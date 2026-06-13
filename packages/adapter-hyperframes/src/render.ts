/**
 * Hyperframes render() — deterministic frame-by-frame capture via Playwright + ffmpeg.
 *
 * Per-frame strategy (orchestrator already loops per node and concats):
 *   1. Launch chromium headless at the configured resolution
 *   2. file:// load the frame HTML (all animations frozen at parse time)
 *   3. wait for web fonts, probe the animation length
 *   4. take over the page's clock: rAF / performance.now / Date.now become
 *      virtual, GSAP's ticker is put to sleep, CSS animations are driven
 *      through the Web Animations API
 *   5. for each output frame, seek every timeline to t = i/fps and screenshot
 *   6. ffmpeg assembles the image sequence into mp4 at `outputPath`
 *
 * Why not Playwright's recordVideo? That is a real-time CDP screencast capped
 * at 25fps which drops frames whenever headless chromium (software rendering,
 * no GPU) can't keep up — measured output was ~5–8 distinct frames/sec at
 * 1080p regardless of the requested fps. Stepping virtual time and
 * screenshotting each frame is slower in wall-clock but every frame is
 * pixel-perfect and the requested fps is real.
 *
 * Upstream Hyperframes was never required at runtime for this adapter —
 * our generated HTML is plain inline-CSS+JS, chromium runs it as-is.
 */

import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  HtmlSceneOutput,
  RenderContext,
  RenderInput,
  RenderOutput,
} from '@html-video/core';
import { HtmlVideoError } from '@html-video/core';

const ADAPTER_VERSION = '0.3.0-framestep';

