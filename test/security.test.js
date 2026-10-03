/**
 * Security and honesty boundaries: fail-closed production auth, never-seeded production,
 * storage policy guards, and degradation when persistence is absent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, closeDatabase, isProductionRuntime } from '../src/db.js';
import { seedAllowed } from '../src/seed.js';
import { assertAdmin, assertCronOrAdmin, safeEquals, AuthError } from '../src/auth.js';
import { resolveStorageProvider, createStorage } from '../src/storage.js';
import { createAppServer } from '../src/server.js';

function reqWith(header) {
  return { headers: header ? { authorization: header } : {} };
}

test('assertAdmin: fail-closed in production, practical in development, timing-safe compare', () => {
  assert.throws(() => assertAdmin(reqWith(), { production: true, adminKey: '' }), (error) => {
    assert.ok(error instanceof AuthError);
    assert.equal(error.statusCode, 503);
    assert.equal(error.code, 'AUTH_NOT_CONFIGURED');
    assert.match(error.message, /fail-closed/);
    return true;
  });
  assert.deepEqual(assertAdmin(reqWith(), { production: false, adminKey: '' }), { actor: 'dev-unauthenticated', enforced: false });
  assert.throws(() => assertAdmin(reqWith('Bearer wrong'), { production: false, adminKey: 'secret' }), { statusCode: 401, code: 'ADMIN_AUTH_REQUIRED' });
  assert.throws(() => assertAdmin(reqWith(), { production: true, adminKey: 'secret' }), { statusCode: 401, code: 'ADMIN_AUTH_REQUIRED' });
  assert.deepEqual(assertAdmin(reqWith('Bearer secret'), { production: true, adminKey: 'secret' }), { actor: 'admin', enforced: true });
  assert.deepEqual(assertAdmin({ headers: { 'x-admin-key': 'secret' } }, { production: true, adminKey: 'secret' }), { actor: 'admin', enforced: true });
  assert.equal(safeEquals('a', 'a'), true);
  assert.equal(safeEquals('a', 'b'), false);
  assert.equal(safeEquals('', null), false);
});

test('assertCronOrAdmin accepts CRON_SECRET or ADMIN_API_KEY bearers only', () => {
  assert.throws(() => assertCronOrAdmin(reqWith(), { production: true, adminKey: '', cronSecret: '' }), { statusCode: 503, code: 'AUTH_NOT_CONFIGURED' });
  assert.deepEqual(assertCronOrAdmin(reqWith(), { production: false, adminKey: '', cronSecret: '' }), { actor: 'dev-cron', enforced: false });
  assert.deepEqual(assertCronOrAdmin(reqWith('Bearer cron123'), { production: true, adminKey: 'admin', cronSecret: 'cron123' }), { actor: 'cron', enforced: true });
  assert.deepEqual(assertCronOrAdmin(reqWith('Bearer admin'), { production: true, adminKey: 'admin', cronSecret: 'cron123' }), { actor: 'admin', enforced: true });
  assert.throws(() => assertCronOrAdmin(reqWith('Bearer nope'), { production: true, adminKey: 'admin', cronSecret: 'cron123' }), { statusCode: 401, code: 'CRON_AUTH_REQUIRED' });
});

test('production boot refuses to invent persistence or demo fixtures', async () => {
  assert.equal(isProductionRuntime({ NODE_ENV: 'production' }), true);
  assert.equal(isProductionRuntime({ VERCEL: '1' }), true);
  assert.equal(isProductionRuntime({ NODE_ENV: 'test' }), false);
  assert.equal(seedAllowed({ NODE_ENV: 'production' }), false);
  assert.equal(seedAllowed({ NODE_ENV: 'test', LCF_ALLOW_SEED: 'false' }), false);
  assert.equal(seedAllowed({ NODE_ENV: 'development' }), true);

  await assert.rejects(
    () => openDatabase({ env: { NODE_ENV: 'production' }, path: undefined }),
    (error) => { assert.match(error.constructor.name + error.message, /DatabaseNotConfigured|DATABASE_NOT_CONFIGURED|not configured/i); return true; },
  );
});

test('storage provider policy: durable providers in production, filesystem only outside', async () => {
  assert.equal(resolveStorageProvider({ STORAGE_PROVIDER: 'filesystem' }, 'sqlite'), 'filesystem');
  assert.throws(() => resolveStorageProvider({ VERCEL: '1', STORAGE_PROVIDER: 'filesystem' }, 'postgres'), /only allowed outside production/);
  assert.equal(resolveStorageProvider({ VERCEL: '1', STORAGE_PROVIDER: 'filesystem', ALLOW_FS_STORAGE_DEV: '1' }, 'postgres'), 'filesystem', 'explicit dev escape hatch still available');
  assert.throws(() => resolveStorageProvider({ NODE_ENV: 'production', STORAGE_PROVIDER: 's3-ish' }, 'postgres'), /Unknown STORAGE_PROVIDER/);
  await assert.rejects(() => createStorage({ env: { NODE_ENV: 'production', STORAGE_PROVIDER: 'blob' } }), /BLOB_READ_WRITE_TOKEN/);
  assert.equal(resolveStorageProvider({ NODE_ENV: 'production', STORAGE_PROVIDER: 'blob', BLOB_READ_WRITE_TOKEN: 'tok' }, 'postgres'), 'blob');
  assert.equal(resolveStorageProvider({ NODE_ENV: 'production' }, 'postgres'), 'database', 'production defaults to PostgreSQL bytea when Blob is not configured');
  assert.equal(resolveStorageProvider({ NODE_ENV: 'development' }, 'sqlite'), 'filesystem');
});

test('HTTP mutations are gated by ADMIN_API_KEY and the API fails closed, never empty-ok, without a database', async (t) => {
  const saved = { admin: process.env.ADMIN_API_KEY, cron: process.env.CRON_SECRET, alertToken: process.env.ALERT_TOKEN_SECRET };
  process.env.ADMIN_API_KEY = 'integration-secret';
  process.env.CRON_SECRET = 'integration-cron';
  t.after(() => {
    if (saved.admin === undefined) delete process.env.ADMIN_API_KEY; else process.env.ADMIN_API_KEY = saved.admin;
    if (saved.cron === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved.cron;
    if (saved.alertToken === undefined) delete process.env.ALERT_TOKEN_SECRET; else process.env.ALERT_TOKEN_SECRET = saved.alertToken;
  });

  const db = await openDatabase({ path: ':memory:' });
  const { server } = createAppServer({ db });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const body = JSON.stringify({ title: 'nope', evidence_type: 'NOTE' });
    const anon = await fetch(`${base}/api/evidence`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(anon.status, 401);
    const payload = await anon.json();
    assert.equal(payload.error, 'ADMIN_AUTH_REQUIRED');
    assert.ok(payload.request_id, 'auth failures carry a request id for correlation');

    const wrong = await fetch(`${base}/api/evidence`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer wrong' }, body });
    assert.equal(wrong.status, 401);

    const ok = await fetch(`${base}/api/evidence`, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer integration-secret' }, body });
    assert.equal(ok.status, 201, 'a correct admin bearer passes');

    const collectNoAuth = await fetch(`${base}/api/jobs/collect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(collectNoAuth.status, 401, 'cron endpoint must reject anonymous triggers');
    const collectGetNoAuth = await fetch(`${base}/api/jobs/collect`);
    assert.equal(collectGetNoAuth.status, 401, 'the GET cron trigger form must be auth-gated too');
    const dailyAlertsNoAuth = await fetch(`${base}/api/jobs/alerts/daily`);
    assert.equal(dailyAlertsNoAuth.status, 401, 'daily alert cron must reject anonymous triggers');
    const collectWrongToken = await fetch(`${base}/api/jobs/collect`, { headers: { Authorization: 'Bearer nope' } });
    assert.equal(collectWrongToken.status, 401);
    const retryNoAuth = await fetch(`${base}/api/errors/whatever/retry`, { method: 'POST' });
    assert.equal(retryNoAuth.status, 401, 'retry endpoints are never open');

    // public GETs keep working without credentials
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, 'ok');

    process.env.ALERT_TOKEN_SECRET = 'alert-test-secret';
    const subscribe = await fetch(`${base}/api/public/alerts/subscribe`, {
      method:'POST', headers:{'content-type':'application/json'},
      body:JSON.stringify({ email:'alerts@example.com', consent:true, authorities:['BCB'], topics:['LAYOUTS'], delivery_mode:'IMMEDIATE' }),
    });
    assert.equal(subscribe.status, 202, 'public double-opt-in signup must not require admin auth');
    const subscription = await subscribe.json();
    assert.equal(subscription.status, 'PENDING_CONFIRMATION');
    const storedAlert = await db.prepare("SELECT status,delivery_mode FROM alert_subscribers WHERE email='alerts@example.com'").get();
    assert.equal(storedAlert.status, 'PENDING');
    assert.equal(storedAlert.delivery_mode, 'DAILY', 'free public signup is forced to daily even if IMMEDIATE is requested');
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    await closeDatabase(db);
  }

  // degraded mode: no db, no fabrication — health is honest, everything else 503s
  const degraded = createAppServer({ db: null });
  await new Promise((resolveListen) => degraded.server.listen(0, '127.0.0.1', resolveListen));
  try {
    const dBase = `http://127.0.0.1:${degraded.server.address().port}`;
    const h = await (await fetch(`${dBase}/api/health`)).json();
    assert.equal(h.status, 'degraded');
    assert.equal(h.data_mode, 'UNCONFIGURED');
    assert.match(h.message, /inventing data is not allowed|never used as production storage/);
    const dash = await fetch(`${dBase}/api/dashboard`);
    assert.equal(dash.status, 503);
    assert.equal((await dash.json()).error, 'DATABASE_NOT_CONFIGURED');
  } finally {
    await new Promise((resolveClose) => degraded.server.close(resolveClose));
  }
});
