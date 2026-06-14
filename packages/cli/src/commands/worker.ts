// Phase 4 worker: claim → hv make → §5 hard gate → upload (or fail).
// Loop. No M3 calls, no template-fill, no SSE. Stdlib only.

import { spawn } from 'node:child_process';
import { mkdtemp, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ok, fail, progress } from '../output.js';

interface WorkerOpts {
  server: string;
  secret: string;
  workerId?: string;
  pollMs?: number;
  projectRoot: string;
}

export async function runWorker(opts: WorkerOpts): Promise<void> {
  const server = opts.server.replace(/\/$/, '');
  const headers = { authorization: `Bearer ${opts.secret}`, 'content-type': 'application/json' };
  const workerId = opts.workerId ?? 'macmini';

  progress('startup', 0, { server, worker_id: workerId });
  for (;;) {
    try {
      await postJson(`${server}/api/worker/heartbeat`, headers, { worker_id: workerId, status: 'online' });

      const claimed = await postJson(`${server}/api/worker/claim`, headers, { worker_id: workerId });
      if (!claimed?.job) {
        await sleep(opts.pollMs ?? 5000);
        continue;
      }
      await processJob(server, headers, workerId, claimed.job, opts.projectRoot);
    } catch (err) {
      progress('loop-error', 0, { error: err instanceof Error ? err.message : String(err) });
      await sleep(opts.pollMs ?? 5000);
    }
  }
}

async function processJob(server: string, headers: Record<string, string>, workerId: string, job: { id: string; prompt: string }, projectRoot: string): Promise<void> {
  // Agent task: a prompt prefixed with "/agent " is a dev/maintenance task, not a
  // video. Run Claude headless in the repo with full tools and report what it did.
  // This is how the WebUI drives + fixes the Mac mini itself (no human relay).
  const agentTask = parseAgentTask(job.prompt);
  if (agentTask !== null) {
    return runAgentJob(server, headers, job, projectRoot, agentTask);
  }

  const workDir = await mkdtemp(join(tmpdir(), 'hv-worker-'));
  const outputPath = join(workDir, 'final.mp4');

  try {
    progress('render', 30, { job_id: job.id, work_dir: workDir });
    await postJson(`${server}/api/worker/jobs/${job.id}/progress`, headers, { status: 'rendering', progress: 30, message: 'Running hv make' });

    await run('node', [join(projectRoot, 'packages/cli/dist/bin.js'), 'make', job.prompt, '-o', outputPath], { cwd: projectRoot });

    progress('gate', 70, { job_id: job.id });
    const verdict = await hardGate(outputPath);
    if (!verdict.ok) {
      progress('fail', 90, { job_id: job.id, reason: verdict.reason });
      await postJson(`${server}/api/worker/jobs/${job.id}/fail`, headers, { error: `hard-gate failed: ${verdict.reason}` });
      return;
    }

    progress('upload', 90, { job_id: job.id });
    await uploadFile(`${server}/api/worker/jobs/${job.id}/upload`, headers, outputPath, workerId);
    progress('done', 100, { job_id: job.id });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await postJson(`${server}/api/worker/jobs/${job.id}/fail`, headers, { error: message }).catch(() => {});
  }
}

// Returns the task text if the prompt is an agent task ("/agent <task>"), else null.
function parseAgentTask(prompt: string): string | null {
  const m = (prompt || '').trim().match(/^\/agent\b[ \t]*([\s\S]*)$/i);
  return m ? (m[1] ?? '').trim() : null;
}

const AGENT_TIMEOUT_MS = 20 * 60 * 1000; // 20 min — a hung claude must not freeze the worker forever

