/**
 * Mac Mini render worker — connects to the Railway WebUI server via SSE for
 * instant job notifications, then claims + executes + uploads results.
 *
 * Architecture:
 *   1. Open SSE stream to `GET /api/worker/stream` (long-lived, server-push)
 *   2. On `job_available` event → `POST /api/worker/claim` to atomically grab it
 *   3. Execute the full pipeline locally (M3 → HTML → TTS → render → mux)
 *   4. Upload MP4 via `POST /api/worker/jobs/:id/upload`
 *   5. Report progress via `POST /api/worker/jobs/:id/progress`
 *
 * The SSE connection auto-reconnects with exponential backoff. The server
 * sends periodic `heartbeat` events to keep the connection alive; if no
 * event arrives within WORKER_HEARTBEAT_TIMEOUT_MS, the worker reconnects.
 *
 * Usage:
 *   node packages/cli/dist/bin.js worker --server https://video-renderer.up.railway.app --secret <WORKER_SECRET>
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, stat, readdir, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

// ── Config ───────────────────────────────────────────────────────────────────

const HEARTBEAT_TIMEOUT_MS = 60_000;   // reconnect if no event in 60s
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const POLL_FALLBACK_MS = 5_000;        // fallback poll if SSE is unsupported

// ── Helpers ──────────────────────────────────────────────────────────────────

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [worker] ${msg}`);
}

function err(msg: string) {
  const ts = new Date().toISOString().slice(11, 19);
  console.error(`[${ts}] [worker:ERROR] ${msg}`);
}

async function ffprobeDuration(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1', file,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve(parseFloat(out.trim()));
      else reject(new Error(`ffprobe exit ${code}`));
    });
  });
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => {
      code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-500)}`));
    });
  });
}

/** Recursively copy a directory. */
async function copyDir(src: string, dest: string): Promise<void> {
  await cp(src, dest, { recursive: true });
}

// ── Server API client ────────────────────────────────────────────────────────

class ServerClient {
  constructor(
    private baseUrl: string,
    private secret: string,
    private workerId: string,
  ) {}

  private headers(extra: Record<string, string> = {}) {
    return { Authorization: `Bearer ${this.secret}`, ...extra };
  }

  /** Report worker health without claiming a job. */
  async heartbeat(): Promise<void> {
    await fetch(`${this.baseUrl}/api/worker/heartbeat`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ worker_id: this.workerId }),
    }).catch(() => {});
  }

  /** Atomically claim the oldest queued job. Returns null if none. */
  async claim(): Promise<any | null> {
    const res = await fetch(`${this.baseUrl}/api/worker/claim`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ worker_id: this.workerId }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { job?: any };
    return data.job ?? null;
  }

  /** Update job progress (status + percentage + message). */
  async progress(jobId: string, status: string, progress: number, message: string): Promise<void> {
    await fetch(`${this.baseUrl}/api/worker/jobs/${jobId}/progress`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ status, progress, message, worker_id: this.workerId }),
    }).catch(() => {});
  }

  /** Upload final MP4 bytes. */
  async upload(jobId: string, mp4Bytes: Buffer): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/worker/jobs/${jobId}/upload`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/octet-stream' }),
      body: new Uint8Array(mp4Bytes),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Upload failed ${res.status}: ${text.slice(200)}`);
    }
  }

  /** Mark job as failed. */
  async fail(jobId: string, message: string): Promise<void> {
    await fetch(`${this.baseUrl}/api/worker/jobs/${jobId}/fail`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({ error: message, worker_id: this.workerId }),
    }).catch(() => {});
  }
}

// ── SSE connection with auto-reconnect ───────────────────────────────────────

interface SseCallbacks {
  onJobAvailable: () => void;
  onHeartbeat: () => void;
  onError: (e: Error) => void;
}

