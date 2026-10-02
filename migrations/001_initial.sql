PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS regulators (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  acronym TEXT NOT NULL UNIQUE,
  jurisdiction TEXT NOT NULL DEFAULT 'Brazil',
  sector TEXT NOT NULL,
  website TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS regulations (
  id TEXT PRIMARY KEY,
  regulator_id TEXT NOT NULL REFERENCES regulators(id),
  type TEXT NOT NULL,
  number TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  publication_date TEXT,
  effective_date TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  source_url TEXT,
  content_hash TEXT,
  content_hash_scope TEXT,
  source_excerpt TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_regulations_regulator ON regulations(regulator_id);

CREATE TABLE IF NOT EXISTS regulatory_sources (
  id TEXT PRIMARY KEY,
  regulator_id TEXT NOT NULL REFERENCES regulators(id),
  regulation_id TEXT REFERENCES regulations(id),
  source_url TEXT NOT NULL,
  source_title TEXT NOT NULL,
  source_authority TEXT NOT NULL,
  source_type TEXT NOT NULL,
  content_hash TEXT,
  content_hash_scope TEXT,
  publication_date TEXT,
  effective_date TEXT,
  collected_at TEXT,
  version TEXT,
  mime_type TEXT,
  status TEXT NOT NULL DEFAULT 'DISCOVERED',
  excerpt TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source_url, version)
);
CREATE INDEX IF NOT EXISTS idx_sources_regulator ON regulatory_sources(regulator_id);
CREATE INDEX IF NOT EXISTS idx_sources_status ON regulatory_sources(status);

CREATE TABLE IF NOT EXISTS regulatory_source_links (
  source_id TEXT NOT NULL REFERENCES regulatory_sources(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  relation TEXT NOT NULL DEFAULT 'SUPPORTS',
  PRIMARY KEY(source_id, entity_type, entity_id, relation)
);

CREATE TABLE IF NOT EXISTS regulatory_obligations (
  id TEXT PRIMARY KEY,
  regulation_id TEXT NOT NULL REFERENCES regulations(id),
  regulator_id TEXT NOT NULL REFERENCES regulators(id),
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  affected_entities TEXT NOT NULL DEFAULT 'UNKNOWN',
  sector TEXT NOT NULL,
  category TEXT NOT NULL,
  frequency TEXT NOT NULL DEFAULT 'UNKNOWN',
  deadline_rule TEXT NOT NULL DEFAULT 'UNKNOWN',
  effective_date TEXT,
  submission_method TEXT NOT NULL DEFAULT 'UNKNOWN',
  submission_system TEXT NOT NULL DEFAULT 'UNKNOWN',
  output_format TEXT NOT NULL DEFAULT 'UNKNOWN',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  criticality TEXT NOT NULL DEFAULT 'MEDIUM',
  impact_score INTEGER NOT NULL DEFAULT 0,
  impact_level TEXT NOT NULL DEFAULT 'UNASSESSED',
  impact_rationale TEXT,
  owner TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_obligations_regulator ON regulatory_obligations(regulator_id);
CREATE INDEX IF NOT EXISTS idx_obligations_category ON regulatory_obligations(category);
CREATE INDEX IF NOT EXISTS idx_obligations_status ON regulatory_obligations(status);

CREATE TABLE IF NOT EXISTS requirements (
  id TEXT PRIMARY KEY,
  obligation_id TEXT NOT NULL REFERENCES regulatory_obligations(id) ON DELETE CASCADE,
  requirement_type TEXT NOT NULL,
  description TEXT NOT NULL,
  source_reference TEXT NOT NULL,
  source_id TEXT REFERENCES regulatory_sources(id),
  effective_from TEXT,
  effective_to TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0,1))
);
CREATE INDEX IF NOT EXISTS idx_requirements_obligation ON requirements(obligation_id);

CREATE TABLE IF NOT EXISTS regulatory_documents (
  id TEXT PRIMARY KEY,
  obligation_id TEXT NOT NULL REFERENCES regulatory_obligations(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  document_type TEXT NOT NULL,
  frequency TEXT NOT NULL DEFAULT 'UNKNOWN',
  output_format TEXT NOT NULL DEFAULT 'UNKNOWN',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  source_id TEXT REFERENCES regulatory_sources(id),
  adapter TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0,1)),
  UNIQUE(obligation_id, code)
);

