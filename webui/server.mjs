import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import {
  API_BASE_URL,
  DATA_DIR,
  DATABASE_URL,
  ensureDataDirs,
  HOST,
  PORT,
  PUBLIC_BASE_URL,
  RENDER_MODE,
  REQUESTER_API_KEY,
  RESULTS_DIR,
  WEBUI_ROOT,
  WORKER_SECRET,
  requireServerSecrets,
} from './config.mjs';
import {
  assertInstruction,
  claimNextJob,
  createJob,
  getJobStats,
  getJob,
  initDb,
  listJobs,
  listWorkers,
  publicJob,
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

    if (method === 'GET' && url.pathname === '/debug') {
      return html(res, 200, debugHtml());
    }

    if (method === 'GET' && url.pathname === '/api/debug') {
      requireRequester(req);
      return json(res, 200, await buildDebugReport(req));
    }

    if (method === 'GET' && url.pathname === '/api/jobs') {
      requireRequester(req);
      const jobs = await listJobs(Number(url.searchParams.get('limit') || 20));
      return json(res, 200, { jobs: jobs.map((job) => publicJob(job, PUBLIC_BASE_URL)) });
    }

    if (method === 'GET' && url.pathname === '/api/workers') {
      requireRequester(req);
      return json(res, 200, { workers: await listWorkers() });
    }

    if (method === 'POST' && url.pathname === '/api/jobs') {
      requireRequester(req);
      const body = await readJson(req);
      assertInstruction(body);
      const job = await createJob(normalizeJobInput(body));
      return json(res, 202, {
        job_id: job.id,
        status: job.status,
        status_url: `/api/jobs/${job.id}`,
        result_url: null,
      });
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
      if (job.status !== 'completed' || !job.result_path || !existsSync(job.result_path)) {
        return json(res, 404, { error: 'result not ready' });
      }
      res.writeHead(200, {
        'content-type': 'video/mp4',
        'content-disposition': `inline; filename="${job.result_filename || `${job.id}.mp4`}"`,
        'cache-control': 'private, max-age=3600',
      });
      createReadStream(job.result_path).pipe(res);
      return;
    }

    if (method === 'POST' && url.pathname === '/api/worker/claim') {
      requireWorker(req);
      const body = await readJson(req).catch(() => ({}));
      const workerId = String(body.worker_id || req.headers['x-worker-id'] || 'worker');
      await upsertWorkerHeartbeat({
        id: workerId,
        status: 'online',
        current_job_id: null,
        version: body.version,
        started_at: body.started_at,
        metadata: body.metadata,
      });
      const job = await claimNextJob(workerId);
      if (job) {
        await upsertWorkerHeartbeat({
          id: workerId,
          status: 'busy',
          current_job_id: job.id,
          version: body.version,
          started_at: body.started_at,
          metadata: body.metadata,
        });
      }
      return json(res, 200, { job });
    }

    if (method === 'POST' && url.pathname === '/api/worker/heartbeat') {
      requireWorker(req);
      const body = await readJson(req).catch(() => ({}));
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

    const workerProgressMatch = url.pathname.match(/^\/api\/worker\/jobs\/([^/]+)\/progress$/);
    if (method === 'POST' && workerProgressMatch?.[1]) {
      requireWorker(req);
      const body = await readJson(req);
      const job = await updateJob(workerProgressMatch[1], {
        status: body.status,
        progress: body.progress,
        message: body.message,
      });
      if (!job) return json(res, 404, { error: 'job not found' });
      return json(res, 200, { job });
    }

    const workerFailMatch = url.pathname.match(/^\/api\/worker\/jobs\/([^/]+)\/fail$/);
    if (method === 'POST' && workerFailMatch?.[1]) {
      requireWorker(req);
      const body = await readJson(req).catch(() => ({}));
      const job = await updateJob(workerFailMatch[1], {
        status: 'failed',
        progress: 100,
        message: 'Failed',
        error: body.error || 'worker failed',
        completed_at: new Date().toISOString(),
      });
      if (!job) return json(res, 404, { error: 'job not found' });
      return json(res, 200, { job });
    }

    const workerUploadMatch = url.pathname.match(/^\/api\/worker\/jobs\/([^/]+)\/upload$/);
    if (method === 'POST' && workerUploadMatch?.[1]) {
      requireWorker(req);
      const job = await getJob(workerUploadMatch[1]);
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
      await upsertWorkerHeartbeat({
        id: job.worker_id || req.headers['x-worker-id'] || 'worker',
        status: 'online',
        current_job_id: null,
      }).catch(() => {});
      return json(res, 200, { job: updated });
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
  console.log(`postgres: connected`);
  console.log(`results dir: ${RESULTS_DIR}`);
});

function normalizeJobInput(body) {
  const prompt = String(body.prompt || body.instruction || '').trim();
  return {
    prompt,
    instruction: prompt,
    aspect: body.aspect || '16:9',
    duration_sec: body.duration_sec || null,
    voice: body.voice || null,
    language: body.language || null,
    music: body.music || null,
    metadata: body.metadata || {},
  };
}

function requireRequester(req) {
  requireBearer(req, REQUESTER_API_KEY, 'requester');
}

function requireWorker(req) {
  requireBearer(req, WORKER_SECRET, 'worker');
}

function requireBearer(req, expected, label) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
  if (!token || token !== expected) {
    const err = new Error(`unauthorized ${label}`);
    err.statusCode = 401;
    throw err;
  }
}

