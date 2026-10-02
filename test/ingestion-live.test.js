/**
 * Real-chain ingestion behavior with a controlled fetcher: conditional GET (304), hash
 * comparison, immutable snapshots, durable bytes, retry/backoff, failure persistence,
 * change-level discipline (SOURCE_CHANGED vs candidate vs confirmed) and provenance serving.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { openDatabase, closeDatabase } from '../src/db.js';
import { isOfficialSourceUrl, runCollectSources } from '../src/engines/ingestion.js';
import { createStorage } from '../src/storage.js';
import { syncOfficialRegistry, ADAPTERS } from '../src/sources/index.js';
import { createAppServer } from '../src/server.js';

const instantSleep = async () => {};
const SOURCE_ID = 'mon-bcb-scr3040-page';

function htmlFetch(body, extraHeaders = {}) {
  return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...extraHeaders } };
}

async function fixture(t) {
  const storageDir = mkdtempSync(join(tmpdir(), 'lcf-ingest-'));
  const db = await openDatabase({ path: ':memory:' });
  await syncOfficialRegistry(db);
  const storage = await createStorage({ env: { STORAGE_DIR: storageDir }, db });
  t.after(async () => { await closeDatabase(db); rmSync(storageDir, { recursive: true, force: true }); });
  return { db, storage, storageDir };
}

test('first capture creates one immutable snapshot, records provenance and never claims a change', async (t) => {
  const { db, storage, storageDir } = await fixture(t);
  const body = '<html><body><h1>Documento 3040</h1><p>Leiaute oficial vigente.</p></body></html>';
  const result = await runCollectSources(db, { sourceIds: [SOURCE_ID], fetcher: async () => new Response(body, htmlFetch(body)), storage, attempts: 1, sleep: instantSleep });
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.changed, 1);
  assert.equal(result.results[0].status, 'CAPTURED_FIRST');
  const snapshot = await db.prepare('SELECT * FROM regulatory_source_snapshots WHERE source_id = ?').get(SOURCE_ID);
  const expectedHash = createHash('sha256').update(body).digest('hex');
  assert.equal(snapshot.content_hash, expectedHash, 'stored hash must be the SHA-256 of the real bytes');
  assert.equal(snapshot.http_status, 200);
  assert.equal(snapshot.content_length, Buffer.byteLength(body));
  assert.equal(snapshot.mime_type, 'text/html');
  assert.equal(snapshot.storage_provider, 'filesystem');
  assert.equal(snapshot.parse_status, 'PARSED_TEXT');
  assert.equal(snapshot.diff_type, 'FIRST_CAPTURE');
  assert.equal(snapshot.previous_snapshot_id, null);
  const stored = readFileSync(join(storageDir, 'snapshots', SOURCE_ID, expectedHash));
  assert.equal(stored.toString('utf8'), body, 'raw bytes must be durably persisted');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM regulatory_changes WHERE entity_type = \'SOURCE\'').get()).n, 0, 'a first capture is not a change');
  const source = await db.prepare('SELECT status, content_hash_scope, last_http_status, current_snapshot_id FROM regulatory_sources WHERE id = ?').get(SOURCE_ID);
  assert.equal(source.status, 'RAW_CAPTURED');
  assert.equal(source.content_hash_scope, 'RAW_RESPONSE_SHA256');
  assert.equal(source.current_snapshot_id, snapshot.id);
});

test('conditional GET: 304 records a verification check without duplicating snapshot bytes', async (t) => {
  const { db, storage } = await fixture(t);
  const body = '<html><body>Estável.</body></html>';
  await runCollectSources(db, { sourceIds: [SOURCE_ID], fetcher: async () => new Response(body, htmlFetch(body, { etag: 'W/"e1"' })), storage, attempts: 1, sleep: instantSleep });
  let seenHeaders = null;
  const result = await runCollectSources(db, {
    sourceIds: [SOURCE_ID], storage, attempts: 1, sleep: instantSleep,
    fetcher: async (_url, options) => {
      seenHeaders = options.headers;
      assert.equal(seenHeaders['If-None-Match'], 'W/"e1"');
      return new Response(null, { status: 304 });
    },
  });
  assert.equal(result.results[0].status, 'UNCHANGED_304');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM regulatory_source_snapshots').get()).n, 1, '304 must not create a snapshot');
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM source_verification_checks WHERE outcome = 'UNCHANGED_304'").get()).n, 1);
  const source = await db.prepare('SELECT last_http_status FROM regulatory_sources WHERE id = ?').get(SOURCE_ID);
  assert.equal(source.last_http_status, 304);
});

test('content change: SOURCE_CHANGED ledger with TEXT diff; candidate only when cues exist; never auto-confirmed', async (t) => {
  const { db, storage } = await fixture(t);
  const before = '<html><body><p>O prazo de entrega do documento 3040 é 14 de outubro.</p></body></html>';
  const after = '<html><body><p>O prazo de entrega do documento 3040 é 20 de novembro e passa a exigir campo obrigatório.</p></body></html>';
  await runCollectSources(db, { sourceIds: [SOURCE_ID], fetcher: async () => new Response(before, htmlFetch(before)), storage, attempts: 1, sleep: instantSleep });
  const changed = await runCollectSources(db, { sourceIds: [SOURCE_ID], fetcher: async () => new Response(after, htmlFetch(after, { etag: 'W/"e2"' })), storage, attempts: 1, sleep: instantSleep });
  assert.equal(changed.results[0].status, 'CAPTURED_CHANGED');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM regulatory_source_snapshots').get()).n, 2);
  const newSnapshot = await db.prepare('SELECT * FROM regulatory_source_snapshots ORDER BY collected_at DESC, id DESC LIMIT 1').get();
  assert.equal(newSnapshot.diff_type, 'TEXT_DIFF');
  assert.ok(newSnapshot.previous_snapshot_id, 'new snapshot links to its predecessor');

  const ledger = await db.prepare("SELECT change_level, review_status, confidence FROM regulatory_changes WHERE entity_type='SOURCE'").all();
  assert.equal(ledger.length, 2);
  const byLevel = Object.fromEntries(ledger.map((row) => [row.change_level, row]));
  assert.equal(byLevel.SOURCE_CHANGED.review_status, 'REVIEW_REQUIRED');
  assert.equal(byLevel.SOURCE_CHANGED.confidence, 'HASH_ONLY');
  assert.equal(byLevel.REGULATORY_CHANGE_CANDIDATE.review_status, 'REVIEW_REQUIRED');
  assert.equal(ledger.filter((row) => row.change_level === 'REGULATORY_CHANGE_CONFIRMED').length, 0, 'the engine never auto-confirms regulatory meaning');

  // A same-hash refetch must not add rows at all.
  const stable = await runCollectSources(db, { sourceIds: [SOURCE_ID], fetcher: async () => new Response(after, htmlFetch(after)), storage, attempts: 1, sleep: instantSleep });
  assert.equal(stable.results[0].status, 'UNCHANGED_HASH');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM regulatory_source_snapshots').get()).n, 2);
});

test('retries with backoff, then succeeds; persistent failure lands in ingestion_errors and keeps old snapshots', async (t) => {
  const { db, storage } = await fixture(t);
  const body = '<html><body>Ok após retries.</body></html>';
  let attempts = 0;
  const sleeps = [];
  const ok = await runCollectSources(db, {
    sourceIds: [SOURCE_ID], storage,
    fetcher: async () => { attempts += 1; if (attempts < 3) throw new Error('ECONNRESET socket hang up'); return new Response(body, htmlFetch(body)); },
    sleep: async (ms) => { sleeps.push(ms); },
  });
  assert.equal(ok.status, 'SUCCEEDED');
  assert.equal(attempts, 3, 'two failed attempts plus success within a three-attempt budget');
  assert.deepEqual(sleeps, [400, 1500], 'backoff between attempts');

  let failingAttempts = 0;
  const failing = await runCollectSources(db, {
    sourceIds: ['mon-cvm-res80'], storage,
    fetcher: async () => { failingAttempts += 1; throw new Error('ETIMEDOUT network unreachable'); },
    sleep: async () => {},
  });
  assert.equal(failing.status, 'FAILED');
  assert.equal(failingAttempts, 3, 'exactly three attempts before declaring failure');
  assert.equal(failing.results[0].status, 'ERROR');
  const error = await db.prepare("SELECT * FROM ingestion_errors WHERE source_id='mon-cvm-res80'").get();
  assert.ok(error, 'failure must be persisted, not swallowed');
  assert.equal(error.attempt_count, 3);
  assert.equal(error.resolved, 0);
  const source = await db.prepare("SELECT consecutive_failures, last_error FROM regulatory_sources WHERE id='mon-cvm-res80'").get();
  assert.equal(source.consecutive_failures, 1);
  assert.match(source.last_error, /ETIMEDOUT/);
});

test('snapshots are append-only: raw fields cannot be updated or deleted, parse metadata may evolve', async (t) => {
  const { db, storage } = await fixture(t);
  const body = '<html><body>Imutável.</body></html>';
  await runCollectSources(db, { sourceIds: [SOURCE_ID], fetcher: async () => new Response(body, htmlFetch(body)), storage, attempts: 1, sleep: instantSleep });
  await assert.rejects(() => db.prepare('UPDATE regulatory_source_snapshots SET content_hash = ? WHERE 1=1').run('c'.repeat(64)), /immutable/);
  await assert.rejects(() => db.prepare('UPDATE regulatory_source_snapshots SET content = ? WHERE 1=1').run(Buffer.from('tampered')), /immutable/);
  await assert.rejects(() => db.prepare('DELETE FROM regulatory_source_snapshots WHERE 1=1').run(), /immutable/);
  await db.prepare('UPDATE regulatory_source_snapshots SET parse_error = ? WHERE 1=1').run('metadata update allowed');
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM regulatory_source_snapshots WHERE parse_error = 'metadata update allowed'").get()).n, 1);
});

test('the HTTP layer serves the stored raw bytes back with the recorded SHA-256', async (t) => {
  const { db, storage } = await fixture(t);
  const body = '<html><body>Sirva os bytes reais.</body></html>';
  await runCollectSources(db, { sourceIds: [SOURCE_ID], fetcher: async () => new Response(body, htmlFetch(body)), storage, attempts: 1, sleep: instantSleep });
  const snapshot = await db.prepare('SELECT id, content_hash FROM regulatory_source_snapshots WHERE source_id = ?').get(SOURCE_ID);
  const { server } = createAppServer({ db });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/sources/${SOURCE_ID}/snapshots/${snapshot.id}/content`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-content-sha256'), snapshot.content_hash);
    const text = await response.text();
    assert.equal(createHash('sha256').update(text).digest('hex'), snapshot.content_hash, 'served bytes must hash to the recorded value');
    void storage;
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

test('official adapter registry: 8 authorities, https-only sources, idempotent sync, polling windows respected', async (t) => {
  const { db, storage } = await fixture(t);
  assert.equal(ADAPTERS.length, 8);
  const declared = ADAPTERS.flatMap((adapter) => adapter.sources.map((source) => ({ ...source, adapter: adapter.name })));
  assert.ok(declared.length >= 20, 'each authority declares several concrete official sources');
  for (const source of declared) {
    assert.match(source.url, /^https:\/\//, 'adapters may only declare HTTPS official URLs');
    assert.equal(isOfficialSourceUrl(source.url), true, `${source.url} must pass the engine's official-host allowlist`);
    assert.ok(['html', 'pdf', 'json', 'csv', 'xml', 'xlsx', 'text'].includes(source.parser), `${source.id} parser must be registered`);
  }
  const first = await syncOfficialRegistry(db);
  const second = await syncOfficialRegistry(db);
  assert.equal(second.sources_created, 0, 're-sync must not duplicate sources');
  assert.equal(first.sources_synced, second.sources_synced);
  const authorities = await db.prepare("SELECT COUNT(DISTINCT COALESCE(authority, regulator_id)) AS n FROM regulatory_sources WHERE adapter IS NOT NULL").get();
  assert.equal(authorities.n, 8);

  // Polling window: an immediately re-run due-only collection must skip recently checked sources.
  const now = new Date().toISOString();
  await db.prepare('UPDATE regulatory_sources SET last_checked_at = ?').run(now);
  const due = await runCollectSources(db, { dueOnly: true, fetcher: async () => new Response('<html></html>', htmlFetch('<html></html>')), storage, attempts: 1, sleep: instantSleep });
  assert.equal(due.processed, 0, 'no source is due right after a fresh check');
});
