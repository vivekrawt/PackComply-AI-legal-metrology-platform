# PackComply AI — Data Model

SQLite (portable SQL → PostgreSQL). All tables carry `created_at`, and where mutable `updated_at` +
`updated_by`. Scope columns (`org_id`, `state`, `district`, `office`) on scoped aggregates. IDs are
prefixed ULID-style strings (`insp_…`, `ev_…`).

## Entities

- **organizations** — agency hierarchy node: id, name, kind(agency/state/district/office), parent_id.
- **users** — id, email, name, password_hash(scrypt), role (`user` | `admin` | `super_admin`), org scope
  fields, status (`invited`/`active`/`suspended`/`offboarded` — deleting an account sets `offboarded` and
  anonymises the e-mail, because audit events reference this actor)
  (invited/active/suspended/offboarded), mfa_secret (nullable, MFA-ready), session_policy.
- **sessions** — id, user_id, expires_at, last_seen_at, revoked_at.
- **role_permissions** — informational mirror of the code matrix (`ROLE_PERMISSIONS`), rebuilt on every
  boot by `syncRolePermissions`. Authorization checks read the code matrix, never this table.
- **inspections** — id, type (physical_retail/warehouse_import/back_office/complaint/ecommerce), status
  (draft/capturing/processing/review/pending_approval/finalized/closed), event_date, jurisdiction+scope,
  location (+gps), seller_entity_id, assigned_to, due_date, priority, sensitivity, checklist_state JSON,
  waivers JSON, lineage: parent_inspection_id, reinspection_of_finding_id, created_by,
  soft-delete columns deleted_at/deleted_by/deleted_reason (super_admin only; every read path filters
  on `deleted_at IS NULL` via `scopeWhere`). **Finalized rows
  reject mutation at the service layer.**
- **products** — id, brand, generic_name, category, gtin, sku, batch_lot, package_form, package_type,
  pack_size, import_status, dimensions JSON. Linked to inspection (inspection_products).
- **entities** — responsible parties: id, role(manufacturer/packer/importer/brand_owner/seller/
  marketplace/care), name, address, contact JSON.
- **evidence_assets** — id, inspection_id, kind (image/pdf/screenshot/url/structured_listing), face_label
  (front/back/side/top/bottom/closeup/listing), sha256, size, mime, storage_key, source (camera/upload/
  url), captured_at (device time), received_at (server time), uploader_id, device JSON, gps JSON,
  url/marketplace/seller for e-comm, upload_state, legal_hold flag. **Original binary write-once,
  content-addressed by sha256.**
- **evidence_derivatives** — id, asset_id, operation, params JSON, sha256, storage_key, provider,
  model_version. Never replaces original. Written by the OCR stage when the provider prepares the image
  before reading it (operation `ocr_preprocess`, PaddleOCR path): params JSON carries the ordered list
  of OpenCV/Pillow operations applied — exif_transpose, resize, rotate, crop, clahe, denoise, sharpen —
  plus input and output pixel dimensions, so what was done to the officer's photograph is always
  answerable. One row per asset: re-processing replaces it.
- **calibrations** — id, asset_id, method (marker/known_dimension/device/manual), value_mm_per_px,
  uncertainty_pct, instrument, entered_by, notes. Absence ⇒ font checks Not Assessable.
- **quality_assessments** — id, asset_id, provider, model_version, is_mock, scores JSON (blur/glare/
  occlusion/resolution/text_scale/curvature/clipping/completeness), reason_codes JSON, recapture JSON.
- **layout_regions** — id, asset_id, kind (package_face/pdp/text_region/declaration_cluster/sticker),
  bbox JSON, confidence, provider/model_version/is_mock, edited_by (officer geometry corrections).
- **ocr_blocks** — id, asset_id, block_type(word/line), text (verbatim, Unicode), bbox JSON,
  reading_order, script (latin/devanagari/mixed), lang, confidence, provider, model_version, is_mock.
- **declarations** — merged statutory declaration candidates: id, inspection_id, decl_type (enum:
  responsible_entity, product_name, net_quantity, mrp, unit_sale_price, mfg_date, import_date,
  best_before, expiry, consumer_care, country_of_origin, dimensions, combination_info,
  category_specific…), verbatim_text, normalized_value JSON, unit, lang/script, confidence,
  needs_review flag + reasons, evidence_regions JSON [{asset_id, bbox, ocr_block_ids}] (provenance),
  presentation_mode (printed/molded/embossed/perforated), source_channel (physical/listing), version int.
- **declaration_corrections** — id, declaration_id, field, original_value, new_value, actor_id, reason,
  created_at. (EXT-06 — full before/after history.)
