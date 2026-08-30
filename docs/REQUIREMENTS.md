# PackComply AI — Requirements Catalogue

Derived from PackComply_AI_PRD_v1.0 (baseline 29 Aug 2026). Priorities use MoSCoW as stated in the PRD
(Must = MVP launch, Should = immediately after MVP, Could = deferrable).

Implementation status legend used throughout this repo:
**IMPLEMENTED** | **PARTIALLY IMPLEMENTED** | **MOCKED** (works end-to-end but backed by a clearly
labeled deterministic demo provider) | **NOT IMPLEMENTED** (abstraction/config exists only).

---

## 8.1 Identity, access and organizational control (IAM)

| ID | Requirement | Priority | Acceptance | Depends on | MVP status |
|----|-------------|----------|------------|-----------|------------|
| IAM-01 | SSO via OIDC/SAML plus controlled local accounts; MFA for privileged/finalizing roles | Must | Authorized user authenticates; MFA enforced by policy; failed events audited | — | PARTIALLY IMPLEMENTED — local accounts (scrypt), session policy, MFA-ready schema (TOTP secret field + policy flag); OIDC/SAML adapter interface documented, not wired (needs an IdP; open decision) |
| IAM-02 | Configurable RBAC for the 6 roles | Must | Every API/UI action denied unless permission allows | — | IMPLEMENTED — server-side permission matrix, per-route enforcement |
| IAM-03 | Scope data access by org, state/UT, district, office, team, assignment, case sensitivity | Must | User cannot search/export/open out-of-scope records | IAM-02 | IMPLEMENTED — scope filter applied in repository queries and search |
| IAM-04 | User lifecycle: invite, approve, activate, transfer, suspend, offboard, access review | Must | Lifecycle events effective within SLA and audited | IAM-02 | PARTIALLY IMPLEMENTED — create/activate/suspend/role+scope change with audit; invitation email + periodic review workflow not implemented |
| IAM-05 | Session timeout, concurrent-session limits, revocation, risk-based re-auth | Must | Policy tests pass | IAM-01 | PARTIALLY IMPLEMENTED — inactivity timeout, session revocation, per-user session limit; risk-based re-auth not implemented |
| IAM-06 | Segregation of duties: rule publication, final report approval, audit-log admin | Must | Same actor cannot complete prohibited maker-checker combos | IAM-02 | IMPLEMENTED — rule author ≠ approver enforced; sysadmin cannot alter finalized findings; enforced server-side |
| IAM-07 | Immutable authn/authz/admin audit events | Must | Audit query shows actor, timestamp, source, action, object, outcome, correlation ID | — | IMPLEMENTED — append-only audit table with hash chain |

## 8.2 Inspection creation, intake and field capture (INS)

| ID | Requirement | Priority | MVP status |
|----|-------------|----------|------------|
| INS-01 | Create inspection: auto ID, jurisdiction, location, channel, date/time, officer, seller/entity, product context | Must | IMPLEMENTED |
| INS-02 | Physical retail, warehouse/import, back-office, complaint-driven, e-commerce types; type changes metadata/workflow | Must | IMPLEMENTED — type-driven required-view checklist + metadata fields |
| INS-03 | Camera capture + JPEG/PNG/HEIC/PDF upload, size/page limits, malware scanning | Must | PARTIALLY IMPLEMENTED — upload + type/size validation + magic-byte check; malware-scan integration point (no-op scanner interface, pluggable) |
| INS-04 | Multiple labeled package views + close-ups; coverage checklist by package form; waiver with reason | Must | IMPLEMENTED |
| INS-05 | Live camera guidance (distance, focus, glare, orientation, calibration marker) | Should | IMPLEMENTED — guided capture samples live video frames in-browser (Laplacian-variance focus, saturated-pixel glare, mean-luminance lighting) with framing corners, a scale-reference guide and actionable recapture prompts; guidance metadata is stored with the asset. Heuristics are capture-assist only, distinct from the server-side quality assessment |
| INS-06 | Capture timestamp, device, optional GPS, source, uploader; policy-based location correction with audit | Must | IMPLEMENTED |
| INS-07 | Barcode/GTIN, SKU, brand, generic name, category, batch/lot, package size; searchable, duplicate matching | Must | IMPLEMENTED |
| INS-08 | Bulk intake (drag-drop, manifest, API) | Should | PARTIALLY IMPLEMENTED — multi-file drag-drop upload; manifest spreadsheet NOT IMPLEMENTED |
| INS-09 | URL, full-page screenshot, PDF, structured feed as e-commerce evidence | Must | IMPLEMENTED — URL + screenshot/PDF + structured listing JSON |
| INS-10 | Duplicate detection; re-inspection/linked case without overwriting prior evidence | Must | IMPLEMENTED — GTIN/brand match suggestions + lineage links |
| INS-11 | Autosave drafts, assignment/reassignment, due dates, status, prioritized queues | Must | IMPLEMENTED (autosave on web; offline autosave is PARTIAL, see MOB-01) |
| INS-12 | Configurable checklists / campaign templates | Should | PARTIALLY IMPLEMENTED — per-type required-view checklists are config data; campaign templates NOT IMPLEMENTED |

