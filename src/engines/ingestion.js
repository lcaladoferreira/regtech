/**
 * Official-source ingestion pipeline (real collection, not a demo).
 *
 *   official source → fetch (conditional GET) → raw snapshot → SHA-256 → metadata
 *     → content extraction (parser) → comparison with previous snapshot
 *     → candidate change → human review → regulatory change → technical impact → dashboard
 *
 * Invariants enforced here:
 * - HTTPS only, official-host allowlist, re-checked on every redirect hop;
 * - every capture is an immutable append-only snapshot row plus durable raw bytes;
 * - a hash change records SOURCE_CHANGED only — never an automatic REGULATORY_CHANGE_CONFIRMED;
 * - fetch failures are retried with backoff, then persisted in ingestion_errors (visible in UI);
 * - HTTP 304 responses are recorded as verification checks without duplicating bytes;
 * - parsers that cannot extract text leave parse_status=UNSTRUCTURED/FAILED — never fake output.
 */
import { createHash, randomUUID } from 'node:crypto';
import { calculateImpacts } from './impact-engine.js';
import { compareNormativeText, compareSchemas } from './schema-diff.js';
import { parseSnapshot, parserFor } from '../parsers/index.js';
import { createStorage } from '../storage.js';
import { syncOfficialRegistry } from '../sources/index.js';

const ALLOWED_HOSTS = ['gov.br', 'bcb.gov.br', 'cvm.gov.br', 'planalto.gov.br', 'in.gov.br'];
const MAX_BYTES = 12 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 9000;
const DEFAULT_ATTEMPTS = 3;
const BACKOFF_MS = [400, 1500];

export const JOB_NAMES = Object.freeze([
  'collect_sources', 'parse_sources', 'detect_versions', 'detect_changes',
  'extract_obligations', 'extract_schemas', 'calculate_impacts', 'update_deadlines',
  'run_quality', 'generate_submissions',
]);

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function isOfficialSourceUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:' && !url.username && !url.password
      && (!url.port || url.port === '443')
      && ALLOWED_HOSTS.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

/**
 * Collects official sources. `dueOnly` respects each source's polling_frequency_minutes so a
 * cron can run frequently without hammering the authority. Explicit sourceIds always run.
 */
export async function runCollectSources(db, options = {}) {
  const {
    sourceIds = [], limit = 25, dueOnly = true, fetcher = fetch, timeoutMs = DEFAULT_TIMEOUT_MS,
    attempts = DEFAULT_ATTEMPTS, trigger = 'manual', storage: injectedStorage = null, sleep = sleepMs,
  } = options;
  await syncOfficialRegistry(db);
  const storage = injectedStorage || await createStorage({ db });
  const run = await startJobRun(db, 'collect_sources', trigger);
  let rows;
  if (sourceIds.length) {
    rows = await db.prepare(`SELECT * FROM regulatory_sources WHERE id IN (${sourceIds.map(() => '?').join(',')}) ORDER BY id`).all(...sourceIds);
  } else {
    // Polling due windows are computed in JavaScript — portable across SQLite and PostgreSQL.
    const candidates = await db.prepare(`SELECT * FROM regulatory_sources WHERE enabled = 1
      ORDER BY CASE WHEN current_snapshot_id IS NULL THEN 0 ELSE 1 END, COALESCE(polling_frequency_minutes, 1440), regulator_id, id
      LIMIT 200`).all();
    const nowMs = Date.now();
    rows = candidates.filter((source) => {
      if (!dueOnly) return true;
      if (!source.last_checked_at) return true;
      const minutes = Number(source.polling_frequency_minutes || 1440);
      return nowMs - new Date(source.last_checked_at).getTime() >= minutes * 60_000;
    }).slice(0, Math.max(1, Math.min(50, Number(limit) || 25)));
  }

  const results = [];
  let checked = 0;
  let changed = 0;
  let unchanged = 0;
  let failed = 0;
  let snapshots = 0;
  const errorSummaries = [];

  for (const source of rows) {
    checked += 1;
    const started = Date.now();
    if (!isOfficialSourceUrl(source.source_url)) {
      const errorId = await logIngestionError(db, run.id, source, 'SOURCE_NOT_ALLOWLISTED', 'A coleta aceita somente HTTPS em domínios oficiais allowlistados.');
      errorSummaries.push({ source_id: source.id, error_id: errorId, message: 'BLOCKED_NON_OFFICIAL_HOST' });
      results.push({ source_id: source.id, status: 'BLOCKED_NON_OFFICIAL_HOST' });
      failed += 1;
      continue;
    }
    try {
      const outcome = await collectOneSource(db, storage, source, { fetcher, timeoutMs, attempts, runId: run.id, sleep });
      results.push(outcome);
      if (outcome.status === 'CAPTURED_CHANGED' || outcome.status === 'CAPTURED_FIRST') { changed += 1; snapshots += 1; }
      else if (outcome.status === 'UNCHANGED_HASH' || outcome.status === 'UNCHANGED_304') unchanged += 1;
      else if (outcome.status === 'ERROR') { failed += 1; errorSummaries.push({ source_id: source.id, message: outcome.error }); }
      else unchanged += 1;
    } catch (error) {
      failed += 1;
      const message = String(error?.message || error).slice(0, 900);
      const errorId = await logIngestionError(db, run.id, source, error?.name || 'FETCH_ERROR', message, { attempts: DEFAULT_ATTEMPTS, httpStatus: error?.httpStatus ?? null });
      errorSummaries.push({ source_id: source.id, error_id: errorId, message });
      results.push({ source_id: source.id, status: 'ERROR', error: message, duration_ms: Date.now() - started });
    }
  }
  const status = failed === 0 ? 'SUCCEEDED' : (changed || unchanged ? 'PARTIAL' : 'FAILED');
  await finishJobRun(db, run.id, { status,
    processed: checked, created: snapshots, updated: unchanged + changed,
    errors: errorSummaries.length ? JSON.stringify(errorSummaries.slice(0, 20)) : null,
    sources_checked: checked, sources_changed: changed, sources_unchanged: unchanged, sources_failed: failed,
    snapshot_count: snapshots, result: { results: results.slice(0, 50), raw_snapshots_are_immutable: true, storage_provider: storage.provider },
  });
  return { job_run_id: run.id, status, processed: checked, changed, unchanged, failed, created: snapshots, errors: errorSummaries.length, results };
}

