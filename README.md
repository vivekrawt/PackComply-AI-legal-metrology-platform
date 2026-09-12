# PackComply AI

Automated Legal Metrology compliance inspection platform (MVP vertical slice).
**Decision support only** — AI proposes, deterministic versioned rules evaluate, authorized officers decide.
Runs fully locally on free/open-source components, except the compliance judge, which calls the Gemini
API when a key is configured and otherwise degrades to a labeled deterministic fallback.

> ⚠ **OCR and the compliance judge are real.** Self-hosted **PaddleOCR** (English + Devanagari), with
> OpenCV/Pillow preparation of every capture, runs in a local sidecar and works offline; the
> field-officer scan flow then sends the recovered text to **Gemini 3.5 Flash Lite**
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
Python 3.11 + FastAPI OCR sidecar (PaddleOCR + OpenCV/Pillow) · pdfkit/docx report exporters ·
vitest + pytest tests. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

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

One hierarchy, enforced server-side on every route from a single matrix
(`server/src/modules/auth/permissions.ts`):

```
super_admin  →  admin  →  auditor        each level supervises the one below it,
                                          and only the bottom one does the auditing
```

The web UI renders navigation and buttons from the permission list the server returns with
`/auth/me`, so it can never offer an action the API refuses.

| Role | What it is for | Can | Cannot |
|---|---|---|---|
| **user** (auditor / field agent) | Does the work. Self-registration always produces this role, in its own organization. Signs in to the **scan flow**, not a console | Create scans, capture/upload evidence, run processing, correct declarations, run the compliance check, disposition findings, export reports | Sign off a scan, approve overrides, amend a signed report, issue notices, read the audit log, author rules, administer anything, **delete anything** |
| **admin** (team reviewer) | Reviews **its own team's** work | **Sign off scans** (accept / reject / send back), **refer a case up** to a super administrator, read its team's casework, dispose findings, approve second-level overrides, finalize and amend reports, issue notices, order re-inspections, see its team's auditors and statistics, read the audit log | See or act on **another team's** cases, create scans, capture evidence, edit declarations, manage teams or people, **delete anything** |
| **super_admin** | Runs the organization | Everything an admin can, across **every** team, plus teams, people, rules, configuration, retention and deletion. Its decision on a case is **final** | **Perform the auditing itself** — `inspection.create`, `evidence.upload`, `processing.run`, `declaration.edit` and `evaluation.run` are deliberately withheld |

Three deliberate consequences:

- **The super administrator does not audit.** It holds every permission *except* the capture
  verbs — the one carve-out in "holds everything by construction". An authority that could
  manufacture the record it later signs off is not a separation of duties, so the hierarchy is
  encoded in the matrix rather than merely hidden in the UI.
- **An admin's reach stops at its team.** `scopeWhere()` narrows an admin to `team_id`, and an
  admin with no team matches **nothing** — a permission boundary that falls back to "everything"
  when its input is missing is not a boundary. Migration 007 places every pre-existing admin in a
  team so this can never strand anyone.
- **Decisions run one way.** Once a super administrator *settles* a case — accepts or rejects it —
  an admin cannot overturn, replace or re-open it. The check reads the `reviewer_role` stored *on
  the decision*, not the reviewer's role today, so demoting someone never retroactively unlocks
  what they finalised. **Sending a package back is the exception**: that is an instruction to go
  and re-photograph it, so the work continues and both the auditor and the admin can act on it.
  Locking a send-back would strand the case with nobody able to move it.

Two deliberate consequences:

- **Segregation of duties.** `admin` cannot create or alter the record it signs off, so "who did the work"
  and "who approved it" are always different people. `user` cannot approve its own high-severity override —
  the second-level approval must come from an `admin` or `super_admin`. The scan sign-off enforces the same
  separation directly: whoever captured a scan is refused the review verb on it, kept as defence in depth
  now that no role can reach both verbs through the API.
- **Deletion is soft and attributed.** Every delete demands a reason, is written to the tamper-evident audit
  log, and keeps the row (and its evidence hashes) so a previously issued report still verifies. Deleted
  inspections appear in **Deleted Records** and can be restored. Deleting a *finalized* inspection requires an
  explicit acknowledgement; a *published* rule version cannot be deleted at all (retire or roll it back).
  Deleting a user offboards and anonymises the account rather than dropping the row, because the audit chain
  references that officer.

Finalization by `user` is policy-driven: set the `finalization_policy` config item's `userCanFinalize` to
`false` to force every report through an `admin` reviewer.

## Demo accounts (password: `PackComply#2026`)