CREATE TABLE IF NOT EXISTS canonical_data_elements (
  id TEXT PRIMARY KEY,
  qualified_name TEXT NOT NULL UNIQUE,
  domain TEXT NOT NULL,
  description TEXT NOT NULL,
  data_type TEXT NOT NULL,
  classification TEXT NOT NULL DEFAULT 'INTERNAL',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0,1))
);

CREATE TABLE IF NOT EXISTS schema_versions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES regulatory_documents(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  effective_from TEXT,
  effective_to TEXT,
  schema_type TEXT NOT NULL,
  schema_url TEXT,
  local_path TEXT,
  content_hash TEXT,
  content_hash_scope TEXT,
  fields_count INTEGER,
  field_inventory_scope TEXT NOT NULL DEFAULT 'NOT_PARSED',
  parse_status TEXT NOT NULL DEFAULT 'PENDING',
  adapter_config_json TEXT,
  status TEXT NOT NULL DEFAULT 'CURRENT',
  UNIQUE(document_id, version)
);

CREATE TABLE IF NOT EXISTS regulatory_fields (
  id TEXT PRIMARY KEY,
  schema_version_id TEXT NOT NULL REFERENCES schema_versions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  parent_path TEXT,
  description TEXT NOT NULL,
  data_type TEXT NOT NULL DEFAULT 'UNKNOWN',
  required INTEGER CHECK (required IN (0,1) OR required IS NULL),
  required_condition TEXT,
  min_occurs INTEGER,
  max_occurs TEXT,
  length INTEGER,
  precision INTEGER,
  scale INTEGER,
  domain TEXT,
  pattern TEXT,
  source_reference TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  UNIQUE(schema_version_id, path)
);
CREATE INDEX IF NOT EXISTS idx_reg_fields_name ON regulatory_fields(name);

