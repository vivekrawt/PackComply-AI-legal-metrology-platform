// Starts the PaddleOCR sidecar (ocr-service/) on :8100.
// Usage from the repo root: npm run ocr
//
// Prefers the project venv (.venv) because PaddleOCR pins numpy 1.24, which
// conflicts with what a general-purpose Python environment usually has.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The interpreter to run the sidecar with, or null when nothing usable is installed. */
export function resolvePython() {
  const candidates = [
    path.join(root, '.venv', 'Scripts', 'python.exe'), // Windows venv
    path.join(root, '.venv', 'bin', 'python'), // POSIX venv
  ];
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  return null;
}

export const SETUP_HINT = [
  'The OCR service needs its Python environment. From the repo root:',
  '  python -m venv .venv',
  process.platform === 'win32'
    ? '  .venv\\Scripts\\python -m pip install -r ocr-service/requirements.txt'
    : '  .venv/bin/python -m pip install -r ocr-service/requirements.txt',
  'Or set PROVIDER_OCR=tesseract in server/.env to use the in-process engine instead.',
].join('\n');

export function spawnOcrService({ port = process.env.PADDLE_PORT ?? '8100', reload = false } = {}) {
  const python = resolvePython();
  if (!python) return null;
  const args = ['-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', String(port)];
  if (reload) args.push('--reload');
  return spawn(python, args, { cwd: path.join(root, 'ocr-service'), shell: false });
}

// Direct invocation: run it in the foreground and mirror its output.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('ocr.mjs')) {
  const child = spawnOcrService({ reload: process.argv.includes('--reload') });
  if (!child) {
    console.error(SETUP_HINT);
    process.exit(1);
  }
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.on('exit', (code) => process.exit(code ?? 1));
  process.on('SIGINT', () => { child.kill(); process.exit(0); });
}
