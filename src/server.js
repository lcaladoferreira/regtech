import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createDatabase, closeDatabase } from './db.js';
import { calculateImpacts } from './engines/impact-engine.js';
import { compareNormativeText } from './engines/schema-diff.js';
import { runDqAgainstSeededData } from './engines/dq-engine.js';
import { runJob, runCollectSources, startJobRun, finishJobRun, isOfficialSourceUrl } from './engines/ingestion.js';
import { calendarStatus } from './engines/deadlines.js';
import { generateSubmission, validateSubmission, runDemoPipeline, readArtifact, SubmissionError } from './services/submission-service.js';

const here = resolve(fileURLToPath(new URL('../', import.meta.url)));
const publicRoot = resolve(here, 'public');
const MAX_BODY = 1_500_000;
const MAPPING_STATUSES = new Set(['UNMAPPED','MAPPED','VALIDATED','REVIEW_REQUIRED']);
const CHANGE_TYPES = new Set([
  'FIELD_ADDED','NEW_REQUIRED_FIELD','FIELD_REMOVED','FIELD_RENAMED','TYPE_CHANGED','LENGTH_CHANGED','PRECISION_CHANGED',
  'REQUIRED_CHANGED','CARDINALITY_CHANGED','DOMAIN_CHANGED','ENUM_ADDED','ENUM_REMOVED','PATTERN_CHANGED','STRUCTURE_CHANGED',
  'DEADLINE_CHANGED','POPULATION_CHANGED','FORMAT_CHANGED','OBLIGATION_ADDED','DOCUMENTATION_CHANGED','SOURCE_HASH_CHANGED',
]);

const ROUTE_META = {
  '/dashboard': ['Overview', 'Workspace intelligence'],
  '/obligations': ['Obligation registry', 'Searchable cross-regulator inventory'],
  '/changes': ['Regulatory change feed', 'Officially sourced change → technical impact'],
  '/schemas': ['Schema registry', 'Versions, field inventory and change evidence'],
  '/norm-diff': ['Norm diff', 'Lexical comparison with explicit human review'],
  '/impact': ['Regulation → data', 'Trace one obligation through the data estate'],
  '/mapping': ['Mapping studio', 'Connect regulatory fields to internal data'],
  '/catalog': ['Regulatory data catalog', 'Canonical elements and reuse'],
  '/lineage': ['Data lineage', 'Navigate from source field to obligation and back'],
  '/controls': ['Control library', 'Evidence that requirements are being addressed'],
  '/calendar': ['Deadline calendar', 'Official due dates separate from internal targets'],
  '/regulators': ['Regulators', 'Shared regulatory model across authorities'],
  '/search': ['Global search', 'Norms, obligations, fields, sources and dates'],
  '/engineering': ['Engineering impact', 'Schemas, mappings, pipelines and DQ coverage'],
  '/regulatory': ['Regulatory operations', 'New rules, effective dates and applicability'],
  '/matrix': ['Impact matrix', 'Obligations by systems, datasets and pipelines'],
  '/evidence': ['Evidence center', 'Source, mapping, validation and artifact trace'],
  '/cases': ['Reference cases', 'Multi-regulator implementations and limitations'],
  '/system/jobs': ['Job runs', 'Ingestion and processing execution history'],
  '/system/errors': ['Ingestion errors', 'Failures remain visible and retryable'],
};

export function createAppServer({ db = createDatabase(), closeDbOnStop = false } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);
    const requestId = randomUUID();
    try {
      if (pathname.startsWith('/api/')) {
        await handleApi(req, res, db, url, requestId);
      } else {
        serveStatic(req, res, pathname);
      }
    } catch (error) {
      const status = Number(error?.statusCode) || 500;
      const body = {
        error: error?.code || 'INTERNAL_ERROR',
        message: error?.message || 'Unexpected server error.',
        request_id: requestId,
        timestamp: new Date().toISOString(),
      };
      if (status >= 500) console.error(JSON.stringify({ level: 'error', request_id: requestId, path: pathname, message: body.message, stack: error?.stack }));
      sendJson(res, status, body);
    }
  });
  if (closeDbOnStop) server.on('close', () => closeDatabase(db));
  return { server, db };
}

export async function handleApi(req, res, db, url, requestId) {
  const pathname = decodeURIComponent(url.pathname);
  const method = req.method || 'GET';
  if (method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return;
  }
  if (method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, { status: 'ok', app: 'LCF Regulatory Data Intelligence', database: 'SQLite', request_id: requestId, time: new Date().toISOString() });
  }
  if (method === 'GET' && pathname === '/api/dashboard') return sendJson(res, 200, dashboardData(db));
  if (method === 'GET' && pathname === '/api/regulators') return sendJson(res, 200, listRegulators(db));
  if (method === 'GET' && pathname === '/api/regulations') return sendJson(res, 200, listRegulations(db));
  if (method === 'GET' && pathname === '/api/obligations') return sendJson(res, 200, listObligations(db, url.searchParams));
  const obligationMatch = pathname.match(/^\/api\/obligations\/([^/]+)$/);
  if (method === 'GET' && obligationMatch) return sendJson(res, 200, obligationDetail(db, obligationMatch[1]));
  if (method === 'GET' && pathname === '/api/requirements') return sendJson(res, 200, listRequirements(db, url.searchParams));
  if (method === 'GET' && pathname === '/api/documents') return sendJson(res, 200, listDocuments(db, url.searchParams));
  if (method === 'GET' && pathname === '/api/schemas') return sendJson(res, 200, listSchemas(db, url.searchParams));
  const schemaMatch = pathname.match(/^\/api\/schemas\/([^/]+)$/);
  if (method === 'GET' && schemaMatch) return sendJson(res, 200, schemaDetail(db, schemaMatch[1]));
  if (method === 'GET' && pathname === '/api/fields') return sendJson(res, 200, listFields(db, url.searchParams));
  if (method === 'GET' && pathname === '/api/changes') return sendJson(res, 200, listChanges(db, url.searchParams));
  if (method === 'POST' && pathname === '/api/changes') return sendJson(res, 201, registerChange(db, await readJson(req)));
  if (method === 'GET' && pathname === '/api/impacts') return sendJson(res, 200, listImpacts(db, url.searchParams));
  if (method === 'GET' && pathname === '/api/norm-diff') return sendJson(res, 200, listNormDiff(db, url.searchParams));
  if (method === 'POST' && pathname === '/api/norm-diff/compare') return sendJson(res, 200, compareNormDiff(await readJson(req)));
  if (method === 'GET' && pathname === '/api/mappings') return sendJson(res, 200, listMappings(db, url.searchParams));
  if (method === 'POST' && pathname === '/api/mappings') return sendJson(res, 201, createMapping(db, await readJson(req)));
  const mappingMatch = pathname.match(/^\/api\/mappings\/([^/]+)$/);
  if (method === 'PUT' && mappingMatch) return sendJson(res, 200, updateMapping(db, mappingMatch[1], await readJson(req)));
  if (method === 'GET' && pathname === '/api/catalog') return sendJson(res, 200, listCatalog(db, url.searchParams));
  if (method === 'GET' && pathname === '/api/internal-data') return sendJson(res, 200, listInternalData(db));
  if (method === 'GET' && pathname === '/api/lineage') return sendJson(res, 200, getLineage(db, url.searchParams));
  if (method === 'GET' && pathname === '/api/dq') return sendJson(res, 200, listDq(db));
  if (method === 'POST' && pathname === '/api/dq/run') return sendJson(res, 201, runDq(db));
  if (method === 'GET' && pathname === '/api/deadlines') return sendJson(res, 200, listDeadlines(db, url.searchParams));
  if (method === 'POST' && pathname === '/api/deadlines/internal') return sendJson(res, 201, createInternalDeadline(db, await readJson(req)));
  if (method === 'GET' && pathname === '/api/submissions') return sendJson(res, 200, listSubmissions(db));
  if (method === 'POST' && pathname === '/api/submissions/generate') return sendJson(res, 201, generateSubmission(db, await readJson(req)));
  if (method === 'POST' && pathname === '/api/submissions/validate') return sendJson(res, 200, validateSubmission(db, await readJson(req)));
  if (method === 'GET' && pathname === '/api/sources') return sendJson(res, 200, listSources(db, url.searchParams));
  if (method === 'GET' && pathname === '/api/evidence') return sendJson(res, 200, listEvidence(db, url.searchParams));
  if (method === 'POST' && pathname === '/api/evidence') return sendJson(res, 201, createEvidence(db, await readJson(req)));
  if (method === 'GET' && pathname === '/api/controls') return sendJson(res, 200, listControls(db));
  if (method === 'POST' && pathname === '/api/controls') return sendJson(res, 201, createControl(db, await readJson(req)));
  if (method === 'GET' && pathname === '/api/audit') return sendJson(res, 200, listAudit(db, url.searchParams));
  if (method === 'GET' && pathname === '/api/matrix') return sendJson(res, 200, buildMatrix(db));
  if (method === 'GET' && pathname === '/api/engineering') return sendJson(res, 200, engineeringData(db));
  if (method === 'GET' && pathname === '/api/regulatory') return sendJson(res, 200, regulatoryData(db));
  if (method === 'GET' && pathname === '/api/cases') return sendJson(res, 200, db.prepare(`SELECT c.*, r.acronym AS regulator_acronym, o.title AS obligation_title, s.source_url
    FROM regulatory_cases c JOIN regulators r ON r.id = c.regulator_id LEFT JOIN regulatory_obligations o ON o.id = c.obligation_id LEFT JOIN regulatory_sources s ON s.id = c.source_id ORDER BY c.code`).all());
  if (method === 'GET' && pathname === '/api/jobs') return sendJson(res, 200, listJobs(db));
  if (method === 'POST' && pathname === '/api/jobs/collect_sources') return sendJson(res, 200, await runCollectSources(db, await readJson(req).catch(() => ({}))));
  const runJobMatch = pathname.match(/^\/api\/jobs\/([a-z_]+)\/run$/);
  if (method === 'POST' && runJobMatch) return sendJson(res, 200, executeJob(db, runJobMatch[1]));
  if (method === 'GET' && pathname === '/api/errors') return sendJson(res, 200, listErrors(db));
  const retryMatch = pathname.match(/^\/api\/errors\/([^/]+)\/retry$/);
  if (method === 'POST' && retryMatch) return sendJson(res, 200, await retryError(db, retryMatch[1]));
  if (method === 'GET' && pathname === '/api/search') return sendJson(res, 200, globalSearch(db, url.searchParams.get('q') || ''));
  if (method === 'POST' && pathname === '/api/pipelines/run') return sendJson(res, 201, runDemoPipeline(db, await readJson(req)));
  const artifactMatch = pathname.match(/^\/api\/artifacts\/([^/]+)$/);
  if (method === 'GET' && artifactMatch) return serveArtifact(res, artifactMatch[1]);
  sendJson(res, 404, { error: 'NOT_FOUND', message: `No API route for ${method} ${pathname}.`, request_id: requestId });
}