CREATE TABLE IF NOT EXISTS regulatory_changes (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  old_version TEXT,
  new_version TEXT,
  change_type TEXT NOT NULL,
  field TEXT,
  old_value TEXT,
  new_value TEXT,
  detected_at TEXT NOT NULL,
  effective_at TEXT,
  severity TEXT NOT NULL DEFAULT 'UNASSESSED',
  source_reference TEXT NOT NULL,
  source_url TEXT,
  summary TEXT NOT NULL,
  confidence TEXT NOT NULL DEFAULT 'REVIEW_REQUIRED',
  review_status TEXT NOT NULL DEFAULT 'REVIEW_REQUIRED',
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0,1))
);
CREATE INDEX IF NOT EXISTS idx_changes_detected ON regulatory_changes(detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_changes_severity ON regulatory_changes(severity);

CREATE TABLE IF NOT EXISTS technical_impacts (
  id TEXT PRIMARY KEY,
  regulatory_change_id TEXT NOT NULL REFERENCES regulatory_changes(id) ON DELETE CASCADE,
  impact_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  score INTEGER NOT NULL,
  description TEXT NOT NULL,
  recommended_action TEXT NOT NULL,
  rationale TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS internal_systems (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  description TEXT NOT NULL,
  owner TEXT NOT NULL,
  criticality TEXT NOT NULL DEFAULT 'MEDIUM',
  is_demo INTEGER NOT NULL DEFAULT 1 CHECK (is_demo IN (0,1))
);

CREATE TABLE IF NOT EXISTS datasets (
  id TEXT PRIMARY KEY,
  system_id TEXT NOT NULL REFERENCES internal_systems(id),
  name TEXT NOT NULL,
  database_name TEXT,
  schema_name TEXT,
  description TEXT NOT NULL,
  owner TEXT NOT NULL,
  is_demo INTEGER NOT NULL DEFAULT 1 CHECK (is_demo IN (0,1)),
  UNIQUE(system_id, name)
);

CREATE TABLE IF NOT EXISTS data_fields (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  data_type TEXT NOT NULL,
  description TEXT NOT NULL,
  classification TEXT NOT NULL DEFAULT 'INTERNAL',
  canonical_element_id TEXT REFERENCES canonical_data_elements(id),
  is_demo INTEGER NOT NULL DEFAULT 1 CHECK (is_demo IN (0,1)),
  UNIQUE(dataset_id, name)
);
CREATE INDEX IF NOT EXISTS idx_data_fields_name ON data_fields(name);

CREATE TABLE IF NOT EXISTS canonical_mappings (
  id TEXT PRIMARY KEY,
  canonical_element_id TEXT NOT NULL REFERENCES canonical_data_elements(id),
  data_field_id TEXT NOT NULL REFERENCES data_fields(id),
  transformation TEXT NOT NULL DEFAULT 'IDENTITY',
  mapping_status TEXT NOT NULL DEFAULT 'REVIEW_REQUIRED',
  owner TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  is_demo INTEGER NOT NULL DEFAULT 1 CHECK (is_demo IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(canonical_element_id, data_field_id)
);

CREATE TABLE IF NOT EXISTS data_mappings (
  id TEXT PRIMARY KEY,
  regulatory_field_id TEXT NOT NULL REFERENCES regulatory_fields(id) ON DELETE CASCADE,
  data_field_id TEXT REFERENCES data_fields(id),
  canonical_element_id TEXT REFERENCES canonical_data_elements(id),
  transformation TEXT NOT NULL DEFAULT 'IDENTITY',
  sql_expression TEXT,
  python_expression TEXT,
  business_rule TEXT,
  mapping_status TEXT NOT NULL DEFAULT 'UNMAPPED',
  owner TEXT,
  approved_by TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  is_demo INTEGER NOT NULL DEFAULT 1 CHECK (is_demo IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(regulatory_field_id, data_field_id)
);
CREATE INDEX IF NOT EXISTS idx_mappings_status ON data_mappings(mapping_status);

CREATE TABLE IF NOT EXISTS pipelines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  technology TEXT NOT NULL,
  owner TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  is_demo INTEGER NOT NULL DEFAULT 1 CHECK (is_demo IN (0,1))
);

CREATE TABLE IF NOT EXISTS pipeline_dependencies (
  id TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  mapping_id TEXT NOT NULL REFERENCES data_mappings(id) ON DELETE CASCADE,
  dependency_type TEXT NOT NULL DEFAULT 'READS',
  is_demo INTEGER NOT NULL DEFAULT 1 CHECK (is_demo IN (0,1)),
  UNIQUE(pipeline_id, mapping_id, dependency_type)
);

CREATE TABLE IF NOT EXISTS dq_rules (
  id TEXT PRIMARY KEY,
  regulatory_field_id TEXT NOT NULL REFERENCES regulatory_fields(id) ON DELETE CASCADE,
  mapping_id TEXT REFERENCES data_mappings(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  rule_type TEXT NOT NULL,
  expression TEXT,
  severity TEXT NOT NULL DEFAULT 'MEDIUM',
  description TEXT NOT NULL,
  source TEXT NOT NULL,
  is_demo INTEGER NOT NULL DEFAULT 1 CHECK (is_demo IN (0,1))
);
CREATE INDEX IF NOT EXISTS idx_dq_rules_field ON dq_rules(regulatory_field_id);

CREATE TABLE IF NOT EXISTS demo_data (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES datasets(id),
  row_key TEXT NOT NULL,
  data_json TEXT NOT NULL,
  scenario TEXT NOT NULL DEFAULT 'happy_path',
  is_demo INTEGER NOT NULL DEFAULT 1 CHECK (is_demo IN (0,1)),
  UNIQUE(dataset_id, row_key)
);

CREATE TABLE IF NOT EXISTS dq_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  rules_evaluated INTEGER NOT NULL DEFAULT 0,
  passed INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  is_demo INTEGER NOT NULL DEFAULT 1 CHECK (is_demo IN (0,1))
);

CREATE TABLE IF NOT EXISTS dq_run_results (
  id TEXT PRIMARY KEY,
  dq_run_id TEXT NOT NULL REFERENCES dq_runs(id) ON DELETE CASCADE,
  dq_rule_id TEXT NOT NULL REFERENCES dq_rules(id),
  dataset_row_key TEXT,
  status TEXT NOT NULL,
  actual_value TEXT,
  expected TEXT,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  is_demo INTEGER NOT NULL DEFAULT 1 CHECK (is_demo IN (0,1))
);

CREATE TABLE IF NOT EXISTS regulatory_deadlines (
  id TEXT PRIMARY KEY,
  obligation_id TEXT NOT NULL REFERENCES regulatory_obligations(id) ON DELETE CASCADE,
  reference_period TEXT NOT NULL,
  due_date TEXT NOT NULL,
  deadline_type TEXT NOT NULL CHECK (deadline_type IN ('OFFICIAL','INTERNAL')),
  source_url TEXT,
  status TEXT NOT NULL DEFAULT 'UPCOMING',
  owner TEXT,
  calculation_basis TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0,1))
);
CREATE INDEX IF NOT EXISTS idx_deadlines_due ON regulatory_deadlines(due_date);

CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  obligation_id TEXT NOT NULL REFERENCES regulatory_obligations(id),
  reference_period TEXT NOT NULL,
  schema_version_id TEXT REFERENCES schema_versions(id),
  generated_at TEXT,
  submitted_at TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  artifact_path TEXT,
  output_format TEXT NOT NULL,
  payload_json TEXT,
  validation_summary TEXT,
  is_demo INTEGER NOT NULL DEFAULT 1 CHECK (is_demo IN (0,1))
);