async function readJson(req) {
  const text = await readText(req);
  if (!text.trim()) return {};
  return JSON.parse(text);
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
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body, null, 2));
}

async function buildDebugReport(req) {
  const started = Date.now();
  const checks = {};

  checks.storage = await probeStorage();
  try {
    checks.jobs = await getJobStats();
  } catch (err) {
    checks.jobs = {
      database: {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }

  const recentJobs = await listJobs(10).catch((err) => ({
    error: err instanceof Error ? err.message : String(err),
  }));
  const workers = await listWorkers().catch((err) => ({
    error: err instanceof Error ? err.message : String(err),
  }));

  return {
    ok: checks.storage.ok && checks.jobs.database?.ok === true,
    generated_at: new Date().toISOString(),
    elapsed_ms: Date.now() - started,
    request: {
      host: req.headers.host || null,
      forwarded_proto: req.headers['x-forwarded-proto'] || null,
      railway_request_id: req.headers['x-railway-request-id'] || null,
      user_agent: req.headers['user-agent'] || null,
    },
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      uptime_sec: Math.round(process.uptime()),
      cwd: process.cwd(),
      memory: process.memoryUsage(),
    },
    config: {
      port: PORT,
      host: HOST,
      public_base_url: PUBLIC_BASE_URL || null,
      api_base_url: API_BASE_URL || null,
      render_mode: RENDER_MODE,
      webui_root: WEBUI_ROOT,
      data_dir: DATA_DIR,
      results_dir: RESULTS_DIR,
      database_url: maskDatabaseUrl(DATABASE_URL),
      requester_api_key_configured: Boolean(REQUESTER_API_KEY),
      worker_secret_configured: Boolean(WORKER_SECRET),
    },
    railway: {
      service_name: process.env.RAILWAY_SERVICE_NAME || null,
      service_id: process.env.RAILWAY_SERVICE_ID || null,
      environment_name: process.env.RAILWAY_ENVIRONMENT_NAME || null,
      project_id: process.env.RAILWAY_PROJECT_ID || null,
      deployment_id: process.env.RAILWAY_DEPLOYMENT_ID || null,
      public_domain: process.env.RAILWAY_PUBLIC_DOMAIN || null,
      volume_mount_path: process.env.RAILWAY_VOLUME_MOUNT_PATH || null,
    },
    checks,
    recent_jobs: Array.isArray(recentJobs)
      ? recentJobs.map((job) => publicJob(job, PUBLIC_BASE_URL))
      : recentJobs,
    workers,
  };
}

async function probeStorage() {
  const probeDir = join(RESULTS_DIR, '.debug');
  const probePath = join(probeDir, `probe-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
  const payload = `debug probe ${new Date().toISOString()}\n`;
  try {
    await mkdir(probeDir, { recursive: true });
    await writeFile(probePath, payload, 'utf8');
    const readBack = await readFile(probePath, 'utf8');
    await rm(probePath, { force: true });
    return {
      ok: readBack === payload,
      data_dir: DATA_DIR,
      results_dir: RESULTS_DIR,
      probe_dir: probeDir,
      write: true,
      read: readBack === payload,
      delete: true,
    };
  } catch (err) {
    return {
      ok: false,
      data_dir: DATA_DIR,
      results_dir: RESULTS_DIR,
      probe_dir: probeDir,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function maskDatabaseUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.password) url.password = '***';
    if (url.username) url.username = url.username.slice(0, 2) + '***';
    return url.toString();
  } catch {
    return value.slice(0, 12) + '***';
  }
}

function html(res, status, body) {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function dashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Video Renderer</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f7f7f4; color: #171713; }
    main { max-width: 920px; margin: 0 auto; padding: 32px 18px 60px; }
    header { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-bottom: 24px; }
    h1 { font-size: 28px; margin: 0; letter-spacing: 0; }
    .pill { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; padding: 5px 8px; border: 1px solid #d8d6ce; border-radius: 6px; color: #555146; }
    section { background: #fff; border: 1px solid #dedbd2; border-radius: 8px; padding: 18px; margin: 14px 0; box-shadow: 0 1px 2px rgba(0,0,0,.04); }
    label { display: block; font-size: 12px; font-weight: 650; color: #555146; margin: 0 0 6px; }
    input, textarea, select { width: 100%; box-sizing: border-box; border: 1px solid #cbc8bd; border-radius: 6px; padding: 10px 11px; font: inherit; background: #fff; color: #171713; }
    textarea { min-height: 130px; resize: vertical; line-height: 1.45; }
    .grid { display: grid; grid-template-columns: 1fr 140px 140px; gap: 12px; align-items: end; }
    .actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 12px; }
    button, a.button { border: 0; border-radius: 6px; padding: 10px 13px; background: #171713; color: #fff; font-weight: 700; cursor: pointer; text-decoration: none; display: inline-flex; }
    button.secondary { background: #ece9df; color: #171713; }
    button:disabled { opacity: .55; cursor: not-allowed; }
    pre { white-space: pre-wrap; word-break: break-word; background: #171713; color: #f6f1e3; border-radius: 8px; padding: 14px; min-height: 90px; overflow: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; border-bottom: 1px solid #ebe8de; padding: 9px 6px; vertical-align: top; }
    th { color: #555146; font-size: 12px; }
    .muted { color: #706b5f; font-size: 13px; }
    @media (max-width: 720px) { .grid { grid-template-columns: 1fr; } header { display: block; } }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Video Renderer</h1>
      <span><a class="pill" href="/docs">Docs</a> <a class="pill" href="/debug">Debug</a> <span class="pill">API online</span></span>
    </header>

    <section>
      <label for="apiKey">Requester API Key</label>
      <input id="apiKey" type="password" placeholder="REQUESTER_API_KEY" autocomplete="off" />
      <p class="muted">Stored only in this browser's localStorage.</p>
    </section>

    <section>
      <label for="instruction">Instruction</label>
      <textarea id="instruction" placeholder="Create a 30 second product explainer about an AI invoice app"></textarea>
      <div class="grid">
        <div>
          <label for="language">Language</label>
          <input id="language" value="English" />
        </div>
        <div>
          <label for="aspect">Aspect</label>
          <select id="aspect">
            <option>16:9</option>
            <option>9:16</option>
            <option>1:1</option>
          </select>
        </div>
        <div>
          <label for="duration">Seconds</label>
          <input id="duration" type="number" min="1" value="30" />
        </div>
      </div>
      <div class="actions">
        <button id="submitBtn">Create Job</button>
      <button id="refreshBtn" class="secondary">Refresh Jobs</button>
      </div>
    </section>

    <section>
      <label>Mac Mini Workers</label>
      <div id="workers" class="muted">No workers loaded.</div>
    </section>

    <section>
      <label>Latest Response</label>
      <pre id="output">Ready.</pre>
    </section>

    <section>
      <label>Recent Jobs</label>
      <div id="jobs" class="muted">No jobs loaded.</div>
    </section>
  </main>

  <script>
    const apiKey = document.getElementById('apiKey');
    const instruction = document.getElementById('instruction');
    const language = document.getElementById('language');
    const aspect = document.getElementById('aspect');
    const duration = document.getElementById('duration');
    const output = document.getElementById('output');
    const jobsEl = document.getElementById('jobs');
    const workersEl = document.getElementById('workers');
    const saved = localStorage.getItem('videoRendererApiKey') || '';
    apiKey.value = saved;
    apiKey.addEventListener('input', () => localStorage.setItem('videoRendererApiKey', apiKey.value));

    document.getElementById('submitBtn').addEventListener('click', createJob);
    document.getElementById('refreshBtn').addEventListener('click', refreshJobs);
    refreshAll().catch(() => {});

    async function createJob() {
      const body = {
        prompt: instruction.value.trim(),
        aspect: aspect.value,
        duration_sec: Number(duration.value || 30),
        language: language.value.trim()
      };
      if (!body.prompt) return show({ error: 'prompt is required' });
      const data = await api('/api/jobs', { method: 'POST', body: JSON.stringify(body) });
      show(data);
      await refreshAll();
    }

    async function refreshAll() {
      await Promise.all([refreshJobs(), refreshWorkers()]);
    }

    async function refreshJobs() {
      const data = await api('/api/jobs?limit=20');
      renderJobs(data.jobs || []);
    }

    async function refreshWorkers() {
      const data = await api('/api/workers');
      renderWorkers(data.workers || []);
    }

    async function api(path, opts = {}) {
      const res = await fetch(path, {
        ...opts,
        headers: {
          'authorization': 'Bearer ' + apiKey.value.trim(),
          'content-type': 'application/json',
          ...(opts.headers || {})
        }
      });
      const text = await res.text();
      let data;
      try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
      if (!res.ok) throw show(data);
      return data;
    }

    function renderJobs(jobs) {
      if (!jobs.length) {
        jobsEl.textContent = 'No jobs yet.';
        return;
      }
      jobsEl.innerHTML = '<table><thead><tr><th>Job</th><th>Status</th><th>Progress</th><th>Message</th><th>Result</th></tr></thead><tbody>' +
        jobs.map(job => '<tr>' +
          '<td><code>' + esc(job.id) + '</code><br><span class="muted">' + esc(job.created_at || '') + '</span></td>' +
          '<td>' + esc(job.status) + '</td>' +
          '<td>' + esc(String(job.progress)) + '%</td>' +
          '<td>' + esc(job.message || '') + '</td>' +
          '<td>' + (job.result_url ? '<button class="download-btn" data-url="' + esc(job.result_url) + '" data-name="' + esc(job.id) + '.mp4">Download</button>' : '') + '</td>' +
        '</tr>').join('') +
        '</tbody></table>';
    }

    function renderWorkers(workers) {
      if (!workers.length) {
        workersEl.textContent = 'No worker heartbeat yet. Start the Mac mini worker.';
        return;
      }
      workersEl.innerHTML = '<table><thead><tr><th>Worker</th><th>Health</th><th>Status</th><th>Current Job</th><th>Last Seen</th></tr></thead><tbody>' +
        workers.map(worker => '<tr>' +
          '<td><code>' + esc(worker.id) + '</code><br><span class="muted">' + esc(worker.version || '') + '</span></td>' +
          '<td>' + esc(worker.health) + '</td>' +
          '<td>' + esc(worker.status || '') + '</td>' +
          '<td><code>' + esc(worker.current_job_id || '') + '</code></td>' +
          '<td>' + esc(worker.last_seen_at || '') + '</td>' +
        '</tr>').join('') +
        '</tbody></table>';
    }

    function show(data) {
      output.textContent = JSON.stringify(data, null, 2);
      return data;
    }

    function esc(s) {
      return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
    }

    // Download with auth header (plain <a href> doesn't send Authorization)
    document.addEventListener('click', async (e) => {
      const btn = e.target.closest('.download-btn');
      if (!btn) return;
      const url = btn.dataset.url;
      const name = btn.dataset.name || 'video.mp4';
      btn.disabled = true;
      btn.textContent = 'Downloading…';
      try {
        const res = await fetch(url, { headers: { 'authorization': 'Bearer ' + apiKey.value.trim() } });
        if (!res.ok) { show({ error: 'Download failed', status: res.status }); return; }
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        URL.revokeObjectURL(a.href);
      } catch (err) { show({ error: err.message }); }
      finally { btn.disabled = false; btn.textContent = 'Download'; }
    });

    // Auto-refresh when API key is entered
    let keyDebounce;
    apiKey.addEventListener('input', () => {
      clearTimeout(keyDebounce);
      keyDebounce = setTimeout(() => { if (apiKey.value.trim()) refreshAll().catch(() => {}); }, 500);
    });
  </script>
</body>
</html>`;
}

function debugHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Video Renderer Debug</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #10100d; color: #f4efe2; }
    main { max-width: 1100px; margin: 0 auto; padding: 30px 18px 60px; }
    h1 { margin: 0 0 18px; font-size: 28px; }
    section { background: #191813; border: 1px solid #383429; border-radius: 8px; padding: 16px; margin: 14px 0; }
    label { display: block; font-size: 12px; font-weight: 700; color: #c9bea5; margin-bottom: 6px; }
    input { width: 100%; box-sizing: border-box; border: 1px solid #4b4537; border-radius: 6px; padding: 10px; background: #0f0f0c; color: #f4efe2; font: inherit; }
    button { border: 0; border-radius: 6px; padding: 10px 13px; background: #f4efe2; color: #10100d; font-weight: 800; cursor: pointer; margin-top: 10px; }
    pre { white-space: pre-wrap; word-break: break-word; background: #050504; color: #e9ffd3; border-radius: 8px; padding: 14px; min-height: 360px; overflow: auto; }
    .muted { color: #aaa18f; font-size: 13px; }
    .status { display: inline-block; padding: 5px 8px; border-radius: 6px; font-weight: 800; background: #423e31; margin-left: 8px; }
    .ok { background: #244b32; color: #d7ffe2; }
    .bad { background: #5a2525; color: #ffe1df; }
  </style>
</head>
<body>
  <main>
    <h1>Production Debug <span id="status" class="status">waiting</span></h1>
    <p class="muted"><a href="/" style="color:#f4efe2">Dashboard</a> · <a href="/docs" style="color:#f4efe2">API Docs</a></p>
    <section>
      <label for="apiKey">Requester API Key</label>
      <input id="apiKey" type="password" placeholder="REQUESTER_API_KEY" autocomplete="off" />
      <p class="muted">This endpoint redacts secrets but still requires auth.</p>
      <button id="run">Run Diagnostics</button>
    </section>
    <section>
      <label>Report</label>
      <pre id="out">Open this page on production, enter REQUESTER_API_KEY, then run diagnostics.</pre>
    </section>
  </main>
  <script>
    const apiKey = document.getElementById('apiKey');
    const out = document.getElementById('out');
    const status = document.getElementById('status');
    apiKey.value = localStorage.getItem('videoRendererApiKey') || '';
    apiKey.addEventListener('input', () => localStorage.setItem('videoRendererApiKey', apiKey.value));
    document.getElementById('run').addEventListener('click', run);
    async function run() {
      status.textContent = 'running';
      status.className = 'status';
      try {
        const res = await fetch('/api/debug', {
          headers: { authorization: 'Bearer ' + apiKey.value.trim() }
        });
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch { data = { raw: text }; }
        out.textContent = JSON.stringify(data, null, 2);
        status.textContent = data.ok ? 'ok' : 'problem';
        status.className = 'status ' + (data.ok ? 'ok' : 'bad');
      } catch (err) {
        out.textContent = String(err && err.message ? err.message : err);
        status.textContent = 'failed';
        status.className = 'status bad';
      }
    }
  </script>
</body>
</html>`;
}

function docsHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Video Renderer API Docs</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f7f7f4; color: #171713; }
    main { max-width: 1040px; margin: 0 auto; padding: 32px 18px 70px; }
    nav { display: flex; gap: 10px; flex-wrap: wrap; margin: 12px 0 26px; }
    nav a, .pill { border: 1px solid #d8d6ce; border-radius: 6px; padding: 7px 9px; color: #171713; text-decoration: none; background: #fff; }
    h1 { margin: 0; font-size: 30px; letter-spacing: 0; }
    h2 { margin: 28px 0 10px; font-size: 22px; }
    h3 { margin: 20px 0 8px; font-size: 16px; }
    p, li { line-height: 1.6; }
    section { background: #fff; border: 1px solid #dedbd2; border-radius: 8px; padding: 18px; margin: 14px 0; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #efede5; padding: 2px 4px; border-radius: 4px; }
    pre { white-space: pre-wrap; word-break: break-word; background: #171713; color: #f6f1e3; border-radius: 8px; padding: 14px; overflow: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { text-align: left; border-bottom: 1px solid #ebe8de; padding: 9px 6px; vertical-align: top; }
    th { color: #555146; font-size: 12px; text-transform: uppercase; }
    .muted { color: #706b5f; }
    .method { font-weight: 900; min-width: 64px; display: inline-block; }
    .get { color: #116329; }
    .post { color: #8a4b00; }
    @media (max-width: 760px) { main { padding-top: 22px; } table { font-size: 12px; } }
  </style>
</head>
<body>
  <main>
    <h1>Video Renderer API Docs</h1>
    <p class="muted">Public VPS/Railway API plus private Mac mini worker protocol.</p>
    <nav>
      <a href="/">Dashboard</a>
      <a href="/debug">Debug</a>
      <a href="#quickstart">Quickstart</a>
      <a href="#requester-api">Requester API</a>
      <a href="#worker-api">Worker API</a>
      <a href="#workflow">Workflow</a>
    </nav>

    <section id="overview">
      <h2>Overview</h2>
      <p>The server stores prompt-only render jobs in Postgres and final video files under mounted storage at <code>/storage/results</code>. The Mac mini does not accept inbound traffic. It polls this server, claims work, calls MiniMax locally, renders locally, then uploads the result back.</p>
      <pre>Requester -> Railway WebUI/API -> Postgres + /storage
                              ^
                              |
                       Mac mini worker polls outbound</pre>
    </section>

    <section>
      <h2>Authentication</h2>
      <table>
        <thead><tr><th>Actor</th><th>Secret</th><th>Used For</th></tr></thead>
        <tbody>
          <tr><td>Requester</td><td><code>REQUESTER_API_KEY</code></td><td>Create jobs, check status, download results, view worker health/debug.</td></tr>
          <tr><td>Mac mini worker</td><td><code>WORKER_SECRET</code></td><td>Heartbeat, claim jobs, send progress, upload result, mark failure.</td></tr>
        </tbody>
      </table>
      <pre>Authorization: Bearer YOUR_SECRET</pre>
    </section>

    <section id="quickstart">
      <h2>Quickstart</h2>
      <h3>Create a job</h3>
      <pre>curl -X POST https://video-renderer.up.railway.app/api/jobs \\
  -H 'Authorization: Bearer REQUESTER_API_KEY' \\
  -H 'Content-Type: application/json' \\
  -d '{
    "prompt": "Create a 30 second product explainer about an AI invoice app",
    "aspect": "16:9",
    "duration_sec": 30,
    "language": "English"
  }'</pre>
      <h3>Check job status</h3>
      <pre>curl https://video-renderer.up.railway.app/api/jobs/JOB_ID \\
  -H 'Authorization: Bearer REQUESTER_API_KEY'</pre>
      <h3>Download result</h3>
      <pre>curl -L https://video-renderer.up.railway.app/api/jobs/JOB_ID/result.mp4 \\
  -H 'Authorization: Bearer REQUESTER_API_KEY' \\
  -o output.mp4</pre>
    </section>

    <section id="requester-api">
      <h2>Requester API</h2>
      <table>
        <thead><tr><th>Method</th><th>Path</th><th>Description</th><th>Auth</th></tr></thead>
        <tbody>
          <tr><td><span class="method get">GET</span></td><td><code>/</code></td><td>Browser dashboard.</td><td>Page public, API calls require requester key.</td></tr>
          <tr><td><span class="method get">GET</span></td><td><code>/docs</code></td><td>This API documentation.</td><td>No secret shown.</td></tr>
          <tr><td><span class="method get">GET</span></td><td><code>/health</code></td><td>Basic service liveness.</td><td>No</td></tr>
          <tr><td><span class="method post">POST</span></td><td><code>/api/jobs</code></td><td>Create a render job.</td><td>Requester</td></tr>
          <tr><td><span class="method get">GET</span></td><td><code>/api/jobs?limit=20</code></td><td>List recent jobs.</td><td>Requester</td></tr>
          <tr><td><span class="method get">GET</span></td><td><code>/api/jobs/:id</code></td><td>Get one job status.</td><td>Requester</td></tr>
          <tr><td><span class="method get">GET</span></td><td><code>/api/jobs/:id/result.mp4</code></td><td>Download final MP4.</td><td>Requester</td></tr>
          <tr><td><span class="method get">GET</span></td><td><code>/api/workers</code></td><td>List Mac mini worker health.</td><td>Requester</td></tr>
          <tr><td><span class="method get">GET</span></td><td><code>/debug</code></td><td>Browser diagnostics page.</td><td>Page public, report requires requester key.</td></tr>
          <tr><td><span class="method get">GET</span></td><td><code>/api/debug</code></td><td>Production diagnostic JSON.</td><td>Requester</td></tr>
        </tbody>
      </table>

      <h3>Create Job Body</h3>
      <pre>{
  "prompt": "What to create",
  "aspect": "16:9",
  "duration_sec": 30,
  "language": "English",
  "voice": "optional voice id",
  "music": "optional music prompt",
  "metadata": {}
}</pre>

      <h3>Job Status Response</h3>
      <pre>{
  "job": {
    "id": "job_...",
    "status": "queued | claimed | planning | generating_assets | rendering | uploading | completed | failed | cancelled",
    "progress": 0,
    "message": "Queued",
    "instruction": "...",
    "input": {},
    "result_url": null,
    "error": null,
    "worker_id": null,
    "created_at": "...",
    "updated_at": "...",
    "claimed_at": null,
    "completed_at": null
  }
}</pre>
    </section>

    <section id="templates">
      <h2>Template System</h2>
      <p>The worker includes 22 premium templates with sophisticated CSS animations, Google Fonts, and precise timing. MiniMax M3 analyzes each prompt and selects the best template automatically.</p>
      <table>
        <thead><tr><th>Template</th><th>Category</th><th>Best For</th></tr></thead>
        <tbody>
          <tr><td><code>frame-bold-signal</code></td><td>Section title</td><td>Bold launch statements, high-impact cards</td></tr>
          <tr><td><code>frame-kinetic-type</code></td><td>Text promo</td><td>Promo headlines, punchy intros</td></tr>
          <tr><td><code>frame-data-chart-nyt</code></td><td>Data chart</td><td>Data storytelling, metrics dashboards</td></tr>
          <tr><td><code>frame-glitch-title</code></td><td>Title effect</td><td>Tech announcements, glitch aesthetics</td></tr>
          <tr><td><code>frame-light-leak-cinema</code></td><td>Cinematic</td><td>Film-style reveals, warm lighting</td></tr>
          <tr><td><code>frame-liquid-bg-hero</code></td><td>Hero section</td><td>Product launches, fluid backgrounds</td></tr>
          <tr><td><code>frame-pentagram-stat</code></td><td>Statistics</td><td>Milestone announcements, key metrics</td></tr>
          <tr><td><code>frame-product-promo</code></td><td>Product promo</td><td>Feature showcases, product tours</td></tr>
          <tr><td colspan="3" class="muted">+ 14 more templates (swiss-grid, vignelli, warm-grain, etc.)</td></tr>
        </tbody>
      </table>
      <p>Templates are selected automatically based on the prompt content. The worker uses MiniMax M3 to match intent to template capabilities.</p>
    </section>

    <section id="worker-api">
      <h2>Worker API</h2>
      <p>These endpoints are private to the Mac mini worker and require <code>WORKER_SECRET</code>.</p>
      <table>
        <thead><tr><th>Method</th><th>Path</th><th>Description</th></tr></thead>
        <tbody>
          <tr><td><span class="method post">POST</span></td><td><code>/api/worker/heartbeat</code></td><td>Report worker health without claiming a job.</td></tr>
          <tr><td><span class="method post">POST</span></td><td><code>/api/worker/claim</code></td><td>Atomically claim the oldest queued job.</td></tr>
          <tr><td><span class="method post">POST</span></td><td><code>/api/worker/jobs/:id/progress</code></td><td>Update job status, progress, and message.</td></tr>
          <tr><td><span class="method post">POST</span></td><td><code>/api/worker/jobs/:id/upload</code></td><td>Upload final MP4 bytes. Server stores at <code>/storage/results/:id/output.mp4</code>.</td></tr>
          <tr><td><span class="method post">POST</span></td><td><code>/api/worker/jobs/:id/fail</code></td><td>Mark job failed with an error message.</td></tr>
        </tbody>
      </table>

      <h3>Run Worker on Mac Mini</h3>
      <pre>cd ~/Documents/video-renderer
node packages/cli/dist/bin.js worker \\
  --server https://video-renderer.up.railway.app \\
  --secret WORKER_SECRET</pre>

      <p>The worker auto-discovers MiniMax credentials from <code>MINIMAX_API_KEY</code> env var or <code>~/.mmx/config.json</code>.</p>
      <p>The MiniMax key belongs only on the Mac mini worker. Railway does not need it.</p>

      <h3>Worker Health</h3>
      <table>
        <thead><tr><th>Health</th><th>Meaning</th></tr></thead>
        <tbody>
          <tr><td><code>online</code></td><td>Last heartbeat was within 30 seconds.</td></tr>
          <tr><td><code>stale</code></td><td>Last heartbeat was 30 to 120 seconds ago.</td></tr>
          <tr><td><code>offline</code></td><td>Last heartbeat is older than 120 seconds.</td></tr>
        </tbody>
      </table>
    </section>

    <section id="workflow">
      <h2>Job Workflow</h2>
      <ol>
        <li>Requester creates a prompt-only job with <code>POST /api/jobs</code>.</li>
        <li>Server stores the job in Postgres as <code>queued</code>.</li>
        <li>Mac mini worker polls <code>POST /api/worker/claim</code>.</li>
        <li>Server atomically marks one job as <code>claimed</code> using Postgres row locking.</li>
        <li>Worker loads 22 premium templates from the html-video template library (bold-signal, kinetic-type, data-chart-nyt, glitch-title, light-leak-cinema, liquid-bg-hero, etc.).</li>
        <li>Worker calls MiniMax M3 to analyze the prompt and select the best template, then generates title, narration script, and template-specific content (stats, data, labels).</li>
        <li>Worker fills the selected template's HTML with generated content — preserving the template's sophisticated CSS animations, Google Fonts, and precise timing.</li>
        <li>Worker calls MiniMax TTS to generate narration audio from the script.</li>
        <li>Worker renders the template HTML through the local html-video Hyperframes adapter at 60fps (parallel capture across 6 Chromium pages on M4).</li>
        <li>Worker muxes audio with ffmpeg and reports progress: <code>planning</code>, <code>generating_assets</code>, <code>rendering</code>, <code>uploading</code>.</li>
        <li>Worker uploads the final MP4 to <code>/api/worker/jobs/:id/upload</code>.</li>
        <li>Server writes the MP4 to mounted storage under <code>/storage/results/:id/output.mp4</code>.</li>
        <li>Server marks the job <code>completed</code>.</li>
        <li>Requester checks <code>GET /api/jobs/:id</code> and downloads <code>GET /api/jobs/:id/result.mp4</code>.</li>
      </ol>
    </section>

    <section>
      <h2>Production Diagnostics</h2>
      <p>Open <a href="/debug">/debug</a>, enter <code>REQUESTER_API_KEY</code>, then run diagnostics. It checks Postgres, mounted storage, recent jobs, workers, Railway env, and runtime memory. Secrets are redacted.</p>
    </section>
  </main>
</body>
</html>`;
}
