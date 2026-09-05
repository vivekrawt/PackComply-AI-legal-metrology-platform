// Starts the API server (:4000), the web dev server (:5173) and the PaddleOCR
// sidecar (:8100) together.
// Usage from the repo root: npm run dev
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnOcrService, SETUP_HINT } from './ocr.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(name, cwd, color) {
  const child = spawn('npm', ['run', 'dev'], { cwd: path.join(root, cwd), shell: true });
  return attach(name, child, color, true);
}

// Prefix and forward a child's output. `fatal` decides whether that child's
// death takes the whole dev stack down with it.
function attach(name, child, color, fatal = false) {
  if (!child) return null;
  const prefix = `\x1b[${color}m[${name}]\x1b[0m `;
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) out.write(prefix + line + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('error', (err) => process.stdout.write(`${prefix}${err.message}\n`));
  child.on('exit', (code) => {
    process.stdout.write(`${prefix}exited with code ${code}\n`);
    if (fatal) process.exit(code ?? 1);
  });
  return child;
}

const server = run('api :4000', 'server', '36');
const web = run('web :5173', 'web', '35');

// The OCR sidecar is Python and optional at dev time: a missing venv should not
// stop someone working on the web app. Its death does not take the stack down
// either — evidence processing then fails loudly on its own, which is the
// behaviour we want, rather than a silent downgrade to a different engine.
const ocr = attach('ocr :8100', spawnOcrService(), '33');
if (!ocr) {
  const prefix = '\x1b[33m[ocr :8100]\x1b[0m ';
  process.stdout.write(`${prefix}not started — PaddleOCR is unavailable.\n`);
  for (const line of SETUP_HINT.split('\n')) process.stdout.write(prefix + line + '\n');
}

process.on('SIGINT', () => { server.kill(); web.kill(); ocr?.kill(); process.exit(0); });