## 8.3 Image processing, OCR and extraction (VIS / EXT)

| ID | Requirement | Priority | MVP status |
|----|-------------|----------|------------|
| VIS-01 | Immutable originals, cryptographic hash, derivatives as separate versions | Must | IMPLEMENTED — content-addressed store, SHA-256, originals write-once |
| VIS-02 | Rotation/dewarp/crop/denoise/contrast while retaining original | Must | MOCKED — derivative records + processing history via mock processor; real CV ops behind provider interface |
| VIS-03 | Score blur, glare, occlusion, resolution, text scale, curvature, clipping, face completeness with reason codes | Must | MOCKED — deterministic ImageQualityProvider emits scores + reason codes + recapture recommendations |
| VIS-04 | Detect faces/PDP/declaration clusters; editable geometry re-runs checks | Must | MOCKED + editable geometry stored; re-evaluation on edit IMPLEMENTED |
| VIS-05 | Calibration marker / known dimension / approved device measurement for mm estimation; store method, value, uncertainty | Must | IMPLEMENTED — calibration record per asset (method/value/uncertainty); marker auto-detect MOCKED |
| EXT-01 | English + Hindi MVP, mixed-script architecture, path to more scripts | Must | IMPLEMENTED — real self-hosted tesseract.js adapter (eng+hin) is now the **default** OCR provider; language data ships in `server/assets/tessdata` so it runs offline from a fresh clone. Verified reading English and Devanagari demo labels at 0.93–0.97 confidence. Not benchmarked against the PRD acceptance corpus; JPEG/PNG/BMP only (HEIC/PDF rasterization not bundled); mock remains selectable for deterministic tests |
| EXT-02 | Text, word/line boxes, reading order, script, confidence, source image per block | Must | IMPLEMENTED (data contract) / MOCKED (values) |
| EXT-03 | Classify declaration candidates (MRP, qty, dates, entity, care, origin, USP…) | Must | MOCKED via DeclarationExtractionProvider; full type taxonomy IMPLEMENTED |
| EXT-04 | Normalize currency/units/numbers/dates/phone/email/country preserving verbatim + provenance | Must | IMPLEMENTED — deterministic normalizers with provenance; ambiguous parses flagged for review |
| EXT-05 | Merge declarations across faces; detect duplicates/conflicts/continuation | Must | IMPLEMENTED — merge + conflict detection across contributing regions |
| EXT-06 | Officer corrections (text/type/value/language/bbox/grouping) with original, new, actor, reason, timestamp | Must | IMPLEMENTED |
| EXT-07 | Confidence exposed, never converted to legal compliance score | Must | IMPLEMENTED — UI + API separate `confidence` from `legalStatus` |

## 8.4 Rule-based compliance engine (REG)

