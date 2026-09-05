# PackComply AI — Architecture

## Stack decision (free tier only — runs fully locally, no paid services)

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node.js 22 + TypeScript | Widely adopted, strong typing, one language across API/workers/shared contracts |
| API | Express 4 (modular monolith) | Mature, simple, testable; PRD explicitly allows a modular monolith with scalable workers |
| Database | SQLite (better-sqlite3), SQL migrations | Zero-cost, zero-setup local relational DB; schema written in portable SQL so it maps to PostgreSQL for production; FTS5 gives full-text search without a separate search cluster |
| Object store | Local filesystem, content-addressed (`data/evidence/sha256/<hash>`) | Immutable-by-construction originals; interface (`ObjectStore`) swaps to S3-compatible storage in production |
| Jobs | DB-backed queue + in-process worker loop | Idempotent, retries, dead-letter status, visible progress; swaps to Redis/queue for scale without changing the job contract |
| Frontend | React 18 + Vite + TypeScript, PWA (manifest + service worker) | Responsive web/PWA per PRD; no UI framework lock-in; custom design-token CSS matching the PRD design direction |
| Reports | pdfkit (PDF), docx (DOCX), native CSV/JSON | Pure-JS, free, offline; behind a `ReportExporter` provider abstraction |
| AI/OCR | Provider interfaces + deterministic MOCK providers | PRD forbids sending evidence to unapproved public AI services; the app runs with clearly-labeled mock providers; real self-hosted providers (PaddleOCR sidecar, tesseract.js) plug in via the same interfaces |
| Auth | Local accounts (Node crypto scrypt), DB-backed httpOnly cookie sessions | Free, secure baseline; OIDC/SAML adapter is a documented boundary (IAM-01) |
| Tests | vitest + supertest | Fast, free |

Deliberately avoided: microservices, Redis, Elasticsearch, Postgres, cloud queues — all are production
swap targets documented per interface, not MVP dependencies (NFR-PORT-01, "no unnecessary microservices").

## Module layout (server/src)

```
core/        config, db (migrations/driver), errors, logger, crypto (hashing), ids, time
middleware/  auth session, permissions+scope, validation, rate limit, security headers, audit context, errors
modules/
  auth/        login/logout/session policy
  users/       user + role + scope administration, lifecycle
  audit/       append-only hash-chained audit log + query API
  inspections/ inspection CRUD, types, checklist, assignment, lineage, duplicates
  evidence/    upload, hash, immutability, metadata, calibration, signed retrieval, derivatives
  processing/  job queue, image-quality + OCR + extraction pipelines
  declarations/ merged declarations, normalization, corrections
  rules/       rule sets, versions, governance (draft→approved→published→retired), test packs, rollback
  evaluation/  deterministic engine, rule selection, outcome pinning, replay/simulation
  findings/    findings, dispositions, overrides, second-level approval
  cases/       notices, re-inspection links, closure, timeline
  reports/     report snapshot, versions, exporters (pdf/docx/csv/json/manifest), verification
  search/      FTS5 index + scoped repository search
  analytics/   dashboard aggregations
  models/      model registry
providers/   ImageQualityProvider, OCRProvider, LayoutProvider, DeclarationExtractionProvider,
             FontMeasurementProvider, MalwareScanner, ObjectStore  (+ mock implementations)
```

Every module = routes + service + repository. Legal evaluation lives **only** in `evaluation/` +
versioned rule config — never in UI components or route handlers.

## Key architectural rules

1. **Evidence immutability (VIS-01)** — originals stored content-addressed by SHA-256; the store refuses
   overwrites; derivatives are separate rows referencing the original hash + processing op. Evidence is
   served only via authenticated, scope-checked, short-lived signed URLs (`/api/v1/assets/:id/content?sig=…`).
   No public/predictable URLs.
2. **Version pinning (REG-01/16)** — an Evaluation row stores `rule_version_id`, `model_versions` (JSON of
   every provider version used), evidence hashes and event date. Finalization freezes a full JSON snapshot
   into `report_versions`. Nothing recomputes a finalized result; re-running creates new evaluation rows on
   a non-finalized inspection only.
3. **Five outcomes (REG-13)** — `passed | failed | needs_review | not_applicable | not_assessable` is a
   closed enum through engine → API → UI → report.