| E-mail | Role | Team |
|---|---|---|
| user@demo.gov.example | **auditor** — lands in the scan flow | Pune Field Team |
| admin@demo.gov.example | **admin** — reviews the Pune team only | Pune Field Team |
| user.ka@demo.gov.example | **auditor** (Karnataka) | Bengaluru Field Team |
| admin.ka@demo.gov.example | **admin** — reviews the Bengaluru team only | Bengaluru Field Team |
| superadmin@demo.gov.example | **super_admin** — runs the organization | — (above the teams) |
| superadmin2@demo.gov.example | **super_admin** — second approver (rule maker-checker demo) | — |

Two teams rather than one on purpose: sign in as `admin@` and then `admin.ka@` and the queues are
disjoint, which is the only way to see that team scoping does anything.

## Field-officer flow (the `user` role)

Signing up lands a field officer in a four-screen application — scan, result, history, report. None of
the reviewer/administrator surface (rule authoring, audit log, analytics, dispositions, recycle bin) is
shown, because none of it is authority a field officer holds. `admin` and `super_admin` sign in to the
**reviewer console** instead (below) — the mirror image, carrying none of the capture surface.

```
Sign up                      creates a `user` account in its own organization; role is never
        │                    claimed at registration
        ▼
Scan the product             → Upload the image   ·   Click image using the camera
        │
        ▼
Capture the sides            top · bottom · left · right, each optional individually
        │                    "+ Add another side image" for front/back/close-up/other
        │                    AT LEAST ONE image required — a small packet can carry its whole
        │                    label on one face; the judge is told which faces it did and did
        │                    not see, so an unphotographed face reads "unclear", not "missing"
        │                    exact duplicate bytes are refused at upload by SHA-256
        ▼
Image preparation            OpenCV/Pillow — EXIF, deskew, crop to text, upscale, CLAHE, sharpen
        │                    every operation recorded; the prepared image kept as a derivative
        ▼
OCR                          PaddleOCR (en + devanagari) in the sidecar — text recovered per face
        ▼
Compliance judge             the OCR text + the FULL text of the LMPC Rules, 2011 → Gemini 3.5 Flash Lite
        │                    structured verdict, temperature 0, statutory text hashed onto the row
        ▼
Verdict                      Compliance ready · Not compliance ready · Needs review
        │                    ├─ Missing for compliance   what is absent, with rule citation + fix
        │                    ├─ Could not be determined  where the images do not settle it
        │                    └─ Requirements met         what the package got right
        ▼
Send to admin                an explicit act: analysis finishing means the machine is done,
        │                    not the auditor. Until they send it the scan reaches no review
        │                    queue. Sent back? it returns to their home screen with the
        │                    reviewer's reason and a button to photograph the package again
        ▼
Scan report                  PDF / JSON — image SHA-256s, the statutory text hash, the model
        │                    version, and the OCR text the verdict was formed from
        ▼
History                      every scan the officer has run, filterable by outcome
```

The verdict gives a **status and counts, not a score** (requirement EXT-07): one missing mandatory
declaration makes a package non-compliant however many other rules pass, so a percentage would
misrepresent the legal position.

**The package names itself.** The common or generic name is a declaration the Rules require, so a
judge that has read the label already knows it — `productName` and `brand` come back with the verdict
and name the record, because a scan listed as "Unnamed product" is one an officer cannot find again.
A name the auditor typed always wins; failing both, the extracted product-name declaration is used.
With no AI model configured and no such declaration, the scan honestly stays unnamed rather than
being given a guess.

**Two assessments, kept separate.** Alongside the AI verdict, the deterministic versioned rule engine
runs over the same evidence and its findings are shown as a labeled cross-check. They are never merged:
one is a model reading the statute, the other is pattern matching against configured rules, and an
officer needs to know which is which.

**A scan report is not a finalized report.** Finalization is a legal act gated on officer review of every
material finding, and this flow does not waive that gate — the scan report is decision support and says
so on its face. Judging a scan is the reviewer's job, in the console below.

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
GEMINI_API_KEY=...                    # unset → deterministic fallback, labeled as not-an-AI-assessment
GEMINI_MODEL=gemini-3.5-flash-lite    # default; any generateContent model works (e.g. gemini-3.5-flash)
PROVIDER_COMPLIANCE=gemini            # or rule_engine to force the fallback
```

`npm test` pins `PROVIDER_COMPLIANCE=rule_engine`, so the suite never makes a live billed call.

## Teams

A team is the unit an admin reviews and an auditor works in. An organization is the tenant; a team
is a group of auditors with one or more admins over them, and `team_id` on a scan is what routes it
to the right queue — stamped from the capturing auditor at creation, never inferred later.

**A team has exactly one admin.** "The admin of this team" is therefore always an unambiguous
person, and an auditor always knows who reviews their work. Assigning a second one is refused;
migration 008 resolved any team the earlier backfill left with several by keeping the
earliest-created admin and unassigning the rest.

Only `super_admin` creates teams or moves people between them, because moving someone changes whose
queue their work reaches. Every move is audited. A team cannot be archived while it still has
members, and a team with no admin is flagged in the Teams list — its work would otherwise reach
nobody.

> Assigning a **custom subset of compliance rules per team** is designed for but not implemented:
> today every team is assessed against the same published rule set. The schema and console leave
> room for it without rework.

## Reviewer console (the `admin` role)

An `admin` lands in a console built for one job: judging scans its own team captured.

```
Review queue                 every analysed scan in the organization, newest first
        │                    default filter is what has NOT been decided — this is a
        │                    worklist, not a browser; unanalysed scans are held out
        │                    because there is nothing yet to judge
        ▼
