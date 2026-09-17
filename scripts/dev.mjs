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
//
// It is kept alive, though. It had been spawned once and left: when the Python
// process died mid-scan nothing restarted it, so every scan after that silently
// lost OCR on the faces it was reading, and the officer was shown a confident
// verdict drawn from the two faces that got through before the crash. A sidecar
// that comes back on its own turns that into a pause instead of a hole.
const OCR_PREFIX = '\x1b[33m[ocr :8100]\x1b[0m ';
const ocrSay = (line) => process.stdout.write(OCR_PREFIX + line + '\n');

// Growing waits, so a sidecar that cannot start at all (a broken venv, a port
// already taken) says so a few times and then stops filling the terminal.
const OCR_RESTART_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
let ocrRestarts = 0;
let ocrStopping = false;
let ocr = null;

function superviseOcr() {
  ocr = spawnOcrService();
  if (!ocr) {
    ocrSay('not started - PaddleOCR is unavailable.');
    for (const line of SETUP_HINT.split('\n')) ocrSay(line);
    return;
  }
  attach('ocr :8100', ocr, '33');

  // A start that lasts resets the ladder, so a crash tomorrow does not have to
  // wait out the thirty seconds that yesterday's failures earned.
  const settle = setTimeout(() => { ocrRestarts = 0; }, 60_000);
  settle.unref?.();

  ocr.on('exit', () => {
    clearTimeout(settle);
    if (ocrStopping) return;
    if (ocrRestarts >= OCR_RESTART_DELAYS_MS.length) {
      ocrSay('gave up restarting. Run `npm run ocr` on its own to see why it will not stay up.');
      return;
    }
    const wait = OCR_RESTART_DELAYS_MS[ocrRestarts++];
    ocrSay(`died - restarting in ${wait / 1000}s (attempt ${ocrRestarts} of ${OCR_RESTART_DELAYS_MS.length}).`);
    ocrSay('Scans waiting on it retry with backoff, so those faces are delayed rather than lost.');
    setTimeout(superviseOcr, wait).unref?.();
  });
}

superviseOcr();

process.on('SIGINT', () => {
  ocrStopping = true;
  server.kill(); web.kill(); ocr?.kill();
  process.exit(0);
});