function dashboardData(db) {
  const today = new Date().toISOString().slice(0, 10);
  const counts = {
    regulator_count: db.prepare('SELECT COUNT(*) AS n FROM regulators WHERE active = 1').get().n,
    obligation_count: db.prepare("SELECT COUNT(*) AS n FROM regulatory_obligations WHERE status = 'ACTIVE'").get().n,
    source_count: db.prepare('SELECT COUNT(*) AS n FROM regulatory_sources').get().n,
    excerpt_verified_sources: db.prepare("SELECT COUNT(*) AS n FROM regulatory_sources WHERE status = 'EXCERPT_VERIFIED'").get().n,
    raw_snapshots: db.prepare('SELECT COUNT(*) AS n FROM regulatory_source_snapshots').get().n,
    schema_count: db.prepare('SELECT COUNT(*) AS n FROM schema_versions').get().n,
    field_count: db.prepare("SELECT COUNT(*) AS n FROM regulatory_fields WHERE status <> 'DEPRECATED'").get().n,
    mapped_field_count: db.prepare("SELECT COUNT(DISTINCT m.regulatory_field_id) AS n FROM data_mappings m WHERE m.mapping_status IN ('MAPPED','VALIDATED')").get().n,
    dq_rule_count: db.prepare('SELECT COUNT(*) AS n FROM dq_rules').get().n,
    deadline_count: db.prepare("SELECT COUNT(*) AS n FROM regulatory_deadlines WHERE deadline_type = 'OFFICIAL' AND due_date >= ?").get(today).n,
    high_impact_change_count: db.prepare("SELECT COUNT(*) AS n FROM regulatory_changes WHERE severity IN ('HIGH','CRITICAL')").get().n,
    ingestion_error_count: db.prepare('SELECT COUNT(*) AS n FROM ingestion_errors WHERE resolved = 0').get().n,
  };
  const latestDq = db.prepare('SELECT * FROM dq_runs ORDER BY started_at DESC LIMIT 1').get() || null;
  const changeCounts = {
    changes_7d: db.prepare("SELECT COUNT(*) AS n FROM regulatory_changes WHERE detected_at >= datetime('now','-7 days')").get().n,
    changes_30d: db.prepare("SELECT COUNT(*) AS n FROM regulatory_changes WHERE detected_at >= datetime('now','-30 days')").get().n,
    changes_total: db.prepare('SELECT COUNT(*) AS n FROM regulatory_changes').get().n,
  };
  const obligations = listObligations(db, new URLSearchParams()).slice(0, 6);
  const changes = listChanges(db, new URLSearchParams()).slice(0, 4);
  const deadlines = listDeadlines(db, new URLSearchParams()).filter((deadline) => deadline.due_date >= today).slice(0, 4);
  return {
    generated_at: new Date().toISOString(),
    counts: { ...counts, ...changeCounts, latest_dq_run: latestDq, unmapped_field_count: Math.max(0, counts.field_count - counts.mapped_field_count) },
    top_changes: changes,
    upcoming_deadlines: deadlines,
    obligations_preview: obligations,
    data_trust: { official_source_excerpts: counts.excerpt_verified_sources, raw_remote_snapshots: counts.raw_snapshots, internal_demo_records: db.prepare('SELECT COUNT(*) AS n FROM demo_data WHERE is_demo = 1').get().n },
  };
}

function listRegulators(db) {
  const rows = db.prepare(`SELECT r.*,
    (SELECT COUNT(*) FROM regulations x WHERE x.regulator_id = r.id) AS regulation_count,
    (SELECT COUNT(*) FROM regulatory_obligations o WHERE o.regulator_id = r.id AND o.status = 'ACTIVE') AS obligation_count,
    (SELECT COUNT(*) FROM regulatory_sources s WHERE s.regulator_id = r.id) AS source_count
    FROM regulators r ORDER BY r.name`).all();
  const changes = listChanges(db,new URLSearchParams());
  return rows.map((row)=>({...row,change_count:changes.filter((change)=>change.regulator?.id===row.id).length}));
}

function listRegulations(db) {
  return db.prepare(`SELECT n.*, r.name AS regulator_name, r.acronym AS regulator_acronym,
    (SELECT COUNT(*) FROM regulatory_obligations o WHERE o.regulation_id = n.id) AS obligation_count
    FROM regulations n JOIN regulators r ON r.id = n.regulator_id ORDER BY r.acronym, n.number`).all();
}

function listObligations(db, params) {
  const q = (params.get('q') || '').trim();
  const regulator = params.get('regulator') || '';
  const category = params.get('category') || '';
  const status = params.get('status') || '';
  const frequency = params.get('frequency') || '';
  const rows = db.prepare(`SELECT o.*, r.name AS regulator_name, r.acronym AS regulator_acronym,
      n.title AS regulation_title, n.number AS regulation_number, n.source_url AS regulation_source_url,
      (SELECT COUNT(*) FROM regulatory_fields f JOIN schema_versions sv ON sv.id = f.schema_version_id JOIN regulatory_documents d ON d.id = sv.document_id WHERE d.obligation_id = o.id AND f.status <> 'DEPRECATED') AS field_count,
      (SELECT COUNT(DISTINCT m.regulatory_field_id) FROM data_mappings m JOIN regulatory_fields f ON f.id = m.regulatory_field_id JOIN schema_versions sv ON sv.id = f.schema_version_id JOIN regulatory_documents d ON d.id = sv.document_id WHERE d.obligation_id = o.id AND m.mapping_status IN ('MAPPED','VALIDATED')) AS mapped_field_count,
      (SELECT COUNT(DISTINCT dq.regulatory_field_id) FROM dq_rules dq JOIN regulatory_fields f ON f.id = dq.regulatory_field_id JOIN schema_versions sv ON sv.id = f.schema_version_id JOIN regulatory_documents d ON d.id = sv.document_id WHERE d.obligation_id = o.id) AS dq_field_count,
      (SELECT MIN(due_date) FROM regulatory_deadlines rd WHERE rd.obligation_id = o.id AND rd.deadline_type = 'OFFICIAL' AND rd.due_date >= date('now')) AS next_official_deadline,
      (SELECT COUNT(*) FROM requirements req WHERE req.obligation_id = o.id) AS requirement_count,
      (SELECT COUNT(*) FROM regulatory_documents doc WHERE doc.obligation_id = o.id) AS document_count
    FROM regulatory_obligations o JOIN regulators r ON r.id = o.regulator_id JOIN regulations n ON n.id = o.regulation_id
    WHERE (? = '' OR r.id = ? OR r.acronym = ?)
      AND (? = '' OR o.category = ?)
      AND (? = '' OR o.status = ?)
      AND (? = '' OR o.frequency = ?)
      AND (? = '' OR lower(o.title || ' ' || o.description || ' ' || o.code || ' ' || o.category || ' ' || n.title) LIKE '%' || lower(?) || '%')
    ORDER BY CASE WHEN next_official_deadline IS NULL THEN 1 ELSE 0 END, next_official_deadline, r.acronym, o.code`)
    .all(regulator, regulator, regulator, category, category, status, status, frequency, frequency, q, q);
  return rows.map((row) => ({ ...row, mapping_coverage: row.field_count ? Math.round((row.mapped_field_count / row.field_count) * 100) : null, dq_coverage: row.field_count ? Math.round((row.dq_field_count / row.field_count) * 100) : null }));
}