Open a scan                  the reviewer sees EXACTLY what the officer saw — same verdict,
        │                    same grouped checks, same evidence viewer with OCR boxes drawn
        │                    on the officer's own photographs
        ▼
Decision                     Accept · Reject · Send back · Refer to super administrator
        │                    a reason is mandatory on all four, acceptance included
        │                    written to the append-only, hash-chained audit log
        ▼
Signed off                   every decision kept, newest first — the path to the outcome
                             survives, not just the outcome
```

**Referring a case upward** is the fourth option, for a case an admin judges beyond their authority
to settle. It leaves their queue, lands in the super administrator's, and locks: the admin who
raised it cannot then decide it anyway, or the referral would mean nothing. Only a super
administrator's answer clears it — and that answer is final.

Three properties make the sign-off worth trusting:

- **A decision names the reading it was made against.** It pins the verdict id, so re-analysing a package
  marks the standing decision **stale** rather than silently carrying a reviewer's name forward onto an
  assessment they never read.
- **You cannot sign off your own capture.** Enforced server-side, not hidden in the UI.
- **There is nothing to accept until there is an assessment.** A scan that was never analysed, or whose
  judge call failed, refuses acceptance — sending it back for re-capture stays available, because that is
  the correct response to a failed analysis.

Alongside the queue an admin gets **Signed off** and **My team**: the auditors reporting to them,
read-only, because membership is the super administrator's authority. It does not list the admin —
a team has one, you are signed in as them, and a panel telling you who you are is noise. Opening an
auditor shows what they have completed **today, this week and this month** (calendar periods, so
"this week" means the week you are standing in) alongside their all-time figures.

The console deliberately carries **none** of the capture surface — no new inspection, no upload, no camera,
no calibration, no declaration editing, no processing-job telemetry. Every one of those needs a permission
the reviewer role does not hold, and offering a control the API will refuse is worse than not offering it.

## Administration console (the `super_admin` role)

A super administrator does not open a queue — the queues belong to the admins. Its landing page is
**how the organization is doing**:

| Section | What it answers |
|---|---|
| **Overview** | Organization-wide throughput, casework-per-month, headcount, and what is waiting on you |
| **Referred to you** | Cases an admin has handed upward, with who raised each and why |
| **All scans** | The complete list, including work still being captured — reachable, never the landing page |
| **Teams** | Create, rename, archive; assign the admin and the auditors; per-team statistics |
| **Admins** | Every admin, their team, their team size, and decisions taken — with add / activate / suspend / delete |
| **Auditors** | Every auditor, their team, and cases captured — same lifecycle controls |
| **Rule library · Deleted records · Audit trail** | Unchanged governance surfaces |

**Referred to you** is the only thing that reaches the super administrator's attention list, and the
only way in is an admin explicitly putting it there. Nothing arrives because the system inferred it
was interesting, so the list is a queue of asks from named people — each with the reason they gave —
rather than a pile to triage.

The overview carries no organization-wide "awaiting review" figure on purpose: undecided work is an
admin's queue, not the super administrator's. The number that belongs to them is what has actually
been referred up. Per-team, per-admin and per-auditor performance lives in the Organization sections
rather than being repeated on the landing page.

An admin's numbers are **decisions taken**; an auditor's are **cases captured**. They are shown on
separate screens because they are different units of work, and one grid would invite comparing numbers
that do not mean the same thing. Every such screen says plainly that the counts describe how much work
moved, not how well anyone did it.

## Try it

**As a field officer.** Open the app → the front door is **Create your account**. Either register, or press
**⚡ One-click test account** (`tester@packcomply.test` / `PackComplyTest#1`) to skip straight to scanning —
the same signup endpoint, the same `user` role, just a pre-filled form. Then **Scan the product** → choose
upload or camera → add at least one side (more is better) → **Analyse for compliance** → read the verdict,
tapping any image to see the text found on it → **Download
report (PDF)** → find it again under **History**. The seeded `server/assets/demo-labels/*.png` are legible
synthetic labels that work end to end through real OCR.

