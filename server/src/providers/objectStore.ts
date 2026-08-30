import fs from 'node:fs';
import path from 'node:path';
import { config } from '../core/config.js';
import { sha256Hex } from '../core/crypto.js';

// Content-addressed, write-once object store (VIS-01).
// Originals live at data/evidence/<aa>/<sha256>. The store REFUSES overwrites:
// identical content is a no-op (same address), different content can never
// collide with an existing key. Swap for an S3-compatible implementation via
// this same interface in production.
export interface ObjectStore {
  put(buf: Buffer): { sha256: string; storageKey: string };
  get(storageKey: string): Buffer;
  exists(storageKey: string): boolean;
}

export class FsObjectStore implements ObjectStore {
  constructor(private root: string = config.evidenceDir) {}

  put(buf: Buffer): { sha256: string; storageKey: string } {
    const hash = sha256Hex(buf);
    const dir = path.join(this.root, hash.slice(0, 2));
    const file = path.join(dir, hash);
    const storageKey = `${hash.slice(0, 2)}/${hash}`;
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(file)) {
      // 'wx' = fail if the file appears concurrently; originals are never overwritten.
      fs.writeFileSync(file, buf, { flag: 'wx' });
    }
    return { sha256: hash, storageKey };
  }

  get(storageKey: string): Buffer {
    return fs.readFileSync(path.join(this.root, storageKey));
  }

  exists(storageKey: string): boolean {
    return fs.existsSync(path.join(this.root, storageKey));
  }
}

export const objectStore = new FsObjectStore();