function obligationDetail(db, id) {
  const obligation = db.prepare(`SELECT o.*, r.name AS regulator_name, r.acronym AS regulator_acronym, n.title AS regulation_title, n.number AS regulation_number, n.source_url AS regulation_source_url, n.source_excerpt AS regulation_excerpt
    FROM regulatory_obligations o JOIN regulators r ON r.id = o.regulator_id JOIN regulations n ON n.id = o.regulation_id WHERE o.id = ?`).get(id);
  if (!obligation) throw new ApiError('Obligation not found.', 404, 'OBLIGATION_NOT_FOUND');
  const requirements = db.prepare(`SELECT q.*, s.source_url, s.source_title, s.content_hash, s.content_hash_scope
    FROM requirements q LEFT JOIN regulatory_sources s ON s.id = q.source_id WHERE q.obligation_id = ? ORDER BY q.id`).all(id);
  const documents = db.prepare(`SELECT d.*, sv.id AS schema_version_id, sv.version, sv.schema_type, sv.schema_url, sv.fields_count, sv.field_inventory_scope, sv.parse_status, sv.adapter_config_json
    FROM regulatory_documents d LEFT JOIN schema_versions sv ON sv.document_id = d.id AND sv.status = 'CURRENT'
    WHERE d.obligation_id = ? ORDER BY d.code`).all(id);
  const fields = db.prepare(`SELECT f.*, sv.version AS schema_version, d.code AS document_code, d.name AS document_name,
      (SELECT COUNT(*) FROM dq_rules q WHERE q.regulatory_field_id=f.id) AS dq_rule_count
    FROM regulatory_fields f JOIN schema_versions sv ON sv.id = f.schema_version_id JOIN regulatory_documents d ON d.id = sv.document_id
    WHERE d.obligation_id = ? ORDER BY d.code, f.path`).all(id);
  const mappings = listMappings(db, new URLSearchParams({ obligation_id: id }));
  const deadlines = listDeadlines(db, new URLSearchParams({ obligation_id: id }));
  const controls = db.prepare('SELECT * FROM regulatory_controls WHERE obligation_id = ? ORDER BY control_name').all(id);
  const evidence = db.prepare('SELECT * FROM evidence_items WHERE obligation_id = ? ORDER BY collected_at DESC').all(id);
  const changes = listChanges(db, new URLSearchParams({ obligation_id: id }));
  const sources = db.prepare(`SELECT DISTINCT s.*,
    (SELECT COUNT(*) FROM regulatory_source_snapshots ss WHERE ss.source_id=s.id) AS raw_snapshot_count
    FROM regulatory_sources s LEFT JOIN requirements q ON q.source_id = s.id LEFT JOIN regulatory_documents d ON d.source_id = s.id
    WHERE q.obligation_id = ? OR d.obligation_id = ? OR EXISTS (SELECT 1 FROM regulatory_source_links l WHERE l.source_id = s.id AND l.entity_type = 'OBLIGATION' AND l.entity_id = ?)
    ORDER BY s.source_authority, s.source_title`).all(id,id,id);
  const stageAvailability = [
    ['Regulation', true], ['Obligation', true], ['Requirements', requirements.length > 0], ['Data elements / fields', fields.length > 0],
    ['Schema', documents.some((doc) => doc.schema_version_id)], ['Mappings', mappings.length > 0], ['Pipelines', mappings.some((mapping) => mapping.pipeline_name)],
    ['DQ', fields.some((field) => field.dq_rule_count > 0)], ['Submission adapter', documents.some((doc) => doc.adapter_config_json)], ['Evidence', evidence.length > 0],
  ];
  return { obligation, requirements, documents, fields, mappings, deadlines, controls, evidence, changes, sources, chain: stageAvailability.map(([label,available],index)=>({order:index+1,label,available})), is_demo_configuration: mappings.some((mapping)=>mapping.is_demo) || documents.some((doc)=>Boolean(doc.adapter_config_json)) };
}

function listRequirements(db, params) {
  const where = params.get('obligation_id') ? 'WHERE q.obligation_id = ?' : '';
  const values = params.get('obligation_id') ? [params.get('obligation_id')] : [];
  return db.prepare(`SELECT q.*, o.title AS obligation_title, o.code AS obligation_code, r.acronym AS regulator_acronym, s.source_url, s.source_title
    FROM requirements q JOIN regulatory_obligations o ON o.id = q.obligation_id JOIN regulators r ON r.id = o.regulator_id LEFT JOIN regulatory_sources s ON s.id = q.source_id ${where} ORDER BY r.acronym, o.code, q.id`).all(...values);
}

function listDocuments(db, params) {
  const where = params.get('obligation_id') ? 'WHERE d.obligation_id = ?' : '';
  const values = params.get('obligation_id') ? [params.get('obligation_id')] : [];
  return db.prepare(`SELECT d.*, o.title AS obligation_title, o.code AS obligation_code, r.acronym AS regulator_acronym, s.source_url,
    (SELECT COUNT(*) FROM schema_versions sv WHERE sv.document_id = d.id) AS schema_version_count
    FROM regulatory_documents d JOIN regulatory_obligations o ON o.id = d.obligation_id JOIN regulators r ON r.id = o.regulator_id LEFT JOIN regulatory_sources s ON s.id = d.source_id ${where} ORDER BY r.acronym,d.code`).all(...values);
}

function listSchemas(db, params) {
  const q = (params.get('q') || '').trim();
  return db.prepare(`SELECT sv.*, d.code AS document_code, d.name AS document_name, d.output_format, d.obligation_id, o.title AS obligation_title, r.acronym AS regulator_acronym, s.source_url, s.source_title,
    (SELECT COUNT(*) FROM regulatory_fields f WHERE f.schema_version_id = sv.id) AS catalogued_fields,
    (SELECT COUNT(*) FROM regulatory_changes c WHERE c.entity_id = sv.id OR c.entity_id = d.id) AS linked_changes
    FROM schema_versions sv JOIN regulatory_documents d ON d.id = sv.document_id JOIN regulatory_obligations o ON o.id = d.obligation_id JOIN regulators r ON r.id = o.regulator_id LEFT JOIN regulatory_sources s ON s.id = d.source_id
    WHERE (? = '' OR lower(d.code || ' ' || d.name || ' ' || sv.version || ' ' || o.title || ' ' || r.acronym) LIKE '%' || lower(?) || '%')
    ORDER BY r.acronym,d.code,sv.version DESC`).all(q,q);
}

function schemaDetail(db, id) {
  const schema = db.prepare(`SELECT sv.*, d.code AS document_code, d.name AS document_name, d.output_format, d.obligation_id, o.title AS obligation_title, r.acronym AS regulator_acronym, s.source_url, s.source_title
    FROM schema_versions sv JOIN regulatory_documents d ON d.id = sv.document_id JOIN regulatory_obligations o ON o.id = d.obligation_id JOIN regulators r ON r.id = o.regulator_id LEFT JOIN regulatory_sources s ON s.id = d.source_id WHERE sv.id = ?`).get(id);
  if (!schema) throw new ApiError('Schema version not found.', 404, 'SCHEMA_NOT_FOUND');
  const fields = db.prepare(`SELECT f.*, (SELECT COUNT(*) FROM data_mappings m WHERE m.regulatory_field_id = f.id) AS mapping_count,
    (SELECT COUNT(*) FROM dq_rules q WHERE q.regulatory_field_id = f.id) AS dq_rule_count
    FROM regulatory_fields f WHERE f.schema_version_id = ? ORDER BY f.path`).all(id);
  const changes = db.prepare(`SELECT * FROM regulatory_changes WHERE entity_id = ? OR entity_id = ? ORDER BY detected_at DESC`).all(id, schema.document_id);
  return { schema, fields, changes, adapter_configured: Boolean(schema.adapter_config_json), adapter_config: schema.adapter_config_json ? JSON.parse(schema.adapter_config_json) : null };
}

function listFields(db, params) {
  const q = (params.get('q') || '').trim();
  const regulator = params.get('regulator') || '';
  const obligationId = params.get('obligation_id') || '';
  return db.prepare(`SELECT f.*, sv.version AS schema_version, sv.schema_type, d.code AS document_code, d.name AS document_name, o.id AS obligation_id, o.title AS obligation_title, o.code AS obligation_code, r.acronym AS regulator_acronym,
    (SELECT COUNT(*) FROM data_mappings m WHERE m.regulatory_field_id = f.id AND m.mapping_status IN ('MAPPED','VALIDATED')) AS mapped_count,
    (SELECT COUNT(*) FROM dq_rules q WHERE q.regulatory_field_id = f.id) AS dq_rule_count
    FROM regulatory_fields f JOIN schema_versions sv ON sv.id = f.schema_version_id JOIN regulatory_documents d ON d.id = sv.document_id JOIN regulatory_obligations o ON o.id = d.obligation_id JOIN regulators r ON r.id = o.regulator_id
    WHERE (? = '' OR r.id = ? OR r.acronym = ?) AND (? = '' OR o.id = ?) AND (? = '' OR lower(f.name || ' ' || f.path || ' ' || f.description || ' ' || o.title) LIKE '%' || lower(?) || '%')
    ORDER BY r.acronym,d.code,f.path`).all(regulator,regulator,regulator,obligationId,obligationId,q,q);
}

function listChanges(db, params) {
  const q = (params.get('q') || '').trim().toLowerCase();
  const level = params.get('severity') || '';
  const rows = db.prepare(`SELECT * FROM regulatory_changes WHERE (? = '' OR severity = ?) ORDER BY detected_at DESC, id`).all(level,level);
  return rows.map((change) => enrichChange(db,change)).filter((change) => {
    if (params.get('obligation_id') && change.obligation?.id !== params.get('obligation_id')) return false;
    if (!q) return true;
    return `${change.summary} ${change.field || ''} ${change.regulator?.acronym || ''} ${change.obligation?.title || ''} ${change.change_type}`.toLowerCase().includes(q);
  });
}