`user@demo.gov.example` also lands in this flow — it is a `user`.

**As an admin.** Sign in as **admin@demo.gov.example** to land in the **review queue** for the Pune
team. Seeded scans are ready immediately — open one, check a finding against the auditor's photographs
with **Show this on the image**, then record Accept / Reject / Send back with a reason. Re-run the
analysis as the auditor and the decision is flagged stale on your next visit. Sign in as
**admin.ka@demo.gov.example** and the queue is a completely different set of cases: that is team scoping.

**As a super administrator.** Sign in as **superadmin@demo.gov.example** and you get the organization
instead of a queue: throughput across both teams, and **Teams** / **Admins** / **Auditors** to run
them. Two things worth trying: decide a case here, then reopen it as `admin@` — the form is closed,
because a super administrator's decision is final. And as `admin@`, choose **Refer to super
administrator** on a case; it leaves the admin queue, appears under **Referred to you** with the
reason given, and the admin can no longer decide it.

Scans from *self-registered* auditors will not appear in any of it: signup puts each new account in its
**own** organization (so one auditor can never read another's scans). Create auditors from the
**Auditors** section, assigned to a team, for their work to reach a queue.

## Real OCR (self-hosted, free, default)

**PaddleOCR** with OpenCV/Pillow image preparation, running in the Python sidecar in
[ocr-service/](ocr-service/) — `PROVIDER_OCR=paddle`, the default. It is reached over loopback, so
evidence never leaves the deployment, and the models are local, so it works **offline** once they are
cached. Upload or capture real JPEG/PNG/WebP label photos and you get real recognition with real
bounding boxes.

Every capture is prepared before it is read: EXIF orientation, deskew, crop to the text, upscale a
small capture, then CLAHE contrast, denoise and unsharp. This is not cosmetic — a tilted shot of a
demo label went from 7 of 8 lines recovered to 8 of 8 once deskew was working.

Two properties keep that defensible:

- **The original is never touched.** The prepared image is stored as an `evidence_derivatives` row
  beside it, with its own SHA-256 and the exact ordered list of operations that produced it, so a
  report can show both what the officer photographed and what the recogniser read.
- **Boxes are reported against the original photograph.** Preparation rotates and crops, so the
  service maps every box back through the inverse of its own transform. Verified to ~1 px on a
  6°-rotated capture.

English and Devanagari are separate recognition models; both run and their readings are merged per
box, with a genuinely-Devanagari reading preferred over a Latin model's transliteration of it.

Setup is `python -m venv .venv` plus `ocr-service/requirements.txt`; `npm run dev` starts the sidecar
with the app, or `npm run ocr` alone. If it is not running, evidence processing **fails loudly** — a
configured engine is never silently swapped for another.

`PROVIDER_OCR=tesseract` keeps the previous in-process tesseract.js (WASM, eng+hin) for a deployment
that cannot run Python; it does no image preparation and produces no derivative.
`PROVIDER_OCR=mock` gives deterministic runs. Neither engine is benchmarked against the PRD
acceptance corpus yet. Verify the adapters with
`cd server && RUN_PADDLE_TESTS=1 npm test -- paddle.integration` (needs the sidecar up) or
`RUN_TESSERACT_TESTS=1 npm test -- tesseract`.

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
# repo root
npm run dev         # API :4000 + web :5173 + OCR sidecar :8100 together
npm run ocr         # just the PaddleOCR sidecar

cd server
npm run dev         # API with reload
npm run seed        # seed database (no-op if already seeded); delete server/data to reset
npm test            # 113 tests: engine units (incl. the critical calibration pair), API/workflow/UAT,
                    # the scan flow, submission, reviewer sign-off, escalation, team
                    # isolation and decision precedence, and the Gemini and PaddleOCR
                    # adapters with the network stubbed
node ../scripts/extract-rules.mjs   # (re)extract the statutory corpus into assets/rules/
npm run typecheck

# OCR sidecar (Python) — 12 tests, offline, no models needed
../.venv/Scripts/python -m pytest ocr-service/test_preprocess.py

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
- A reviewer's sign-off is a record, not a click: mandatory reason, written to the audit chain, pinned to the
  verdict it judged, refused to whoever captured the scan, and marked stale if that verdict is superseded.
- The role hierarchy is data, not decoration: an admin's scope predicate is its team and fails closed without
  one, a super administrator is refused the capture verbs outright, and a super administrator's decision to
  accept or reject a case cannot be overturned at admin level.
- A scan reaches a reviewer only when its auditor sends it. Analysis finishing is the machine being done, not
  the person — and a package sent back for re-photographing returns to the auditor who captured it, with the
  reviewer's reason attached and the way to act on it.
