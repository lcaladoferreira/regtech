import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, closeDatabase } from '../src/db.js';
import { seedDatabase } from '../src/seed.js';
import { calculateImpacts, scoreObligationFootprint } from '../src/engines/impact-engine.js';
import { compareNormativeText, compareSchemas } from '../src/engines/schema-diff.js';
import { evaluateRule, runDqAgainstSeededData } from '../src/engines/dq-engine.js';
import { addBusinessDays, calculateDeadline } from '../src/engines/deadlines.js';
import { serializeWithAdapter, validateConfiguredPayload } from '../src/engines/submission-adapters.js';
import { applyMappingTransformation } from '../src/engines/mapping-engine.js';
import { isOfficialSourceUrl, runCollectSources, runParseSources } from '../src/engines/ingestion.js';
import { createStorage } from '../src/storage.js';
import { runDemoPipeline } from '../src/services/submission-service.js';
import { createAppServer } from '../src/server.js';

const instantSleep = async () => {};

async function memoryDb() {
  return openDatabase({ path: ':memory:' });
}

async function count(db, table) {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).n;
}

test('migration and seed create a generic multi-regulator inventory with explicit source scope', async () => {
  const db = await memoryDb();
  try {
    assert.equal(await count(db, 'regulators'), 6);
    assert.equal(await count(db, 'regulatory_obligations'), 11);
    assert.equal(await count(db, 'regulatory_documents'), 11);
    assert.equal(await count(db, 'schema_versions'), 5);
    assert.equal(await count(db, 'regulatory_fields'), 62);
    assert.equal(await count(db, 'regulatory_cases'), 6);
    assert.equal(await count(db, 'regulatory_source_snapshots'), 0, 'curated excerpts must not be misreported as raw source snapshots');
    assert.equal(await count(db, 'schema_migrations'), 3, 'sqlite migrations 001, 002 and the live-pipeline migration are tracked');
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM regulatory_sources WHERE collected_at IS NOT NULL').get()).n, 0, 'seeded excerpt verification is not recorded as a raw fetch time');
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM regulatory_sources WHERE excerpt_verified_at IS NOT NULL').get()).n, 13);
    assert.deepEqual(await db.prepare('PRAGMA foreign_key_check').all(), []);

    const structured = await db.prepare("SELECT sv.id,sv.fields_count,COUNT(f.id) AS actual_fields FROM schema_versions sv LEFT JOIN regulatory_fields f ON f.schema_version_id=sv.id WHERE sv.parse_status='CURATED_EXTRACT' GROUP BY sv.id").all();
    assert.equal(structured.length, 4);
    for (const schema of structured) assert.equal(schema.fields_count, schema.actual_fields, schema.id);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM schema_versions WHERE parse_status='UNSTRUCTURED' AND fields_count IS NULL").get()).n, 1);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM regulatory_sources WHERE content_hash_scope='CURATED_EXCERPT_SHA256'").get()).n, 13);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM demo_data WHERE is_demo=1').get()).n, 7);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM regulatory_deadlines WHERE deadline_type='OFFICIAL'").get()).n, 3);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM regulatory_deadlines WHERE deadline_type='INTERNAL'").get()).n, 0);

    const before = {
      regulators: await count(db, 'regulators'), obligations: await count(db, 'regulatory_obligations'),
      fields: await count(db, 'regulatory_fields'), sources: await count(db, 'regulatory_sources'),
    };
    await seedDatabase(db);
    assert.deepEqual({
      regulators: await count(db, 'regulators'), obligations: await count(db, 'regulatory_obligations'),
      fields: await count(db, 'regulatory_fields'), sources: await count(db, 'regulatory_sources'),
    }, before, 'seeding is idempotent');
  } finally {
    await closeDatabase(db);
  }
});

test('impact rules are deterministic, explainable, and distinct from obligation-footprint heuristic', () => {
  const first = calculateImpacts('NEW_REQUIRED_FIELD', { field: 'operation/value' });
  const second = calculateImpacts('NEW_REQUIRED_FIELD', { field: 'operation/value' });
  assert.deepEqual(first, second);
  assert.equal(first.level, 'CRITICAL');
  assert.match(first.rationale, /17\+/);
  assert.match(first.impacts[0].description, /operation\/value/);
  assert.equal(calculateImpacts('UNRECOGNIZED_CHANGE').level, 'UNASSESSED');

  const footprint = scoreObligationFootprint({ output_format: 'XML', frequency: 'DAILY' }, { fields: 6, mapped: 2 });
  assert.equal(footprint.level, 'MEDIUM');
  assert.match(footprint.rationale, /saída declarada/);
});