function enrichChange(db, change) {
  let obligation = null;
  let regulator = null;
  if (change.entity_type === 'SCHEMA_VERSION') {
    const schema = db.prepare('SELECT document_id FROM schema_versions WHERE id = ?').get(change.entity_id);
    if (schema) {
      const doc = db.prepare('SELECT obligation_id FROM regulatory_documents WHERE id = ?').get(schema.document_id);
      if (doc) obligation = db.prepare('SELECT * FROM regulatory_obligations WHERE id = ?').get(doc.obligation_id);
    }
    if (!obligation && change.entity_id === 'reg-susep-openinsurance') regulator = db.prepare('SELECT * FROM regulators WHERE id = ?').get('susep');
  } else if (change.entity_type === 'REGULATORY_DOCUMENT') {
    const doc = db.prepare('SELECT obligation_id FROM regulatory_documents WHERE id = ?').get(change.entity_id);
    if (doc) obligation = db.prepare('SELECT * FROM regulatory_obligations WHERE id = ?').get(doc.obligation_id);
  } else if (change.entity_type === 'OBLIGATION') {
    obligation = db.prepare('SELECT * FROM regulatory_obligations WHERE id = ?').get(change.entity_id);
  } else if (change.entity_type === 'REGULATION') {
    const regulation = db.prepare('SELECT * FROM regulations WHERE id = ?').get(change.entity_id);
    if (regulation) regulator = db.prepare('SELECT * FROM regulators WHERE id = ?').get(regulation.regulator_id);
  } else if (change.entity_type === 'SOURCE') {
    const source = db.prepare('SELECT * FROM regulatory_sources WHERE id = ?').get(change.entity_id);
    if (source) regulator = db.prepare('SELECT * FROM regulators WHERE id = ?').get(source.regulator_id);
  } else if (change.entity_type === 'MANUAL' && change.entity_id) {
    obligation = db.prepare('SELECT * FROM regulatory_obligations WHERE id = ?').get(change.entity_id) || null;
  }
  if (obligation) regulator = db.prepare('SELECT * FROM regulators WHERE id = ?').get(obligation.regulator_id);
  const impacts = db.prepare('SELECT * FROM technical_impacts WHERE regulatory_change_id = ? ORDER BY score DESC, impact_type').all(change.id);
  const source = change.source_url ? db.prepare('SELECT id,source_title,source_type,content_hash,content_hash_scope,status FROM regulatory_sources WHERE source_url = ? LIMIT 1').get(change.source_url) : null;
  return { ...change, obligation, regulator, impacts, source };
}

