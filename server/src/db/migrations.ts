// Portable SQL schema (SQLite now; column types chosen to map cleanly to PostgreSQL).
// Migrations run in order exactly once; recorded in schema_migrations.

export const migrations: { id: string; sql: string }[] = [
  {
    id: '001_core',
    sql: `
CREATE TABLE organizations (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, parent_id TEXT REFERENCES organizations(id),
  created_at TEXT NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  password_hash TEXT NOT NULL, role TEXT NOT NULL,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  state TEXT, district TEXT, office TEXT,
  status TEXT NOT NULL DEFAULT 'active',           -- invited|active|suspended|offboarded
  mfa_secret TEXT,                                  -- MFA-ready (IAM-01); enforcement is policy config
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, absolute_expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE role_permissions (role TEXT NOT NULL, permission TEXT NOT NULL, PRIMARY KEY(role, permission));

CREATE TABLE entities (
  id TEXT PRIMARY KEY, role TEXT NOT NULL, name TEXT NOT NULL, address TEXT,
  contact_json TEXT, created_at TEXT NOT NULL
);

CREATE TABLE inspections (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,            -- physical_retail|warehouse_import|back_office|complaint|ecommerce
  status TEXT NOT NULL DEFAULT 'draft', -- draft|capturing|processing|review|pending_approval|finalized|closed
  event_date TEXT NOT NULL,
  org_id TEXT NOT NULL, state TEXT, district TEXT, office TEXT,
  location TEXT, gps_json TEXT,
  seller_entity_id TEXT REFERENCES entities(id),
  assigned_to TEXT REFERENCES users(id),
  due_date TEXT, priority TEXT DEFAULT 'normal', sensitivity TEXT DEFAULT 'normal',
  checklist_json TEXT NOT NULL DEFAULT '{}',
  waivers_json TEXT NOT NULL DEFAULT '[]',
  parent_inspection_id TEXT REFERENCES inspections(id),
  reinspection_of_finding_id TEXT,
  notes TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_insp_scope ON inspections(org_id, state, district, office, status);
CREATE INDEX idx_insp_assigned ON inspections(assigned_to, status);
CREATE INDEX idx_insp_event ON inspections(event_date);

CREATE TABLE products (
  id TEXT PRIMARY KEY, inspection_id TEXT NOT NULL REFERENCES inspections(id),
  brand TEXT, generic_name TEXT, category TEXT, gtin TEXT, sku TEXT, batch_lot TEXT,
  package_form TEXT,            -- bottle|box|pouch|sachet|wrapper|...
  package_type TEXT,            -- retail|wholesale|combination|group|multipiece
  pack_size TEXT, import_status TEXT DEFAULT 'domestic',  -- domestic|imported
  presentation_mode TEXT DEFAULT 'printed',               -- printed|molded_embossed_perforated
  dimensions_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_products_insp ON products(inspection_id);
CREATE INDEX idx_products_gtin ON products(gtin);
CREATE INDEX idx_products_brand ON products(brand);

CREATE TABLE inspection_entities (
  inspection_id TEXT NOT NULL REFERENCES inspections(id),
  entity_id TEXT NOT NULL REFERENCES entities(id),
  PRIMARY KEY (inspection_id, entity_id)
);

CREATE TABLE evidence_assets (
  id TEXT PRIMARY KEY, inspection_id TEXT NOT NULL REFERENCES inspections(id),
  kind TEXT NOT NULL,            -- image|pdf|screenshot|url|structured_listing
  face_label TEXT,               -- front|back|side|top|bottom|closeup|listing|other
  sha256 TEXT, size_bytes INTEGER, mime TEXT, storage_key TEXT,
  original_name TEXT,
  source TEXT NOT NULL DEFAULT 'upload',  -- camera|upload|url
  url TEXT, marketplace TEXT, seller TEXT, structured_json TEXT,
  captured_at TEXT,              -- device-reported time (kept separate from server time)
  received_at TEXT NOT NULL,     -- server time
  uploader_id TEXT NOT NULL REFERENCES users(id),
  device_json TEXT, gps_json TEXT,
  upload_state TEXT NOT NULL DEFAULT 'synced', -- local|pending|uploading|synced|failed
  legal_hold INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_assets_insp ON evidence_assets(inspection_id);
CREATE INDEX idx_assets_hash ON evidence_assets(sha256);

CREATE TABLE evidence_derivatives (
  id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES evidence_assets(id),
  operation TEXT NOT NULL, params_json TEXT, sha256 TEXT, storage_key TEXT,
  provider TEXT NOT NULL, model_version TEXT NOT NULL, is_mock INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE calibrations (
  id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES evidence_assets(id),
  method TEXT NOT NULL,          -- marker|known_dimension|device|manual
  mm_per_px REAL NOT NULL, uncertainty_pct REAL, instrument TEXT, notes TEXT,
  entered_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);

CREATE TABLE quality_assessments (
  id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES evidence_assets(id),
  provider TEXT NOT NULL, model_version TEXT NOT NULL, is_mock INTEGER NOT NULL,
  scores_json TEXT NOT NULL, reason_codes_json TEXT NOT NULL, recapture_json TEXT NOT NULL,
  overall REAL NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX idx_quality_asset ON quality_assessments(asset_id);

CREATE TABLE layout_regions (
  id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES evidence_assets(id),
  kind TEXT NOT NULL,            -- package_face|pdp|text_region|declaration_cluster|sticker
  bbox_json TEXT NOT NULL, confidence REAL,
  provider TEXT NOT NULL, model_version TEXT NOT NULL, is_mock INTEGER NOT NULL,
  edited_by TEXT REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE INDEX idx_layout_asset ON layout_regions(asset_id);

CREATE TABLE ocr_blocks (
  id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES evidence_assets(id),
  block_type TEXT NOT NULL DEFAULT 'line',
  text TEXT NOT NULL, bbox_json TEXT NOT NULL, reading_order INTEGER,
  script TEXT, lang TEXT, confidence REAL,
  provider TEXT NOT NULL, model_version TEXT NOT NULL, is_mock INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_ocr_asset ON ocr_blocks(asset_id);

CREATE TABLE declarations (
  id TEXT PRIMARY KEY, inspection_id TEXT NOT NULL REFERENCES inspections(id),
  decl_type TEXT NOT NULL,
  verbatim_text TEXT NOT NULL,
  normalized_json TEXT,          -- normalized value + provenance back to verbatim
  unit TEXT, lang TEXT, script TEXT, confidence REAL,
  needs_review INTEGER NOT NULL DEFAULT 0, review_reasons_json TEXT DEFAULT '[]',
  evidence_regions_json TEXT NOT NULL DEFAULT '[]', -- [{assetId,bbox,ocrBlockIds}]
  presentation_mode TEXT DEFAULT 'printed',
  source_channel TEXT NOT NULL DEFAULT 'physical', -- physical|listing
  provider TEXT, model_version TEXT, is_mock INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_decl_insp ON declarations(inspection_id, decl_type);

CREATE TABLE declaration_corrections (
  id TEXT PRIMARY KEY, declaration_id TEXT NOT NULL REFERENCES declarations(id),
  field TEXT NOT NULL, original_value TEXT, new_value TEXT,
  actor_id TEXT NOT NULL REFERENCES users(id), reason TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX idx_corr_decl ON declaration_corrections(declaration_id);

CREATE TABLE rule_sources (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, citation TEXT NOT NULL, publisher TEXT,
  publication_date TEXT, url TEXT, sha256 TEXT,
  legal_status TEXT NOT NULL DEFAULT 'REQUIRES_LEGAL_APPROVAL', -- APPROVED|REQUIRES_LEGAL_APPROVAL
  created_at TEXT NOT NULL
);

CREATE TABLE rule_sets (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  layer TEXT NOT NULL,           -- base_lmpc|overlay|channel
  category_scope_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE rule_versions (
  id TEXT PRIMARY KEY, rule_set_id TEXT NOT NULL REFERENCES rule_sets(id),
  rule_key TEXT NOT NULL, version INTEGER NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', -- draft|submitted|approved|published|retired
  source_id TEXT REFERENCES rule_sources(id), citation TEXT NOT NULL,
  jurisdiction TEXT NOT NULL DEFAULT 'IN',
  effective_from TEXT NOT NULL, effective_to TEXT,
  transition_json TEXT,
  applicability_json TEXT NOT NULL,  -- predicates: categories, channels, packageTypes, importStatus...
  inputs_json TEXT NOT NULL,         -- required declaration types, calibration, geometry
  logic_json TEXT NOT NULL,          -- deterministic check primitives
  outcome_json TEXT NOT NULL,        -- severity, remediation, report wording
  legal_status TEXT NOT NULL DEFAULT 'REQUIRES_LEGAL_APPROVAL',
  author_id TEXT NOT NULL, approver_id TEXT,
  submitted_at TEXT, approved_at TEXT, published_at TEXT, retired_at TEXT,
  rollback_of TEXT, change_note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(rule_key, version)
);
CREATE INDEX idx_rv_select ON rule_versions(rule_set_id, status, effective_from);
CREATE INDEX idx_rv_key ON rule_versions(rule_key, status);

CREATE TABLE rule_tests (
  id TEXT PRIMARY KEY, rule_key TEXT NOT NULL, name TEXT NOT NULL,
  fixture_json TEXT NOT NULL, expected_outcome TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX idx_rt_key ON rule_tests(rule_key);

CREATE TABLE category_routes (
  id TEXT PRIMARY KEY, category TEXT NOT NULL UNIQUE,
  overlay_rule_set_id TEXT REFERENCES rule_sets(id),
  specialist_review INTEGER NOT NULL DEFAULT 0,
  excluded_rule_keys_json TEXT NOT NULL DEFAULT '[]', -- base rules displaced by the overlay
  citation TEXT, note TEXT, created_at TEXT NOT NULL
);

CREATE TABLE evaluations (
  id TEXT PRIMARY KEY, inspection_id TEXT NOT NULL REFERENCES inspections(id),
  run_id TEXT NOT NULL,
  rule_version_id TEXT NOT NULL REFERENCES rule_versions(id),
  rule_key TEXT NOT NULL, event_date TEXT NOT NULL,
  outcome TEXT NOT NULL,          -- passed|failed|needs_review|not_applicable|not_assessable
  reason_code TEXT NOT NULL, explanation TEXT NOT NULL, citation TEXT NOT NULL,
  severity TEXT, evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  input_snapshot_json TEXT NOT NULL, model_versions_json TEXT NOT NULL,
  engine_version TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX idx_eval_insp ON evaluations(inspection_id, run_id);

CREATE TABLE findings (
  id TEXT PRIMARY KEY, inspection_id TEXT NOT NULL REFERENCES inspections(id),
  evaluation_id TEXT NOT NULL REFERENCES evaluations(id),
  rule_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', -- open|confirmed|dismissed|deferred|overridden|not_applicable|not_assessable
  effective_outcome TEXT NOT NULL,     -- outcome after officer disposition (starts = evaluation outcome)
  severity TEXT, finalized INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_findings_insp ON findings(inspection_id, status);

CREATE TABLE finding_dispositions (
  id TEXT PRIMARY KEY, finding_id TEXT NOT NULL REFERENCES findings(id),
  action TEXT NOT NULL,           -- confirm|dismiss|defer|override|not_applicable|not_assessable
  from_outcome TEXT NOT NULL, to_outcome TEXT NOT NULL,
  reason TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id),
  requires_approval INTEGER NOT NULL DEFAULT 0,
  approved_by TEXT REFERENCES users(id), approved_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_disp_finding ON finding_dispositions(finding_id);

CREATE TABLE annotations (
  id TEXT PRIMARY KEY, inspection_id TEXT NOT NULL REFERENCES inspections(id),
  asset_id TEXT REFERENCES evidence_assets(id),
  kind TEXT NOT NULL,             -- rect|note|measure
  geometry_json TEXT, text TEXT,
  actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL
);

CREATE TABLE notices (
  id TEXT PRIMARY KEY, inspection_id TEXT NOT NULL REFERENCES inspections(id),
  kind TEXT NOT NULL,             -- warning|improvement
  template_key TEXT, served_at TEXT, due_date TEXT,
  response_json TEXT, status TEXT NOT NULL DEFAULT 'issued', -- issued|responded|cured|not_cured|escalated|closed
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE reports (
  id TEXT PRIMARY KEY, inspection_id TEXT NOT NULL UNIQUE REFERENCES inspections(id),
  current_version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);

CREATE TABLE report_versions (
  id TEXT PRIMARY KEY, report_id TEXT NOT NULL REFERENCES reports(id),
  version INTEGER NOT NULL, snapshot_json TEXT NOT NULL, sha256 TEXT NOT NULL,
  reason TEXT, generated_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
  UNIQUE(report_id, version)
);

CREATE TABLE processing_jobs (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, target_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued', -- queued|processing|completed|failed|dead_letter|cancelled
  attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3,
  idempotency_key TEXT NOT NULL UNIQUE, correlation_id TEXT NOT NULL,
  error TEXT, progress INTEGER NOT NULL DEFAULT 0,
  requested_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX idx_jobs_status ON processing_jobs(status);

CREATE TABLE model_versions (
  id TEXT PRIMARY KEY, component TEXT NOT NULL, name TEXT NOT NULL, version TEXT NOT NULL,
  is_mock INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'deployed',
  benchmark_json TEXT, deployed_at TEXT, created_at TEXT NOT NULL,
  UNIQUE(component, name, version)
);

CREATE TABLE audit_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  actor_id TEXT, actor_label TEXT NOT NULL,
  action TEXT NOT NULL, object_type TEXT, object_id TEXT,
  before_json TEXT, after_json TEXT,
  outcome TEXT NOT NULL DEFAULT 'success',
  source_ip TEXT, correlation_id TEXT,
  created_at TEXT NOT NULL,
  prev_hash TEXT NOT NULL, event_hash TEXT NOT NULL
);
CREATE INDEX idx_audit_object ON audit_events(object_type, object_id);
CREATE INDEX idx_audit_actor ON audit_events(actor_id);

CREATE TABLE config_items (
  key TEXT PRIMARY KEY, value_json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT, updated_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE search_index USING fts5(
  doc_id UNINDEXED, doc_type UNINDEXED, org_id UNINDEXED, state UNINDEXED,
  district UNINDEXED, office UNINDEXED, inspection_id UNINDEXED, content
);
`,
  },
  {
    // Offline draft sync (MOB-01/02, UAT-11): a client-generated reference makes
    // draft upload idempotent — retried syncs return the existing inspection
    // instead of creating a duplicate.
    id: '002_client_ref',
    sql: `
ALTER TABLE inspections ADD COLUMN client_ref TEXT;
CREATE INDEX idx_insp_client_ref ON inspections(created_by, client_ref);
`,
  },
];