test('schema and normative comparisons return reviewable typed/lexical differences', () => {
  const changes = compareSchemas(
    [{ id: 'a', stable_id: 'customer-id', name: 'customerId', path: 'record/customerId', data_type: 'STRING', length: 8, required: 0, domain: ['A'] }],
    [{ id: 'b', stable_id: 'customer-id', name: 'customerId', path: 'record/customerId', data_type: 'STRING', length: 14, required: 1, domain: ['A', 'B'] }],
  );
  assert.deepEqual(changes.map((row) => row.change_type).sort(), ['ENUM_ADDED', 'LENGTH_CHANGED', 'REQUIRED_CHANGED']);

  const textDiff = compareNormativeText('O prazo será de cinco dias úteis.\nCampo opcional.', 'O prazo será de três dias úteis.\nCampo obrigatório.');
  assert.equal(textDiff.added.length, 2);
  assert.equal(textDiff.removed.length, 2);
  assert.ok(textDiff.cues.includes('deadline'));
  assert.ok(textDiff.cues.includes('business_rule'));
  assert.match(textDiff.note, /não substitui interpretação jurídica/);
});

test('DQ evaluator handles JSON decimals and Brazilian decimal formatting; seeded negative control fails visibly', async () => {
  assert.equal(evaluateRule('100315.45', 'RANGE', { min: 100000 }).status, 'PASS');
  assert.match(evaluateRule('100315.45', 'RANGE', { min: 100000 }).message, /100315\.45/);
  assert.equal(evaluateRule('1.234,56', 'RANGE', { min: 1234.56, max: 1234.56 }).status, 'PASS');
  assert.equal(evaluateRule('nope', 'RANGE', { min: 0 }).status, 'FAIL');

  const db = await memoryDb();
  try {
    const run = await runDqAgainstSeededData(db, { runId: 'test-dq-run', now: Date.UTC(2026, 9, 2) });
    assert.equal(run.status, 'COMPLETED_WITH_FAILURES');
    assert.equal(run.failed, 1);
    assert.ok(run.passed > 0);
    const failure = await db.prepare("SELECT dataset_row_key,actual_value FROM dq_run_results WHERE dq_run_id=? AND status='FAIL'").get(run.id);
    assert.equal(failure.dataset_row_key, 'negative-control-invalid-cnpj');
    assert.equal(failure.actual_value, '12AB34CDX');
  } finally {
    await closeDatabase(db);
  }
});

test('deadline helpers calculate business days without replacing published regulatory calendars', () => {
  assert.equal(addBusinessDays('2026-10-02', 3), '2026-10-07');
  const result = calculateDeadline({ startDate: '2026-10-02', rule: { kind: 'BUSINESS_DAYS_AFTER_EVENT', days: 3 } });
  assert.equal(result.dueDate, '2026-10-07');
  assert.match(result.basis, /validar com o calendário oficial publicado|calendário nacional fornecido/);
  assert.equal(calculateDeadline({ startDate: '2026-10-02', rule: { kind: 'UNKNOWN' } }).dueDate, null);
});

test('generic adapters serialize safely and configured validation remains explicit', () => {
  const xml = serializeWithAdapter('XML', { cnpj: '12AB34CD' }, { rootName: 'documento', rootAttributes: { cnpj: { path: 'cnpj' } } });
  assert.match(xml, /<documento cnpj="12AB34CD"><\/documento>/);
  const csv = serializeWithAdapter('CSV', [{ name: 'Alice, Example' }]);
  assert.match(csv, /"Alice, Example"/);
  assert.equal(serializeWithAdapter('JSON', { a: 1 }), '{\n  "a": 1\n}\n');
  assert.equal(applyMappingTransformation('123', 'LEFT_PAD(10)'), '0000000123');
  assert.equal(applyMappingTransformation('2026-10-02', 'DDMMYYYY'), '02102026');
  assert.equal(applyMappingTransformation('1.234,56', 'DECIMAL(2)'), '1234.56');
  assert.throws(() => applyMappingTransformation('x', 'RUN_CODE()'), /safe mapping allowlist/);
  assert.throws(() => serializeWithAdapter('DBF', {}), /not supported/);

  const validation = validateConfiguredPayload({ code: 'A1', amount: 12.5 }, {
    requiredPaths: ['code'], constraints: [{ path: 'code', type: 'string', length: 2, allowed: ['A1', 'B2'], required: true }],
  });
  assert.equal(validation.status, 'VALIDATED');
  assert.deepEqual(validation.errors, []);
});