4. **Calibration gate (FNT-01)** — the font-size evaluator takes calibration as an explicit input; absent
   or invalid → `not_assessable` with reason `NO_VALID_SCALE`. Pixels are never converted to mm without a
   stored calibration record (method, value, uncertainty).
5. **Confidence ≠ legal status (EXT-07)** — separate fields end-to-end; UI renders them in separate visual
   channels (teal assistive vs legal status chips).
6. **AI proposes, officers decide** — finalization endpoint refuses if any material (high-severity or
   failed/needs-review) finding lacks an officer disposition (REV-03, review-safety metric).
7. **Segregation of duties (IAM-06)** — rule `approve`/`publish` reject the version author; finalized
   findings reject all mutation including by system administrators.
8. **Mock providers are labeled** — every provider result carries `provider`, `modelVersion`, and
   `isMock: true`; the UI shows a persistent "DEMO PROVIDER" banner on mock-derived data. Config
   (`PROVIDERS_*` env) selects implementations; no silent substitution.

## Background processing

`processing_jobs` table: `queued → processing → completed | failed(→retry with backoff, max N → dead_letter) | cancelled`.
Jobs carry `correlation_id`, `idempotency_key` (unique) — resubmission returns the existing job. Worker
loop runs in-process (configurable interval); results are upserted by natural key so retries never create
duplicate final records (NFR-RELIAB-01). Pipeline per evidence asset: quality → layout → OCR → extraction
→ declaration merge. Progress visible via `GET /processing/jobs`.

## AuthN/AuthZ

- Sessions: httpOnly, SameSite=Lax cookie, DB-backed, inactivity timeout + absolute lifetime, revocable,
  per-user concurrent limit. CSRF: custom-header requirement on mutations + SameSite.
- Permissions: role → permission matrix (config data mirroring PRD §04 capability table), checked
  server-side per route.
- Scope: every user carries `{orgId, state, district, office}`; repositories append scope predicates;
  search results and exports pass through the same filter (IAM-03, UAT-10). Assignment grants access to
  specific out-of-office cases where configured.

## Rule engine

Rule versions are rows of pure JSON config (see DATA_MODEL.md). The evaluator is a deterministic
interpreter over check primitives: `presence`, `format` (regex/normalizer-validated), `arithmetic`,
`comparison`, `chronology`, `cross_field`, `conflict`, `placement`, `calibrated_font_size`,
`listing_comparison`. Selection: jurisdiction/category/channel/import/package-type predicates + event
date within `[effective_from, effective_to)`. Overlays: category-routing table maps categories (medical
devices, pan masala, edible oils, …) to overlay rule sets and/or `specialist_review` flag; overlaid base
rules are excluded with an explanation (REG-12). Governance: draft → submitted → approved (independent
approver) → published (scheduled by effective date) → retired; every version immutable once published;
rollback = re-point active pointer with audit, historical evaluations untouched. Test packs are stored
fixtures (context + declarations + expected outcome) runnable against any version (regression + diff).

## Reporting

On finalize: build the 8-section report model (PRD §15) from pinned data, store as immutable
`report_versions` row + SHA-256 of canonical JSON. Exporters (PDF/DOCX/CSV/JSON/manifest) render from the
stored snapshot only — never from live data. Amendment creates version n+1 with reason; all versions
retained and hash-verifiable via `GET /reports/:id/verify`.

## Audit

Append-only `audit_events` with hash chain (`event_hash = sha256(prev_hash + canonical(event))`) for
tamper evidence; no UPDATE/DELETE path in code; verification endpoint recomputes the chain. Every request
gets a correlation ID (also returned in `X-Correlation-Id`).

## Offline / PWA (MOB-01/02)

Implemented: installable manifest, service worker app-shell caching, network-status indicator, and an
**encrypted offline draft store** (`web/src/offline.ts`): new-inspection drafts + queued evidence photos
are AES-GCM encrypted (WebCrypto, non-extractable CryptoKey persisted in IndexedDB) with per-draft sync
states (`local/uploading/synced/failed`), auto-sync on the `online` event, and idempotent upload — each
draft carries a client-generated `clientRef` that the server dedupes per creator, and evidence binaries
are content-addressed, so interrupted syncs resume without duplicates (UAT-11). Failures surface
explicitly in the Offline Drafts screen; nothing resolves silently. Scope: create-only drafts (offline
edits of existing server records — which would need revision-based conflict UI — remain designed, not
implemented). Threat model: the at-rest key is non-extractable but usable by same-origin script; device
security policy still applies (ASSUMPTIONS.md A15).

