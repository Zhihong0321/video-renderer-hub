/**
 * HTTP server for the project studio (RFC-05 §UI).
 * Serves @html-video/project-studio static UI + project / template REST APIs.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, copyFile, mkdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import type { CliContext } from './context.js';
import { AssetStore } from '@html-video/core';
import { detectAll, findAgent, spawnAgent } from '@html-video/runtime';

interface StudioHandle {
  url: string;
  port: number;
  close: () => void;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
};

function resolveUiRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '..', '..', 'project-studio', 'public'),
    resolve(here, '..', 'public'),
    resolve(here, '..', '..', 'storyboard-ui', 'public'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return candidates[0]!;
}

export async function startStudioServer(ctx: CliContext, port: number): Promise<StudioHandle> {
  const uiRoot = resolveUiRoot();

  const server = createServer(async (req, res) => {
    try {
      if (!req.url) {
        res.writeHead(400);
        res.end();
        return;
      }
      const url = new URL(req.url, 'http://x');
      const m = req.method ?? 'GET';

      // ============== API ==============

      // List projects
      if (url.pathname === '/api/projects' && m === 'GET') {
        const list = await ctx.orchestrator.list();
        return json(res, 200, { projects: list });
      }

      // Create project
      if (url.pathname === '/api/projects' && m === 'POST') {
        const body = await readBody(req);
        const project = await ctx.orchestrator.create({
          name: (body.name as string) ?? 'Untitled',
          ...(body.intent !== undefined && { intent: body.intent as string }),
          preferences: (body.preferences as Record<string, unknown>) ?? {},
        });
        return json(res, 200, { project });
      }

      // Get / update / delete single project
      const projMatch = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
      if (projMatch && projMatch[1]) {
        const id = projMatch[1];
        if (m === 'GET') {
          return json(res, 200, { project: await ctx.orchestrator.load(id) });
        }
        if (m === 'DELETE') {
          await ctx.orchestrator.remove(id);
          MESSAGES.delete(id);
          return json(res, 200, { ok: true });
        }
      }

      // List engines + templates
      if (url.pathname === '/api/templates' && m === 'GET') {
        return json(res, 200, {
          templates: ctx.templates.list().map((t) => ({
            id: t.id,
            name: t.name,
            description: t.description,
            engine: t.engine,
            category: t.category,
            tags: t.tags,
            best_for: t.best_for,
            inputs_schema: t.inputs.schema,
            inputs_examples: t.inputs.examples,
            license: t.license,
            preview: t.preview,
            output: t.output,
          })),
        });
      }

      // Add asset (multipart-style via JSON for v0.1: paths or inline content)
      const addAssetMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/assets$/);
      if (addAssetMatch && addAssetMatch[1] && m === 'POST') {
        const id = addAssetMatch[1];
        const ct = req.headers['content-type'] ?? '';
        let project;
        if (ct.startsWith('multipart/form-data')) {
          // Save uploaded file to /tmp then add
          const saved = await receiveMultipartFile(req, ct);
          project = await ctx.orchestrator.addFileAsset(id, saved.filePath);
        } else {
          const body = await readBody(req);
          if (body.kind === 'text') {
            project = await ctx.orchestrator.addInlineAsset(
              id,
              (body.content as string) ?? '',
              'text',
              body.caption as string | undefined,
            );
          } else if (body.kind === 'data') {
            project = await ctx.orchestrator.addInlineAsset(
              id,
              (body.content as string) ?? '',
              'data',
              body.caption as string | undefined,
            );
          } else if (body.kind === 'file' && body.path) {
            project = await ctx.orchestrator.addFileAsset(id, body.path as string);
          } else {
            return json(res, 400, { error: 'Provide kind=text|data|file with content/path' });
          }
        }
        return json(res, 200, { project });
      }

      // Remove asset
      const rmAssetMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/assets\/([^/]+)$/);
      if (rmAssetMatch && rmAssetMatch[1] && rmAssetMatch[2] && m === 'DELETE') {
        const project = await ctx.orchestrator.removeAsset(rmAssetMatch[1], rmAssetMatch[2]);
        return json(res, 200, { project });
      }

      // Set template
      const tplMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/template$/);
      if (tplMatch && tplMatch[1] && m === 'PUT') {
        const body = await readBody(req);
        const project = await ctx.orchestrator.setTemplate(tplMatch[1], body.template_id as string);
        // Auto-seed preview with the template's own example.html so the user sees
        // something immediately (before any chat-driven rewrite).
        const tmpl = ctx.templates.get(body.template_id as string);
        const exampleHtmlPath = join(tmpl.__dir!, tmpl.source_entry);
        if (existsSync(exampleHtmlPath)) {
          const html = await readFile(exampleHtmlPath, 'utf8');
          await ctx.orchestrator.writePreviewHtmlRaw(project.id, html);
        }
        return json(res, 200, { project: await ctx.orchestrator.load(project.id) });
      }

      // Set agent (runtime selection)
      const agentMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/agent$/);
      if (agentMatch && agentMatch[1] && m === 'PUT') {
        const body = await readBody(req);
        const project = await ctx.orchestrator.setAgent(
          agentMatch[1],
          (body.agent_id as string) || null,
        );
        return json(res, 200, { project });
      }

      // Set variables (whole bag)
      const varsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/variables$/);
      if (varsMatch && varsMatch[1] && m === 'PUT') {
        const body = await readBody(req);
        const project = await ctx.orchestrator.setVariables(
          varsMatch[1],
          (body.variables as Record<string, unknown>) ?? {},
        );
        return json(res, 200, { project });
      }

      // Render preview HTML (legacy; v0.3+ uses chat-driven path)
      const prevMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/preview$/);
      if (prevMatch && prevMatch[1] && m === 'POST') {
        const { project, htmlPath } = await ctx.orchestrator.renderPreviewHtml(prevMatch[1]);
        return json(res, 200, {
          project,
          preview_url: `/preview/${project.id}`,
          html_path: htmlPath,
        });
      }

      // Get raw preview HTML (frontend reads to parse data-hv-text nodes)
      const rawGetMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/raw-html$/);
      if (rawGetMatch && rawGetMatch[1] && m === 'GET') {
        const project = await ctx.orchestrator.load(rawGetMatch[1]);
        if (!project.lastPreviewHtmlPath || !existsSync(project.lastPreviewHtmlPath)) {
          return json(res, 404, { error: 'No preview HTML yet — pick a template or send a chat first' });
        }
        const html = await readFile(project.lastPreviewHtmlPath, 'utf8');
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(html);
        return;
      }

      // Write raw preview HTML (frontend posts back the modified HTML
      // after the user edits a data-hv-text field in the middle column)
      if (rawGetMatch && rawGetMatch[1] && m === 'PUT') {
        const project = await ctx.orchestrator.load(rawGetMatch[1]);
        const ct = req.headers['content-type'] ?? '';
        let html: string;
        if (ct.includes('application/json')) {
          const body = await readBody(req);
          html = (body.html as string) ?? '';
        } else {
          html = await readBodyText(req);
        }
        if (!html || !/<\/html>/i.test(html)) {
          return json(res, 400, { error: 'Body must be a complete HTML document' });
        }
        await ctx.orchestrator.writePreviewHtmlRaw(project.id, html);
        return json(res, 200, { project: await ctx.orchestrator.load(project.id) });
      }

      // Export MP4
      const expMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/export$/);
      if (expMatch && expMatch[1] && m === 'POST') {
        const { project, outputPath } = await ctx.orchestrator.exportMp4({
          projectId: expMatch[1],
        });
        return json(res, 200, { project, output_path: outputPath });
      }

      // Agents (detected on each call; cheap)
      if (url.pathname === '/api/agents' && m === 'GET') {
        const agents = await detectAll();
        return json(res, 200, { agents });
      }

      // Messages: GET history (lazy-loads from messages.json on first hit)
      const msgsMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/messages$/);
      if (msgsMatch && msgsMatch[1] && m === 'GET') {
        const arr = await loadMessages(ctx, msgsMatch[1]);
        return json(res, 200, { messages: arr });
      }

      // Messages: POST = send + stream agent reply via SSE
      // v0.5: accepts multipart (text + files) OR JSON. Files become real
      // project assets via AssetStore; their paths are passed to the agent
      // prompt as attachments.
      if (msgsMatch && msgsMatch[1] && m === 'POST') {
        const id = msgsMatch[1];
        const ct = req.headers['content-type'] ?? '';
        let userText = '';
        const attachments: Attachment[] = [];

        const project0 = await ctx.orchestrator.load(id);
        if (ct.startsWith('multipart/form-data')) {
          const parts = await receiveMultipart(req, ct);
          for (const p of parts) {
            if (p.kind === 'field' && p.name === 'content') {
              userText = p.value;
            } else if (p.kind === 'file') {
              const updatedProject = await ctx.orchestrator.addFileAsset(id, p.tmpPath);
              const newAsset = updatedProject.assets[updatedProject.assets.length - 1];
              if (newAsset) {
                attachments.push({
                  path: newAsset.path ?? p.tmpPath,
                  kind: newAsset.type as Attachment['kind'],
                  filename: p.filename,
                  size: newAsset.metadata.sizeBytes ?? 0,
                });
              }
            }
          }
        } else {
          const body = await readBody(req);
          userText = (body.content as string) ?? '';
        }

        if (!userText && attachments.length === 0) {
          return json(res, 400, { error: 'content or attachments required' });
        }

        // Re-fetch project after potential addFileAsset side-effects
        const project = await ctx.orchestrator.load(id);
        const tmpl = project.templateId ? ctx.templates.get(project.templateId) : null;
        // No template required — agent can synthesize from scratch when none picked.

        const agentId = project.agentId ?? 'claude';
        const agentDef = findAgent(agentId);
        if (!agentDef) {
          return json(res, 400, { error: `agent "${agentId}" not registered` });
        }

        // Append user message to history (with attachment summary)
        const attachmentSummary = attachments.length > 0
          ? `\n\n📎 ${attachments.length} attachment(s): ${attachments.map((a) => a.filename).join(', ')}`
          : '';
        const history = await loadMessages(ctx, id);
        history.push({
          role: 'user',
          content: userText + attachmentSummary,
          ts: Date.now(),
        });
        MESSAGES.set(id, history);
        // Persist immediately so the user message survives even if the
        // streaming agent call below crashes mid-flight.
        await saveMessages(ctx, id, history);

        // Compose prompt — template-aware OR template-free
        const projectDir = await ctx.projects.ensureDir(id);
        const priorHtmlPath = join(projectDir, 'preview.html');
        const priorHtml = existsSync(priorHtmlPath)
          ? await readFile(priorHtmlPath, 'utf8')
          : '';
        let exampleHtml = '';
        if (tmpl) {
          const exampleHtmlPath = join(tmpl.__dir!, tmpl.source_entry);
          if (existsSync(exampleHtmlPath)) {
            exampleHtml = await readFile(exampleHtmlPath, 'utf8');
          }
        }

        const fullPrompt = buildHtmlGenerationPrompt({
          tmpl,
          exampleHtml,
          priorHtml,
          history,
          userText,
          attachments,
        });

        // SSE response
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });

        let assistantText = '';
        const handle = spawnAgent({
          def: agentDef,
          prompt: fullPrompt,
          context: { cwd: projectDir },
          onEvent: (ev) => {
            if (ev.type === 'text') {
              assistantText += ev.chunk;
              res.write(`data: ${JSON.stringify(ev)}\n\n`);
            } else if (ev.type === 'error' || ev.type === 'message_end') {
              res.write(`data: ${JSON.stringify(ev)}\n\n`);
            }
          },
        });
        await handle.done;

        // v0.8: try multi-frame path first — content-graph JSON + tagged html blocks.
        // Fall back to single-frame fast path (v0.7) when no graph is emitted.
        const multi = extractContentGraphAndFrames(assistantText);
        let summaryLine = '';
        if (multi && multi.frames.length > 0) {
          await ctx.orchestrator.writeContentGraph(id, multi.graph);
          for (const f of multi.frames) {
            try {
              await ctx.orchestrator.writeFrameHtml(id, f.nodeId, f.html);
            } catch (err) {
              // Don't abort the whole turn for one bad frame; surface a hint.
              const msg = err instanceof Error ? err.message : String(err);
              res.write(
                `data: ${JSON.stringify({ type: 'text', chunk: `\n[frame ${f.nodeId} skipped: ${msg}]\n` })}\n\n`,
              );
            }
          }
          res.write(
            `data: ${JSON.stringify({ type: 'preview_ready', preview_url: `/preview/${id}`, frames: multi.frames.length })}\n\n`,
          );
          summaryLine = `✓ ${multi.frames.length}-frame storyboard generated (intent: ${multi.graph.intent})`;
        } else {
          // Single-frame fast path: extract one HTML doc, write preview.
          const extracted = extractHtmlDocument(assistantText);
          if (extracted) {
            await ctx.orchestrator.writePreviewHtmlRaw(id, extracted);
            res.write(
              `data: ${JSON.stringify({ type: 'preview_ready', preview_url: `/preview/${id}` })}\n\n`,
            );
            summaryLine = '✓ updated the HTML preview';
          }
        }

        // Persist assistant message — strip the html / graph blocks when present (UI sees summary line)
        let persistText = summaryLine
          ? assistantText
              .replace(/```html[#\w-]*[\s\S]*?```/gi, '')
              .replace(/```json#content-graph[\s\S]*?```/i, '')
              .replace(/```json[\s\S]*?```/i, (m) =>
                /content-graph|"intent"\s*:|"nodes"\s*:/i.test(m) ? '' : m,
              )
              .trim() || summaryLine
          : assistantText;

        // Empty agent reply (no HTML, no graph, no prose) usually means the
        // prompt confused the model into doing nothing. Give the user something
        // actionable instead of a blank speech bubble.
        if (!persistText.trim()) {
          const fallback = '⚠️ The agent returned an empty reply. Try rephrasing your request — e.g. tell it the brand / topic / 1-2 concrete details, or which kind of frame you want first.';
          res.write(`data: ${JSON.stringify({ type: 'text', chunk: fallback })}\n\n`);
          persistText = fallback;
        }
        history.push({
          role: 'assistant',
          agent: agentDef.id,
          content: persistText,
          ts: Date.now(),
        });
        MESSAGES.set(id, history);
        await saveMessages(ctx, id, history);
        // discard project0 reference to keep TS happy
        void project0;
        res.end();
        return;
      }

      // ============== v0.8: content-graph + frames API ==============

      // GET content graph as JSON
      const cgMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/content-graph$/);
      if (cgMatch && cgMatch[1] && m === 'GET') {
        const graph = await ctx.orchestrator.readContentGraph(cgMatch[1]);
        if (!graph) return json(res, 404, { error: 'No content graph for this project' });
        return json(res, 200, { graph });
      }

      // ============== File serving ==============

      // Project preview HTML (and any sibling files like assets/)
      const previewServeMatch = url.pathname.match(/^\/preview\/([^/]+)(\/.*)?$/);
      if (previewServeMatch && previewServeMatch[1]) {
        const projId = previewServeMatch[1];
        const sub = previewServeMatch[2] ?? '/preview.html';
        const project = await ctx.orchestrator.load(projId);

        // v0.8: serve a specific frame HTML by graph node id
        const frameMatch = sub.match(/^\/frame\/([a-z0-9_-]+)$/i);
        if (frameMatch && frameMatch[1]) {
          const nodeId = frameMatch[1];
          const frame = (project.frames ?? []).find((f) => f.graphNodeId === nodeId);
          if (frame && existsSync(frame.htmlPath)) {
            return serveFile(frame.htmlPath, res);
          }
          res.writeHead(404);
          return res.end('Frame not found');
        }

        const baseDir = project.lastPreviewHtmlPath
          ? dirname(project.lastPreviewHtmlPath)
          : null;
        if (!baseDir) {
          res.writeHead(404);
          return res.end('Preview not rendered yet');
        }
        const filePath = sub === '/preview.html' || sub === '/'
          ? project.lastPreviewHtmlPath!
          : join(baseDir, sub);
        if (existsSync(filePath) && statSync(filePath).isFile()) {
          return serveFile(filePath, res);
        }
        // Fallback: also try project assets/
        const projAssets = join(dirname(baseDir), 'assets', basename(sub));
        if (existsSync(projAssets)) return serveFile(projAssets, res);
        res.writeHead(404);
        return res.end('Not found');
      }

      // Asset direct serve (so iframe can load image_path etc)
      // /asset?path=<absolute-path>  — must be inside .html-video/projects
      if (url.pathname === '/asset' && m === 'GET') {
        const p = url.searchParams.get('path');
        if (!p) {
          res.writeHead(400);
          return res.end('missing ?path');
        }
        const safe = resolve(p);
        if (!safe.includes('/.html-video/projects/')) {
          res.writeHead(403);
          return res.end('forbidden');
        }
        if (existsSync(safe)) return serveFile(safe, res);
        res.writeHead(404);
        return res.end();
      }

      // Template poster (e.g. /template-asset/<id>/preview.png)
      const tplAssetMatch = url.pathname.match(/^\/template-asset\/([^/]+)\/(.+)$/);
      if (tplAssetMatch && tplAssetMatch[1] && tplAssetMatch[2]) {
        const t = ctx.templates.get(tplAssetMatch[1]);
        const filePath = join(t.__dir!, tplAssetMatch[2]);
        if (existsSync(filePath)) return serveFile(filePath, res);
        res.writeHead(404);
        return res.end();
      }

      // ============== Static UI ==============
      const path = url.pathname === '/' ? '/index.html' : url.pathname;
      const filePath = join(uiRoot, path);
      if (filePath.startsWith(uiRoot) && existsSync(filePath) && statSync(filePath).isFile()) {
        return serveFile(filePath, res);
      }

      res.writeHead(404);
      res.end('Not found');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const code = (e as { code?: string }).code ?? 'unknown';
      json(res, 500, { error: msg, code });
    }
  });

  return new Promise((resolveFn) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      resolveFn({
        url: `http://127.0.0.1:${actualPort}`,
        port: actualPort,
        close: () => server.close(),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': MIME['.json']! });
  res.end(JSON.stringify(body));
}

async function serveFile(filePath: string, res: ServerResponse): Promise<void> {
  const ext = extname(filePath).toLowerCase();
  const buf = await readFile(filePath);
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    // Studio is a local dev tool — always serve fresh so v0.x updates show
    // up immediately on page load instead of being held in disk cache.
    'cache-control': 'no-store, no-cache, must-revalidate',
    pragma: 'no-cache',
  });
  res.end(buf);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveFn, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      try {
        resolveFn(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

async function readBodyText(req: IncomingMessage): Promise<string> {
  return new Promise((resolveFn, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => resolveFn(data));
    req.on('error', reject);
  });
}

/**
 * Minimal multipart parser — returns ALL parts (fields + files).
 * Files are written to a tmp path and the path is returned.
 * For production switch to formidable / busboy.
 */
