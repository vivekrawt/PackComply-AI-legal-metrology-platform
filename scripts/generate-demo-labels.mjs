// ============================================================================
// Dev-time asset generator — creates the SYNTHETIC demo package-label images
// used by the seed data. Run once; the resulting PNGs are committed to
// server/assets/demo-labels/ so no developer needs a browser to seed.
//
//   node scripts/generate-demo-labels.mjs
//
// Labels are deliberately FICTIONAL (invented brands, .example domains, a
// "SYNTHETIC DEMO LABEL" footer) and are rendered as real, legible artwork so
// that real OCR genuinely reads them end-to-end.
//
// Requires a Chromium-family browser for rendering (Edge/Chrome). Windows and
// Linux paths are probed; override with BROWSER=/path/to/chrome.
// ============================================================================
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'server', 'assets', 'demo-labels');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'packcomply-labels-'));

const BROWSERS = [
  process.env.BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);
const browser = BROWSERS.find((b) => fs.existsSync(b));
if (!browser) {
  console.error('No Chromium-family browser found. Set BROWSER=/path/to/chrome');
  process.exit(1);
}

// Wide enough that every declaration stays on ONE rendered line — a wrapped
// declaration would split into two OCR blocks and lose its value/unit pairing.
const W = 1100, H = 1150;

// Each line becomes one OCR line. Declaration values that must be parsed as a
// unit (e.g. price + tax wording) are kept on a single line deliberately.
// Brand bands use dark text on a light tint: white-on-colour reverses poorly
// for OCR and produced garbage reads that the extractor then mistook for the
// product name.
const LABELS = [
  {
    file: 'noodles-front.png', accent: '#1d5bbf', tint: '#e3ecfa', brand: 'DEMO BRAND',
    lines: [
      { t: 'Instant Noodles', c: 'title' },
      { t: 'Masala Flavour', c: 'sub' },
      { t: 'Net Quantity: 500 g', c: 'decl' },
      { t: 'नेट मात्रा: 500 ग्राम', c: 'decl hi' },
      { t: 'M.R.P. Rs. 99.00 (Inclusive of all taxes)', c: 'decl' },
    ],
  },
  {
    file: 'noodles-back.png', accent: '#1d5bbf', tint: '#e3ecfa', brand: 'DEMO BRAND', small: true,
    lines: [
      { t: 'Mfd. by: Demo Foods Pvt Ltd, Pune 411001', c: 'decl' },
      { t: 'Date of Manufacture: 03/2026', c: 'decl' },
      { t: 'Best Before: 12 months from manufacture', c: 'decl' },
      { t: 'Consumer Care: care@demofoods.example, 1800 000 1234', c: 'decl' },
      { t: 'Marketed in India', c: 'decl' },
      { t: 'Net Qty: 500 g', c: 'decl' },
    ],
  },
  {
    // Non-compliant demo: retail price lacks the tax-inclusive wording.
    file: 'chips-front.png', accent: '#0e7f74', tint: '#e2f4f1', brand: 'SAMPLE SNACKS',
    lines: [
      { t: 'Potato Chips', c: 'title' },
      { t: 'Classic Salted', c: 'sub' },
      { t: 'Net Quantity: 90 g', c: 'decl' },
      { t: 'नेट मात्रा: 90 ग्राम', c: 'decl hi' },
      { t: 'M.R.P. Rs. 20.00', c: 'decl' },
    ],
  },
  {
    // Non-compliant demo: no consumer-care details declared.
    file: 'chips-back.png', accent: '#0e7f74', tint: '#e2f4f1', brand: 'SAMPLE SNACKS', small: true,
    lines: [
      { t: 'Packed by: Sample Snacks Foods, Nashik 422001', c: 'decl' },
      { t: 'Date of Packing: 05/2026', c: 'decl' },
      { t: 'Best Before: 6 months from packing', c: 'decl' },
      { t: 'Net Qty: 90 g', c: 'decl' },
    ],
  },
  {
    file: 'wafers-front.png', accent: '#8a5800', tint: '#fdf1dc', brand: 'IMPORTO',
    lines: [
      { t: 'Chocolate Wafers', c: 'title' },
      { t: 'Hazelnut Cream', c: 'sub' },
      { t: 'Net Quantity: 150 g', c: 'decl' },
      { t: 'M.R.P. Rs. 249.00 (Inclusive of all taxes)', c: 'decl' },
    ],
  },
  {
    file: 'wafers-back.png', accent: '#8a5800', tint: '#fdf1dc', brand: 'IMPORTO', small: true,
    lines: [
      { t: 'Imported by: Importo India Pvt Ltd, Gurugram 122002', c: 'decl' },
      { t: 'Country of Origin: Malaysia', c: 'decl' },
      { t: 'Date of Import: 04/2026', c: 'decl' },
      { t: 'Best Before: 18 months from packing', c: 'decl' },
      { t: 'Consumer Care: care@importo.example, 1800 111 2222', c: 'decl' },
      { t: 'Net Qty: 150 g', c: 'decl' },
    ],
  },
];

function html(label) {
  const declSize = label.small ? 34 : 40;
  return `<!doctype html><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { width:${W}px; height:${H}px; background:#fff; font-family:"Arial","Segoe UI",sans-serif; color:#000; }
  .pack { width:100%; height:100%; border:6px solid ${label.accent}; padding:48px 44px; display:flex; flex-direction:column; }
  .band { background:${label.tint}; color:${label.accent}; font-size:46px; font-weight:800; letter-spacing:3px;
          padding:20px 28px; text-align:center; margin-bottom:44px; border:3px solid ${label.accent}; }
  .title { font-size:62px; font-weight:800; margin-bottom:10px; }
  .sub { font-size:38px; color:#333; margin-bottom:44px; }
  .decl { font-size:${declSize}px; font-weight:600; line-height:1.55; margin-bottom:22px; white-space:nowrap; }
  .hi { font-family:"Nirmala UI","Noto Sans Devanagari",sans-serif; }
  .foot { margin-top:auto; font-size:22px; color:#888; letter-spacing:1px; border-top:2px solid #ddd; padding-top:16px; }
</style><div class="pack">
  <div class="band">${label.brand}</div>
  ${label.lines.map((l) => `<div class="${l.c}">${l.t}</div>`).join('\n  ')}
  <div class="foot">SYNTHETIC DEMO LABEL — NOT FOR ENFORCEMENT USE</div>
</div>`;
}

fs.mkdirSync(outDir, { recursive: true });
for (const label of LABELS) {
  const htmlPath = path.join(tmpDir, label.file.replace('.png', '.html'));
  fs.writeFileSync(htmlPath, html(label), 'utf-8');
  const outPath = path.join(outDir, label.file);
  execFileSync(browser, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    `--window-size=${W},${H}`, `--screenshot=${outPath}`,
    '--virtual-time-budget=3000',
    'file:///' + htmlPath.replace(/\\/g, '/'),
  ], { stdio: 'ignore' });
  console.log(`generated ${label.file} (${(fs.statSync(outPath).size / 1024).toFixed(0)} KB)`);
}
console.log(`\n${LABELS.length} synthetic demo labels written to server/assets/demo-labels/`);
