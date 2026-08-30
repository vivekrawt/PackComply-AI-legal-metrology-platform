import crypto from 'node:crypto';

// Sortable unique IDs: <prefix>_<timestamp36><random>
export function newId(prefix: string): string {
  const t = Date.now().toString(36).padStart(9, '0');
  const r = crypto.randomBytes(8).toString('hex');
  return `${prefix}_${t}${r}`;
}
