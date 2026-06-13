// WebUI configuration. Env reads only; no Postgres, no Docker, no SSE.

import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

function read(name, fallback) {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

export const HOST = read('HOST', '0.0.0.0');
export const PORT = Number(read('PORT', '3000'));
export const WEBUI_ROOT = resolve(read('WEBUI_ROOT', process.cwd()));
const dataDirEnv = read('DATA_DIR', 'data');
export const DATA_DIR = resolve(isAbsolute(dataDirEnv) ? dataDirEnv : join(WEBUI_ROOT, dataDirEnv));
export const RESULTS_DIR = resolve(join(DATA_DIR, read('RESULTS_SUBDIR', 'results')));
export const DB_PATH = resolve(join(DATA_DIR, read('DB_FILENAME', 'webui.sqlite')));

export const REQUESTER_API_KEY = read('REQUESTER_API_KEY', '');
export const WORKER_SECRET = read('WORKER_SECRET', '');

export const PUBLIC_BASE_URL = read('PUBLIC_BASE_URL', '');

export function requireServerSecrets() {
  if (!REQUESTER_API_KEY) {
    throw new Error('REQUESTER_API_KEY is required');
  }
  if (!WORKER_SECRET) {
    throw new Error('WORKER_SECRET is required');
  }
}

export function ensureDataDirs() {
  for (const dir of [DATA_DIR, RESULTS_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}
