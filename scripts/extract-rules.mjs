#!/usr/bin/env node
// Extract the statutory corpus the compliance judge reads.
//
// Every PDF in the repository root whose name looks like a rules document is
// converted to plain text under server/assets/rules/. That directory is what the
// judge loads (config.rulesDir); its concatenated SHA-256 is recorded on every
// verdict, so re-running this after adding an amendment PDF is what makes the new
// law visible to the model.
//
// Requires `pdftotext` (poppler-utils) on PATH. On Windows it ships with Git for
// Windows' MSYS environment; otherwise install poppler.
//
//   node scripts/extract-rules.mjs

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'server', 'assets', 'rules');

// The PRD is a product document, not law — it must never reach the judge as if
// it were statutory text.
const EXCLUDE = /^PackComply_AI_PRD/i;

function slugify(name) {
  const base = name.replace(/\.pdf$/i, '');
  if (/legal metrology/i.test(base) && /2011/.test(base)) return 'lmpc-2011';
  return base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

// `pdftotext -v` prints the version and then exits non-zero because no input file
// was given, so a non-zero status proves nothing. Only ENOENT means "not installed".
try {
  execFileSync('pdftotext', ['-v'], { stdio: 'ignore' });
} catch (err) {
  if (err.code === 'ENOENT') {
    console.error('pdftotext not found on PATH. Install poppler-utils, then re-run.');
    process.exit(1);
  }
}

const pdfs = fs.readdirSync(root).filter((f) => f.toLowerCase().endsWith('.pdf') && !EXCLUDE.test(f));
if (pdfs.length === 0) {
  console.error(`No rules PDFs found in ${root}.`);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
for (const pdf of pdfs) {
  const out = path.join(outDir, `${slugify(pdf)}.txt`);
  // -layout preserves the column structure of the schedules and the Rule 7 size
  // table; without it those tables collapse into unreadable single lines.
  execFileSync('pdftotext', ['-layout', '-enc', 'UTF-8', path.join(root, pdf), out]);
  const bytes = fs.statSync(out).size;
  console.log(`${pdf}\n  -> ${path.relative(root, out)} (${bytes.toLocaleString()} bytes)`);
}
console.log(`\n${pdfs.length} document(s) extracted into ${path.relative(root, outDir)}.`);
