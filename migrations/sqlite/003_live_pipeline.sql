-- 003_live_pipeline: real official-source ingestion, durable snapshots, change levels,
-- provenance metadata and job observability. Additive only — never destructive.

-- Source registry: adapter-driven official monitoring configuration.
ALTER TABLE regulatory_sources ADD COLUMN authority TEXT;
ALTER TABLE regulatory_sources ADD COLUMN adapter TEXT;
ALTER TABLE regulatory_sources ADD COLUMN parser TEXT;
ALTER TABLE regulatory_sources ADD COLUMN polling_frequency_minutes INTEGER;
ALTER TABLE regulatory_sources ADD COLUMN discovery_strategy TEXT;
ALTER TABLE regulatory_sources ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE regulatory_sources ADD COLUMN last_checked_at TEXT;
ALTER TABLE regulatory_sources ADD COLUMN last_attempt_at TEXT;
ALTER TABLE regulatory_sources ADD COLUMN last_http_status INTEGER;
ALTER TABLE regulatory_sources ADD COLUMN etag TEXT;
ALTER TABLE regulatory_sources ADD COLUMN last_modified TEXT;
ALTER TABLE regulatory_sources ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE regulatory_sources ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE regulatory_sources ADD COLUMN last_error TEXT;
ALTER TABLE regulatory_sources ADD COLUMN current_snapshot_id TEXT;

-- Snapshots: immutable captures of real official bytes with full HTTP provenance.
ALTER TABLE regulatory_source_snapshots ADD COLUMN authority TEXT;
ALTER TABLE regulatory_source_snapshots ADD COLUMN source_type TEXT;
ALTER TABLE regulatory_source_snapshots ADD COLUMN http_status INTEGER;
ALTER TABLE regulatory_source_snapshots ADD COLUMN etag TEXT;
ALTER TABLE regulatory_source_snapshots ADD COLUMN last_modified TEXT;
ALTER TABLE regulatory_source_snapshots ADD COLUMN content_length INTEGER;
ALTER TABLE regulatory_source_snapshots ADD COLUMN content_size INTEGER;
ALTER TABLE regulatory_source_snapshots ADD COLUMN storage_provider TEXT;
ALTER TABLE regulatory_source_snapshots ADD COLUMN raw_storage_path TEXT;
ALTER TABLE regulatory_source_snapshots ADD COLUMN parser TEXT;
ALTER TABLE regulatory_source_snapshots ADD COLUMN parse_status TEXT NOT NULL DEFAULT 'PENDING';
ALTER TABLE regulatory_source_snapshots ADD COLUMN parse_error TEXT;
ALTER TABLE regulatory_source_snapshots ADD COLUMN diff_type TEXT;
ALTER TABLE regulatory_source_snapshots ADD COLUMN diff_summary TEXT;
ALTER TABLE regulatory_source_snapshots ADD COLUMN previous_snapshot_id TEXT;
ALTER TABLE regulatory_source_snapshots ADD COLUMN fields_json TEXT;

-- Changes: explicit detection levels (source hash vs content vs regulatory candidate/confirmed).
ALTER TABLE regulatory_changes ADD COLUMN change_level TEXT NOT NULL DEFAULT 'LEGACY';
ALTER TABLE regulatory_changes ADD COLUMN previous_snapshot_id TEXT;
ALTER TABLE regulatory_changes ADD COLUMN current_snapshot_id TEXT;
ALTER TABLE regulatory_changes ADD COLUMN diff_type TEXT;
ALTER TABLE regulatory_changes ADD COLUMN diff_summary TEXT;

-- Job runs: real observability counters for ingestion execution.
ALTER TABLE job_runs ADD COLUMN sources_checked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE job_runs ADD COLUMN sources_changed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE job_runs ADD COLUMN sources_unchanged INTEGER NOT NULL DEFAULT 0;
ALTER TABLE job_runs ADD COLUMN sources_failed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE job_runs ADD COLUMN snapshot_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE job_runs ADD COLUMN duration_ms INTEGER;
ALTER TABLE job_runs ADD COLUMN manual_trigger TEXT NOT NULL DEFAULT 'manual';

-- Ingestion errors: retry bookkeeping.
ALTER TABLE ingestion_errors ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE ingestion_errors ADD COLUMN http_status INTEGER;

-- Verification ledger: every check performed against an official source, including 304
-- responses that legitimately produce no new snapshot bytes.
CREATE TABLE IF NOT EXISTS source_verification_checks (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES regulatory_sources(id),
  checked_at TEXT NOT NULL,
  http_status INTEGER,
  outcome TEXT NOT NULL,
  content_hash TEXT,
  etag TEXT,
  last_modified TEXT,
  job_run_id TEXT REFERENCES job_runs(id),
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_verification_source ON source_verification_checks(source_id, checked_at DESC);

-- Durable object storage fallback when STORAGE_PROVIDER=database.
CREATE TABLE IF NOT EXISTS storage_objects (
  key TEXT PRIMARY KEY,
  content_type TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  content BLOB NOT NULL
);

-- Snapshot immutability: historical raw captures are append-only. The captured bytes, hash,
-- URL and timestamps can never be overwritten or deleted; only downstream parse/diff metadata
-- may be updated. Corrections to parsing happen through new state on the same row or a new snapshot.
CREATE TRIGGER IF NOT EXISTS trg_snapshots_no_raw_update BEFORE UPDATE OF content, content_hash, source_id, response_url, collected_at, mime_type, storage_provider, raw_storage_path, http_status, content_length, content_size ON regulatory_source_snapshots
BEGIN
  SELECT RAISE(ABORT, 'regulatory_source_snapshots raw capture fields are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_snapshots_no_delete BEFORE DELETE ON regulatory_source_snapshots
BEGIN
  SELECT RAISE(ABORT, 'regulatory_source_snapshots are immutable');
END;

CREATE INDEX IF NOT EXISTS idx_sources_enabled_due ON regulatory_sources(enabled, last_checked_at);
CREATE INDEX IF NOT EXISTS idx_snapshots_source_time ON regulatory_source_snapshots(source_id, collected_at DESC);
CREATE INDEX IF NOT EXISTS idx_changes_level ON regulatory_changes(change_level, detected_at DESC);