function registerChange(db, body) {
  const changeType = String(body.change_type || '').toUpperCase();
  if (!CHANGE_TYPES.has(changeType)) throw new ApiError('Unsupported change_type.', 400, 'INVALID_CHANGE_TYPE');
  if (!body.source_url || !isOfficialSourceUrl(body.source_url)) throw new ApiError('Provide an HTTPS URL on an allowlisted official domain.', 400, 'OFFICIAL_SOURCE_REQUIRED');
  if (!body.source_reference || !body.summary) throw new ApiError('source_reference and summary are required; keep the trace to the exact text or section.', 400, 'SOURCE_TRACE_REQUIRED');
  const entityId = body.obligation_id || body.regulation_id || 'unlinked-review';
  if (body.obligation_id && !db.prepare('SELECT id FROM regulatory_obligations WHERE id = ?').get(body.obligation_id)) throw new ApiError('obligation_id not found.', 404, 'OBLIGATION_NOT_FOUND');
  const id = randomUUID();
  const detectedAt = new Date().toISOString();
  const impact = calculateImpacts(changeType,{field:body.field || null, note:'User-submitted change; legal confirmation remains pending.'});
  db.prepare(`INSERT INTO regulatory_changes
    (id, entity_type, entity_id, old_version, new_version, change_type, field, old_value, new_value, detected_at, effective_at, severity, source_reference, source_url, summary, confidence, review_status, is_demo)
    VALUES (?, 'MANUAL', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'USER_SUBMITTED_UNVERIFIED', 'REVIEW_REQUIRED', ?)`)
    .run(id,entityId,body.old_version||null,body.new_version||null,changeType,body.field||null,body.old_value??null,body.new_value??null,detectedAt,body.effective_at||null,impact.level,body.source_reference,body.source_url,body.summary,body.is_demo?1:0);
  const insert = db.prepare(`INSERT INTO technical_impacts
    (id, regulatory_change_id, impact_type, severity, score, description, recommended_action, rationale)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const row of impact.impacts) insert.run(randomUUID(),id,row.impactType,row.severity,row.score,row.description,row.recommendedAction,row.rationale);
  writeAudit(db,'REGULATORY_CHANGE',id,'CREATED',null,{changeType,summary:body.summary,confidence:'USER_SUBMITTED_UNVERIFIED'},body.actor||'user');
  return enrichChange(db,db.prepare('SELECT * FROM regulatory_changes WHERE id = ?').get(id));
}

function listImpacts(db, params) {
  const changeId = params.get('change_id') || '';
  return db.prepare(`SELECT ti.*, c.change_type, c.field, c.summary, c.source_url, c.source_reference, c.severity AS change_severity
    FROM technical_impacts ti JOIN regulatory_changes c ON c.id = ti.regulatory_change_id
    WHERE (? = '' OR c.id = ?) ORDER BY c.detected_at DESC, ti.score DESC`).all(changeId,changeId);
}

function listNormDiff(db, params) {
  const regulations = listRegulations(db);
  const changes = listChanges(db, new URLSearchParams());
  const filtered = changes.filter((change) => ['REGULATION','MANUAL'].includes(change.entity_type) || /deadline|business_rule|population|format|documentation/i.test(change.change_type));
  return { regulations, changes: filtered, method: 'Registered source-backed version events plus lexical compare-on-demand; legal interpretation is not automated.' };
}

function compareNormDiff(body) {
  if (typeof body.old_text !== 'string' || typeof body.new_text !== 'string') throw new ApiError('old_text and new_text are required.', 400, 'TEXT_REQUIRED');
  if (body.old_text.length > 50_000 || body.new_text.length > 50_000) throw new ApiError('Each text must be 50 KB or less.', 413, 'TEXT_TOO_LARGE');
  return compareNormativeText(body.old_text,body.new_text);
}

function listMappings(db, params) {
  const q = (params.get('q') || '').trim();
  const status = params.get('status') || '';
  const obligationId = params.get('obligation_id') || '';
  const rows = db.prepare(`SELECT m.*, rf.name AS regulatory_field_name, rf.path AS regulatory_field_path, rf.description AS field_definition, rf.data_type AS regulatory_type,
      sv.version AS schema_version, doc.code AS document_code, doc.name AS document_name, o.id AS obligation_id, o.code AS obligation_code, o.title AS obligation_title,
      reg.acronym AS regulator_acronym, df.name AS source_field, df.data_type AS source_data_type, ds.name AS dataset_name, sys.name AS system_name,
      cm.qualified_name AS canonical_name,
      (SELECT GROUP_CONCAT(p.name, ', ') FROM pipeline_dependencies pd JOIN pipelines p ON p.id = pd.pipeline_id WHERE pd.mapping_id = m.id) AS pipeline_name,
      (SELECT COUNT(*) FROM dq_rules dq WHERE dq.mapping_id = m.id) AS dq_rule_count
    FROM data_mappings m JOIN regulatory_fields rf ON rf.id = m.regulatory_field_id JOIN schema_versions sv ON sv.id = rf.schema_version_id JOIN regulatory_documents doc ON doc.id = sv.document_id JOIN regulatory_obligations o ON o.id = doc.obligation_id JOIN regulators reg ON reg.id = o.regulator_id
    LEFT JOIN data_fields df ON df.id = m.data_field_id LEFT JOIN datasets ds ON ds.id = df.dataset_id LEFT JOIN internal_systems sys ON sys.id = ds.system_id LEFT JOIN canonical_data_elements cm ON cm.id = m.canonical_element_id
    WHERE (? = '' OR m.mapping_status = ?) AND (? = '' OR o.id = ?) AND (? = '' OR lower(rf.name || ' ' || rf.path || ' ' || o.title || ' ' || coalesce(df.name,'') || ' ' || coalesce(ds.name,'') || ' ' || coalesce(sys.name,'')) LIKE '%' || lower(?) || '%')
    ORDER BY CASE m.mapping_status WHEN 'REVIEW_REQUIRED' THEN 0 WHEN 'UNMAPPED' THEN 1 WHEN 'MAPPED' THEN 2 ELSE 3 END, reg.acronym, o.code, rf.path`).all(status,status,obligationId,obligationId,q,q);
  if (!params.has('status') && !params.has('q') && !params.has('obligation_id')) {
    const mappedFieldIds = new Set(rows.map((row)=>row.regulatory_field_id));
    const unmapped = db.prepare(`SELECT f.id AS regulatory_field_id, f.name AS regulatory_field_name, f.path AS regulatory_field_path, f.description AS field_definition, f.data_type AS regulatory_type,
      sv.version AS schema_version, doc.code AS document_code, doc.name AS document_name, o.id AS obligation_id, o.code AS obligation_code, o.title AS obligation_title, reg.acronym AS regulator_acronym,
      'UNMAPPED' AS mapping_status, 0 AS version, 0 AS is_demo, NULL AS source_field, NULL AS source_data_type, NULL AS dataset_name, NULL AS system_name, NULL AS canonical_name, NULL AS pipeline_name, 0 AS dq_rule_count
      FROM regulatory_fields f JOIN schema_versions sv ON sv.id=f.schema_version_id JOIN regulatory_documents doc ON doc.id=sv.document_id JOIN regulatory_obligations o ON o.id=doc.obligation_id JOIN regulators reg ON reg.id=o.regulator_id
      WHERE f.status <> 'DEPRECATED' ORDER BY reg.acronym,doc.code,f.path`).all();
    for (const row of unmapped) if (!mappedFieldIds.has(row.regulatory_field_id)) rows.push(row);
  }
  return rows;
}

function createMapping(db, body) {
  const fieldId = body.regulatory_field_id;
  if (!fieldId || !db.prepare('SELECT id FROM regulatory_fields WHERE id = ?').get(fieldId)) throw new ApiError('Valid regulatory_field_id is required.', 400, 'REGULATORY_FIELD_REQUIRED');
  const status = String(body.mapping_status || (body.data_field_id ? 'MAPPED' : 'UNMAPPED')).toUpperCase();
  if (!MAPPING_STATUSES.has(status)) throw new ApiError('Unsupported mapping_status.', 400, 'INVALID_MAPPING_STATUS');
  if (['MAPPED','VALIDATED'].includes(status) && !body.data_field_id) throw new ApiError('MAPPED and VALIDATED statuses require data_field_id.',400,'DATA_FIELD_REQUIRED');
  if (body.data_field_id && !db.prepare('SELECT id FROM data_fields WHERE id = ?').get(body.data_field_id)) throw new ApiError('data_field_id not found.', 404, 'DATA_FIELD_NOT_FOUND');
  if (body.canonical_element_id && !db.prepare('SELECT id FROM canonical_data_elements WHERE id = ?').get(body.canonical_element_id)) throw new ApiError('canonical_element_id not found.', 404, 'CANONICAL_ELEMENT_NOT_FOUND');
  let existing = null;
  if (body.data_field_id) existing = db.prepare('SELECT * FROM data_mappings WHERE regulatory_field_id = ? AND data_field_id = ?').get(fieldId,body.data_field_id);
  if (existing) return updateMapping(db,existing.id,{...body,mapping_status:status});
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO data_mappings (id, regulatory_field_id, data_field_id, canonical_element_id, transformation, sql_expression, python_expression, business_rule, mapping_status, owner, approved_by, version, is_demo, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
    .run(id,fieldId,body.data_field_id||null,body.canonical_element_id||null,body.transformation||'IDENTITY',body.sql_expression||null,body.python_expression||null,body.business_rule||null,status,body.owner||'Unassigned',status==='VALIDATED'?(body.approved_by||'Demo Reviewer'):null,body.is_demo===false?0:1,now);
  writeAudit(db,'DATA_MAPPING',id,'CREATED',null,{regulatory_field_id:fieldId,data_field_id:body.data_field_id||null,mapping_status:status},body.actor||'user');
  return listMappings(db,new URLSearchParams()).find((row)=>row.id===id) || db.prepare('SELECT * FROM data_mappings WHERE id = ?').get(id);
}

function updateMapping(db, id, body) {
  const current = db.prepare('SELECT * FROM data_mappings WHERE id = ?').get(id);
  if (!current) throw new ApiError('Mapping not found.',404,'MAPPING_NOT_FOUND');
  const status = String(body.mapping_status || current.mapping_status).toUpperCase();
  if (!MAPPING_STATUSES.has(status)) throw new ApiError('Unsupported mapping_status.',400,'INVALID_MAPPING_STATUS');
  const nextDataFieldId = body.data_field_id === undefined ? current.data_field_id : body.data_field_id;
  if (['MAPPED','VALIDATED'].includes(status) && !nextDataFieldId) throw new ApiError('MAPPED and VALIDATED statuses require data_field_id.',400,'DATA_FIELD_REQUIRED');
  if (nextDataFieldId && !db.prepare('SELECT id FROM data_fields WHERE id = ?').get(nextDataFieldId)) throw new ApiError('data_field_id not found.',404,'DATA_FIELD_NOT_FOUND');
  const canonicalId = body.canonical_element_id === undefined ? current.canonical_element_id : body.canonical_element_id;
  if (canonicalId && !db.prepare('SELECT id FROM canonical_data_elements WHERE id = ?').get(canonicalId)) throw new ApiError('canonical_element_id not found.',404,'CANONICAL_ELEMENT_NOT_FOUND');
  if (nextDataFieldId) {
    const conflict = db.prepare('SELECT id FROM data_mappings WHERE regulatory_field_id = ? AND data_field_id = ? AND id <> ?').get(current.regulatory_field_id,nextDataFieldId,id);
    if (conflict) throw new ApiError('That internal field is already mapped to this regulatory field.',409,'DUPLICATE_MAPPING');
  }
  const next = {
    data_field_id: nextDataFieldId,
    canonical_element_id: canonicalId,
    transformation: body.transformation || current.transformation,
    sql_expression: body.sql_expression === undefined ? current.sql_expression : body.sql_expression,
    python_expression: body.python_expression === undefined ? current.python_expression : body.python_expression,
    business_rule: body.business_rule === undefined ? current.business_rule : body.business_rule,
    mapping_status: status,
    owner: body.owner || current.owner,
    approved_by: status === 'VALIDATED' ? (body.approved_by || current.approved_by || 'Demo Reviewer') : null,
  };
  const now = new Date().toISOString();
  db.prepare(`UPDATE data_mappings SET data_field_id=?,canonical_element_id=?,transformation=?,sql_expression=?,python_expression=?,business_rule=?,mapping_status=?,owner=?,approved_by=?,version=version+1,updated_at=? WHERE id=?`)
    .run(next.data_field_id,next.canonical_element_id,next.transformation,next.sql_expression,next.python_expression,next.business_rule,next.mapping_status,next.owner,next.approved_by,now,id);
  writeAudit(db,'DATA_MAPPING',id,'UPDATED',current,next,body.actor||'user');
  return listMappings(db,new URLSearchParams()).find((row)=>row.id===id) || db.prepare('SELECT * FROM data_mappings WHERE id = ?').get(id);
}

function listInternalData(db) {
  const systems = db.prepare('SELECT * FROM internal_systems ORDER BY name').all().map((row) => ({ ...row, is_demo: Boolean(row.is_demo) }));
  const datasets = db.prepare(`SELECT d.*, s.name AS system_name, s.type AS system_type FROM datasets d JOIN internal_systems s ON s.id=d.system_id ORDER BY s.name,d.name`)
    .all().map((row) => ({ ...row, is_demo: Boolean(row.is_demo) }));
  const fields = db.prepare(`SELECT f.*, d.name AS dataset_name, s.name AS system_name, c.qualified_name AS canonical_name
    FROM data_fields f JOIN datasets d ON d.id=f.dataset_id JOIN internal_systems s ON s.id=d.system_id LEFT JOIN canonical_data_elements c ON c.id=f.canonical_element_id
    ORDER BY s.name,d.name,f.name`).all().map((row) => ({ ...row, is_demo: Boolean(row.is_demo) }));
  const canonical_elements = db.prepare('SELECT * FROM canonical_data_elements ORDER BY domain,qualified_name').all().map((row) => ({ ...row, is_demo: Boolean(row.is_demo) }));
  return { systems, datasets, fields, canonical_elements, all_internal_records_are_demo: [...systems,...datasets,...fields].every((row)=>row.is_demo) };
}

function listCatalog(db, params) {
  const q = (params.get('q') || '').trim();
  return db.prepare(`SELECT c.*, (SELECT COUNT(DISTINCT m.regulatory_field_id) FROM data_mappings m WHERE m.canonical_element_id=c.id) AS regulatory_field_count,
      (SELECT COUNT(DISTINCT o.id) FROM data_mappings m JOIN regulatory_fields f ON f.id=m.regulatory_field_id JOIN schema_versions sv ON sv.id=f.schema_version_id JOIN regulatory_documents d ON d.id=sv.document_id JOIN regulatory_obligations o ON o.id=d.obligation_id WHERE m.canonical_element_id=c.id) AS obligation_count,
      (SELECT COUNT(*) FROM canonical_mappings cm WHERE cm.canonical_element_id=c.id AND cm.mapping_status IN ('MAPPED','VALIDATED')) AS internal_source_count,
      (SELECT GROUP_CONCAT(DISTINCT r.acronym) FROM data_mappings m JOIN regulatory_fields f ON f.id=m.regulatory_field_id JOIN schema_versions sv ON sv.id=f.schema_version_id JOIN regulatory_documents d ON d.id=sv.document_id JOIN regulatory_obligations o ON o.id=d.obligation_id JOIN regulators r ON r.id=o.regulator_id WHERE m.canonical_element_id=c.id) AS regulators
    FROM canonical_data_elements c WHERE (? = '' OR lower(c.qualified_name || ' ' || c.description || ' ' || c.domain) LIKE '%' || lower(?) || '%') ORDER BY c.domain,c.qualified_name`).all(q,q);
}

function getLineage(db, params) {
  const dataFieldId = params.get('data_field_id') || '';
  const obligationId = params.get('obligation_id') || '';
  const q = (params.get('q') || '').trim();
  let mappings = listMappings(db,new URLSearchParams());
  mappings = mappings.filter((mapping)=>mapping.data_field_id && (!dataFieldId || mapping.data_field_id===dataFieldId) && (!obligationId || mapping.obligation_id===obligationId));
  if (q) mappings = mappings.filter((mapping)=>`${mapping.source_field} ${mapping.dataset_name} ${mapping.system_name} ${mapping.regulatory_field_name} ${mapping.obligation_title}`.toLowerCase().includes(q.toLowerCase()));
  const nodes = new Map(); const edges=[];
  const add=(id,type,label,detail)=>{ if(!nodes.has(id)) nodes.set(id,{id,type,label,detail}); };
  for (const mapping of mappings) {
    const sysId=`system:${mapping.system_name}`; const dsId=`dataset:${mapping.dataset_name}`; const fieldId=`datafield:${mapping.data_field_id}`;
    const canonId=mapping.canonical_element_id?`canonical:${mapping.canonical_element_id}`:null;
    const pipelineId=mapping.pipeline_name?`pipeline:${mapping.pipeline_name}`:null;
    const regFieldId=`regfield:${mapping.regulatory_field_id}`; const docId=`document:${mapping.document_code}:${mapping.obligation_id}`; const obligationNode=`obligation:${mapping.obligation_id}`; const regulatorNode=`regulator:${mapping.regulator_acronym}`;
    add(sysId,'SYSTEM',mapping.system_name,'DEMO SYSTEM'); add(dsId,'DATASET',mapping.dataset_name,'DEMO DATASET'); add(fieldId,'DATA_FIELD',mapping.source_field,mapping.source_data_type);
    add(regFieldId,'REGULATORY_FIELD',mapping.regulatory_field_name,mapping.regulatory_field_path); add(docId,'DOCUMENT',mapping.document_code,mapping.document_name); add(obligationNode,'OBLIGATION',mapping.obligation_title,mapping.obligation_code); add(regulatorNode,'REGULATOR',mapping.regulator_acronym,'Official regulator');
    if (canonId) add(canonId,'CANONICAL',mapping.canonical_name,'Canonical data element');
    if (pipelineId) add(pipelineId,'PIPELINE',mapping.pipeline_name,'Configured pipeline');
    edges.push({from:sysId,to:dsId,label:'contains'},{from:dsId,to:fieldId,label:'field'});
    if (canonId) edges.push({from:fieldId,to:canonId,label:'canonical mapping'});
    if (pipelineId) edges.push({from:fieldId,to:pipelineId,label:'consumed by'});
    edges.push({from:fieldId,to:regFieldId,label:mapping.transformation},{from:regFieldId,to:docId,label:'serialized in'},{from:docId,to:obligationNode,label:'fulfills'},{from:obligationNode,to:regulatorNode,label:'reported to'});
  }
  return { nodes:[...nodes.values()], edges, mappings_count:mappings.length, is_demo: mappings.some((m)=>m.is_demo), note:'Lineage edge set is built from persisted mapping/dependency records; no internal production source is connected in this prototype.' };
}

function listDq(db) {
  const rules = db.prepare(`SELECT q.*, f.name AS field_name, f.path AS field_path, o.title AS obligation_title, o.code AS obligation_code, r.acronym AS regulator_acronym, m.mapping_status
    FROM dq_rules q JOIN regulatory_fields f ON f.id=q.regulatory_field_id JOIN schema_versions sv ON sv.id=f.schema_version_id JOIN regulatory_documents d ON d.id=sv.document_id JOIN regulatory_obligations o ON o.id=d.obligation_id JOIN regulators r ON r.id=o.regulator_id LEFT JOIN data_mappings m ON m.id=q.mapping_id ORDER BY r.acronym,o.code,f.path`).all();
  const latest = db.prepare(`SELECT run.*, (SELECT COUNT(*) FROM dq_run_results rr WHERE rr.dq_run_id=run.id AND rr.status='FAIL') AS fail_count FROM dq_runs run ORDER BY started_at DESC LIMIT 1`).get() || null;
  const recentRuns = db.prepare('SELECT * FROM dq_runs ORDER BY started_at DESC LIMIT 10').all();
  const results = latest ? db.prepare(`SELECT rr.*, q.name AS rule_name, q.rule_type, q.severity, q.description, f.name AS field_name, f.path AS field_path
    FROM dq_run_results rr JOIN dq_rules q ON q.id=rr.dq_rule_id JOIN regulatory_fields f ON f.id=q.regulatory_field_id WHERE rr.dq_run_id=? ORDER BY rr.status DESC, q.name`).all(latest.id) : [];
  return { rules, latest, recent_runs: recentRuns, latest_results: results, demo_data_only: true };
}

function runDq(db) {
  const run = runDqAgainstSeededData(db);
  const job = startJobRun(db,'run_quality');
  finishJobRun(db,job.id,run.failed?'COMPLETED_WITH_FAILURES':'SUCCEEDED',run.rules_evaluated,0,0,run.failed?`${run.failed} demo DQ check(s) failed`:null,run);
  return { ...run, note:'Executed only against synthetic DEMO DATA fixtures. Negative-control row is intentionally invalid.' };
}

function listDeadlines(db, params) {
  const type = params.get('deadline_type') || '';
  const obligationId = params.get('obligation_id') || '';
  return db.prepare(`SELECT d.*, o.code AS obligation_code, o.title AS obligation_title, r.acronym AS regulator_acronym, r.name AS regulator_name, o.owner AS obligation_owner
    FROM regulatory_deadlines d JOIN regulatory_obligations o ON o.id=d.obligation_id JOIN regulators r ON r.id=o.regulator_id
    WHERE (? = '' OR d.deadline_type = ?) AND (? = '' OR o.id = ?) ORDER BY d.due_date,r.acronym,o.code`).all(type,type,obligationId,obligationId)
    .map((row)=>({...row,...calendarStatus(row.due_date),owner:row.owner||row.obligation_owner,is_demo:Boolean(row.is_demo)}));
}

function createInternalDeadline(db, body) {
  const obligationId = String(body.obligation_id || '');
  const obligation = db.prepare('SELECT id FROM regulatory_obligations WHERE id=?').get(obligationId);
  if (!obligation) throw new ApiError('A valid obligation_id is required.', 400, 'OBLIGATION_REQUIRED');
  const dueDate = String(body.due_date || '');
  if (!isValidIsoDate(dueDate)) throw new ApiError('due_date must be a real date in YYYY-MM-DD format.', 400, 'INVALID_DUE_DATE');
  const referencePeriod = String(body.reference_period || '').trim();
  const owner = String(body.owner || '').trim();
  if (!referencePeriod || referencePeriod.length > 64 || !owner || owner.length > 120) {
    throw new ApiError('reference_period and owner are required (maximum 64 and 120 characters).', 400, 'INTERNAL_DEADLINE_FIELDS_REQUIRED');
  }
  const id = randomUUID();
  const status = calendarStatus(dueDate).status;
  const createdAt = new Date().toISOString();
  const basis = String(body.calculation_basis || 'Internal planning target entered by an operator; not a regulatory due date.').slice(0, 1000);
  db.prepare(`INSERT INTO regulatory_deadlines
    (id,obligation_id,reference_period,due_date,deadline_type,source_url,status,owner,calculation_basis,is_demo)
    VALUES (?,?,?,?,'INTERNAL',NULL,?,?,?,1)`)
    .run(id,obligationId,referencePeriod,dueDate,status,owner,basis);
  writeAudit(db,'REGULATORY_DEADLINE',id,'INTERNAL_TARGET_CREATED',null,{obligation_id:obligationId,reference_period:referencePeriod,due_date:dueDate,owner,deadline_type:'INTERNAL',is_demo:true},body.actor||'user');
  return { ...db.prepare('SELECT * FROM regulatory_deadlines WHERE id=?').get(id), ...calendarStatus(dueDate), is_demo: true,
    notice: 'INTERNAL planning target only. This record is not an official regulatory deadline.' };
}

function isValidIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === value;
}

function listSubmissions(db) {
  return db.prepare(`SELECT s.*, o.code AS obligation_code, o.title AS obligation_title, r.acronym AS regulator_acronym,
    (SELECT COUNT(*) FROM validation_results v WHERE v.submission_id=s.id) AS validation_count
    FROM submissions s JOIN regulatory_obligations o ON o.id=s.obligation_id JOIN regulators r ON r.id=o.regulator_id ORDER BY s.generated_at DESC`).all().map((row)=>({...row,is_demo:Boolean(row.is_demo),validation_summary:row.validation_summary?JSON.parse(row.validation_summary):null}));
}

function listSources(db, params) {
  const regulator = params.get('regulator') || '';
  return db.prepare(`SELECT s.*, r.acronym AS regulator_acronym, r.name AS regulator_name,
    (SELECT COUNT(*) FROM regulatory_source_snapshots ss WHERE ss.source_id=s.id) AS raw_snapshot_count,
    (SELECT MAX(collected_at) FROM regulatory_source_snapshots ss WHERE ss.source_id=s.id) AS last_raw_snapshot_at,
    (SELECT COUNT(*) FROM regulatory_extraction_candidates ec WHERE ec.source_id=s.id) AS extraction_candidates
    FROM regulatory_sources s JOIN regulators r ON r.id=s.regulator_id WHERE (? = '' OR r.id = ? OR r.acronym = ?) ORDER BY r.acronym,s.source_title`).all(regulator,regulator,regulator).map((row)=>({...row,hash_notice:row.content_hash_scope==='CURATED_EXCERPT_SHA256'?'Hash of stored curated text excerpt; not a hash of the remote file.':row.content_hash_scope==='RAW_RESPONSE_SHA256'?'Hash of the captured raw HTTP response.':'No content hash captured.'}));
}

function listEvidence(db, params) {
  const obligationId=params.get('obligation_id')||'';
  return db.prepare(`SELECT e.*, o.code AS obligation_code, o.title AS obligation_title, r.acronym AS regulator_acronym, c.control_name
    FROM evidence_items e LEFT JOIN regulatory_obligations o ON o.id=e.obligation_id LEFT JOIN regulators r ON r.id=o.regulator_id LEFT JOIN regulatory_controls c ON c.id=e.control_id
    WHERE (? = '' OR o.id = ?) ORDER BY e.collected_at DESC`).all(obligationId,obligationId).map((row)=>({...row,is_demo:Boolean(row.is_demo)}));
}

function createEvidence(db, body) {
  if (!body.title || !body.evidence_type) throw new ApiError('title and evidence_type are required.',400,'EVIDENCE_FIELDS_REQUIRED');
  if (body.obligation_id && !db.prepare('SELECT id FROM regulatory_obligations WHERE id=?').get(body.obligation_id)) throw new ApiError('obligation_id not found.',404,'OBLIGATION_NOT_FOUND');
  if (body.control_id) {
    const control = db.prepare('SELECT id,obligation_id FROM regulatory_controls WHERE id=?').get(body.control_id);
    if (!control) throw new ApiError('control_id not found.',404,'CONTROL_NOT_FOUND');
    if (body.obligation_id && control.obligation_id !== body.obligation_id) throw new ApiError('control_id must belong to the selected obligation.',400,'CONTROL_OBLIGATION_MISMATCH');
  }
  const id=randomUUID(); const now=new Date().toISOString();
  db.prepare(`INSERT INTO evidence_items (id,obligation_id,control_id,evidence_type,title,artifact_path,collected_at,source_reference,content_hash,status,is_demo)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id,body.obligation_id||null,body.control_id||null,body.evidence_type,body.title,body.artifact_path||null,now,body.source_reference||null,body.content_hash||null,'AVAILABLE',body.is_demo===false?0:1);
  writeAudit(db,'EVIDENCE',id,'CREATED',null,body,body.actor||'user');
  return db.prepare('SELECT * FROM evidence_items WHERE id=?').get(id);
}

