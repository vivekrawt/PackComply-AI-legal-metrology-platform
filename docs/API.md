# PackComply AI — REST API (v1)

Base path: `/api/v1`. Cookie-session auth (`POST /auth/login`). Every mutation requires header
`X-Requested-With: packcomply` (CSRF). Responses are JSON; errors:
`{ "error": { "code", "message", "details?" }, "correlationId" }`. Every response carries
`X-Correlation-Id`. Rate-limited (global + login). All routes enforce role permission **and**
jurisdictional scope server-side. `Idempotency-Key` header is honored on `POST /inspections/:id/process`.

**Roles.** Three roles — `user` (does the inspection work), `admin` (reviews it; no create/upload/delete)
and `super_admin` (full write **and** delete). The matrix lives in
`server/src/modules/auth/permissions.ts` and is enforced per route by `requirePerm`; denials are audited.
Routes marked **super_admin** below are the destructive verbs, which no other role holds. Deletes are soft
(the row and its evidence hashes survive so issued reports stay verifiable), always require a reason, and
are recorded in the hash-chained audit log.

## Auth
| Method | Path | Notes |
|---|---|---|
| POST | /auth/signup | self-registration — see **Scan flow** below; always creates a `user` |
| POST | /auth/login | `{email, password}` → sets httpOnly session cookie |
| POST | /auth/logout | |
| GET | /auth/me | current user + provider/demo status + `permissions[]` for the signed-in role |
| GET | /roles | role catalogue: `{role, label, description, permissions[]}` for `user`, `admin`, `super_admin` |

## Scan flow (field officer)
The `user` role's whole application. A thin façade over the same services the casework routes use —
same evidence store, same audit chain, same scope checks — shaped for capture-and-verdict rather than
casework.

| Method | Path | Notes |
|---|---|---|
| POST | /auth/signup | `{email, name, password, organizationName?}` → creates a **`user`** account in its own organization and signs it in. Role is never taken from the request. |
| GET | /scans/capability | `sides` to lay out on arrival + `extraSides` to offer as they fill, image floor (`minImages`) and ceiling (`maxImages`), judge provider/model/`isMock`, statutory-corpus availability + SHA-256 |
| POST | /scans | create a scan `{product?, location?}` → `{scanId}` |
| PUT | /scans/:id/product | brand / generic name / category / pack size / import status |
| POST | /scans/:id/images | multipart `file` + `side` (`front`\|`back`\|`top`\|`bottom`\|`left`\|`right`\|`closeup`\|`other`) + `source`. One face per request. A second image for a face already captured **replaces** it — the old one is soft-deleted, so a retake is not sent to OCR alongside the shot that superseded it. Exact duplicate bytes are refused. **409** past `maxImages` (8) distinct faces. |
| DELETE | /scans/:id/images/:assetId | the capturing auditor discards one of their own images. Soft delete — the SHA-256 stays on the row — and the freed face can be photographed again. |
| POST | /scans/:id/analyze | `{force?}` → 202. Queues OCR → declaration extraction → rule evaluation → AI compliance judge. **422** below two images. `force` re-queues only the judge, so a retry after a service outage is not deduplicated into a no-op. |
| GET | /scans/:id | poll target: `status` (`capturing`\|`analyzing`\|`ready`\|`failed`), progress, images, `verdict`, `engineFindings`, `ruleVersions` |
| GET | /scans | scan history for the signed-in officer (scope-enforced) |
| GET | /scans/:id/report | scan report JSON (built on demand; **does not finalize**) |
| GET | /scans/:id/report.pdf | the same report as PDF |

**Verdict shape.** `{overall: compliant\|non_compliant\|needs_review, summary, confidence, checks[], provider,
modelVersion, isMock, rulesSources[], rulesSha256, ocrText, error}`. Each check is
`{parameter, ruleReference, status: present\|missing\|unclear, observedText, issue, remedy}`.

Three fields make a verdict reproducible and are stored on every row: `rulesSha256` (the exact statutory
text the model read), `ocrText` (exactly what it was given), and `isMock` (whether a model read the rules
at all, or the deterministic fallback ran). A judge failure is recorded as a verdict row carrying `error`
rather than discarded — the officer must see that the AI step did not run.

**A scan report is not a finalized report.** Finalization is gated on officer review of every material
finding (`POST /inspections/:id/finalize`), and this flow deliberately does not waive that gate: the
scan report is decision support and says so on its face.