type MultipartPart =
  | { kind: 'field'; name: string; value: string }
  | { kind: 'file'; name: string; filename: string; tmpPath: string };

async function receiveMultipart(
  req: IncomingMessage,
  contentType: string,
): Promise<MultipartPart[]> {
  const boundaryMatch = contentType.match(/boundary=(.+)/);
  if (!boundaryMatch) throw new Error('No multipart boundary');
  const boundary = `--${boundaryMatch[1]}`;
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const buf = Buffer.concat(chunks);
  const text = buf.toString('binary');
  const parts = text.split(boundary).slice(1, -1);
  const out: MultipartPart[] = [];
  const fs = await import('node:fs/promises');
  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const headers = part.slice(0, headerEnd);
    const bodyRaw = part.slice(headerEnd + 4, part.length - 2);
    const nameMatch = headers.match(/name="([^"]+)"/);
    if (!nameMatch || !nameMatch[1]) continue;
    const name = nameMatch[1];
    const fnMatch = headers.match(/filename="([^"]+)"/);
    if (fnMatch && fnMatch[1]) {
      const filename = fnMatch[1];
      const tmpPath = join(tmpdir(), `hv-upload-${randomUUID().slice(0, 8)}-${filename}`);
      await mkdir(dirname(tmpPath), { recursive: true });
      await fs.writeFile(tmpPath, Buffer.from(bodyRaw, 'binary'));
      out.push({ kind: 'file', name, filename, tmpPath });
    } else {
      // Field — body is utf8 text
      out.push({ kind: 'field', name, value: Buffer.from(bodyRaw, 'binary').toString('utf8') });
    }
  }
  return out;
}

