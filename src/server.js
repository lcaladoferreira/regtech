import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { closeDatabase, isProductionRuntime } from './db.js';
import { calculateImpacts } from './engines/impact-engine.js';
import { compareNormativeText } from './engines/schema-diff.js';
import { runDqAgainstSeededData } from './engines/dq-engine.js';
import { runJob, runCollectSources, startJobRun, finishJobRun, isOfficialSourceUrl } from './engines/ingestion.js';
import { calendarStatus } from './engines/deadlines.js';
import { generateSubmission, validateSubmission, runDemoPipeline, readArtifact, SubmissionError } from './services/submission-service.js';
import { assertAdmin, assertCronOrAdmin, AuthError } from './auth.js';
import { createStorage } from './storage.js';
import { ADAPTERS, syncOfficialRegistry } from './sources/index.js';

const here = resolve(fileURLToPath(new URL('../', import.meta.url)));
const publicRoot = resolve(here, 'public');
const MAX_BODY = 1_500_000;
const MAPPING_STATUSES = new Set(['UNMAPPED','MAPPED','VALIDATED','REVIEW_REQUIRED']);
const CHANGE_TYPES = new Set([
  'FIELD_ADDED','NEW_REQUIRED_FIELD','FIELD_REMOVED','FIELD_RENAMED','TYPE_CHANGED','LENGTH_CHANGED','PRECISION_CHANGED',
  'REQUIRED_CHANGED','CARDINALITY_CHANGED','DOMAIN_CHANGED','ENUM_ADDED','ENUM_REMOVED','PATTERN_CHANGED','STRUCTURE_CHANGED',
  'DEADLINE_CHANGED','POPULATION_CHANGED','FORMAT_CHANGED','OBLIGATION_ADDED','DOCUMENTATION_CHANGED','SOURCE_HASH_CHANGED',
]);
// Stateless computation endpoints that mutate nothing and therefore stay public.
const OPEN_MUTATIONS = new Set(['/api/norm-diff/compare']);

