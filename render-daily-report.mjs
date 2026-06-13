// One-off renderer: takes a hyperframes-style HTML and renders it to MP4
// via the html-video hyperframes adapter (Playwright + ffmpeg).
//
// Usage: node render-daily-report.mjs <input.html> <output.mp4>

import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const inputHtml = resolve(process.argv[2] ?? 'daily-report.html');
const outputMp4 = resolve(process.argv[3] ?? 'out/daily-report.mp4');
const fps = Number(process.argv[4] ?? 60);
const duration = Number(process.argv[5] ?? 42);

if (!existsSync(inputHtml)) {
  console.error(`Input HTML not found: ${inputHtml}`);
  process.exit(1);
}

const htmlStat = await stat(inputHtml);
console.log(`Input:  ${inputHtml} (${(htmlStat.size / 1024).toFixed(1)} KB)`);
console.log(`Output: ${outputMp4}`);
console.log(`FPS:    ${fps}`);
console.log(`Length: ${duration}s`);

const adapterModule = await import(pathToFileURL(resolve('packages/adapter-hyperframes/dist/index.js')).href);
const adapter = adapterModule.default ?? adapterModule.adapter;
const { render } = adapter;

const input = {
  template: {
    id: 'frame-daily-report',
    sourcePath: inputHtml,
    mode: 'bridge',
  },
  variables: {},
  config: {
    format: 'mp4',
    resolution: { width: 1920, height: 1080 },
    fps,
    duration,
    durationMode: 'explicit',
    outputPath: outputMp4,
    alpha: false,
  },
};

const ctx = {
  workDir: dirname(outputMp4),
  onProgress: (pct, stage) => {
    process.stdout.write(`\r  [${stage.padEnd(20)}] ${pct.toFixed(0).padStart(3)}%`);
    if (pct >= 100) process.stdout.write('\n');
  },
};

console.log('Rendering via hyperframes adapter (Playwright + ffmpeg)...');
const t0 = Date.now();
const result = await render(input, ctx);
const t1 = Date.now();

console.log(`\n✓ Done in ${((t1 - t0) / 1000).toFixed(1)}s`);
console.log(`  → ${result.outputPath}`);
console.log(`  Duration: ${result.meta.durationSec.toFixed(2)}s  ${result.meta.actualResolution.width}×${result.meta.actualResolution.height} @ ${result.meta.fps}fps`);
console.log(`  Frames:   ${result.meta.renderedFrames}`);
console.log(`  Size:     ${(result.meta.fileSizeBytes / 1024 / 1024).toFixed(2)} MB`);
console.log(`  Engine:   ${result.meta.engineVersion}`);
if (result.diagnostics?.length) {
  console.log('  Diagnostics:');
  for (const d of result.diagnostics) console.log(`    - ${d}`);
}
