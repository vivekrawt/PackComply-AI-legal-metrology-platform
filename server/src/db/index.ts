import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config, ensureDirs } from '../core/config.js';
import { migrations } from './migrations.js';
import { logger } from '../core/logger.js';

export type DB = Database.Database;

let db: DB | null = null;

export function getDb(): DB {
  if (!db) db = openDb(config.dbPath);
  return db;
}

export function openDb(dbPath: string): DB {
  if (dbPath !== ':memory:') {
    ensureDirs();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const d = new Database(dbPath);
  d.pragma('journal_mode = WAL');
  d.pragma('foreign_keys = ON');
  migrate(d);
  return d;
}

// Test helper: fresh in-memory DB.
export function openTestDb(): DB {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  migrate(d);
  return d;
}

export function setDb(d: DB) {
  db = d;
}

function migrate(d: DB) {
  d.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const applied = new Set(
    (d.prepare('SELECT id FROM schema_migrations').all() as { id: string }[]).map((r) => r.id),
  );
  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    d.transaction(() => {
      d.exec(m.sql);
      d.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(m.id, new Date().toISOString());
    })();
    logger.info('migration applied', { id: m.id });
  }
}

export const now = () => new Date().toISOString();