test('source collector captures immutable bytes, hashes the raw response, and blocks unsafe redirects', async () => {
  assert.equal(isOfficialSourceUrl('https://www.bcb.gov.br/content/file.pdf'), true);
  assert.equal(isOfficialSourceUrl('https://www.in.gov.br/qualquer/coisa'), true);
  assert.equal(isOfficialSourceUrl('http://www.bcb.gov.br/file.pdf'), false);
  assert.equal(isOfficialSourceUrl('https://bcb.gov.br.evil.example/file.pdf'), false);
  assert.equal(isOfficialSourceUrl('https://bcb.gov.br:8443/file.pdf'), false);

  const storageDir = mkdtempSync(join(tmpdir(), 'lcf-storage-'));
  const storage = await createStorage({ env: { STORAGE_DIR: storageDir }, db: { dialect: 'sqlite' } });
  const db = await memoryDb();
  try {
    const sourceId = 'src-bcb-3040-layout';
    const fetcher = async (_url, options) => {
      assert.equal(options.redirect, 'manual');
      return new Response('official example text', { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    };
    const first = await runCollectSources(db, { sourceIds: [sourceId], fetcher, storage, sleep: instantSleep });
    assert.equal(first.status, 'SUCCEEDED');
    assert.equal(first.created, 1);
    const snapshot = await db.prepare('SELECT * FROM regulatory_source_snapshots WHERE source_id=?').get(sourceId);
    assert.equal(snapshot.http_status, 200);
    assert.equal(Buffer.from(snapshot.content).toString('utf8'), 'official example text');
    assert.equal(snapshot.content_hash.length, 64);
    assert.ok(snapshot.raw_storage_path.includes(snapshot.content_hash));
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM regulatory_changes WHERE change_level=\x27FIRST\x27').get()).n, 0);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM source_verification_checks WHERE outcome='FIRST_CAPTURE'").get()).n, 1);

    const second = await runCollectSources(db, { sourceIds: [sourceId], fetcher, storage, sleep: instantSleep });
    assert.equal(second.created, 0);
    assert.equal(second.results[0].status, 'UNCHANGED_HASH');
    assert.equal(await count(db, 'regulatory_source_snapshots'), 1);

    await runCollectSources(db, {
      sourceIds: ['src-bcb-4111-manual'], storage,
      fetcher: async () => new Response('not a parsed spreadsheet', { status: 200, headers: { 'content-type': 'application/vnd.ms-excel' } }),
    });
    const unstructured = await db.prepare("SELECT parse_status FROM regulatory_source_snapshots WHERE source_id='src-bcb-4111-manual'").get();
    assert.equal(unstructured.parse_status, 'UNSTRUCTURED', 'binary XLS content must not be treated as UTF-8 text');
    const parse = await runParseSources(db, { storage });
    assert.ok(parse.processed >= 1);

    const rejected = await runCollectSources(db, {
      sourceIds: ['src-bcb-4111-manual'], storage, attempts: 1, sleep: instantSleep,
      fetcher: async () => new Response(null, { status: 302, headers: { location: 'https://example.com/collect-me' } }),
    });
    assert.equal(rejected.status, 'FAILED');
    assert.equal(rejected.errors >= 1, true);
    const error = await db.prepare("SELECT message FROM ingestion_errors WHERE error_type IN ('Error','FETCH_ERROR') ORDER BY timestamp DESC LIMIT 1").get();
    assert.match(error.message, /outside the HTTPS official-host allowlist/);
  } finally {
    await closeDatabase(db);
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test('generic demonstration pipeline emits a labeled artifact through durable storage and local-only validation', async () => {
  const storageDir = mkdtempSync(join(tmpdir(), 'lcf-artifacts-'));
  const db = await memoryDb();
  try {
    const storage = await createStorage({ env: { STORAGE_DIR: storageDir }, db });
    const result = await runDemoPipeline(db, { obligationId: 'obl-bcb-4111', referencePeriod: '2026-10-02', actor: 'test', storage });
    assert.equal(result.status, 'SUCCEEDED');
    assert.equal(result.validation.status, 'READY');
    assert.equal(result.submission.is_demo, true);
    assert.equal(result.submission.payload.accounts[0].codigoConta, '4110000001');
    assert.equal(result.submission.payload.accounts[0].saldoDia, '125000.45');
    assert.ok(result.submission.source_rows[0].projections.some((projection) => projection.transformation === 'LEFT_PAD(10)'));
    assert.match(result.submission.notice, /not submitted|Não foi submetido/);
    assert.equal(result.validation.summary.official_regulator_validator, false);
    assert.equal(await count(db, 'submissions'), 1);
    assert.equal(await count(db, 'pipeline_runs'), 1);
    assert.ok(await db.prepare("SELECT id FROM audit_events WHERE entity_type='SUBMISSION'").get());
    assert.match(result.submission.artifact_path, /^filesystem:demo-artifacts\//);
    assert.ok(existsSync(join(storageDir, 'demo-artifacts', result.submission.artifact_path.split('/').pop())));
  } finally {
    await closeDatabase(db);
    rmSync(storageDir, { recursive: true, force: true });
  }
});

test('HTTP API exposes inventory and sources, creates only explicitly internal targets, and rejects malformed deadlines', async (t) => {
  const db = await memoryDb();
  const { server } = createAppServer({ db });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolveClose) => server.close(resolveClose));
    await closeDatabase(db);
  });

  const sync = await fetch(`${base}/api/sources/sync`, { method: 'POST' });
  assert.equal(sync.status, 200);

  const routes = [
    '/api/health', '/api/dashboard', '/api/regulators', '/api/regulations', '/api/obligations',
    '/api/requirements', '/api/documents', '/api/schemas', '/api/fields', '/api/changes',
    '/api/impacts', '/api/norm-diff', '/api/mappings', '/api/catalog', '/api/internal-data',
    '/api/lineage', '/api/dq', '/api/deadlines', '/api/submissions', '/api/sources',
    '/api/sources/mon-bcb-scr3040-page', '/api/sources/mon-bcb-scr3040-page/snapshots',
    '/api/sources/mon-bcb-scr3040-page/checks',
    '/api/evidence', '/api/controls', '/api/audit', '/api/matrix', '/api/engineering',
    '/api/regulatory', '/api/cases', '/api/jobs', '/api/errors', '/api/search?q=4111',
    '/api/obligations/obl-bcb-4111', '/api/schemas/schema-susep-openinsurance-67',
  ];
  for (const route of routes) {
    const response = await fetch(`${base}${route}`);
    assert.equal(response.status, 200, route);
    assert.equal(response.headers.get('content-type')?.includes('application/json'), true, route);
    await response.json();
  }

  // monitored sources were registered by the sync call above
  const monitored = await (await fetch(`${base}/api/sources?authority=BCB`)).json();
  assert.ok(monitored.length >= 6, 'BCB monitored sources exist after registry sync');
  assert.equal(monitored.every((row) => row.source_url.startsWith('https://')), true);

  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.status, 'ok');
  assert.equal(health.data_mode, 'DEMO_FIXTURES');
  assert.ok(['filesystem', 'database', 'blob'].includes(health.storage), `storage reported: ${health.storage}`);
  assert.ok('sources_monitored' in health);

  const dashboard = await (await fetch(`${base}/api/dashboard`)).json();
  assert.equal(dashboard.data_mode, 'DEMO_FIXTURES');
  assert.ok(dashboard.counts.sources_monitored >= 23);
  assert.ok(Array.isArray(dashboard.source_health));

  const internal = await fetch(`${base}/api/deadlines/internal`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ obligation_id: 'obl-bcb-4111', reference_period: '2026-10-02', due_date: '2026-10-06', owner: 'Finance Data' }),
  });
  assert.equal(internal.status, 201);
  const target = await internal.json();
  assert.equal(target.deadline_type, 'INTERNAL');
  assert.equal(target.is_demo, true);
  assert.match(target.notice, /not an official regulatory deadline/);
  assert.equal(await count(db, 'regulatory_deadlines'), 4);
  assert.equal(await count(db, 'audit_events'), 1);

  const invalid = await fetch(`${base}/api/deadlines/internal`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ obligation_id: 'obl-bcb-4111', reference_period: '2026-10-02', due_date: '2026-02-30', owner: 'Finance Data' }),
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error, 'INVALID_DUE_DATE');

  const diff = await fetch(`${base}/api/norm-diff/compare`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ old_text: 'Valor opcional.', new_text: 'Valor obrigatório.' }),
  });
  assert.equal(diff.status, 200);
  assert.ok((await diff.json()).cues.includes('business_rule'));

  const createMapping = await fetch(`${base}/api/mappings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ regulatory_field_id: 'fld-3040-totalcli', data_field_id: 'df-core-contract-id', canonical_element_id: 'canon-credit-contract-id', transformation: 'IDENTITY', mapping_status: 'MAPPED', owner: 'Data Team', is_demo: true }),
  });
  assert.equal(createMapping.status, 201);
  const mapping = await createMapping.json();
  assert.equal(mapping.mapping_status, 'MAPPED');
  assert.equal(mapping.data_field_id, 'df-core-contract-id');

  const updateMapping = await fetch(`${base}/api/mappings/${encodeURIComponent(mapping.id)}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mapping_status: 'VALIDATED', approved_by: 'Reviewer' }),
  });
  assert.equal(updateMapping.status, 200);
  assert.equal((await updateMapping.json()).version, 2);

  const addEvidence = await fetch(`${base}/api/evidence`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'DEMO DATA mapping review', evidence_type: 'MAPPING_REVIEW', obligation_id: 'obl-bcb-4111', control_id: 'control-4111-cnpj', source_reference: 'test-fixture', is_demo: true }),
  });
  assert.equal(addEvidence.status, 201);
  assert.equal((await addEvidence.json()).is_demo, 1);

  const createControl = await fetch(`${base}/api/controls`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ control_name: 'test control', obligation_id: 'obl-bcb-4111', requirement_id: 'req-4111-xml', owner: 'Finance', frequency: 'Per run', evidence_type: 'LOCAL VALIDATION' }),
  });
  assert.equal(createControl.status, 201);
  const control = await createControl.json();
  assert.equal(control.result, 'NOT_RUN');
  assert.equal(await count(db, 'regulatory_controls'), 6);
  assert.equal(await count(db, 'audit_events'), 5, 'deadline, mapping create/update, evidence and control writes are audit-logged');

  // a registered manual change is created as a reviewable candidate, never as a confirmed legal fact
  const change = await fetch(`${base}/api/changes`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ change_type: 'DEADLINE_CHANGED', source_url: 'https://www.bcb.gov.br/estabilidadefinanceira/scrdoc3040', source_reference: 'test', summary: 'manual change without evidence review' }),
  });
  assert.equal(change.status, 201);
  const created = await change.json();
  assert.equal(created.review_status, 'REVIEW_REQUIRED');
  assert.equal(created.change_level, 'REGULATORY_CHANGE_CANDIDATE');
  const fetched = await (await fetch(`${base}/api/changes/${created.id}`)).json();
  assert.equal(fetched.id, created.id);
});

