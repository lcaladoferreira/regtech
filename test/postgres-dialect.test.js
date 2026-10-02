/**
 * PostgreSQL dialect coverage without a live server: SQL placeholder translation and the
 * PgDriver surface (get/all/run, transactions, migrations) are exercised against a fake
 * `pg` module; the baseline migration file is validated for dialect-specific constructs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, closeDatabase, toPgParams } from '../src/db.js';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');

test('toPgParams renumbers ? placeholders outside literals, quotes, and comments', () => {
  assert.equal(toPgParams('SELECT ? , ?'), 'SELECT $1 , $2');
  assert.equal(toPgParams("WHERE label = 'a ? $5 b' AND id = ?"), "WHERE label = 'a ? $5 b' AND id = $1");
  assert.equal(toPgParams('SELECT 1 -- note ? here\nWHERE id = ?'), 'SELECT 1 -- note ? here\nWHERE id = $1');
  assert.equal(toPgParams('SELECT /* ? */ ?'), 'SELECT /* ? */ $1');
  assert.equal(toPgParams("INSERT INTO t VALUES ('it''s ? here', ?)"), "INSERT INTO t VALUES ('it''s ? here', $1)");
  assert.equal(toPgParams('SELECT "quoted ? col", ?'), 'SELECT "quoted ? col", $1');
  // Migration/exec SQL without bindable placeholders must come out unchanged — asserted on the real files below.
  for (const file of ['migrations/postgres/001_full_baseline.sql', 'migrations/sqlite/001_initial.sql', 'migrations/sqlite/002_excerpt_verification_timestamp.sql', 'migrations/sqlite/003_live_pipeline.sql']) {
    const sql = readFileSync(join(repoRoot, file), 'utf8');
    assert.equal(toPgParams(sql), sql, `${file} must survive placeholder rewriting untouched`);
  }
});

function fakePg({ applied = [] } = {}) {
  const calls = [];
  const tables = new Map([['schema_migrations', applied.map((version) => ({ version }))]]);
  const record = async (sql, params) => {
    calls.push({ sql, params });
    const normalized = String(sql).trim().toLowerCase();
    if (normalized.startsWith('select')) {
      if (normalized.includes('from schema_migrations')) {
        const version = params?.[0];
        return { rows: version ? (tables.get('schema_migrations') || []).filter((row) => row.version === version) : [...(tables.get('schema_migrations') || [])] };
      }
      return { rows: [], rowCount: 0 };
    }
    if (normalized.startsWith('insert into schema_migrations')) {
      if (!tables.has('schema_migrations')) tables.set('schema_migrations', []);
      tables.get('schema_migrations').push({ version: params[0] });
    }
    return { rows: [], rowCount: 1 };
  };
  const client = {
    query: (sql, params) => record(sql, params),
    release() { this.released = true; },
  };
  const pool = {
    query: (sql, params) => record(sql, params),
    connect: async () => client,
    end: async () => { pool.ended = true; },
  };
  return {
    calls,
    client,
    pool,
    module: {
      types: { setTypeParser() {} },
      default: { Pool: function Pool() { return pool; } },
      Pool: function Pool() { return pool; },
    },
  };
}

