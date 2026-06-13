// Audio-first speech-video pipeline driver.
//
// The narration is the timing master: TTS is generated FIRST, each clip is
// measured with ffprobe, and every slide's render duration is derived from its
// own narration length. Audio mux offsets are prefix sums of those same
// durations, so picture and speech can never drift apart.
//
// Usage: node scripts/make-speech-video.mjs <manifest.json>
//
// Manifest schema (see workflows/speech-video.md for the full reference):
// {
//   "output": "out/demo/final.mp4",
//   "fps": 60,
//   "resolution": { "width": 1920, "height": 1080 },
//   "voice": "presenter_male",          // mmx voice id
//   "language": "Chinese",              // mmx language boost
//   "speechSpeed": 1.0,
//   "leadInSec": 0.6,                   // slide visible before narration starts
//   "tailSec": 0.6,                     // breathing room after narration ends
//   "minSlideSec": 4,                   // floor for very short narrations
//   "sections": [
//     { "id": "s1", "html": "slides/s1.html", "narration": "中文旁白……" },
//     { "id": "outro", "html": "slides/outro.html", "durationSec": 4 }  // no speech
//   ]
// }

import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const manifestPath = resolve(process.argv[2] ?? 'speech-video.json');
if (!existsSync(manifestPath)) {
  console.error(`Manifest not found: ${manifestPath}`);
  process.exit(1);
}
const manifestDir = dirname(manifestPath);
const m = JSON.parse(await readFile(manifestPath, 'utf8'));

const fps = m.fps ?? 60;
const resolution = m.resolution ?? { width: 1920, height: 1080 };
const voice = m.voice ?? 'presenter_male';
const language = m.language ?? 'Chinese';
const speechSpeed = m.speechSpeed ?? 1.0;
const leadInSec = m.leadInSec ?? 0.6;
const tailSec = m.tailSec ?? 0.6;
const minSlideSec = m.minSlideSec ?? 4;
const outputPath = resolve(manifestDir, m.output ?? 'out/final.mp4');

const workDir = join(dirname(outputPath), '.speech-video-work');
const ttsDir = join(workDir, 'tts');
const segDir = join(workDir, 'segments');
await mkdir(ttsDir, { recursive: true });
await mkdir(segDir, { recursive: true });

function run(cmd, args, opts = {}) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: opts.shell ?? false });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', rej);
    p.on('close', (code) => (code === 0 ? res(out.trim()) : rej(new Error(`${cmd} exit ${code}: ${err.slice(-1500)}`))));
  });
}

const ffprobeDur = async (file) =>
  parseFloat(await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]));