function createControl(db, body) {
  const controlName = String(body.control_name || '').trim();
  const obligationId = String(body.obligation_id || '');
  const owner = String(body.owner || '').trim();
  const frequency = String(body.frequency || '').trim();
  const evidenceType = String(body.evidence_type || '').trim();
  if (!controlName || controlName.length > 200 || !owner || owner.length > 120 || !frequency || frequency.length > 64 || !evidenceType || evidenceType.length > 120) {
    throw new ApiError('control_name, owner, frequency and evidence_type are required within their length limits.',400,'CONTROL_FIELDS_REQUIRED');
  }
  const obligation = db.prepare('SELECT id FROM regulatory_obligations WHERE id=?').get(obligationId);
  if (!obligation) throw new ApiError('A valid obligation_id is required.',400,'OBLIGATION_REQUIRED');
  const requirementId = body.requirement_id || null;
  if (requirementId) {
    const requirement = db.prepare('SELECT id,obligation_id FROM requirements WHERE id=?').get(requirementId);
    if (!requirement) throw new ApiError('requirement_id not found.',404,'REQUIREMENT_NOT_FOUND');
    if (requirement.obligation_id !== obligationId) throw new ApiError('requirement_id must belong to the selected obligation.',400,'REQUIREMENT_OBLIGATION_MISMATCH');
  }
  const id = randomUUID();
  db.prepare(`INSERT INTO regulatory_controls
    (id,control_name,obligation_id,requirement_id,owner,frequency,evidence_type,last_execution,result,status,is_demo)
    VALUES (?,?,?,?,?,?,?,NULL,'NOT_RUN','ACTIVE',1)`)
    .run(id,controlName,obligationId,requirementId,owner,frequency,evidenceType);
  writeAudit(db,'CONTROL',id,'CREATED',null,{control_name:controlName,obligation_id:obligationId,requirement_id:requirementId,owner,frequency,evidence_type:evidenceType,is_demo:true},body.actor||'user');
  return db.prepare('SELECT * FROM regulatory_controls WHERE id=?').get(id);
}