async function collectOneSource(db, storage, source, { fetcher, timeoutMs, attempts, runId, sleep }) {
  const collectedAt = new Date().toISOString();
  await db.prepare('UPDATE regulatory_sources SET last_attempt_at = ?, retry_count = retry_count + 1 WHERE id = ?').run(collectedAt, source.id);

  const conditional = {};
  if (source.etag && source.current_snapshot_id) conditional['If-None-Match'] = source.etag;
  if (source.last_modified && source.current_snapshot_id) conditional['If-Modified-Since'] = source.last_modified;

  let response = null;
  let lastError = null;
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      response = await fetchOfficialSource(source.source_url, fetcher, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'LCF-Regulatory-Data-Intelligence/0.2 (+official-source-audit; contact: data-intelligence@lcf.example)',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json,text/csv,application/pdf,*/*;q=0.8',
          'Accept-Encoding': 'identity',
          ...conditional,
        },
      });
      if (response.status >= 500 && attempt < attempts) { lastError = httpError(response.status); response = null; await sleep(BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]); continue; }
      lastError = null;
      break;
    } catch (error) {
      lastError = error?.name === 'AbortError' ? new Error(`Request timed out after ${timeoutMs} ms (attempt ${attempt}).`) : error;
      response = null;
      if (attempt < attempts) await sleep(BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]);
    }
  }

  if (!response) {
    await markSourceFailure(db, source, 'FETCH_ERROR', String(lastError?.message || lastError).slice(0, 900), collectedAt, runId, { attempts, httpStatus: lastError?.httpStatus ?? null });
    return { source_id: source.id, status: 'ERROR', error: String(lastError?.message || lastError).slice(0, 400) };
  }

  if (response.status === 304) {
    await recordVerification(db, source, runId, { http_status: 304, outcome: 'UNCHANGED_304', etag: source.etag, last_modified: source.last_modified, detail: 'Conditional GET validated by the official server; no new bytes needed.' });
    await db.prepare(`UPDATE regulatory_sources SET last_checked_at = ?, last_http_status = 304, status = CASE WHEN current_snapshot_id IS NOT NULL THEN 'RAW_UNCHANGED' ELSE status END,
        consecutive_failures = 0, last_error = NULL, etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified) WHERE id = ?`)
      .run(collectedAt, response.headers?.get?.('etag'), response.headers?.get?.('last-modified'), source.id);
    await resolveOpenErrors(db, source.id);
    return { source_id: source.id, status: 'UNCHANGED_304' };
  }

  if (!response.ok) {
    const message = `HTTP ${response.status} ${response.statusText || ''}`.trim();
    await markSourceFailure(db, source, 'HTTP_ERROR', message, collectedAt, runId, { attempts, httpStatus: response.status });
    return { source_id: source.id, status: 'ERROR', error: message, http_status: response.status };
  }

  const contentLengthHeader = Number(response.headers?.get?.('content-length') || 0);
  if (contentLengthHeader > MAX_BYTES) throw new Error(`Source exceeds ${MAX_BYTES} byte collection limit (Content-Length ${contentLengthHeader}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_BYTES) throw new Error(`Source exceeds ${MAX_BYTES} byte collection limit (${bytes.length}).`);
  const hash = sha256(bytes);
  const mimeType = response.headers?.get?.('content-type')?.split(';')[0] || source.mime_type || 'application/octet-stream';
  const etag = response.headers?.get?.('etag') || null;
  const lastModified = response.headers?.get?.('last-modified') || null;

  const previous = await db.prepare('SELECT id, content_hash, extracted_text, fields_json, mime_type, storage_provider, raw_storage_path FROM regulatory_source_snapshots WHERE source_id = ? ORDER BY collected_at DESC, id DESC LIMIT 1').get(source.id);
  if (previous && previous.content_hash === hash) {
    await recordVerification(db, source, runId, { http_status: 200, outcome: 'UNCHANGED_HASH', content_hash: hash, etag, last_modified: lastModified, detail: 'Re-fetched payload matches the newest immutable snapshot hash.' });
    await db.prepare(`UPDATE regulatory_sources SET last_checked_at = ?, collected_at = ?, last_http_status = 200, status = 'RAW_UNCHANGED', consecutive_failures = 0, last_error = NULL,
        etag = ?, last_modified = ?, mime_type = ?, content_hash = ?, content_hash_scope = 'RAW_RESPONSE_SHA256' WHERE id = ?`)
      .run(collectedAt, collectedAt, etag, lastModified, mimeType, hash, source.id);
    await resolveOpenErrors(db, source.id);
    return { source_id: source.id, status: 'UNCHANGED_HASH', content_hash: hash, bytes: bytes.length };
  }

  // New or changed content: durable raw bytes + immutable snapshot + metadata + diff + candidates.
  const key = `snapshots/${safeKey(source.id)}/${hash}`;
  const saved = await storage.save(key, bytes, { contentType: mimeType });
  const parse = parseSnapshot(parserFor(mimeType, source.parser), bytes, mimeType);
  const diff = buildDiff(previous, parse);
  const snapshotId = randomUUID();
  const snapshotValues = {
    id: snapshotId, source_id: source.id, response_url: response.url || source.source_url, content_hash: hash,
    mime_type: mimeType, collected_at: collectedAt, status: parse.parse_status === 'PARSED_TEXT' || parse.parse_status === 'PARSED_STRUCTURED' ? 'PARSED_TEXT' : 'RAW_CAPTURED',
    authority: source.authority || source.source_authority, source_type: source.source_type, http_status: response.status,
    etag, last_modified: lastModified, content_length: contentLengthHeader || bytes.length, content_size: bytes.length,
    storage_provider: saved.provider, raw_storage_path: saved.key, parser: parse.parser,
    parse_status: parse.parse_status, parse_error: parse.parse_status === 'FAILED' ? parse.notes : null,
    diff_type: diff.diff_type, diff_summary: diff.diff_summary, previous_snapshot_id: previous ? previous.id : null,
    extracted_text: parse.extracted_text,
    fields_json: parse.fields && parse.fields.length ? JSON.stringify(parse.fields.slice(0, 500)) : null,
  };
  // SQLite (dev/test only) keeps the bytes inline because the legacy snapshots table column is
  // NOT NULL; PostgreSQL production relies on the durable storage provider pointer.
  if (db.dialect === 'sqlite') snapshotValues.content = bytes;
  await insertSnapshot(db, snapshotValues);

  const changeIds = [];
  if (previous) {
    const changeId = await registerSourceChange(db, source, previous, snapshotValues, diff);
    if (changeId) changeIds.push(changeId);
    if (diff.regulatoryCues.length) {
      const candidateId = await registerRegulatoryCandidate(db, source, snapshotValues, diff);
      if (candidateId) changeIds.push(candidateId);
    }
  }
  await recordVerification(db, source, runId, { http_status: 200, outcome: previous ? 'CHANGED' : 'FIRST_CAPTURE', content_hash: hash, etag, last_modified: lastModified, detail: `Snapshot ${snapshotId} stored via "${saved.provider}" provider. Changes: ${changeIds.length}.` });
  await db.prepare(`UPDATE regulatory_sources SET content_hash = ?, content_hash_scope = 'RAW_RESPONSE_SHA256', collected_at = ?, last_checked_at = ?, last_http_status = 200,
      mime_type = ?, etag = ?, last_modified = ?, status = 'RAW_CAPTURED', current_snapshot_id = ?, consecutive_failures = 0, last_error = NULL WHERE id = ?`)
    .run(hash, collectedAt, collectedAt, mimeType, etag, lastModified, snapshotId, source.id);
  await resolveOpenErrors(db, source.id);
  return { source_id: source.id, status: previous ? 'CAPTURED_CHANGED' : 'CAPTURED_FIRST', content_hash: hash, bytes: bytes.length, mime_type: mimeType, snapshot_id: snapshotId, parse_status: parse.parse_status, changes: changeIds, storage: saved.provider, diff_type: diff.diff_type };
}

function buildDiff(previousSnapshot, parse) {
  if (!previousSnapshot) return { diff_type: 'FIRST_CAPTURE', diff_summary: 'First raw capture of this official source; there is no previous snapshot to compare.', regulatoryCues: [] };
  const oldText = previousSnapshot.extracted_text || null;
  const newText = parse.extracted_text || null;
  if (oldText && newText) {
    const textDiff = compareNormativeText(oldText, newText);
    const cues = textDiff.cues || [];
    return {
      diff_type: 'TEXT_DIFF',
      diff_summary: `Text diff vs previous snapshot: ${textDiff.added.length} line(s) added, ${textDiff.removed.length} line(s) removed${cues.length ? `; normative keyword cues: ${cues.join(', ')}` : '; no normative keyword cue detected'}. Requires human review.`,
      regulatoryCues: cues,
      textDiff,
    };
  }
  const oldFields = previousSnapshot.fields_json ? JSON.parse(previousSnapshot.fields_json) : [];
  if (oldFields.length && parse.fields.length) {
    const schemaChanges = compareSchemas(oldFields, parse.fields);
    return {
      diff_type: 'STRUCTURE_DIFF',
      diff_summary: `Structure diff vs previous snapshot: ${schemaChanges.length} field-level change(s) ${schemaChanges.length ? `(${[...new Set(schemaChanges.map((row) => row.change_type))].join(', ')})` : ''}. Requires human review.`,
      regulatoryCues: [],
      schemaChanges,
    };
  }
  return {
    diff_type: 'HASH_ONLY',
    diff_summary: `Raw bytes differ (SHA-256 ${previousSnapshot.content_hash.slice(0, 12)}… → ${sha256Preview(parse.extracted_text)}) but at least one side has no comparable text layer; semantic diff is NOT attempted and the change remains UNASSESSED.`,
    regulatoryCues: [],
  };
}

function sha256Preview(text) {
  return text ? `${String(text).length} chars extracted` : 'no text';
}

async function insertSnapshot(db, snapshot) {
  const columns = Object.keys(snapshot);
  await db.prepare(`INSERT INTO regulatory_source_snapshots (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    .run(...columns.map((column) => snapshot[column] === undefined ? null : snapshot[column]));
}

async function registerSourceChange(db, source, previousSnapshot, snapshotValues, diff) {
  const existing = await db.prepare(`SELECT id FROM regulatory_changes WHERE entity_type = 'SOURCE' AND entity_id = ? AND change_level = 'SOURCE_CHANGED' AND old_version = ? AND new_version = ?`)
    .get(source.id, previousSnapshot.content_hash, snapshotValues.content_hash);
  if (existing) return null;
  const id = randomUUID();
  await db.prepare(`INSERT INTO regulatory_changes
      (id, entity_type, entity_id, old_version, new_version, change_type, field, old_value, new_value, detected_at,
       severity, source_reference, source_url, summary, confidence, review_status, is_demo,
       change_level, previous_snapshot_id, current_snapshot_id, diff_type, diff_summary)
    VALUES (?, 'SOURCE', ?, ?, ?, 'SOURCE_HASH_CHANGED', 'official source content', ?, ?, ?, 'UNASSESSED', ?, ?, ?, ?, 'REVIEW_REQUIRED', 0,
       'SOURCE_CHANGED', ?, ?, ?, ?)`)
    .run(id, source.id, previousSnapshot.content_hash, snapshotValues.content_hash, previousSnapshot.content_hash, snapshotValues.content_hash,
      snapshotValues.collected_at, `${source.source_title} (${source.authority || source.source_authority})`, source.source_url,
      `Hash do conteúdo oficial mudou (${previousSnapshot.content_hash.slice(0, 12)}… → ${snapshotValues.content_hash.slice(0, 12)}…). ${diff.diff_summary} Nenhuma conclusão regulatória automática foi registrada.`,
      'HASH_ONLY', previousSnapshot.id, snapshotValues.id, diff.diff_type, diff.diff_summary.slice(0, 4000));
  return id;
}

async function registerRegulatoryCandidate(db, source, snapshotValues, diff) {
  const id = randomUUID();
  const cues = diff.regulatoryCues.join(', ');
  await db.prepare(`INSERT INTO regulatory_changes
      (id, entity_type, entity_id, old_version, new_version, change_type, field, old_value, new_value, detected_at,
       severity, source_reference, source_url, summary, confidence, review_status, is_demo,
       change_level, previous_snapshot_id, current_snapshot_id, diff_type, diff_summary)
    VALUES (?, 'SOURCE', ?, ?, ?, 'DOCUMENTATION_CHANGED', 'text diff cues', NULL, NULL, ?, 'UNASSESSED', ?, ?, ?, 'TEXT_CUES_NEEDS_REVIEW', 'REVIEW_REQUIRED', 0,
       'REGULATORY_CHANGE_CANDIDATE', ?, ?, 'TEXT_DIFF', ?)`)
    .run(id, source.id, 'previous snapshot text layer', 'current snapshot text layer', snapshotValues.collected_at,
      `${source.source_title} — candidate`, source.source_url,
      `Mudança candidata após diff de texto na fonte oficial (cues: ${cues}). Este registro NÃO é conclusão jurídica; exige revisão humana antes de virar REGULATORY_CHANGE_CONFIRMED.`,
      snapshotValues.previous_snapshot_id, snapshotValues.id, diff.diff_summary.slice(0, 4000));
  return id;
}

async function markSourceFailure(db, source, errorType, message, timestamp, jobRunId, { attempts = 1, httpStatus = null } = {}) {
  await db.prepare(`UPDATE regulatory_sources SET last_checked_at = ?, last_http_status = ?, consecutive_failures = consecutive_failures + 1, last_error = ?,
      status = CASE WHEN current_snapshot_id IS NOT NULL THEN 'MONITOR_ERROR' ELSE 'FETCH_ERROR' END WHERE id = ?`)
    .run(timestamp, httpStatus, `${errorType}: ${message}`.slice(0, 900), source.id);
  await logIngestionError(db, jobRunId, source, errorType, message, { attempts, httpStatus, dedupeWindowHours: 24 });
}

async function logIngestionError(db, jobRunId, source, errorType, message, { attempts = 1, httpStatus = null, dedupeWindowHours = 0 } = {}) {
  const id = randomUUID();
  if (dedupeWindowHours) {
    const since = new Date(Date.now() - dedupeWindowHours * 3600_000).toISOString();
    const open = await db.prepare('SELECT id FROM ingestion_errors WHERE source_id = ? AND resolved = 0 AND error_type = ? AND timestamp >= ?').get(source?.id || null, errorType, since);
    if (open) {
      await db.prepare('UPDATE ingestion_errors SET message = ?, timestamp = ?, attempt_count = attempt_count + ?, http_status = COALESCE(?, http_status) WHERE id = ?')
        .run(message, new Date().toISOString(), attempts, httpStatus, open.id);
      return open.id;
    }
  }
  await db.prepare(`INSERT INTO ingestion_errors (id, source, error_type, message, timestamp, retry_count, resolved, source_id, job_run_id, attempt_count, http_status)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`)
    .run(id, source?.source_url || 'unknown', errorType, message, new Date().toISOString(), attempts - 1, source?.id || null, jobRunId, attempts, httpStatus);
  return id;
}

async function resolveOpenErrors(db, sourceId) {
  await db.prepare('UPDATE ingestion_errors SET resolved = 1 WHERE source_id = ? AND resolved = 0').run(sourceId);
}

async function recordVerification(db, source, jobRunId, fields) {
  await db.prepare(`INSERT INTO source_verification_checks (id, source_id, checked_at, http_status, outcome, content_hash, etag, last_modified, job_run_id, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), source.id, new Date().toISOString(), fields.http_status ?? null, fields.outcome, fields.content_hash ?? null,
      fields.etag ?? null, fields.last_modified ?? null, jobRunId, fields.detail ?? null);
}

export async function runParseSources(db, { storage: injectedStorage = null } = {}) {
  const run = await startJobRun(db, 'parse_sources');
  const storage = injectedStorage || await createStorage({ db });
  const snapshots = await db.prepare(`SELECT ss.*, rs.parser AS declared_parser, rs.source_url FROM regulatory_source_snapshots ss
    JOIN regulatory_sources rs ON rs.id = ss.source_id WHERE ss.parse_status IN ('PENDING','FAILED','UNSTRUCTURED') AND ss.status IN ('RAW_CAPTURED','PARSED_TEXT','UNSTRUCTURED')
    ORDER BY ss.collected_at`).all();
  let parsed = 0;
  let unstructured = 0;
  const failures = [];
  for (const snapshot of snapshots) {
    try {
      let bytes = snapshot.content ? Buffer.from(snapshot.content) : null;
      if (!bytes && snapshot.raw_storage_path) {
        try { bytes = await storage.read(snapshot.raw_storage_path); } catch { bytes = null; }
      }
      if (!bytes) {
        await db.prepare(`UPDATE regulatory_source_snapshots SET parse_status = 'UNSTRUCTURED', parse_error = 'Raw bytes are not retrievable from provider "${snapshot.storage_provider}"; nothing was inferred.' WHERE id = ?`).run(snapshot.id);
        unstructured += 1;
        continue;
      }
      const parse = parseSnapshot(parserFor(snapshot.mime_type, snapshot.declared_parser), bytes, snapshot.mime_type);
      await db.prepare('UPDATE regulatory_source_snapshots SET extracted_text = ?, parser = ?, parse_status = ?, parse_error = ?, status = ? WHERE id = ?')
        .run(parse.extracted_text, parse.parser, parse.parse_status, parse.parse_status === 'FAILED' ? parse.notes : null,
          parse.parse_status === 'PARSED_TEXT' || parse.parse_status === 'PARSED_STRUCTURED' ? 'PARSED_TEXT' : 'UNSTRUCTURED', snapshot.id);
      if (parse.parse_status === 'PARSED_TEXT' || parse.parse_status === 'PARSED_STRUCTURED') parsed += 1;
      else unstructured += 1;
    } catch (error) {
      const source = await db.prepare('SELECT * FROM regulatory_sources WHERE id = ?').get(snapshot.source_id);
      await logIngestionError(db, run.id, source, 'PARSE_ERROR', String(error?.message || error));
      failures.push({ source_id: snapshot.source_id, error: String(error?.message || error) });
    }
  }
  const status = failures.length ? 'PARTIAL' : 'SUCCEEDED';
  await finishJobRun(db, run.id, status, { processed: snapshots.length, created: parsed, result: { text_parsed: parsed, unstructured, failures }, sources_checked: snapshots.length });
  return { job_run_id: run.id, status, processed: snapshots.length, parsed, unstructured, errors: failures.length };
}

export async function runDetectVersions(db) {
  const run = await startJobRun(db, 'detect_versions');
  const sources = await db.prepare('SELECT id, source_url FROM regulatory_sources ORDER BY id').all();
  let processed = 0;
  let multiVersionSources = 0;
  for (const source of sources) {
    processed += 1;
    const row = await db.prepare('SELECT COUNT(*) AS count FROM regulatory_source_snapshots WHERE source_id = ?').get(source.id);
    if (row.count > 1) multiVersionSources += 1;
  }
  await finishJobRun(db, run.id, 'SUCCEEDED', { processed, result: { sources_checked: processed, sources_with_multiple_immutable_snapshots: multiVersionSources }, sources_checked: processed });
  return { job_run_id: run.id, status: 'SUCCEEDED', processed, sources_with_multiple_versions: multiVersionSources };
}

/** Reconciles snapshot history with the change ledger; never invents missing diffs. */
export async function runDetectChanges(db) {
  const run = await startJobRun(db, 'detect_changes');
  const snapshots = await db.prepare(`SELECT ss.id, ss.source_id, ss.content_hash, ss.collected_at, ss.parse_status, rs.source_url, rs.source_title
    FROM regulatory_source_snapshots ss JOIN regulatory_sources rs ON rs.id = ss.source_id
    ORDER BY ss.source_id, ss.collected_at`).all();
  const grouped = new Map();
  for (const snapshot of snapshots) {
    if (!grouped.has(snapshot.source_id)) grouped.set(snapshot.source_id, []);
    grouped.get(snapshot.source_id).push(snapshot);
  }
  let changes = 0;
  for (const [sourceId, versions] of grouped) {
    for (let index = 1; index < versions.length; index += 1) {
      const prior = versions[index - 1];
      const current = versions[index];
      if (prior.content_hash === current.content_hash) continue;
      const existing = await db.prepare(`SELECT id FROM regulatory_changes WHERE entity_type = 'SOURCE' AND entity_id = ? AND change_level = 'SOURCE_CHANGED' AND old_version = ? AND new_version = ?`)
        .get(sourceId, prior.content_hash, current.content_hash);
      if (existing) continue;
      const latest = await db.prepare('SELECT * FROM regulatory_source_snapshots WHERE id = ?').get(current.id);
      const id = randomUUID();
      await db.prepare(`INSERT INTO regulatory_changes
          (id, entity_type, entity_id, old_version, new_version, change_type, field, old_value, new_value, detected_at,
           severity, source_reference, source_url, summary, confidence, review_status, is_demo,
           change_level, previous_snapshot_id, current_snapshot_id, diff_type, diff_summary)
        VALUES (?, 'SOURCE', ?, ?, ?, 'SOURCE_HASH_CHANGED', 'official source content', ?, ?, ?, 'UNASSESSED', ?, ?, ?, 'HASH_ONLY', 'REVIEW_REQUIRED', 0,
           'SOURCE_CHANGED', ?, ?, ?, ?)`)
        .run(id, sourceId, prior.content_hash, current.content_hash, prior.content_hash, current.content_hash, current.collected_at,
          `snapshot pair ${prior.id}→${current.id}`, versions[0].source_url,
          'Hash remoto alterado. Diff de conteúdo e classificação semântica pendentes; nenhuma conclusão regulatória automática foi criada.',
          prior.id, current.id, 'HASH_ONLY', latest?.diff_summary || 'Reconciled from snapshot history by detect_changes job.');
      changes += 1;
    }
  }
  await finishJobRun(db, run.id, 'SUCCEEDED', { processed: snapshots.length, created: changes, result: { snapshots_checked: snapshots.length, hash_changes_registered_for_review: changes }, sources_checked: snapshots.length });
  return { job_run_id: run.id, status: 'SUCCEEDED', processed: snapshots.length, changes };
}

export async function runExtractObligations(db) {
  const run = await startJobRun(db, 'extract_obligations');
  const snippets = await db.prepare(`SELECT ss.id AS snapshot_id, ss.source_id, ss.extracted_text, ss.collected_at, rs.source_url
    FROM regulatory_source_snapshots ss JOIN regulatory_sources rs ON rs.id = ss.source_id
    WHERE ss.extracted_text IS NOT NULL ORDER BY ss.collected_at DESC`).all();
  let candidates = 0;
  for (const record of snippets) {
    const sentences = extractObligationSentences(record.extracted_text);
    for (const sentence of sentences) {
      const exists = await db.prepare(`SELECT id FROM regulatory_extraction_candidates WHERE source_id = ? AND entity_type = 'OBLIGATION' AND evidence_excerpt = ?`).get(record.source_id, sentence);
      if (exists) continue;
      await db.prepare(`INSERT INTO regulatory_extraction_candidates
        (id, source_id, entity_type, candidate_json, evidence_excerpt, confidence, status, created_at)
        VALUES (?, ?, 'OBLIGATION', ?, ?, 'LOW', 'REVIEW_REQUIRED', ?)`)
        .run(randomUUID(), record.source_id, JSON.stringify({ proposal: 'candidate only', source_url: record.source_url }), sentence, new Date().toISOString());
      candidates += 1;
    }
  }
  await finishJobRun(db, run.id, 'SUCCEEDED', { processed: snippets.length, created: candidates, result: { candidate_obligations_for_human_review: candidates, auto_created_obligations: 0 }, sources_checked: snippets.length });
  return { job_run_id: run.id, status: 'SUCCEEDED', processed_sources: snippets.length, candidates, auto_created_obligations: 0 };
}

export async function runExtractSchemas(db) {
  const run = await startJobRun(db, 'extract_schemas');
  const snapshots = await db.prepare(`SELECT ss.*, rs.source_url, rs.source_type FROM regulatory_source_snapshots ss
    JOIN regulatory_sources rs ON rs.id = ss.source_id WHERE ss.parse_status IN ('PARSED_TEXT','PARSED_STRUCTURED') ORDER BY ss.collected_at DESC`).all();
  let candidates = 0;
  let unstructured = 0;
  for (const snapshot of snapshots) {
    const type = String(snapshot.mime_type || '').toLowerCase();
    const text = snapshot.extracted_text || '';
    const fields = extractSchemaCandidates(text, type);
    if (!fields.length) { unstructured += 1; continue; }
    for (const field of fields) {
      const evidence = field.evidence.slice(0, 800);
      const exists = await db.prepare(`SELECT id FROM regulatory_extraction_candidates WHERE source_id = ? AND entity_type = 'SCHEMA_FIELD' AND evidence_excerpt = ?`).get(snapshot.source_id, evidence);
      if (exists) continue;
      await db.prepare(`INSERT INTO regulatory_extraction_candidates
        (id, source_id, entity_type, candidate_json, evidence_excerpt, confidence, status, created_at)
        VALUES (?, ?, 'SCHEMA_FIELD', ?, ?, 'LOW', 'REVIEW_REQUIRED', ?)`)
        .run(randomUUID(), snapshot.source_id, JSON.stringify(field), evidence, new Date().toISOString());
      candidates += 1;
    }
  }
  await finishJobRun(db, run.id, 'SUCCEEDED', { processed: snapshots.length, created: candidates, result: { schema_field_candidates_for_review: candidates, unstructured_sources: unstructured, auto_published_schema_fields: 0 }, sources_checked: snapshots.length });
  return { job_run_id: run.id, status: 'SUCCEEDED', processed: snapshots.length, candidates, unstructured };
}

export async function runCalculateImpacts(db) {
  const run = await startJobRun(db, 'calculate_impacts');
  const changes = await db.prepare(`SELECT * FROM regulatory_changes WHERE change_type <> 'SOURCE_HASH_CHANGED' AND (severity = 'UNASSESSED' OR severity IS NULL)`).all();
  let calculated = 0;
  for (const item of changes) {
    const impact = calculateImpacts(item.change_type, { field: item.field, note: 'Impacto técnico é determinístico e explicável; validade jurídica continua associada à fonte e revisão.' });
    await db.prepare('DELETE FROM technical_impacts WHERE regulatory_change_id = ?').run(item.id);
    const insert = db.prepare(`INSERT INTO technical_impacts
      (id, regulatory_change_id, impact_type, severity, score, description, recommended_action, rationale)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const row of impact.impacts) await insert.run(randomUUID(), item.id, row.impactType, row.severity, row.score, row.description, row.recommendedAction, row.rationale);
    await db.prepare('UPDATE regulatory_changes SET severity = ? WHERE id = ?').run(impact.level, item.id);
    calculated += 1;
  }
  await finishJobRun(db, run.id, 'SUCCEEDED', { processed: changes.length, created: calculated, result: { changes_scored: calculated, source_hash_changes_left_unclassified: (await db.prepare(`SELECT COUNT(*) AS count FROM regulatory_changes WHERE change_type = 'SOURCE_HASH_CHANGED'`).get()).count }, sources_checked: changes.length });
  return { job_run_id: run.id, status: 'SUCCEEDED', processed: changes.length, calculated };
}

export async function runUpdateDeadlines(db, today = new Date()) {
  const run = await startJobRun(db, 'update_deadlines');
  const deadlines = await db.prepare('SELECT id, due_date, deadline_type FROM regulatory_deadlines').all();
  const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const todayIso = date.toISOString().slice(0, 10);
  for (const deadline of deadlines) {
    const dueDate = String(deadline.due_date).slice(0, 10);
    const status = dueDate < todayIso ? 'OVERDUE' : dueDate === todayIso ? 'DUE_TODAY' : 'UPCOMING';
    await db.prepare('UPDATE regulatory_deadlines SET status = ? WHERE id = ?').run(status, deadline.id);
  }
  await finishJobRun(db, run.id, 'SUCCEEDED', { processed: deadlines.length, updated: deadlines.length, result: { records_refreshed: deadlines.length, internal_and_official_deadlines_kept_separate: true }, sources_checked: deadlines.length });
  return { job_run_id: run.id, status: 'SUCCEEDED', processed: deadlines.length, updated: deadlines.length };
}

export async function runJob(db, name, options = {}) {
  if (name === 'collect_sources') return runCollectSources(db, options);
  if (name === 'parse_sources') return runParseSources(db, options);
  if (name === 'detect_versions') return runDetectVersions(db);
  if (name === 'detect_changes') return runDetectChanges(db);
  if (name === 'extract_obligations') return runExtractObligations(db);
  if (name === 'extract_schemas') return runExtractSchemas(db);
  if (name === 'calculate_impacts') return runCalculateImpacts(db);
  if (name === 'update_deadlines') return runUpdateDeadlines(db, options.today || new Date());
  throw new Error(`Job ${name} is not implemented here; use the dedicated DQ or submission endpoint.`);
}

export async function startJobRun(db, name, manualTrigger = 'manual') {
  return createJobRun(db, name, manualTrigger);
}

export async function finishJobRun(db, id, statusOrFields, maybe) {
  const fields = typeof statusOrFields === 'string' ? { status: statusOrFields, ...(maybe || {}) } : { ...(statusOrFields || {}) };
  const started = await db.prepare('SELECT started_at FROM job_runs WHERE id = ?').get(id);
  const now = new Date();
  const durationMs = started?.started_at ? Math.max(0, now.getTime() - new Date(started.started_at).getTime()) : null;
  await db.prepare(`UPDATE job_runs SET finished_at = ?, status = ?, records_processed = ?, records_created = ?, records_updated = ?, errors = ?, result_json = ?,
      sources_checked = ?, sources_changed = ?, sources_unchanged = ?, sources_failed = ?, snapshot_count = ?, duration_ms = ? WHERE id = ?`)
    .run(now.toISOString(), fields.status || 'SUCCEEDED', fields.processed ?? 0, fields.created ?? 0, fields.updated ?? 0, fields.errors ?? null,
      JSON.stringify(fields.result || {}), fields.sources_checked ?? 0, fields.sources_changed ?? 0, fields.sources_unchanged ?? 0,
      fields.sources_failed ?? 0, fields.snapshot_count ?? 0, durationMs, id);
}

async function createJobRun(db, name, manualTrigger) {
  const id = randomUUID();
  await db.prepare(`INSERT INTO job_runs (id, job_name, started_at, status, manual_trigger) VALUES (?, ?, ?, 'RUNNING', ?)`).run(id, name, new Date().toISOString(), manualTrigger);
  return { id };
}

async function fetchOfficialSource(startUrl, fetcher, { signal, headers }) {
  let currentUrl = startUrl;
  const maxRedirects = 5;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const response = await fetcher(currentUrl, { method: 'GET', redirect: 'manual', signal, headers });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers?.get?.('location');
    if (!location) throw new Error(`Official source returned HTTP ${response.status} without a Location header.`);
    const nextUrl = new URL(location, currentUrl).toString();
    if (!isOfficialSourceUrl(nextUrl)) { const error = new Error('Redirect target is outside the HTTPS official-host allowlist.'); error.allowlist = true; throw error; }
    if (hop === maxRedirects) throw new Error(`Official source exceeded ${maxRedirects} redirects.`);
    currentUrl = nextUrl;
  }
  throw new Error('Official source redirect handling failed.');
}

function httpError(status) {
  const error = new Error(`Official source returned HTTP ${status}; retried.`);
  error.httpStatus = status;
  return error;
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeKey(value) {
  return String(value || 'source').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function extractObligationSentences(text) {
  const sentences = String(text).split(/(?<=[.!?])\s+|\n+/).map((part) => part.trim()).filter(Boolean);
  const matched = sentences.filter((sentence) => /\b(deve|deverá|deverão|obrigad[oa]s?|incumbe|dever de|prazo para)\b/i.test(sentence));
  return [...new Set(matched)].map((sentence) => sentence.slice(0, 1000)).slice(0, 25);
}

function extractSchemaCandidates(text, mimeType) {
  const output = [];
  const type = String(mimeType).toLowerCase();
  if (type.includes('json')) {
    try {
      const parsed = JSON.parse(text);
      const properties = parsed?.properties || parsed?.definitions || {};
      for (const [name, detail] of Object.entries(properties)) {
        output.push({ name, data_type: detail?.type || 'UNKNOWN', required: Array.isArray(parsed.required) && parsed.required.includes(name), evidence: JSON.stringify(detail) });
      }
    } catch { /* not valid JSON */ }
  }
  if (type.includes('xml') || type.includes('xsd') || /<xs:schema|<xsd:schema/i.test(text)) {
    const regex = /<(?:xs|xsd):element\b([^>]*?)(?:\/?>)/gi;
    for (const match of text.matchAll(regex)) {
      const attrs = Object.fromEntries([...match[1].matchAll(/([\w:.-]+)\s*=\s*["']([^"']*)["']/g)].map((item) => [item[1], item[2]]));
      if (!attrs.name) continue;
      output.push({ name: attrs.name, data_type: attrs.type || 'UNKNOWN', required: attrs.minOccurs === '1', evidence: match[0] });
    }
  }
  if (type.includes('csv') || type.includes('excel') || type.includes('spreadsheet')) {
    const header = String(text).split(/\r?\n/)[0] || '';
    const delimiter = header.includes(';') ? ';' : header.includes('\t') ? '\t' : ',';
    for (const name of header.split(delimiter).map((item) => item.replace(/^"|"$/g, '').trim()).filter(Boolean)) {
      output.push({ name, data_type: 'UNKNOWN', required: null, evidence: header });
    }
  }
  return output;
}
