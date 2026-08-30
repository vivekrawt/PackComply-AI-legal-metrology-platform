# PackComply AI

Automated Legal Metrology compliance inspection platform (MVP vertical slice).
**Decision support only** — AI proposes, deterministic versioned rules evaluate, authorized officers decide.
Built entirely on free/open-source components; runs fully locally with **no paid services or external AI APIs**.

> ⚠ **OCR is real** — a self-hosted tesseract.js adapter (English + Hindi) runs in-process by default and
> works offline. Image-quality, layout, declaration-classification and font-measurement are still
> deterministic **MOCK/DEMO** providers, clearly labeled everywhere they surface. All seeded legal rule
> parameters are placeholders flagged **REQUIRES LEGAL APPROVAL**, and all seeded products/labels are
> synthetic and fictional. Nothing here is a real enforcement decision or certified statutory logic.

## Stack

Node.js 22 + TypeScript + Express (modular monolith) · SQLite (better-sqlite3, FTS5 search) ·
content-addressed filesystem evidence store · DB-backed async job queue · React 18 + Vite PWA ·
pdfkit/docx report exporters · vitest tests. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quick start

Prereqs: Node.js ≥ 20 (22 recommended), npm.

```bash
# Install once
cd server && npm install && cd ../web && npm install && cd ..

# Start BOTH the API (:4000) and web app (:5173) from the repo root:
npm run dev                                    # open http://localhost:5173

# (Or in two terminals: `cd server && npm run dev` and `cd web && npm run dev`.)
```

> Sign-in shows “request failed” / 502? The API server on port 4000 isn’t running —
> the web app only proxies to it. Start both with `npm run dev` from the repo root.

Or a single production-style container:

```bash
docker compose up --build                       # → http://localhost:4000 (serves API + built PWA)
```

Optional: `cp server/.env.example server/.env` and adjust.

## Demo accounts (password: `PackComply#2026`)

| E-mail | Role |
|---|---|
| inspector@demo.gov.example | Field inspector (Maharashtra/Pune scope) |
| reviewer@demo.gov.example | Review / senior officer (Maharashtra) |
| ruleadmin@demo.gov.example / ruleadmin2@demo.gov.example | Legal rule administrators (maker + checker) |
| analyst@demo.gov.example | Compliance analyst |
| sysadmin@demo.gov.example | System administrator (cannot alter findings) |
| auditor@demo.gov.example | Auditor (read-only) |
| inspector.ka@demo.gov.example | Inspector in Karnataka (scope-isolation demo) |

## Try the end-to-end flow

Sign in as the inspector → **New Inspection** (pick a category; `pan_masala`/`medical_devices`/`edible_oil`
trigger overlay routing) → upload PNG/JPEG/PDF evidence with face labels → optionally record a
**calibration** (without one, font-size checks return **Not Assessable**) → **Run evidence processing** →
open the **Analysis workbench** → review/correct declarations → **Apply versioned rules** → disposition
each material finding (overrides need reasons; high-severity overrides need reviewer approval) →
**Finalize** → open the **Report** (PDF/DOCX/CSV/JSON/manifest export + hash verification) →
find it again via **Repository / Search**. Seeded inspections (one finalized, one open, one e-commerce)
are ready immediately.

## Real OCR (self-hosted, free, default)

Real OCR runs out of the box: tesseract.js (WASM) in-process, English + Hindi, with language data
committed to `server/assets/tessdata` so a fresh clone works **offline** and evidence never leaves the
server. Upload or capture real JPEG/PNG label photos and you get real recognition with real bounding
boxes. Limits: JPEG/PNG/BMP only (HEIC/PDF need a rasterizer) and it is not yet benchmarked against the
PRD acceptance corpus. Set `PROVIDER_OCR=mock` for deterministic runs; verify the adapter with
`cd server && RUN_TESSERACT_TESTS=1 npm test -- tesseract`.

The seeded demo evidence is real, legible artwork of clearly fictional products
(`server/assets/demo-labels/`, regenerate with `node scripts/generate-demo-labels.mjs`). Two labels are
deliberately non-compliant, so the seeded findings are produced by genuinely reading the images.

## Guided camera capture

**Capture with guided camera** on an inspection opens a live preview that samples video frames in the
browser and reports focus, glare and lighting as you aim, with framing corners and a scale-reference
guide. Guidance never blocks capture — it advises, the officer decides — and is recorded in the asset's
metadata. It is separate from the server-side quality assessment and is never a legal judgement.
(Camera access needs `localhost` or HTTPS.)

## Offline field drafts (encrypted)

While offline (or if the network drops mid-save), **New Inspection** saves an AES-GCM-encrypted draft —
with queued evidence photos — to the browser's IndexedDB (non-extractable WebCrypto key). The
**Offline drafts** screen shows per-draft sync state (local / uploading / synced / failed); sync runs
automatically when connectivity returns and is idempotent (client reference deduped server-side), so
interrupted uploads resume without duplicates. Failures stay visible — nothing resolves silently.

## Commands

```bash
cd server
npm run dev         # API with reload
npm run seed        # seed database (no-op if already seeded); delete server/data to reset
npm test            # 40 tests: engine unit tests (incl. the critical calibration pair), API/workflow/UAT tests
npm run typecheck

cd web
npm run dev / build
```

## Documentation

- [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) — full PRD requirement catalogue with honest implementation status
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/DATA_MODEL.md](docs/DATA_MODEL.md) · [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md)
- [docs/API.md](docs/API.md) — REST API reference
- [docs/ASSUMPTIONS.md](docs/ASSUMPTIONS.md) — every assumption made where the PRD was open

## Key guarantees implemented

- Evidence originals are write-once, SHA-256-hashed, integrity-checked on every read; no public URLs.
- Legal rules are **versioned data** with effective dates, dual-approval publication, regression packs and rollback.
- Exactly five outcomes: Passed / Failed / Needs Review / Not Applicable / **Not Assessable** — never a forced pass/fail.
- Physical font size is evaluated **only** with a valid calibration; pixels are never converted to mm otherwise (tested).
- Finalized findings/reports are immutable; amendments create retained new versions; every evaluation is pinned to rule + model + engine versions.
- Append-only, hash-chained audit trail with a verification endpoint.
- Server-side RBAC + jurisdictional scoping on every route, including search and exports.
