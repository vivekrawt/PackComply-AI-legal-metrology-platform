import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../core/config.js';
import { sha256Hex } from '../../core/crypto.js';
import { logger } from '../../core/logger.js';
import type { RulesCorpus } from '../../providers/types.js';

// The statutory text the compliance judge reads. Every .txt/.md file under
// config.rulesDir is concatenated in filename order; assets/rules/lmpc-2011.txt
// is the Legal Metrology (Packaged Commodities) Rules, 2011 extracted verbatim
// from the source PDF (see scripts/extract-rules.mjs).
//
// The corpus is hashed and the hash is stored on every verdict, so a report can
// always name the exact text the model was shown. Dropping a further amendment
// PDF's text into the directory changes that hash — which is the point: two
// verdicts produced against different law are never silently comparable.

let cached: { corpus: RulesCorpus; mtimeKey: string } | null = null;

function directoryFingerprint(dir: string, files: string[]): string {
  return files
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return `${f}:${st.size}:${st.mtimeMs}`;
    })
    .join('|');
}

export function loadRulesCorpus(): RulesCorpus {
  const dir = config.rulesDir;
  if (!fs.existsSync(dir)) {
    return { text: '', sha256: '', sources: [], chars: 0 };
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.txt') || f.endsWith('.md'))
    .sort();

  // Cheap staleness check so an operator can drop in an amendment without a restart.
  const fingerprint = directoryFingerprint(dir, files);
  if (cached && cached.mtimeKey === fingerprint) return cached.corpus;

  const parts: string[] = [];
  for (const f of files) {
    const body = fs.readFileSync(path.join(dir, f), 'utf-8').trim();
    if (!body) continue;
    parts.push(`===== SOURCE DOCUMENT: ${f} =====\n\n${body}`);
  }
  const text = parts.join('\n\n');
  const corpus: RulesCorpus = {
    text,
    sha256: text ? sha256Hex(text) : '',
    sources: files,
    chars: text.length,
  };
  cached = { corpus, mtimeKey: fingerprint };
  logger.info('rules corpus loaded', {
    sources: files, chars: corpus.chars, sha256: corpus.sha256.slice(0, 12),
  });
  return corpus;
}

export function rulesCorpusStatus() {
  const c = loadRulesCorpus();
  return {
    available: c.chars > 0,
    sources: c.sources,
    chars: c.chars,
    sha256: c.sha256,
    directory: config.rulesDir,
  };
}
