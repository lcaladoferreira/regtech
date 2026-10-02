import { createHash, randomUUID } from 'node:crypto';
import { calculateImpacts } from './impact-engine.js';

const ALLOWED_HOSTS = ['gov.br', 'bcb.gov.br', 'cvm.gov.br', 'planalto.gov.br', 'in.gov.br'];
const MAX_BYTES = 12 * 1024 * 1024;

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
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && ALLOWED_HOSTS.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

export async function runCollectSources(db, { sourceIds = [], limit = 4, fetcher = fetch, timeoutMs = 7000 } = {}) {
  const run = createJobRun(db, 'collect_sources');
  const rows = sourceIds.length
    ? db.prepare(`SELECT * FROM regulatory_sources WHERE id IN (${sourceIds.map(() => '?').join(',')}) ORDER BY id`).all(...sourceIds)
    : db.prepare(`SELECT * FROM regulatory_sources ORDER BY CASE WHEN status = 'RAW_CAPTURED' THEN 1 ELSE 0 END, regulator_id, id LIMIT ?`).all(Math.max(1, Math.min(20, Number(limit) || 4)));
  const results = [];
  let created = 0;
  let processed = 0;
  const errorIds = [];

  for (const source of rows) {
    processed += 1;
    if (!isOfficialSourceUrl(source.source_url)) {
      const errorId = logIngestionError(db, run.id, source, 'SOURCE_NOT_ALLOWLISTED', 'A coleta aceita somente HTTPS em domínios oficiais allowlistados.');
      errorIds.push(errorId);
      results.push({ source_id: source.id, status: 'BLOCKED_NON_OFFICIAL_HOST' });
      continue;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchOfficialSource(source.source_url, fetcher, {
        signal: controller.signal,
        headers: { 'User-Agent': 'LCF-Regulatory-Data-Intelligence/0.1 (+official-source-audit)' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText || ''}`.trim());
      const contentLength = Number(response.headers?.get?.('content-length') || 0);
      if (contentLength > MAX_BYTES) throw new Error(`Source exceeds ${MAX_BYTES} byte collection limit (Content-Length ${contentLength}).`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_BYTES) throw new Error(`Source exceeds ${MAX_BYTES} byte collection limit (${bytes.length}).`);
      const hash = sha256(bytes);
      const existing = db.prepare('SELECT id FROM regulatory_source_snapshots WHERE source_id = ? AND content_hash = ?').get(source.id, hash);
      const collectedAt = new Date().toISOString();
      const mimeType = response.headers?.get?.('content-type')?.split(';')[0] || source.mime_type || 'application/octet-stream';
      if (!existing) {
        const extractedText = isTextMime(mimeType) ? extractText(bytes.toString('utf8'), mimeType) : null;
        db.prepare(`INSERT INTO regulatory_source_snapshots
          (id, source_id, response_url, content_hash, mime_type, collected_at, content, extracted_text, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'RAW_CAPTURED')`)
          .run(randomUUID(), source.id, response.url || source.source_url, hash, mimeType, collectedAt, bytes, extractedText);
        created += 1;
      }
      const previous = db.prepare('SELECT content_hash FROM regulatory_source_snapshots WHERE source_id = ? AND content_hash <> ? ORDER BY collected_at DESC LIMIT 1').get(source.id, hash);
      if (previous && !existing) createRawHashChange(db, source, previous.content_hash, hash, collectedAt);
      db.prepare(`UPDATE regulatory_sources SET content_hash = ?, content_hash_scope = 'RAW_RESPONSE_SHA256',
        collected_at = ?, mime_type = ?, status = ? WHERE id = ?`)
        .run(hash, collectedAt, mimeType, existing ? 'RAW_UNCHANGED' : 'RAW_CAPTURED', source.id);
      results.push({ source_id: source.id, status: existing ? 'UNCHANGED' : 'CAPTURED', content_hash: hash, bytes: bytes.length, mime_type: mimeType });
    } catch (error) {
      const message = error?.name === 'AbortError' ? `Request timed out after ${timeoutMs} ms.` : String(error?.message || error);
      const errorId = logIngestionError(db, run.id, source, error?.name || 'FETCH_ERROR', message);
      errorIds.push(errorId);
      results.push({ source_id: source.id, status: 'ERROR', error: message });
      // The source record stays discoverable and any prior snapshot remains intact.
      db.prepare(`UPDATE regulatory_sources SET status = CASE WHEN content_hash IS NULL THEN 'FETCH_ERROR' ELSE status END WHERE id = ?`).run(source.id);
    } finally {
      clearTimeout(timeout);
    }
  }
  const errors = errorIds.length;
  finishJobRun(db, run.id, errors ? (created || rows.length === 0 ? 'PARTIAL' : 'FAILED') : 'SUCCEEDED', processed, created, 0, errors ? JSON.stringify(results.filter((item) => item.status === 'ERROR' || item.status === 'BLOCKED_NON_OFFICIAL_HOST')) : null, { results, raw_snapshots_created: created, raw_snapshots_are_immutable: true });
  return { job_run_id: run.id, status: errors ? (created ? 'PARTIAL' : 'FAILED') : 'SUCCEEDED', processed, created, errors, results };
}

export function runParseSources(db) {
  const run = createJobRun(db, 'parse_sources');
  const snapshots = db.prepare(`SELECT ss.*, rs.source_type, rs.source_url FROM regulatory_source_snapshots ss
    JOIN regulatory_sources rs ON rs.id = ss.source_id WHERE ss.status = 'RAW_CAPTURED' ORDER BY ss.collected_at`).all();
  let parsed = 0;
  let unstructured = 0;
  const failures = [];
  for (const snapshot of snapshots) {
    try {
      const bytes = Buffer.from(snapshot.content);
      const type = String(snapshot.mime_type || '').toLowerCase();
      if (isTextMime(type) || type.includes('xml') || type.includes('json') || type.includes('csv')) {
        const text = bytes.toString('utf8');
        const extracted = extractText(text, type);
        db.prepare('UPDATE regulatory_source_snapshots SET extracted_text = ?, status = ? WHERE id = ?')
          .run(extracted, extracted ? 'PARSED_TEXT' : 'UNSTRUCTURED', snapshot.id);
        if (extracted) parsed += 1;
        else unstructured += 1;
      } else if (type.includes('pdf') || type.includes('zip') || type.includes('octet-stream')) {
        db.prepare(`UPDATE regulatory_source_snapshots SET status = 'UNSTRUCTURED' WHERE id = ?`).run(snapshot.id);
        unstructured += 1;
      } else {
        db.prepare(`UPDATE regulatory_source_snapshots SET status = 'UNSTRUCTURED' WHERE id = ?`).run(snapshot.id);
        unstructured += 1;
      }
    } catch (error) {
      const source = db.prepare('SELECT * FROM regulatory_sources WHERE id = ?').get(snapshot.source_id);
      logIngestionError(db, run.id, source, 'PARSE_ERROR', String(error?.message || error));
      failures.push({ source_id: snapshot.source_id, error: String(error?.message || error) });
    }
  }
  const status = failures.length ? 'PARTIAL' : 'SUCCEEDED';
  finishJobRun(db, run.id, status, snapshots.length, parsed, 0, failures.length ? JSON.stringify(failures) : null, { text_parsed: parsed, unstructured, failures });
  return { job_run_id: run.id, status, processed: snapshots.length, parsed, unstructured, errors: failures.length };
}

export function runDetectVersions(db) {
  const run = createJobRun(db, 'detect_versions');
  const sources = db.prepare('SELECT id, source_url FROM regulatory_sources ORDER BY id').all();
  let processed = 0;
  let multiVersionSources = 0;
  for (const source of sources) {
    processed += 1;
    const count = db.prepare('SELECT COUNT(*) AS count FROM regulatory_source_snapshots WHERE source_id = ?').get(source.id).count;
    if (count > 1) multiVersionSources += 1;
  }
  finishJobRun(db, run.id, 'SUCCEEDED', processed, 0, 0, null, { sources_checked: processed, sources_with_multiple_immutable_snapshots: multiVersionSources });
  return { job_run_id: run.id, status: 'SUCCEEDED', processed, sources_with_multiple_versions: multiVersionSources };
}

export function runDetectChanges(db) {
  const run = createJobRun(db, 'detect_changes');
  const snapshots = db.prepare(`SELECT ss.source_id, ss.content_hash, ss.collected_at, rs.source_url, rs.source_title
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
      const existing = db.prepare(`SELECT id FROM regulatory_changes WHERE entity_type = 'SOURCE' AND entity_id = ? AND old_version = ? AND new_version = ?`).get(sourceId, prior.content_hash, current.content_hash);
      if (existing) continue;
      db.prepare(`INSERT INTO regulatory_changes
        (id, entity_type, entity_id, old_version, new_version, change_type, field, old_value, new_value,
         detected_at, severity, source_reference, source_url, summary, confidence, review_status)
        VALUES (?, 'SOURCE', ?, ?, ?, 'SOURCE_HASH_CHANGED', 'source content', ?, ?, ?, 'UNASSESSED', ?, ?, ?, 'HASH_ONLY', 'REVIEW_REQUIRED')`)
        .run(randomUUID(), sourceId, prior.content_hash, current.content_hash, prior.content_hash, current.content_hash,
          current.collected_at, current.source_title, current.source_url,
          'Hash remoto alterado. Diff de conteúdo e classificação semântica pendentes; nenhuma conclusão regulatória automática foi criada.');
      changes += 1;
    }
  }
  finishJobRun(db, run.id, 'SUCCEEDED', snapshots.length, changes, 0, null, { snapshots_checked: snapshots.length, hash_changes_registered_for_review: changes });
  return { job_run_id: run.id, status: 'SUCCEEDED', processed: snapshots.length, changes };
}

export function runExtractObligations(db) {
  const run = createJobRun(db, 'extract_obligations');
  const snippets = db.prepare(`SELECT ss.id AS snapshot_id, ss.source_id, ss.extracted_text, ss.collected_at, rs.source_url
    FROM regulatory_source_snapshots ss JOIN regulatory_sources rs ON rs.id = ss.source_id
    WHERE ss.extracted_text IS NOT NULL ORDER BY ss.collected_at DESC`).all();
  let candidates = 0;
  for (const record of snippets) {
    const sentences = extractObligationSentences(record.extracted_text);
    for (const sentence of sentences) {
      const exists = db.prepare(`SELECT id FROM regulatory_extraction_candidates WHERE source_id = ? AND entity_type = 'OBLIGATION' AND evidence_excerpt = ?`).get(record.source_id, sentence);
      if (exists) continue;
      db.prepare(`INSERT INTO regulatory_extraction_candidates
        (id, source_id, entity_type, candidate_json, evidence_excerpt, confidence, status, created_at)
        VALUES (?, ?, 'OBLIGATION', ?, ?, 'LOW', 'REVIEW_REQUIRED', ?)`)
        .run(randomUUID(), record.source_id, JSON.stringify({ proposal: 'candidate only', source_url: record.source_url }), sentence, new Date().toISOString());
      candidates += 1;
    }
  }
  finishJobRun(db, run.id, 'SUCCEEDED', snippets.length, candidates, 0, null, { candidate_obligations_for_human_review: candidates, auto_created_obligations: 0 });
  return { job_run_id: run.id, status: 'SUCCEEDED', processed_sources: snippets.length, candidates, auto_created_obligations: 0 };
}

export function runExtractSchemas(db) {
  const run = createJobRun(db, 'extract_schemas');
  const snapshots = db.prepare(`SELECT ss.*, rs.source_url, rs.source_type FROM regulatory_source_snapshots ss
    JOIN regulatory_sources rs ON rs.id = ss.source_id WHERE ss.status IN ('PARSED_TEXT','RAW_CAPTURED','UNSTRUCTURED') ORDER BY ss.collected_at DESC`).all();
  let candidates = 0;
  let unstructured = 0;
  for (const snapshot of snapshots) {
    const type = String(snapshot.mime_type || '').toLowerCase();
    const text = snapshot.extracted_text || '';
    const fields = extractSchemaCandidates(text, type);
    if (!fields.length) {
      unstructured += 1;
      continue;
    }
    for (const field of fields) {
      const evidence = field.evidence.slice(0, 800);
      const exists = db.prepare(`SELECT id FROM regulatory_extraction_candidates WHERE source_id = ? AND entity_type = 'SCHEMA_FIELD' AND evidence_excerpt = ?`).get(snapshot.source_id, evidence);
      if (exists) continue;
      db.prepare(`INSERT INTO regulatory_extraction_candidates
        (id, source_id, entity_type, candidate_json, evidence_excerpt, confidence, status, created_at)
        VALUES (?, ?, 'SCHEMA_FIELD', ?, ?, 'LOW', 'REVIEW_REQUIRED', ?)`)
        .run(randomUUID(), snapshot.source_id, JSON.stringify(field), evidence, new Date().toISOString());
      candidates += 1;
    }
  }
  finishJobRun(db, run.id, 'SUCCEEDED', snapshots.length, candidates, 0, null, { schema_field_candidates_for_review: candidates, unstructured_sources: unstructured, auto_published_schema_fields: 0 });
  return { job_run_id: run.id, status: 'SUCCEEDED', processed: snapshots.length, candidates, unstructured };
}

export function runCalculateImpacts(db) {
  const run = createJobRun(db, 'calculate_impacts');
  const changes = db.prepare(`SELECT * FROM regulatory_changes WHERE change_type <> 'SOURCE_HASH_CHANGED'`).all();
  let calculated = 0;
  for (const item of changes) {
    const impact = calculateImpacts(item.change_type, { field: item.field, note: 'Impacto técnico é determinístico e explicável; validade jurídica continua associada à fonte e revisão.' });
    db.prepare('DELETE FROM technical_impacts WHERE regulatory_change_id = ?').run(item.id);
    const insert = db.prepare(`INSERT INTO technical_impacts
      (id, regulatory_change_id, impact_type, severity, score, description, recommended_action, rationale)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const row of impact.impacts) insert.run(randomUUID(), item.id, row.impactType, row.severity, row.score, row.description, row.recommendedAction, row.rationale);
    db.prepare('UPDATE regulatory_changes SET severity = ? WHERE id = ?').run(impact.level, item.id);
    calculated += 1;
  }
  finishJobRun(db, run.id, 'SUCCEEDED', changes.length, calculated, 0, null, { changes_scored: calculated, source_hash_changes_left_unclassified: db.prepare(`SELECT COUNT(*) AS count FROM regulatory_changes WHERE change_type = 'SOURCE_HASH_CHANGED'`).get().count });
  return { job_run_id: run.id, status: 'SUCCEEDED', processed: changes.length, calculated };
}

export function runUpdateDeadlines(db, today = new Date()) {
  const run = createJobRun(db, 'update_deadlines');
  const deadlines = db.prepare('SELECT id, due_date, deadline_type FROM regulatory_deadlines').all();
  const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const todayIso = date.toISOString().slice(0, 10);
  for (const deadline of deadlines) {
    const status = deadline.due_date < todayIso ? 'OVERDUE' : deadline.due_date === todayIso ? 'DUE_TODAY' : 'UPCOMING';
    db.prepare('UPDATE regulatory_deadlines SET status = ? WHERE id = ?').run(status, deadline.id);
  }
  finishJobRun(db, run.id, 'SUCCEEDED', deadlines.length, 0, deadlines.length, null, { records_refreshed: deadlines.length, internal_and_official_deadlines_kept_separate: true });
  return { job_run_id: run.id, status: 'SUCCEEDED', processed: deadlines.length, updated: deadlines.length };
}

export function runJob(db, name, options = {}) {
  if (name === 'collect_sources') return runCollectSources(db, options);
  if (name === 'parse_sources') return runParseSources(db);
  if (name === 'detect_versions') return runDetectVersions(db);
  if (name === 'detect_changes') return runDetectChanges(db);
  if (name === 'extract_obligations') return runExtractObligations(db);
  if (name === 'extract_schemas') return runExtractSchemas(db);
  if (name === 'calculate_impacts') return runCalculateImpacts(db);
  if (name === 'update_deadlines') return runUpdateDeadlines(db, options.today || new Date());
  throw new Error(`Job ${name} is not implemented here; use the dedicated DQ or submission endpoint.`);
}

export function startJobRun(db, name) {
  return createJobRun(db, name);
}

export function finishJobRun(db, id, status, processed, created, updated, errors, result) {
  db.prepare(`UPDATE job_runs SET finished_at = ?, status = ?, records_processed = ?, records_created = ?, records_updated = ?, errors = ?, result_json = ? WHERE id = ?`)
    .run(new Date().toISOString(), status, processed, created, updated, errors, JSON.stringify(result || {}), id);
}

function createJobRun(db, name) {
  const id = randomUUID();
  db.prepare(`INSERT INTO job_runs (id, job_name, started_at, status) VALUES (?, ?, ?, 'RUNNING')`).run(id, name, new Date().toISOString());
  return { id };
}

function logIngestionError(db, jobRunId, source, errorType, message) {
  const id = randomUUID();
  db.prepare(`INSERT INTO ingestion_errors (id, source, error_type, message, timestamp, retry_count, resolved, source_id, job_run_id)
    VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)`)
    .run(id, source?.source_url || 'unknown', errorType, message, new Date().toISOString(), source?.id || null, jobRunId);
  return id;
}

function createRawHashChange(db, source, oldHash, newHash, detectedAt) {
  const id = randomUUID();
  db.prepare(`INSERT OR IGNORE INTO regulatory_changes
    (id, entity_type, entity_id, old_version, new_version, change_type, field, old_value, new_value, detected_at,
     severity, source_reference, source_url, summary, confidence, review_status)
    VALUES (?, 'SOURCE', ?, ?, ?, 'SOURCE_HASH_CHANGED', 'remote content hash', ?, ?, ?, 'UNASSESSED', ?, ?, ?, 'HASH_ONLY', 'REVIEW_REQUIRED')`)
    .run(id, source.id, oldHash, newHash, oldHash, newHash, detectedAt, source.source_title, source.source_url,
      'O conteúdo remoto possui novo SHA-256. A versão anterior foi preservada; classificar apenas após diff semântico e revisão humana.');
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
    if (!isOfficialSourceUrl(nextUrl)) throw new Error('Redirect target is outside the HTTPS official-host allowlist.');
    if (hop === maxRedirects) throw new Error(`Official source exceeded ${maxRedirects} redirects.`);
    currentUrl = nextUrl;
  }
  throw new Error('Official source redirect handling failed.');
}

function isTextMime(type) {
  return type.startsWith('text/') || type.includes('html') || type.includes('xml') || type.includes('json') || type.includes('csv');
}

function extractText(text, mimeType = '') {
  const normalizedType = String(mimeType).toLowerCase();
  if (normalizedType.includes('html') || /<html|<body|<article/i.test(text)) {
    return text
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;|&#160;/gi, ' ')
      .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      .replace(/\s+/g, ' ').trim();
  }
  return String(text).replace(/\u0000/g, '').trim();
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