CREATE TABLE IF NOT EXISTS validation_results (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  validation_type TEXT NOT NULL,
  rule TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  is_demo INTEGER NOT NULL DEFAULT 1 CHECK (is_demo IN (0,1))
);

CREATE TABLE IF NOT EXISTS regulatory_controls (
  id TEXT PRIMARY KEY,
  control_name TEXT NOT NULL,
  obligation_id TEXT NOT NULL REFERENCES regulatory_obligations(id),
  requirement_id TEXT REFERENCES requirements(id),
  owner TEXT NOT NULL,
  frequency TEXT NOT NULL,
  evidence_type TEXT NOT NULL,
  last_execution TEXT,
  result TEXT NOT NULL DEFAULT 'NOT_RUN',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  is_demo INTEGER NOT NULL DEFAULT 1 CHECK (is_demo IN (0,1))
);

CREATE TABLE IF NOT EXISTS evidence_items (
  id TEXT PRIMARY KEY,
  obligation_id TEXT REFERENCES regulatory_obligations(id),
  control_id TEXT REFERENCES regulatory_controls(id),
  evidence_type TEXT NOT NULL,
  title TEXT NOT NULL,
  artifact_path TEXT,
  collected_at TEXT NOT NULL,
  source_reference TEXT,
  content_hash TEXT,
  status TEXT NOT NULL DEFAULT 'AVAILABLE',
  is_demo INTEGER NOT NULL DEFAULT 1 CHECK (is_demo IN (0,1))
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  created_at TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'system'
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_events(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS regulatory_source_snapshots (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES regulatory_sources(id),
  response_url TEXT,
  content_hash TEXT NOT NULL,
  mime_type TEXT,
  collected_at TEXT NOT NULL,
  content BLOB NOT NULL,
  extracted_text TEXT,
  status TEXT NOT NULL DEFAULT 'RAW_CAPTURED',
  UNIQUE(source_id, content_hash)
);

CREATE TABLE IF NOT EXISTS job_runs (
  id TEXT PRIMARY KEY,
  job_name TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  records_processed INTEGER NOT NULL DEFAULT 0,
  records_created INTEGER NOT NULL DEFAULT 0,
  records_updated INTEGER NOT NULL DEFAULT 0,
  errors TEXT,
  result_json TEXT
);

CREATE TABLE IF NOT EXISTS ingestion_errors (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  error_type TEXT NOT NULL,
  message TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  resolved INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0,1)),
  source_id TEXT REFERENCES regulatory_sources(id),
  job_run_id TEXT REFERENCES job_runs(id)
);

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL REFERENCES pipelines(id),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  records_processed INTEGER NOT NULL DEFAULT 0,
  records_created INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  stages_json TEXT NOT NULL,
  is_demo INTEGER NOT NULL DEFAULT 1 CHECK (is_demo IN (0,1))
);

CREATE TABLE IF NOT EXISTS schema_diffs (
  id TEXT PRIMARY KEY,
  old_schema_version_id TEXT NOT NULL REFERENCES schema_versions(id),
  new_schema_version_id TEXT NOT NULL REFERENCES schema_versions(id),
  change_type TEXT NOT NULL,
  field_path TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  severity TEXT NOT NULL,
  rationale TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(old_schema_version_id, new_schema_version_id, change_type, field_path)
);

CREATE TABLE IF NOT EXISTS regulatory_extraction_candidates (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES regulatory_sources(id),
  entity_type TEXT NOT NULL,
  candidate_json TEXT NOT NULL,
  evidence_excerpt TEXT NOT NULL,
  confidence TEXT NOT NULL DEFAULT 'LOW',
  status TEXT NOT NULL DEFAULT 'REVIEW_REQUIRED',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS regulatory_cases (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  regulator_id TEXT NOT NULL REFERENCES regulators(id),
  obligation_id TEXT REFERENCES regulatory_obligations(id),
  scenario TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'REFERENCE',
  implementation_notes TEXT NOT NULL,
  source_id TEXT REFERENCES regulatory_sources(id),
  is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0,1))
);

CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
