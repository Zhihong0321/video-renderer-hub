import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  copyFile,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { CliContext } from '../context.js';
import { fail, ok, progress } from '../output.js';

interface MakeOptions {
  output: string;
}

interface TemplateBrief {
  id: string;
  name: string;
  bestFor: string[];
  category: string;
  entry: string; // path to the template's source HTML, relative to the work dir
}

interface ManifestSection {
  id: string;
  html: string;
  narration?: string;
  durationSec?: number;
}

interface ManifestFile {
  output: string;
  fps: number;
  resolution: { width: number; height: number };
  voice: string;
  language: string;
  speechSpeed: number;
  leadInSec: number;
  tailSec: number;
  minSlideSec: number;
  sections: ManifestSection[];
}

interface SlideDeclaration {
  id: string;
  narrated: boolean;
}

interface SlidesFile {
  slides: SlideDeclaration[];
}

interface VerificationResult {
  durationSec: number;
  expectedDurationSec: number;
  sampledFrames: Array<{ timeSec: number; ymin: number; ymax: number }>;
  streams: string[];
  tts: Array<{ id: string; bytes: number; durationSec: number }>;
}

export async function makeVideo(ctx: CliContext, promptText: string, opts: MakeOptions): Promise<void> {
  const projectRoot = ctx.projectRoot;
  const outputPath = resolve(opts.output);
  const skillPath = join(projectRoot, 'workflows', 'speech-video.md');
  const skillText = await readFile(skillPath, 'utf8').catch((err) => {
    fail('missing-skill', `Cannot read ${skillPath}`, {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  if (!promptText.trim()) {
    fail('invalid-input', 'Prompt is required');
  }

  await mkdir(dirname(outputPath), { recursive: true });

  let lastError = 'unknown failure';
  let lastWorkDir = '';
  const scratchRoot = join(projectRoot, 'out', 'hv-make-runs');
  await mkdir(scratchRoot, { recursive: true });

  for (let attempt = 1; attempt <= 2; attempt++) {
    const workDir = await mkdtemp(join(scratchRoot, 'run-'));
    lastWorkDir = workDir;
    let keepWorkDir = true;

    try {
      progress('scratch', 5, { attempt, work_dir: workDir });
      await prepareScratchDir(workDir);

      // Pre-filter premium templates in code; Claude picks + adapts (best-effort).
      const templates = await provideTemplates(workDir, ctx, promptText);
      progress('templates', 10, { attempt, count: templates.length, ids: templates.map((t) => t.id) });

      progress('author', 15, { attempt });
      await authorSlides({
        workDir,
        promptText,
        skillText,
        language: detectLanguage(promptText),
        templates,
      });
      const slidesFile = await readSlidesFile(workDir);
      await assertAuthoredFiles(workDir, slidesFile);

      progress('manifest', 30, { attempt });
      const manifest = await writeManifest(workDir, promptText, slidesFile);

      progress('render', 55, { attempt });
      await runDriver(projectRoot, join(workDir, 'manifest.json'));

      progress('verify', 85, { attempt });
      const verification = await verifyOutput(workDir, manifest);

      await copyFile(join(workDir, 'final.mp4'), outputPath);
      keepWorkDir = false;
      ok({
        output: outputPath,
        attempt,
        verification,
      });
      await rm(workDir, { recursive: true, force: true });
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      progress('retry', attempt === 1 ? 90 : 100, {
        attempt,
        error: lastError,
        work_dir: workDir,
      });
      if (!keepWorkDir) {
        await rm(workDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  fail('hv-make-failed', lastError, { work_dir: lastWorkDir });
}

async function prepareScratchDir(workDir: string): Promise<void> {
  await mkdir(join(workDir, 'slides'), { recursive: true });
  await mkdir(join(workDir, 'narration'), { recursive: true });
}

/**
 * Shortlist premium templates for the prompt (code pre-filters) and copy their
 * source into the work dir so Claude can read + adapt them (Claude finalizes).
 * Best-effort: any failure returns [] and Claude authors from scratch — never a
 * hard failure point. This is NOT runtime string-fill; Claude adapts the HTML.
 */
async function provideTemplates(workDir: string, ctx: CliContext, promptText: string): Promise<TemplateBrief[]> {
  try {
    // Omit enginesAvailable so the shortlist is never empty-filtered; all our
    // templates render through the same hyperframes framestep adapter anyway.
    // Search a few extra: some entries are skipped below (non-HTML/native).
    const matches = ctx.templates.search({ intent: promptText, top: 6 });
    if (!matches.length) return [];
    const destRoot = join(workDir, 'templates');
    await mkdir(destRoot, { recursive: true });

    const briefs: TemplateBrief[] = [];
    for (const { template: t } of matches) {
      if (briefs.length >= 4) break;
      const dir = (t as { __dir?: string }).__dir;
      if (!dir || !existsSync(dir)) continue;
      const srcDir = existsSync(join(dir, 'source')) ? join(dir, 'source') : dir;
      // source_entry is declared inconsistently across templates: some "index.html",
      // some "source/index.html". Resolve by basename within srcDir, and skip
      // non-HTML entries (e.g. Remotion native .ts/.tsx bundles can't be adapted).
      const entryBase = basename(t.source_entry || 'index.html');
      if (!/\.html?$/i.test(entryBase)) continue;
      const entryFile = existsSync(join(srcDir, entryBase))
        ? entryBase
        : existsSync(join(srcDir, 'index.html'))
          ? 'index.html'
          : '';
      if (!entryFile) continue;
      await cp(srcDir, join(destRoot, t.id), { recursive: true });
      briefs.push({
        id: t.id,
        name: t.name,
        bestFor: t.best_for ?? [],
        category: t.category ?? '',
        entry: `templates/${t.id}/${entryFile}`,
      });
    }
    return briefs;
  } catch {
    return [];
  }
}

async function authorSlides(args: {
  workDir: string;
  promptText: string;
  skillText: string;
  language: string;
  templates: TemplateBrief[];
}): Promise<void> {
  const prompt = buildClaudePrompt(args.promptText, args.skillText, args.language, args.templates);
  await run('claude', [
    '--bare',
    '--dangerously-skip-permissions',
    '--permission-mode',
    'bypassPermissions',
    '-p',
    prompt,
  ], { cwd: args.workDir });
}

function buildClaudePrompt(promptText: string, skillText: string, language: string, templates: TemplateBrief[]): string {
  const templateBlock = templates.length
    ? [
        'PREMIUM TEMPLATES — start from these, do not invent slides from scratch:',
        'The following premium HTML templates have been copied into ./templates/.',
        'They have professional CSS animations, typography and layout. Use them.',
        ...templates.map(
          (t) => `- ${t.id} (${t.category || 'general'}) — best for: ${(t.bestFor || []).join(', ') || 'general'}. Source: ${t.entry}`,
        ),
        'For each slide: pick the best-fitting template above, READ its source HTML,',
        'and produce slides/<id>.html that REUSES its visual design + CSS animations',
        'but with the real content for this topic swapped in. Adapt intelligently —',
        'edit headings/text/colors to fit; keep the motion and the look.',
        'Each slides/<id>.html MUST be self-contained: inline all CSS; keep Google',
        'Fonts <link> tags if the template uses them; do NOT reference ../templates',
        'or any external local file (the slide is rendered from slides/ in isolation).',
      ].join('\n')
    : 'No templates available — author clean self-contained slides yourself.';

  return [
    'You are writing only creative content for a narrated video.',
    'Read and follow these authoring rules exactly:',
    skillText,
    templateBlock,
    'Task:',
    promptText,
    `Language: ${language}`,
    'Decide how many slides the topic needs.',
    'Write a file named slides.json in the current working directory with exact JSON shape:',
    '{"slides":[{"id":"cover","narrated":false},{"id":"s1","narrated":true},{"id":"outro","narrated":false}]}',
    'Then create slides/<id>.html for every slide listed.',
    'For every slide with narrated:true, create narration/<id>.txt.',
    'Requirements:',
    '- Use between 2 and 8 slides total.',
    '- Prefer adapting a premium template above over building a slide from scratch.',
    '- Usually include a silent cover and a silent outro when that helps clarity.',
    '- One idea per slide.',
    '- Make the visuals obviously non-blank and strongly visible.',
    '- Use dark or high-contrast backgrounds rather than flat white.',
    '- Narration should be concise, natural, and easy to speak.',
    '- Do not create manifest.json.',
    '- Do not create files outside slides.json, slides/*.html, and narration/*.txt.',
    '- When finished, print a one-line summary only.',
  ].join('\n\n');
}

async function readSlidesFile(workDir: string): Promise<SlidesFile> {
  const slidesJsonPath = join(workDir, 'slides.json');
  if (!existsSync(slidesJsonPath)) {
    throw new Error('Claude did not create slides.json');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(slidesJsonPath, 'utf8'));
  } catch {
    throw new Error('slides.json is not valid JSON');
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as SlidesFile).slides)) {
    throw new Error('slides.json must contain a slides array');
  }

  const slides = (parsed as SlidesFile).slides;
  if (slides.length < 2 || slides.length > 8) {
    throw new Error(`slides.json must declare between 2 and 8 slides, got ${slides.length}`);
  }

  const seen = new Set<string>();
  for (const slide of slides) {
    if (!slide || typeof slide !== 'object') {
      throw new Error('slides.json contains an invalid slide entry');
    }
    if (typeof slide.id !== 'string' || !/^[a-z0-9-]+$/i.test(slide.id)) {
      throw new Error(`slides.json has invalid slide id: ${String(slide.id)}`);
    }
    if (typeof slide.narrated !== 'boolean') {
      throw new Error(`slides.json has invalid narrated flag for ${slide.id}`);
    }
    if (seen.has(slide.id)) {
      throw new Error(`slides.json repeats slide id: ${slide.id}`);
    }
    seen.add(slide.id);
  }

  return { slides };
}

async function assertAuthoredFiles(workDir: string, slidesFile: SlidesFile): Promise<void> {
  for (const slide of slidesFile.slides) {
    const htmlPath = join(workDir, 'slides', `${slide.id}.html`);
    if (!existsSync(htmlPath)) {
      throw new Error(`Claude did not create required file: slides/${slide.id}.html`);
    }
    const htmlText = (await readFile(htmlPath, 'utf8')).trim();
    if (!htmlText) {
      throw new Error(`Claude created empty file: slides/${slide.id}.html`);
    }

    if (!slide.narrated) continue;

    const narrationPath = join(workDir, 'narration', `${slide.id}.txt`);
    const relPath = `narration/${slide.id}.txt`;
    const filePath = narrationPath;
    if (!existsSync(filePath)) {
      throw new Error(`Claude did not create required file: ${relPath}`);
    }
    const text = (await readFile(filePath, 'utf8')).trim();
    if (!text) {
      throw new Error(`Claude created empty file: ${relPath}`);
    }
  }
}

async function writeManifest(workDir: string, promptText: string, slidesFile: SlidesFile): Promise<ManifestFile> {
  const language = detectLanguage(promptText);
  const manifest: ManifestFile = {
    output: 'final.mp4',
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    voice: language === 'Chinese' ? 'presenter_male' : 'English_expressive_narrator',
    language,
    speechSpeed: 1.0,
    leadInSec: 0.6,
    tailSec: 0.6,
    minSlideSec: 4,
    sections: await Promise.all(
      slidesFile.slides.map(async (slide) => {
        const section: ManifestSection = {
          id: slide.id,
          html: `slides/${slide.id}.html`,
        };
        if (slide.narrated) {
          section.narration = (await readFile(join(workDir, 'narration', `${slide.id}.txt`), 'utf8')).trim();
        } else {
          section.durationSec = 2;
        }
        return section;
      }),
    ),
  };

  if (manifest.sections.some((section) => section.narration === '')) {
    throw new Error('Narration files must not be empty');
  }

  await writeFile(join(workDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

async function runDriver(projectRoot: string, manifestPath: string): Promise<void> {
  await run('node', ['scripts/make-speech-video.mjs', manifestPath], { cwd: projectRoot });
}

async function verifyOutput(workDir: string, manifest: ManifestFile): Promise<VerificationResult> {
  const finalPath = join(workDir, 'final.mp4');
  if (!existsSync(finalPath)) {
    throw new Error('Render did not produce final.mp4');
  }

  const streams = await ffprobeStreams(finalPath);
  if (!streams.includes('video')) {
    throw new Error('final.mp4 is missing a video stream');
  }
  if (!streams.includes('audio')) {
    throw new Error('final.mp4 is missing an audio stream');
  }

  const tts = await collectTtsEvidence(workDir, manifest);
  const expectedDurationSec = computeExpectedDuration(manifest, tts);
  const durationSec = await ffprobeDuration(finalPath);
  if (Math.abs(durationSec - expectedDurationSec) > 0.1) {
    throw new Error(
      `Duration mismatch: expected ${expectedDurationSec.toFixed(3)}s, got ${durationSec.toFixed(3)}s`,
    );
  }

  const times = buildSampleTimes(durationSec);
  const sampledFrames = [];
  let nonBlank = 0;
  for (const timeSec of times) {
    const frame = await sampleFrameSignalStats(finalPath, timeSec);
    sampledFrames.push(frame);
    if (frame.ymax > frame.ymin) nonBlank++;
  }
  // A real video shows content for most of its body. Premium templates fade in
  // from black, so an edge frame can be legitimately blank — that's NOT a white
  // screen. A true white screen is blank everywhere. Require a majority of body
  // samples to have content.
  if (nonBlank < Math.ceil(times.length / 2)) {
    throw new Error(`Blank-frame check failed: only ${nonBlank}/${times.length} sampled frames had content (likely a true blank render)`);
  }

  return {
    durationSec,
    expectedDurationSec,
    sampledFrames,
    streams,
    tts,
  };
}

async function collectTtsEvidence(
  workDir: string,
  manifest: ManifestFile,
): Promise<Array<{ id: string; bytes: number; durationSec: number }>> {
  const ttsDir = join(workDir, '.speech-video-work', 'tts');
  const voicedSections = manifest.sections.filter((section) => section.narration);
  const result = [];

  for (const section of voicedSections) {
    const mp3Path = join(ttsDir, `${section.id}.mp3`);
    if (!existsSync(mp3Path)) {
      throw new Error(`Missing narration audio: ${section.id}.mp3`);
    }
    const fileStat = await stat(mp3Path);
    if (fileStat.size <= 5 * 1024) {
      throw new Error(`Narration audio too small: ${section.id}.mp3 (${fileStat.size} bytes)`);
    }
    const durationSec = await ffprobeDuration(mp3Path);
    if (!(durationSec > 0)) {
      throw new Error(`Narration audio duration invalid: ${section.id}.mp3`);
    }
    result.push({
      id: section.id,
      bytes: fileStat.size,
      durationSec,
    });
  }

  return result;
}

function computeExpectedDuration(
  manifest: ManifestFile,
  tts: Array<{ id: string; durationSec: number }>,
): number {
  const ttsById = new Map(tts.map((item) => [item.id, item.durationSec]));
  let total = 0;

  for (const section of manifest.sections) {
    const audioDurationSec = ttsById.get(section.id);
    let durationSec = section.durationSec ?? manifest.minSlideSec;
    if (audioDurationSec != null) {
      durationSec = Math.max(manifest.minSlideSec, manifest.leadInSec + audioDurationSec + manifest.tailSec);
    }
    durationSec = Math.round(durationSec * manifest.fps) / manifest.fps;
    total += durationSec;
  }

  return total;
}

function buildSampleTimes(durationSec: number): number[] {
  // Sample inside the body (15%–85%), NOT the very start/end where intro and
  // outro fades live. Sampling t=0.2s wrongly flagged fade-in templates as blank.
  const d = Math.max(0.4, durationSec);
  return [0.15, 0.35, 0.5, 0.65, 0.85].map((f) => Math.min(d - 0.1, Math.max(0.1, d * f)));
}

async function sampleFrameSignalStats(
  videoPath: string,
  timeSec: number,
): Promise<{ timeSec: number; ymin: number; ymax: number }> {
  const output = await run('ffmpeg', [
    '-hide_banner',
    '-ss',
    timeSec.toFixed(3),
    '-i',
    videoPath,
    '-frames:v',
    '1',
    '-vf',
    'signalstats,metadata=print:file=-',
    '-f',
    'null',
    '-',
  ]);

  const ymin = extractLastNumber(output, /lavfi\.signalstats\.YMIN=(\d+(?:\.\d+)?)/g);
  const ymax = extractLastNumber(output, /lavfi\.signalstats\.YMAX=(\d+(?:\.\d+)?)/g);

  if (ymin == null || ymax == null) {
    throw new Error(`Could not read signalstats at ${timeSec.toFixed(2)}s`);
  }

  return { timeSec, ymin, ymax };
}

function extractLastNumber(text: string, pattern: RegExp): number | null {
  const matches = [...text.matchAll(pattern)];
  if (!matches.length) return null;
  return Number(matches[matches.length - 1]?.[1]);
}

async function ffprobeStreams(filePath: string): Promise<string[]> {
  const output = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'stream=codec_type',
    '-of',
    'default=nw=1:nk=1',
    filePath,
  ]);
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function ffprobeDuration(filePath: string): Promise<number> {
  const output = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=nw=1:nk=1',
    filePath,
  ]);
  return Number(output.trim());
}

function detectLanguage(promptText: string): 'Chinese' | 'English' {
  return /[\u3400-\u9fff\uf900-\ufaff]/.test(promptText) ? 'Chinese' : 'English';
}

async function run(
  command: string,
  args: string[],
  opts: { cwd?: string } = {},
): Promise<string> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise([stdout, stderr].filter(Boolean).join('\n').trim());
        return;
      }
      rejectPromise(
        new Error(
          `${command} exit ${code}: ${[stdout, stderr].filter(Boolean).join('\n').slice(-4000)}`,
        ),
      );
    });
  });
}
