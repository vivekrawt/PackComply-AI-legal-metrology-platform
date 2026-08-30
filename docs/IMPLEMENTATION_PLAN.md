# PackComply AI — Implementation Plan

Vertical-slice first: the MVP flow (login → inspect → evidence → process → OCR → review → rules →
findings → override → finalize → report → search → audit) is built end-to-end before breadth.

| Phase | Scope | Key reqs | Status |
|---|---|---|---|
| 0 Foundation | Repo layout, TS config, DB driver+migrations, config, logging, error handling, IDs, seed harness | NFR-OBS/MAINT | DONE |
| 1 Auth/RBAC | Local auth, sessions, permission matrix, scope enforcement, user lifecycle, audit of auth events | IAM-01..07 | DONE (OIDC adapter deferred) |
| 2 Inspection intake | Inspection CRUD, 5 types, checklist config, product/entity context, duplicates, lineage, queues | INS-01,02,04,06,07,10,11 | DONE |
| 3 Evidence | Upload/validation, immutable store, hashes, metadata, calibration entry, signed retrieval, e-comm evidence | INS-03,09; VIS-01,05; ECM-01,07 | DONE |
| 4 Pipeline | Job queue, mock quality/layout/OCR/extraction providers, derivatives, declaration merge, normalizers | VIS-02..04; EXT-01..05 | DONE (providers MOCKED by design) |
| 5 Rule engine | Rule schema, versioning, selection, evaluator primitives, overlays, 5 outcomes, calibration gate | REG-01..14,16; FNT-01..05 | DONE |
| 6 Workbench | Evidence viewer + overlays + declarations + findings + corrections UI | EXT-06,07; FNT-08 | DONE |
| 7 Review/finalize | Dispositions, overrides, second-level approval, finalization lock, notices, re-inspection | REV-01..08 | DONE |
| 8 Reports/repository | Snapshot, PDF/DOCX/CSV/JSON/manifest export, verify endpoint, FTS search, history | RPT-01..04; REP-01..03 | DONE |
| 9 Dashboards | Enforcement/operations/violation/model-quality aggregations | DASH-01..04 | DONE (core metrics) |
| 10 Rule administration | Draft/test/submit/dual-approve/publish/rollback UI + test-pack runner + diff | ADM-01..03; REG-15 | DONE |
| 11 Offline/PWA | Manifest, SW shell cache, upload states, autosave; encrypted IndexedDB draft store + idempotent sync (create-only drafts) | MOB-01..02 | DONE (offline edit of server records deferred) |
| 12 Hardening/tests | Security middleware, rate limits, validation, unit/integration/UAT tests | NFR-SEC; UAT-01..12 | DONE for listed tests |

Post-MVP milestone 1 (DONE): real self-hosted OCR adapter (tesseract.js eng+hin, opt-in via
`PROVIDER_OCR=tesseract`) + encrypted offline draft store with idempotent sync.

Deferred (documented, config/interface in place): OIDC/SAML + e-sign + webhook adapters, campaign
templates, combination-package evaluator, automated marketplace capture, offline editing of existing
server records, HEIC/PDF rasterization for real OCR, server-rendered annotated images, retention
disposal job, OCR benchmark against the PRD acceptance corpus.
