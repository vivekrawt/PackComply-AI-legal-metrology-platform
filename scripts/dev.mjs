// Starts the API server (:4000) and the web dev server (:5173) together.
// Usage from the repo root: npm run dev
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(name, cwd, color) {
  const child = spawn('npm', ['run', 'dev'], { cwd: path.join(root, cwd), shell: true });
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
  child.on('exit', (code) => {
    process.stdout.write(`${prefix}exited with code ${code}\n`);
    process.exit(code ?? 1);
  });
  return child;
}

const server = run('api :4000', 'server', '36');
const web = run('web :5173', 'web', '35');

process.on('SIGINT', () => { server.kill(); web.kill(); process.exit(0); });
