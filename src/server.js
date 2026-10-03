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
      } else if (await handlePublicPage(req, res, db, url, requestId)) {
        return;
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
  if (method === 'GET' && pathname === '/api/public/overview') return sendJson(res, 200, await publicOverview(db));
  if (method === 'GET' && pathname === '/api/public/changes') return sendJson(res, 200, await listPublicChanges(db, url.searchParams));
  const publicChangeMatch = pathname.match(/^\/api\/public\/changes\/([^/]+)$/);
  if (method === 'GET' && publicChangeMatch) return sendJson(res, 200, await publicChangeDetail(db, publicChangeMatch[1]));
  if (method === 'GET' && pathname === '/api/public/sources') return sendJson(res, 200, await listPublicSources(db, url.searchParams));
  const publicSourceMatch = pathname.match(/^\/api\/public\/sources\/([^/]+)$/);
  if (method === 'GET' && publicSourceMatch) return sendJson(res, 200, await publicSourceDetail(db, publicSourceMatch[1]));
  if (method === 'GET' && pathname === '/api/public/regulators') return sendJson(res, 200, await listPublicRegulators(db));
  if (method === 'GET' && pathname === '/api/public/obligations') return sendJson(res, 200, await listPublicObligations(db, url.searchParams));
  const publicObligationMatch = pathname.match(/^\/api\/public\/obligations\/([^/]+)$/);
  if (method === 'GET' && publicObligationMatch) return sendJson(res, 200, await publicObligationDetail(db, publicObligationMatch[1]));
  if (method === 'GET' && pathname === '/api/public/schemas') return sendJson(res, 200, await listPublicSchemas(db, url.searchParams));
  const publicSchemaMatch = pathname.match(/^\/api\/public\/schemas\/([^/]+)$/);
  if (method === 'GET' && publicSchemaMatch) return sendJson(res, 200, await publicSchemaDetail(db, publicSchemaMatch[1]));
  if (method === 'GET' && pathname === '/api/public/deadlines') return sendJson(res, 200, await listPublicDeadlines(db, url.searchParams));
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

async function publicOverview(db) {
  const now = new Date();
  const since30d = new Date(now.getTime() - 30 * 86400_000).toISOString();
  const [publicSources, publicRegulators] = await Promise.all([
    listPublicSources(db, new URLSearchParams()), listPublicRegulators(db),
  ]);
  const sourceIds = publicSources.map((source) => source.id);
  const sourceStats = sourceIds.length
    ? await db.prepare(`SELECT s.id, s.regulator_id, s.content_hash_scope,
        (SELECT COUNT(*) FROM regulatory_source_snapshots ss WHERE ss.source_id = s.id
          AND s.content_hash_scope = 'RAW_RESPONSE_SHA256') AS raw_snapshot_count,
        (SELECT COUNT(*) FROM source_verification_checks vc WHERE vc.source_id = s.id AND vc.checked_at >= ?) AS verifications_30d,
        (SELECT MAX(vc.checked_at) FROM source_verification_checks vc WHERE vc.source_id = s.id) AS last_verification_at
      FROM regulatory_sources s WHERE s.id IN (${sourceIds.map(() => '?').join(',')})`).all(since30d, ...sourceIds)
    : [];
  const monitoredRows = await db.prepare(`SELECT id FROM regulatory_sources WHERE enabled = 1 AND adapter IS NOT NULL`).all();
  const monitoredIds = new Set(monitoredRows.map((row) => row.id));
  const sourceStatsById = new Map(sourceStats.map((row) => [row.id, row]));
  const rawSnapshots = sourceStats.reduce((total, row) => total + Number(row.raw_snapshot_count || 0), 0);
  const verifiedSources = sourceStats.filter((row) => row.content_hash_scope === 'RAW_RESPONSE_SHA256'
    && Number(row.raw_snapshot_count) > 0).length;
  const verificationChecks30d = sourceStats.reduce((total, row) => total + Number(row.verifications_30d || 0), 0);
  const sourcesMonitored = sourceIds.filter((id) => monitoredIds.has(id)).length;
  const authorities = publicRegulators.filter((regulator) => regulator.monitored_source_count > 0).map((regulator) => {
    const regulatorSources = publicSources.filter((source) => source.regulator_id === regulator.id && monitoredIds.has(source.id));
    const stats = regulatorSources.map((source) => sourceStatsById.get(source.id)).filter(Boolean);
    const checks = stats.reduce((total, row) => total + Number(row.verifications_30d || 0), 0);
    const lastVerification = stats.map((row) => row.last_verification_at).filter(Boolean).sort().at(-1) || null;
    return {
      id: regulator.id, name: regulator.name, acronym: regulator.acronym, sector: regulator.sector,
      monitored_sources: regulatorSources.length, verifications_30d: checks, last_verification_at: lastVerification,
    };
  });
  const pendingPublic = await listPublicChanges(db, new URLSearchParams({ period: 'all', kind: 'DETECTED', review_required: 'true' }));
  const recent = await listPublicChanges(db, new URLSearchParams({ period: '30d', kind: 'DETECTED' }));
  const detectedChanges30d = recent.changes.filter((change) => change.change_level === 'SOURCE_CHANGED').length;
  const pendingReview = pendingPublic.changes.length;
  const detectedByRegulator = new Map();
  for (const change of recent.changes) {
    if (change.change_level !== 'SOURCE_CHANGED' || !change.regulator?.id) continue;
    detectedByRegulator.set(change.regulator.id, (detectedByRegulator.get(change.regulator.id) || 0) + 1);
  }
  for (const authority of authorities) authority.detected_changes_30d = detectedByRegulator.get(authority.id) || 0;
  return {
    generated_at: now.toISOString(),
    data_mode: db.dataMode || (db.dialect === 'postgres' ? 'LIVE' : 'UNKNOWN'),
    sources_monitored: sourcesMonitored,
    registered_official_sources: publicSources.length,
    verified_capture_sources: verifiedSources,
    raw_snapshots: rawSnapshots,
    verification_checks_30d: verificationChecks30d,
    detected_changes_30d: detectedChanges30d,
    pending_review: pendingReview,
    authorities,
    recent_changes: recent.changes.slice(0, 6),
  };
}

async function listPublicChanges(db, params = new URLSearchParams()) {
  const period = ['7d','30d','90d','all'].includes(params.get('period')) ? params.get('period') : '30d';
  const cutoff = period === 'all' ? null : Date.now() - Number.parseInt(period, 10) * 86400_000;
  const authority = String(params.get('authority') || '').trim().toLowerCase();
  const sourceType = String(params.get('source_type') || '').trim().toLowerCase();
  const kind = String(params.get('kind') || '').trim().toUpperCase();
  const status = String(params.get('status') || '').trim().toUpperCase();
  const reviewRequired = String(params.get('review_required') || '').trim().toLowerCase();
  const cutoffIso = cutoff === null ? '' : new Date(cutoff).toISOString();
  const changeRows = await db.prepare(`SELECT * FROM regulatory_changes
    WHERE is_demo = 0
      AND ((entity_type = 'SOURCE' AND change_level IN ('SOURCE_CHANGED','REGULATORY_CHANGE_CANDIDATE','REGULATORY_CHANGE_CONFIRMED')
            AND previous_snapshot_id IS NOT NULL AND current_snapshot_id IS NOT NULL)
        OR (change_level = 'LEGACY' AND review_status = 'CONFIRMED'))
      AND (? = '' OR detected_at >= ?)
    ORDER BY detected_at DESC, id`).all(cutoffIso, cutoffIso);
  const allRows = [];
  for (const row of changeRows) allRows.push(await enrichChange(db, row));
  const publicRows = [];
  for (const change of allRows) {
    if (Number(change.is_demo) === 1 || change.is_demo === true) continue;
    const category = await classifyPublicChange(db, change);
    if (!category) continue;
    const timestamp = Date.parse(change.detected_at || '');
    if (cutoff !== null && (!Number.isFinite(timestamp) || timestamp < cutoff)) continue;
    const authorityName = String(change.source?.authority || change.regulator?.acronym || change.source?.source_authority || '').toLowerCase();
    if (authority && authorityName !== authority && !authorityName.includes(authority)) continue;
    if (sourceType && String(change.source?.source_type || '').toLowerCase() !== sourceType) continue;
    if (kind && category !== kind) continue;
    if (status === 'REVIEW_REQUIRED' && change.review_status !== 'REVIEW_REQUIRED') continue;
    if (status === 'ANALYZED' && !['ANALYZED','CONFIRMED'].includes(change.review_status)) continue;
    if (status === 'SOURCE_CHANGED' && change.change_level !== 'SOURCE_CHANGED') continue;
    if (reviewRequired === 'true' && change.review_status !== 'REVIEW_REQUIRED') continue;
    if (reviewRequired === 'false' && change.review_status === 'REVIEW_REQUIRED') continue;
    publicRows.push(publicChangeSummary(change, category));
  }
  const detectedCount = publicRows.filter((row) => row.public_category === 'DETECTED').length;
  const documentedCount = publicRows.filter((row) => row.public_category === 'DOCUMENTED').length;
  return { period, total: publicRows.length, detected_count: detectedCount, documented_count: documentedCount, changes: publicRows };
}

function publicChangeSummary(change, category) {
  return {
    id: change.id, entity_type: change.entity_type, entity_id: change.entity_id,
    old_version: change.old_version, new_version: change.new_version,
    change_type: change.change_type, field: change.field, detected_at: change.detected_at,
    effective_at: change.effective_at, severity: change.severity,
    source_reference: change.source_reference, source_url: change.source_url,
    summary: change.summary, confidence: change.confidence,
    review_status: change.review_status, change_level: change.change_level,
    previous_snapshot_id: change.previous_snapshot_id, current_snapshot_id: change.current_snapshot_id,
    diff_type: change.diff_type, diff_summary: change.diff_summary,
    source: change.source ? {
      id: change.source.id, source_title: change.source.source_title,
      source_type: change.source.source_type, source_authority: change.source.source_authority,
      authority: change.source.authority, source_url: change.source.source_url,
    } : null,
    regulator: change.regulator ? {
      id: change.regulator.id, name: change.regulator.name, acronym: change.regulator.acronym,
    } : null,
    public_category: category,
    public_status: category === 'DOCUMENTED' ? 'DOCUMENTED_REFERENCE'
      : change.review_status === 'REVIEW_REQUIRED' ? 'REVIEW_REQUIRED'
        : ['ANALYZED','CONFIRMED'].includes(change.review_status) ? 'ANALYZED' : 'CHANGE_DETECTED',
  };
}

async function classifyPublicChange(db, change) {
  if (!change.source_url || !isOfficialSourceUrl(change.source_url)) return null;
  if (change.entity_type === 'SOURCE' && change.current_snapshot_id && change.previous_snapshot_id
    && ['SOURCE_CHANGED','REGULATORY_CHANGE_CANDIDATE','REGULATORY_CHANGE_CONFIRMED'].includes(change.change_level)) {
    const [current, previous] = await Promise.all([
      db.prepare('SELECT id, previous_snapshot_id FROM regulatory_source_snapshots WHERE id = ? AND source_id = ?').get(change.current_snapshot_id, change.entity_id),
      db.prepare('SELECT id FROM regulatory_source_snapshots WHERE id = ? AND source_id = ?').get(change.previous_snapshot_id, change.entity_id),
    ]);
    if (current && previous && current.previous_snapshot_id === previous.id) return 'DETECTED';
    return null;
  }
  if (change.change_level === 'LEGACY' && change.review_status === 'CONFIRMED') {
    const source = await db.prepare('SELECT id FROM regulatory_sources WHERE source_url = ? LIMIT 1').get(change.source_url);
    if (source) return 'DOCUMENTED';
  }
  return null;
}

async function publicChangeDetail(db, id) {
  const detail = await changeDetail(db, id);
  const category = await classifyPublicChange(db, detail);
  if (!category || Number(detail.is_demo) === 1) throw new ApiError('This change record is not available in the public workspace.', 404, 'PUBLIC_CHANGE_NOT_FOUND');
  const previous = detail.snapshots.previous_snapshot_id;
  const current = detail.snapshots.current_snapshot_id;
  const snapshotPayload = (snapshot) => snapshot ? {
    id: snapshot.id, source_id: snapshot.source_id, content_hash: snapshot.content_hash,
    mime_type: snapshot.mime_type, collected_at: snapshot.collected_at, http_status: snapshot.http_status,
    content_size: snapshot.content_size, content_length: snapshot.content_length, parser: snapshot.parser,
    parse_status: snapshot.parse_status, diff_type: snapshot.diff_type,
    diff_summary: snapshot.diff_summary,
    extracted_text: snapshot.extracted_text ? String(snapshot.extracted_text).slice(0, 5000) : null,
    extracted_text_truncated: Boolean(snapshot.extracted_text && String(snapshot.extracted_text).length > 5000),
  } : null;
  const snapshots = { previous: snapshotPayload(previous), current: snapshotPayload(current) };
  let textDiff = null;
  if (previous?.extracted_text && current?.extracted_text) {
    if (previous.extracted_text.length <= 50_000 && current.extracted_text.length <= 50_000) {
      textDiff = compareNormativeText(previous.extracted_text, current.extracted_text);
    } else {
      textDiff = { available: false, reason: 'Text comparison exceeds the 50 KB review limit; no semantic interpretation was attempted.' };
    }
  }
  let schema = null;
  if (detail.entity_type === 'SCHEMA_VERSION') {
    schema = await db.prepare(`SELECT sv.id, sv.version, sv.schema_type, sv.parse_status, sv.field_inventory_scope, sv.fields_count,
        d.id AS document_id, d.code AS document_code, d.name AS document_name, d.source_url AS document_source_url,
        d.is_demo AS document_is_demo
      FROM schema_versions sv JOIN regulatory_documents d ON d.id = sv.document_id WHERE sv.id = ?`).get(detail.entity_id) || null;
  } else if (detail.entity_type === 'REGULATORY_DOCUMENT') {
    schema = await db.prepare(`SELECT sv.id, sv.version, sv.schema_type, sv.parse_status, sv.field_inventory_scope, sv.fields_count,
        d.id AS document_id, d.code AS document_code, d.name AS document_name, d.source_url AS document_source_url,
        d.is_demo AS document_is_demo
      FROM schema_versions sv JOIN regulatory_documents d ON d.id = sv.document_id WHERE d.id = ? AND sv.status = 'CURRENT' LIMIT 1`).get(detail.entity_id) || null;
  }
  if (schema && (Number(schema.document_is_demo) === 1 || !isOfficialSourceUrl(schema.document_source_url))) schema = null;
  const fields = schema && Number(schema.document_is_demo) === 0
    ? await db.prepare('SELECT id, name, path, data_type, required, source_reference FROM regulatory_fields WHERE schema_version_id = ? AND status <> \'DEPRECATED\' ORDER BY path').all(schema.id)
    : [];
  const relatedObligations = [];
  if (detail.obligation && Number(detail.obligation.is_demo) === 0) relatedObligations.push(detail.obligation);
  if (detail.entity_type === 'SOURCE') {
    const rows = await db.prepare(`SELECT DISTINCT o.id, o.code, o.title, o.is_demo,
        n.source_url AS regulation_source_url, n.is_demo AS regulation_is_demo, r.acronym AS regulator_acronym
      FROM regulatory_source_links l JOIN regulatory_obligations o ON o.id = l.entity_id AND l.entity_type = 'OBLIGATION'
      JOIN regulations n ON n.id = o.regulation_id JOIN regulators r ON r.id = o.regulator_id
      WHERE l.source_id = ? AND o.is_demo = 0 AND n.is_demo = 0 ORDER BY r.acronym, o.code`).all(detail.entity_id);
    for (const row of rows) if (isOfficialSourceUrl(row.regulation_source_url)
      && !relatedObligations.some((item) => item.id === row.id)) relatedObligations.push(row);
  }
  const source = detail.source ? {
    id: detail.source.id, source_title: detail.source.source_title, source_type: detail.source.source_type,
    source_authority: detail.source.source_authority, authority: detail.source.authority,
    source_url: detail.source_url, status: detail.source.status,
  } : {
    id: detail.entity_type === 'SOURCE' ? detail.entity_id : null,
    source_title: detail.source_reference, source_type: null, source_authority: detail.regulator?.name || null,
    authority: detail.regulator?.acronym || null, source_url: detail.source_url, status: null,
  };
  const publicRelatedObligations = relatedObligations
    .filter((item) => Number(item.is_demo) !== 1)
    .map((item) => ({
      id: item.id, code: item.code, title: item.title,
      regulator_acronym: item.regulator_acronym || detail.regulator?.acronym || null,
    }));
  const publicSchema = schema ? {
    id: schema.id, version: schema.version, schema_type: schema.schema_type,
    parse_status: schema.parse_status, field_inventory_scope: schema.field_inventory_scope,
    fields_count: schema.fields_count, document_id: schema.document_id,
    document_code: schema.document_code, document_name: schema.document_name,
  } : null;
  return {
    id: detail.id, entity_type: detail.entity_type, entity_id: detail.entity_id,
    old_version: detail.old_version, new_version: detail.new_version,
    change_type: detail.change_type, field: detail.field, old_value: detail.old_value,
    new_value: detail.new_value, detected_at: detail.detected_at, effective_at: detail.effective_at,
    severity: detail.severity, source_reference: detail.source_reference,
    source_url: detail.source_url, summary: detail.summary, confidence: detail.confidence,
    review_status: detail.review_status, change_level: detail.change_level,
    diff_type: detail.diff_type, diff_summary: detail.diff_summary,
    regulator: detail.regulator ? {
      id: detail.regulator.id, name: detail.regulator.name, acronym: detail.regulator.acronym,
    } : null,
    source,
    public_category: category,
    public_status: category === 'DOCUMENTED' ? 'DOCUMENTED_REFERENCE'
      : detail.review_status === 'REVIEW_REQUIRED' ? 'REVIEW_REQUIRED'
        : ['ANALYZED','CONFIRMED'].includes(detail.review_status) ? 'ANALYZED' : 'CHANGE_DETECTED',
    snapshots,
    text_diff: textDiff,
    schema: publicSchema,
    fields: fields.map(publicField),
    related_obligations: publicRelatedObligations,
    impacts: detail.impacts.map((impact) => ({
      impact_type: impact.impact_type, severity: impact.severity,
      description: impact.description, rationale: impact.rationale,
    })),
    impact_notice: 'Impactos técnicos catalogados apoiam triagem de engenharia; não são classificação jurídica nem decisão de aplicabilidade.',
  };
}

function publicField(field) {
  return {
    id: field.id, name: field.name, path: field.path, parent_path: field.parent_path,
    description: field.description, data_type: field.data_type, required: field.required,
    required_condition: field.required_condition, min_occurs: field.min_occurs,
    max_occurs: field.max_occurs, length: field.length, precision: field.precision,
    scale: field.scale, domain: field.domain, pattern: field.pattern,
    source_reference: field.source_reference, status: field.status,
    document_id: field.document_id, document_code: field.document_code,
  };
}

async function listPublicSources(db, params = new URLSearchParams()) {
  const rows = await listSources(db, params);
  const sourceType = String(params.get('source_type') || '').trim().toLowerCase();
  const q = String(params.get('q') || '').trim().toLowerCase();
  return rows.filter((row) => isOfficialSourceUrl(row.source_url)
    && (!sourceType || String(row.source_type || '').toLowerCase() === sourceType)
    && (!q || `${row.source_title} ${row.source_authority} ${row.source_type} ${row.source_url}`.toLowerCase().includes(q))).map((row) => ({
    id: row.id, regulator_id: row.regulator_id, regulator_acronym: row.regulator_acronym,
    regulator_name: row.regulator_name, authority: row.authority || row.source_authority,
    source_authority: row.source_authority, source_title: row.source_title, source_url: row.source_url,
    source_type: row.source_type, status: row.status, enabled: Boolean(row.enabled),
    last_checked_at: row.last_checked_at, last_http_status: row.last_http_status,
    raw_snapshot_count: Number(row.raw_snapshot_count || 0), last_raw_snapshot_at: row.last_raw_snapshot_at,
    content_hash: row.content_hash, content_hash_scope: row.content_hash_scope,
    verification_status: row.verification_status,
  }));
}

async function publicSourceDetail(db, id) {
  const detail = await sourceDetail(db, id);
  if (!isOfficialSourceUrl(detail.source.source_url)) throw new ApiError('Source is not allowlisted as an official public source.', 404, 'PUBLIC_SOURCE_NOT_FOUND');
  const publicChanges = [];
  for (const change of detail.changes) {
    if (Number(change.is_demo) === 1) continue;
    const category = await classifyPublicChange(db, change);
    if (category) publicChanges.push({ ...change, public_category: category });
  }
  return {
    source: {
      id: detail.source.id, source_title: detail.source.source_title, source_url: detail.source.source_url,
      source_authority: detail.source.source_authority, authority: detail.source.authority || detail.source.source_authority,
      source_type: detail.source.source_type, status: detail.source.status, content_hash: detail.source.content_hash,
      content_hash_scope: detail.source.content_hash_scope, last_checked_at: detail.source.last_checked_at,
      last_http_status: detail.source.last_http_status, etag: detail.source.etag, last_modified: detail.source.last_modified,
      raw_snapshot_count: detail.snapshots.length,
    },
    snapshots: detail.snapshots.map((snapshot) => ({
      id: snapshot.id, collected_at: snapshot.collected_at, content_hash: snapshot.content_hash,
      mime_type: snapshot.mime_type, content_size: snapshot.content_size, http_status: snapshot.http_status,
      parser: snapshot.parser, parse_status: snapshot.parse_status,
      diff_type: snapshot.diff_type, diff_summary: snapshot.diff_summary,
      previous_snapshot_id: snapshot.previous_snapshot_id,
    })),
    checks: detail.checks.map((check) => ({
      checked_at: check.checked_at, http_status: check.http_status, outcome: check.outcome,
      content_hash: check.content_hash,
    })),
    changes: publicChanges.map((change) => ({
      id: change.id, summary: change.summary, detected_at: change.detected_at,
      change_level: change.change_level, review_status: change.review_status,
      public_category: change.public_category,
    })),
    hash_notice: detail.hash_notice,
  };
}

async function listPublicRegulators(db) {
  const [rows, sources, obligations, monitored] = await Promise.all([
    db.prepare('SELECT id, name, acronym, sector, jurisdiction, website, active FROM regulators WHERE active = 1 ORDER BY name').all(),
    listPublicSources(db, new URLSearchParams()),
    listPublicObligations(db, new URLSearchParams()),
    db.prepare(`SELECT id, regulator_id FROM regulatory_sources
      WHERE enabled = 1 AND adapter IS NOT NULL`).all(),
  ]);
  const officialSourceIds = new Set(sources.map((source) => source.id));
  const monitoredCounts = new Map();
  for (const source of monitored) {
    if (!officialSourceIds.has(source.id)) continue;
    monitoredCounts.set(source.regulator_id, (monitoredCounts.get(source.regulator_id) || 0) + 1);
  }
  return rows.filter((row) => Number(row.active) !== 0 && isOfficialSourceUrl(row.website)).map((row) => {
    const officialSources = sources.filter((source) => source.regulator_id === row.id);
    return {
      id: row.id, name: row.name, acronym: row.acronym, sector: row.sector,
      jurisdiction: row.jurisdiction, website: row.website,
      source_count: officialSources.length,
      monitored_source_count: monitoredCounts.get(row.id) || 0,
      obligation_count: obligations.filter((obligation) => obligation.regulator_id === row.id).length,
    };
  });
}

async function listPublicObligations(db, params = new URLSearchParams()) {
  const rows = await listObligations(db, params);
  return rows.filter((row) => Number(row.is_demo) !== 1 && Number(row.regulation_is_demo) !== 1
    && isOfficialSourceUrl(row.regulation_source_url)).map((row) => ({
    id: row.id, regulation_id: row.regulation_id, regulator_id: row.regulator_id,
    code: row.code, title: row.title, description: row.description,
    affected_entities: row.affected_entities, category: row.category,
    frequency: row.frequency, effective_date: row.effective_date,
    output_format: row.output_format, status: row.status,
    regulator_name: row.regulator_name, regulator_acronym: row.regulator_acronym,
    regulation_title: row.regulation_title, regulation_number: row.regulation_number,
    regulation_source_url: row.regulation_source_url,
    next_official_deadline: row.next_official_deadline,
    requirement_count: Number(row.requirement_count || 0),
    document_count: Number(row.document_count || 0),
  }));
}

async function publicObligationDetail(db, id) {
  const detail = await obligationDetail(db, id);
  const obligation = detail.obligation;
  if (Number(obligation.is_demo) === 1 || Number(obligation.regulation_is_demo) === 1
    || !isOfficialSourceUrl(obligation.regulation_source_url)) {
    throw new ApiError('This obligation is not part of the public regulatory inventory.', 404, 'PUBLIC_OBLIGATION_NOT_FOUND');
  }
  const documents = detail.documents.filter((row) => Number(row.is_demo) !== 1 && isOfficialSourceUrl(row.source_url));
  const publicDocumentIds = new Set(documents.map((row) => row.id));
  const requirements = detail.requirements.filter((row) => Number(row.is_demo) !== 1
    && isOfficialSourceUrl(row.source_url)).map((row) => ({
    requirement_type: row.requirement_type, description: row.description,
    source_reference: row.source_reference, source_url: row.source_url,
    effective_from: row.effective_from, effective_to: row.effective_to, status: row.status,
  }));
  const publicChanges = [];
  for (const change of detail.changes) {
    if (Number(change.is_demo) === 1) continue;
    const category = await classifyPublicChange(db, change);
    if (category) publicChanges.push(publicChangeSummary(change, category));
  }
  return {
    obligation: {
      id: obligation.id, regulation_id: obligation.regulation_id, regulator_id: obligation.regulator_id,
      code: obligation.code, title: obligation.title, description: obligation.description,
      affected_entities: obligation.affected_entities, category: obligation.category,
      frequency: obligation.frequency, effective_date: obligation.effective_date,
      output_format: obligation.output_format, status: obligation.status,
      regulator_name: obligation.regulator_name, regulator_acronym: obligation.regulator_acronym,
      regulation_title: obligation.regulation_title, regulation_number: obligation.regulation_number,
      regulation_source_url: obligation.regulation_source_url,
    },
    requirements,
    documents: documents.map((row) => ({
      id: row.id, code: row.code, name: row.name, document_type: row.document_type,
      output_format: row.output_format, frequency: row.frequency, source_url: row.source_url,
      schema_version_id: row.schema_version_id, version: row.version, parse_status: row.parse_status,
    })),
    fields: detail.fields.filter((field) => Number(field.document_is_demo) !== 1
      && publicDocumentIds.has(field.document_id)).map(publicField),
    deadlines: detail.deadlines.filter((row) => row.deadline_type === 'OFFICIAL'
      && Number(row.is_demo) !== 1 && isOfficialSourceUrl(row.source_url)).map((row) => ({
      id: row.id, obligation_id: row.obligation_id, reference_period: row.reference_period,
      due_date: row.due_date, deadline_type: row.deadline_type, source_url: row.source_url,
      status: row.status, calculation_basis: row.calculation_basis,
    })),
    changes: publicChanges,
    sources: detail.sources.filter((row) => isOfficialSourceUrl(row.source_url)).map((row) => ({
      id: row.id, source_title: row.source_title, source_authority: row.source_authority,
      source_type: row.source_type, source_url: row.source_url, version: row.version,
      publication_date: row.publication_date, status: row.status, content_hash_scope: row.content_hash_scope,
      content_hash: row.content_hash, raw_snapshot_count: Number(row.raw_snapshot_count || 0),
      last_raw_snapshot_at: row.last_raw_snapshot_at,
    })),
  };
}

async function listPublicSchemas(db, params = new URLSearchParams()) {
  const rows = await listSchemas(db, params);
  return rows.filter((row) => Number(row.document_is_demo) !== 1 && isOfficialSourceUrl(row.source_url)).map((row) => ({
    id: row.id, document_id: row.document_id, version: row.version,
    schema_type: row.schema_type, status: row.status, parse_status: row.parse_status,
    field_inventory_scope: row.field_inventory_scope, fields_count: row.fields_count,
    catalogued_fields: Number(row.catalogued_fields || 0), linked_changes: Number(row.linked_changes || 0),
    document_code: row.document_code, document_name: row.document_name,
    output_format: row.output_format, obligation_title: row.obligation_title,
    regulator_acronym: row.regulator_acronym, source_url: row.source_url,
    source_title: row.source_title,
  }));
}

async function publicSchemaDetail(db, id) {
  const detail = await schemaDetail(db, id);
  if (Number(detail.schema.document_is_demo) === 1 || !isOfficialSourceUrl(detail.schema.source_url)) {
    throw new ApiError('This schema is not part of the public regulatory inventory.', 404, 'PUBLIC_SCHEMA_NOT_FOUND');
  }
  const row = detail.schema;
  const schema = {
    id: row.id, document_id: row.document_id, version: row.version,
    schema_type: row.schema_type, parse_status: row.parse_status,
    field_inventory_scope: row.field_inventory_scope, fields_count: row.fields_count,
    document_code: row.document_code, document_name: row.document_name,
    output_format: row.output_format, obligation_id: row.obligation_id,
    obligation_title: row.obligation_title, regulator_acronym: row.regulator_acronym,
    source_url: row.source_url, source_title: row.source_title,
  };
  const fields = detail.fields.filter((field) => field.status !== 'DEPRECATED').map(publicField);
  const changes = [];
  for (const change of detail.changes) {
    if (Number(change.is_demo) === 1) continue;
    const category = await classifyPublicChange(db, change);
    if (category) changes.push(publicChangeSummary(change, category));
  }
  return { schema, fields, changes };
}

async function listPublicDeadlines(db, params = new URLSearchParams()) {
  return (await listDeadlines(db, params)).filter((row) => row.deadline_type === 'OFFICIAL'
    && Number(row.is_demo) !== 1 && isOfficialSourceUrl(row.source_url)).map((row) => ({
    id: row.id, obligation_id: row.obligation_id, reference_period: row.reference_period,
    due_date: row.due_date, deadline_type: row.deadline_type, source_url: row.source_url,
    status: row.status, calculation_basis: row.calculation_basis,
    obligation_code: row.obligation_code, obligation_title: row.obligation_title,
    regulator_acronym: row.regulator_acronym,
  }));
}

async function listRegulators(db) {
  const rows = await db.prepare(`SELECT r.*,
    (SELECT COUNT(*) FROM regulations x WHERE x.regulator_id = r.id) AS regulation_count,
    (SELECT COUNT(*) FROM regulatory_obligations o WHERE o.regulator_id = r.id AND o.status = 'ACTIVE') AS obligation_count,
    (SELECT COUNT(*) FROM regulatory_sources s WHERE s.regulator_id = r.id) AS source_count,
    (SELECT COUNT(*) FROM regulatory_sources s WHERE s.regulator_id = r.id AND s.content_hash_scope = 'RAW_RESPONSE_SHA256') AS raw_monitored_count,
    (SELECT COUNT(*) FROM regulatory_sources s WHERE s.regulator_id = r.id AND s.enabled = 1 AND s.adapter IS NOT NULL) AS monitored_source_count
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
      n.title AS regulation_title, n.number AS regulation_number, n.source_url AS regulation_source_url, n.is_demo AS regulation_is_demo,
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
    ORDER BY next_official_deadline ASC NULLS LAST, r.acronym, o.code`)
    .all(today, regulator, regulator, regulator, category, category, status, status, frequency, frequency, q, q);
  return rows.map((row) => ({
    ...row,
    next_official_deadline: row.next_official_deadline ? String(row.next_official_deadline).slice(0, 10) : null,
    mapping_coverage: row.field_count ? Math.round((row.mapped_field_count / row.field_count) * 100) : null,
    dq_coverage: row.field_count ? Math.round((row.dq_field_count / row.field_count) * 100) : null,
  }));
}

async function obligationDetail(db, id) {
  const obligation = await db.prepare(`SELECT o.*, r.name AS regulator_name, r.acronym AS regulator_acronym, n.title AS regulation_title, n.number AS regulation_number, n.source_url AS regulation_source_url, n.source_excerpt AS regulation_excerpt, n.is_demo AS regulation_is_demo
    FROM regulatory_obligations o JOIN regulators r ON r.id = o.regulator_id JOIN regulations n ON n.id = o.regulation_id WHERE o.id = ?`).get(id);
  if (!obligation) throw new ApiError('Obligation not found.', 404, 'OBLIGATION_NOT_FOUND');
  const requirements = await db.prepare(`SELECT q.*, s.source_url, s.source_title, s.content_hash, s.content_hash_scope
    FROM requirements q LEFT JOIN regulatory_sources s ON s.id = q.source_id WHERE q.obligation_id = ? ORDER BY q.id`).all(id);
  const documents = await db.prepare(`SELECT d.*, s.source_url, s.source_title,
      sv.id AS schema_version_id, sv.version, sv.schema_type, sv.schema_url, sv.fields_count,
      sv.field_inventory_scope, sv.parse_status, sv.adapter_config_json
    FROM regulatory_documents d LEFT JOIN schema_versions sv ON sv.document_id = d.id AND sv.status = 'CURRENT'
    LEFT JOIN regulatory_sources s ON s.id = d.source_id
    WHERE d.obligation_id = ? ORDER BY d.code`).all(id);
  const fields = await db.prepare(`SELECT f.*, d.id AS document_id, d.code AS document_code,
      d.is_demo AS document_is_demo, s.source_url AS document_source_url,
      sv.version AS schema_version, d.name AS document_name,
      (SELECT COUNT(*) FROM dq_rules q WHERE q.regulatory_field_id=f.id) AS dq_rule_count
    FROM regulatory_fields f JOIN schema_versions sv ON sv.id = f.schema_version_id JOIN regulatory_documents d ON d.id = sv.document_id
    LEFT JOIN regulatory_sources s ON s.id = d.source_id
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
  return await db.prepare(`SELECT sv.*, d.code AS document_code, d.name AS document_name, d.output_format, d.is_demo AS document_is_demo, o.title AS obligation_title, r.acronym AS regulator_acronym, s.source_url, s.source_title,
    (SELECT COUNT(*) FROM regulatory_fields f WHERE f.schema_version_id = sv.id) AS catalogued_fields,
    (SELECT COUNT(*) FROM regulatory_changes c WHERE c.entity_id = sv.id OR c.entity_id = d.id) AS linked_changes
    FROM schema_versions sv JOIN regulatory_documents d ON d.id = sv.document_id JOIN regulatory_obligations o ON o.id = d.obligation_id JOIN regulators r ON r.id = o.regulator_id LEFT JOIN regulatory_sources s ON s.id = d.source_id
    WHERE (? = '' OR lower(d.code || ' ' || d.name || ' ' || sv.version || ' ' || o.title || ' ' || r.acronym) LIKE '%' || lower(?) || '%')
    ORDER BY r.acronym, d.code, sv.version DESC`).all(q, q);
}

async function schemaDetail(db, id) {
  const schema = await db.prepare(`SELECT sv.*, d.code AS document_code, d.name AS document_name, d.output_format, d.is_demo AS document_is_demo, d.obligation_id, o.title AS obligation_title, r.acronym AS regulator_acronym, s.source_url, s.source_title
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
      snapshots[key] = await db.prepare(`SELECT id, source_id, content_hash, mime_type, collected_at, http_status, content_length, content_size, storage_provider, raw_storage_path, parser, parse_status, parse_error, diff_type, diff_summary, previous_snapshot_id, extracted_text, fields_json FROM regulatory_source_snapshots WHERE id = ?`).get(change[key]) || null;
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
  const source = change.source_url ? await db.prepare(`SELECT s.id, s.source_title, s.source_type, s.source_authority, s.authority, s.source_url,
      s.content_hash, s.content_hash_scope, s.status,
      (SELECT COUNT(*) FROM regulatory_source_snapshots ss WHERE ss.source_id = s.id) AS raw_snapshot_count,
      (SELECT MAX(collected_at) FROM regulatory_source_snapshots ss WHERE ss.source_id = s.id) AS last_raw_snapshot_at
    FROM regulatory_sources s WHERE s.source_url = ? LIMIT 1`).get(change.source_url) : null;
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
    'X-Robots-Tag': 'noindex, nofollow',
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
  res.writeHead(200, { 'Content-Type': `${types[extension] || 'application/octet-stream'}; charset=utf-8`, 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
  res.end(artifact.body);
}

const PUBLIC_SEO_PATHS = new Set(['/', '/mudancas', '/fontes', '/orgaos', '/obrigacoes', '/schemas', '/prazos', '/sobre']);
const LCF_CONSULTING_SITE = 'https://www.lcfconsulting.com.br/';

export async function handlePublicPage(req, res, db, url, requestId = '') {
  const pathname = decodeURIComponent(url.pathname || '/');
  const method = req.method || 'GET';
  const origin = publicOrigin(req);
  if (method !== 'GET' && method !== 'HEAD') return false;

  if (pathname === '/robots.txt') {
    const body = [
      'User-agent: *', 'Allow: /', 'Disallow: /api/', 'Disallow: /admin', 'Disallow: /system/',
      'Disallow: /jobs', 'Disallow: /errors', 'Disallow: /internal', `Sitemap: ${origin}/sitemap.xml`, '',
    ].join('\n');
    return sendPublicResponse(req, res, 200, 'text/plain; charset=utf-8', body, { 'X-Robots-Tag': 'noindex' });
  }
  if (pathname === '/sitemap.xml') {
    const body = await buildSitemapXml(db, origin);
    return sendPublicResponse(req, res, 200, 'application/xml; charset=utf-8', body, { 'X-Robots-Tag': 'noindex' });
  }
  if (pathname === '/admin') {
    const html = publicDocument({
      title: 'Admin / Operations | LCF RegTech',
      description: 'Área interna de operação e desenvolvimento do LCF RegTech.',
      canonical: `${origin}/admin`, origin, robots: 'noindex,nofollow',
      content: '<main class="public-main"><section class="public-empty"><p class="eyebrow">LCF REGTECH · ÁREA INTERNA</p><h1>Admin / Operations</h1><p>Carregando o espaço interno de operação e desenvolvimento…</p></section></main>',
    });
    return sendPublicResponse(req, res, 200, 'text/html; charset=utf-8', html, {
      'X-Robots-Tag': 'noindex, nofollow', 'X-Request-Id': requestId,
    });
  }

  const route = publicSeoRoute(pathname);
  if (!route) return false;
  if (!db) {
    const html = publicDocument({
      title: 'LCF RegTech — dados temporariamente indisponíveis',
      description: 'A consulta pública depende da base PostgreSQL configurada. Nenhum dado regulatório é inventado quando a persistência está indisponível.',
      canonical: `${origin}${pathname}`, origin, robots: 'noindex,follow',
      content: `<main class="public-main"><section class="public-empty"><p class="eyebrow">LCF REGTECH</p><h1>Dados temporariamente indisponíveis</h1><p>O serviço de persistência não está disponível. Nenhuma informação regulatória foi fabricada ou substituída por dados de demonstração.</p><a class="public-button" href="/">Tentar novamente</a></section></main>`,
    });
    return sendPublicResponse(req, res, 503, 'text/html; charset=utf-8', html, { 'X-Robots-Tag': 'noindex,follow', 'X-Request-Id': requestId });
  }

  try {
    const page = await buildPublicSeoPage(db, route, url.searchParams, origin);
    const html = publicDocument({ ...page, origin });
    return sendPublicResponse(req, res, page.status || 200, 'text/html; charset=utf-8', html, {
      'X-Robots-Tag': page.robots === 'noindex,follow' ? 'noindex,follow' : 'index,follow',
      'X-Request-Id': requestId,
    });
  } catch (error) {
    const status = Number(error?.statusCode) || 500;
    const title = status === 404 ? 'Página não encontrada | LCF RegTech' : 'Serviço temporariamente indisponível | LCF RegTech';
    const message = status === 404 ? 'Este conteúdo não existe ou não está disponível para consulta pública.' : 'Não foi possível carregar dados verificáveis neste momento. Tente novamente em instantes.';
    if (status >= 500) console.error(JSON.stringify({ level: 'error', request_id: requestId, path: pathname, message: error?.message || String(error) }));
    const html = publicDocument({
      title, description: message, canonical: `${origin}${pathname}`, origin,
      robots: 'noindex,follow', status,
      content: `<main class="public-main"><section class="public-empty"><p class="eyebrow">LCF REGTECH</p><h1>${escapeHtml(status === 404 ? 'Conteúdo não encontrado' : 'Consulta temporariamente indisponível')}</h1><p>${escapeHtml(message)}</p><a class="public-button" href="/">Voltar à visão geral</a></section></main>`,
    });
    return sendPublicResponse(req, res, status, 'text/html; charset=utf-8', html, {
      'X-Robots-Tag': 'noindex,follow', 'X-Request-Id': requestId,
    });
  }
}

function publicSeoRoute(pathname) {
  if (PUBLIC_SEO_PATHS.has(pathname)) return { path: pathname };
  const patterns = [
    ['/mudancas/', 'change'], ['/fontes/', 'source'], ['/obrigacoes/', 'obligation'], ['/schemas/', 'schema'],
  ];
  for (const [prefix, type] of patterns) {
    if (pathname.startsWith(prefix) && pathname.slice(prefix.length) && !pathname.slice(prefix.length).includes('/')) {
      return { path: pathname, type, id: pathname.slice(prefix.length) };
    }
  }
  return null;
}

function publicOrigin(req) {
  const configured = String(process.env.PUBLIC_SITE_URL || '').trim();
  if (configured) {
    try { const parsed = new URL(configured); if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return parsed.origin; } catch { /* use request host */ }
  }
  const forwardedHost = String(req.headers?.['x-forwarded-host'] || '').split(',')[0].trim();
  const rawHost = forwardedHost || String(req.headers?.host || 'localhost').split(',')[0].trim();
  const host = /^[a-zA-Z0-9.\-]+(?::\d{1,5})?$/.test(rawHost) ? rawHost : 'localhost';
  const forwardedProto = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const protocol = forwardedProto === 'https' || process.env.VERCEL === '1' || req.socket?.encrypted ? 'https' : 'http';
  return `${protocol}://${host}`;
}

function sendPublicResponse(req, res, status, contentType, body, headers = {}) {
  const bytes = Buffer.from(body, 'utf8');
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': bytes.length,
    'Cache-Control': contentType.startsWith('text/html') ? 'public, max-age=60, s-maxage=300, stale-while-revalidate=60' : 'public, max-age=300',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    ...headers,
  });
  res.end(req.method === 'HEAD' ? undefined : bytes);
  return true;
}

async function buildPublicSeoPage(db, route, query, origin) {
  const canonicalPath = route.type ? route.path : route.path;
  const canonical = `${origin}${canonicalPath}`;
  if (route.path === '/') return buildPublicHomePage(db, origin);
  if (route.path === '/sobre') return buildAboutPage(origin);
  if (route.path === '/mudancas') return buildChangesPage(db, query, origin);
  if (route.type === 'change') return buildChangeDetailPage(db, route.id, origin);
  if (route.path === '/fontes') return buildSourcesPage(db, query, origin);
  if (route.type === 'source') return buildSourceDetailPage(db, route.id, origin);
  if (route.path === '/orgaos') return buildRegulatorsPage(db, query, origin);
  if (route.path === '/obrigacoes') return buildObligationsPage(db, query, origin);
  if (route.type === 'obligation') return buildObligationDetailPage(db, route.id, origin);
  if (route.path === '/schemas') return buildSchemasPage(db, query, origin);
  if (route.type === 'schema') return buildSchemaDetailPage(db, route.id, origin);
  if (route.path === '/prazos') return buildDeadlinesPage(db, query, origin);
  return { title: 'LCF RegTech', description: 'Regulatory Data Intelligence by LCF Consulting.', canonical, content: publicShell('<main class="public-main"><h1>LCF RegTech</h1></main>', route.path, origin) };
}

async function buildPublicHomePage(db, origin) {
  const overview = await publicOverview(db);
  const changes = overview.recent_changes || [];
  const changeMarkup = changes.length ? changes.map((change) => serverChangeCard(change, origin)).join('')
    : '<div class="public-empty"><strong>Nenhuma alteração detectada nas fontes monitoradas no período.</strong><p>O painel só exibe detecções vinculadas a snapshots reais. Uma verificação sem mudança não é apresentada como nova alteração.</p></div>';
  const authorityCards = overview.authorities.length ? overview.authorities.map((authority) => `<article class="authority-card"><div class="authority-acronym">${escapeHtml(authority.acronym)}</div><div><strong>${escapeHtml(authority.name)}</strong><p>${formatNumber(authority.monitored_sources)} fonte(s) monitorada(s) · ${formatNumber(authority.verifications_30d)} verificação(ões) nos últimos 30 dias</p><small>${authority.last_verification_at ? `Última verificação ${formatPublicDate(authority.last_verification_at)}` : 'Nenhuma verificação registrada'}</small></div></article>`).join('')
    : '<div class="public-empty"><strong>Nenhuma fonte monitorada configurada nesta base.</strong><p>As fontes oficiais aparecem aqui após a sincronização dos adapters existentes.</p></div>';
  const dataStatus = overview.data_mode === 'LIVE'
    ? (overview.raw_snapshots > 0
      ? '<div class="public-notice live"><strong>LIVE · FONTES OFICIAIS.</strong> As capturas verificadas são identificadas individualmente abaixo; cada alteração continua sujeita à revisão.</div>'
      : '<div class="public-notice"><strong>MONITORAMENTO LIVE.</strong> A base está conectada, mas ainda não há snapshot bruto capturado. O site não apresenta alterações sem evidência.</div>')
    : '<div class="public-notice"><strong>AMBIENTE DE DESENVOLVIMENTO.</strong> Registros de referência podem existir; capturas oficiais só são tratadas como verificadas quando seus bytes e SHA-256 estão armazenados.</div>';
  const content = `<main class="public-main">
    <section class="public-hero"><p class="eyebrow">LCF REGTECH <span>·</span> REGULATORY DATA INTELLIGENCE</p><h1>O que mudou na regulação?</h1><p class="hero-lede">Saiba o que mudou nas fontes regulatórias oficiais — e onde essa mudança pode gerar impacto.</p><p class="hero-detail">Monitoramento contínuo de normas, manuais, layouts e documentos oficiais, com histórico de versões e evidências para análise regulatória e técnica.</p><div class="hero-actions"><a class="public-button primary" href="/mudancas">Ver mudanças recentes</a><a class="public-button" href="/fontes">Explorar fontes oficiais</a></div><p class="brand-byline">by <a href="${escapeHtml(consultingUrl('home'))}" target="_blank" rel="noopener noreferrer">LCF Consulting</a></p></section>
    ${dataStatus}
    <section class="public-section"><div class="section-heading"><div><p class="eyebrow">EVIDÊNCIA PÚBLICA</p><h2>O que mudou nas fontes</h2><p>Detecções recentes vinculadas a snapshots; hash alterado não significa, por si só, mudança regulatória.</p></div><a class="text-link" href="/mudancas">Ver histórico completo →</a></div><div class="public-change-list">${changeMarkup}</div></section>
    <section class="public-section"><div class="section-heading"><div><p class="eyebrow">COBERTURA</p><h2>Órgãos e fontes oficiais</h2><p>Exibimos somente authorities e fontes persistidas no registro do sistema.</p></div><a class="text-link" href="/orgaos">Explorar órgãos →</a></div><div class="authority-grid">${authorityCards}</div></section>
    <section class="public-section"><div class="section-heading"><div><p class="eyebrow">MÉTODO</p><h2>Da fonte à evidência</h2><p>Cada etapa preserva rastreabilidade e distingue detecção técnica de interpretação regulatória.</p></div></div><ol class="process-flow"><li><span>01</span><strong>Fonte oficial</strong></li><li><span>02</span><strong>Captura</strong></li><li><span>03</span><strong>Snapshot</strong></li><li><span>04</span><strong>Comparação</strong></li><li><span>05</span><strong>Mudança</strong></li><li><span>06</span><strong>Análise</strong></li></ol></section>
    <section class="public-section"><div class="section-heading"><div><p class="eyebrow">STATUS DAS EVIDÊNCIAS</p><h2>Monitoramento verificável</h2></div></div><div class="public-metrics"><div><span>Fontes oficiais monitoradas</span><strong>${formatNumber(overview.sources_monitored)}</strong></div><div><span>Verificações · 30 dias</span><strong>${formatNumber(overview.verification_checks_30d)}</strong></div><div><span>Capturas verificadas</span><strong>${formatNumber(overview.verified_capture_sources)}</strong></div><div><span>Mudanças aguardando revisão</span><strong>${formatNumber(overview.pending_review)}</strong></div></div></section>
    ${serverConsultingCta('Sua organização precisa saber não apenas o que mudou, mas onde a mudança atinge processos, dados, sistemas e controles?', 'A LCF Consulting aplica inteligência regulatória ao contexto específico da organização: obrigações, processos, sistemas, datasets, pipelines e controles.', 'Solicitar análise de impacto', 'home')}
  </main>`;
  return {
    title: 'LCF RegTech — Regulatory Data Intelligence by LCF Consulting',
    description: 'Saiba o que mudou nas fontes regulatórias oficiais. Monitoramento, histórico de versões, snapshots e evidências para análise regulatória e técnica.',
    canonical: `${origin}/`, content: publicShell(content, '/', origin), type: 'website',
    structuredData: { '@context': 'https://schema.org', '@type': 'WebSite', name: 'LCF RegTech', alternateName: 'Regulatory Data Intelligence by LCF Consulting', url: `${origin}/`, publisher: { '@type': 'Organization', name: 'LCF Consulting', url: LCF_CONSULTING_SITE } },
  };
}

async function buildChangesPage(db, query, origin) {
  const result = await listPublicChanges(db, query);
  const authorities = await listPublicRegulators(db);
  const sources = await listPublicSources(db, new URLSearchParams());
  const detected = result.changes.filter((change) => change.public_category === 'DETECTED');
  const documented = result.changes.filter((change) => change.public_category === 'DOCUMENTED');
  const filters = `<form class="public-filters" method="get" action="/mudancas"><label>Órgão<select name="authority"><option value="">Todos os órgãos</option>${authorities.map((r) => `<option value="${escapeHtml(r.acronym)}" ${String(query.get('authority') || '').toLowerCase() === String(r.acronym).toLowerCase() ? 'selected' : ''}>${escapeHtml(r.acronym)} · ${escapeHtml(r.name)}</option>`).join('')}</select></label><label>Período<select name="period">${[['7d','7 dias'],['30d','30 dias'],['90d','90 dias'],['all','Todo o histórico']].map(([value,label]) => `<option value="${value}" ${(query.get('period') || '30d') === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label>Tipo de fonte<select name="source_type"><option value="">Todos os tipos</option>${[...new Set(sources.map((source) => source.source_type))].sort().map((type) => `<option value="${escapeHtml(type)}" ${(query.get('source_type') || '') === type ? 'selected' : ''}>${escapeHtml(type)}</option>`).join('')}</select></label><label>Registro<select name="kind"><option value="">Todos</option><option value="DETECTED" ${(query.get('kind') || '') === 'DETECTED' ? 'selected' : ''}>Detecção por snapshot</option><option value="DOCUMENTED" ${(query.get('kind') || '') === 'DOCUMENTED' ? 'selected' : ''}>Alteração documentada</option></select></label><label>Revisão<select name="review_required"><option value="">Todos</option><option value="true" ${query.get('review_required') === 'true' ? 'selected' : ''}>Revisão necessária</option><option value="false" ${query.get('review_required') === 'false' ? 'selected' : ''}>Sem revisão pendente</option></select></label><button class="public-button primary" type="submit">Aplicar filtros</button><a class="public-button" href="/mudancas">Limpar</a></form>`;
  const detectedMarkup = detected.length ? detected.map((change) => serverChangeCard(change, origin)).join('')
    : '<div class="public-empty"><strong>Nenhuma alteração detectada nas fontes monitoradas no período.</strong><p>Registros de alteração documentada são listados separadamente e não são apresentados como captura recente.</p></div>';
  const documentedMarkup = documented.length ? documented.map((change) => serverChangeCard(change, origin)).join('')
    : '<div class="public-empty"><strong>Nenhuma referência documental corresponde aos filtros.</strong></div>';
  const content = `<main class="public-main"><header class="public-page-head"><p class="eyebrow">LCF REGTECH · MUDANÇAS</p><h1>O que mudou nas fontes oficiais?</h1><p>Detecções de conteúdo são separadas de alterações documentadas em versões oficiais. Um SOURCE_CHANGED significa que o conteúdo da fonte mudou — não que uma regra regulatória foi alterada.</p></header>${filters}<section class="public-section"><div class="section-heading"><div><p class="eyebrow">CAPTURA COMPARÁVEL</p><h2>Mudanças detectadas</h2></div><span class="count-pill">${formatNumber(detected.length)} registro(s)</span></div><div class="public-change-list">${detectedMarkup}</div></section><section class="public-section"><div class="section-heading"><div><p class="eyebrow">REFERÊNCIAS HISTÓRICAS</p><h2>Alterações documentadas em fontes oficiais</h2><p>Registros citados no catálogo, sem snapshots anterior e atual armazenados por esta instalação.</p></div><span class="count-pill">${formatNumber(documented.length)} registro(s)</span></div><div class="public-change-list">${documentedMarkup}</div></section>${serverConsultingCta('Essa mudança pode afetar sua operação?', 'A LCF transforma mudanças regulatórias em análise sobre processos, dados, sistemas e controles da sua organização.', 'Solicitar análise de impacto', 'changes')}</main>`;
  return {
    title: 'O que mudou nas fontes oficiais | LCF RegTech',
    description: 'Mudanças detectadas em fontes regulatórias oficiais, com histórico de versões, evidências e status de revisão claramente identificados.',
    canonical: `${origin}/mudancas`, content: publicShell(content, '/mudancas', origin), type: 'website',
  };
}

async function buildChangeDetailPage(db, id, origin) {
  const change = await publicChangeDetail(db, id);
  const sourceTitle = change.source?.source_title || change.summary;
  const authority = change.source?.authority || change.regulator?.acronym || change.source?.source_authority || 'Fonte oficial';
  const title = `${sourceTitle} — ${change.public_category === 'DETECTED' ? 'mudança detectada' : 'alteração documentada'} | ${authority} | LCF RegTech`;
  const description = String(change.summary || 'Registro de alteração relacionado a fonte oficial.').slice(0, 300);
  const content = serverChangeDetailMarkup(change, origin);
  return {
    title, description, canonical: `${origin}/mudancas/${encodeURIComponent(id)}`,
    content: publicShell(content, '/mudancas', origin), type: 'article',
    structuredData: { '@context': 'https://schema.org', '@type': 'WebPage', name: title, description, url: `${origin}/mudancas/${encodeURIComponent(id)}`, dateModified: change.detected_at, isPartOf: { '@type': 'WebSite', name: 'LCF RegTech', url: `${origin}/` } },
  };
}

function publicChangeLevelLabel(change) {
  if (change.change_level === 'SOURCE_CHANGED') return 'SOURCE_CHANGED · CONTEÚDO DA FONTE';
  if (change.change_level === 'REGULATORY_CHANGE_CANDIDATE') return 'CANDIDATO · REVISÃO HUMANA NECESSÁRIA';
  if (change.change_level === 'REGULATORY_CHANGE_CONFIRMED') return 'MUDANÇA REGULATÓRIA CONFIRMADA';
  return 'REFERÊNCIA DOCUMENTAL';
}

function serverChangeCard(change, origin) {
  const sourceTitle = change.source?.source_title || change.summary || 'Documento oficial';
  const authority = change.source?.authority || change.regulator?.acronym || change.source?.source_authority || 'Órgão não identificado';
  const status = change.public_category === 'DOCUMENTED' ? 'ALTERAÇÃO DOCUMENTADA'
    : change.review_status === 'REVIEW_REQUIRED' ? 'REVISÃO NECESSÁRIA' : 'MUDANÇA DETECTADA';
  const message = change.public_category === 'DETECTED'
    ? 'O conteúdo da fonte oficial mudou. Isso não confirma, por si só, uma alteração regulatória.'
    : 'Referência registrada a partir do histórico/documento oficial; não representa captura de snapshots por esta instalação.';
  return `<article class="public-change-card"><div class="public-change-card-top"><div><span class="public-badge official">FONTE OFICIAL</span><span class="public-badge">${escapeHtml(authority)}</span><span class="public-badge ${change.change_level === 'SOURCE_CHANGED' || change.change_level === 'REGULATORY_CHANGE_CANDIDATE' ? 'warning' : 'neutral'}">${escapeHtml(publicChangeLevelLabel(change))}</span><h3><a href="/mudancas/${encodeURIComponent(change.id)}">${escapeHtml(sourceTitle)}</a></h3><p>${escapeHtml(change.change_type || 'ALTERAÇÃO DOCUMENTADA')} · ${escapeHtml(formatPublicDate(change.detected_at))}</p></div><span class="public-badge ${change.public_category === 'DETECTED' ? 'warning' : 'neutral'}">${status}</span></div><p class="change-summary">${escapeHtml(change.summary || message)}</p><p class="source-boundary">${escapeHtml(message)}</p>${change.source?.source_url ? `<a class="text-link" href="${escapeHtml(change.source.source_url)}" target="_blank" rel="noopener noreferrer">Abrir fonte oficial ↗</a>` : ''}<div class="public-card-actions"><a class="public-button compact" href="/mudancas/${encodeURIComponent(change.id)}">Ver evidências e detalhe</a></div></article>`;
}

function serverChangeDetailMarkup(change, origin) {
  const before = change.snapshots.previous;
  const current = change.snapshots.current;
  const hasCapturedPair = Boolean(before && current);
  const bodyText = (snapshot) => snapshot?.extracted_text
    ? `${String(snapshot.extracted_text).slice(0, 5000)}${snapshot.extracted_text_truncated ? '\n\n[Excerto limitado a 5.000 caracteres; use o link para baixar os bytes completos.]' : ''}`
    : '';
  const diff = change.text_diff?.available === false
    ? `<div class="public-notice">${escapeHtml(change.text_diff.reason)}</div>`
    : change.text_diff
      ? `<div class="diff-columns"><section><h3>Trechos removidos</h3><ul class="diff-list removed">${change.text_diff.removed.map((line) => `<li>${escapeHtml(line)}</li>`).join('') || '<li>Sem linhas removidas no diff lexical.</li>'}</ul></section><section><h3>Trechos adicionados</h3><ul class="diff-list added">${change.text_diff.added.map((line) => `<li>${escapeHtml(line)}</li>`).join('') || '<li>Sem linhas adicionadas no diff lexical.</li>'}</ul></section></div><p class="source-boundary">Comparação textual lexical. Não é interpretação jurídica nem conclusão automática de aplicabilidade.</p>`
      : `<div class="public-notice">${change.public_category === 'DETECTED' ? 'O documento mudou, mas o significado regulatório desta alteração ainda requer revisão.' : 'Esta instalação não possui snapshots anterior e atual capturados para este registro. A referência está vinculada à fonte oficial indicada.'}</div>`;
  const beforeAfter = hasCapturedPair && (bodyText(before) || bodyText(current))
    ? `<div class="diff-columns"><section class="text-version"><h3>ANTES · ${escapeHtml(formatPublicDate(before.collected_at))}</h3><pre>${escapeHtml(bodyText(before) || 'Texto não extraído pelo parser.')}</pre></section><section class="text-version"><h3>DEPOIS · ${escapeHtml(formatPublicDate(current.collected_at))}</h3><pre>${escapeHtml(bodyText(current) || 'Texto não extraído pelo parser.')}</pre></section></div>` : '';
  const snapshots = [
    ['Snapshot anterior', before], ['Snapshot atual', current],
  ].filter(([, row]) => row).map(([label, snapshot]) => `<div class="evidence-item"><strong>${label}</strong><span>Capturado ${escapeHtml(formatPublicDate(snapshot.collected_at))}</span><code>SHA-256 ${escapeHtml(snapshot.content_hash || 'NÃO DISPONÍVEL')}</code><span>${escapeHtml(snapshot.mime_type || 'MIME não disponível')} · ${snapshot.content_size == null ? 'Tamanho não disponível' : `${formatNumber(snapshot.content_size)} bytes`}</span><span>Parser ${escapeHtml(snapshot.parser || 'não informado')} · ${escapeHtml(snapshot.parse_status || 'status não informado')} · HTTP ${escapeHtml(String(snapshot.http_status ?? 'NÃO DISPONÍVEL'))}</span><span>Snapshot ${escapeHtml(snapshot.id)}</span><a href="/api/sources/${encodeURIComponent(snapshot.source_id)}/snapshots/${encodeURIComponent(snapshot.id)}/content">Baixar bytes capturados</a></div>`).join('');
  const impacts = change.impacts?.length ? `<ul class="impact-list">${change.impacts.map((impact) => `<li><strong>${escapeHtml(impact.impact_type)} · ${escapeHtml(impact.severity)}</strong><span>${escapeHtml(impact.description)}</span><small>${escapeHtml(impact.rationale)}</small></li>`).join('')}</ul><p class="source-boundary">${escapeHtml(change.impact_notice)}</p>` : '<div class="public-empty">Impacto específico ainda não classificado.</div>';
  const relatedObligations = change.related_obligations?.length ? `<ul>${change.related_obligations.map((item) => `<li><a href="/obrigacoes/${encodeURIComponent(item.id)}">${escapeHtml(item.regulator_acronym || '')} · ${escapeHtml(item.code)} — ${escapeHtml(item.title)}</a></li>`).join('')}</ul>` : '<p>Não há obrigação diretamente relacionada registrada no modelo de dados.</p>';
  const fields = change.fields?.length ? `<div class="table-wrap"><table><thead><tr><th>Campo catalogado</th><th>Tipo</th><th>Obrigatoriedade</th><th>Referência</th></tr></thead><tbody>${change.fields.map((field) => `<tr><td>${escapeHtml(field.path)} · ${escapeHtml(field.name)}</td><td>${escapeHtml(field.data_type)}</td><td>${field.required == null ? 'Não classificada' : field.required ? 'Obrigatório' : 'Opcional'}</td><td>${escapeHtml(field.source_reference)}</td></tr>`).join('')}</tbody></table></div><p class="source-boundary">Inventário limitado ao escopo catalogado: ${escapeHtml(change.schema?.field_inventory_scope || 'escopo não informado')}. Não representa schema completo se a cobertura estiver marcada como parcial.</p>` : '<p>Impacto específico ainda não classificado. Nenhum campo relacionado está catalogado para este registro.</p>';
  const source = change.source || {};
  const oldValue = change.old_value && change.public_category === 'DOCUMENTED' ? `<section><h3>Versão/registro anterior documentado</h3><pre class="evidence-pre">${escapeHtml(change.old_value)}</pre></section>` : '';
  const newValue = change.new_value && change.public_category === 'DOCUMENTED' ? `<section><h3>Versão/registro atual documentado</h3><pre class="evidence-pre">${escapeHtml(change.new_value)}</pre></section>` : '';
  return `<main class="public-main"><header class="public-page-head"><p class="eyebrow">${change.public_category === 'DETECTED' ? 'O QUE MUDOU · DETECÇÃO DE FONTE' : 'O QUE MUDOU · REFERÊNCIA DOCUMENTAL'}</p><h1>${escapeHtml(source.source_title || change.summary)}</h1><p>${escapeHtml(source.authority || source.source_authority || change.regulator?.name || 'Órgão não identificado')} · ${escapeHtml(formatPublicDate(change.detected_at))}</p><div class="change-detail-status"><span class="public-badge official">FONTE OFICIAL</span><span class="public-badge ${change.public_status === 'REVIEW_REQUIRED' ? 'warning' : 'neutral'}">${change.public_category === 'DOCUMENTED' ? 'ALTERAÇÃO DOCUMENTADA' : change.public_status === 'REVIEW_REQUIRED' ? 'REVISÃO NECESSÁRIA' : 'MUDANÇA DETECTADA'}</span><span class="public-badge ${change.change_level === 'SOURCE_CHANGED' || change.change_level === 'REGULATORY_CHANGE_CANDIDATE' ? 'warning' : 'neutral'}">${escapeHtml(publicChangeLevelLabel(change))}</span><span class="public-badge">${escapeHtml(change.change_type)}</span></div></header>
    <section class="public-section"><p class="eyebrow">RESUMO DO REGISTRO</p><p class="detail-lede">${escapeHtml(change.summary)}</p><p>${escapeHtml(change.public_category === 'DETECTED' ? 'SOURCE_CHANGED significa que o conteúdo da fonte oficial mudou. Essa detecção não confirma alteração de regra, obrigação ou aplicabilidade.' : 'Este registro se baseia em informação/histórico documentado na fonte oficial; não é uma detecção por snapshots capturados nesta instalação.')}</p>${change.diff_summary ? `<p class="source-boundary">${escapeHtml(change.diff_summary)}</p>` : ''}</section>
    <section class="public-section"><p class="eyebrow">ANTES E DEPOIS</p><h2>Comparação entre versões</h2>${beforeAfter}${diff}${oldValue}${newValue}</section>
    <section class="public-section"><p class="eyebrow">POSSÍVEL IMPACTO</p><h2>Informações relacionadas no modelo</h2><h3>Obrigações relacionadas</h3>${relatedObligations}<h3>Campos catalogados</h3>${fields}<h3>Triagem técnica registrada</h3>${impacts}</section>
    <section class="public-section"><p class="eyebrow">EVIDÊNCIA</p><h2>Proveniência da captura</h2><div class="evidence-item"><strong>${escapeHtml(source.source_title || change.source_reference || 'Fonte oficial')}</strong><span>Autoridade: ${escapeHtml(source.authority || source.source_authority || 'não informada')} · Tipo: ${escapeHtml(source.source_type || 'não informado')}</span><a href="${escapeHtml(source.source_url || '#')}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.source_url || 'URL oficial não disponível')} ↗</a><span>Referência: ${escapeHtml(change.source_reference || 'não disponível')}</span></div>${snapshots ? `<div class="evidence-grid">${snapshots}</div>` : '<div class="public-empty">Nenhum snapshot anterior/atual está vinculado a este registro. Hash de excerto, quando existir, não é hash dos bytes originais.</div>'}</section>
    ${serverConsultingCta('Essa mudança pode afetar sua operação?', 'A LCF transforma mudanças regulatórias em análise sobre processos, dados, sistemas e controles da sua organização.', 'Solicitar análise de impacto', `change-${change.id}`)}
  </main>`;
}

async function buildSourcesPage(db, query, origin) {
  const sources = await listPublicSources(db, query);
  const authorities = await listPublicRegulators(db);
  const authority = query.get('authority') || '';
  const types = [...new Set(sources.map((source) => source.source_type))].sort();
  const content = `<main class="public-main"><header class="public-page-head"><p class="eyebrow">LCF REGTECH · FONTES OFICIAIS</p><h1>Fontes regulatórias oficiais</h1><p>Catálogo de URLs oficiais e seus estados reais de verificação. Fonte cadastrada não significa que já exista captura bruta.</p></header><form class="public-filters" method="get" action="/fontes"><label>Órgão<select name="authority"><option value="">Todos os órgãos</option>${authorities.map((r) => `<option value="${escapeHtml(r.acronym)}" ${authority.toLowerCase() === r.acronym.toLowerCase() ? 'selected' : ''}>${escapeHtml(r.acronym)} · ${escapeHtml(r.name)}</option>`).join('')}</select></label><label>Tipo de fonte<select name="source_type"><option value="">Todos os tipos</option>${types.map((type) => `<option value="${escapeHtml(type)}" ${(query.get('source_type') || '') === type ? 'selected' : ''}>${escapeHtml(type)}</option>`).join('')}</select></label><button class="public-button primary" type="submit">Filtrar</button><a class="public-button" href="/fontes">Limpar</a></form><div class="public-source-list">${sources.length ? sources.map((source) => `<article class="public-source-card"><div class="public-change-card-top"><div><span class="public-badge official">FONTE OFICIAL</span><span class="public-badge">${escapeHtml(source.regulator_acronym)}</span><h2><a href="/fontes/${encodeURIComponent(source.id)}">${escapeHtml(source.source_title)}</a></h2><p>${escapeHtml(source.source_type)} · ${escapeHtml(source.authority)}</p></div>${source.content_hash_scope === 'RAW_RESPONSE_SHA256' && source.raw_snapshot_count ? '<span class="public-badge success">CAPTURA VERIFICADA</span>' : '<span class="public-badge neutral">SEM SNAPSHOT BRUTO</span>'}</div><p class="source-url-text"><a href="${escapeHtml(source.source_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(source.source_url)} ↗</a></p><p>Última verificação: ${escapeHtml(source.last_checked_at ? formatPublicDate(source.last_checked_at) : 'não registrada')} · ${formatNumber(source.raw_snapshot_count)} snapshot(s)</p></article>`).join('') : '<div class="public-empty"><strong>Nenhuma fonte oficial corresponde aos filtros.</strong></div>'}</div>${serverConsultingCta('Precisa monitorar fontes específicas da sua organização?', 'A LCF Consulting estrutura monitoramento, governança e trilhas de evidência de acordo com as fontes e processos relevantes para cada organização.', 'Falar com a LCF Consulting', 'sources')}</main>`;
  return { title: 'Fontes regulatórias oficiais monitoradas | LCF RegTech', description: 'Explore as fontes oficiais monitoradas pelo LCF RegTech, seus links primários, verificações e snapshots reais.', canonical: `${origin}/fontes`, content: publicShell(content, '/fontes', origin), type: 'website' };
}

async function buildSourceDetailPage(db, id, origin) {
  const detail = await publicSourceDetail(db, id);
  const source = detail.source;
  const content = `<main class="public-main"><header class="public-page-head"><p class="eyebrow">FONTE OFICIAL · ${escapeHtml(source.regulator_acronym || source.authority)}</p><h1>${escapeHtml(source.source_title)}</h1><p>${escapeHtml(source.source_authority)} · ${escapeHtml(source.source_type)}</p><a class="public-button" href="${escapeHtml(source.source_url)}" target="_blank" rel="noopener noreferrer">Abrir fonte oficial ↗</a></header><section class="public-section"><h2>Status de captura</h2><div class="evidence-grid"><div class="evidence-item"><strong>${source.content_hash_scope === 'RAW_RESPONSE_SHA256' && detail.snapshots.length ? 'CAPTURA VERIFICADA' : 'SEM SNAPSHOT BRUTO'}</strong><span>${escapeHtml(detail.hash_notice)}</span><span>Última verificação ${escapeHtml(source.last_checked_at ? formatPublicDate(source.last_checked_at) : 'não registrada')}</span><span>HTTP ${escapeHtml(String(source.last_http_status ?? 'não disponível'))}</span></div></div></section><section class="public-section"><h2>Histórico imutável de snapshots</h2>${detail.snapshots.length ? `<div class="evidence-grid">${detail.snapshots.map((snapshot) => `<article class="evidence-item"><strong>${escapeHtml(formatPublicDate(snapshot.collected_at))}</strong><code>SHA-256 ${escapeHtml(snapshot.content_hash)}</code><span>${escapeHtml(snapshot.mime_type || 'MIME desconhecido')} · ${formatNumber(snapshot.content_size)} bytes · HTTP ${escapeHtml(String(snapshot.http_status ?? '—'))}</span><span>Parser ${escapeHtml(snapshot.parser || 'não informado')} · ${escapeHtml(snapshot.parse_status)}</span><a href="/api/sources/${encodeURIComponent(source.id)}/snapshots/${encodeURIComponent(snapshot.id)}/content">Baixar snapshot</a></article>`).join('')}</div>` : '<div class="public-empty">Nenhum snapshot bruto foi capturado para esta fonte. Não existe hash de bytes para apresentar.</div>'}</section><section class="public-section"><h2>Verificações da fonte</h2>${detail.checks.length ? `<div class="table-wrap"><table><thead><tr><th>Data</th><th>HTTP</th><th>Resultado</th><th>SHA-256</th></tr></thead><tbody>${detail.checks.map((check) => `<tr><td>${escapeHtml(formatPublicDate(check.checked_at))}</td><td>${escapeHtml(String(check.http_status ?? '—'))}</td><td>${escapeHtml(check.outcome)}</td><td>${escapeHtml(check.content_hash || '—')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="public-empty">Nenhuma verificação está registrada para esta fonte.</div>'}</section><section class="public-section"><h2>Mudanças vinculadas</h2>${detail.changes.length ? detail.changes.map((change) => { const level = publicChangeLevelLabel(change); const status = change.public_category === 'DOCUMENTED' ? 'ALTERAÇÃO DOCUMENTADA' : change.review_status === 'REVIEW_REQUIRED' ? 'REVISÃO NECESSÁRIA' : 'MUDANÇA DETECTADA'; return `<article class="public-source-card"><span class="public-badge ${change.public_category === 'DETECTED' ? 'warning' : 'neutral'}">${escapeHtml(level)}</span><span class="public-badge">${escapeHtml(status)}</span><p><a href="/mudancas/${encodeURIComponent(change.id)}">${escapeHtml(change.summary)} · ${escapeHtml(formatPublicDate(change.detected_at))}</a></p></article>`; }).join('') : '<p>Nenhuma mudança pública vinculada a esta fonte.</p>'}</section></main>`;
  return { title: `${source.source_title} | Fonte oficial | LCF RegTech`, description: `Fonte oficial ${source.authority || source.source_authority}: link primário, histórico de verificações e snapshots quando capturados.`, canonical: `${origin}/fontes/${encodeURIComponent(id)}`, content: publicShell(content, '/fontes', origin), robots: 'noindex,follow', type: 'article' };
}

async function buildRegulatorsPage(db, query, origin) {
  const regulators = await listPublicRegulators(db);
  const selected = query.get('regulator');
  if (selected) {
    const regulator = regulators.find((row) => row.id === selected || row.acronym.toLowerCase() === selected.toLowerCase());
    if (!regulator) throw new ApiError('Regulator not found.', 404, 'REGULATOR_NOT_FOUND');
    const obligations = await listPublicObligations(db, new URLSearchParams({ regulator: regulator.id }));
    const sources = await listPublicSources(db, new URLSearchParams({ authority: regulator.acronym }));
    const content = `<main class="public-main"><header class="public-page-head"><p class="eyebrow">ÓRGÃO MONITORADO · ${escapeHtml(regulator.acronym)}</p><h1>${escapeHtml(regulator.name)}</h1><p>${escapeHtml(regulator.sector)} · ${escapeHtml(regulator.jurisdiction)}</p><a href="${escapeHtml(regulator.website)}" target="_blank" rel="noopener noreferrer" class="text-link">Site oficial ↗</a></header><section class="public-section"><h2>Fontes oficiais</h2><div class="public-source-list">${sources.map((source) => `<article class="public-source-card"><span class="public-badge official">FONTE OFICIAL</span><h3><a href="/fontes/${encodeURIComponent(source.id)}">${escapeHtml(source.source_title)}</a></h3><p>${escapeHtml(source.source_type)} · ${source.raw_snapshot_count ? 'CAPTURA VERIFICADA' : 'sem snapshot bruto'}</p></article>`).join('') || '<div class="public-empty">Nenhuma fonte cadastrada para este órgão.</div>'}</div></section><section class="public-section"><h2>Obrigações catalogadas</h2><div class="public-source-list">${obligations.map((item) => `<article class="public-source-card"><h3><a href="/obrigacoes/${encodeURIComponent(item.id)}">${escapeHtml(item.code)} · ${escapeHtml(item.title)}</a></h3><p>${escapeHtml(item.category)} · ${escapeHtml(item.frequency)}</p></article>`).join('') || '<div class="public-empty">Nenhuma obrigação pública catalogada.</div>'}</div></section></main>`;
    return { title: `${regulator.acronym} — fontes e obrigações | LCF RegTech`, description: `Fontes oficiais e obrigações catalogadas para ${regulator.name}, vinculadas ao LCF RegTech.`, canonical: `${origin}/orgaos`, content: publicShell(content, '/orgaos', origin), robots: 'noindex,follow', type: 'article' };
  }
  const content = `<main class="public-main"><header class="public-page-head"><p class="eyebrow">LCF REGTECH · ÓRGÃOS</p><h1>Órgãos e autoridades regulatórias</h1><p>Cobertura demonstrada por fontes oficiais persistidas no registro; a quantidade de fontes não implica cobertura normativa completa.</p></header><div class="authority-grid">${regulators.length ? regulators.map((row) => `<article class="authority-card"><div class="authority-acronym">${escapeHtml(row.acronym)}</div><div><h2><a href="/orgaos?regulator=${encodeURIComponent(row.id)}">${escapeHtml(row.name)}</a></h2><p>${escapeHtml(row.sector)} · ${escapeHtml(row.jurisdiction)}</p><small>${formatNumber(row.monitored_source_count)} fonte(s) monitorada(s) · ${formatNumber(row.obligation_count)} obrigação(ões) catalogada(s)</small><p><a href="${escapeHtml(row.website)}" target="_blank" rel="noopener noreferrer">Site oficial ↗</a></p></div></article>`).join('') : '<div class="public-empty">Nenhum órgão está cadastrado nesta base.</div>'}</div></main>`;
  return { title: 'Órgãos regulatórios monitorados | LCF RegTech', description: 'Autoridades regulatórias e fontes oficiais presentes no registro do LCF RegTech.', canonical: `${origin}/orgaos`, content: publicShell(content, '/orgaos', origin), type: 'website' };
}

async function buildObligationsPage(db, query, origin) {
  const obligations = await listPublicObligations(db, query);
  const regulators = await listPublicRegulators(db);
  const content = `<main class="public-main"><header class="public-page-head"><p class="eyebrow">LCF REGTECH · OBRIGAÇÕES</p><h1>Obrigações regulatórias catalogadas</h1><p>Registros públicos vinculados a fontes oficiais. A listagem não determina aplicabilidade a uma organização específica.</p></header><form class="public-filters" method="get" action="/obrigacoes"><label>Órgão<select name="regulator"><option value="">Todos os órgãos</option>${regulators.map((row) => `<option value="${escapeHtml(row.id)}" ${query.get('regulator') === row.id ? 'selected' : ''}>${escapeHtml(row.acronym)} · ${escapeHtml(row.name)}</option>`).join('')}</select></label><label>Pesquisar<input type="search" name="q" value="${escapeHtml(query.get('q') || '')}" placeholder="Código, obrigação ou tema"></label><button class="public-button primary" type="submit">Filtrar</button><a class="public-button" href="/obrigacoes">Limpar</a></form><div class="public-source-list">${obligations.length ? obligations.map((row) => `<article class="public-source-card"><span class="public-badge official">${escapeHtml(row.regulator_acronym)} · SOURCE-LINKED</span><h2><a href="/obrigacoes/${encodeURIComponent(row.id)}">${escapeHtml(row.code)} · ${escapeHtml(row.title)}</a></h2><p>${escapeHtml(row.description)}</p><div class="fact-row"><span>${escapeHtml(row.category)}</span><span>${escapeHtml(row.frequency || 'Frequência não informada')}</span><span>${row.next_official_deadline ? `Próximo prazo oficial ${escapeHtml(row.next_official_deadline)}` : 'Prazo oficial não disponível'}</span></div><a class="text-link" href="/obrigacoes/${encodeURIComponent(row.id)}">Ver fonte, requisitos e evidências →</a></article>`).join('') : '<div class="public-empty">Nenhuma obrigação pública corresponde aos filtros.</div>'}</div>${serverConsultingCta('Precisa entender quais obrigações alcançam a sua organização?', 'A aplicabilidade depende do contexto da empresa. A LCF Consulting estrutura a ligação entre norma, obrigação, processo, dados, sistemas e controles.', 'Falar com a LCF Consulting', 'obligations')}</main>`;
  return { title: 'Obrigações regulatórias | LCF RegTech', description: 'Consulte obrigações regulatórias catalogadas e suas fontes oficiais, prazos e escopo documentado.', canonical: `${origin}/obrigacoes`, content: publicShell(content, '/obrigacoes', origin), type: 'website' };
}

async function buildObligationDetailPage(db, id, origin) {
  const detail = await publicObligationDetail(db, id);
  const obligation = detail.obligation;
  const sourceMarkup = detail.sources.map((source) => `<article class="evidence-item"><strong>${escapeHtml(source.source_title)}</strong><span>${escapeHtml(source.source_authority)} · ${escapeHtml(source.source_type)} · ${escapeHtml(source.version || 'versão não informada')}</span><a href="${escapeHtml(source.source_url)}" target="_blank" rel="noopener noreferrer">Abrir fonte oficial ↗</a><span>${source.raw_snapshot_count ? 'CAPTURA VERIFICADA' : `Sem snapshot bruto · ${escapeHtml(source.content_hash_scope || 'hash de bytes não disponível')}`}</span></article>`).join('');
  const requirements = detail.requirements.map((row) => `<article class="public-source-card"><h3>${escapeHtml(row.requirement_type)}</h3><p>${escapeHtml(row.description)}</p><p class="source-boundary">${escapeHtml(row.source_reference)}</p>${row.source_url ? `<a href="${escapeHtml(row.source_url)}" target="_blank" rel="noopener noreferrer">Ver fonte oficial ↗</a>` : ''}</article>`).join('');
  const documents = detail.documents.map((doc) => `<article class="public-source-card"><h3>${escapeHtml(doc.code)} · ${escapeHtml(doc.name)}</h3><p>${escapeHtml(doc.document_type)} · ${escapeHtml(doc.output_format || 'formato não informado')} · ${escapeHtml(doc.frequency || 'frequência não informada')}</p>${doc.schema_version_id ? `<a href="/schemas/${encodeURIComponent(doc.schema_version_id)}">Schema ${escapeHtml(doc.version || '')} · ${escapeHtml(doc.parse_status || '')} →</a>` : '<p>Schema técnico não catalogado.</p>'}</article>`).join('');
  const fields = detail.fields.map((field) => `<tr><td>${escapeHtml(field.path)}</td><td>${escapeHtml(field.name)}</td><td>${escapeHtml(field.data_type)}</td><td>${field.required == null ? 'Não classificado' : field.required ? 'Obrigatório' : 'Opcional'}</td><td>${escapeHtml(field.source_reference)}</td></tr>`).join('');
  const deadlines = detail.deadlines.map((deadline) => `<article class="evidence-item"><strong>${escapeHtml(deadline.reference_period)} · ${escapeHtml(formatPublicDate(deadline.due_date))}</strong><span>${escapeHtml(deadline.calculation_basis || 'Base do prazo não informada')}</span>${deadline.source_url ? `<a href="${escapeHtml(deadline.source_url)}" target="_blank" rel="noopener noreferrer">Fonte oficial do prazo ↗</a>` : '<span>Fonte oficial não disponível</span>'}</article>`).join('');
  const content = `<main class="public-main"><header class="public-page-head"><p class="eyebrow">${escapeHtml(obligation.regulator_acronym)} · OBRIGAÇÃO SOURCE-LINKED</p><h1>${escapeHtml(obligation.title)}</h1><p>${escapeHtml(obligation.code)} · ${escapeHtml(obligation.regulation_number)} · ${escapeHtml(obligation.regulation_title)}</p>${obligation.regulation_source_url ? `<a href="${escapeHtml(obligation.regulation_source_url)}" target="_blank" rel="noopener noreferrer">Abrir fonte normativa ↗</a>` : ''}</header><div class="fact-grid"><div><span>Órgão</span><strong>${escapeHtml(obligation.regulator_name)} (${escapeHtml(obligation.regulator_acronym)})</strong></div><div><span>Categoria</span><strong>${escapeHtml(obligation.category)}</strong></div><div><span>Periodicidade</span><strong>${escapeHtml(obligation.frequency || 'Não informada')}</strong></div><div><span>Entidades afetadas</span><strong>${escapeHtml(obligation.affected_entities || 'Não classificado')}</strong></div><div><span>Formato declarado</span><strong>${escapeHtml(obligation.output_format || 'Não informado')}</strong></div><div><span>Vigência</span><strong>${escapeHtml(obligation.effective_date || 'Data não informada')}</strong></div></div><section class="public-section"><h2>Descrição documentada</h2><p class="detail-lede">${escapeHtml(obligation.description)}</p><p class="source-boundary">Esta ficha organiza referências existentes. Não decide a aplicabilidade jurídica da obrigação à sua organização.</p></section><section class="public-section"><h2>Requisitos estruturados</h2><div class="public-source-list">${requirements || '<div class="public-empty">Nenhum requisito estruturado está vinculado.</div>'}</div></section><section class="public-section"><h2>Documentos e schemas catalogados</h2><div class="public-source-list">${documents || '<div class="public-empty">Nenhum documento vinculado.</div>'}</div>${fields.length ? `<div class="table-wrap"><table><thead><tr><th>Campo</th><th>Nome</th><th>Tipo</th><th>Obrigatoriedade</th><th>Referência</th></tr></thead><tbody>${fields}</tbody></table></div><p class="source-boundary">${formatNumber(detail.fields.length)} campo(s) catalogado(s); inventário pode ser parcial. Consulte sempre o documento oficial.</p>` : '<p>Impacto específico ainda não classificado. Não há campos catalogados para esta obrigação.</p>'}</section><section class="public-section"><h2>Prazos oficiais publicados</h2><div class="evidence-grid">${deadlines || '<div class="public-empty">Nenhum prazo oficial comprovado está registrado.</div>'}</div></section><section class="public-section"><h2>Fontes oficiais e evidências</h2><div class="evidence-grid">${sourceMarkup || '<div class="public-empty">Nenhuma fonte oficial vinculada a esta obrigação.</div>'}</div></section>${serverConsultingCta('Como esta obrigação se conecta à sua operação?', 'A LCF Consulting mapeia aplicabilidade, processo, sistema, dataset, pipeline, controle, evidência e plano de ação no contexto da organização.', 'Solicitar análise de impacto', `obligation-${obligation.id}`)}</main>`;
  return { title: `${obligation.code} — ${obligation.title} | ${obligation.regulator_acronym} | LCF RegTech`, description: String(obligation.description || '').slice(0, 300), canonical: `${origin}/obrigacoes/${encodeURIComponent(id)}`, content: publicShell(content, '/obrigacoes', origin), type: 'article', structuredData: { '@context': 'https://schema.org', '@type': 'WebPage', name: `${obligation.code} — ${obligation.title}`, description: String(obligation.description || '').slice(0, 300), url: `${origin}/obrigacoes/${encodeURIComponent(id)}`, isPartOf: { '@type': 'WebSite', name: 'LCF RegTech', url: `${origin}/` } } };
}

async function buildSchemasPage(db, query, origin) {
  const schemas = await listPublicSchemas(db, query);
  const content = `<main class="public-main"><header class="public-page-head"><p class="eyebrow">LCF REGTECH · SCHEMAS</p><h1>Schemas e layouts catalogados</h1><p>Versões e campos organizados conforme o escopo de captura e catalogação disponível. Ausência de campo não significa que o documento oficial não o contenha.</p></header><form class="public-filters" method="get" action="/schemas"><label>Pesquisar<input type="search" name="q" value="${escapeHtml(query.get('q') || '')}" placeholder="Documento, órgão, versão"></label><button class="public-button primary" type="submit">Pesquisar</button><a class="public-button" href="/schemas">Limpar</a></form><div class="public-source-list">${schemas.length ? schemas.map((schema) => `<article class="public-source-card"><span class="public-badge official">${escapeHtml(schema.regulator_acronym)} · SOURCE-LINKED</span><h2><a href="/schemas/${encodeURIComponent(schema.id)}">${escapeHtml(schema.document_code)} · ${escapeHtml(schema.document_name)}</a></h2><div class="fact-row"><span>Versão ${escapeHtml(schema.version)}</span><span>${escapeHtml(schema.schema_type)}</span><span>${schema.catalogued_fields == null ? 'Campos não informados' : `${formatNumber(schema.catalogued_fields)} campos catalogados`}</span><span>${escapeHtml(schema.parse_status)} · ${escapeHtml(schema.field_inventory_scope)}</span></div><p>${schema.source_url ? `<a href="${escapeHtml(schema.source_url)}" target="_blank" rel="noopener noreferrer">Fonte oficial ↗</a>` : 'Fonte oficial não vinculada'}</p></article>`).join('') : '<div class="public-empty">Nenhum schema público corresponde aos filtros.</div>'}</div></main>`;
  return { title: 'Schemas e layouts regulatórios | LCF RegTech', description: 'Consulte schemas, layouts, versões, campos catalogados e limites de cobertura com links para as fontes oficiais.', canonical: `${origin}/schemas`, content: publicShell(content, '/schemas', origin), type: 'website' };
}

async function buildSchemaDetailPage(db, id, origin) {
  const detail = await publicSchemaDetail(db, id);
  const schema = detail.schema;
  const fields = detail.fields.map((field) => `<tr><td>${escapeHtml(field.path)}</td><td>${escapeHtml(field.name)}</td><td>${escapeHtml(field.data_type)}</td><td>${field.required == null ? 'Não classificado' : field.required ? 'Obrigatório' : 'Opcional'}</td><td>${escapeHtml(field.source_reference)}</td></tr>`).join('');
  const content = `<main class="public-main"><header class="public-page-head"><p class="eyebrow">${escapeHtml(schema.regulator_acronym)} · SCHEMA SOURCE-LINKED</p><h1>${escapeHtml(schema.document_code)} · ${escapeHtml(schema.document_name)}</h1><p>Versão ${escapeHtml(schema.version)} · ${escapeHtml(schema.schema_type)} · ${escapeHtml(schema.parse_status)}</p>${schema.source_url ? `<a href="${escapeHtml(schema.source_url)}" target="_blank" rel="noopener noreferrer">Abrir documento oficial ↗</a>` : ''}</header><section class="public-section"><h2>Escopo da catalogação</h2><div class="public-notice">${escapeHtml(schema.field_inventory_scope)} · ${schema.fields_count == null ? 'Quantidade declarada de campos não disponível' : `${formatNumber(schema.fields_count)} campos declarados`} · ${formatNumber(detail.fields.length)} campos catalogados. O catálogo não afirma cobertura integral além deste escopo.</div></section><section class="public-section"><h2>Campos catalogados</h2>${fields ? `<div class="table-wrap"><table><thead><tr><th>Caminho</th><th>Nome</th><th>Tipo</th><th>Obrigatoriedade</th><th>Referência</th></tr></thead><tbody>${fields}</tbody></table></div>` : '<div class="public-empty">Nenhum campo estruturado foi capturado. Não foi inventado um schema.</div>'}</section><section class="public-section"><h2>Histórico de mudanças relacionadas</h2>${detail.changes.length ? detail.changes.map((change) => `<p><a href="/mudancas/${encodeURIComponent(change.id)}">${escapeHtml(change.summary)}</a></p>`).join('') : '<p>Nenhum registro de mudança ligado a esta versão.</p>'}</section></main>`;
  return { title: `${schema.document_code} ${schema.version} — schema | ${schema.regulator_acronym} | LCF RegTech`, description: `${schema.document_name}, versão ${schema.version}. Escopo de campos: ${schema.field_inventory_scope}. Consulte a fonte oficial.`, canonical: `${origin}/schemas/${encodeURIComponent(id)}`, content: publicShell(content, '/schemas', origin), type: 'article' };
}

async function buildDeadlinesPage(db, query, origin) {
  const deadlines = await listPublicDeadlines(db, query);
  const content = `<main class="public-main"><header class="public-page-head"><p class="eyebrow">LCF REGTECH · PRAZOS OFICIAIS</p><h1>Prazos regulatórios publicados</h1><p>Somente registros oficiais com base identificada. Datas internas de planejamento não são exibidas nesta área pública.</p></header><div class="public-source-list">${deadlines.length ? deadlines.map((item) => `<article class="public-source-card"><span class="public-badge official">PRAZO OFICIAL</span><h2>${escapeHtml(item.regulator_acronym)} · ${escapeHtml(item.obligation_code)} · ${escapeHtml(item.obligation_title)}</h2><div class="fact-row"><span>Período ${escapeHtml(item.reference_period)}</span><span>Vencimento ${escapeHtml(item.due_date)}</span><span>Status ${escapeHtml(item.status)}</span></div><p>${escapeHtml(item.calculation_basis || 'Base de cálculo não informada')}</p>${item.source_url ? `<a href="${escapeHtml(item.source_url)}" target="_blank" rel="noopener noreferrer">Ver fonte oficial do prazo ↗</a>` : '<p>Fonte oficial não disponível.</p>'}<p><a href="/obrigacoes/${encodeURIComponent(item.obligation_id)}">Consultar obrigação relacionada →</a></p></article>`).join('') : '<div class="public-empty"><strong>Nenhum prazo oficial comprovado está disponível.</strong><p>Nenhuma data é inferida para preencher a página.</p></div>'}</div></main>`;
  return { title: 'Prazos regulatórios oficiais | LCF RegTech', description: 'Prazos publicados por fontes oficiais, com período, obrigação relacionada e evidência da fonte.', canonical: `${origin}/prazos`, content: publicShell(content, '/prazos', origin), type: 'website' };
}

function buildAboutPage(origin) {
  const content = `<main class="public-main"><header class="public-page-head"><p class="eyebrow">LCF REGTECH · SOBRE</p><h1>Regulatory Data Intelligence</h1><p>O LCF RegTech monitora fontes regulatórias oficiais, preserva versões, detecta alterações de conteúdo e organiza evidências para análise regulatória e técnica.</p><p class="brand-byline">Uma iniciativa tecnológica pública da <a href="${escapeHtml(consultingUrl('about'))}" target="_blank" rel="noopener noreferrer">LCF Consulting</a>.</p></header><section class="public-section"><h2>O fluxo de inteligência pública</h2><ol class="process-flow"><li><span>01</span><strong>Fonte oficial</strong></li><li><span>02</span><strong>Captura</strong></li><li><span>03</span><strong>Snapshot imutável</strong></li><li><span>04</span><strong>Comparação</strong></li><li><span>05</span><strong>Mudança detectada</strong></li><li><span>06</span><strong>Análise humana</strong></li><li><span>07</span><strong>Impacto possível</strong></li></ol></section><section class="public-section"><h2>Do sinal público ao contexto da organização</h2><p>A parte pública entrega mudanças, histórico, links oficiais, capturas, hashes, diffs básicos e o catálogo já sustentado por fontes. Ela não afirma qual sistema ou processo de uma empresa específica será afetado.</p><div class="consulting-flow"><span>Mudança regulatória</span><span>Obrigação da empresa</span><span>Processo</span><span>Sistema</span><span>Dataset</span><span>Pipeline</span><span>Controle</span><span>Evidência</span><span>Plano de ação</span></div></section><section class="public-section"><h2>Limites de interpretação</h2><ul class="boundary-list"><li>O LCF RegTech não é software oficial de regulador nem canal de filing.</li><li>Uma mudança de bytes na fonte não é automaticamente uma mudança de regra regulatória.</li><li>Extrações automáticas permanecem candidatas e exigem revisão adequada.</li><li>O conteúdo não substitui parecer jurídico nem decisão de aplicabilidade.</li></ul></section>${serverConsultingCta('Precisa levar essa inteligência para o ambiente da sua organização?', 'A LCF Consulting desenvolve projetos customizados de inteligência regulatória aplicados a obrigações, processos, dados, sistemas, pipelines, controles e evidências.', 'Falar com a LCF Consulting', 'about')}</main>`;
  return { title: 'Sobre o LCF RegTech | Regulatory Data Intelligence', description: 'Conheça o LCF RegTech, uma iniciativa pública de inteligência regulatória da LCF Consulting: fontes oficiais, snapshots, comparação e evidências.', canonical: `${origin}/sobre`, content: publicShell(content, '/sobre', origin), type: 'website' };
}

function publicShell(content, activePath, origin) {
  const links = [['/','Visão geral'],['/mudancas','Mudanças'],['/fontes','Fontes oficiais'],['/orgaos','Órgãos'],['/obrigacoes','Obrigações'],['/schemas','Schemas'],['/prazos','Prazos'],['/sobre','Sobre']];
  return `<div class="public-shell"><header class="public-header"><a class="public-brand" href="/" aria-label="LCF RegTech — visão geral"><span class="brand-mark">LCF</span><span><strong>LCF RegTech</strong><small>Regulatory Data Intelligence</small></span></a><nav class="public-nav" aria-label="Navegação principal">${links.map(([href,label]) => `<a class="public-nav-link ${activePath === href ? 'active' : ''}" href="${href}" ${activePath === href ? 'aria-current="page"' : ''}>${label}</a>`).join('')}</nav><a class="header-consulting" href="${escapeHtml(consultingUrl('header'))}" target="_blank" rel="noopener noreferrer">by LCF Consulting ↗</a></header>${content}<footer class="public-footer"><div><a class="footer-brand" href="/">LCF RegTech</a><span>Regulatory Data Intelligence · by LCF Consulting</span><p>Uma iniciativa de inteligência regulatória da LCF Consulting.</p></div><div class="footer-links"><a href="/sobre">Sobre o projeto</a><a href="${escapeHtml(consultingUrl('footer'))}" target="_blank" rel="noopener noreferrer">LCF Consulting ↗</a><a href="/#/admin">Admin / Operations</a></div><p class="legal-note">Conteúdo informativo, vinculado às fontes citadas. Não é filing oficial, parecer jurídico ou decisão automática de aplicabilidade.</p></footer></div>`;
}

function publicDocument({ title, description, canonical, origin, content, type = 'website', robots = 'index,follow', structuredData = null }) {
  const jsonLd = structuredData ? `<script type="application/ld+json">${JSON.stringify(structuredData).replace(/</g, '\\u003c')}</script>` : '';
  const escapedTitle = escapeHtml(title || 'LCF RegTech — Regulatory Data Intelligence by LCF Consulting');
  const escapedDescription = escapeHtml(description || 'Regulatory Data Intelligence by LCF Consulting.');
  const canonicalUrl = escapeHtml(canonical || `${origin}/`);
  const ogType = type === 'article' ? 'article' : 'website';
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#101d31"><meta name="description" content="${escapedDescription}"><meta name="robots" content="${escapeHtml(robots)}"><title>${escapedTitle}</title><link rel="canonical" href="${canonicalUrl}"><meta property="og:type" content="${ogType}"><meta property="og:site_name" content="LCF RegTech"><meta property="og:title" content="${escapedTitle}"><meta property="og:description" content="${escapedDescription}"><meta property="og:url" content="${canonicalUrl}"><meta name="twitter:card" content="summary"><link rel="stylesheet" href="/styles.css"><script type="module" src="/app.js"></script>${jsonLd}</head><body><div id="app">${content}</div></body></html>`;
}

function serverConsultingCta(title, body, button, content = '') {
  const link = new URL(LCF_CONSULTING_SITE);
  link.searchParams.set('utm_source', 'regtech'); link.searchParams.set('utm_medium', 'product');
  link.searchParams.set('utm_campaign', 'lcf_regtech');
  if (content) link.searchParams.set('utm_content', content);
  return `<section class="consulting-cta"><div><p class="eyebrow">LCF CONSULTING · PROJETOS CUSTOMIZADOS</p><h2>${escapeHtml(title)}</h2><p>${escapeHtml(body)}</p></div><a class="public-button primary" href="${escapeHtml(link.toString())}" target="_blank" rel="noopener noreferrer">${escapeHtml(button)} ↗</a></section>`;
}

function consultingUrl(content) {
  const link = new URL(LCF_CONSULTING_SITE);
  link.searchParams.set('utm_source', 'regtech'); link.searchParams.set('utm_medium', 'product');
  link.searchParams.set('utm_campaign', 'lcf_regtech');
  if (content) link.searchParams.set('utm_content', content);
  return link.toString();
}

function formatPublicDate(value) {
  if (!value) return 'Data não disponível';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return escapeHtml(String(value));
  try { return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(date) + ' UTC'; }
  catch { return date.toISOString(); }
}

function formatNumber(value) {
  return new Intl.NumberFormat('pt-BR').format(Number(value || 0));
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

async function buildSitemapXml(db, origin) {
  const entries = new Map();
  const today = new Date().toISOString().slice(0, 10);
  for (const path of ['/', '/mudancas', '/fontes', '/orgaos', '/obrigacoes', '/schemas', '/prazos', '/sobre']) entries.set(path, today);
  if (db) {
    for (const change of (await listPublicChanges(db, new URLSearchParams({ period: 'all' }))).changes) {
      entries.set(`/mudancas/${encodeURIComponent(change.id)}`, String(change.detected_at || today).slice(0, 10));
    }
    for (const obligation of await listPublicObligations(db, new URLSearchParams())) {
      if (Number(obligation.requirement_count) > 0 || Number(obligation.document_count) > 0) entries.set(`/obrigacoes/${encodeURIComponent(obligation.id)}`, today);
    }
    for (const schema of await listPublicSchemas(db, new URLSearchParams())) {
      if (schema.source_url && isOfficialSourceUrl(schema.source_url)) entries.set(`/schemas/${encodeURIComponent(schema.id)}`, today);
    }
  }
  const urls = [...entries].map(([path, lastmod]) => `<url><loc>${escapeXml(`${origin}${path}`)}</loc><lastmod>${escapeXml(lastmod)}</lastmod></url>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;
}

function escapeXml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char]);
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
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow' });
  res.end(JSON.stringify(data));
}

class ApiError extends Error {
  constructor(message, statusCode = 400, code = 'BAD_REQUEST') { super(message); this.statusCode = statusCode; this.code = code; }
}
export { ApiError, AuthError, SubmissionError };