// Backward-compat shim used by the older /api/projects/:id/assets endpoint
async function receiveMultipartFile(
  req: IncomingMessage,
  contentType: string,
): Promise<{ filePath: string; filename: string }> {
  const parts = await receiveMultipart(req, contentType);
  const file = parts.find((p): p is Extract<MultipartPart, { kind: 'file' }> => p.kind === 'file');
  if (!file) throw new Error('No file field in multipart body');
  return { filePath: file.tmpPath, filename: file.filename };
}

// Keep TS aware that copyFile / AssetStore are used somewhere (they're indirectly via orchestrator)
void copyFile;
void AssetStore;

// ---------------------------------------------------------------------------
// Message history — in-memory cache, JSON file as source of truth.
//
// v0.8.2: previously memory-only, so chat history evaporated on every studio
// restart. Now persisted to <projectDir>/messages.json. Cache is lazy-loaded
// on first GET / POST per project; writes go through saveMessages().
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  agent?: string;
  tool?: string;
  output?: unknown;
  ts: number;
}

const MESSAGES = new Map<string, ChatMessage[]>();

async function loadMessages(ctx: CliContext, projectId: string): Promise<ChatMessage[]> {
  const cached = MESSAGES.get(projectId);
  if (cached) return cached;
  const projectDir = await ctx.projects.ensureDir(projectId);
  const filePath = join(projectDir, 'messages.json');
  if (!existsSync(filePath)) {
    MESSAGES.set(projectId, []);
    return MESSAGES.get(projectId)!;
  }
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? (parsed as ChatMessage[]) : [];
    MESSAGES.set(projectId, arr);
    return arr;
  } catch {
    // Corrupt file — start fresh in memory but don't overwrite the file
    // until the next save (gives the user a chance to recover by hand).
    MESSAGES.set(projectId, []);
    return MESSAGES.get(projectId)!;
  }
}