| ID | Requirement | Priority | MVP status |
|----|-------------|----------|------------|
| REG-01 | Rules/thresholds/sources/report wording as versioned config with effective dates | Must | IMPLEMENTED |
| REG-02 | Rule selection by category, package type, dimensions/PDP area, import status, channel, actor, consumer class, jurisdiction, event date | Must | IMPLEMENTED — applicability predicate on rule versions |
| REG-03 | Presence/completeness of mandatory declarations; status+reason+evidence+citation each | Must | IMPLEMENTED |
| REG-04 | Syntactic/semantic format validation (units, currency, dates, address/contact) | Must | IMPLEMENTED |
| REG-05 | Conflict detection across faces/stickers/listing/physical-vs-online | Must | IMPLEMENTED (cross-face + listing-vs-physical) |
| REG-06 | Net quantity/number tests + category quantity relationships | Must | IMPLEMENTED (unit whitelist is config; values marked REQUIRES LEGAL APPROVAL) |
| REG-07 | MRP/RSP wording, INR amount, tax-inclusive phrase, USP rules per active version | Must | IMPLEMENTED (required phrase is rule config) |
| REG-08 | Date type/format/chronology validation | Must | IMPLEMENTED |
| REG-09 | Responsible entity + import + country-of-origin validation | Must | IMPLEMENTED |
| REG-10 | Consumer-care validation | Must | IMPLEMENTED |
| REG-11 | Combination/group/multipiece logic | Should | NOT IMPLEMENTED (schema fields exist; no evaluator) |
| REG-12 | Exemptions, sectoral overlays, transition, precedence; never infer universal applicability | Must | IMPLEMENTED — overlay routing (medical device, pan masala, edible oil seeds) + inclusion/exclusion explanations |
| REG-13 | Five outcomes with severity + remediation | Must | IMPLEMENTED |
| REG-14 | Human-readable explanation + citation on every evaluation | Must | IMPLEMENTED |
| REG-15 | Historical replay, simulation, version comparison, impact analysis | Should | PARTIALLY IMPLEMENTED — replay (pinned versions) + simulation against test pack; version diff view basic |
| REG-16 | Deterministic rules separate from model outputs; every component version logged | Must | IMPLEMENTED |

## 8.5 Font size, placement and readability (FNT)

| ID | Requirement | Priority | MVP status |
|----|-------------|----------|------------|
| FNT-01 | Physical character height only with valid scale/calibration; else Not Assessable | Must | IMPLEMENTED — hard gate in engine; covered by critical test |
| FNT-02 | Active Rule 7 table + package-form variants as configurable source-linked data | Must | IMPLEMENTED as config; seeded threshold values are DEMO and marked REQUIRES LEGAL APPROVAL |
| FNT-03 | Numeral/letter height, width ratio, line spacing at region level with overlay + uncertainty | Must | MOCKED measurement, IMPLEMENTED pipeline/overlay data |
| FNT-04 | Molded/embossed/perforated as distinct presentation mode with own thresholds | Must | IMPLEMENTED — presentation-mode field routes to separate threshold rows |
| FNT-05 | Readability (contrast/blur/glare/occlusion/curvature/clutter/compression/resolution) separate from font-size | Must | IMPLEMENTED (separate reason-code namespace), MOCKED scores |
| FNT-06 | Placement/PDP/grouping/visibility/obstruction checks | Must | PARTIALLY IMPLEMENTED — PDP presence/grouping check on mock geometry |
| FNT-07 | Manual measurement entry with instrument/method metadata | Should | IMPLEMENTED — manual calibration/measurement entry distinguished from CV estimate |
| FNT-08 | Evidence overlays + downloadable annotated images per presentation finding | Must | PARTIALLY IMPLEMENTED — overlay data in UI + report JSON; server-rendered annotated image NOT IMPLEMENTED |

## 8.6 E-commerce (ECM)