- **rule_sources** — id, title, citation, publisher, publication_date, url/file ref, sha256,
  legal_status ('APPROVED' | 'REQUIRES_LEGAL_APPROVAL').
- **rule_sets** — id, name, layer (base_lmpc/overlay/channel), category_scope JSON.
- **rule_versions** — id, rule_set_id, rule_key, version int, title, status (draft/submitted/approved/
  published/retired), source_id, citation, jurisdiction, effective_from, effective_to, transition JSON,
  applicability JSON, inputs JSON, logic JSON (check primitives), outcome JSON (severity/remediation/
  report_wording), author_id, approver_id (must differ), published_at, rollback_of, change_note,
  legal_status flag. **Published versions immutable.**
- **rule_tests** — id, rule_version_id/rule_key, name, fixture JSON (context+declarations+calibration),
  expected_outcome. Runnable pack per version (regression, diff, simulation).
- **category_routes** — category → overlay rule_set_id | specialist_review flag, source citation, dates.
- **evaluations** — id, inspection_id, run_id, rule_version_id (pinned), event_date, outcome (5-state),
  reason_code, explanation, citation, severity, evidence_refs JSON, input_snapshot JSON, model_versions
  JSON, engine_version, created_at. **Never updated; re-runs insert a new run.**
- **findings** — id, inspection_id, evaluation_id, status (open/confirmed/dismissed/deferred/overridden/
  na/not_assessable), severity, current disposition pointer.
- **finding_dispositions** — id, finding_id, action, from_outcome, to_outcome, reason (required),
  actor_id, requires_approval flag, approved_by (second-level, must differ), created_at. Versioned trail.
- **annotations** — id, inspection_id, asset_id, kind (rect/note/measure), bbox/points JSON, text,
  actor_id. Non-destructive.
- **notices** — id, inspection_id, kind (warning/improvement), template_key, served_at, due_date,
  response JSON, status (issued/responded/cured/not_cured/escalated/closed).
- **reports** / **report_versions** — report id per inspection; each version: number, snapshot JSON
  (full 8-section model), sha256, reason (for amendments), generated_by, finalized flag. Immutable.
- **processing_jobs** — id, type, target_id, status (queued/processing/completed/failed/dead_letter/
  cancelled), attempts, max_attempts, idempotency_key UNIQUE, correlation_id, error, progress,
  requested_model_versions JSON, timestamps.
- **model_versions** — id, component (quality/layout/ocr/extraction/font), name, version, is_mock,
  status (approved/deployed/retired), benchmark JSON, deployed_at.
- **audit_events** — id, seq INTEGER PK autoincrement, actor_id/service, action, object_type, object_id,
  before JSON, after JSON, outcome, source_ip, correlation_id, created_at, prev_hash, event_hash.
  **Append-only; hash-chained; no update/delete code path.**
- **search_index** — FTS5 virtual table over inspections/products/entities/declarations/ocr text with
  scope columns for filtering.
- **config_items** — versioned key/value config (units, currency phrases, checklist templates, severity
  policy, domain crawl policy, retention policy).

## Key relationships

inspection 1—n evidence_assets 1—n (derivatives, calibrations, quality, layout, ocr_blocks);
inspection 1—n declarations n—n ocr_blocks (via evidence_regions); inspection 1—n evaluations 1—1
finding 1—n dispositions; rule_set 1—n rule_versions 1—n rule_tests; inspection 1—1 report 1—n
report_versions; inspection lineage self-references; entities n—n inspections/products.

## Indexes

- inspections(org_id,state,district,office,status), inspections(assigned_to,status), inspections(event_date)
- evidence_assets(inspection_id), evidence_assets(sha256)
- ocr_blocks(asset_id), declarations(inspection_id, decl_type)
- rule_versions(rule_set_id, rule_key, status, effective_from)
- evaluations(inspection_id, run_id), findings(inspection_id,status)
- processing_jobs(status), processing_jobs(idempotency_key UNIQUE)
- audit_events(object_type,object_id), audit_events(actor_id)
- products(gtin), products(brand)
- FTS5 for full text

## Immutability / audit strategy

| Record | Strategy |
|---|---|
| Evidence original | Content-addressed file + sha256 row; store refuses overwrite |
| Published rule version | Status gate: no mutation after publish; new version required |
| Evaluation | Insert-only; new run per re-evaluation |
| Finalized finding/report | Service-layer lock + new version on amendment; prior versions retained |
| Audit event | Append-only + hash chain, verify endpoint |
| Corrections/dispositions | Insert-only history rows with before/after |

Reproducibility: any finalized finding = evidence hash + rule_version + model_versions + input_snapshot +
disposition trail, all pinned by IDs stored on the evaluation and frozen into the report snapshot.