## Real OCR provider (default)

OCR defaults to **PaddleOCR with OpenCV/Pillow image preparation** (`PROVIDER_OCR=paddle`), running in
the Python sidecar in `ocr-service/` and reached from `src/providers/paddle.ts` over loopback. The AI
data boundary holds: the sidecar is part of the deployment, is stateless, writes nothing to disk, and
keeps no image after the response. Models are local, so it works offline once they are cached.

**Why a separate process.** PaddleOCR, OpenCV and Pillow are Python. The alternative — spawning an
interpreter per image — reloads the models on every call, several seconds each. In the sidecar they
load once and stay warm.

**Preparation, then recognition, in one call.** The sidecar returns the text *and* the prepared image
together, so the image stored as evidence is provably the one the recogniser read rather than a re-run
that might differ. `processEvidence` writes it to `evidence_derivatives` (operation `ocr_preprocess`)
with its own SHA-256 and the ordered list of operations applied; the officer's upload stays the
immutable evidence of record at its own address. Re-processing replaces the derivative, so a retry
never leaves two competing "what the model saw" images.

**Coordinates.** Preparation deskews and crops, so processed-image coordinates are not the officer's
photograph's. The service composes the affine transform of every geometric step and maps each box back
through its inverse, and boxes reach the pipeline normalized to [0..1] of the ORIGINAL image — verified
to about 1 px on a 6°-rotated capture. Nothing downstream (font measurement, overlays) needs to know
preparation happened.

**Languages.** Recognition models are per-script, so English and Devanagari are two passes
(`PADDLE_LANGS`), merged per box: the more confident reading wins, except that a reading actually
containing Devanagari beats a Latin model's transliteration of the same box.

Honest limits: JPEG/PNG/BMP/WebP only (HEIC/PDF need a rasterizer), unbenchmarked against the PRD
corpus, `isMock:false` recorded on every block. An unreachable sidecar **fails the job** — a configured
engine is never silently replaced by a different one.

`PROVIDER_OCR=tesseract` keeps the in-process tesseract.js (WASM, eng+hin, `src/providers/tesseract.ts`,
language data committed to `server/assets/tessdata`) for deployments that cannot run Python; it does no
preparation and produces no derivative. `PROVIDER_OCR=mock` gives deterministic runs (the test suite
pins it). Gated integration tests: `RUN_PADDLE_TESTS=1 npm test -- paddle.integration` (needs the
sidecar up), `RUN_TESSERACT_TESTS=1 npm test -- tesseract`.

## Guided camera capture (INS-05)

`web/src/components/CameraCapture.tsx` samples live `getUserMedia` frames into a 160-px offscreen canvas
a few times a second and computes three capture-assist signals — Laplacian variance (focus), fraction of
near-saturated pixels (glare), mean luminance (lighting) — rendering framing corners, a scale-reference
guide and specific recapture prompts. Guidance never blocks capture (the officer decides what to record),
is stored in the asset's device metadata, and is explicitly distinct from the server-side image-quality
assessment and from any legal conclusion.

## Security summary

Helmet security headers, strict input validation (zod) on every route, parameterized SQL only, upload
magic-byte + extension + size validation, MalwareScanner interface (no-op locally, wired at the boundary),
rate limiting (global + login-specific), scrypt password hashing, secrets via env (.env.example, never
committed), signed expiring asset URLs, audit of reads/downloads/exports on sensitive evidence, TLS
expected at the reverse-proxy layer in deployment.

## Non-functional approach

- PERF: async pipeline + timing middleware logs per-stage latency; `/api/v1/admin/metrics` exposes counters
  for measurement under pilot load. Targets are instrumented, not yet claimed.
- SEARCH: FTS5 indexed queries; timing recorded.
- AVAIL/DR: single-node MVP; container + volume backup documented; RPO/RTO targets are hosting decisions.
- OBS: structured JSON logs with correlation IDs; job/queue metrics.

## Deployment

`Dockerfile` (multi-stage: build web → serve from Node) + `docker-compose.yml` (app + volume). Local dev:
`npm run dev` (API, tsx watch) + `npm run dev` in web/ (Vite proxy). One-command setup in README.
