// Generate TTS narration for each section using mmx-cli.
// Each clip is 3-4s and is placed at section-start + 0.6s in the final mux.

import { spawn } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const outDir = resolve('out/tts');
if (!existsSync(outDir)) await mkdir(outDir, { recursive: true });

const sections = [
  {
    id: 's1',
    text: 'Section one. Sync. Pulled the latest changes for ee main site, reviewed the diff across three hundred and forty five session messages, and applied the updates. Build is green. Deploy slot held.',
  },
  {
    id: 's2',
    text: 'Section two. Expand. The EE Social Media plugin now includes Reddit posting. Built the agent integration end to end, three hundred and twenty seven messages this session. Currently blocked by the V P S I P range. Routing fix queued for Monday.',
  },
  {
    id: 's3',
    text: 'Section three. Auth. Tested LinkedIn posting via the Google account sign-in path. Google sign-in failed on the O Auth consent screen. Ninety four messages of debugging. Re-auth flow documented. Will retry on a clean profile.',
  },
  {
    id: 's4',
    text: 'Section four. Tooling. Installed the MiniMax M C P server for web search and wired it into the agent runtime via Hermes config dot yaml. One hundred ninety six messages for full setup and smoke tests. Tool registry now exposes web dot search.',
  },
  {
    id: 's5',
    text: 'Section five. Intake. Processed a company intake submission for S A J Electric, residential hybrid solar system, Asia Pacific region. Routed to the solutions team with a pre-filled brief and discovery call scheduled.',
  },
  {
    id: 's6',
    text: 'Section six. Local. Worked on the Google Maps review campaign for the Kluang location of Eternalgy Sdn B H D. Claim verified, listing polished, review solicitation sequence drafted for post-purchase flows.',
  },
];

const VOICE = 'English_expressive_narrator';
const SPEED = '0.92';

function run(cmd, args) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: true });
    let out = '', err = '';
    p.stdout.on('data', d => (out += d.toString()));
    p.stderr.on('data', d => (err += d.toString()));
    p.on('close', code => code === 0 ? res(out.trim()) : rej(new Error(`exit ${code}: ${err}`)));
  });
}

const results = [];
for (const s of sections) {
  const outPath = resolve(outDir, `${s.id}.mp3`);
  console.log(`\n→ ${s.id} (${s.text.length} chars)`);
  const t0 = Date.now();
  try {
    await run('C:\\Users\\Eternalgy\\AppData\\Roaming\\npm\\mmx.cmd', [
      'speech', 'synthesize',
      '--text', s.text,
      '--voice', VOICE,
      '--speed', SPEED,
      '--format', 'mp3',
      '--out', outPath,
      '--quiet',
    ]);
    const st = await stat(outPath);
    const ms = Date.now() - t0;
    // ffprobe to get duration
    const probe = await run('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', outPath,
    ]).catch(() => '?');
    const dur = parseFloat(probe);
    console.log(`  ✓ ${ms}ms · ${dur.toFixed(2)}s · ${(st.size / 1024).toFixed(1)} KB`);
    results.push({ id: s.id, path: outPath, durationSec: dur, bytes: st.size });
  } catch (e) {
    console.error(`  ✗ ${s.id}: ${e.message}`);
    process.exit(1);
  }
}

console.log('\n──── TTS generated ────');
let total = 0;
for (const r of results) {
  console.log(`  ${r.id}: ${r.path} · ${r.durationSec.toFixed(2)}s`);
  total += r.durationSec;
}
console.log(`\nTotal narration duration: ${total.toFixed(2)}s`);