function listControls(db) {
  return db.prepare(`SELECT c.*, o.code AS obligation_code, o.title AS obligation_title, r.acronym AS regulator_acronym, req.description AS requirement_description,
    (SELECT COUNT(*) FROM evidence_items e WHERE e.control_id=c.id) AS evidence_count
    FROM regulatory_controls c JOIN regulatory_obligations o ON o.id=c.obligation_id JOIN regulators r ON r.id=o.regulator_id LEFT JOIN requirements req ON req.id=c.requirement_id ORDER BY r.acronym,o.code`).all().map((row)=>({...row,is_demo:Boolean(row.is_demo)}));
}

function listAudit(db, params) {
  const entityId=params.get('entity_id')||'';
  return db.prepare('SELECT * FROM audit_events WHERE (? = \'\' OR entity_id = ?) ORDER BY created_at DESC LIMIT 200').all(entityId,entityId).map((row)=>({...row,old_value:parseMaybeJson(row.old_value),new_value:parseMaybeJson(row.new_value)}));
}

function buildMatrix(db) {
  const obligations=listObligations(db,new URLSearchParams());
  const mappings=listMappings(db,new URLSearchParams());
  const matrix=obligations.map((obligation)=>{
    const related=mappings.filter((mapping)=>mapping.obligation_id===obligation.id && mapping.data_field_id);
    const systems=[...new Set(related.map((mapping)=>mapping.system_name).filter(Boolean))];
    const datasets=[...new Set(related.map((mapping)=>mapping.dataset_name).filter(Boolean))];
    const pipelines=[...new Set(related.flatMap((mapping)=>String(mapping.pipeline_name||'').split(', ').filter(Boolean)))];
    return {...obligation,systems,datasets,pipelines,teams:[...new Set(related.map((mapping)=>mapping.owner).filter(Boolean))],is_demo:related.some((mapping)=>mapping.is_demo)};
  });
  return { obligations:matrix, assets:{systems:[...new Set(matrix.flatMap((row)=>row.systems))],datasets:[...new Set(matrix.flatMap((row)=>row.datasets))],pipelines:[...new Set(matrix.flatMap((row)=>row.pipelines))]}, note:'Cells are derived from stored mapping and pipeline-dependency rows; DEMO DATA assets only.' };
}

function engineeringData(db) {
  const changes=db.prepare('SELECT change_type,COUNT(*) AS count FROM regulatory_changes GROUP BY change_type').all();
  const mapStatuses=db.prepare('SELECT mapping_status,COUNT(*) AS count FROM data_mappings GROUP BY mapping_status').all();
  const schemaFields=db.prepare('SELECT COUNT(*) AS n FROM regulatory_fields').get().n;
  const mapped=db.prepare("SELECT COUNT(DISTINCT regulatory_field_id) AS n FROM data_mappings WHERE mapping_status IN ('MAPPED','VALIDATED')").get().n;
  const openMappings=db.prepare("SELECT COUNT(*) AS n FROM data_mappings WHERE mapping_status IN ('UNMAPPED','REVIEW_REQUIRED')").get().n;
  const pipelines=db.prepare("SELECT COUNT(*) AS n FROM pipelines WHERE status <> 'INACTIVE'").get().n;
  const dependencies=db.prepare('SELECT COUNT(*) AS n FROM pipeline_dependencies').get().n;
  const dqRules=db.prepare('SELECT COUNT(*) AS n FROM dq_rules').get().n;
  const lastDq=db.prepare('SELECT * FROM dq_runs ORDER BY started_at DESC LIMIT 1').get()||null;
  const submissionsAtRisk=db.prepare("SELECT COUNT(*) AS n FROM regulatory_deadlines d LEFT JOIN submissions s ON s.obligation_id=d.obligation_id AND s.reference_period=d.reference_period WHERE d.deadline_type='OFFICIAL' AND d.due_date >= date('now') AND coalesce(s.status,'') NOT IN ('READY','SUBMITTED','ACCEPTED')").get().n;
  return { schemas_changed:changes.reduce((sum,row)=>sum+row.count,0), change_types:changes, field_count:schemaFields, mapped_fields:mapped, unmapped_or_review_mappings:openMappings, mapping_statuses:mapStatuses, pipelines, pipeline_dependencies:dependencies, dq_rules:dqRules, latest_dq_run:lastDq, submissions_at_risk:submissionsAtRisk, technical_debt:schemaFields-mapped, note:'Engineering indicators are calculated from catalogued metadata and demo mappings; this is not an assessment of any real client estate.' };
}

