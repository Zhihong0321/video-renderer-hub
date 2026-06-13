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

  // Sample one frame at t=0.2s and assert non-blank via signalstats (YMIN < YMAX).
  const stats = await run('ffmpeg', ['-hide_banner', '-ss', '0.2', '-i', filePath, '-frames:v', '1', '-vf', 'signalstats,metadata=print:file=-', '-f', 'null', '-']);
  const ymin = Number((stats.match(/lavfi\.signalstats\.YMIN=(\d+(?:\.\d+)?)/) || [])[1]);
  const ymax = Number((stats.match(/lavfi\.signalstats\.YMAX=(\d+(?:\.\d+)?)/) || [])[1]);
  if (!Number.isFinite(ymin) || !Number.isFinite(ymax) || ymax <= ymin) {
    return { ok: false, reason: 'blank frame at t=0.2s (YMIN>=YMAX)' };
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
    child.on('close', (code) => (code === 0 ? resolveP(out.trim()) : rejectP(new Error(`${command} exit ${code}: ${err.slice(-1500)}`))));
  });
}
