// SQLite-backed job + worker store. Single-file DB. No Postgres.

import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from './config.mjs';

let db;

export function initDb() {
  if (db) return db;
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      progress INTEGER NOT NULL DEFAULT 0,
      message TEXT,
      error TEXT,
      worker_id TEXT,
      result_path TEXT,
      result_filename TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      claimed_at TEXT,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS workers (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'online',
      current_job_id TEXT,
      version TEXT,
      started_at TEXT,
      last_seen_at TEXT NOT NULL,
      metadata_json TEXT
    );
  `);
  return db;
}

function row() {
  if (!db) initDb();
  return db;
}

function nowIso() {
  return new Date().toISOString();
}

function newId() {
  // 16 random bytes → 32 hex chars. Not a UUID, but unambiguous and short.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return 'job_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function assertInstruction(body) {
  if (!body || typeof body !== 'object') {
    const e = new Error('body must be an object');
    e.statusCode = 400;
    throw e;
  }
  const prompt = String(body.prompt || body.instruction || '').trim();
  if (!prompt) {
    const e = new Error('prompt is required');
    e.statusCode = 400;
    throw e;
  }
}

export function createJob(input) {
  const id = newId();
  const ts = nowIso();
  const metadata_json = input.metadata ? JSON.stringify(input.metadata) : null;
  row().prepare(`
    INSERT INTO jobs (id, prompt, status, progress, message, metadata_json, created_at, updated_at)
    VALUES (?, ?, 'queued', 0, 'Queued', ?, ?, ?)
  `).run(id, input.prompt, metadata_json, ts, ts);
  return getJob(id);
}

export function getJob(id) {
  const job = row().prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  if (!job) return null;
  return job;
}

export function listJobs(limit = 20) {
  return row().prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit);
}

export function updateJob(id, patch) {
  const job = getJob(id);
  if (!job) return null;
  const fields = [];
  const values = [];
  for (const key of ['status', 'progress', 'message', 'error', 'worker_id', 'result_path', 'result_filename', 'claimed_at', 'completed_at']) {
    if (key in patch) {
      fields.push(`${key} = ?`);
      values.push(patch[key]);
    }
  }
  if (fields.length === 0) return job;
  fields.push('updated_at = ?');
  values.push(nowIso());
  values.push(id);
  row().prepare(`UPDATE jobs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return getJob(id);
}

// Reset claimed jobs older than `olderThanMs` back to queued. Called by the
// claim handler so a dead worker's in-flight job doesn't sit stuck forever.
export function sweepStaleClaimedJobs(olderThanMs) {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const info = row().prepare(`
    UPDATE jobs
    SET status = 'queued', worker_id = NULL, claimed_at = NULL,
        updated_at = ?, message = 'Re-queued (previous worker stale)'
    WHERE status = 'claimed' AND claimed_at IS NOT NULL AND claimed_at < ?
  `).run(nowIso(), cutoff);
  return info.changes || 0;
}

// Atomic claim: a single UPDATE that picks the oldest queued job and flips it
// to 'claimed' in one shot. SQLite serializes writers, so this is race-free.
export function claimNextJob(workerId) {
  const ts = nowIso();
  const tx = row().prepare(`
    UPDATE jobs
    SET status = 'claimed', worker_id = ?, claimed_at = ?, updated_at = ?, message = 'Claimed by worker'
    WHERE id = (
      SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1
    )
    RETURNING *
  `);
  // node:sqlite has prepare().get/run/all but RETURNING is via .get/.all on the prepared statement.
  const claimed = tx.get(workerId, ts, ts);
  return claimed || null;
}

export function getJobStats() {
  const r = row().prepare(`
    SELECT
      SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
      SUM(CASE WHEN status = 'claimed' THEN 1 ELSE 0 END) AS claimed,
      SUM(CASE WHEN status IN ('rendering','uploading') THEN 1 ELSE 0 END) AS running,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      COUNT(*) AS total
    FROM jobs
  `).get();
  return { database: { ok: true }, jobs: r };
}

export function upsertWorkerHeartbeat({ id, status, current_job_id, version, started_at, metadata }) {
  if (!id) throw new Error('worker id required');
  const ts = nowIso();
  const metadata_json = metadata ? JSON.stringify(metadata) : null;
  row().prepare(`
    INSERT INTO workers (id, status, current_job_id, version, started_at, last_seen_at, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      current_job_id = excluded.current_job_id,
      version = COALESCE(excluded.version, workers.version),
      started_at = COALESCE(excluded.started_at, workers.started_at),
      last_seen_at = excluded.last_seen_at,
      metadata_json = COALESCE(excluded.metadata_json, workers.metadata_json)
  `).run(id, status || 'online', current_job_id || null, version || null, started_at || null, ts, metadata_json);
  return row().prepare('SELECT * FROM workers WHERE id = ?').get(id);
}

export function listWorkers() {
  const rows = row().prepare('SELECT * FROM workers ORDER BY last_seen_at DESC').all();
  const cutoffOnline = Date.now() - 30 * 1000;
  const cutoffStale = Date.now() - 120 * 1000;
  return rows.map((w) => {
    const last = Date.parse(w.last_seen_at) || 0;
    const health = last >= cutoffOnline ? 'online' : last >= cutoffStale ? 'stale' : 'offline';
    return { ...w, health };
  });
}

export function publicJob(job, publicBaseUrl) {
  if (!job) return null;
  const result_url =
    job.status === 'completed' && job.result_path && publicBaseUrl
      ? `${publicBaseUrl.replace(/\/$/, '')}/api/jobs/${job.id}/result.mp4`
      : null;
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    message: job.message,
    prompt: job.prompt,
    error: job.error,
    worker_id: job.worker_id,
    result_url,
    metadata: job.metadata_json ? JSON.parse(job.metadata_json) : {},
    created_at: job.created_at,
    updated_at: job.updated_at,
    claimed_at: job.claimed_at,
    completed_at: job.completed_at,
  };
}