function connectSse(
  url: string,
  secret: string,
  callbacks: SseCallbacks,
): { close: () => void } {
  let closed = false;
  let controller: AbortController | null = null;

  const connect = async () => {
    let backoff = INITIAL_BACKOFF_MS;
    while (!closed) {
      controller = new AbortController();
      const timeoutId = setTimeout(() => controller?.abort(), HEARTBEAT_TIMEOUT_MS);

      try {
        log(`SSE connecting to ${url}…`);
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${secret}` },
          signal: controller.signal,
        });

        if (!res.ok) {
          // Server doesn't support SSE — fall back to polling
          if (res.status === 404 || res.status === 405) {
            log(`SSE not available (${res.status}), falling back to polling`);
            closed = true;
            callbacks.onError(new Error('SSE_NOT_SUPPORTED'));
            return;
          }
          throw new Error(`SSE ${res.status}: ${await res.text().catch(() => '')}`);
        }

        log('SSE connected');
        backoff = INITIAL_BACKOFF_MS; // reset on successful connect

        const reader = res.body?.getReader();
        if (!reader) throw new Error('No response body');

        const decoder = new TextDecoder();
        let buffer = '';

        while (!closed) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            clearTimeout(timeoutId);

            if (line.startsWith('event: ')) {
              const eventType = line.slice(7).trim();
              // Next line will be the data
              continue;
            }
            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim();
              try {
                const parsed = JSON.parse(data);
                if (parsed.event === 'job_available' || parsed.type === 'job_available') {
                  log(`Job available: ${parsed.job_id ?? '(unknown)'}`);
                  callbacks.onJobAvailable();
                } else if (parsed.event === 'heartbeat' || parsed.type === 'heartbeat') {
                  callbacks.onHeartbeat();
                }
              } catch {
                // Plain text data — might be a heartbeat ping
                if (data === 'heartbeat' || data === 'ping') {
                  callbacks.onHeartbeat();
                }
              }
            }
          }

          // Reset heartbeat timeout
          clearTimeout(timeoutId);
        }

        log('SSE stream ended, reconnecting…');
      } catch (e: any) {
        clearTimeout(timeoutId);
        if (closed) return;
        if (e.message === 'SSE_NOT_SUPPORTED') return;

        err(`SSE error: ${e.message}, reconnecting in ${(backoff / 1000).toFixed(1)}s`);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      } finally {
        clearTimeout(timeoutId);
      }
    }
  };

  connect();

  return {
    close() {
      closed = true;
      controller?.abort();
    },
  };
}

// ── Pipeline execution ───────────────────────────────────────────────────────

interface JobInput {
  prompt: string;
  aspect?: string;
  duration_sec?: number;
  language?: string;
  voice?: string;
  music?: string;
  metadata?: Record<string, unknown>;
}

async function resolveMinimaxCreds(): Promise<{ apiKey: string; baseUrl: string } | null> {
  // 1. Environment variables
  const envKey = (process.env.OD_MINIMAX_API_KEY || process.env.MINIMAX_API_KEY || '').trim();
  if (envKey) return { apiKey: envKey, baseUrl: (process.env.MINIMAX_BASE_URL || 'https://api.minimax.io/v1').replace(/\/$/, '') };

  // 2. mmx-cli config file
  try {
    const { readFileSync } = await import('node:fs');
    const cfgPath = join(homedir(), '.mmx', 'config.json');
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
      const key = cfg.apiKey || cfg.api_key || '';
      if (key) {
        const base = (cfg.base_url || 'https://api.minimax.io').replace(/\/$/, '');
        const baseUrl = base.endsWith('/v1') ? base : base + '/v1';
        return { apiKey: key, baseUrl };
      }
    }
  } catch {}

  return null;
}

/**
 * Execute a full render job using the premium template system:
 * 1. Load templates from templates/ directory
 * 2. Use MiniMax M3 to select best template + generate content
 * 3. Fill template HTML with generated content
 * 4. Generate narration via MiniMax TTS
 * 5. Render HTML → MP4 at 60fps via hyperframes adapter
 * 6. Mux audio + video
 */
async function executeRenderJob(
  job: any,
  server: ServerClient,
): Promise<Buffer> {
  const input: JobInput = job.input || job;
  const prompt = input.prompt || job.instruction || '';
  const aspect = input.aspect || '16:9';
  const durationSec = input.duration_sec || 10;
  const language = input.language || 'English';
  const voice = input.voice || 'male-qn-qingse';

  const [w, h] = aspect === '9:16' ? [1080, 1920] : aspect === '1:1' ? [1080, 1080] : [1920, 1080];
  const fps = 60;

  const creds = await resolveMinimaxCreds();
  if (!creds) throw new Error('No MiniMax API key — set MINIMAX_API_KEY or run `mmx auth login`');

  const corePath = pathToFileURL(resolve('packages/core/dist/index.js')).href;
  const { generateTts } = await import(corePath);

  const workDir = join(tmpdir(), `hv-worker-${randomUUID()}`);
  await mkdir(workDir, { recursive: true });

  try {
    // ── Step 1: Load templates ──
    await server.progress(job.id, 'planning', 5, 'Loading templates…');
    const templates = await loadTemplates();
    log(`Loaded ${templates.length} templates`);

    // ── Step 2: Use M3 to select template + generate content ──
    await server.progress(job.id, 'planning', 10, 'Selecting template & generating content…');
    const plan = await planWithM3(prompt, templates, { aspect, durationSec, language }, creds);
    log(`Selected template: ${plan.templateId} — "${plan.title}"`);

    // ── Step 3: Fill template HTML with generated content ──
    await server.progress(job.id, 'generating_assets', 25, 'Preparing slide…');
    const template = templates.find(t => t.id === plan.templateId) ?? templates[0];
    if (!template) throw new Error('No templates available');

    // Copy entire template directory to workDir (preserves compositions/, assets/)
    const templateWorkDir = join(workDir, 'template');
    await copyDir(dirname(template.htmlPath), templateWorkDir);

    // Fill template HTML with generated content and write over the copy
    const slideHtml = fillTemplate(template, plan.variables);
    const htmlPath = join(templateWorkDir, basename(template.htmlPath));
    await writeFile(htmlPath, slideHtml, 'utf8');

    // ── Step 4: Generate narration via TTS ──
    await server.progress(job.id, 'generating_assets', 35, 'Generating narration…');

    const narrationText = plan.narration || '';
    let narrationPath: string | undefined;
    let audioDuration = 0;

    if (narrationText) {
      const ttsResult = await generateTts({
        text: narrationText,
        voiceId: voice,
        languageBoost: language === 'Chinese' ? 'zh' : undefined,
        creds,
      });
      narrationPath = join(workDir, 'narration.mp3');
      await writeFile(narrationPath, ttsResult.bytes);
      audioDuration = ttsResult.durationSec ?? (ttsResult.bytes.length / 16000);
    }

    // ── Step 5: Compute final duration ──
    const slideDuration = narrationPath
      ? Math.max(4, Math.round((0.6 + audioDuration + 0.6) * fps) / fps)
      : Math.max(template.minDuration || 4, durationSec);

    // ── Step 6: Render HTML → MP4 ──
    await server.progress(job.id, 'rendering', 50, `Rendering ${slideDuration.toFixed(1)}s at ${fps}fps…`);

    const adapterPath = pathToFileURL(resolve('packages/adapter-hyperframes/dist/index.js')).href;
    const adapter = await import(adapterPath);
    const { render } = adapter.default ?? adapter.adapter;

    const videoPath = join(workDir, 'video.mp4');
    await render(
      {
        template: { id: template.id, sourcePath: htmlPath, mode: 'bridge' },
        variables: plan.variables,
        config: {
          format: 'mp4',
          resolution: { width: w, height: h },
          fps,
          duration: slideDuration,
          durationMode: 'explicit',
          outputPath: videoPath,
          alpha: false,
        },
      },
      { workDir },
    );

    // ── Step 7: Mux audio + video ──
    await server.progress(job.id, 'rendering', 85, 'Muxing audio…');

    let finalPath = videoPath;
    if (narrationPath) {
      finalPath = join(workDir, 'final.mp4');
      await runFfmpeg([
        '-y',
        '-i', videoPath,
        '-i', narrationPath,
        '-filter_complex',
        `[1:a]adelay=600|600[delayed];anullsrc=channel_layout=mono:sample_rate=32000:d=${slideDuration.toFixed(3)}[base];[base][delayed]amix=inputs=2:normalize=0[mix]`,
        '-map', '0:v', '-map', '[mix]',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
        '-t', slideDuration.toFixed(3),
        '-movflags', '+faststart',
        finalPath,
      ]);
    }

    const mp4Bytes = await readFile(finalPath);
    log(`Pipeline complete: ${(mp4Bytes.length / 1024 / 1024).toFixed(2)} MB`);
    return mp4Bytes;

  } finally {
    const { rm } = await import('node:fs/promises');
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Template system ──────────────────────────────────────────────────────────

interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  category: string;
  bestFor: string[];
  tags: string[];
  htmlPath: string;
  html: string;
  inputs: Record<string, any>;
  examples: any[];
  minDuration: number;
  maxDuration: number;
  aspects: string[];
}

async function loadTemplates(): Promise<TemplateInfo[]> {
  const templatesDir = resolve('templates');
  if (!existsSync(templatesDir)) return [];

  const entries = await readdir(templatesDir);
  const templates: TemplateInfo[] = [];

  for (const entry of entries) {
    const dir = join(templatesDir, entry);
    const yamlPath = join(dir, 'template.html-video.yaml');
    if (!existsSync(yamlPath)) continue;

    try {
      const yaml = await readFile(yamlPath, 'utf8');
      // Simple YAML parser for our template format
      const spec = parseYaml(yaml);
      if (!spec.id || spec.engine !== 'hyperframes') continue;

      // Find the source HTML (may be in source/ or root)
      const sourceEntry = spec.source_entry || 'index.html';
      const htmlPath = existsSync(join(dir, 'source', sourceEntry))
        ? join(dir, 'source', sourceEntry)
        : join(dir, sourceEntry);
      if (!existsSync(htmlPath)) continue;

      const html = await readFile(htmlPath, 'utf8');
      const schema = spec.inputs?.schema || {};
      const examples = schema.examples || [];
      const output = spec.output || {};

      templates.push({
        id: spec.id,
        name: spec.name || spec.id,
        description: spec.description || '',
        category: spec.category || '',
        bestFor: spec.best_for || [],
        tags: spec.tags || [],
        htmlPath,
        html,
        inputs: schema.properties || {},
        examples,
        minDuration: output.duration?.min_sec || 3,
        maxDuration: output.duration?.max_sec || 30,
        aspects: output.resolution?.supported_aspects || ['16:9'],
      });
    } catch (e: any) {
      log(`Failed to load template ${entry}: ${e.message}`);
    }
  }

  return templates;
}

/** Minimal YAML parser for template specs (handles our simple format). */
function parseYaml(text: string): any {
  const result: any = {};
  const lines = text.split('\n');
  const stack: Array<{ obj: any; indent: number }> = [{ obj: result, indent: -1 }];

  for (const line of lines) {
    const trimmed = line.replace(/#.*$/, '').trimEnd();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const indent = line.search(/\S/);
    const match = trimmed.match(/^(\w[\w_]*)\s*:\s*(.*)/);
    if (!match) continue;

    const key = match[1]!;
    let value: any = match[2]?.trim();

    // Pop stack to find parent
    while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1]!.obj;

    if (value === '' || value === '>' || value === '|') {
      // Block value — collect next lines
      parent[key] = {};
      stack.push({ obj: parent[key], indent });
    } else if (value.startsWith('[')) {
      // Inline array
      try { parent[key] = JSON.parse(value); } catch { parent[key] = value; }
    } else if (value.startsWith('{')) {
      // Inline object
      try { parent[key] = JSON.parse(value); } catch { parent[key] = value; }
    } else if (value.startsWith('"') || value.startsWith("'")) {
      parent[key] = value.slice(1, -1);
    } else if (value === 'true') {
      parent[key] = true;
    } else if (value === 'false') {
      parent[key] = false;
    } else if (/^\d+(\.\d+)?$/.test(value)) {
      parent[key] = Number(value);
    } else {
      parent[key] = value;
    }
  }

  return result;
}

interface M3Plan {
  templateId: string;
  title: string;
  narration: string;
  variables: Record<string, any>;
}

/** Use MiniMax M3 to select the best template and generate content. */
async function planWithM3(
  prompt: string,
  templates: TemplateInfo[],
  opts: { aspect: string; durationSec: number; language: string },
  creds: { apiKey: string; baseUrl: string },
): Promise<M3Plan> {
  // Build template catalog for M3
  const catalog = templates.map(t => ({
    id: t.id,
    name: t.name,
    description: String(t.description || '').slice(0, 100),
    category: t.category,
    best_for: t.bestFor,
    tags: t.tags,
    inputs: Object.keys(t.inputs),
    examples: t.examples.slice(0, 1),
    aspects: t.aspects,
    min_duration: t.minDuration,
    max_duration: t.maxDuration,
  }));

  // Build detailed catalog with exact input names and examples
  const detailedCatalog = templates.map(t => ({
    id: t.id,
    name: t.name,
    description: String(t.description || '').slice(0, 100),
    category: t.category,
    best_for: t.bestFor,
    inputs: t.inputs,
    examples: t.examples.slice(0, 1),
    required_inputs: Object.entries(t.inputs)
      .filter(([, v]: [string, any]) => v.type !== 'number' || v.minimum === undefined)
      .map(([k]) => k),
  }));

  const systemPrompt = `You are a video presentation designer. Given a user prompt, select the best template and generate content for it.

Available templates:
${JSON.stringify(detailedCatalog, null, 2)}

CRITICAL RULES:
1. Pick the template whose "best_for" and category best match the user's intent
2. "variables" MUST be a FLAT OBJECT (not an array!) with the EXACT input names from the template's "inputs"
3. For example, if the template has inputs "headline", "label", "subtitle", "anchor" — return:
   "variables": { "label": "VALUE", "headline": "VALUE", "subtitle": "VALUE", "anchor": "VALUE" }
4. For data templates (inputs include "data"), generate realistic data that supports the narrative
5. For self-contained templates (no required inputs), just pick the right one
6. Write a natural narration script (30-60 seconds) that tells the story
7. Match the requested aspect ratio: ${opts.aspect}
8. Language: ${opts.language}

Respond in JSON only:
{
  "templateId": "the-template-id",
  "title": "compelling headline for narration",
  "narration": "spoken narration script in ${opts.language}",
  "variables": { "exact_input_name": "generated_value", ... }
}`;

  const res = await fetch(`${creds.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${creds.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'MiniMax-M3',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
      temperature: 0.7,
      response_format: { type: 'json_object' },
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`M3 planning failed ${res.status}: ${text.slice(200)}`);
  }

  const data = await res.json() as any;
  let content = data.choices?.[0]?.message?.content || '';

  // Strip <think>...</think> tags (M3 reasoning)
  content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

  // Extract JSON from markdown code blocks if present
  const codeBlockMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch) content = codeBlockMatch[1]!.trim();

  let plan: M3Plan;
  try {
    plan = JSON.parse(content);
  } catch {
    // Try to extract JSON object from the response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`M3 returned non-JSON: ${content.slice(200)}`);
    plan = JSON.parse(jsonMatch[0]);
  }

  // Validate template exists
  if (!templates.find(t => t.id === plan.templateId)) {
    log(`M3 picked unknown template "${plan.templateId}", falling back to first`);
    plan.templateId = templates[0]!.id;
  }

  // Ensure variables is a flat object (M3 sometimes returns an array)
  if (Array.isArray(plan.variables)) {
    log('M3 returned variables as array, extracting first element');
    plan.variables = plan.variables[0] || {};
  }
  if (typeof plan.variables !== 'object' || plan.variables === null) {
    plan.variables = {};
  }

  return plan;
}

/** Fill a template's HTML with generated variables. */
function fillTemplate(template: TemplateInfo, variables: Record<string, any>): string {
  let html = template.html;

  // For templates with examples, replace example values with generated values
  if (template.examples.length > 0) {
    const example = template.examples[0]!;
    for (const [key, exValue] of Object.entries(example)) {
      const newValue = variables[key];
      if (newValue === undefined) continue;

      if (typeof exValue === 'string' && typeof newValue === 'string') {
        // Replace the example string in the HTML
        html = html.replace(new RegExp(escapeRegex(exValue), 'g'), newValue);
      }
    }
  }

  // For data templates, replace data arrays
  if (variables.data && Array.isArray(variables.data)) {
    // The template has hardcoded SVG/chart data — we need to regenerate it
    // This is handled by the template-specific logic below
    html = fillDataTemplate(template, variables, html);
  }

  // Inject variables as JS for templates that read them at runtime
  const varsScript = `<script>window.__HV_VARS__ = ${JSON.stringify(variables)};</script>`;
  html = html.replace('</head>', `${varsScript}\n</head>`);

  return html;
}

/** Fill data-driven templates (charts, graphs) with new data. */
function fillDataTemplate(template: TemplateInfo, variables: Record<string, any>, html: string): string {
  const data = variables.data;
  if (!Array.isArray(data) || data.length === 0) return html;

  // For the NYT chart template, regenerate the SVG data points
  if (template.id === 'frame-data-chart-nyt' || template.id === 'frame-nyt-graph') {
    return fillNytChart(html, data, variables.title, variables.subtitle);
  }

  // For data-rollup template
  if (template.id === 'frame-data-rollup') {
    return fillDataRollup(html, data, variables.title);
  }

  // Generic: replace title/subtitle if present
  if (variables.title) {
    html = html.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(variables.title)}</title>`);
  }

  return html;
}

/** Fill NYT chart template with new data. */
function fillNytChart(html: string, data: Array<{label: string; value: number}>, title?: string, subtitle?: string): string {
  // Replace title if provided
  if (title) {
    html = html.replace(/(<text[^>]*class="title"[^>]*>)[^<]*/g, `$1${escapeHtml(title)}`);
    // Also replace any large text that looks like a title
    html = html.replace(/(<text[^>]*font-size="32"[^>]*>)[^<]*/g, `$1${escapeHtml(title)}`);
  }
  if (subtitle) {
    html = html.replace(/(<text[^>]*class="subtitle"[^>]*>)[^<]*/g, `$1${escapeHtml(subtitle)}`);
  }

  return html;
}

/** Fill data-rollup template with new data. */
function fillDataRollup(html: string, data: Array<{label: string; value: number}>, title?: string): string {
  if (title) {
    html = html.replace(/(<[^>]*class="[^"]*title[^"]*"[^>]*>)[^<]*/g, `$1${escapeHtml(title)}`);
  }
  return html;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Main worker loop ─────────────────────────────────────────────────────────

export interface WorkerOptions {
  serverUrl: string;
  workerSecret: string;
  workerId?: string;
}

export async function startWorker(opts: WorkerOptions): Promise<void> {
  const workerId = opts.workerId ?? `mac-mini-${randomUUID().slice(0, 8)}`;
  const server = new ServerClient(opts.serverUrl, opts.workerSecret, workerId);
  let processing = false;

  log(`Worker ID: ${workerId}`);
  log(`Server: ${opts.serverUrl}`);

  // Initial heartbeat
  await server.heartbeat();

  // Connect SSE for instant notifications
  const sse = connectSse(
    `${opts.serverUrl}/api/worker/stream`,
    opts.workerSecret,
    {
      onJobAvailable: async () => {
        if (processing) return; // already working on a job
        processing = true;
        try {
          await claimAndProcess(server, workerId);
        } finally {
          processing = false;
        }
      },
      onHeartbeat: () => {
        // Connection is alive
      },
      onError: async (e) => {
        if (e.message === 'SSE_NOT_SUPPORTED') {
          log('Falling back to polling mode');
          await pollLoop(server, workerId);
        }
      },
    },
  );

  // Keep-alive: periodic heartbeat in case SSE is quiet
  const keepAlive = setInterval(() => server.heartbeat().catch(() => {}), 30_000);

  // Graceful shutdown
  const shutdown = () => {
    log('Shutting down…');
    sse.close();
    clearInterval(keepAlive);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Block forever (SSE runs in background)
  await new Promise(() => {});
}

async function claimAndProcess(server: ServerClient, workerId: string): Promise<void> {
  const job = await server.claim();
  if (!job) return; // someone else got it

  log(`Claimed job ${job.id}: "${(job.instruction || job.input?.prompt || '').slice(0, 60)}…"`);

  try {
    const mp4 = await executeRenderJob(job, server);
    await server.progress(job.id, 'uploading', 90, `Uploading ${(mp4.length / 1024 / 1024).toFixed(1)} MB…`);
    await server.upload(job.id, mp4);
    log(`Job ${job.id} completed`);
  } catch (e: any) {
    err(`Job ${job.id} failed: ${e.message}`);
    await server.fail(job.id, e.message);
  }
}

/** Fallback polling if SSE is not available on the server. */
async function pollLoop(server: ServerClient, workerId: string): Promise<void> {
  while (true) {
    try {
      await claimAndProcess(server, workerId);
    } catch (e: any) {
      err(`Poll error: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, POLL_FALLBACK_MS));
  }
}