async function saveMessages(
  ctx: CliContext,
  projectId: string,
  messages: ChatMessage[],
): Promise<void> {
  const projectDir = await ctx.projects.ensureDir(projectId);
  const filePath = join(projectDir, 'messages.json');
  const fs = await import('node:fs/promises');
  await fs.writeFile(filePath, JSON.stringify(messages, null, 2), 'utf8');
}

// `Attachment` is declared above (at the buildHtmlGenerationPrompt section)

interface BuildPromptArgs {
  tmpl: import('@html-video/core').TemplateMetadata | null;
  exampleHtml: string;
  priorHtml: string;
  history: ChatMessage[];
  userText: string;
  attachments: Attachment[];
}

interface Attachment {
  /** absolute path on disk */
  path: string;
  /** type the AssetStore detected */
  kind: 'image' | 'video' | 'audio' | 'data' | 'text' | 'reference-link';
  /** display name */
  filename: string;
  /** byte size */
  size: number;
}

/**
 * v0.5 chat prompt — guidance-first, not write-HTML-immediately.
 *
 * The system prompt tells the agent to:
 *   - On a vague first turn, ask 1–3 sharp questions instead of writing HTML
 *   - When the request + context are concrete enough, generate the full HTML
 *   - Use attachments as references / actual assets
 *   - Never use a fixed 4-question script — judge per turn what's missing
 *
 * Whether the agent writes HTML this turn is up to the agent. The server
 * extracts a fenced ```html block if present; if not, it's just a chat reply.
 */