test('all browser routes render their page views against a live in-memory API', async () => {
  const db = await memoryDb();
  const { server } = createAppServer({ db });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const base = `http://127.0.0.1:${server.address().port}`;
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const originalLocation = globalThis.location;
  const appElement = { innerHTML: '' };
  const pageElement = { innerHTML: '' };
  const windowHandlers = {};
  const documentHandlers = {};
  globalThis.fetch = (input, init) => originalFetch(new URL(String(input), base), init);
  globalThis.location = { hash: '' };
  globalThis.document = {
    title: '',
    getElementById(id) { return id === 'app' ? appElement : id === 'page-content' ? pageElement : null; },
    addEventListener(name, handler) { documentHandlers[name] = handler; },
    querySelector() { return null; },
    createElement() { return { className: '', textContent: '', setAttribute() {} }; },
  };
  globalThis.window = { addEventListener(name, handler) { windowHandlers[name] = handler; } };
  try {
    await import(`../public/app.js?route-smoke=${Date.now()}`);
    const routes = [
      '#/dashboard', '#/obligations', '#/sources', '#/sources?id=src-bcb-3040-page',
      '#/impact', '#/impact?id=obl-bcb-4111',
      '#/regulators', '#/regulators?regulator=susep', '#/changes', '#/schemas',
      '#/schemas?id=schema-susep-openinsurance-67', '#/norm-diff', '#/mapping', '#/catalog',
      '#/lineage', '#/dq', '#/calendar', '#/submissions', '#/controls', '#/evidence',
      '#/regulatory', '#/engineering', '#/matrix', '#/cases', '#/system/jobs',
      '#/system/errors', '#/search?q=4111',
    ];
    for (const hash of routes) {
      globalThis.location.hash = hash;
      await windowHandlers.hashchange();
      assert.match(pageElement.innerHTML, /<main class="page">/, hash);
      assert.doesNotMatch(pageElement.innerHTML, /Workspace error/, hash);
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
    if (originalWindow === undefined) delete globalThis.window; else globalThis.window = originalWindow;
    if (originalLocation === undefined) delete globalThis.location; else globalThis.location = originalLocation;
    await new Promise((resolveClose) => server.close(resolveClose));
    await closeDatabase(db);
  }
});