| ID | Requirement | Priority | MVP status |
|----|-------------|----------|------------|
| ECM-01 | Preserve URL, marketplace, seller, timestamp, screenshot/PDF, structured data | Must | IMPLEMENTED |
| ECM-02 | Extract listing declarations, distinguish page/cart/seller-panel evidence | Must | PARTIALLY IMPLEMENTED — structured listing fields + screenshot OCR (mock); evidence-zone tagging basic |
| ECM-03 | Validate entity/origin/care/MRP/quantity per active channel rule | Must | IMPLEMENTED — channel-scoped rule versions |
| ECM-04 | Country-of-origin search/filter test (from 1 Jul 2026) | Should | PARTIALLY IMPLEMENTED — manual filter-test record (query, value, behavior, timestamp, screenshot); no automation |
| ECM-05 | Online vs physical comparison (same/missing/contradictory/added/changed) | Should | IMPLEMENTED — comparison evaluator + difference view |
| ECM-06 | Officer-assisted capture for dynamic/login-gated content | Should | PARTIALLY IMPLEMENTED — manual upload path is the fallback |
| ECM-07 | Respect access controls / crawl policy; no-crawl and manual paths | Must | IMPLEMENTED — no automated crawling at all in MVP; domain policy table + manual capture only (safe default) |

## 8.7 Review and case workflow (REV)

| ID | Requirement | Priority | MVP status |
|----|-------------|----------|------------|
| REV-01 | Queues by assignment/severity/confidence/SLA/category/campaign/jurisdiction | Must | IMPLEMENTED (assignment/severity/status/due filters) |
| REV-02 | Dispositions: confirm/dismiss/edit/merge/split/defer/NA/not-assessable with reason; versioned & attributable | Must | IMPLEMENTED (merge/split PARTIAL — via declaration grouping) |
| REV-03 | Override reason mandatory; second-level approval for configured high-risk changes; blocks finalization | Must | IMPLEMENTED |
| REV-04 | Annotation, crop, callout, measurement line, comments, attachments; non-destructive; in manifest | Must | PARTIALLY IMPLEMENTED — rectangle/note annotations + comments + attachments; measurement-line UI basic |
| REV-05 | Configurable severity/provision/remedy/due/escalation, policy-controlled | Must | IMPLEMENTED (severity + remediation from rule config) |
| REV-06 | Warning/advisory, improvement notice, re-inspection, closure, escalation | Should | IMPLEMENTED (basic lifecycle: notice → response → re-inspection link → closure/escalation) |
| REV-07 | Link related products/entities/prior inspections/complaints/notices/repeat findings | Must | IMPLEMENTED — lineage links + entity/product history |
| REV-08 | Lock finalized reports/findings; amendments create new signed version, prior hash-verifiable | Must | IMPLEMENTED |

## 8.8 Reports, repository, search, export (RPT / REP)

| ID | Requirement | Priority | MVP status |
|----|-------------|----------|------------|
| RPT-01 | Standardized 8-section report | Must | IMPLEMENTED |
| RPT-02 | Signed/final PDF + editable DOCX/ODT; CSV/JSON + evidence manifest | Must | IMPLEMENTED — PDF (pdfkit), DOCX (docx lib), CSV, JSON, manifest; digital signature = hash only (e-sign NOT IMPLEMENTED, adapter point exists) |
| RPT-03 | Embed photos, boxes, annotations, text, confidence, measurements | Must | PARTIALLY IMPLEMENTED — PDF embeds images + region data as text/coords; box-burn-in NOT IMPLEMENTED |
| RPT-04 | Citations, rule version, report version, model version, disposition in report | Must | IMPLEMENTED |
| RPT-05 | Digital signature/e-sign, QR verification, report package hash | Should | PARTIALLY IMPLEMENTED — SHA-256 report hash + verification endpoint; e-sign/QR NOT IMPLEMENTED |
| RPT-06 | English/Hindi/bilingual templates, branding | Should | PARTIALLY IMPLEMENTED — template strings externalized; Hindi template partial |
| REP-01 | Repository of products/inspections/evidence/findings/reports/notices/actions/audit | Must | IMPLEMENTED |
| REP-02 | Full-text OCR search + filters; performance + scope | Must | IMPLEMENTED — SQLite FTS5, scope-filtered |
| REP-03 | Product/entity timeline, duplicate suggestions, related-case graph | Should | PARTIALLY IMPLEMENTED — timeline + duplicates; graph view NOT IMPLEMENTED |
| REP-04 | Retention, legal hold, archive/restore, policy disposal | Must | PARTIALLY IMPLEMENTED — legal-hold flag blocks deletion; retention policy config stored; automated disposal job NOT IMPLEMENTED |