function buildHtmlGenerationPrompt(args: BuildPromptArgs): string {
  const { tmpl, exampleHtml, priorHtml, history, userText, attachments } = args;

  const baseHtml = priorHtml && priorHtml !== exampleHtml ? priorHtml : exampleHtml;
  const isFirstTurn = history.filter((m) => m.role === 'user').length <= 1;

  // Detect "user is answering an hv-options card".
  //
  // Subtlety: a previous empty/failed assistant turn means the latest
  // assistant message has no hv-options block, but the relevant card is
  // one turn earlier. So we scan back for the most recent assistant that
  // DID emit options, and only treat it as "active" if no later user turn
  // already replied to a draft (i.e. agent didn't successfully produce HTML
  // since then — the card is still the live question).
  const optionsBlock = /```hv-options\s*\n[\s\S]*?```/i;
  let cardAssistant: ChatMessage | null = null;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!;
    if (m.role !== 'assistant') continue;
    if (optionsBlock.test(m.content)) {
      cardAssistant = m;
      break;
    }
    // If we hit an assistant turn that DID produce content (HTML / graph
    // summary lines) before finding a card, the card has been resolved.
    const hasContent = /```html|```json#content-graph|✓\s/i.test(m.content);
    if (hasContent) break;
  }
  const answeringOptions = !!cardAssistant && !isFirstTurn;

  // Detect "opener" — short greeting / vague intent. Empirically,
  // `claude --print` returns an empty string when the prompt offers a binary
  // draft-vs-ask choice and the user's message is too short to commit either
  // way ("你好", "hi", "做个视频" …). Force-pick the ask path with a tight
  // hv-options card schema so the model has exactly one job.
  const trimmed = userText.trim();
  const isOpener =
    !answeringOptions &&
    trimmed.length < 30 &&
    !/brand|outro|intro|launch|demo|video|chart|data|product|tagline|视频|品牌|预告|发布|讲解|介绍|对比|时间线/i.test(
      trimmed,
    );

  // Heuristic: a "concrete" first turn (≥ 8 words OR mentions a brand/product/topic
  // word) gets the direct-draft path. A short / vague turn gets the explorer path.
  // When the user is answering options, treat the turn as concrete — they
  // already made a choice, no point asking more questions.
  const concrete =
    answeringOptions ||
    userText.trim().split(/\s+/).length >= 8 ||
    /brand|outro|intro|launch|demo|video|chart|data|product|tagline/i.test(userText);

  const parts: string[] = [];

  // Opener path: stripped-down prompt that ONLY asks the agent to emit a
  // welcoming line + an hv-options card. No source HTML, no decision tree,
  // no multi-frame schema — those would tempt claude --print into emitting
  // nothing.
  if (isOpener) {
    const opener: string[] = [];
    opener.push(
      `The user just opened a project and said "${trimmed}". You are an HTML-video creation assistant.`,
    );
    opener.push('');
    opener.push(
      `Reply with TWO things, in this exact order:`,
    );
    opener.push(
      `1. ONE friendly opening sentence in the user's language (≤ 25 chars), e.g. "你好！想做点什么？" or "Hi! What kind of video?".`,
    );
    opener.push(
      `2. A fenced \`\`\`hv-options block with 4 content-type choices and allow_freeform: true. JSON shape:`,
    );
    opener.push('   ```hv-options');
    opener.push('   {');
    opener.push('     "question": "想做哪种内容？" or "What kind?",');
    opener.push('     "options": [');
    opener.push('       { "label": "单帧标题卡", "hint": "logo / 封面 / 单画面 - 5-10s" },');
    opener.push('       { "label": "多帧预告片", "hint": "产品 / 活动 teaser, 3-6 帧" },');
    opener.push('       { "label": "数据大字报", "hint": "1-2 个核心数字, 社媒爆款风" },');
    opener.push('       { "label": "概念解说短片", "hint": "几帧讲清一个 idea / feature" }');
    opener.push('     ],');
    opener.push('     "allow_freeform": true');
    opener.push('   }');
    opener.push('   ```');
    opener.push('');
    if (tmpl) {
      opener.push(
        `Note: a template "${tmpl.name}" is currently selected (${tmpl.description}), but treat it as a visual style reference only. Don't let its name pin the user to one use case — they may want to repurpose the look for any of the 4 content types above.`,
      );
      opener.push('');
    }
    opener.push(
      `Do NOT write HTML this turn. Do NOT return an empty reply. The hv-options block is REQUIRED.`,
    );
    return opener.join('\n');
  }

  // When the user is answering an hv-options card, return a stripped-down
  // direct-draft prompt and skip the rest of the explorer/concrete branching.
  // Empirically: a long branching prompt + a 4-character user reply makes
  // claude --print return an empty string (Joey hit this on every 2nd turn).
  if (answeringOptions) {
    const optMatch = /```hv-options\s*\n([\s\S]*?)```/i.exec(cardAssistant!.content);
    let question = '';
    let pickedHint = '';
    if (optMatch && optMatch[1]) {
      try {
        const parsed = JSON.parse(optMatch[1].trim());
        question = String(parsed.question ?? '');
        const matched = (parsed.options || []).find(
          (o: { label?: string }) => o && o.label === userText.trim(),
        );
        if (matched && typeof matched === 'object' && 'hint' in matched) {
          pickedHint = String((matched as { hint?: string }).hint ?? '');
        }
      } catch {
        // ignore
      }
    }
    const directParts: string[] = [];
    directParts.push(
      `Write a self-contained HTML video file based on the user's pick.`,
    );
    directParts.push('');
    if (question) directParts.push(`Earlier question: ${question}`);
    directParts.push(
      `User's pick: ${userText.trim()}${pickedHint ? ` (${pickedHint})` : ''}`,
    );
    directParts.push('');
    directParts.push(
      `Constraints: full-bleed 1920×1080, opens with an animation timeline, inline CSS + JS, single complete <!doctype html>...</html> document. CDN imports (Tailwind, GSAP) are fine. Tag every visible text node with data-hv-text set to a stable key (brand_name, headline, item_1, cta…). No prose outside code blocks.`,
    );
    directParts.push('');
    directParts.push(`Output ONE of these:`);
    directParts.push(
      `  A) Single HTML file in a fenced \`\`\`html block — for a single brand card / title moment.`,
    );
    directParts.push(
      `  B) Multi-frame: first a \`\`\`json#content-graph block (schemaVersion:1, intent, nodes:[{id,kind:text|data|entity,durationSec,...}], edges:[{from,to,kind:sequence|dependency|contrast}]), then one complete HTML document per node in a fenced \`\`\`html#<nodeId> block — for a teaser / explainer / timeline.`,
    );
    directParts.push('');
    directParts.push(
      `For "预告片" / "teaser" / "explainer" / multi-step content, prefer B. Otherwise A.`,
    );
    directParts.push(
      `Do NOT ask another multiple-choice question. Do NOT return an empty reply.`,
    );
    if (priorHtml && priorHtml !== exampleHtml) {
      directParts.push('');
      directParts.push(`Prior preview HTML (iterate on it, or replace if a different vibe is better):`);
      directParts.push('```html');
      directParts.push(priorHtml.slice(0, 4000));
      directParts.push('```');
    }
    if (attachments.length > 0) {
      directParts.push('');
      directParts.push(`Attachments:`);
      for (const a of attachments) {
        directParts.push(`- [${a.kind}] ${a.filename} — ${a.path}`);
      }
    }
    return directParts.join('\n');
  }

  if (concrete) {
    // === Direct-draft path: minimal preamble, no decision tree, just go ===
    parts.push(`Create an HTML video file based on the user's request below.`);
    parts.push('');
  } else {
    // === Explorer path: agent may ask questions or offer hv-options ===
    parts.push(`# Role`);
    parts.push(
      `You are a Hyperframes video creation collaborator. The user wants ONE self-contained HTML file that opens with animation and is ready to be recorded into an MP4.`,
    );
    parts.push('');
    parts.push(`# Behaviour`);
    parts.push(`- If the user's request is concrete enough to make a good first draft, generate the HTML directly (see Output rules below).`);
    parts.push(`- If the request is too vague, ask 1–3 short, sharp questions to surface what's missing. Pick whichever 1–3 things are blocking *this* particular project — don't run a fixed audience/platform/style checklist.`);
    parts.push(`- When the user attaches files, use them: images / video links as visual style references, logos / photos as actual assets to embed, data files as content, text files as copy.`);
    parts.push(`- When the user describes a style in words (e.g. "warm grain magazine", "cyberpunk glitch", "Swiss minimalist"), translate that into concrete CSS.`);
    parts.push(`- Keep chat replies brief. The HTML is the artefact.`);
    parts.push('');
  }

  if (tmpl) {
    parts.push(`# Template currently selected`);
    parts.push(`${tmpl.name} (${tmpl.category}) — ${tmpl.description}`);
    parts.push(`The template's visual signature (colors, animation timing, layout) should be preserved unless the user explicitly asks for a deviation.`);
    parts.push('');
  } else {
    parts.push(`# No template — write from scratch`);
    parts.push(`The user has NOT picked a template. You're free to design the visual style yourself, guided by:`);
    parts.push(`  · the user's description in plain language ("warm grain magazine", "neon cyberpunk", "Swiss grid", etc)`);
    parts.push(`  · any image / link attachments they provide as style references`);
    parts.push(`  · any prior preview HTML below (iterate on it instead of starting over)`);
    parts.push(`Hyperframes-style HTML conventions still apply: full-bleed 1920×1080, opens with an animation timeline, inline CSS+JS, no build step. Use Tailwind CDN if you want utility classes; use GSAP CDN if you want richer motion. Keep it ONE complete <!doctype html>...</html> document.`);
    parts.push('');
  }

  if (attachments.length > 0) {
    parts.push(`# Attachments in this turn`);
    for (const a of attachments) {
      parts.push(`- [${a.kind}] ${a.filename} (${a.size} bytes) — ${a.path}`);
    }
    parts.push(`Use these as references or assets. Reference image paths in <img src="..."> as needed.`);
    parts.push('');
  }

  if (baseHtml) {
    parts.push(`# Source HTML (the current preview state)`);
    parts.push('```html');
    parts.push(baseHtml.slice(0, 6000));
    parts.push('```');
    parts.push('');
  } else {
    parts.push(`# Source HTML`);
    parts.push(`(nothing yet — this will be the first draft)`);
    parts.push('');
  }

  const recentUserTurns = history
    .filter((m) => m.role === 'user')
    .slice(-4, -1)
    .map((m) => m.content);
  if (recentUserTurns.length > 0) {
    parts.push(`# Earlier user messages in this conversation`);
    for (const t of recentUserTurns) parts.push(`- ${t.slice(0, 240)}`);
    parts.push('');
  }

  parts.push(`# User message`);
  parts.push(userText);
  parts.push('');

  if (concrete) {
    // Direct-draft path: terse output rules, no branching = claude doesn't stall
    parts.push(`Output rules — pick ONE path:`);
    parts.push('');
    parts.push(`A) **Single-frame fast path** — for short brand cards, title cards, single moments, simple promo loops:`);
    parts.push(`   - Reply with one complete HTML document inside a fenced \`\`\`html code block.`);
    parts.push(`   - Inline all CSS and JS. CDN imports fine.`);
    parts.push(`   - Tag every visible text node with data-hv-text set to a stable key (brand_name, tagline, headline, item_1, cta).`);
    parts.push(`   - No prose outside the code block.`);
    parts.push('');
    parts.push(`B) **Multi-frame path** — for explainers, timelines, before/after comparisons, step-by-step walkthroughs, anything ≥ 2 distinct moments:`);
    parts.push(`   1. First emit a content-graph JSON in a fenced \`\`\`json#content-graph block. Schema:`);
    parts.push(`      {`);
    parts.push(`        "schemaVersion": 1,`);
    parts.push(`        "intent": "single-frame" | "explainer" | "data-viz" | "promo" | "comparison" | "other",`);
    parts.push(`        "synopsis": "one-line video description",`);
    parts.push(`        "nodes": [`);
    parts.push(`          { "id": "intro", "kind": "text", "label": "Intro", "frameIntent": "title-card", "durationSec": 3, "text": "..." },`);
    parts.push(`          { "id": "stat_users", "kind": "data", "frameIntent": "data-bar", "durationSec": 4, "data": { "label": "MAU", "value": "1.2M" } },`);
    parts.push(`          { "id": "outro", "kind": "entity", "frameIntent": "outro", "durationSec": 3, "props": { "logo_text": "BrandName" } }`);
    parts.push(`        ],`);
    parts.push(`        "edges": [`);
    parts.push(`          { "from": "intro", "to": "stat_users", "kind": "sequence" },`);
    parts.push(`          { "from": "stat_users", "to": "outro", "kind": "sequence" }`);
    parts.push(`        ]`);
    parts.push(`      }`);
    parts.push(`      Edge kinds: "sequence" (soft order hint), "dependency" (hard topo constraint), "contrast" (semantic, doesn't affect order).`);
    parts.push(`   2. Then emit ONE complete HTML document per node, each in a fenced \`\`\`html#<nodeId> code block (e.g. \`\`\`html#intro). Each frame is a self-contained 1920×1080 page that opens with its own animation timeline. Tag visible text with data-hv-text.`);
    parts.push(`   3. No prose outside the code blocks.`);
    parts.push('');
    parts.push(`Choose A or B based on the user's request. When in doubt for a request that mentions multiple things in sequence, pick B.`);
  } else {
    if (isFirstTurn) {
      parts.push(`(This is the first turn. If the message is concrete enough, just draft. Otherwise ask 1–3 questions to surface what's missing — or use the multiple-choice format below.)`);
      parts.push('');
    }
    parts.push(`# When you decide to draft HTML — pick ONE path`);
    parts.push('');
    parts.push(`**A) Single-frame fast path** (short brand card / title / single moment):`);
    parts.push(`- Reply with one complete HTML document inside a fenced \`\`\`html code block.`);
    parts.push(`- Inline all CSS and JS. CDN imports fine.`);
    parts.push(`- Tag every visible text node with data-hv-text set to a stable key. Preserve existing keys.`);
    parts.push('');
    parts.push(`**B) Multi-frame path** (explainer / timeline / comparison / walkthrough):`);
    parts.push(`- Emit a \`\`\`json#content-graph block first (nodes + edges; see schema below).`);
    parts.push(`- Then one \`\`\`html#<nodeId> block per node — each is a complete 1920×1080 HTML page with its own animation timeline.`);
    parts.push(`- Tag visible text with data-hv-text. No prose between blocks.`);
    parts.push('');
    parts.push(`Content-graph schema (B path):`);
    parts.push(`  schemaVersion: 1`);
    parts.push(`  intent: "single-frame" | "explainer" | "data-viz" | "promo" | "comparison" | "other"`);
    parts.push(`  synopsis: string (one-line)`);
    parts.push(`  nodes: [{ id, kind: "entity"|"data"|"text", label?, frameIntent?, durationSec?, ...kindSpecific }]`);
    parts.push(`  edges: [{ from, to, kind: "sequence"|"dependency"|"contrast", reason? }]`);
    parts.push('');
    parts.push(`# When you ask questions instead`);
    parts.push(`Reply in plain conversational text. Markdown renders (**bold**, lists, headings).`);
    parts.push('');
    parts.push(`# Multiple-choice question format`);
    parts.push(`When a question has 2–6 natural options, emit a fenced code block whose language tag is hv-options. Body is JSON:`);
    parts.push(`  { "question": "...", "options": [{ "label": "...", "hint": "..." }, ...], "allow_freeform": true }`);
    parts.push(`Rules: 2–6 options, each label ≤ 30 chars, distinct, the only block in that turn, allow_freeform:true when custom answers are useful.`);

    if (tmpl) {
      parts.push('');
      parts.push(`## Avoid template-name tunnel vision`);
      parts.push(`Don't let the template's name force every option into one use case. Templates are visual skeletons; users repurpose them. Include at least one broader-scope option when offering choices: a longer/full video, a series, or a different scenario.`);
    }
  }

  return parts.join('\n');
}

