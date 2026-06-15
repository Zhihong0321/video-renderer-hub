// WebUI queue: thin request/transport surface for the prompt → narrated MP4 pipeline.
// Three pieces: this file (routes) + job-store.mjs (SQLite) + config.mjs (env).
// No Postgres, no SSE, no Docker. The Mac mini worker pulls jobs over HTTP.

import { createReadStream, existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import {
  HOST,
  PORT,
  PUBLIC_BASE_URL,
  REQUESTER_API_KEY,
  RESULTS_DIR,
  WORKER_SECRET,
  ensureDataDirs,
  requireServerSecrets,
} from './config.mjs';
import {
  assertInstruction,
  claimNextJob,
  createJob,
  getJob,
  getJobStats,
  initDb,
  listJobs,
  listWorkers,
  publicJob,
  sweepStaleClaimedJobs,
  updateJob,
  upsertWorkerHeartbeat,
} from './job-store.mjs';

requireServerSecrets();
ensureDataDirs();
await initDb();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://local');
    const method = req.method || 'GET';

    if (method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true, service: 'video-renderer-webui' });
    }

    if (method === 'GET' && url.pathname === '/') {
      return html(res, 200, dashboardHtml());
    }

    if (method === 'GET' && url.pathname === '/docs') {
      return html(res, 200, docsHtml());
    }

    if (method === 'GET' && url.pathname === '/api/jobs') {
      requireRequester(req);
      return json(res, 200, { jobs: (await listJobs(Number(url.searchParams.get('limit') || 20))).map((j) => publicJob(j, PUBLIC_BASE_URL)) });
    }

    if (method === 'GET' && url.pathname === '/api/workers') {
      requireRequester(req);
      return json(res, 200, { workers: await listWorkers() });
    }

    if (method === 'GET' && url.pathname === '/api/stats') {
      requireRequester(req);
      return json(res, 200, await getJobStats());
    }

    if (method === 'POST' && url.pathname === '/api/jobs') {
      requireRequester(req);
      const body = await readJson(req);
      assertInstruction(body);
      const job = await createJob({ prompt: String(body.prompt || body.instruction).trim(), metadata: body.metadata });
      return json(res, 202, { job_id: job.id, status: job.status, status_url: `/api/jobs/${job.id}`, result_url: null });
    }

    const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (method === 'GET' && jobMatch?.[1]) {
      requireRequester(req);
      const job = await getJob(jobMatch[1]);
      if (!job) return json(res, 404, { error: 'job not found' });
      return json(res, 200, { job: publicJob(job, PUBLIC_BASE_URL) });
    }

    const resultMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/result\.mp4$/);
    if (method === 'GET' && resultMatch?.[1]) {
      requireRequester(req);
      const job = await getJob(resultMatch[1]);
      if (!job) return json(res, 404, { error: 'job not found' });
      // Prefer the stored path, but fall back to the canonical location under
      // the current RESULTS_DIR so a stale absolute path (e.g. from before the
      // volume was mounted) does not lose an otherwise-present file.
      const resultPath =
        job.result_path && existsSync(job.result_path)
          ? job.result_path
          : join(RESULTS_DIR, job.id, 'output.mp4');
      if (job.status !== 'completed' || !existsSync(resultPath)) {
        return json(res, 404, { error: 'result not ready' });
      }
      res.writeHead(200, {
        'content-type': 'video/mp4',
        'content-disposition': `inline; filename="${job.result_filename || `${job.id}.mp4`}"`,
        'cache-control': 'private, max-age=3600',
      });
      createReadStream(resultPath).pipe(res);
      return;
    }

    if (method === 'POST' && url.pathname === '/api/worker/claim') {
      requireWorker(req);
      const body = await readJsonSafe(req);
      const workerId = String(body.worker_id || req.headers['x-worker-id'] || 'worker');
      await upsertWorkerHeartbeat({ id: workerId, status: 'online', current_job_id: null, version: body.version, started_at: body.started_at, metadata: body.metadata });
      const swept = sweepStaleClaimedJobs(5 * 60 * 1000);
      const job = await claimNextJob(workerId);
      if (job) {
        await upsertWorkerHeartbeat({ id: workerId, status: 'busy', current_job_id: job.id, version: body.version, started_at: body.started_at, metadata: body.metadata });
      }
      if (swept > 0) console.log(`sweep: re-queued ${swept} stale claimed job(s)`);
      return json(res, 200, { job, swept });
    }

    if (method === 'POST' && url.pathname === '/api/worker/heartbeat') {
      requireWorker(req);
      const body = await readJsonSafe(req);
      const worker = await upsertWorkerHeartbeat({
        id: body.worker_id || req.headers['x-worker-id'] || 'worker',
        status: body.status || 'online',
        current_job_id: body.current_job_id || null,
        version: body.version,
        started_at: body.started_at,
        metadata: body.metadata,
      });
      return json(res, 200, { worker });
    }

    const progressMatch = url.pathname.match(/^\/api\/worker\/jobs\/([^/]+)\/progress$/);
    if (method === 'POST' && progressMatch?.[1]) {
      requireWorker(req);
      const body = await readJson(req);
      const job = await updateJob(progressMatch[1], { status: body.status, progress: body.progress, message: body.message });
      if (!job) return json(res, 404, { error: 'job not found' });
      return json(res, 200, { job: publicJob(job, PUBLIC_BASE_URL) });
    }

    const failMatch = url.pathname.match(/^\/api\/worker\/jobs\/([^/]+)\/fail$/);
    if (method === 'POST' && failMatch?.[1]) {
      requireWorker(req);
      const body = await readJsonSafe(req);
      const job = await updateJob(failMatch[1], {
        status: 'failed',
        progress: 100,
        message: 'Failed',
        error: body.error || 'worker failed',
        completed_at: new Date().toISOString(),
      });
      if (!job) return json(res, 404, { error: 'job not found' });
      return json(res, 200, { job: publicJob(job, PUBLIC_BASE_URL) });
    }

    const uploadMatch = url.pathname.match(/^\/api\/worker\/jobs\/([^/]+)\/upload$/);
    if (method === 'POST' && uploadMatch?.[1]) {
      requireWorker(req);
      const job = await getJob(uploadMatch[1]);
      if (!job) return json(res, 404, { error: 'job not found' });
      await updateJob(job.id, { status: 'uploading', progress: 95, message: 'Uploading result' });
      const resultDir = join(RESULTS_DIR, job.id);
      await mkdir(resultDir, { recursive: true });
      const outputPath = join(resultDir, 'output.mp4');
      await writeRequestToFile(req, outputPath);
      const updated = await updateJob(job.id, {
        status: 'completed',
        progress: 100,
        message: 'Completed',
        result_path: outputPath,
        result_filename: `${job.id}.mp4`,
        error: null,
        completed_at: new Date().toISOString(),
      });
      try { upsertWorkerHeartbeat({ id: job.worker_id || req.headers['x-worker-id'] || 'worker', status: 'online', current_job_id: null }); } catch {}
      return json(res, 200, { job: publicJob(updated, PUBLIC_BASE_URL) });
    }

    return json(res, 404, { error: 'not found' });
  } catch (err) {
    const status = err.statusCode || 500;
    const message = err instanceof Error ? err.message : String(err);
    return json(res, status, { error: message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`video-renderer webui listening on http://${HOST}:${PORT}`);
  console.log(`requester auth: ${REQUESTER_API_KEY ? 'configured' : 'missing'}`);
  console.log(`worker auth: ${WORKER_SECRET ? 'configured' : 'missing'}`);
  console.log(`results dir: ${RESULTS_DIR}`);
});