## 8.9 Dashboards, administration, integrations (DASH / ADM / MOB / INT)

| ID | Requirement | Priority | MVP status |
|----|-------------|----------|------------|
| DASH-01 | Executive/operational dashboards | Must | IMPLEMENTED (reconciles with repository queries) |
| DASH-02 | Violation analytics by declaration/rule/category/brand/entity/marketplace/geo/time | Must | IMPLEMENTED (core dimensions) |
| DASH-03 | Repeat entities, patterns, data-quality gaps, risk clusters | Should | PARTIALLY IMPLEMENTED — repeat-entity list; clustering NOT IMPLEMENTED |
| DASH-04 | Model-quality dashboard (script/package/category/confidence/review outcome) | Must | IMPLEMENTED — correction/override/recapture/confidence metrics (mock-model data clearly labeled) |
| ADM-01 | No-code rule admin: sources, dates, maker-checker publication, test, compare, rollback | Must | IMPLEMENTED |
| ADM-02 | Taxonomy admin (commodities, synonyms, units, countries, jurisdictions, severity, templates) versioned | Must | PARTIALLY IMPLEMENTED — units/categories/countries as editable config; full synonym admin UI basic |
| ADM-03 | Model registry, deployment status, benchmarks, rollback | Must | IMPLEMENTED — registry of (mock) model versions; every inference records model version |
| MOB-01 | Responsive PWA, Android-first, encrypted offline drafts | Must | IMPLEMENTED for new-inspection drafts — AES-GCM-encrypted IndexedDB store (non-extractable WebCrypto key) for offline drafts + queued evidence photos, auto-sync on reconnect, idempotent via clientRef; offline EDITING of existing server records NOT IMPLEMENTED |
| MOB-02 | Sync conflict resolution, pending/failed upload states, remote sign-out/wipe | Must | PARTIALLY IMPLEMENTED — per-draft sync states (local/uploading/synced/failed) with explicit surfaced errors, session revocation; conflicts cannot arise for create-only drafts (existing-record offline edits are out of scope), remote wipe NOT IMPLEMENTED |
| INT-01 | Versioned authenticated REST APIs (all domains), rate-limited, documented, idempotent | Must | IMPLEMENTED — /api/v1, idempotency keys on mutating processing ops, rate limiting, docs/API.md |
| INT-02 | Webhooks/events | Should | NOT IMPLEMENTED (event table exists as integration point) |
| INT-03 | Adapters: SSO, e-sign, messaging, GTIN data, case systems, marketplaces, DW | Should | NOT IMPLEMENTED (adapter interfaces defined) |

## Non-functional requirements

NFR-PERF-01/02, NFR-SEARCH-01, NFR-AVAIL-01, NFR-SCALE-01, NFR-RELIAB-01, NFR-DR-01,
NFR-OFFLINE-01, NFR-SEC-01, NFR-AUD-01, NFR-ACC-01, NFR-LOC-01, NFR-MAINT-01, NFR-OBS-01,
NFR-PORT-01 — tracked in ARCHITECTURE.md §Non-functional approach. Targets are **designed toward and
instrumented (timing middleware, job metrics), not claimed as achieved** — measurement requires the
agreed pilot load.

## UAT scenarios

UAT-01 … UAT-12 as in PRD §16. Automated coverage: see `server/test/` — UAT-01/02/03/04/05/07/08/10/12
have automated tests or executable fixtures; UAT-06 partial (listing + comparison; filter test manual);
UAT-09 basic lifecycle test; UAT-11 manual test script (offline is partial).

## Open decisions from the PRD (not invented here)

Owning agency/tenant model; certified MVP category overlays and exemptions; approved device/calibration
procedure; hosting/data residency; scripts beyond en/hi; notice/report templates + signature authority;
integration priorities; retention periods; pilot volumes. Each is left configurable; legal values are
seeded as placeholders flagged `REQUIRES LEGAL APPROVAL`.