## Inspections
| POST | /inspections | create (type, eventDate, location, sellerName, product{…}) |
| GET | /inspections | filters: status, type, assignedTo=me, q, limit, offset |
| GET | /inspections/:id | inspection + coverage + assets + duplicate suggestions |
| PATCH | /inspections/:id | location/notes/assignment/due/priority/status/eventDate |
| PUT | /inspections/:id/product | upsert product context |
| POST | /inspections/:id/waive-view | `{view, reason}` |
| GET | /inspections/:id/timeline | audit + notices + linked inspections |
| POST | /inspections/:id/reinspect | linked re-inspection (lineage preserved) — `inspection.reinspect` |
| DELETE | /inspections/:id | **super_admin** · `{reason, force?}` → soft delete; `force` required for a finalized record |
| POST | /inspections/:id/restore | **super_admin** · undo a soft delete |
| GET | /inspections/deleted | **super_admin** · recycle bin (the only view that shows deleted rows) |

## Evidence & processing
| POST | /inspections/:id/evidence | multipart `files[]` + faceLabel/source/capturedAt/device/gps |
| POST | /inspections/:id/evidence/url | `{url, marketplace?, seller?, structured?}` |
| POST | /assets/:id/calibration | `{method, mmPerPx, uncertaintyPct?, instrument?}` |
| GET | /assets/:id | asset + quality + OCR blocks + layout + calibrations |
| DELETE | /assets/:id | **super_admin** · `{reason}` → soft delete; refused under legal hold or after finalization |
| POST | /assets/:id/signed-url | mint short-lived signed content URL |
| GET | /assets/:id/content | original binary (session+scope or valid signature); integrity-checked |
| POST | /inspections/:id/process | enqueue quality→OCR→extraction jobs (202; idempotent) |
| GET | /inspections/:id/jobs | job status/progress/errors |

## Declarations, evaluation, findings
| GET | /inspections/:id/declarations | merged declarations with provenance |
| POST | /declarations/:id/correct | `{field, newValue, reason}` (verbatim_text, decl_type, normalized_value, lang, bbox, grouping) |
| GET | /declarations/:id/corrections | correction history |
| POST | /inspections/:id/evaluate | run versioned rule engine; returns run + per-rule results + exclusions |
| GET | /inspections/:id/evaluations | latest (or ?runId=) evaluation set |
| GET | /inspections/:id/findings | findings + dispositions |
| POST | /findings/:id/disposition | `{action: confirm|dismiss|defer|override|not_applicable|not_assessable, toOutcome?, reason}` |
| POST | /dispositions/:id/approve | second-level approval (different officer) |

## Case workflow
| POST | /inspections/:id/annotations | rect/note/measure annotations |
| POST | /inspections/:id/notices | warning/improvement notice |
| PATCH | /notices/:id | status/response updates |

## Finalization & reports
| POST | /inspections/:id/finalize | blocks until material findings reviewed & approvals complete |
| GET | /inspections/:id/report | current report + version list |
| POST | /reports/:id/amend | new immutable version with reason |
| GET | /reports/:id/verify | recompute + compare snapshot hash |
| GET | /reports/:id/export/:format | pdf · docx · csv · json · manifest (?version=) |

## Search, history, dashboards
| GET | /search?q= | FTS over OCR/declarations/products/entities (scope-enforced) |
| GET | /products/history?gtin=&brand= | product/entity inspection timeline |
| GET | /dashboards/enforcement · /operations · /violations · /model-quality · /rule-admin | |

## Rules (governance)
| GET | /rules/sets · /rules/sources · /rules/versions[?ruleKey&status] · /rules/versions/:id | |
| POST | /rules/versions | create draft (rule admin) |
| PATCH | /rules/versions/:id | edit draft only |
| POST | /rules/versions/:id/submit · /approve · /publish · /retire · /rollback | maker-checker enforced; publish runs the regression pack |
| POST | /rules/versions/:id/test | run test pack against this version |
| GET | /rules/compare?ruleKey&versionA&versionB | outcome diff across versions |
| POST | /rules/tests | add fixture `{ruleKey, name, fixture, expectedOutcome}` |
| DELETE | /rules/versions/:id | **super_admin** · `{reason}` → hard delete, unpublished and unused versions only |

## Administration & audit
| GET/POST/PATCH | /admin/users | lifecycle (`admin.users`, super_admin) · POST /admin/users/:id/revoke-sessions |
| DELETE | /admin/users/:id | **super_admin** · offboards + anonymises + cuts sessions; the row is retained for audit attribution |
| GET/PUT | /admin/config/:key | versioned config items |
| GET | /models | model registry |
| GET | /audit?objectType&objectId&actorId&limit | audit query (itself audited) |
| GET | /audit/verify | hash-chain verification |
| GET | /health · /admin/metrics | |
