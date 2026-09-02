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

## Roles

Three roles, enforced server-side on every route from a single matrix
(`server/src/modules/auth/permissions.ts`). The web UI renders navigation and buttons from the
permission list the server returns with `/auth/me`, so it can never offer an action the API refuses.

| Role | What it is for | Can | Cannot |
|---|---|---|---|
| **user** | Does the work — the field officer using the product | Create inspections, capture/upload evidence, run processing, correct declarations, run the compliance check, disposition findings, export reports | Approve overrides, amend a signed report, issue notices, read the audit log, author rules, administer users, **delete anything** |
| **admin** | Reviews the work | Read all casework in the organization, disposition findings, approve second-level overrides, finalize and amend reports, issue notices, order re-inspections, read the audit log | Create inspections, upload evidence, edit declarations, administer users or configuration, **delete anything** |
| **super_admin** | Full write **and delete** | Everything above, plus rule drafting/approval/publication, user administration, system configuration, and deletion of inspections, evidence, unpublished rule versions and accounts | — (holds every permission by construction) |

Two deliberate consequences:

- **Segregation of duties.** `admin` cannot create or alter the record it signs off, so "who did the work"
  and "who approved it" are always different people. `user` cannot approve its own high-severity override —
  the second-level approval must come from an `admin` or `super_admin`.
- **Deletion is soft and attributed.** Every delete demands a reason, is written to the tamper-evident audit
  log, and keeps the row (and its evidence hashes) so a previously issued report still verifies. Deleted
  inspections appear in **Deleted Records** and can be restored. Deleting a *finalized* inspection requires an
  explicit acknowledgement; a *published* rule version cannot be deleted at all (retire or roll it back).
  Deleting a user offboards and anonymises the account rather than dropping the row, because the audit chain
  references that officer.

Finalization by `user` is policy-driven: set the `finalization_policy` config item's `userCanFinalize` to
`false` to force every report through an `admin` reviewer.

## Demo accounts (password: `PackComply#2026`)

| E-mail | Role |
|---|---|
| user@demo.gov.example | **user** — field officer (Maharashtra/Pune scope) |
| admin@demo.gov.example | **admin** — reviewer (organization-wide) |
| superadmin@demo.gov.example | **super_admin** — full write and delete |
| superadmin2@demo.gov.example | **super_admin** — second approver (rule maker-checker demo) |
| user.ka@demo.gov.example | **user** in Karnataka (scope-isolation demo) |

## Field-officer flow (the `user` role)

```
Upload product images        front · back · top · bottom · left · right   (+ closeup / listing)
        │                    exact duplicates are refused at upload by SHA-256
        ▼
Image quality check          blur · too dark · label visible · orientation · glare ·
        │                    occlusion · edge clipping · face completeness
        │                    → per-image recapture guidance; never a legal judgement
        ▼
Product image analysis       computer vision (layout regions) ─┐
        │                    OCR (tesseract, en+hi) → text ────┘
        ▼
Structured product data      declarations, normalized + officer-correctable
        ▼
Rule engine                  versioned rules, pinned by effective date
        ▼
Findings                     passed · failed · needs review · not assessable · not applicable
        ▼
Compliance report            overall status + outcome counts · failed rules with citations ·
                             evidence images and extracted text · SHA-256 verification
```

The report gives a **status and counts, not a score** (requirement EXT-07): one missing mandatory
declaration makes a package non-compliant however many other rules pass, so a percentage would
misrepresent the legal position.

## Try the end-to-end flow

Sign in as **user@demo.gov.example** → **New Inspection** (pick a category; `pan_masala`/`medical_devices`/`edible_oil`
trigger overlay routing) → upload PNG/JPEG/PDF evidence with face labels → optionally record a
**calibration** (without one, font-size checks return **Not Assessable**) → **Run evidence processing** →
open the **Analysis workbench** → review/correct declarations → **Apply versioned rules** → disposition
each material finding (overrides need reasons; high-severity overrides need approval from an admin) →
**Finalize** → open the **Report** (PDF/DOCX/CSV/JSON/manifest export + hash verification) →
find it again via **Repository / Search**. Seeded inspections (one finalized, one open, one e-commerce)
are ready immediately.

Then sign in as **admin@demo.gov.example** to see the same case read-only with the review verbs available
(and no capture or delete controls), and as **superadmin@demo.gov.example** for user administration, the
rule library and **Deleted Records**.

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