/** Real render: chromium records the page, ffmpeg transcodes to MP4. */
export async function render(input: RenderInput, ctx: RenderContext): Promise<RenderOutput> {
  const t0 = Date.now();
  ctx.onProgress?.(5, 'preparing');
  const outDir = dirname(input.config.outputPath);
  await mkdir(outDir, { recursive: true });
  if (ctx.signal?.aborted) throw new HtmlVideoError('cancelled', 'Aborted');

  // Resolve the source HTML path. Templates pass an absolute path already;
  // multi-frame `core` calls pass the per-frame HTML path the same way.
  if (!existsSync(input.template.sourcePath)) {
    throw new HtmlVideoError(
      'template-invalid',
      `Source HTML not found: ${input.template.sourcePath}`,
    );
  }

  let totalDuration =
    input.config.duration === 'auto' ? 5 : Math.max(0.5, Number(input.config.duration));
  const { width, height } = input.config.resolution;
  const fps = input.config.fps || 30;

  // Lazy-load playwright so the import cost only hits actual exports.
  ctx.onProgress?.(15, 'launching browser');
  const playwright = await import('playwright').catch((err) => {
    throw new HtmlVideoError(
      'render-failed',
      `playwright not installed (run \`pnpm install\` from the monorepo root). ${err instanceof Error ? err.message : err}`,
    );
  });

  const recordDir = await mkdtemp(join(tmpdir(), 'hv-render-'));
  const framesDir = join(recordDir, 'frames');
  await mkdir(framesDir, { recursive: true });
  let browser: import('playwright').Browser | undefined;
  let cleanupSrc: (() => Promise<void>) | undefined;
  let totalFrames = 0;
  try {
    browser = await playwright.chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    });
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();

    // Freeze all CSS/SMIL animations the instant the document starts parsing,
    // BEFORE any @keyframes can begin counting down. Single-file templates are
    // pure CSS `animation: … forwards` timelines with no JS trigger — they
    // start running on the wall clock the moment the element is styled, i.e.
    // right after goto(). Meanwhile we then spend ~2–3s waiting for the Google
    // Fonts faces (Shrikhand et al.) to download. Without this freeze the whole
    // opening (text fading in while the real face is still downloading, then
    // the swap) plays out during that font wait and gets recorded. Pausing all
    // animations up front lets us hold the timeline at frame 0 until fonts are
    // ready, then release it so capture and motion start together — the same
    // shape as the multi-composition paused→drive path below.
    await page.addInitScript(() => {
      const style = document.createElement('style');
      style.id = '__hv_freeze';
      style.textContent =
        '*, *::before, *::after { animation-play-state: paused !important;' +
        ' -webkit-animation-play-state: paused !important; }';
      const attach = () => (document.head || document.documentElement).appendChild(style);
      if (document.head || document.documentElement) attach();
      else document.addEventListener('DOMContentLoaded', attach, { once: true });
      (window as unknown as { __hvUnfreeze?: () => void }).__hvUnfreeze = () => {
        document.getElementById('__hv_freeze')?.remove();
      };
    });

    // Deterministic clock. Installed before any page script runs, but inert
    // until __hvBeginVirtualTime() — page setup (font loading, our own
    // evaluate() helpers) must keep running on the real clock. Once active:
    //   - requestAnimationFrame queues callbacks instead of scheduling them;
    //   - performance.now() / Date.now() return a frozen virtual time;
    //   - GSAP's ticker is put to sleep so nothing advances on the wall clock;
    //   - __hvGoTo(ms) advances the virtual time to `ms`, flushes the rAF
    //     queue with the virtual timestamp (drives custom rAF loops), ticks
    //     GSAP via gsap.updateRoot(), and seeks every CSS/WAAPI animation to
    //     `ms` through the Web Animations API. The CSS freeze stylesheet stays
    //     attached the whole time — a paused animation still renders the frame
    //     its currentTime points at, and keeping it pinned guarantees nothing
    //     drifts between the seek and the screenshot.
    await page.addInitScript(() => {
      const w = window as unknown as Record<string, unknown> & Window;
      let active = false;
      let vNow = 0;
      let rafId = 1;
      let rafQueue: Array<{ id: number; cb: FrameRequestCallback }> = [];
      const realPerfNow = performance.now.bind(performance);
      const realDateNow = Date.now.bind(Date);
      let perfBase = 0;
      let dateBase = 0;
      let gsapBaseSec = 0;
      type GsapLike = {
        ticker?: { time?: number; sleep?: () => void; lagSmoothing?: (n: number) => void };
        updateRoot?: (timeSec: number) => void;
      };
      (w as { __hvBeginVirtualTime?: () => void }).__hvBeginVirtualTime = () => {
        if (active) return;
        active = true;
        vNow = 0;
        perfBase = realPerfNow();
        dateBase = realDateNow();
        performance.now = () => perfBase + vNow;
        Date.now = () => dateBase + vNow;
        w.requestAnimationFrame = ((cb: FrameRequestCallback) => {
          const id = rafId++;
          rafQueue.push({ id, cb });
          return id;
        }) as typeof requestAnimationFrame;
        w.cancelAnimationFrame = ((id: number) => {
          rafQueue = rafQueue.filter((e) => e.id !== id);
        }) as typeof cancelAnimationFrame;
        const g = (w as { gsap?: GsapLike }).gsap;
        if (g?.ticker) {
          try {
            g.ticker.lagSmoothing?.(0);
            g.ticker.sleep?.(); // stop GSAP's own rAF loop — we tick it manually
            gsapBaseSec = g.ticker.time ?? 0;
          } catch {
            /* gsap variant without ticker control — rAF queue still covers it */
          }
        }
      };
      (w as { __hvGoTo?: (ms: number) => void }).__hvGoTo = (ms: number) => {
        if (!active) return;
        vNow = ms;
        // Custom rAF-driven loops: run this frame's callbacks with the
        // virtual timestamp; re-registrations land in the next frame's queue.
        const due = rafQueue;
        rafQueue = [];
        for (const e of due) {
          try {
            e.cb(perfBase + vNow);
          } catch {
            /* one bad callback must not kill the capture */
          }
        }
        // GSAP: manual root tick (Remotion-style external clock driving).
        const g = (w as { gsap?: GsapLike }).gsap;
        if (g?.updateRoot) {
          try {
            g.updateRoot(gsapBaseSec + ms / 1000);
          } catch {
            /* ignore */
          }
        }
        // CSS @keyframes / transitions / WAAPI: seek via Web Animations API.
        let anims: Animation[] = [];
        try {
          anims = document.getAnimations();
        } catch {
          /* no WAAPI — nothing to seek */
        }
        for (const a of anims) {
          try {
            a.pause();
            a.currentTime = ms;
          } catch {
            /* some transitions reject seeking — ignore */
          }
        }
      };
    });

    ctx.onProgress?.(30, 'loading frame');
    // Multi-composition templates ship an entry index.html that only stitches
    // sub-scenes via `data-composition-src="compositions/x.html"`; loaded raw
    // over file:// the scenes never appear (chromium blocks file:// fetch, so
    // the studio's client-side fetch player can't run here). Inline the
    // composition files into the HTML up front so chromium records real motion
    // instead of an empty shell. Single-file templates pass through untouched.
    const prepared = await prepareSourceHtml(input.template.sourcePath);
    cleanupSrc = prepared.cleanup;
    const fileUrl = pathToFileURL(prepared.loadPath).href;
    // Wait only for the DOM + same-document scripts (GSAP, the inline player),
    // NOT `load` — `load` blocks on every external asset, and some templates
    // reference a cross-origin A-Roll video (e.g. an S3 mp4 with no CORS
    // header) that chromium retries for ~4s before giving up. Under `load`
    // those ~4s get recorded into the webm as a frozen first scene before the
    // timeline ever plays, so the clip opens on several dead seconds. Fonts are
    // awaited separately below (document.fonts.ready); GSAP is a synchronous
    // <head> script so it's ready at DOMContentLoaded.
    await page.goto(fileUrl, { waitUntil: 'domcontentloaded' });

    // Wait for all web fonts to finish loading BEFORE recording. Templates
    // pull display faces (Shrikhand, Libre Baskerville, Archivo Black, …) from
    // Google Fonts with `font-display: swap`, which paints text in a fallback
    // system font immediately and swaps in the real face once it downloads.
    // If we start recording before the swap, the video shows a visible flash:
    // the text renders in the fallback for the first frames, then the glyphs,
    // widths and weights snap to the intended font mid-clip.
    //
    // `document.fonts.ready` alone is NOT enough here, and this was the bug in
    // the first cut of this fix. We load the page with `domcontentloaded` (so a
    // CORS-blocked A-Roll video can't freeze the opening — see above), which
    // means at this point the Google Fonts <link> stylesheet has usually not
    // come back yet. Until that CSS arrives, its @font-face rules are not in
    // `document.fonts` at all, so `fonts.ready` sees an empty set and resolves
    // INSTANTLY — recording starts, then the CSS lands, the faces download, and
    // the swap happens mid-clip anyway. So we must, in order:
    //   1. wait for every stylesheet <link> to load (or error) — this is what
    //      actually registers the @font-face rules into document.fonts;
    //   2. explicitly fonts.load() each registered face — `display: swap` does
    //      NOT auto-download a face until something paints with it, and our
    //      off-screen/pre-animation text may not have triggered that yet;
    //   3. then await fonts.ready, plus one rAF, so layout settles on the real
    //      glyph metrics before frame 0.
    // Everything is capped so a slow/blocked font CDN can't stall forever —
    // worst case we fall back to the previous behavior for that one frame.
    ctx.onProgress?.(32, 'loading fonts');
    await page
      .evaluate(
        () =>
          new Promise<void>((resolve) => {
            const doc = document as Document & { fonts?: FontFaceSet };
            const fonts = doc.fonts;
            if (!fonts || typeof fonts.ready?.then !== 'function') {
              resolve();
              return;
            }

            let settled = false;
            const finish = () => {
              if (settled) return;
              settled = true;
              // One more frame so the relayout on the real face is painted.
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            };
            // Hard cap: a blocked CDN must never stall the render.
            const cap = setTimeout(finish, 8000);

            // 1. Wait for stylesheet <link>s to load (registers @font-face).
            const links = Array.from(
              document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'),
            );
            const linkDone = links.map((link) => {
              // An already-loaded sheet exposes cssRules without throwing.
              try {
                if (link.sheet && link.sheet.cssRules) return Promise.resolve();
              } catch {
                /* not ready yet — fall through to event wait */
              }
              return new Promise<void>((r) => {
                const done = () => r();
                link.addEventListener('load', done, { once: true });
                link.addEventListener('error', done, { once: true });
                // Per-link safety so one wedged link can't hold the batch.
                setTimeout(done, 6000);
              });
            });

            Promise.all(linkDone)
              .then(() => {
                // 2. Force every registered face to actually download. Under
                // `display: swap` the browser otherwise defers the fetch.
                const loads: Promise<unknown>[] = [];
                fonts.forEach((face) => {
                  try {
                    loads.push(face.load().catch(() => undefined));
                  } catch {
                    /* some faces reject load() pre-paint — ignore */
                  }
                });
                return Promise.all(loads);
              })
              // 3. Now ready() reflects the real face set.
              .then(() => fonts.ready)
              .then(() => {
                clearTimeout(cap);
                finish();
              })
              .catch(() => {
                clearTimeout(cap);
                finish();
              });
          }),
      )
      .catch(() => {});

    // Pages sometimes set up animations on the load tick — give a frame
    // for animations to actually start before we count the duration.
    await page.waitForTimeout(100);

    // Probe the frame's own animation length so we never cut it off. A short
    // per-frame duration set by the user could be < the frame's opening
    // animation, truncating it mid-play. Take the longer of the two: the frame
    // gets at least as long as its non-looping CSS animations / GSAP timeline.
    try {
      const animMs = await page.evaluate(() => {
        let maxMs = 0;
        Array.from(document.querySelectorAll('*')).forEach((el) => {
          const s = getComputedStyle(el);
          const durs = (s.animationDuration || '').split(',');
          const dels = (s.animationDelay || '').split(',');
          const iters = (s.animationIterationCount || '').split(',');
          durs.forEach((d, i) => {
            if ((iters[i] || '').trim() === 'infinite') return; // ignore looping bg anims
            maxMs = Math.max(maxMs, ((parseFloat(d) || 0) + (parseFloat(dels[i] || '0') || 0)) * 1000);
          });
        });
        // GSAP: do NOT use globalTimeline.totalDuration() — an infinitely
        // repeating tween (repeat:-1, e.g. a blinking cursor) makes it ~1e10s.
        // Walk the children and take the longest FINITE (non-repeat:-1) tween.
        const g = (window as unknown as {
          gsap?: { globalTimeline?: { getChildren?: (b?: boolean, t?: boolean, tl?: boolean) => Array<{ totalDuration?: () => number; repeat?: () => number; vars?: { repeat?: number } }> } };
        }).gsap;
        let gsapMs = 0;
        const children = g?.globalTimeline?.getChildren?.(true, true, true) ?? [];
        for (const c of children) {
          const repeat = typeof c.repeat === 'function' ? c.repeat() : (c.vars?.repeat ?? 0);
          if (repeat === -1) continue; // infinite loop — ignore
          const td = typeof c.totalDuration === 'function' ? c.totalDuration() : 0;
          if (Number.isFinite(td)) gsapMs = Math.max(gsapMs, td * 1000);
        }
        return Math.max(maxMs, gsapMs);
      });
      // +0.4s settle so the final animation frame is actually captured; cap at
      // 30s so a stray huge value can't make a frame run away.
      const needed = Math.min(30, (animMs + 400) / 1000);
      // Only extend when the duration is a soft 'auto' fallback. When the user
      // set an explicit per-frame length (multi-frame export), it's a hard cap —
      // honoring it keeps "每帧 4s" at 4s instead of letting one long animation
      // stretch the frame toward the 30s ceiling.
      if (input.config.durationMode !== 'explicit' && needed > totalDuration) {
        ctx.onProgress?.(38, `extending to ${needed.toFixed(1)}s for animation`);
        totalDuration = needed;
      }
    } catch { /* probe failed — fall back to the requested duration */ }

    // Switch the page onto the virtual clock, then start any multi-composition
    // master timelines. They were registered paused so the probe above could
    // read their real duration; playing them now is safe because GSAP's ticker
    // is already asleep — they sit at t=0 until __hvGoTo drives them.
    await page
      .evaluate(() => {
        const w = window as unknown as {
          __hvBeginVirtualTime?: () => void;
          __hvPlayAll?: () => void;
          __hvPlayed?: boolean;
        };
        w.__hvBeginVirtualTime?.();
        if (typeof w.__hvPlayAll === 'function') {
          w.__hvPlayed = true;
          w.__hvPlayAll();
        }
      })
      .catch(() => {});

    // Deterministic capture: seek every timeline to i/fps and screenshot.
    // Wall-clock speed no longer matters — however long a screenshot takes,
    // the page is pinned at exactly that frame's time, so the requested fps
    // is the real fps of the output, not an aspiration.
    totalFrames = Math.max(1, Math.round(totalDuration * fps));
    ctx.onProgress?.(40, `capturing ${totalFrames} frames`);
    for (let i = 0; i < totalFrames; i++) {
      if (ctx.signal?.aborted) throw new HtmlVideoError('cancelled', 'Aborted');
      const tMs = (i * 1000) / fps;
      await page.evaluate((ms) => {
        (window as unknown as { __hvGoTo?: (ms: number) => void }).__hvGoTo?.(ms);
      }, tMs);
      await page.screenshot({
        path: join(framesDir, `frame-${String(i).padStart(6, '0')}.png`),
        type: 'png',
        animations: 'allow', // we drive animations ourselves — don't let playwright reset them
        caret: 'hide',
      });
      const pct = 40 + Math.floor(((i + 1) / totalFrames) * 45);
      ctx.onProgress?.(pct, `capturing frame ${i + 1}/${totalFrames}`);
    }

    ctx.onProgress?.(85, 'finalising capture');
    await context.close();
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (cleanupSrc) await cleanupSrc().catch(() => {});
  }

  // ---- ffmpeg: png sequence → mp4 ----
  // The sequence already has exactly totalFrames frames at exact frame times,
  // so no lead-in trim, no tail padding, no -r resample: duration is
  // totalFrames/fps by construction for both 'explicit' and 'auto'.
  ctx.onProgress?.(90, 'encoding mp4');
  await runFfmpeg([
    '-y',
    '-framerate', String(fps),
    '-i', join(framesDir, 'frame-%06d.png'),
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-preset', 'medium',
    '-crf', '20',
    '-movflags', '+faststart',
    input.config.outputPath,
  ]);

  // Clean tmp dir
  await rm(recordDir, { recursive: true, force: true }).catch(() => {});

  const st = await stat(input.config.outputPath);
  ctx.onProgress?.(100, 'done');
  return {
    outputPath: input.config.outputPath,
    meta: {
      durationSec: totalDuration,
      fileSizeBytes: st.size,
      actualResolution: input.config.resolution,
      fps,
      renderedFrames: totalFrames,
      renderWallClockSec: (Date.now() - t0) / 1000,
      engineVersion: `hyperframes-playwright@${ADAPTER_VERSION}`,
    },
    diagnostics: [
      `deterministic frame-by-frame capture (${totalFrames} screenshots @ ${fps}fps) encoded with ffmpeg (libx264 crf20)`,
    ],
  };
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    proc.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        reject(new HtmlVideoError('render-failed',
          'ffmpeg not found on PATH. Install with `brew install ffmpeg` (macOS).'));
      } else reject(err);
    });
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new HtmlVideoError(
        'render-failed',
        `ffmpeg exited ${code}: ${stderr.slice(-2000)}`,
      ));
    });
  });
}