/**
 * Extract a full HTML document from agent output.
 * Tries (1) `\`\`\`html ... \`\`\`` block, (2) bare `<!doctype html>...</html>`.
 */
function extractHtmlDocument(text: string): string | null {
  // Plain ```html``` block (no node-id tag — single-frame fast path)
  const fence = /```html\s*\n([\s\S]*?)```/i.exec(text);
  if (fence && fence[1]) {
    const html = fence[1].trim();
    if (/<\/html>/i.test(html)) return html;
  }
  const bare = /<!doctype html[\s\S]*?<\/html>/i.exec(text);
  if (bare) return bare[0];
  return null;
}

/**
 * v0.8: extract a content-graph JSON block + N tagged html#<nodeId> blocks
 * from a single agent response.
 *
 * Expected agent output format for multi-frame:
 *   ```json#content-graph
 *   { "schemaVersion": 1, "intent": "explainer", "nodes": [...], "edges": [...] }
 *   ```
 *   ```html#node_1
 *   <!doctype html>...
 *   ```
 *   ```html#node_2
 *   <!doctype html>...
 *   ```
 *
 * Returns null when no content-graph block is found (caller falls back to
 * single-frame extraction).
 */
function extractContentGraphAndFrames(
  text: string,
): { graph: import('@html-video/content-graph').ContentGraph; frames: { nodeId: string; html: string }[] } | null {
  // Find a fenced JSON block tagged as content-graph.
  const graphMatch = /```json#content-graph\s*\n([\s\S]*?)```/i.exec(text);
  if (!graphMatch || !graphMatch[1]) return null;
  let graph: import('@html-video/content-graph').ContentGraph;
  try {
    graph = JSON.parse(graphMatch[1].trim()) as import('@html-video/content-graph').ContentGraph;
  } catch {
    return null;
  }
  if (!graph || !Array.isArray((graph as { nodes?: unknown[] }).nodes)) return null;

  // Find tagged html blocks: ```html#<nodeId>
  const frames: { nodeId: string; html: string }[] = [];
  const re = /```html#([a-z0-9_-]+)\s*\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const nodeId = match[1];
    const html = match[2]?.trim() ?? '';
    if (nodeId && /<\/html>/i.test(html)) {
      frames.push({ nodeId, html });
    }
  }

  return { graph, frames };
}
