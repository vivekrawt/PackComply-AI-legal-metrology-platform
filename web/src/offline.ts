// Encrypted offline draft store (MOB-01/02, NFR-OFFLINE-01).
//
// Drafts and queued evidence photos are encrypted with AES-GCM (WebCrypto)
// before touching IndexedDB. The key is a NON-EXTRACTABLE CryptoKey stored in
// IndexedDB: its raw material is never exposed to JavaScript, so offline data
// is opaque to casual inspection of the browser profile. Threat model note:
// script running on this origin can still USE the key — this protects data at
// rest, it is not a substitute for device security policy (documented in
// docs/ASSUMPTIONS.md A15).
//
// Sync is idempotent: each draft carries a client-generated `localId` sent as
// `clientRef`; the server returns the existing inspection on retry, so an
// interrupted sync can safely resume without duplicates (UAT-11). Failures are
// surfaced explicitly — never silently resolved.

const DB_NAME = 'packcomply-offline';
const DB_VERSION = 1;

export type SyncState = 'local' | 'pending' | 'uploading' | 'synced' | 'failed';

export interface DraftPayload {
  type: string;
  eventDate: string;
  location?: string;
  sellerName?: string;
  notes?: string;
  product?: Record<string, string>;
}

export interface OfflineDraft {
  localId: string;
  payload: DraftPayload;
  createdAt: string;
  syncState: SyncState;
  error?: string;
  serverId?: string;
  evidenceCount: number;
}

interface DraftRecord { localId: string; iv: ArrayBuffer; cipher: ArrayBuffer; createdAt: string; syncState: SyncState; error?: string; serverId?: string }
interface EvidenceRecord { id: string; localId: string; faceLabel: string; name: string; mime: string; iv: ArrayBuffer; cipher: ArrayBuffer }

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('keys')) db.createObjectStore('keys');
      if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts', { keyPath: 'localId' });
      if (!db.objectStoreNames.contains('evidence')) {
        db.createObjectStore('evidence', { keyPath: 'id' }).createIndex('byDraft', 'localId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(db: IDBDatabase, store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const r = fn(t.objectStore(store));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function getKey(): Promise<CryptoKey> {
  const db = await openDb();
  const existing = await tx<CryptoKey | undefined>(db, 'keys', 'readonly', (s) => s.get('draft-key') as IDBRequest<CryptoKey | undefined>);
  if (existing) return existing;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false /* non-extractable */, ['encrypt', 'decrypt']);
  await tx(db, 'keys', 'readwrite', (s) => s.put(key, 'draft-key'));
  return key;
}

async function encrypt(key: CryptoKey, data: ArrayBuffer): Promise<{ iv: ArrayBuffer; cipher: ArrayBuffer }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  return { iv: iv.buffer, cipher };
}
async function decrypt(key: CryptoKey, iv: ArrayBuffer, cipher: ArrayBuffer): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv) }, key, cipher);
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function saveDraft(payload: DraftPayload): Promise<string> {
  const key = await getKey();
  const localId = `local_${Date.now().toString(36)}_${crypto.getRandomValues(new Uint32Array(2)).join('')}`;
  const { iv, cipher } = await encrypt(key, enc.encode(JSON.stringify(payload)).buffer as ArrayBuffer);
  const db = await openDb();
  const rec: DraftRecord = { localId, iv, cipher, createdAt: new Date().toISOString(), syncState: 'local' };
  await tx(db, 'drafts', 'readwrite', (s) => s.put(rec));
  return localId;
}

export async function addDraftEvidence(localId: string, file: File, faceLabel: string): Promise<void> {
  const key = await getKey();
  const { iv, cipher } = await encrypt(key, await file.arrayBuffer());
  const db = await openDb();
  const rec: EvidenceRecord = {
    id: `${localId}_ev_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6)}`,
    localId, faceLabel, name: file.name, mime: file.type, iv, cipher,
  };
  await tx(db, 'evidence', 'readwrite', (s) => s.put(rec));
}