// Run Claude headless in the repo with full tools (edit/bash/build/git), then post
// the result back as the job message and mark it completed. No new server endpoint
// or schema needed — works against the existing queue. The agent is expected to
// `git push` real code changes; the message is its summary of what it did.
async function runAgentJob(
  server: string,
  headers: Record<string, string>,
  job: { id: string; prompt: string },
  projectRoot: string,
  task: string,
): Promise<void> {
  const progressUrl = `${server}/api/worker/jobs/${job.id}/progress`;
  try {
    if (!task) {
      await postJson(progressUrl, headers, { status: 'failed', progress: 100, message: 'Empty agent task' });
      return;
    }
    progress('agent', 20, { job_id: job.id });
    await postJson(progressUrl, headers, { status: 'rendering', progress: 20, message: 'Running agent task' });

    const { out, err, code, timedOut } = await runCapture(
      'claude',
      ['--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions', '-p', task],
      { cwd: projectRoot, timeoutMs: AGENT_TIMEOUT_MS },
    );

    const combined = [out.trim(), err.trim()].filter(Boolean).join('\n').trim();
    const transcript = combined || '(agent produced no output)';
    // The queue's message field carries the result. Cap to keep payloads sane;
    // the real artifact is whatever the agent committed/pushed.
    const message = (timedOut ? '[TIMED OUT after 20m]\n' : '') + transcript.slice(-6000);
    const status = timedOut ? 'failed' : 'completed';
    progress('agent-done', 100, { job_id: job.id, code, timed_out: timedOut });
    await postJson(progressUrl, headers, { status, progress: 100, message });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await postJson(progressUrl, headers, { status: 'failed', progress: 100, message: `agent error: ${msg}` }).catch(() => {});
  }
}

// Like run(), but always resolves with both streams + exit code (never throws on
// nonzero), and enforces a timeout that kills the child. For agent tasks, the
// output is useful even when claude exits nonzero.
function runCapture(
  command: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ out: string; err: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolveP) => {
    const child = spawn(command, args, { cwd: opts.cwd, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, opts.timeoutMs)
      : null;
    child.stdout.on('data', (c) => (out += c.toString()));
    child.stderr.on('data', (c) => (err += c.toString()));
    child.on('error', (e) => { if (timer) clearTimeout(timer); resolveP({ out, err: err + String(e), code: null, timedOut }); });
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolveP({ out, err, code, timedOut }); });
  });
}

// §5 Layer-2 hard gate. Cheap checks, no ImageMagick, no PIL.
async function hardGate(filePath: string): Promise<{ ok: boolean; reason?: string; info?: Record<string, unknown> }> {
  const fileStat = await stat(filePath).catch(() => null);
  if (!fileStat || fileStat.size < 1024) return { ok: false, reason: 'file missing or too small' };

  const streams = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'default=nw=1:nk=1', filePath]);
  const types = streams.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!types.includes('video')) return { ok: false, reason: 'no video stream' };
  if (!types.includes('audio')) return { ok: false, reason: 'no audio stream' };

  const duration = Number((await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', filePath])).trim());
  if (!(duration > 0)) return { ok: false, reason: 'duration is zero' };

  // Sample at the MIDDLE of the video (not the intro), so a fade-in from black
  // isn't mistaken for a white screen. signalstats YMIN < YMAX = has content.
  const mid = Math.max(0.2, duration / 2).toFixed(2);
  const stats = await run('ffmpeg', ['-hide_banner', '-ss', mid, '-i', filePath, '-frames:v', '1', '-vf', 'signalstats,metadata=print:file=-', '-f', 'null', '-']);
  const ymin = Number((stats.match(/lavfi\.signalstats\.YMIN=(\d+(?:\.\d+)?)/) || [])[1]);
  const ymax = Number((stats.match(/lavfi\.signalstats\.YMAX=(\d+(?:\.\d+)?)/) || [])[1]);
  if (!Number.isFinite(ymin) || !Number.isFinite(ymax) || ymax <= ymin) {
    return { ok: false, reason: `blank frame at t=${mid}s (YMIN>=YMAX)` };
  }
  return { ok: true, info: { duration, streams: types, ymin, ymax, size: fileStat.size } };
}

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

async function uploadFile(url: string, headers: Record<string, string>, filePath: string, workerId: string): Promise<any> {
  const { readFile } = await import('node:fs/promises');
  const body = await readFile(filePath);
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'x-worker-id': workerId, 'content-type': 'video/mp4' },
    body,
  });
  if (!res.ok) throw new Error(`upload ${url} -> ${res.status}`);
  return res.json();
}

function run(command: string, args: string[], opts: { cwd?: string } = {}): Promise<string> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(command, args, { cwd: opts.cwd, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (c) => (out += c.toString()));
    child.stderr.on('data', (c) => (err += c.toString()));
    child.on('error', rejectP);
    child.on('close', (code) => {
      if (code === 0) return resolveP(out.trim());
      // hv make reports failures as JSON on STDOUT (via fail()), not stderr.
      // Include both streams so the real reason reaches the queue, not "exit 1:".
      const detail = [out.trim(), err.trim()].filter(Boolean).join('\n').slice(-2000);
      rejectP(new Error(`${command} exit ${code}: ${detail || '(no output)'}`));
    });
  });
}