// ── Phase 1: TTS per section (skipped if the mp3 already exists — delete
//    out/.speech-video-work/tts/<id>.mp3 to force regeneration) ──────────────
console.log('── Phase 1: TTS ──');
for (const s of m.sections) {
  if (!s.narration) continue;
  s.audioPath = join(ttsDir, `${s.id}.mp3`);
  if (existsSync(s.audioPath)) {
    console.log(`  ${s.id}: reusing existing ${s.audioPath}`);
    continue;
  }
  const t0 = Date.now();
  await run('mmx', [
    'speech', 'synthesize',
    '--text', s.narration,
    '--voice', voice,
    '--language', language,
    '--speed', String(speechSpeed),
    '--format', 'mp3',
    '--out', s.audioPath,
    '--quiet', '--non-interactive',
  ], { shell: process.platform === 'win32' }); // mmx is a .cmd shim on Windows
  console.log(`  ${s.id}: synthesized in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// ── Phase 2: measure audio, derive per-slide durations ──────────────────────
console.log('── Phase 2: timing ──');
let cursor = 0;
for (const s of m.sections) {
  if (s.audioPath) {
    s.audioDurationSec = await ffprobeDur(s.audioPath);
    s.durationSec = Math.max(minSlideSec, leadInSec + s.audioDurationSec + tailSec);
    s.audioStartSec = cursor + leadInSec;
  } else {
    s.durationSec = s.durationSec ?? minSlideSec; // silent slide: manifest value or floor
  }
  s.videoStartSec = cursor;
  // Snap to a whole frame count so concat boundaries land exactly on frames.
  s.durationSec = Math.round(s.durationSec * fps) / fps;
  cursor += s.durationSec;
  console.log(
    `  ${s.id}: video ${s.videoStartSec.toFixed(2)}s +${s.durationSec.toFixed(2)}s` +
    (s.audioPath ? ` · speech ${s.audioDurationSec.toFixed(2)}s @ ${s.audioStartSec.toFixed(2)}s` : ' · silent'),
  );
}
const totalSec = cursor;
console.log(`  total: ${totalSec.toFixed(2)}s`);

// ── Phase 3: render each slide at its exact derived duration ────────────────
console.log('── Phase 3: render ──');
const adapterModule = await import(
  pathToFileURL(resolve('packages/adapter-hyperframes/dist/index.js')).href
);
const { render } = adapterModule.default ?? adapterModule.adapter;
for (const s of m.sections) {
  const htmlPath = resolve(manifestDir, s.html);
  if (!existsSync(htmlPath)) {
    console.error(`  ${s.id}: slide HTML not found: ${htmlPath}`);
    process.exit(1);
  }
  s.segmentPath = join(segDir, `${s.id}.mp4`);
  const t0 = Date.now();
  await render(
    {
      template: { id: `slide-${s.id}`, sourcePath: htmlPath, mode: 'bridge' },
      variables: {},
      config: {
        format: 'mp4',
        resolution,
        fps,
        duration: s.durationSec,
        durationMode: 'explicit', // narration-derived length is a hard contract
        outputPath: s.segmentPath,
        alpha: false,
      },
    },
    { workDir: segDir },
  );
  console.log(`  ${s.id}: ${s.durationSec.toFixed(2)}s rendered in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

// ── Phase 4: concat video (same encoder settings → lossless demuxer copy) ───
console.log('── Phase 4: concat ──');
const listPath = join(workDir, 'concat.txt');
await writeFile(
  listPath,
  m.sections.map((s) => `file '${s.segmentPath.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'),
  'utf8',
);
const silentVideo = join(workDir, 'video-only.mp4');
await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', silentVideo]);

// ── Phase 5: mux narration at the computed offsets ───────────────────────────
console.log('── Phase 5: mux audio ──');
const voiced = m.sections.filter((s) => s.audioPath);
const inputs = ['-i', silentVideo];
for (const s of voiced) inputs.push('-i', s.audioPath);
const delayed = voiced.map((s, i) => {
  const ms = Math.round(s.audioStartSec * 1000);
  return `[${i + 1}:a]adelay=${ms}|${ms}[a${i}]`;
});
const filter = [
  `anullsrc=channel_layout=mono:sample_rate=32000:d=${totalSec.toFixed(3)}[base]`,
  ...delayed,
  `[base]${voiced.map((_, i) => `[a${i}]`).join('')}amix=inputs=${voiced.length + 1}:normalize=0[mix]`,
].join(';');
await run('ffmpeg', [
  '-y', ...inputs,
  '-filter_complex', filter,
  '-map', '0:v', '-map', '[mix]',
  '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k',
  '-t', totalSec.toFixed(3),
  '-movflags', '+faststart',
  outputPath,
]);

const st = await stat(outputPath);
const finalDur = await ffprobeDur(outputPath);
console.log('── Done ──');
console.log(`  ${outputPath}`);
console.log(`  ${finalDur.toFixed(2)}s · ${(st.size / 1024 / 1024).toFixed(2)} MB · ${fps}fps`);
console.log('  timeline:');
for (const s of m.sections) {
  console.log(
    `    ${s.videoStartSec.toFixed(2).padStart(7)}s  ${s.id}` +
    (s.audioPath ? `  (speech ${s.audioStartSec.toFixed(2)}–${(s.audioStartSec + s.audioDurationSec).toFixed(2)}s)` : ''),
  );
}