async function draftEvidence(db: IDBDatabase, localId: string): Promise<EvidenceRecord[]> {
  return new Promise((resolve, reject) => {
    const r = db.transaction('evidence', 'readonly').objectStore('evidence').index('byDraft').getAll(localId);
    r.onsuccess = () => resolve(r.result as EvidenceRecord[]);
    r.onerror = () => reject(r.error);
  });
}

export async function listDrafts(): Promise<OfflineDraft[]> {
  const db = await openDb();
  const key = await getKey();
  const recs = await tx<DraftRecord[]>(db, 'drafts', 'readonly', (s) => s.getAll() as IDBRequest<DraftRecord[]>);
  const out: OfflineDraft[] = [];
  for (const r of recs) {
    let payload: DraftPayload;
    try {
      payload = JSON.parse(dec.decode(await decrypt(key, r.iv, r.cipher)));
    } catch {
      payload = { type: 'unknown', eventDate: '', location: '⚠ cannot decrypt (key mismatch)' };
    }
    out.push({
      localId: r.localId, payload, createdAt: r.createdAt, syncState: r.syncState,
      error: r.error, serverId: r.serverId,
      evidenceCount: (await draftEvidence(db, r.localId)).length,
    });
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function deleteDraft(localId: string): Promise<void> {
  const db = await openDb();
  await tx(db, 'drafts', 'readwrite', (s) => s.delete(localId));
  const evs = await draftEvidence(db, localId);
  for (const e of evs) await tx(db, 'evidence', 'readwrite', (s) => s.delete(e.id));
}

async function setDraftState(localId: string, patch: Partial<DraftRecord>): Promise<void> {
  const db = await openDb();
  const rec = await tx<DraftRecord | undefined>(db, 'drafts', 'readonly', (s) => s.get(localId) as IDBRequest<DraftRecord | undefined>);
  if (!rec) return;
  await tx(db, 'drafts', 'readwrite', (s) => s.put({ ...rec, ...patch }));
}

export function pendingCount(): Promise<number> {
  return listDrafts().then((d) => d.filter((x) => x.syncState !== 'synced').length).catch(() => 0);
}

let syncing = false;

// Sync all local drafts to the server. Safe to call repeatedly; duplicates are
// prevented server-side via clientRef. Returns per-draft outcomes.
export async function syncDrafts(): Promise<{ synced: number; failed: number }> {
  if (syncing || !navigator.onLine) return { synced: 0, failed: 0 };
  syncing = true;
  let synced = 0, failed = 0;
  try {
    const key = await getKey();
    const db = await openDb();
    for (const draft of await listDrafts()) {
      if (draft.syncState === 'synced') continue;
      await setDraftState(draft.localId, { syncState: 'uploading', error: undefined });
      try {
        const res = await fetch('/api/v1/inspections', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'packcomply' },
          body: JSON.stringify({ ...draft.payload, clientRef: draft.localId }),
        });
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error?.message ?? `HTTP ${res.status}`);
        const inspection = await res.json();

        for (const ev of await draftEvidence(db, draft.localId)) {
          const bytes = await decrypt(key, ev.iv, ev.cipher);
          const form = new FormData();
          form.append('files', new File([bytes], ev.name, { type: ev.mime }));
          form.append('faceLabel', ev.faceLabel);
          form.append('source', 'camera');
          const up = await fetch(`/api/v1/inspections/${inspection.id}/evidence`, {
            method: 'POST', credentials: 'same-origin',
            headers: { 'X-Requested-With': 'packcomply' }, body: form,
          });
          if (!up.ok) throw new Error(`Evidence upload failed (${(await up.json().catch(() => null))?.error?.message ?? up.status})`);
          // Delete each item immediately after its successful upload so a
          // resumed sync only sends what is still pending (binaries are also
          // content-addressed server-side, so re-sent bytes never duplicate).
          await tx(db, 'evidence', 'readwrite', (s) => s.delete(ev.id));
        }
        await setDraftState(draft.localId, { syncState: 'synced', serverId: inspection.id });
        synced++;
      } catch (err) {
        await setDraftState(draft.localId, { syncState: 'failed', error: err instanceof Error ? err.message : String(err) });
        failed++;
      }
    }
  } finally {
    syncing = false;
  }
  return { synced, failed };
}