function requireRequester(req) {
  requireBearer(req, REQUESTER_API_KEY, 'requester');
}
function requireWorker(req) {
  requireBearer(req, WORKER_SECRET, 'worker');
}
function requireBearer(req, expected, label) {
  const token = (req.headers.authorization || '').startsWith('Bearer ')
    ? req.headers.authorization.slice(7).trim()
    : '';
  if (!token || token !== expected) {
    const e = new Error(`unauthorized ${label}`);
    e.statusCode = 401;
    throw e;
  }
}

async function readJson(req) {
  const text = await readText(req);
  if (!text.trim()) {
    const e = new Error('empty body');
    e.statusCode = 400;
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch {
    const e = new Error('invalid JSON');
    e.statusCode = 400;
    throw e;
  }
}
async function readJsonSafe(req) {
  try {
    return await readJson(req);
  } catch {
    return {};
  }
}
async function readText(req) {
  let text = '';
  for await (const chunk of req) text += chunk.toString('utf8');
  return text;
}
async function writeRequestToFile(req, path) {
  const { createWriteStream } = await import('node:fs');
  await new Promise((resolve, reject) => {
    const out = createWriteStream(path);
    req.pipe(out);
    req.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body, null, 2));
}
function html(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function dashboardHtml() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Video Renderer</title>
<style>:root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}body{margin:0;background:#f7f7f4;color:#171713}main{max-width:920px;margin:0 auto;padding:32px 18px 60px}section{background:#fff;border:1px solid #dedbd2;border-radius:8px;padding:18px;margin:14px 0}label{display:block;font-size:12px;font-weight:650;color:#555146;margin:0 0 6px}input,textarea,select{width:100%;box-sizing:border-box;border:1px solid #cbc8bd;border-radius:6px;padding:10px 11px;font:inherit;background:#fff;color:#171713}textarea{min-height:110px;resize:vertical;line-height:1.45}.actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:12px}button{border:0;border-radius:6px;padding:10px 13px;background:#171713;color:#fff;font-weight:700;cursor:pointer}button.secondary{background:#ece9df;color:#171713}pre{white-space:pre-wrap;word-break:break-word;background:#171713;color:#f6f1e3;border-radius:8px;padding:14px;min-height:90px;overflow:auto}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;border-bottom:1px solid #ebe8de;padding:9px 6px;vertical-align:top}th{color:#555146;font-size:12px}.muted{color:#706b5f;font-size:13px}</style>
</head><body><main>
<header><h1>Video Renderer</h1><span><a class="muted" href="/docs">Docs</a></span></header>
<section><label>Requester API Key</label><input id="apiKey" type="password" placeholder="REQUESTER_API_KEY" autocomplete="off"><p class="muted">Stored only in this browser's localStorage.</p></section>
<section><label for="instruction">Prompt</label><textarea id="instruction" placeholder="Create a 30 second product explainer about an AI invoice app"></textarea>
<div class="actions"><button id="submitBtn">Create Job</button><button id="refreshBtn" class="secondary">Refresh</button></div></section>
<section><label>Latest Response</label><pre id="output">Ready.</pre></section>
<section><label>Recent Jobs</label><div id="jobs" class="muted">No jobs loaded.</div></section>
</main>
<script>
const apiKey=document.getElementById('apiKey'),instruction=document.getElementById('instruction'),output=document.getElementById('output'),jobsEl=document.getElementById('jobs');
apiKey.value=localStorage.getItem('videoRendererApiKey')||'';
apiKey.addEventListener('input',()=>localStorage.setItem('videoRendererApiKey',apiKey.value));
document.getElementById('submitBtn').addEventListener('click',createJob);
document.getElementById('refreshBtn').addEventListener('click',refreshJobs);
refreshJobs().catch(()=>{});
async function createJob(){
  const body={prompt:instruction.value.trim()};
  if(!body.prompt)return show({error:'prompt is required'});
  show(await api('/api/jobs',{method:'POST',body:JSON.stringify(body)}));
  await refreshJobs();
}
async function refreshJobs(){
  const data=await api('/api/jobs?limit=20');
  const jobs=data.jobs||[];
  if(!jobs.length){jobsEl.textContent='No jobs yet.';return;}
  jobsEl.innerHTML='<table><thead><tr><th>Job</th><th>Status</th><th>Progress</th><th>Message</th><th>Result</th></tr></thead><tbody>'+
    jobs.map(j=>'<tr>'+
      '<td><code>'+esc(j.id)+'</code><br><span class="muted">'+esc(j.created_at||'')+'</span></td>'+
      '<td>'+esc(j.status)+'</td>'+
      '<td>'+esc(String(j.progress))+'%</td>'+
      '<td>'+esc(j.message||'')+'</td>'+
      '<td>'+(j.result_url?'<a href="'+esc(j.result_url)+'" target="_blank" rel="noopener">open</a>':'')+'</td>'+
    '</tr>').join('')+'</tbody></table>';
}
async function api(path,opts={}){
  const res=await fetch(path,{...opts,headers:{'authorization':'Bearer '+apiKey.value.trim(),'content-type':'application/json',...(opts.headers||{})}});
  const text=await res.text();let data;try{data=text?JSON.parse(text):{}}catch{data={raw:text}}
  if(!res.ok)throw show(data);return data;
}
function show(d){output.textContent=JSON.stringify(d,null,2);return d}
function esc(s){return String(s).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]))}
</script></body></html>`;
}

function docsHtml() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Video Renderer API</title>
<style>:root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,sans-serif}body{margin:0;background:#f7f7f4;color:#171713}main{max-width:820px;margin:0 auto;padding:32px 18px 60px}h1{font-size:28px;margin:0 0 12px}section{background:#fff;border:1px solid #dedbd2;border-radius:8px;padding:18px;margin:14px 0}h2{font-size:18px;margin:0 0 8px}code{font-family:ui-monospace,monospace;background:#efede5;padding:2px 4px;border-radius:4px}pre{background:#171713;color:#f6f1e3;border-radius:8px;padding:14px;overflow:auto;white-space:pre-wrap}table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;border-bottom:1px solid #ebe8de;padding:8px 6px}th{font-size:12px;color:#555146;text-transform:uppercase}.muted{color:#706b5f}.method{font-weight:900;min-width:48px;display:inline-block}.get{color:#116329}.post{color:#8a4b00}</style>
</head><body><main>
<h1>Video Renderer API</h1>
<p class="muted">Prompt-only job queue. The Mac mini worker pulls jobs, runs <code>hv make</code> locally, and uploads the result.</p>

<section>
<h2>Pipeline</h2>
<ol>
  <li>App POSTs a prompt to <code>/api/jobs</code>.</li>
  <li>Server stores the job (SQLite) as <code>queued</code>.</li>
  <li>Mac mini worker POSTs to <code>/api/worker/claim</code> and receives the oldest queued job.</li>
  <li>Worker runs <code>hv make "&lt;prompt&gt;" -o &lt;scratch&gt;/final.mp4</code> locally. <code>hv make</code> spawns <code>claude -p</code> with the speech-video skill to write self-contained slide HTML + narration, writes the manifest itself, runs <code>make-speech-video.mjs</code>, and verifies the output (ffprobe + signalstats) before returning.</li>
  <li>Worker streams the final mp4 to <code>/api/worker/jobs/&lt;id&gt;/upload</code>. Server stores it under <code>RESULTS_DIR/&lt;id&gt;/output.mp4</code> and marks the job <code>completed</code>.</li>
  <li>App polls <code>/api/jobs/&lt;id&gt;</code> and downloads <code>/api/jobs/&lt;id&gt;/result.mp4</code>.</li>
</ol>
<p>TTS uses <code>mmx speech synthesize</code> (audio-first: narration length drives each slide's render duration). Render uses the <code>0.3.0-framestep</code> adapter for deterministic 60fps capture.</p>
</section>

<section>
<h2>Requester API (Bearer: <code>REQUESTER_API_KEY</code>)</h2>
<table><thead><tr><th>Method</th><th>Path</th><th>Description</th></tr></thead><tbody>
<tr><td><span class="method post">POST</span></td><td><code>/api/jobs</code></td><td>Create a job. Body: <code>{"prompt":"…","metadata":{}}</code></td></tr>
<tr><td><span class="method get">GET</span></td><td><code>/api/jobs?limit=20</code></td><td>List recent jobs</td></tr>
<tr><td><span class="method get">GET</span></td><td><code>/api/jobs/:id</code></td><td>Job status (queued|claimed|rendering|uploading|completed|failed)</td></tr>
<tr><td><span class="method get">GET</span></td><td><code>/api/jobs/:id/result.mp4</code></td><td>Download final mp4 (404 until completed)</td></tr>
<tr><td><span class="method get">GET</span></td><td><code>/api/workers</code></td><td>Worker heartbeats (online|stale|offline)</td></tr>
<tr><td><span class="method get">GET</span></td><td><code>/api/stats</code></td><td>Job counts by status</td></tr>
<tr><td><span class="method get">GET</span></td><td><code>/health</code></td><td>Liveness (no auth)</td></tr>
</tbody></table>
</section>

<section>
<h2>Worker API (Bearer: <code>WORKER_SECRET</code>)</h2>
<table><thead><tr><th>Method</th><th>Path</th><th>Description</th></tr></thead><tbody>
<tr><td><span class="method post">POST</span></td><td><code>/api/worker/claim</code></td><td>Claim oldest queued job (returns the job or <code>{"job":null}</code>)</td></tr>
<tr><td><span class="method post">POST</span></td><td><code>/api/worker/heartbeat</code></td><td>Liveness ping with optional status / current_job_id</td></tr>
<tr><td><span class="method post">POST</span></td><td><code>/api/worker/jobs/:id/progress</code></td><td>Update job status / progress / message</td></tr>
<tr><td><span class="method post">POST</span></td><td><code>/api/worker/jobs/:id/upload</code></td><td>Stream raw mp4 body; server stores it and marks the job completed</td></tr>
<tr><td><span class="method post">POST</span></td><td><code>/api/worker/jobs/:id/fail</code></td><td>Mark job failed with <code>{"error":"…"}</code></td></tr>
</tbody></table>
</section>

<section>
<h2>Worker env (Mac mini)</h2>
<pre>REQUESTER_API_KEY=&lt;shared with webui&gt;
WORKER_SECRET=&lt;shared with webui&gt;
WEBUI_URL=https://video-renderer.up.railway.app
mmx must be on PATH (TTS) and authenticated</pre>
</section>
</main></body></html>`;
}
