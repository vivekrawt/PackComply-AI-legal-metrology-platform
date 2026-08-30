import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate test data (DB + evidence store) from the dev environment.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'packcomply-test-'));
process.env.PACKCOMPLY_DATA_DIR = dir;
process.env.PACKCOMPLY_DB_PATH = path.join(dir, 'test.db');
process.env.PACKCOMPLY_EVIDENCE_DIR = path.join(dir, 'evidence');
process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_MAX = '10000';
process.env.RATE_LIMIT_LOGIN_MAX = '1000';
// Pin deterministic mock providers regardless of any local .env (the gated
// tesseract integration test constructs its provider directly).
process.env.PROVIDER_QUALITY = 'mock';
process.env.PROVIDER_OCR = 'mock';
process.env.PROVIDER_LAYOUT = 'mock';
process.env.PROVIDER_EXTRACTION = 'mock';
process.env.PROVIDER_FONT = 'mock';
process.env.PROVIDER_MALWARE = 'noop';
