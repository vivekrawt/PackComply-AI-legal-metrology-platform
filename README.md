# PackComply AI

Automated Legal Metrology compliance inspection platform (MVP vertical slice).
**Decision support only** — AI proposes, deterministic versioned rules evaluate, authorized officers decide.
Runs fully locally on free/open-source components, except the compliance judge, which calls the Gemini
API when a key is configured and otherwise degrades to a labeled deterministic fallback.

> ⚠ **OCR and the compliance judge are real.** A self-hosted tesseract.js adapter (English + Hindi) runs
> in-process and works offline; the field-officer scan flow then sends the recovered text to **Gemini Flash**
> together with the full text of the Legal Metrology (Packaged Commodities) Rules, 2011. With no
> `GEMINI_API_KEY` set, that step falls back to the built-in deterministic rule engine, which reports
> itself as **not an AI assessment** — it is never silently substituted. Image-quality, layout,
> declaration-classification and font-measurement remain deterministic **MOCK/DEMO** providers, labeled
> everywhere they surface. All seeded legal rule parameters are placeholders flagged
> **REQUIRES LEGAL APPROVAL**, and all seeded products/labels are synthetic and fictional. Nothing here is
> a real enforcement decision or certified statutory logic.

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
| **user** | Does the work — the field officer using the product. Self-registration always produces this role, in its own organization. Signs in to the **scan flow**, not the casework workbench | Create scans/inspections, capture/upload evidence, run processing, correct declarations, run the compliance check, disposition findings, export reports | Approve overrides, amend a signed report, issue notices, read the audit log, author rules, administer users, **delete anything** |
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
| user@demo.gov.example | **user** — field officer (Maharashtra/Pune scope); lands in the scan flow |
| admin@demo.gov.example | **admin** — reviewer (organization-wide) |
| superadmin@demo.gov.example | **super_admin** — full write and delete |
| superadmin2@demo.gov.example | **super_admin** — second approver (rule maker-checker demo) |
| user.ka@demo.gov.example | **user** in Karnataka (scope-isolation demo) |

## Field-officer flow (the `user` role)

Signing up lands a field officer in a four-screen application — scan, result, history, report. None of
the reviewer/administrator surface (rule authoring, audit log, analytics, dispositions, recycle bin) is
shown, because none of it is authority a field officer holds. `admin` and `super_admin` still sign in to
the full casework workbench.

```
Sign up                      creates a `user` account in its own organization; role is never
        │                    claimed at registration
        ▼
Scan the product             → Upload the image   ·   Click image using the camera
        │
        ▼
Capture the sides            top · bottom · left · right, each optional individually
        │                    "+ Add another side image" for front/back/close-up/other
        │                    AT LEAST TWO images required — one face cannot show that a
        │                    declaration is absent, only that you did not photograph it
        │                    exact duplicate bytes are refused at upload by SHA-256
        ▼
OCR                          tesseract (en+hi), in-process — text recovered per face
        ▼
Compliance judge             the OCR text + the FULL text of the LMPC Rules, 2011 → Gemini Flash
        │                    structured verdict, temperature 0, statutory text hashed onto the row
        ▼
Verdict                      Compliance ready · Not compliance ready · Needs review
        │                    ├─ Missing for compliance   what is absent, with rule citation + fix
        │                    ├─ Could not be determined  where the images do not settle it
        │                    └─ Requirements met         what the package got right
        ▼
Scan report                  PDF / JSON — image SHA-256s, the statutory text hash, the model
        │                    version, and the OCR text the verdict was formed from
        ▼
History                      every scan the officer has run, filterable by outcome
```

The verdict gives a **status and counts, not a score** (requirement EXT-07): one missing mandatory
declaration makes a package non-compliant however many other rules pass, so a percentage would
misrepresent the legal position.

**Two assessments, kept separate.** Alongside the AI verdict, the deterministic versioned rule engine
runs over the same evidence and its findings are shown as a labeled cross-check. They are never merged:
one is a model reading the statute, the other is pattern matching against configured rules, and an
officer needs to know which is which.

**A scan report is not a finalized report.** Finalization is a legal act gated on officer review of every
material finding, and this flow does not waive that gate — the scan report is decision support and says
so on its face. Formal finalization stays in the reviewer's workbench.

### Statutory corpus

The text the model reads lives in `server/assets/rules/`. `lmpc-2011.txt` is the Legal Metrology
(Packaged Commodities) Rules, 2011 extracted verbatim from the source PDF. To refresh it, or to add an
amendment, drop the PDF in the repo root and run:

```bash
node scripts/extract-rules.mjs
```

Every `.txt`/`.md` in that directory is concatenated and hashed; the hash is recorded on every verdict, so
a report always names the exact text the model was shown and two verdicts produced against different law
are never silently comparable.

### Configuring the judge

```bash
# server/.env
GEMINI_API_KEY=...              # unset → deterministic fallback, labeled as not-an-AI-assessment
GEMINI_MODEL=gemini-flash-latest
PROVIDER_COMPLIANCE=gemini      # or rule_engine to force the fallback
```

`npm test` pins `PROVIDER_COMPLIANCE=rule_engine`, so the suite never makes a live billed call.

## Try it

**As a field officer.** Open the app → the front door is **Create your account**. Either register, or press
**⚡ One-click test account** (`tester@packcomply.test` / `PackComplyTest#1`) to skip straight to scanning —
the same signup endpoint, the same `user` role, just a pre-filled form. Then **Scan the product** → choose
upload or camera → add at least two sides → **Analyse for compliance** → read the verdict → **Download
report (PDF)** → find it again under **History**. The seeded `server/assets/demo-labels/*.png` are legible
synthetic labels that work end to end through real OCR.

`user@demo.gov.example` also lands in this flow — it is a `user`.

**As a reviewer / administrator.** Sign in as **admin@demo.gov.example** for the casework workbench:
declarations, dispositions, overrides, finalization, notices and the audit log, read-only over capture.
**superadmin@demo.gov.example** adds user administration, the rule library and **Deleted Records**.
Seeded inspections (one finalized, one open, one e-commerce) are ready immediately. The full casework
path — new inspection → evidence → calibration → processing → workbench → versioned rules → dispositions
→ finalize → report export with hash verification → repository search — is unchanged.

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
npm test            # 80 tests: engine units (incl. the critical calibration pair), API/workflow/UAT,
                    # the scan flow, and the Gemini adapter with the network stubbed
node ../scripts/extract-rules.mjs   # (re)extract the statutory corpus into assets/rules/
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
- Self-registration cannot claim authority: the role is fixed server-side, and each new account gets its own
  organization so one self-registered officer can never read another's scans.
- Every AI verdict records the SHA-256 of the statutory text the model read, the OCR text it was given, the
  model version, and whether a model ran at all — a verdict that cannot be reproduced is not evidence.
- A failed compliance call is stored as a verdict carrying its error, never discarded and never rendered as a
  compliance outcome; the scan flow offers a retry that actually re-queues the judge.