/**
 * Resolve the HTML to actually load into chromium.
 *
 * Single-file templates load as-is. Multi-composition templates declare their
 * scenes as `<div data-composition-src="compositions/x.html">` placeholders;
 * each composition file is a `<template>` wrapping markup + <style> + a <script>
 * that registers a paused GSAP timeline on `window.__timelines[name]`. The
 * studio preview assembles these client-side via fetch — but chromium blocks
 * file:// fetch, so over file:// the scenes would never appear.
 *
 * This reads each composition file on the Node side, inlines them into a
 * `window.__COMPOSITIONS__` map, and injects a player that grafts each
 * `<template>.content` into its placeholder and re-executes the composition
 * scripts (cloned <script> nodes never run on their own). The result is a
 * self-contained HTML written next to the source (so sibling relative assets
 * still resolve) and loaded over file://. Returns a cleanup() to remove it.
 */
async function prepareSourceHtml(
  sourcePath: string,
): Promise<{ loadPath: string; cleanup?: () => Promise<void> }> {
  const raw = await readFile(sourcePath, 'utf8');
  const srcMatches = Array.from(raw.matchAll(/data-composition-src=["']([^"']+)["']/g));
  if (srcMatches.length === 0) return { loadPath: sourcePath };

  const srcDir = dirname(sourcePath);
  const compMap: Record<string, string> = {};
  for (const m of srcMatches) {
    const rel = m[1]!;
    if (compMap[rel] !== undefined) continue;
    const compPath = join(srcDir, rel);
    if (!existsSync(compPath)) continue;
    compMap[rel] = await readFile(compPath, 'utf8');
  }
  if (Object.keys(compMap).length === 0) return { loadPath: sourcePath };

  // Escape `</` (and the comment opener) so the JSON survives the inline
  // <script> context — composition files contain their own </script> tags.
  const safeJson = JSON.stringify(compMap).replace(/<\//g, '<\\/').replace(/<!--/g, '<\\!--');

  let out = raw
    .replace(/__VIDEO_DURATION__/g, '15')
    .replace(/__VIDEO_SRC__/g, 'data:video/mp4;base64,');

  // Seed the timeline registry in <head> so the entry's own early
  // `window.__timelines["x"] = …` assignments don't throw on undefined.
  const head = `<script>window.__timelines=window.__timelines||{};window.__COMPOSITIONS__=${safeJson};</script>`;
  out = /<head[^>]*>/i.test(out)
    ? out.replace(/<head[^>]*>/i, (mm) => `${mm}\n${head}`)
    : `${head}\n${out}`;

  const player = `
<script>
(function () {
  function reexec(root) {
    root.querySelectorAll('script').forEach(function (old) {
      if (old.src) { old.parentNode.removeChild(old); return; }
      var s = document.createElement('script');
      // Wrap each composition's inline script in a block so top-level
      // \`const tl = …\` locals don't collide across scenes; the
      // window.__timelines assignments still escape the block.
      s.textContent = '{\\n' + old.textContent + '\\n}';
      old.parentNode.replaceChild(s, old);
    });
  }
  function mountOne(host) {
    var src = host.getAttribute('data-composition-src');
    var text = (window.__COMPOSITIONS__ || {})[src];
    if (!text) return;
    var holder = document.createElement('div');
    holder.innerHTML = text;
    var tpl = holder.querySelector('template');
    host.appendChild(tpl ? tpl.content.cloneNode(true) : holder);
    reexec(host);
  }
  // Play every registered timeline once from the start. Do NOT force
  // repeat(-1): these composition timelines are finite, scene-by-scene
  // narratives (e.g. kinetic-type is a 14.7s master timeline that wipes
  // through 6 scenes). Looping them broke two things — it replayed the intro
  // over the outro, and the renderer's duration probe SKIPS repeat:-1 tweens
  // as "infinite background anim", so a looped master timeline read as 0s and
  // the clip got truncated to the default 5s. Leaving them finite lets the
  // probe see the real 14.7s and record the whole story.
  window.__hvPlayAll = function () {
    var tls = window.__timelines || {};
    Object.keys(tls).forEach(function (k) {
      var tl = tls[k];
      if (tl && typeof tl.play === 'function') tl.play(0);
    });
  };
  function boot() {
    window.__timelines = window.__timelines || {};
    Array.prototype.slice
      .call(document.querySelectorAll('[data-composition-src]'))
      .forEach(mountOne);
    // The composition <script>s register their (paused) timelines synchronously
    // as they're injected, so they're on window.__timelines now. Leave them
    // paused here — the renderer probes their duration first, then calls
    // window.__hvPlayAll() at the exact moment recording starts so playback and
    // capture are aligned. If no driver calls it (e.g. opened standalone), fall
    // back to auto-playing shortly after load.
    setTimeout(function () { if (!window.__hvPlayed) window.__hvPlayAll(); }, 250);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else { boot(); }
})();
</script>`;
  out = out.includes('</body>') ? out.replace('</body>', `${player}\n</body>`) : out + player;

  const loadPath = join(srcDir, `.hv-render-${Date.now()}.html`);
  await writeFile(loadPath, out, 'utf8');
  return {
    loadPath,
    cleanup: async () => {
      await rm(loadPath, { force: true }).catch(() => {});
    },
  };
}

/**
 * Render template to a single HTML preview.
 *
 * v0.1: read the source HTML file (a Hyperframes template is HTML+CSS+JS),
 * inject a banner showing the variables, copy referenced assets, write to ctx.workDir.
 * Real upstream Hyperframes integration will replace the inject + add a frame-bound clock.
 */
export async function renderToHtml(
  input: RenderInput,
  ctx: RenderContext,
): Promise<HtmlSceneOutput> {
  if (!existsSync(input.template.sourcePath)) {
    throw new HtmlVideoError(
      'template-invalid',
      `Source not found: ${input.template.sourcePath}`,
    );
  }

  await mkdir(ctx.workDir, { recursive: true });
  const htmlPath = join(ctx.workDir, 'preview.html');
  const posterPath = join(ctx.workDir, 'poster.svg');

  const sourceHtml = await readFile(input.template.sourcePath, 'utf8');
  const augmented = sourceHtml.replace(
    '</body>',
    `<script>
window.__HV_VARS__ = ${JSON.stringify(input.variables)};
window.__HV_DURATION__ = ${typeof input.config.duration === 'number' ? input.config.duration : 5};
console.log('html-video preview vars', window.__HV_VARS__);
</script></body>`,
  );
  await writeFile(htmlPath, augmented, 'utf8');

  // Cheap poster: an SVG placeholder we draw ourselves (no headless chromium yet).
  const { width, height } = input.config.resolution;
  const title = String(input.variables.title ?? input.template.id);
  const poster = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  <rect width="100%" height="100%" fill="#1a1a1a"/>
  <text x="50%" y="50%" fill="#eee" font-family="Inter, system-ui, sans-serif"
        font-size="72" text-anchor="middle" dominant-baseline="middle">${escapeXml(title)}</text>
  <text x="50%" y="${height - 80}" fill="#888" font-family="monospace" font-size="32"
        text-anchor="middle">hyperframes · ${input.template.id}</text>
</svg>`;
  await writeFile(posterPath, poster, 'utf8');

  // Copy any referenced asset files mentioned in variables (best-effort)
  const referencedAssets: { assetId: string; usagePath: string }[] = [];
  for (const v of Object.values(input.variables)) {
    if (typeof v !== 'string') continue;
    if (!v.includes('/.html-video/bundles/')) continue;
    if (!existsSync(v)) continue;
    const dest = join(ctx.workDir, 'assets', v.split('/').pop() ?? 'asset');
    await mkdir(dirname(dest), { recursive: true });
    if (!existsSync(dest)) await copyFile(v, dest);
    const m = /assets\/([0-9a-f]{40})\./.exec(v);
    if (m && m[1]) {
      referencedAssets.push({ assetId: m[1], usagePath: dest });
    }
  }

  const totalDuration =
    input.config.duration === 'auto' ? 5 : input.config.duration;
  return {
    htmlPath,
    referencedAssets,
    posterPath,
    durationSec: totalDuration,
  };
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&apos;',
    };
    return map[c] ?? c;
  });
}

// silence unused imports warning until real impl uses them
void stat;
