// Mux TTS narration into the rendered video.
// Each clip is delayed to start ~0.6s after its section begins (so the
// section's text is visible before the narrator starts reading).

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const videoIn = 'out/daily-report.mp4';
const audioOut = 'out/daily-report-with-audio.mp4';

// Section start times in the video timeline
//   title  0.0–4.0s   — no narration
//   s1     4.0–10.0s  — narration at +0.6s
//   s2     9.5–15.5s
//   s3     15.0–21.0s
//   s4     20.5–26.5s
//   s5     26.0–32.0s
//   s6     31.5–37.5s
//   outro  37.0–42.0s — no narration

const placements = [
  { id: 's1', file: 'out/tts/s1.mp3', startSec: 4.0 + 0.6 },
  { id: 's2', file: 'out/tts/s2.mp3', startSec: 9.5 + 0.6 },
  { id: 's3', file: 'out/tts/s3.mp3', startSec: 15.0 + 0.6 },
  { id: 's4', file: 'out/tts/s4.mp3', startSec: 20.5 + 0.6 },
  { id: 's5', file: 'out/tts/s5.mp3', startSec: 26.0 + 0.6 },
  { id: 's6', file: 'out/tts/s6.mp3', startSec: 31.5 + 0.6 },
];

for (const p of placements) {
  if (!existsSync(p.file)) {
    console.error(`Missing TTS: ${p.file}`);
    process.exit(1);
  }
}
if (!existsSync(videoIn)) {
  console.error(`Missing video: ${videoIn}`);
  process.exit(1);
}

// Build ffmpeg command.
//   -i video       : input video
//   -i tts/s1.mp3  : one input per narration
//   filter_complex:
//     for each narration: [i]adelay=ms[i]      (delay in ms)
//     [a][b]...[amix=N=N:normalize=0          (mix all)
//   -map 0:v       : video from input 0
//   -map [mix]     : mixed audio
//   -c:v copy      : don't re-encode video
//   -c:a aac       : encode audio as AAC
//   -shortest      : stop at end of shortest (video)

const inputArgs = [videoIn, ...placements.map(p => p.file)];

// adelay for each narration (in ms). Multiple outputs for amix.
const adelayExprs = placements.map(p => `[${placements.indexOf(p) + 1}:a]adelay=${Math.round(p.startSec * 1000)}|${Math.round(p.startSec * 1000)}[a${placements.indexOf(p)}]`);
// Add a silent pad to cover any gap at the end so the audio stream
// is exactly as long as the video (avoids `-shortest` truncation).
const padLenMs = 42000;
const filterParts = [
  ...adelayExprs,
  // amix all narrations
  placements.map((_, i) => `[a${i}]`).join('') + `amix=inputs=${placements.length}:normalize=0:duration=longest[mixed]`,
  // pad to 42s with silence
  `[mixed]apad=whole_dur=${padLenMs}[aout]`,
];

const filterComplex = filterParts.join(';');

const args = [
  ...inputArgs.flatMap(p => ['-i', p]),
  '-filter_complex', filterComplex,
  '-map', '0:v',
  '-map', '[aout]',
  '-c:v', 'copy',
  '-c:a', 'aac', '-b:a', '192k',
  '-ar', '48000',
  '-ac', '2',
  '-t', '42',
  '-y',
  audioOut,
];

console.log('Muxing audio with video…');
console.log(`Filter: ${filterComplex.substring(0, 200)}…`);

const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
let out = '', err = '';
p.stdout.on('data', d => (out += d.toString()));
p.stderr.on('data', d => (err += d.toString()));
p.on('close', code => {
  if (code === 0) {
    console.log('✓ Mux complete');
    const probe = spawn('ffprobe', [
      '-v', 'error', '-show_entries',
      'format=duration,size:stream=codec_name,codec_type,width,height,r_frame_rate,sample_rate,channels',
      '-of', 'default', audioOut,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let po = '';
    probe.stdout.on('data', d => (po += d.toString()));
    probe.on('close', () => console.log(po));
  } else {
    console.error(`✗ ffmpeg exit ${code}\n${err}`);
    process.exit(1);
  }
});