function regulatoryData(db) {
  return { regulations:db.prepare("SELECT COUNT(*) AS n FROM regulations WHERE status='ACTIVE'").get().n, obligations:db.prepare("SELECT COUNT(*) AS n FROM regulatory_obligations WHERE status='ACTIVE'").get().n,
    upcoming_effective_dates:db.prepare("SELECT COUNT(*) AS n FROM regulatory_obligations WHERE effective_date >= date('now')").get().n,
    upcoming_deadlines:db.prepare("SELECT COUNT(*) AS n FROM regulatory_deadlines WHERE deadline_type='OFFICIAL' AND due_date >= date('now')").get().n,
    source_excerpts:db.prepare("SELECT COUNT(*) AS n FROM regulatory_sources WHERE status='EXCERPT_VERIFIED'").get().n,
    sources_not_raw_captured:db.prepare("SELECT COUNT(*) AS n FROM regulatory_sources WHERE content_hash_scope='CURATED_EXCERPT_SHA256'").get().n,
    change_review_queue:db.prepare("SELECT COUNT(*) AS n FROM regulatory_changes WHERE review_status='REVIEW_REQUIRED'").get().n,
    regulators:listRegulators(db), note:'A source excerpt is not a byte-for-byte capture of the full source document; raw snapshot count is exposed separately.' };
}

function executeJob(db, name) {
  if (name === 'run_quality') return runDq(db);
  if (name === 'generate_submissions') return runDemoPipeline(db,{});
  const result=runJob(db,name);
  return result;
}

async function retryError(db,id) {
  const error=db.prepare('SELECT * FROM ingestion_errors WHERE id=?').get(id);
  if (!error) throw new ApiError('Ingestion error not found.',404,'ERROR_NOT_FOUND');
  if (!error.source_id) throw new ApiError('This error has no source_id and cannot be retried automatically.',409,'ERROR_NOT_RETRYABLE');
  const result=await runCollectSources(db,{sourceIds:[error.source_id],limit:1});
  db.prepare('UPDATE ingestion_errors SET retry_count=retry_count+1,resolved=? WHERE id=?').run(result.errors===0?1:0,id);
  return {previous_error_id:id,retry_result:result};
}

function listErrors(db) {
  return db.prepare(`SELECT e.*, s.source_title, j.job_name FROM ingestion_errors e LEFT JOIN regulatory_sources s ON s.id=e.source_id LEFT JOIN job_runs j ON j.id=e.job_run_id ORDER BY e.timestamp DESC`).all().map((row)=>({...row,resolved:Boolean(row.resolved)}));
}

function listJobs(db) {
  const runs=db.prepare('SELECT * FROM job_runs ORDER BY started_at DESC LIMIT 100').all().map((row)=>({...row,result_json:parseMaybeJson(row.result_json),errors:parseMaybeJson(row.errors)}));
  const descriptions={
    collect_sources:'Fetch only official allowlisted HTTPS URLs; keep immutable raw bytes and SHA-256 on success.',parse_sources:'Extract text or mark format as UNSTRUCTURED; parser failures stay visible.',detect_versions:'Report source IDs with multiple immutable content hashes.',detect_changes:'Create hash-only changes for semantic review; never invent before/after.',extract_obligations:'Create low-confidence candidates for human review; no automatic official obligation publishing.',extract_schemas:'Create schema-field candidates for human review.',calculate_impacts:'Apply deterministic, explainable impact rules to typed changes.',update_deadlines:'Refresh status of already sourced deadlines; does not infer unknown deadlines.',run_quality:'Execute DQ rules against synthetic DEMO DATA fixtures.',generate_submissions:'Run the generic demonstration pipeline using a configured adapter.'
  };
  const available=Object.entries(descriptions).map(([name,description])=>({name,description,last_run:runs.find((run)=>run.job_name===name)||null}));
  return { runs, available, raw_snapshot_count:db.prepare('SELECT COUNT(*) AS n FROM regulatory_source_snapshots').get().n, source_excerpt_count:db.prepare("SELECT COUNT(*) AS n FROM regulatory_sources WHERE status='EXCERPT_VERIFIED'").get().n };
}

function globalSearch(db,query) {
  const q=String(query||'').trim();
  if (q.length<2) return {query:q,results:[],note:'Enter at least two characters.'};
  const like=`%${q}%`;
  const results=[];
  for(const row of db.prepare(`SELECT o.id,o.code AS code,o.title AS title,o.description AS snippet,r.acronym AS regulator,'obligation' AS type FROM regulatory_obligations o JOIN regulators r ON r.id=o.regulator_id WHERE lower(o.title||' '||o.code||' '||o.description||' '||o.category) LIKE lower(?) LIMIT 30`).all(like)) results.push({...row,url:`/impact?id=${encodeURIComponent(row.id)}`});
  for(const row of db.prepare(`SELECT n.id,n.number AS code,n.title AS title,n.description AS snippet,r.acronym AS regulator,'regulation' AS type FROM regulations n JOIN regulators r ON r.id=n.regulator_id WHERE lower(n.title||' '||n.number||' '||coalesce(n.description,'')) LIKE lower(?) LIMIT 20`).all(like)) results.push({...row,url:'/regulatory'});
  for(const row of db.prepare(`SELECT f.id,f.name AS code,f.path AS title,f.description AS snippet,r.acronym AS regulator,'field' AS type FROM regulatory_fields f JOIN schema_versions sv ON sv.id=f.schema_version_id JOIN regulatory_documents d ON d.id=sv.document_id JOIN regulatory_obligations o ON o.id=d.obligation_id JOIN regulators r ON r.id=o.regulator_id WHERE lower(f.name||' '||f.path||' '||f.description) LIKE lower(?) LIMIT 30`).all(like)) results.push({...row,url:'/schemas'});
  for(const row of listChanges(db,new URLSearchParams()).filter((item)=>`${item.summary} ${item.field||''} ${item.change_type} ${item.regulator?.acronym||''} ${item.obligation?.title||''}`.toLowerCase().includes(q.toLowerCase())).slice(0,20)) results.push({id:row.id,code:row.change_type,title:row.summary,snippet:row.field||row.source_reference,regulator:row.regulator?.acronym||'',type:'change',url:'/changes'});
  for(const row of db.prepare(`SELECT s.id,s.source_type AS code,s.source_title AS title,s.source_url AS snippet,r.acronym AS regulator,'source' AS type FROM regulatory_sources s JOIN regulators r ON r.id=s.regulator_id WHERE lower(s.source_title||' '||s.source_type||' '||s.source_url||' '||coalesce(s.excerpt,'')) LIKE lower(?) LIMIT 30`).all(like)) results.push({...row,url:row.snippet,external:true});
  return {query:q,results:results.slice(0,80),total:results.length};
}

function writeAudit(db,entityType,entityId,action,oldValue,newValue,actor='user') {
  db.prepare('INSERT INTO audit_events (id,entity_type,entity_id,action,old_value,new_value,created_at,actor) VALUES (?,?,?,?,?,?,?,?)')
    .run(randomUUID(),entityType,entityId,action,oldValue===null?null:JSON.stringify(oldValue),newValue===null?null:JSON.stringify(newValue),new Date().toISOString(),actor);
}

function parseMaybeJson(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return value; }
}

function serveArtifact(res,filename) {
  if (filename.includes('/')||filename.includes('\\')||filename.includes('..')) return sendJson(res,400,{error:'INVALID_ARTIFACT_PATH',message:'Artifact path must be a single filename.'});
  const artifact=readArtifact(`storage/demo-artifacts/${filename}`);
  if(!artifact) return sendJson(res,404,{error:'ARTIFACT_NOT_FOUND',message:'Generated demo artifact not found.'});
  const extension=extname(filename).toLowerCase();
  const types={'.xml':'application/xml','.json':'application/json','.csv':'text/csv','.txt':'text/plain'};
  res.writeHead(200,{'Content-Type':`${types[extension]||'application/octet-stream'}; charset=utf-8`,'Content-Disposition':`attachment; filename="${filename}"`,'Cache-Control':'no-store'});
  res.end(artifact.body);
}

function serveStatic(req,res,pathname) {
  if (pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
  const publicPath=pathname==='/'?'/index.html':pathname;
  const resolved=resolve(publicRoot,`.${publicPath}`);
  if(!resolved.startsWith(publicRoot)) { res.writeHead(403); return res.end('Forbidden'); }
  const file=existsSync(resolved)&&extname(resolved)?resolved:resolve(publicRoot,'index.html');
  if(!existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
  const type={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'}[extname(file)]||'application/octet-stream';
  res.writeHead(200,{'Content-Type':`${type}; charset=utf-8`,'Cache-Control':extname(file)==='.html'?'no-cache':'public, max-age=300'});
  res.end(readFileSync(file));
}

async function readJson(req) {
  const chunks=[]; let size=0;
  for await (const chunk of req) {
    size+=chunk.length;
    if(size>MAX_BODY) throw new ApiError('Request body too large.',413,'BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  if(!chunks.length) return {};
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError('Request body must be valid JSON.',400,'INVALID_JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError('Request body must be a JSON object.',400,'INVALID_JSON_BODY');
  return body;
}

function sendJson(res,status,data) {
  if(res.headersSent) return;
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(JSON.stringify(data));
}

class ApiError extends Error {
  constructor(message,statusCode=400,code='BAD_REQUEST'){super(message);this.statusCode=statusCode;this.code=code;}
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const { server }=createAppServer();
  const port=Number(process.env.PORT||3000);
  server.listen(port,'0.0.0.0',()=>console.log(JSON.stringify({level:'info',message:'LCF Regulatory Data Intelligence ready',host:'0.0.0.0',port,database:'SQLite / data/regtech.sqlite'})));
  const shutdown=()=>server.close(()=>process.exit(0));
  process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
}