const ROUTE_META = {
  '/dashboard': ['Overview', 'Workspace intelligence'],
  '/sources': ['Official sources', 'Monitored authorities, snapshots and provenance'],
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

export function createAppServer({ db = null, closeDbOnStop = false } = {}) {
  let storagePromise = null;
  const getStorage = () => { storagePromise ??= createStorage({ db }).catch((error) => ({ provider: 'unavailable', error: String(error?.message || error) })); return storagePromise; };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);
    const requestId = randomUUID();
    try {
      if (pathname.startsWith('/api/')) {
        await handleApi(req, res, db, url, requestId, { getStorage });
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

export async function handleApi(req, res, db, url, requestId, context = {}) {
  const pathname = decodeURIComponent(url.pathname);
  const method = req.method || 'GET';
  const env = process.env;
  const production = isProductionRuntime(env);
  if (method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Key' });
    res.end();
    return;
  }
  if (method === 'GET' && pathname === '/api/health') {
    if (!db) {
      return sendJson(res, 200, {
        status: 'degraded', app: 'LCF Regulatory Data Intelligence', database: 'not_configured',
        persistence: 'POSTGRESQL_REQUIRED', data_mode: 'UNCONFIGURED',
        message: 'Production persistence is not configured. Set DATABASE_URL (PostgreSQL). SQLite is development-only and never used as production storage.',
        request_id: requestId, time: new Date().toISOString(),
      });
    }
    const storage = await (context.getStorage ? context.getStorage() : createStorage({ db }));
    const health = await healthPayload(db, storage);
    return sendJson(res, 200, { ...health, request_id: requestId });
  }
  if (!db) throw new ApiError('Production persistence is not configured: set DATABASE_URL to a PostgreSQL connection string. The dashboard shows no data because inventing data is not allowed.', 503, 'DATABASE_NOT_CONFIGURED');

  // Authentication boundary: every mutation requires the admin bearer secret; the collection
  // endpoint additionally accepts CRON_SECRET so Vercel Cron can trigger it. GETs stay public.
  const isCollectPath = pathname === '/api/jobs/collect' || pathname === '/api/jobs/collect_sources';
  const requiresAuth = (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method) && !OPEN_MUTATIONS.has(pathname))
    || (method === 'GET' && isCollectPath); // the GET form is the Vercel-Cron trigger — equally sensitive
  if (requiresAuth) {
    try {
      if (isCollectPath) assertCronOrAdmin(req, { production, adminKey: env.ADMIN_API_KEY, cronSecret: env.CRON_SECRET });
      else assertAdmin(req, { production, adminKey: env.ADMIN_API_KEY });
    } catch (error) {
      return sendJson(res, error.statusCode || 401, { error: error.code || 'UNAUTHORIZED', message: error.message, request_id: requestId, timestamp: new Date().toISOString() });
    }
  }

  if (method === 'GET' && pathname === '/api/dashboard') return sendJson(res, 200, await dashboardData(db));
  if (method === 'GET' && pathname === '/api/regulators') return sendJson(res, 200, await listRegulators(db));
  if (method === 'GET' && pathname === '/api/regulations') return sendJson(res, 200, await listRegulations(db));
  if (method === 'GET' && pathname === '/api/obligations') return sendJson(res, 200, await listObligations(db, url.searchParams));
  const obligationMatch = pathname.match(/^\/api\/obligations\/([^/]+)$/);
  if (method === 'GET' && obligationMatch) return sendJson(res, 200, await obligationDetail(db, obligationMatch[1]));
  if (method === 'GET' && pathname === '/api/requirements') return sendJson(res, 200, await listRequirements(db, url.searchParams));
  if (method === 'GET' && pathname === '/api/documents') return sendJson(res, 200, await listDocuments(db, url.searchParams));
  if (method === 'GET' && pathname === '/api/schemas') return sendJson(res, 200, await listSchemas(db, url.searchParams));
  const schemaMatch = pathname.match(/^\/api\/schemas\/([^/]+)$/);
  if (method === 'GET' && schemaMatch) return sendJson(res, 200, await schemaDetail(db, schemaMatch[1]));
  if (method === 'GET' && pathname === '/api/fields') return sendJson(res, 200, await listFields(db, url.searchParams));
  if (method === 'GET' && pathname === '/api/changes') return sendJson(res, 200, await listChanges(db, url.searchParams));
  if (method === 'POST' && pathname === '/api/changes') return sendJson(res, 201, await registerChange(db, await readJson(req)));
  const changeMatch = pathname.match(/^\/api\/changes\/([^/]+)$/);
  if (method === 'GET' && changeMatch) return sendJson(res, 200, await changeDetail(db, changeMatch[1]));
  if (method === 'GET' && pathname === '/api/impacts') return sendJson(res, 200, await listImpacts(db, url.searchParams));
  if (method === 'GET' && pathname === '/api/norm-diff') return sendJson(res, 200, await listNormDiff(db, url.searchParams));
  if (method === 'POST' && pathname === '/api/norm-diff/compare') return sendJson(res, 200, compareNormDiff(await readJson(req)));
  if (method === 'GET' && pathname === '/api/mappings') return sendJson(res, 200, await listMappings(db, url.searchParams));
  if (method === 'POST' && pathname === '/api/mappings') return sendJson(res, 201, await createMapping(db, await readJson(req)));
  const mappingMatch = pathname.match(/^\/api\/mappings\/([^/]+)$/);
  if (method === 'PUT' && mappingMatch) return sendJson(res, 200, await updateMapping(db, mappingMatch[1], await readJson(req)));
  if (method === 'GET' && pathname === '/api/catalog') return sendJson(res, 200, await listCatalog(db, url.searchParams));
  if (method === 'GET' && pathname === '/api/internal-data') return sendJson(res, 200, await listInternalData(db));
  if (method === 'GET' && pathname === '/api/lineage') return sendJson(res, 200, await getLineage(db, url.searchParams));
  if (method === 'GET' && pathname === '/api/dq') return sendJson(res, 200, await listDq(db));
  if (method === 'POST' && pathname === '/api/dq/run') return sendJson(res, 201, await runDq(db));
  if (method === 'GET' && pathname === '/api/deadlines') return sendJson(res, 200, await listDeadlines(db, url.searchParams));
  if (method === 'POST' && pathname === '/api/deadlines/internal') return sendJson(res, 201, await createInternalDeadline(db, await readJson(req)));
  if (method === 'GET' && pathname === '/api/submissions') return sendJson(res, 200, await listSubmissions(db));
  if (method === 'POST' && pathname === '/api/submissions/generate') return sendJson(res, 201, await generateSubmission(db, await readJson(req)));
  if (method === 'POST' && pathname === '/api/submissions/validate') return sendJson(res, 200, await validateSubmission(db, await readJson(req)));
  if (method === 'GET' && pathname === '/api/sources') return sendJson(res, 200, await listSources(db, url.searchParams));
  if (method === 'POST' && pathname === '/api/sources/sync') return sendJson(res, 200, await syncOfficialRegistry(db));
  const sourceContentMatch = pathname.match(/^\/api\/sources\/([^/]+)\/snapshots\/([^/]+)\/content$/);
  if (method === 'GET' && sourceContentMatch) return await serveSnapshotContent(res, db, sourceContentMatch[1], sourceContentMatch[2]);
  const snapshotsMatch = pathname.match(/^\/api\/sources\/([^/]+)\/snapshots$/);
  if (method === 'GET' && snapshotsMatch) return sendJson(res, 200, await listSourceSnapshots(db, snapshotsMatch[1], url.searchParams));
  const checksMatch = pathname.match(/^\/api\/sources\/([^/]+)\/checks$/);
  if (method === 'GET' && checksMatch) return sendJson(res, 200, await listSourceChecks(db, checksMatch[1]));
  const sourceMatch = pathname.match(/^\/api\/sources\/([^/]+)$/);
  if (method === 'GET' && sourceMatch) return sendJson(res, 200, await sourceDetail(db, sourceMatch[1], context));
  if (method === 'GET' && pathname === '/api/evidence') return sendJson(res, 200, await listEvidence(db, url.searchParams));
  if (method === 'POST' && pathname === '/api/evidence') return sendJson(res, 201, await createEvidence(db, await readJson(req)));
  if (method === 'GET' && pathname === '/api/controls') return sendJson(res, 200, await listControls(db));
  if (method === 'POST' && pathname === '/api/controls') return sendJson(res, 201, await createControl(db, await readJson(req)));
  if (method === 'GET' && pathname === '/api/audit') return sendJson(res, 200, await listAudit(db, url.searchParams));
  if (method === 'GET' && pathname === '/api/matrix') return sendJson(res, 200, await buildMatrix(db));
  if (method === 'GET' && pathname === '/api/engineering') return sendJson(res, 200, await engineeringData(db));
  if (method === 'GET' && pathname === '/api/regulatory') return sendJson(res, 200, await regulatoryData(db));
  if (method === 'GET' && pathname === '/api/cases') return sendJson(res, 200, await db.prepare(`SELECT c.*, r.acronym AS regulator_acronym, o.title AS obligation_title, s.source_url
    FROM regulatory_cases c JOIN regulators r ON r.id = c.regulator_id LEFT JOIN regulatory_obligations o ON o.id = c.obligation_id LEFT JOIN regulatory_sources s ON s.id = c.source_id ORDER BY c.code`).all());
  if (method === 'GET' && pathname === '/api/jobs') return sendJson(res, 200, await listJobs(db));
  if ((method === 'POST' || method === 'GET') && pathname === '/api/jobs/collect') {
    const body = method === 'POST' ? await readJson(req).catch(() => ({})) : {};
    return sendJson(res, 200, await runCollectSources(db, { limit: body.limit ?? 25, dueOnly: body.dueOnly !== false, trigger: 'cron', ...body }));
  }
  if (method === 'POST' && pathname === '/api/jobs/collect_sources') return sendJson(res, 200, await runCollectSources(db, { trigger: 'admin', ...(await readJson(req).catch(() => ({}))) }));
  const runJobMatch = pathname.match(/^\/api\/jobs\/([a-z_]+)\/run$/);
  if (method === 'POST' && runJobMatch) return sendJson(res, 200, await executeJob(db, runJobMatch[1]));
  if (method === 'GET' && pathname === '/api/errors') return sendJson(res, 200, await listErrors(db));
  const retryMatch = pathname.match(/^\/api\/errors\/([^/]+)\/retry$/);
  if (method === 'POST' && retryMatch) return sendJson(res, 200, await retryError(db, retryMatch[1]));
  if (method === 'GET' && pathname === '/api/search') return sendJson(res, 200, await globalSearch(db, url.searchParams.get('q') || ''));
  if (method === 'POST' && pathname === '/api/pipelines/run') return sendJson(res, 201, await runDemoPipeline(db, await readJson(req)));
  const artifactMatch = pathname.match(/^\/api\/artifacts\/([^/]+)$/);
  if (method === 'GET' && artifactMatch) return await serveArtifact(res, db, artifactMatch[1], context);
  sendJson(res, 404, { error: 'NOT_FOUND', message: `No API route for ${method} ${pathname}.`, request_id: requestId });
}

async function healthPayload(db, storage) {
  const today = new Date().toISOString().slice(0, 10);
  const lastRun = await db.prepare(`SELECT * FROM job_runs WHERE job_name = 'collect_sources' ORDER BY started_at DESC LIMIT 1`).get() || null;
  const sourcesMonitored = (await db.prepare('SELECT COUNT(*) AS n FROM regulatory_sources WHERE enabled = 1').get()).n;
  const snapshots = (await db.prepare('SELECT COUNT(*) AS n FROM regulatory_source_snapshots').get()).n;
  const rawSources = (await db.prepare("SELECT COUNT(*) AS n FROM regulatory_sources WHERE content_hash_scope = 'RAW_RESPONSE_SHA256'").get()).n;
  const openErrors = (await db.prepare('SELECT COUNT(*) AS n FROM ingestion_errors WHERE resolved = 0').get()).n;
  return {
    status: storage?.provider === 'unavailable' && rawSources > 0 ? 'degraded' : 'ok',
    app: 'LCF Regulatory Data Intelligence',
    version: '0.2.0',
    database: db.dialect === 'postgres' ? 'postgresql' : 'sqlite',
    persistence: db.dialect === 'postgres' ? 'POSTGRESQL' : 'SQLITE_DEV_ONLY',
    data_mode: db.dataMode || (db.dialect === 'postgres' ? 'LIVE' : 'DEMO_FIXTURES'),
    storage: storage?.provider || 'unknown',
    storage_error: storage?.error || null,
    last_ingestion: lastRun ? {
      id: lastRun.id, status: lastRun.status, started_at: lastRun.started_at, finished_at: lastRun.finished_at,
      sources_checked: lastRun.sources_checked, sources_changed: lastRun.sources_changed, sources_failed: lastRun.sources_failed,
    } : null,
    sources_monitored: sourcesMonitored,
    sources_with_raw_snapshots: rawSources,
    snapshots,
    open_ingestion_errors: openErrors,
    upcoming_official_deadlines: (await db.prepare("SELECT COUNT(*) AS n FROM regulatory_deadlines WHERE deadline_type = 'OFFICIAL' AND due_date >= ?").get(today)).n,
    time: new Date().toISOString(),
  };
}

async function dashboardData(db) {
  const today = new Date().toISOString().slice(0, 10);
  const since24h = new Date(Date.now() - 24 * 3600_000).toISOString();
  const since7d = new Date(Date.now() - 7 * 86400_000).toISOString();
  const since30d = new Date(Date.now() - 30 * 86400_000).toISOString();
  const counts = {
    regulator_count: (await db.prepare('SELECT COUNT(*) AS n FROM regulators WHERE active = 1').get()).n,
    obligation_count: (await db.prepare("SELECT COUNT(*) AS n FROM regulatory_obligations WHERE status = 'ACTIVE'").get()).n,
    source_count: (await db.prepare('SELECT COUNT(*) AS n FROM regulatory_sources').get()).n,
    sources_monitored: (await db.prepare('SELECT COUNT(*) AS n FROM regulatory_sources WHERE enabled = 1').get()).n,
    excerpt_verified_sources: (await db.prepare("SELECT COUNT(*) AS n FROM regulatory_sources WHERE status = 'EXCERPT_VERIFIED'").get()).n,
    raw_verified_sources: (await db.prepare("SELECT COUNT(*) AS n FROM regulatory_sources WHERE content_hash_scope = 'RAW_RESPONSE_SHA256'").get()).n,
    raw_snapshots: (await db.prepare('SELECT COUNT(*) AS n FROM regulatory_source_snapshots').get()).n,
    snapshots_24h: (await db.prepare('SELECT COUNT(*) AS n FROM regulatory_source_snapshots WHERE collected_at >= ?').get(since24h)).n,
    sources_changed_24h: (await db.prepare('SELECT COUNT(DISTINCT source_id) AS n FROM regulatory_source_snapshots WHERE collected_at >= ?').get(since24h)).n,
    sources_changed_7d: (await db.prepare('SELECT COUNT(DISTINCT source_id) AS n FROM regulatory_source_snapshots WHERE collected_at >= ?').get(since7d)).n,
    pending_review: (await db.prepare("SELECT COUNT(*) AS n FROM regulatory_changes WHERE review_status = 'REVIEW_REQUIRED'").get()).n,
    verification_checks_24h: (await db.prepare('SELECT COUNT(*) AS n FROM source_verification_checks WHERE checked_at >= ?').get(since24h)).n,
    schema_count: (await db.prepare('SELECT COUNT(*) AS n FROM schema_versions').get()).n,
    field_count: (await db.prepare("SELECT COUNT(*) AS n FROM regulatory_fields WHERE status <> 'DEPRECATED'").get()).n,
    mapped_field_count: (await db.prepare("SELECT COUNT(DISTINCT m.regulatory_field_id) AS n FROM data_mappings m WHERE m.mapping_status IN ('MAPPED','VALIDATED')").get()).n,
    dq_rule_count: (await db.prepare('SELECT COUNT(*) AS n FROM dq_rules').get()).n,
    deadline_count: (await db.prepare("SELECT COUNT(*) AS n FROM regulatory_deadlines WHERE deadline_type = 'OFFICIAL' AND due_date >= ?").get(today)).n,
    high_impact_change_count: (await db.prepare("SELECT COUNT(*) AS n FROM regulatory_changes WHERE severity IN ('HIGH','CRITICAL')").get()).n,
    ingestion_error_count: (await db.prepare('SELECT COUNT(*) AS n FROM ingestion_errors WHERE resolved = 0').get()).n,
  };
  const latestDq = await db.prepare('SELECT * FROM dq_runs ORDER BY started_at DESC LIMIT 1').get() || null;
  const changeCounts = {
    changes_7d: (await db.prepare('SELECT COUNT(*) AS n FROM regulatory_changes WHERE detected_at >= ?').get(since7d)).n,
    changes_30d: (await db.prepare('SELECT COUNT(*) AS n FROM regulatory_changes WHERE detected_at >= ?').get(since30d)).n,
    changes_total: (await db.prepare('SELECT COUNT(*) AS n FROM regulatory_changes').get()).n,
  };
  const lastRun = await db.prepare(`SELECT * FROM job_runs WHERE job_name = 'collect_sources' ORDER BY started_at DESC LIMIT 1`).get() || null;
  const lastAttempt = await db.prepare('SELECT * FROM job_runs ORDER BY started_at DESC LIMIT 1').get() || null;
  const sourceHealth = await db.prepare(`SELECT COALESCE(s.authority, r.acronym) AS authority,
      COUNT(*) AS sources,
      SUM(CASE WHEN s.last_http_status IN (200,304) AND s.consecutive_failures = 0 THEN 1 ELSE 0 END) AS healthy,
      SUM(CASE WHEN s.consecutive_failures > 0 THEN 1 ELSE 0 END) AS failing,
      MAX(s.last_checked_at) AS last_check
    FROM regulatory_sources s JOIN regulators r ON r.id = s.regulator_id WHERE s.enabled = 1
    GROUP BY COALESCE(s.authority, r.acronym) ORDER BY 1`).all();
  const obligations = await listObligations(db, new URLSearchParams());
  const changes = await listChanges(db, new URLSearchParams());
  const deadlines = await listDeadlines(db, new URLSearchParams());
  return {
    generated_at: new Date().toISOString(),
    data_mode: db.dataMode || 'UNKNOWN',
    counts: { ...counts, ...changeCounts, latest_dq_run: latestDq, unmapped_field_count: Math.max(0, counts.field_count - counts.mapped_field_count) },
    ingestion: {
      last_successful: lastRun && lastRun.status !== 'FAILED' ? lastRun : null,
      last_attempt: lastAttempt,
      last_collection: lastRun,
    },
    source_health: sourceHealth,
    top_changes: changes.slice(0, 4),
    upcoming_deadlines: deadlines.filter((deadline) => deadline.due_date >= today).slice(0, 4),
    obligations_preview: obligations.slice(0, 6),
    data_trust: {
      official_source_excerpts: counts.excerpt_verified_sources,
      raw_remote_snapshots: counts.raw_snapshots,
      sources_with_raw_capture: counts.raw_verified_sources,
      internal_demo_records: (await db.prepare('SELECT COUNT(*) AS n FROM demo_data WHERE is_demo = 1').get()).n,
    },
  };
}

async function listRegulators(db) {
  const rows = await db.prepare(`SELECT r.*,
    (SELECT COUNT(*) FROM regulations x WHERE x.regulator_id = r.id) AS regulation_count,
    (SELECT COUNT(*) FROM regulatory_obligations o WHERE o.regulator_id = r.id AND o.status = 'ACTIVE') AS obligation_count,
    (SELECT COUNT(*) FROM regulatory_sources s WHERE s.regulator_id = r.id) AS source_count,
    (SELECT COUNT(*) FROM regulatory_sources s WHERE s.regulator_id = r.id AND s.content_hash_scope = 'RAW_RESPONSE_SHA256') AS raw_monitored_count
    FROM regulators r ORDER BY r.name`).all();
  const changes = await listChanges(db, new URLSearchParams());
  return rows.map((row) => ({ ...row, change_count: changes.filter((change) => change.regulator?.id === row.id).length }));
}

async function listRegulations(db) {
  return await db.prepare(`SELECT n.*, r.name AS regulator_name, r.acronym AS regulator_acronym,
    (SELECT COUNT(*) FROM regulatory_obligations o WHERE o.regulation_id = n.id) AS obligation_count
    FROM regulations n JOIN regulators r ON r.id = n.regulator_id ORDER BY r.acronym, n.number`).all();
}

async function listObligations(db, params) {
  const q = (params.get('q') || '').trim();
  const regulator = params.get('regulator') || '';
  const category = params.get('category') || '';
  const status = params.get('status') || '';
  const frequency = params.get('frequency') || '';
  const today = new Date().toISOString().slice(0, 10);
  const rows = await db.prepare(`SELECT o.*, r.name AS regulator_name, r.acronym AS regulator_acronym,
      n.title AS regulation_title, n.number AS regulation_number, n.source_url AS regulation_source_url,
      (SELECT COUNT(*) FROM regulatory_fields f JOIN schema_versions sv ON sv.id = f.schema_version_id JOIN regulatory_documents d ON d.id = sv.document_id WHERE d.obligation_id = o.id AND f.status <> 'DEPRECATED') AS field_count,
      (SELECT COUNT(DISTINCT m.regulatory_field_id) FROM data_mappings m JOIN regulatory_fields f ON f.id = m.regulatory_field_id JOIN schema_versions sv ON sv.id = f.schema_version_id JOIN regulatory_documents d ON d.id = sv.document_id WHERE d.obligation_id = o.id AND m.mapping_status IN ('MAPPED','VALIDATED')) AS mapped_field_count,
      (SELECT COUNT(DISTINCT dq.regulatory_field_id) FROM dq_rules dq JOIN regulatory_fields f ON f.id = dq.regulatory_field_id JOIN schema_versions sv ON sv.id = f.schema_version_id JOIN regulatory_documents d ON d.id = sv.document_id WHERE d.obligation_id = o.id) AS dq_field_count,
      (SELECT MIN(due_date) FROM regulatory_deadlines rd WHERE rd.obligation_id = o.id AND rd.deadline_type = 'OFFICIAL' AND rd.due_date >= ?) AS next_official_deadline,
      (SELECT COUNT(*) FROM requirements req WHERE req.obligation_id = o.id) AS requirement_count,
      (SELECT COUNT(*) FROM regulatory_documents doc WHERE doc.obligation_id = o.id) AS document_count
    FROM regulatory_obligations o JOIN regulators r ON r.id = o.regulator_id JOIN regulations n ON n.id = o.regulation_id
    WHERE (? = '' OR r.id = ? OR r.acronym = ?)
      AND (? = '' OR o.category = ?)
      AND (? = '' OR o.status = ?)
      AND (? = '' OR o.frequency = ?)
      AND (? = '' OR lower(o.title || ' ' || o.description || ' ' || o.code || ' ' || o.category || ' ' || n.title) LIKE '%' || lower(?) || '%')
    ORDER BY CASE WHEN next_official_deadline IS NULL THEN 1 ELSE 0 END, next_official_deadline, r.acronym, o.code`)
    .all(today, regulator, regulator, regulator, category, category, status, status, frequency, frequency, q, q);
  return rows.map((row) => ({
    ...row,
    next_official_deadline: row.next_official_deadline ? String(row.next_official_deadline).slice(0, 10) : null,
    mapping_coverage: row.field_count ? Math.round((row.mapped_field_count / row.field_count) * 100) : null,
    dq_coverage: row.field_count ? Math.round((row.dq_field_count / row.field_count) * 100) : null,
  }));
}

async function obligationDetail(db, id) {
  const obligation = await db.prepare(`SELECT o.*, r.name AS regulator_name, r.acronym AS regulator_acronym, n.title AS regulation_title, n.number AS regulation_number, n.source_url AS regulation_source_url, n.source_excerpt AS regulation_excerpt
    FROM regulatory_obligations o JOIN regulators r ON r.id = o.regulator_id JOIN regulations n ON n.id = o.regulation_id WHERE o.id = ?`).get(id);
  if (!obligation) throw new ApiError('Obligation not found.', 404, 'OBLIGATION_NOT_FOUND');
  const requirements = await db.prepare(`SELECT q.*, s.source_url, s.source_title, s.content_hash, s.content_hash_scope
    FROM requirements q LEFT JOIN regulatory_sources s ON s.id = q.source_id WHERE q.obligation_id = ? ORDER BY q.id`).all(id);
  const documents = await db.prepare(`SELECT d.*, sv.id AS schema_version_id, sv.version, sv.schema_type, sv.schema_url, sv.fields_count, sv.field_inventory_scope, sv.parse_status, sv.adapter_config_json
    FROM regulatory_documents d LEFT JOIN schema_versions sv ON sv.document_id = d.id AND sv.status = 'CURRENT'
    WHERE d.obligation_id = ? ORDER BY d.code`).all(id);
  const fields = await db.prepare(`SELECT f.*, sv.version AS schema_version, d.code AS document_code, d.name AS document_name,
      (SELECT COUNT(*) FROM dq_rules q WHERE q.regulatory_field_id=f.id) AS dq_rule_count
    FROM regulatory_fields f JOIN schema_versions sv ON sv.id = f.schema_version_id JOIN regulatory_documents d ON d.id = sv.document_id
    WHERE d.obligation_id = ? ORDER BY d.code, f.path`).all(id);
  const mappings = await listMappings(db, new URLSearchParams({ obligation_id: id }));
  const deadlines = await listDeadlines(db, new URLSearchParams({ obligation_id: id }));
  const controls = await db.prepare('SELECT * FROM regulatory_controls WHERE obligation_id = ? ORDER BY control_name').all(id);
  const evidence = await db.prepare('SELECT * FROM evidence_items WHERE obligation_id = ? ORDER BY collected_at DESC').all(id);
  const changes = await listChanges(db, new URLSearchParams({ obligation_id: id }));
  const sources = await db.prepare(`SELECT DISTINCT s.*,
    (SELECT COUNT(*) FROM regulatory_source_snapshots ss WHERE ss.source_id=s.id) AS raw_snapshot_count,
    (SELECT MAX(collected_at) FROM regulatory_source_snapshots ss WHERE ss.source_id=s.id) AS last_raw_snapshot_at
    FROM regulatory_sources s LEFT JOIN requirements q ON q.source_id = s.id LEFT JOIN regulatory_documents d ON d.source_id = s.id
    WHERE q.obligation_id = ? OR d.obligation_id = ? OR EXISTS (SELECT 1 FROM regulatory_source_links l WHERE l.source_id = s.id AND l.entity_type = 'OBLIGATION' AND l.entity_id = ?)
    ORDER BY s.source_authority, s.source_title`).all(id, id, id);
  const stageAvailability = [
    ['Regulation', true], ['Obligation', true], ['Requirements', requirements.length > 0], ['Data elements / fields', fields.length > 0],
    ['Schema', documents.some((doc) => doc.schema_version_id)], ['Mappings', mappings.length > 0], ['Pipelines', mappings.some((mapping) => mapping.pipeline_name)],
    ['DQ', fields.some((field) => field.dq_rule_count > 0)], ['Submission adapter', documents.some((doc) => doc.adapter_config_json)], ['Evidence', evidence.length > 0],
  ];
  return { obligation, requirements, documents, fields, mappings, deadlines, controls, evidence, changes, sources, chain: stageAvailability.map(([label, available], index) => ({ order: index + 1, label, available })), is_demo_configuration: mappings.some((mapping) => mapping.is_demo) || documents.some((doc) => Boolean(doc.adapter_config_json)) };
}

async function listRequirements(db, params) {
  const where = params.get('obligation_id') ? 'WHERE q.obligation_id = ?' : '';
  const values = params.get('obligation_id') ? [params.get('obligation_id')] : [];
  return await db.prepare(`SELECT q.*, o.title AS obligation_title, o.code AS obligation_code, r.acronym AS regulator_acronym, s.source_url, s.source_title
    FROM requirements q JOIN regulatory_obligations o ON o.id = q.obligation_id JOIN regulators r ON r.id = o.regulator_id LEFT JOIN regulatory_sources s ON s.id = q.source_id ${where} ORDER BY r.acronym, o.code, q.id`).all(...values);
}

async function listDocuments(db, params) {
  const where = params.get('obligation_id') ? 'WHERE d.obligation_id = ?' : '';
  const values = params.get('obligation_id') ? [params.get('obligation_id')] : [];
  return await db.prepare(`SELECT d.*, o.title AS obligation_title, o.code AS obligation_code, r.acronym AS regulator_acronym, s.source_url,
    (SELECT COUNT(*) FROM schema_versions sv WHERE sv.document_id = d.id) AS schema_version_count
    FROM regulatory_documents d JOIN regulatory_obligations o ON o.id = d.obligation_id JOIN regulators r ON r.id = o.regulator_id LEFT JOIN regulatory_sources s ON s.id = d.source_id ${where} ORDER BY r.acronym, d.code`).all(...values);
}

async function listSchemas(db, params) {
  const q = (params.get('q') || '').trim();
  return await db.prepare(`SELECT sv.*, d.code AS document_code, d.name AS document_name, d.output_format, d.obligation_id, o.title AS obligation_title, r.acronym AS regulator_acronym, s.source_url, s.source_title,
    (SELECT COUNT(*) FROM regulatory_fields f WHERE f.schema_version_id = sv.id) AS catalogued_fields,
    (SELECT COUNT(*) FROM regulatory_changes c WHERE c.entity_id = sv.id OR c.entity_id = d.id) AS linked_changes
    FROM schema_versions sv JOIN regulatory_documents d ON d.id = sv.document_id JOIN regulatory_obligations o ON o.id = d.obligation_id JOIN regulators r ON r.id = o.regulator_id LEFT JOIN regulatory_sources s ON s.id = d.source_id
    WHERE (? = '' OR lower(d.code || ' ' || d.name || ' ' || sv.version || ' ' || o.title || ' ' || r.acronym) LIKE '%' || lower(?) || '%')
    ORDER BY r.acronym, d.code, sv.version DESC`).all(q, q);
}

async function schemaDetail(db, id) {
  const schema = await db.prepare(`SELECT sv.*, d.code AS document_code, d.name AS document_name, d.output_format, d.obligation_id, o.title AS obligation_title, r.acronym AS regulator_acronym, s.source_url, s.source_title
    FROM schema_versions sv JOIN regulatory_documents d ON d.id = sv.document_id JOIN regulatory_obligations o ON o.id = d.obligation_id JOIN regulators r ON r.id = o.regulator_id LEFT JOIN regulatory_sources s ON s.id = d.source_id WHERE sv.id = ?`).get(id);
  if (!schema) throw new ApiError('Schema version not found.', 404, 'SCHEMA_NOT_FOUND');
  const fields = await db.prepare(`SELECT f.*, (SELECT COUNT(*) FROM data_mappings m WHERE m.regulatory_field_id = f.id) AS mapping_count,
    (SELECT COUNT(*) FROM dq_rules q WHERE q.regulatory_field_id = f.id) AS dq_rule_count
    FROM regulatory_fields f WHERE f.schema_version_id = ? ORDER BY f.path`).all(id);
  const changes = await db.prepare(`SELECT * FROM regulatory_changes WHERE entity_id = ? OR entity_id = ? ORDER BY detected_at DESC`).all(id, schema.document_id);
  return { schema, fields, changes, adapter_configured: Boolean(schema.adapter_config_json), adapter_config: schema.adapter_config_json ? JSON.parse(schema.adapter_config_json) : null };
}

async function listFields(db, params) {
  const q = (params.get('q') || '').trim();
  const regulator = params.get('regulator') || '';
  const obligationId = params.get('obligation_id') || '';
  return await db.prepare(`SELECT f.*, sv.version AS schema_version, sv.schema_type, d.code AS document_code, d.name AS document_name, o.id AS obligation_id, o.title AS obligation_title, o.code AS obligation_code, r.acronym AS regulator_acronym,
    (SELECT COUNT(*) FROM data_mappings m WHERE m.regulatory_field_id = f.id AND m.mapping_status IN ('MAPPED','VALIDATED')) AS mapped_count,
    (SELECT COUNT(*) FROM dq_rules q WHERE q.regulatory_field_id = f.id) AS dq_rule_count
    FROM regulatory_fields f JOIN schema_versions sv ON sv.id = f.schema_version_id JOIN regulatory_documents d ON d.id = sv.document_id JOIN regulatory_obligations o ON o.id = d.obligation_id JOIN regulators r ON r.id = o.regulator_id
    WHERE (? = '' OR r.id = ? OR r.acronym = ?) AND (? = '' OR o.id = ?) AND (? = '' OR lower(f.name || ' ' || f.path || ' ' || f.description || ' ' || o.title) LIKE '%' || lower(?) || '%')
    ORDER BY r.acronym, d.code, f.path`).all(regulator, regulator, regulator, obligationId, obligationId, q, q);
}

async function listChanges(db, params) {
  const q = (params.get('q') || '').trim().toLowerCase();
  const level = params.get('severity') || '';
  const changeLevel = params.get('change_level') || '';
  const rows = await db.prepare(`SELECT * FROM regulatory_changes WHERE (? = '' OR severity = ?) AND (? = '' OR change_level = ?) ORDER BY detected_at DESC, id`).all(level, level, changeLevel, changeLevel);
  const enriched = [];
  for (const change of rows) enriched.push(await enrichChange(db, change));
  return enriched.filter((change) => {
    if (params.get('obligation_id') && change.obligation?.id !== params.get('obligation_id')) return false;
    if (!q) return true;
    return `${change.summary} ${change.field || ''} ${change.regulator?.acronym || ''} ${change.obligation?.title || ''} ${change.change_type}`.toLowerCase().includes(q);
  });
}

async function changeDetail(db, id) {
  const change = await db.prepare('SELECT * FROM regulatory_changes WHERE id = ?').get(id);
  if (!change) throw new ApiError('Change not found.', 404, 'CHANGE_NOT_FOUND');
  const enriched = await enrichChange(db, change);
  const snapshots = {};
  for (const key of ['previous_snapshot_id', 'current_snapshot_id']) {
    if (change[key]) {
      snapshots[key] = await db.prepare(`SELECT id, source_id, content_hash, mime_type, collected_at, http_status, content_size, storage_provider, raw_storage_path, parse_status, diff_type, diff_summary FROM regulatory_source_snapshots WHERE id = ?`).get(change[key]) || null;
    }
  }
  return { ...enriched, snapshots, review_history: snapshots ? null : null };
}

async function enrichChange(db, change) {
  let obligation = null;
  let regulator = null;
  if (change.entity_type === 'SCHEMA_VERSION') {
    const schema = await db.prepare('SELECT document_id FROM schema_versions WHERE id = ?').get(change.entity_id);
    if (schema) {
      const doc = await db.prepare('SELECT obligation_id FROM regulatory_documents WHERE id = ?').get(schema.document_id);
      if (doc) obligation = await db.prepare('SELECT * FROM regulatory_obligations WHERE id = ?').get(doc.obligation_id);
    }
    if (!obligation && change.entity_id === 'reg-susep-openinsurance') regulator = await db.prepare('SELECT * FROM regulators WHERE id = ?').get('susep');
  } else if (change.entity_type === 'REGULATORY_DOCUMENT') {
    const doc = await db.prepare('SELECT obligation_id FROM regulatory_documents WHERE id = ?').get(change.entity_id);
    if (doc) obligation = await db.prepare('SELECT * FROM regulatory_obligations WHERE id = ?').get(doc.obligation_id);
  } else if (change.entity_type === 'OBLIGATION') {
    obligation = await db.prepare('SELECT * FROM regulatory_obligations WHERE id = ?').get(change.entity_id);
  } else if (change.entity_type === 'REGULATION') {
    const regulation = await db.prepare('SELECT * FROM regulations WHERE id = ?').get(change.entity_id);
    if (regulation) regulator = await db.prepare('SELECT * FROM regulators WHERE id = ?').get(regulation.regulator_id);
  } else if (change.entity_type === 'SOURCE') {
    const source = await db.prepare('SELECT * FROM regulatory_sources WHERE id = ?').get(change.entity_id);
    if (source) {
      regulator = await db.prepare('SELECT * FROM regulators WHERE id = ?').get(source.regulator_id);
      if (!regulator) regulator = { id: source.regulator_id, acronym: source.authority || source.regulator_id, name: source.source_authority };
    }
  } else if (change.entity_type === 'MANUAL' && change.entity_id) {
    obligation = await db.prepare('SELECT * FROM regulatory_obligations WHERE id = ?').get(change.entity_id) || null;
  }
  if (obligation) regulator = await db.prepare('SELECT * FROM regulators WHERE id = ?').get(obligation.regulator_id);
  const impacts = await db.prepare('SELECT * FROM technical_impacts WHERE regulatory_change_id = ? ORDER BY score DESC, impact_type').all(change.id);
  const source = change.source_url ? await db.prepare('SELECT id,source_title,source_type,content_hash,content_hash_scope,status FROM regulatory_sources WHERE source_url = ? LIMIT 1').get(change.source_url) : null;
  return { ...change, obligation, regulator, impacts, source };
}

async function registerChange(db, body) {
  const changeType = String(body.change_type || '').toUpperCase();
  if (!CHANGE_TYPES.has(changeType)) throw new ApiError('Unsupported change_type.', 400, 'INVALID_CHANGE_TYPE');
  if (!body.source_url || !isOfficialSourceUrl(body.source_url)) throw new ApiError('Provide an HTTPS URL on an allowlisted official domain.', 400, 'OFFICIAL_SOURCE_REQUIRED');
  if (!body.source_reference || !body.summary) throw new ApiError('source_reference and summary are required; keep the trace to the exact text or section.', 400, 'SOURCE_TRACE_REQUIRED');
  const entityId = body.obligation_id || body.regulation_id || 'unlinked-review';
  if (body.obligation_id && !(await db.prepare('SELECT id FROM regulatory_obligations WHERE id = ?').get(body.obligation_id))) throw new ApiError('obligation_id not found.', 404, 'OBLIGATION_NOT_FOUND');
  const id = randomUUID();
  const detectedAt = new Date().toISOString();
  const impact = calculateImpacts(changeType, { field: body.field || null, note: 'User-submitted change; legal confirmation remains pending.' });
  const changeLevel = body.change_level === 'REGULATORY_CHANGE_CONFIRMED' && body.review_status === 'CONFIRMED' ? 'REGULATORY_CHANGE_CONFIRMED' : 'REGULATORY_CHANGE_CANDIDATE';
  await db.prepare(`INSERT INTO regulatory_changes
    (id, entity_type, entity_id, old_version, new_version, change_type, field, old_value, new_value, detected_at, effective_at, severity, source_reference, source_url, summary, confidence, review_status, is_demo, change_level)
    VALUES (?, 'MANUAL', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'USER_SUBMITTED_UNVERIFIED', ?, ?, 'REGULATORY_CHANGE_CANDIDATE')`)
    .run(id, entityId, body.old_version || null, body.new_version || null, changeType, body.field || null, body.old_value ?? null, body.new_value ?? null, detectedAt, body.effective_at || null, impact.level, body.source_reference, body.source_url, body.summary, 'REVIEW_REQUIRED', body.is_demo ? 1 : 0);
  const insert = db.prepare(`INSERT INTO technical_impacts
    (id, regulatory_change_id, impact_type, severity, score, description, recommended_action, rationale)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const row of impact.impacts) await insert.run(randomUUID(), id, row.impactType, row.severity, row.score, row.description, row.recommendedAction, row.rationale);
  await writeAudit(db, 'REGULATORY_CHANGE', id, 'CREATED', null, { changeType, summary: body.summary, confidence: 'USER_SUBMITTED_UNVERIFIED', changeLevel }, body.actor || 'user');
  return enrichChange(db, await db.prepare('SELECT * FROM regulatory_changes WHERE id = ?').get(id));
}

async function listImpacts(db, params) {
  const changeId = params.get('change_id') || '';
  return await db.prepare(`SELECT ti.*, c.change_type, c.field, c.summary, c.source_url, c.source_reference, c.severity AS change_severity
    FROM technical_impacts ti JOIN regulatory_changes c ON c.id = ti.regulatory_change_id
    WHERE (? = '' OR c.id = ?) ORDER BY c.detected_at DESC, ti.score DESC`).all(changeId, changeId);
}

async function listNormDiff(db, params) {
  const regulations = await listRegulations(db);
  const changes = await listChanges(db, new URLSearchParams());
  const filtered = changes.filter((change) => ['REGULATION', 'MANUAL'].includes(change.entity_type) || /deadline|business_rule|population|format|documentation/i.test(change.change_type));
  return { regulations, changes: filtered, method: 'Registered source-backed version events plus lexical compare-on-demand; legal interpretation is not automated.' };
}

function compareNormDiff(body) {
  if (typeof body.old_text !== 'string' || typeof body.new_text !== 'string') throw new ApiError('old_text and new_text are required.', 400, 'TEXT_REQUIRED');
  if (body.old_text.length > 50_000 || body.new_text.length > 50_000) throw new ApiError('Each text must be 50 KB or less.', 413, 'TEXT_TOO_LARGE');
  return compareNormativeText(body.old_text, body.new_text);
}

async function listMappings(db, params) {
  const q = (params.get('q') || '').trim();
  const status = params.get('status') || '';
  const obligationId = params.get('obligation_id') || '';
  const rows = await db.prepare(`SELECT m.*, rf.name AS regulatory_field_name, rf.path AS regulatory_field_path, rf.description AS field_definition, rf.data_type AS regulatory_type,
      sv.version AS schema_version, doc.code AS document_code, doc.name AS document_name, o.id AS obligation_id, o.code AS obligation_code, o.title AS obligation_title,
      reg.acronym AS regulator_acronym, df.name AS source_field, df.data_type AS source_data_type, ds.name AS dataset_name, sys.name AS system_name,
      cm.qualified_name AS canonical_name,
      (SELECT p.name FROM pipeline_dependencies pd JOIN pipelines p ON p.id = pd.pipeline_id WHERE pd.mapping_id = m.id ORDER BY p.name LIMIT 1) AS pipeline_name,
      (SELECT COUNT(*) FROM pipeline_dependencies pd WHERE pd.mapping_id = m.id) AS pipeline_dependency_count,
      (SELECT COUNT(*) FROM dq_rules dq WHERE dq.mapping_id = m.id) AS dq_rule_count
    FROM data_mappings m JOIN regulatory_fields rf ON rf.id = m.regulatory_field_id JOIN schema_versions sv ON sv.id = rf.schema_version_id JOIN regulatory_documents doc ON doc.id = sv.document_id JOIN regulatory_obligations o ON o.id = doc.obligation_id JOIN regulators reg ON reg.id = o.regulator_id
    LEFT JOIN data_fields df ON df.id = m.data_field_id LEFT JOIN datasets ds ON ds.id = df.dataset_id LEFT JOIN internal_systems sys ON sys.id = ds.system_id LEFT JOIN canonical_data_elements cm ON cm.id = m.canonical_element_id
    WHERE (? = '' OR m.mapping_status = ?) AND (? = '' OR o.id = ?) AND (? = '' OR lower(rf.name || ' ' || rf.path || ' ' || o.title || ' ' || coalesce(df.name,'') || ' ' || coalesce(ds.name,'') || ' ' || coalesce(sys.name,'')) LIKE '%' || lower(?) || '%')
    ORDER BY CASE m.mapping_status WHEN 'REVIEW_REQUIRED' THEN 0 WHEN 'UNMAPPED' THEN 1 WHEN 'MAPPED' THEN 2 ELSE 3 END, reg.acronym, o.code, rf.path`).all(status, status, obligationId, obligationId, q, q);
  if (!params.has('status') && !params.has('q') && !params.has('obligation_id')) {
    const mappedFieldIds = new Set(rows.map((row) => row.regulatory_field_id));
    const unmapped = await db.prepare(`SELECT f.id AS regulatory_field_id, f.name AS regulatory_field_name, f.path AS regulatory_field_path, f.description AS field_definition, f.data_type AS regulatory_type,
      sv.version AS schema_version, doc.code AS document_code, doc.name AS document_name, o.id AS obligation_id, o.code AS obligation_code, o.title AS obligation_title, reg.acronym AS regulator_acronym,
      'UNMAPPED' AS mapping_status, 0 AS version, 0 AS is_demo, NULL AS source_field, NULL AS source_data_type, NULL AS dataset_name, NULL AS system_name, NULL AS canonical_name, NULL AS pipeline_name, 0 AS dq_rule_count, 0 AS pipeline_dependency_count
      FROM regulatory_fields f JOIN schema_versions sv ON sv.id=f.schema_version_id JOIN regulatory_documents doc ON doc.id=sv.document_id JOIN regulatory_obligations o ON o.id=doc.obligation_id JOIN regulators reg ON reg.id=o.regulator_id
      WHERE f.status <> 'DEPRECATED' ORDER BY reg.acronym,doc.code,f.path`).all();
    for (const row of unmapped) if (!mappedFieldIds.has(row.regulatory_field_id)) rows.push(row);
  }
  return rows;
}

async function createMapping(db, body) {
  const fieldId = body.regulatory_field_id;
  if (!fieldId || !(await db.prepare('SELECT id FROM regulatory_fields WHERE id = ?').get(fieldId))) throw new ApiError('Valid regulatory_field_id is required.', 400, 'REGULATORY_FIELD_REQUIRED');
  const status = String(body.mapping_status || (body.data_field_id ? 'MAPPED' : 'UNMAPPED')).toUpperCase();
  if (!MAPPING_STATUSES.has(status)) throw new ApiError('Unsupported mapping_status.', 400, 'INVALID_MAPPING_STATUS');
  if (['MAPPED','VALIDATED'].includes(status) && !body.data_field_id) throw new ApiError('MAPPED and VALIDATED statuses require data_field_id.', 400, 'DATA_FIELD_REQUIRED');
  if (body.data_field_id && !(await db.prepare('SELECT id FROM data_fields WHERE id = ?').get(body.data_field_id))) throw new ApiError('data_field_id not found.', 404, 'DATA_FIELD_NOT_FOUND');
  if (body.canonical_element_id && !(await db.prepare('SELECT id FROM canonical_data_elements WHERE id = ?').get(body.canonical_element_id))) throw new ApiError('canonical_element_id not found.', 404, 'CANONICAL_ELEMENT_NOT_FOUND');
  let existing = null;
  if (body.data_field_id) existing = await db.prepare('SELECT * FROM data_mappings WHERE regulatory_field_id = ? AND data_field_id = ?').get(fieldId, body.data_field_id);
  if (existing) return updateMapping(db, existing.id, { ...body, mapping_status: status });
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO data_mappings (id, regulatory_field_id, data_field_id, canonical_element_id, transformation, sql_expression, python_expression, business_rule, mapping_status, owner, approved_by, version, is_demo, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
    .run(id, fieldId, body.data_field_id || null, body.canonical_element_id || null, body.transformation || 'IDENTITY', body.sql_expression || null, body.python_expression || null, body.business_rule || null, status, body.owner || 'Unassigned', status === 'VALIDATED' ? (body.approved_by || 'Reviewer') : null, body.is_demo === false ? 0 : 1, now);
  await writeAudit(db, 'DATA_MAPPING', id, 'CREATED', null, { regulatory_field_id: fieldId, data_field_id: body.data_field_id || null, mapping_status: status }, body.actor || 'user');
  return (await listMappings(db, new URLSearchParams())).find((row) => row.id === id) || await db.prepare('SELECT * FROM data_mappings WHERE id = ?').get(id);
}

async function updateMapping(db, id, body) {
  const current = await db.prepare('SELECT * FROM data_mappings WHERE id = ?').get(id);
  if (!current) throw new ApiError('Mapping not found.', 404, 'MAPPING_NOT_FOUND');
  const status = String(body.mapping_status || current.mapping_status).toUpperCase();
  if (!MAPPING_STATUSES.has(status)) throw new ApiError('Unsupported mapping_status.', 400, 'INVALID_MAPPING_STATUS');
  const nextDataFieldId = body.data_field_id === undefined ? current.data_field_id : body.data_field_id;
  if (['MAPPED','VALIDATED'].includes(status) && !nextDataFieldId) throw new ApiError('MAPPED and VALIDATED statuses require data_field_id.', 400, 'DATA_FIELD_REQUIRED');
  if (nextDataFieldId && !(await db.prepare('SELECT id FROM data_fields WHERE id = ?').get(nextDataFieldId))) throw new ApiError('data_field_id not found.', 404, 'DATA_FIELD_NOT_FOUND');
  const canonicalId = body.canonical_element_id === undefined ? current.canonical_element_id : body.canonical_element_id;
  if (canonicalId && !(await db.prepare('SELECT id FROM canonical_data_elements WHERE id = ?').get(canonicalId))) throw new ApiError('canonical_element_id not found.', 404, 'CANONICAL_ELEMENT_NOT_FOUND');
  if (nextDataFieldId) {
    const conflict = await db.prepare('SELECT id FROM data_mappings WHERE regulatory_field_id = ? AND data_field_id = ? AND id <> ?').get(current.regulatory_field_id, nextDataFieldId, id);
    if (conflict) throw new ApiError('That internal field is already mapped to this regulatory field.', 409, 'DUPLICATE_MAPPING');
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
    approved_by: status === 'VALIDATED' ? (body.approved_by || current.approved_by || 'Reviewer') : null,
  };
  const now = new Date().toISOString();
  await db.prepare(`UPDATE data_mappings SET data_field_id=?,canonical_element_id=?,transformation=?,sql_expression=?,python_expression=?,business_rule=?,mapping_status=?,owner=?,approved_by=?,version=version+1,updated_at=? WHERE id=?`)
    .run(next.data_field_id, next.canonical_element_id, next.transformation, next.sql_expression, next.python_expression, next.business_rule, next.mapping_status, next.owner, next.approved_by, now, id);
  await writeAudit(db, 'DATA_MAPPING', id, 'UPDATED', current, next, body.actor || 'user');
  return (await listMappings(db, new URLSearchParams())).find((row) => row.id === id) || await db.prepare('SELECT * FROM data_mappings WHERE id = ?').get(id);
}

async function listInternalData(db) {
  const systems = (await db.prepare('SELECT * FROM internal_systems ORDER BY name').all()).map((row) => ({ ...row, is_demo: Boolean(row.is_demo) }));
  const datasets = (await db.prepare(`SELECT d.*, s.name AS system_name, s.type AS system_type FROM datasets d JOIN internal_systems s ON s.id=d.system_id ORDER BY s.name,d.name`).all()).map((row) => ({ ...row, is_demo: Boolean(row.is_demo) }));
  const fields = (await db.prepare(`SELECT f.*, d.name AS dataset_name, s.name AS system_name, c.qualified_name AS canonical_name
    FROM data_fields f JOIN datasets d ON d.id=f.dataset_id JOIN internal_systems s ON s.id=d.system_id LEFT JOIN canonical_data_elements c ON c.id=f.canonical_element_id
    ORDER BY s.name,d.name,f.name`).all()).map((row) => ({ ...row, is_demo: Boolean(row.is_demo) }));
  const canonical_elements = (await db.prepare('SELECT * FROM canonical_data_elements ORDER BY domain,qualified_name').all()).map((row) => ({ ...row, is_demo: Boolean(row.is_demo) }));
  return { systems, datasets, fields, canonical_elements, all_internal_records_are_demo: [...systems, ...datasets, ...fields].every((row) => row.is_demo) };
}

async function listCatalog(db, params) {
  const q = (params.get('q') || '').trim();
  const rows = await db.prepare(`SELECT c.*, (SELECT COUNT(DISTINCT m.regulatory_field_id) FROM data_mappings m WHERE m.canonical_element_id=c.id) AS regulatory_field_count,
      (SELECT COUNT(DISTINCT o.id) FROM data_mappings m JOIN regulatory_fields f ON f.id=m.regulatory_field_id JOIN schema_versions sv ON sv.id=f.schema_version_id JOIN regulatory_documents d ON d.id=sv.document_id JOIN regulatory_obligations o ON o.id=d.obligation_id WHERE m.canonical_element_id=c.id) AS obligation_count,
      (SELECT COUNT(*) FROM canonical_mappings cm WHERE cm.canonical_element_id=c.id AND cm.mapping_status IN ('MAPPED','VALIDATED')) AS internal_source_count
    FROM canonical_data_elements c WHERE (? = '' OR lower(c.qualified_name || ' ' || c.description || ' ' || c.domain) LIKE '%' || lower(?) || '%') ORDER BY c.domain,c.qualified_name`).all(q, q);
  const regulatorRows = await db.prepare(`SELECT DISTINCT m.canonical_element_id AS cid, r.acronym FROM data_mappings m
    JOIN regulatory_fields f ON f.id=m.regulatory_field_id JOIN schema_versions sv ON sv.id=f.schema_version_id
    JOIN regulatory_documents d ON d.id=sv.document_id JOIN regulatory_obligations o ON o.id=d.obligation_id
    JOIN regulators r ON r.id=o.regulator_id WHERE m.canonical_element_id IS NOT NULL`).all();
  const byId = new Map();
  for (const row of regulatorRows) {
    if (!byId.has(row.cid)) byId.set(row.cid, new Set());
    byId.get(row.cid).add(row.acronym);
  }
  return rows.map((row) => ({ ...row, regulators: [...(byId.get(row.id) || [])].join(',') || null }));
}

async function getLineage(db, params) {
  const dataFieldId = params.get('data_field_id') || '';
  const obligationId = params.get('obligation_id') || '';
  const q = (params.get('q') || '').trim();
  let mappings = await listMappings(db, new URLSearchParams());
  mappings = mappings.filter((mapping) => mapping.data_field_id && (!dataFieldId || mapping.data_field_id === dataFieldId) && (!obligationId || mapping.obligation_id === obligationId));
  if (q) mappings = mappings.filter((mapping) => `${mapping.source_field} ${mapping.dataset_name} ${mapping.system_name} ${mapping.regulatory_field_name} ${mapping.obligation_title}`.toLowerCase().includes(q.toLowerCase()));
  const nodes = new Map(); const edges = [];
  const add = (id, type, label, detail) => { if (!nodes.has(id)) nodes.set(id, { id, type, label, detail }); };
  for (const mapping of mappings) {
    const sysId = `system:${mapping.system_name}`; const dsId = `dataset:${mapping.dataset_name}`; const fieldId = `datafield:${mapping.data_field_id}`;
    const canonId = mapping.canonical_element_id ? `canonical:${mapping.canonical_element_id}` : null;
    const pipelineId = mapping.pipeline_name ? `pipeline:${mapping.pipeline_name}` : null;
    const regFieldId = `regfield:${mapping.regulatory_field_id}`; const docId = `document:${mapping.document_code}:${mapping.obligation_id}`; const obligationNode = `obligation:${mapping.obligation_id}`; const regulatorNode = `regulator:${mapping.regulator_acronym}`;
    add(sysId, 'SYSTEM', mapping.system_name, mapping.is_demo ? 'DEMO SYSTEM' : 'INTERNAL SYSTEM'); add(dsId, 'DATASET', mapping.dataset_name, mapping.is_demo ? 'DEMO DATASET' : 'INTERNAL DATASET'); add(fieldId, 'DATA_FIELD', mapping.source_field, mapping.source_data_type);
    add(regFieldId, 'REGULATORY_FIELD', mapping.regulatory_field_name, mapping.regulatory_field_path); add(docId, 'DOCUMENT', mapping.document_code, mapping.document_name); add(obligationNode, 'OBLIGATION', mapping.obligation_title, mapping.obligation_code); add(regulatorNode, 'REGULATOR', mapping.regulator_acronym, 'Official regulator');
    if (canonId) add(canonId, 'CANONICAL', mapping.canonical_name, 'Canonical data element');
    if (pipelineId) add(pipelineId, 'PIPELINE', mapping.pipeline_name, 'Configured pipeline');
    edges.push({ from: sysId, to: dsId, label: 'contains' }, { from: dsId, to: fieldId, label: 'field' });
    if (canonId) edges.push({ from: fieldId, to: canonId, label: 'canonical mapping' });
    if (pipelineId) edges.push({ from: fieldId, to: pipelineId, label: 'consumed by' });
    edges.push({ from: fieldId, to: regFieldId, label: mapping.transformation }, { from: regFieldId, to: docId, label: 'serialized in' }, { from: docId, to: obligationNode, label: 'fulfills' }, { from: obligationNode, to: regulatorNode, label: 'reported to' });
  }
  return { nodes: [...nodes.values()], edges, mappings_count: mappings.length, is_demo: mappings.some((m) => m.is_demo), note: 'Lineage edge set is built from persisted mapping/dependency records.' };
}

async function listDq(db) {
  const rules = await db.prepare(`SELECT q.*, f.name AS field_name, f.path AS field_path, o.title AS obligation_title, o.code AS obligation_code, r.acronym AS regulator_acronym, m.mapping_status
    FROM dq_rules q JOIN regulatory_fields f ON f.id=q.regulatory_field_id JOIN schema_versions sv ON sv.id=f.schema_version_id JOIN regulatory_documents d ON d.id=sv.document_id JOIN regulatory_obligations o ON o.id=d.obligation_id JOIN regulators r ON r.id=o.regulator_id LEFT JOIN data_mappings m ON m.id=q.mapping_id ORDER BY r.acronym,o.code,f.path`).all();
  const latest = await db.prepare(`SELECT run.*, (SELECT COUNT(*) FROM dq_run_results rr WHERE rr.dq_run_id=run.id AND rr.status='FAIL') AS fail_count FROM dq_runs run ORDER BY started_at DESC LIMIT 1`).get() || null;
  const recentRuns = await db.prepare('SELECT * FROM dq_runs ORDER BY started_at DESC LIMIT 10').all();
  const results = latest ? await db.prepare(`SELECT rr.*, q.name AS rule_name, q.rule_type, q.severity, q.description, f.name AS field_name, f.path AS field_path
    FROM dq_run_results rr JOIN dq_rules q ON q.id=rr.dq_rule_id JOIN regulatory_fields f ON f.id=q.regulatory_field_id WHERE rr.dq_run_id=? ORDER BY rr.status DESC, q.name`).all(latest.id) : [];
  return { rules, latest, recent_runs: recentRuns, latest_results: results, demo_data_only: true };
}

async function runDq(db) {
  const run = await runDqAgainstSeededData(db);
  const job = await startJobRun(db, 'run_quality');
  await finishJobRun(db, job.id, { status: run.failed ? 'COMPLETED_WITH_FAILURES' : 'SUCCEEDED', processed: run.rules_evaluated, result: run });
  return { ...run, note: 'Executed only against synthetic DEMO DATA fixtures (development environment). Negative-control row is intentionally invalid.' };
}

async function listDeadlines(db, params) {
  const type = params.get('deadline_type') || '';
  const obligationId = params.get('obligation_id') || '';
  const rows = await db.prepare(`SELECT d.*, o.code AS obligation_code, o.title AS obligation_title, r.acronym AS regulator_acronym, r.name AS regulator_name, o.owner AS obligation_owner
    FROM regulatory_deadlines d JOIN regulatory_obligations o ON o.id=d.obligation_id JOIN regulators r ON r.id=o.regulator_id
    WHERE (? = '' OR d.deadline_type = ?) AND (? = '' OR o.id = ?) ORDER BY d.due_date, r.acronym, o.code`).all(type, type, obligationId, obligationId);
  return rows.map((row) => {
    const dueDate = String(row.due_date || '').slice(0, 10);
    return { ...row, due_date: dueDate, ...calendarStatus(dueDate), owner: row.owner || row.obligation_owner, is_demo: Boolean(row.is_demo) };
  });
}

async function createInternalDeadline(db, body) {
  const obligationId = String(body.obligation_id || '');
  const obligation = await db.prepare('SELECT id FROM regulatory_obligations WHERE id=?').get(obligationId);
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
  await db.prepare(`INSERT INTO regulatory_deadlines
    (id,obligation_id,reference_period,due_date,deadline_type,source_url,status,owner,calculation_basis,is_demo)
    VALUES (?,?,?,?,'INTERNAL',NULL,?,?,?,1)`)
    .run(id, obligationId, referencePeriod, dueDate, status, owner, basis);
  await writeAudit(db, 'REGULATORY_DEADLINE', id, 'INTERNAL_TARGET_CREATED', null, { obligation_id: obligationId, reference_period: referencePeriod, due_date: dueDate, owner, deadline_type: 'INTERNAL', is_demo: true }, body.actor || 'user');
  return { ...(await db.prepare('SELECT * FROM regulatory_deadlines WHERE id=?').get(id)), ...calendarStatus(dueDate), is_demo: true,
    notice: 'INTERNAL planning target only. This record is not an official regulatory deadline.' };
}

function isValidIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

async function listSubmissions(db) {
  const rows = await db.prepare(`SELECT s.*, o.code AS obligation_code, o.title AS obligation_title, r.acronym AS regulator_acronym,
    (SELECT COUNT(*) FROM validation_results v WHERE v.submission_id=s.id) AS validation_count
    FROM submissions s JOIN regulatory_obligations o ON o.id=s.obligation_id JOIN regulators r ON r.id=o.regulator_id ORDER BY s.generated_at DESC`).all();
  return rows.map((row) => ({ ...row, is_demo: Boolean(row.is_demo), validation_summary: row.validation_summary ? JSON.parse(row.validation_summary) : null }));
}

async function listSources(db, params) {
  const regulator = params.get('regulator') || '';
  const authority = params.get('authority') || '';
  const rows = await db.prepare(`SELECT s.*, r.acronym AS regulator_acronym, r.name AS regulator_name,
    (SELECT COUNT(*) FROM regulatory_source_snapshots ss WHERE ss.source_id=s.id) AS raw_snapshot_count,
    (SELECT MAX(collected_at) FROM regulatory_source_snapshots ss WHERE ss.source_id=s.id) AS last_raw_snapshot_at,
    (SELECT COUNT(*) FROM regulatory_extraction_candidates ec WHERE ec.source_id=s.id) AS extraction_candidates,
    (SELECT COUNT(*) FROM regulatory_changes c WHERE c.entity_type='SOURCE' AND c.entity_id=s.id) AS change_count,
    (SELECT COUNT(*) FROM source_verification_checks vc WHERE vc.source_id=s.id AND vc.checked_at >= ?) AS checks_24h
    FROM regulatory_sources s JOIN regulators r ON r.id=s.regulator_id
    WHERE (? = '' OR r.id = ? OR r.acronym = ?) AND (? = '' OR s.authority = ?)
    ORDER BY r.acronym, s.source_title`).all(
    new Date(Date.now() - 86400_000).toISOString(),
    regulator, regulator, regulator, authority, authority);
  return rows.map((row) => ({
    ...row,
    content_hash_scope_note: row.content_hash_scope === 'CURATED_EXCERPT_SHA256' ? 'Hash of stored curated text excerpt; not a hash of the remote file.' : row.content_hash_scope === 'RAW_RESPONSE_SHA256' ? 'SHA-256 of the captured raw HTTP response.' : 'No content hash captured yet.',
    verification_status: row.content_hash_scope === 'RAW_RESPONSE_SHA256' ? 'SOURCE_VERIFIED' : row.status === 'EXCERPT_VERIFIED' ? 'EXCERPT_VERIFIED' : 'UNVERIFIED',
    health: row.consecutive_failures > 0 ? 'INGESTION_ERROR' : row.current_snapshot_id ? 'LIVE' : 'MONITORED',
  }));
}

async function sourceDetail(db, id, context = {}) {
  const source = await db.prepare(`SELECT s.*, r.acronym AS regulator_acronym, r.name AS regulator_name
    FROM regulatory_sources s JOIN regulators r ON r.id = s.regulator_id WHERE s.id = ?`).get(id);
  if (!source) throw new ApiError('Source not found.', 404, 'SOURCE_NOT_FOUND');
  const snapshots = await db.prepare(`SELECT id, source_id, response_url, content_hash, mime_type, collected_at, status, authority, source_type, http_status,
      etag, last_modified, content_length, content_size, storage_provider, raw_storage_path, parser, parse_status, parse_error, diff_type, diff_summary, previous_snapshot_id
    FROM regulatory_source_snapshots WHERE source_id = ? ORDER BY collected_at DESC LIMIT 50`).all(id);
  const checks = await db.prepare('SELECT * FROM source_verification_checks WHERE source_id = ? ORDER BY checked_at DESC LIMIT 50').all(id);
  const changes = [];
  for (const row of await db.prepare(`SELECT * FROM regulatory_changes WHERE entity_type = 'SOURCE' AND entity_id = ? ORDER BY detected_at DESC LIMIT 50`).all(id)) changes.push(await enrichChange(db, row));
  const adapter = ADAPTERS.find((row) => row.name === source.adapter) || null;
  const current = source.current_snapshot_id ? snapshots.find((row) => row.id === source.current_snapshot_id) || null : null;
  const storage = context.getStorage ? await context.getStorage() : null;
  return {
    source,
    adapter: adapter ? { authority: adapter.authority, name: adapter.name, discoveryStrategy: adapter.discoveryStrategy, notes: adapter.notes } : null,
    current_snapshot: current,
    snapshots, checks, changes,
    storage_provider: storage?.provider || null,
    hash_notice: source.content_hash_scope === 'RAW_RESPONSE_SHA256' ? 'SHA-256 of immutable raw response bytes captured by the platform.' : source.content_hash_scope === 'CURATED_EXCERPT_SHA256' ? 'SHA-256 of a curated text excerpt only — not the original file.' : 'No hash captured.',
  };
}

async function listSourceSnapshots(db, sourceId, params) {
  const limit = Math.min(200, Math.max(1, Number(params.get('limit') || 50)));
  const rows = await db.prepare(`SELECT id, source_id, response_url, content_hash, mime_type, collected_at, status, authority, source_type, http_status,
      etag, last_modified, content_length, content_size, storage_provider, raw_storage_path, parser, parse_status, parse_error, diff_type, diff_summary, previous_snapshot_id
    FROM regulatory_source_snapshots WHERE source_id = ? ORDER BY collected_at DESC, id DESC LIMIT ?`).all(sourceId, limit);
  return rows;
}

async function listSourceChecks(db, sourceId) {
  return await db.prepare('SELECT * FROM source_verification_checks WHERE source_id = ? ORDER BY checked_at DESC LIMIT 100').all(sourceId);
}

async function serveSnapshotContent(res, db, sourceId, snapshotId) {
  const snapshot = await db.prepare(`SELECT id, source_id, content_hash, mime_type, storage_provider, raw_storage_path, content FROM regulatory_source_snapshots WHERE id = ? AND source_id = ?`).get(snapshotId, sourceId);
  if (!snapshot) return sendJson(res, 404, { error: 'SNAPSHOT_NOT_FOUND', message: 'No snapshot with that id for this source.' });
  let body = snapshot.content ? Buffer.from(snapshot.content) : null;
  if (!body) {
    const storage = await createStorage({ db });
    if (storage.provider === 'unavailable') return sendJson(res, 503, { error: 'STORAGE_UNAVAILABLE', message: storage.error });
    body = await storage.read(snapshot.raw_storage_path);
    if (body) body = Buffer.from(body);
  }
  if (!body) return sendJson(res, 410, { error: 'RAW_BYTES_UNAVAILABLE', message: 'The durable storage provider cannot return these bytes; the snapshot metadata and hash remain authoritative.' });
  res.writeHead(200, {
    'Content-Type': `${snapshot.mime_type || 'application/octet-stream'}; charset=utf-8`,
    'Content-Disposition': `attachment; filename="snapshot-${snapshot.id.slice(0, 8)}-${String(snapshot.content_hash).slice(0, 12)}"`,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'X-Content-Sha256': String(snapshot.content_hash),
  });
  res.end(body);
}

async function listEvidence(db, params) {
  const obligationId = params.get('obligation_id') || '';
  const rows = await db.prepare(`SELECT e.*, o.code AS obligation_code, o.title AS obligation_title, r.acronym AS regulator_acronym, c.control_name
    FROM evidence_items e LEFT JOIN regulatory_obligations o ON o.id=e.obligation_id LEFT JOIN regulators r ON r.id=o.regulator_id LEFT JOIN regulatory_controls c ON c.id=e.control_id
    WHERE (? = '' OR o.id = ?) ORDER BY e.collected_at DESC`).all(obligationId, obligationId);
  return rows.map((row) => ({ ...row, is_demo: Boolean(row.is_demo) }));
}

async function createEvidence(db, body) {
  if (!body.title || !body.evidence_type) throw new ApiError('title and evidence_type are required.', 400, 'EVIDENCE_FIELDS_REQUIRED');
  if (body.obligation_id && !(await db.prepare('SELECT id FROM regulatory_obligations WHERE id=?').get(body.obligation_id))) throw new ApiError('obligation_id not found.', 404, 'OBLIGATION_NOT_FOUND');
  if (body.control_id) {
    const control = await db.prepare('SELECT id,obligation_id FROM regulatory_controls WHERE id=?').get(body.control_id);
    if (!control) throw new ApiError('control_id not found.', 404, 'CONTROL_NOT_FOUND');
    if (body.obligation_id && control.obligation_id !== body.obligation_id) throw new ApiError('control_id must belong to the selected obligation.', 400, 'CONTROL_OBLIGATION_MISMATCH');
  }
  const id = randomUUID(); const now = new Date().toISOString();
  await db.prepare(`INSERT INTO evidence_items (id,obligation_id,control_id,evidence_type,title,artifact_path,collected_at,source_reference,content_hash,status,is_demo)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, body.obligation_id || null, body.control_id || null, body.evidence_type, body.title, body.artifact_path || null, now, body.source_reference || null, body.content_hash || null, 'AVAILABLE', body.is_demo === false ? 0 : 1);
  await writeAudit(db, 'EVIDENCE', id, 'CREATED', null, body, body.actor || 'user');
  return await db.prepare('SELECT * FROM evidence_items WHERE id=?').get(id);
}

async function createControl(db, body) {
  const controlName = String(body.control_name || '').trim();
  const obligationId = String(body.obligation_id || '');
  const owner = String(body.owner || '').trim();
  const frequency = String(body.frequency || '').trim();
  const evidenceType = String(body.evidence_type || '').trim();
  if (!controlName || controlName.length > 200 || !owner || owner.length > 120 || !frequency || frequency.length > 64 || !evidenceType || evidenceType.length > 120) {
    throw new ApiError('control_name, owner, frequency and evidence_type are required within their length limits.', 400, 'CONTROL_FIELDS_REQUIRED');
  }
  const obligation = await db.prepare('SELECT id FROM regulatory_obligations WHERE id=?').get(obligationId);
  if (!obligation) throw new ApiError('A valid obligation_id is required.', 400, 'OBLIGATION_REQUIRED');
  const requirementId = body.requirement_id || null;
  if (requirementId) {
    const requirement = await db.prepare('SELECT id,obligation_id FROM requirements WHERE id=?').get(requirementId);
    if (!requirement) throw new ApiError('requirement_id not found.', 404, 'REQUIREMENT_NOT_FOUND');
    if (requirement.obligation_id !== obligationId) throw new ApiError('requirement_id must belong to the selected obligation.', 400, 'REQUIREMENT_OBLIGATION_MISMATCH');
  }
  const id = randomUUID();
  await db.prepare(`INSERT INTO regulatory_controls
    (id,control_name,obligation_id,requirement_id,owner,frequency,evidence_type,last_execution,result,status,is_demo)
    VALUES (?,?,?,?,?,?,?,NULL,'NOT_RUN','ACTIVE',?)`)
    .run(id, controlName, obligationId, requirementId, owner, frequency, evidenceType, body.is_demo === false ? 0 : 1);
  await writeAudit(db, 'CONTROL', id, 'CREATED', null, { control_name: controlName, obligation_id: obligationId, requirement_id: requirementId, owner, frequency, evidence_type: evidenceType }, body.actor || 'user');
  return await db.prepare('SELECT * FROM regulatory_controls WHERE id=?').get(id);
}

async function listControls(db) {
  const rows = await db.prepare(`SELECT c.*, o.code AS obligation_code, o.title AS obligation_title, r.acronym AS regulator_acronym, req.description AS requirement_description,
    (SELECT COUNT(*) FROM evidence_items e WHERE e.control_id=c.id) AS evidence_count
    FROM regulatory_controls c JOIN regulatory_obligations o ON o.id=c.obligation_id JOIN regulators r ON r.id=o.regulator_id LEFT JOIN requirements req ON req.id=c.requirement_id ORDER BY r.acronym,o.code`).all();
  return rows.map((row) => ({ ...row, is_demo: Boolean(row.is_demo) }));
}

async function listAudit(db, params) {
  const entityId = params.get('entity_id') || '';
  const rows = await db.prepare('SELECT * FROM audit_events WHERE (? = \'\' OR entity_id = ?) ORDER BY created_at DESC LIMIT 200').all(entityId, entityId);
  return rows.map((row) => ({ ...row, old_value: parseMaybeJson(row.old_value), new_value: parseMaybeJson(row.new_value) }));
}

async function buildMatrix(db) {
  const obligations = await listObligations(db, new URLSearchParams());
  const mappings = await listMappings(db, new URLSearchParams());
  const matrix = obligations.map((obligation) => {
    const related = mappings.filter((mapping) => mapping.obligation_id === obligation.id && mapping.data_field_id);
    const systems = [...new Set(related.map((mapping) => mapping.system_name).filter(Boolean))];
    const datasets = [...new Set(related.map((mapping) => mapping.dataset_name).filter(Boolean))];
    const pipelines = [...new Set(related.flatMap((mapping) => String(mapping.pipeline_name || '').split(', ').filter(Boolean)))];
    return { ...obligation, systems, datasets, pipelines, teams: [...new Set(related.map((mapping) => mapping.owner).filter(Boolean))], is_demo: related.some((mapping) => mapping.is_demo) };
  });
  return { obligations: matrix, assets: { systems: [...new Set(matrix.flatMap((row) => row.systems))], datasets: [...new Set(matrix.flatMap((row) => row.datasets))], pipelines: [...new Set(matrix.flatMap((row) => row.pipelines))] }, note: 'Cells are derived from stored mapping and pipeline-dependency rows.' };
}

async function engineeringData(db) {
  const changes = await db.prepare('SELECT change_type,COUNT(*) AS count FROM regulatory_changes GROUP BY change_type').all();
  const mapStatuses = await db.prepare('SELECT mapping_status,COUNT(*) AS count FROM data_mappings GROUP BY mapping_status').all();
  const schemaFields = (await db.prepare('SELECT COUNT(*) AS n FROM regulatory_fields').get()).n;
  const mapped = (await db.prepare("SELECT COUNT(DISTINCT regulatory_field_id) AS n FROM data_mappings WHERE mapping_status IN ('MAPPED','VALIDATED')").get()).n;
  const openMappings = (await db.prepare("SELECT COUNT(*) AS n FROM data_mappings WHERE mapping_status IN ('UNMAPPED','REVIEW_REQUIRED')").get()).n;
  const pipelines = (await db.prepare("SELECT COUNT(*) AS n FROM pipelines WHERE status <> 'INACTIVE'").get()).n;
  const dependencies = (await db.prepare('SELECT COUNT(*) AS n FROM pipeline_dependencies').get()).n;
  const dqRules = (await db.prepare('SELECT COUNT(*) AS n FROM dq_rules').get()).n;
  const lastDq = await db.prepare('SELECT * FROM dq_runs ORDER BY started_at DESC LIMIT 1').get() || null;
  const submissionsAtRisk = (await db.prepare("SELECT COUNT(*) AS n FROM regulatory_deadlines d LEFT JOIN submissions s ON s.obligation_id=d.obligation_id AND s.reference_period=d.reference_period WHERE d.deadline_type='OFFICIAL' AND d.due_date >= ? AND coalesce(s.status,'') NOT IN ('READY','SUBMITTED','ACCEPTED')").get(new Date().toISOString().slice(0, 10))).n;
  return { schemas_changed: changes.reduce((sum, row) => sum + row.count, 0), change_types: changes, field_count: schemaFields, mapped_fields: mapped, unmapped_or_review_mappings: openMappings, mapping_statuses: mapStatuses, pipelines, pipeline_dependencies: dependencies, dq_rules: dqRules, latest_dq_run: lastDq, submissions_at_risk: submissionsAtRisk, technical_debt: schemaFields - mapped, note: 'Engineering indicators are calculated from catalogued metadata and stored mappings.' };
}

async function regulatoryData(db) {
  return {
    regulations: (await db.prepare("SELECT COUNT(*) AS n FROM regulations WHERE status='ACTIVE'").get()).n,
    obligations: (await db.prepare("SELECT COUNT(*) AS n FROM regulatory_obligations WHERE status='ACTIVE'").get()).n,
    upcoming_effective_dates: (await db.prepare("SELECT COUNT(*) AS n FROM regulatory_obligations WHERE effective_date >= ?").get(new Date().toISOString().slice(0, 10))).n,
    upcoming_deadlines: (await db.prepare("SELECT COUNT(*) AS n FROM regulatory_deadlines WHERE deadline_type='OFFICIAL' AND due_date >= ?").get(new Date().toISOString().slice(0, 10))).n,
    source_excerpts: (await db.prepare("SELECT COUNT(*) AS n FROM regulatory_sources WHERE status='EXCERPT_VERIFIED'").get()).n,
    raw_verified_sources: (await db.prepare("SELECT COUNT(*) AS n FROM regulatory_sources WHERE content_hash_scope='RAW_RESPONSE_SHA256'").get()).n,
    change_review_queue: (await db.prepare("SELECT COUNT(*) AS n FROM regulatory_changes WHERE review_status='REVIEW_REQUIRED'").get()).n,
    regulators: await listRegulators(db),
    note: 'A source excerpt is not a byte-for-byte capture of the full source document; raw snapshot counts are exposed separately.',
  };
}

async function executeJob(db, name) {
  if (name === 'run_quality') return runDq(db);
  if (name === 'generate_submissions') return runDemoPipeline(db, {});
  return await runJob(db, name);
}

async function retryError(db, id) {
  const error = await db.prepare('SELECT * FROM ingestion_errors WHERE id=?').get(id);
  if (!error) throw new ApiError('Ingestion error not found.', 404, 'ERROR_NOT_FOUND');
  if (!error.source_id) throw new ApiError('This error has no source_id and cannot be retried automatically.', 409, 'ERROR_NOT_RETRYABLE');
  const result = await runCollectSources(db, { sourceIds: [error.source_id], dueOnly: false, limit: 1, trigger: 'retry' });
  await db.prepare('UPDATE ingestion_errors SET retry_count=retry_count+1, resolved=? WHERE id=?').run(result.failed === 0 ? 1 : 0, id);
  return { previous_error_id: id, retry_result: result };
}

async function listErrors(db) {
  const rows = await db.prepare(`SELECT e.*, s.source_title, j.job_name FROM ingestion_errors e LEFT JOIN regulatory_sources s ON s.id=e.source_id LEFT JOIN job_runs j ON j.id=e.job_run_id ORDER BY e.timestamp DESC`).all();
  return rows.map((row) => ({ ...row, resolved: Boolean(row.resolved) }));
}

async function listJobs(db) {
  const rawRuns = await db.prepare('SELECT * FROM job_runs ORDER BY started_at DESC LIMIT 100').all();
  const runs = rawRuns.map((row) => ({ ...row, result_json: parseMaybeJson(row.result_json), errors: parseMaybeJson(row.errors) }));
  const descriptions = {
    collect_sources: 'Conditional-GET fetch of official allowlisted sources; immutable raw snapshots + SHA-256; 304 responses recorded as checks only.',
    parse_sources: 'Runs registered parsers on captured snapshots; failures stay visible as UNSTRUCTURED/FAILED.',
    detect_versions: 'Reports sources with multiple immutable snapshots.',
    detect_changes: 'Reconciles snapshot history into SOURCE_CHANGED review records; never auto-confirms regulatory meaning.',
    extract_obligations: 'Creates low-confidence obligation candidates for human review.',
    extract_schemas: 'Creates schema-field candidates for human review from parsed structure.',
    calculate_impacts: 'Deterministic technical-impact rules for typed change records.',
    update_deadlines: 'Refreshes status of sourced deadlines; never infers new official dates.',
    run_quality: 'Executes DQ rules against synthetic fixtures (dev only).',
    generate_submissions: 'Runs the generic demonstration pipeline (dev only).',
  };
  const available = Object.entries(descriptions).map(([name, description]) => ({ name, description, last_run: runs.find((run) => run.job_name === name) || null }));
  return {
    runs, available,
    raw_snapshot_count: (await db.prepare('SELECT COUNT(*) AS n FROM regulatory_source_snapshots').get()).n,
    source_excerpt_count: (await db.prepare("SELECT COUNT(*) AS n FROM regulatory_sources WHERE status='EXCERPT_VERIFIED'").get()).n,
    last_successful_ingestion: runs.find((run) => run.job_name === 'collect_sources' && run.status !== 'FAILED') || null,
  };
}

async function globalSearch(db, query) {
  const q = String(query || '').trim();
  if (q.length < 2) return { query: q, results: [], note: 'Enter at least two characters.' };
  const like = `%${q}%`;
  const results = [];
  for (const row of await db.prepare(`SELECT o.id,o.code AS code,o.title AS title,o.description AS snippet,r.acronym AS regulator,'obligation' AS type FROM regulatory_obligations o JOIN regulators r ON r.id=o.regulator_id WHERE lower(o.title||' '||o.code||' '||o.description||' '||o.category) LIKE lower(?) LIMIT 30`).all(like)) results.push({ ...row, url: `/impact?id=${encodeURIComponent(row.id)}` });
  for (const row of await db.prepare(`SELECT n.id,n.number AS code,n.title AS title,n.description AS snippet,r.acronym AS regulator,'regulation' AS type FROM regulations n JOIN regulators r ON r.id=n.regulator_id WHERE lower(n.title||' '||n.number||' '||coalesce(n.description,'')) LIKE lower(?) LIMIT 20`).all(like)) results.push({ ...row, url: '/regulatory' });
  for (const row of await db.prepare(`SELECT f.id,f.name AS code,f.path AS title,f.description AS snippet,r.acronym AS regulator,'field' AS type FROM regulatory_fields f JOIN schema_versions sv ON sv.id=f.schema_version_id JOIN regulatory_documents d ON d.id=sv.document_id JOIN regulatory_obligations o ON o.id=d.obligation_id JOIN regulators r ON r.id=o.regulator_id WHERE lower(f.name||' '||f.path||' '||f.description) LIKE lower(?) LIMIT 30`).all(like)) results.push({ ...row, url: '/schemas' });
  for (const row of (await listChanges(db, new URLSearchParams())).filter((item) => `${item.summary} ${item.field || ''} ${item.change_type} ${item.regulator?.acronym || ''} ${item.obligation?.title || ''}`.toLowerCase().includes(q.toLowerCase())).slice(0, 20)) results.push({ id: row.id, code: row.change_type, title: row.summary, snippet: row.field || row.source_reference, regulator: row.regulator?.acronym || '', type: 'change', url: `/changes?focus=${encodeURIComponent(row.id)}` });
  for (const row of await db.prepare(`SELECT s.id,s.source_type AS code,s.source_title AS title,s.source_url AS snippet,r.acronym AS regulator,'source' AS type FROM regulatory_sources s JOIN regulators r ON r.id=s.regulator_id WHERE lower(s.source_title||' '||s.source_type||' '||s.source_url||' '||coalesce(s.excerpt,'')) LIKE lower(?) LIMIT 30`).all(like)) results.push({ ...row, url: `/sources?id=${encodeURIComponent(row.id)}`, external: true });
  return { query: q, results: results.slice(0, 80), total: results.length };
}

async function writeAudit(db, entityType, entityId, action, oldValue, newValue, actor = 'user') {
  await db.prepare('INSERT INTO audit_events (id,entity_type,entity_id,action,old_value,new_value,created_at,actor) VALUES (?,?,?,?,?,?,?,?)')
    .run(randomUUID(), entityType, entityId, action, oldValue === null ? null : JSON.stringify(oldValue), newValue === null ? null : JSON.stringify(newValue), new Date().toISOString(), actor);
}

function parseMaybeJson(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return value; }
}

async function serveArtifact(res, db, filename, context) {
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) return sendJson(res, 400, { error: 'INVALID_ARTIFACT_PATH', message: 'Artifact path must be a single filename.' });
  const storage = context.getStorage ? await context.getStorage() : await createStorage({ db });
  if (storage.provider === 'unavailable') return sendJson(res, 503, { error: 'STORAGE_UNAVAILABLE', message: storage.error });
  const artifact = await readArtifact(storage, filename).catch(() => null);
  if (!artifact) return sendJson(res, 404, { error: 'ARTIFACT_NOT_FOUND', message: 'Generated demo artifact not found in durable storage.' });
  const extension = extname(filename).toLowerCase();
  const types = { '.xml': 'application/xml', '.json': 'application/json', '.csv': 'text/csv', '.txt': 'text/plain' };
  res.writeHead(200, { 'Content-Type': `${types[extension] || 'application/octet-stream'}; charset=utf-8`, 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' });
  res.end(artifact.body);
}

function serveStatic(req, res, pathname) {
  if (pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
  const publicPath = pathname === '/' ? '/index.html' : pathname;
  const resolved = resolve(publicRoot, `.${publicPath}`);
  if (!resolved.startsWith(publicRoot)) { res.writeHead(403); return res.end('Forbidden'); }
  const file = existsSync(resolved) && extname(resolved) ? resolved : resolve(publicRoot, 'index.html');
  if (!existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
  const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }[extname(file)] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=300' });
  res.end(readFileSync(file));
}

async function readJson(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new ApiError('Request body too large.', 413, 'BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError('Request body must be valid JSON.', 400, 'INVALID_JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError('Request body must be a JSON object.', 400, 'INVALID_JSON_BODY');
  return body;
}

function sendJson(res, status, data) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}

class ApiError extends Error {
  constructor(message, statusCode = 400, code = 'BAD_REQUEST') { super(message); this.statusCode = statusCode; this.code = code; }
}
export { ApiError, AuthError, SubmissionError };