test('PgDriver translates app SQL, keeps native params, and wraps transactions', async (t) => {
  const pg = fakePg();
  const db = await openDatabase({ env: { NODE_ENV: 'test', DATABASE_URL: 'postgres://fake/only', PG_POOL_MAX: '2' }, pg: pg.module });
  t.after(async () => { await closeDatabase(db); });

  await db.prepare('SELECT * FROM regulatory_sources WHERE enabled = 1 AND id = ?').get('src-1');
  const select = pg.calls.at(-1);
  assert.match(select.sql, /id = \$1/);
  assert.ok(!/[^$]\?\b/.test(select.sql), 'no raw ? placeholders reach the driver');
  assert.deepEqual(select.params, ['src-1']);

  await db.prepare('UPDATE regulatory_sources SET last_http_status = ?, consecutive_failures = ? WHERE id = ?').run(200, 0, 'src-1');
  assert.deepEqual(pg.calls.at(-1).params, [200, 0, 'src-1'], 'numbers pass through as numbers');

  const result = await db.prepare('INSERT INTO audit_events (id, action) VALUES (?, ?)').run('a1', 'x');
  assert.equal(result.changes, 1);

  const beginsBefore = pg.calls.filter((call) => call.sql === 'BEGIN').length;
  const returned = await db.transaction(async (handle) => {
    await handle.prepare('SELECT ? AS v').get(42);
    return 'done';
  });
  assert.equal(returned, 'done');
  assert.equal(pg.calls.filter((call) => call.sql === 'BEGIN').length, beginsBefore + 1, 'transaction issues BEGIN on the client');
  assert.ok(pg.calls.some((call) => call.sql === 'COMMIT'));
  assert.ok(!pg.calls.some((call) => call.sql === 'ROLLBACK'));
  assert.equal(pg.client.released, true, 'pool client is released after the transaction');

  await assert.rejects(() => db.transaction(async (handle) => {
    await handle.prepare('SELECT ? AS v').get(1);
    throw new Error('boom');
  }), /boom/);
  assert.ok(pg.calls.some((call) => call.sql === 'ROLLBACK'), 'failed transaction rolls back');
  await db.close();
  assert.equal(pg.pool.ended, true, 'db.close ends the pool');
});

test('openDatabase on PostgreSQL applies the baseline once and never seeds', async () => {
  const fresh = fakePg();
  const db = await openDatabase({ env: { NODE_ENV: 'test', DATABASE_URL: 'postgres://fake/only' }, pg: fresh.module });
  const applied = fresh.calls.filter((call) => call.sql.trim().toLowerCase().startsWith('insert into schema_migrations')).map((call) => call.params[0]);
  assert.deepEqual(applied, ['001_full_baseline.sql'], 'the PostgreSQL baseline migration contains the full live schema');
  assert.equal(db.dataMode, 'LIVE');
  const anySeed = fresh.calls.some((call) => /insert into (regulators|regulatory_obligations|demo_data)\b/.test(String(call.sql)));
  assert.equal(anySeed, false, 'production-style boot must never seed demo data');
  await db.close();

  const upToDate = fakePg({ applied: ['001_full_baseline.sql'] });
  const db2 = await openDatabase({ env: { NODE_ENV: 'production', VERCEL: '1', DATABASE_URL: 'postgres://fake/only', ADMIN_API_KEY: 'k' }, pg: upToDate.module });
  const newInserts = upToDate.calls.filter((call) => call.sql.trim().toLowerCase().startsWith('insert into schema_migrations'));
  assert.equal(newInserts.length, 0, 'already-applied migrations are skipped');
  await db2.close();
});

test('postgres baseline migration is dialect-correct and includes the live-pipeline schema', () => {
  const sql = readFileSync(join(repoRoot, 'migrations/postgres/001_full_baseline.sql'), 'utf8');
  assert.doesNotMatch(sql, /AUTOINCREMENT|PRAGMA|INSERT OR IGNORE|datetime\(/, 'no SQLite-only constructs');
  assert.match(sql, /BYTEA/);
  assert.match(sql, /source_verification_checks/);
  assert.match(sql, /change_level TEXT NOT NULL DEFAULT 'LEGACY'/);
  assert.match(sql, /attempt_count INTEGER/, 'ingestion_errors retry accounting columns exist');
  const triggers = sql.match(/CREATE TRIGGER/gi) || [];
  assert.equal(triggers.length, 2, 'one BEFORE UPDATE and one BEFORE DELETE immutability trigger');
  assert.match(sql, /BEFORE UPDATE OF .* ON regulatory_source_snapshots/i);
  assert.match(sql, /BEFORE DELETE ON regulatory_source_snapshots/i);
  // parse metadata updates must stay possible: the OF column list excludes parse_* fields
  const ofList = sql.match(/BEFORE UPDATE OF ([\s\S]+?) ON regulatory_source_snapshots/)[1];
  for (const forbidden of ['parse_status', 'parse_error', 'parse_warning', 'diff_type', 'previous_snapshot_id', 'regulatory_change_id', 'fields_count', 'notes']) {
    assert.ok(!ofList.includes(forbidden), `trigger column list must not freeze ${forbidden}`);
  }
});
