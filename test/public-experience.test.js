import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { openDatabase, closeDatabase } from '../src/db.js';
import { runCollectSources } from '../src/engines/ingestion.js';
import { ADAPTERS } from '../src/sources/index.js';
import { createAppServer } from '../src/server.js';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function json(base, path) {
  const response = await fetch(`${base}${path}`);
  assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`);
  return { response, value: await response.json() };
}

test('public workspace renders evidenced snapshots, clear SOURCE_CHANGED status, SEO and safe public projections', async () => {
  const db = await openDatabase({ path: ':memory:' });
  const { server } = createAppServer({ db });
  const base = await listen(server);
  const stored = new Map();
  const storage = {
    provider: 'test-memory',
    async save(key, bytes) {
      stored.set(key, Buffer.from(bytes));
      return { provider: 'test-memory', key, size: bytes.length };
    },
    async read(key) { return stored.get(String(key).replace(/^test:/, '')) || null; },
    async exists(key) { return stored.has(String(key).replace(/^test:/, '')); },
  };
  let version = 0;
  const fetcher = async () => {
    version += 1;
    const body = version === 1
      ? '<html><body><h1>Registro alpha</h1><p>Visual A.</p></body></html>'
      : version === 2
        ? '<html><body><h1>Registro beta</h1><p>Visual B.</p></body></html>'
        : '<html><body><h1>Registro gamma</h1><p>Nova norma deverá ser transmitida em formato JSON.</p></body></html>';
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', etag: `"version-${version}"` },
    });
  };
  const sourceId = ADAPTERS[0].sources[0].id;

  try {
    const before = await json(base, '/api/public/changes?period=all&kind=DETECTED');
    assert.equal(before.value.detected_count, 0, 'seeded documentary references are not presented as captured changes');

    const firstCapture = await runCollectSources(db, {
      sourceIds: [sourceId], fetcher, storage, attempts: 1, sleep: async () => {},
    });
    assert.equal(firstCapture.results[0].status, 'CAPTURED_FIRST');
    assert.equal((await json(base, '/api/public/changes?period=all&kind=DETECTED')).value.detected_count, 0,
      'a first capture does not fabricate a change');

    const secondCapture = await runCollectSources(db, {
      sourceIds: [sourceId], fetcher, storage, attempts: 1, sleep: async () => {},
    });
    assert.equal(secondCapture.results[0].status, 'CAPTURED_CHANGED');
    const feed = await json(base, '/api/public/changes?period=all&kind=DETECTED');
    assert.equal(feed.value.detected_count, 1);
    const change = feed.value.changes[0];
    assert.equal(change.change_level, 'SOURCE_CHANGED');
    assert.equal(change.public_status, 'REVIEW_REQUIRED');
    assert.equal(change.public_category, 'DETECTED');
    assert.equal(Object.hasOwn(change, 'owner'), false);
    assert.equal(Object.hasOwn(change, 'is_demo'), false);

    const detailResult = await json(base, `/api/public/changes/${encodeURIComponent(change.id)}`);
    const detail = detailResult.value;
    assert.equal(detail.change_level, 'SOURCE_CHANGED');
    assert.equal(detail.review_status, 'REVIEW_REQUIRED');
    assert.equal(detail.snapshots.previous.content_hash, createHash('sha256').update(
      '<html><body><h1>Registro alpha</h1><p>Visual A.</p></body></html>',
    ).digest('hex'));
    assert.equal(detail.snapshots.current.content_hash, createHash('sha256').update(
      '<html><body><h1>Registro beta</h1><p>Visual B.</p></body></html>',
    ).digest('hex'));
    assert.ok(detail.text_diff.added.some((line) => line.includes('beta')));
    assert.ok(detail.text_diff.removed.some((line) => line.includes('alpha')));
    assert.match(detail.impact_notice, /não são classificação jurídica/);
    assert.equal(Object.hasOwn(detail, 'adapter_config_json'), false);
    assert.equal(Object.hasOwn(detail, 'storage_provider'), false);

    const [obligations, schemas, deadlines] = await Promise.all([
      json(base, '/api/public/obligations'),
      json(base, '/api/public/schemas'),
      json(base, '/api/public/deadlines'),
    ]);
    assert.ok(obligations.value.length > 0);
    assert.equal(Object.hasOwn(obligations.value[0], 'owner'), false);
    assert.equal(Object.hasOwn(obligations.value[0], 'submission_method'), false);
    assert.ok(schemas.value.length > 0);
    assert.equal(Object.hasOwn(schemas.value[0], 'adapter_config_json'), false);
    assert.ok(deadlines.value.length > 0);
    assert.equal(Object.hasOwn(deadlines.value[0], 'owner'), false);

    const schemaDetail = await json(base, '/api/public/schemas/schema-bcb-4111-v2026');
    assert.ok(schemaDetail.value.fields.length > 0);
    assert.equal(Object.hasOwn(schemaDetail.value.fields[0], 'mapping_count'), false);
    assert.equal(Object.hasOwn(schemaDetail.value.fields[0], 'dq_rule_count'), false);
    const obligationDetail = await json(base, '/api/public/obligations/obl-bcb-4111');
    assert.equal(Object.hasOwn(obligationDetail.value.obligation, 'owner'), false);
    assert.equal(Object.hasOwn(obligationDetail.value.obligation, 'submission_system'), false);

    const snapshotId = detail.snapshots.current.id;
    const raw = await fetch(`${base}/api/sources/${encodeURIComponent(sourceId)}/snapshots/${encodeURIComponent(snapshotId)}/content`);
    assert.equal(raw.status, 200);
    assert.equal(raw.headers.get('x-content-sha256'), detail.snapshots.current.content_hash);
    assert.match(raw.headers.get('x-robots-tag'), /noindex/);
    assert.match(await raw.text(), /Registro beta/);

    for (const path of ['/', '/mudancas', '/fontes', '/orgaos', '/obrigacoes', '/schemas', '/prazos', '/sobre']) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 200, path);
      const html = await response.text();
      assert.match(html, /<html lang="pt-BR">/, path);
      assert.match(html, /<meta name="robots" content="index,follow">/, path);
      assert.match(html, /<link rel="canonical" href="http:\/\//, path);
      assert.match(html, /LCF RegTech/, path);
    }

    const changePage = await fetch(`${base}/mudancas/${encodeURIComponent(change.id)}`);
    assert.equal(changePage.status, 200);
    const changeHtml = await changePage.text();
    assert.match(changeHtml, /SOURCE_CHANGED/);
    assert.match(changeHtml, /SHA-256/);
    assert.match(changeHtml, /não confirma/i);
    assert.match(changePage.headers.get('x-robots-tag'), /index/);

    const thirdCapture = await runCollectSources(db, {
      sourceIds: [sourceId], fetcher, storage, attempts: 1, sleep: async () => {},
    });
    assert.equal(thirdCapture.results[0].status, 'CAPTURED_CHANGED');
    const candidateFeed = await json(base, '/api/public/changes?period=all&kind=DETECTED');
    const candidate = candidateFeed.value.changes.find((row) => row.change_level === 'REGULATORY_CHANGE_CANDIDATE');
    assert.ok(candidate, 'a lexical cue remains a review candidate, separate from SOURCE_CHANGED');
    assert.equal(candidate.public_status, 'REVIEW_REQUIRED');
    const candidateDetail = await json(base, `/api/public/changes/${encodeURIComponent(candidate.id)}`);
    assert.equal(candidateDetail.value.change_level, 'REGULATORY_CHANGE_CANDIDATE');
    assert.equal(candidateDetail.value.review_status, 'REVIEW_REQUIRED');
    const candidatePage = await fetch(`${base}/mudancas/${encodeURIComponent(candidate.id)}`);
    assert.equal(candidatePage.status, 200);
    const candidateHtml = await candidatePage.text();
    assert.match(candidateHtml, /CANDIDATO · REVISÃO HUMANA NECESSÁRIA/);
    assert.match(candidateHtml, /revisão humana/i);
    const sourcePage = await fetch(`${base}/fontes/${encodeURIComponent(sourceId)}`);
    assert.equal(sourcePage.status, 200);
    const sourceHtml = await sourcePage.text();
    assert.match(sourceHtml, /SOURCE_CHANGED · CONTEÚDO DA FONTE/);
    assert.match(sourceHtml, /CANDIDATO · REVISÃO HUMANA NECESSÁRIA/);

    const internal = await fetch(`${base}/admin`);
    assert.equal(internal.status, 200);
    assert.match(internal.headers.get('x-robots-tag'), /noindex/);
    assert.match(await internal.text(), /content="noindex,nofollow"/);

    const robots = await (await fetch(`${base}/robots.txt`)).text();
    assert.match(robots, /Disallow: \/api\//);
    assert.match(robots, /Disallow: \/admin/);
    const sitemap = await (await fetch(`${base}/sitemap.xml`)).text();
    assert.match(sitemap, new RegExp(`/mudancas/${change.id}`));
    assert.doesNotMatch(sitemap, /\/admin/);

    const { response: apiResponse } = await json(base, '/api/public/overview');
    assert.match(apiResponse.headers.get('x-robots-tag'), /noindex/);
  } finally {
    await close(server);
    await closeDatabase(db);
  }
});

test('Vercel rewrites dispatch public pages and APIs through the serverless gateway', async () => {
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  const rewrites = config.rewrites;
  for (const path of ['/', '/mudancas', '/fontes', '/orgaos', '/obrigacoes', '/schemas', '/prazos', '/sobre', '/admin']) {
    assert.ok(rewrites.some((rule) => rule.source === path && rule.destination.startsWith('/api/index?__page=')), path);
  }
  assert.ok(rewrites.some((rule) => rule.source === '/api/:path*' && rule.destination.includes('__path=:path*')));

  const originalEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_PATH: process.env.DATABASE_PATH,
    NODE_ENV: process.env.NODE_ENV,
    LCF_ALLOW_SEED: process.env.LCF_ALLOW_SEED,
    VERCEL: process.env.VERCEL,
  };
  process.env.DATABASE_URL = '';
  process.env.DATABASE_PATH = ':memory:';
  process.env.NODE_ENV = 'test';
  process.env.LCF_ALLOW_SEED = 'true';
  delete process.env.VERCEL;

  let db;
  try {
    const { default: handler, getBootstrap } = await import(`../api/index.js?public-workspace-test=${Date.now()}`);
    const response = () => {
      const headers = new Map();
      const chunks = [];
      return {
        statusCode: 200,
        headers,
        chunks,
        setHeader(name, value) { headers.set(String(name).toLowerCase(), value); },
        writeHead(status, values = {}) {
          this.statusCode = status;
          for (const [name, value] of Object.entries(values)) headers.set(name.toLowerCase(), value);
        },
        end(chunk = '') { chunks.push(Buffer.from(chunk)); },
        text() { return Buffer.concat(chunks).toString('utf8'); },
      };
    };
    const pageResponse = response();
    await handler({
      method: 'GET', url: '/api/index?__page=%2F',
      headers: { host: 'preview.example.test', 'x-forwarded-proto': 'https' }, socket: {},
    }, pageResponse);
    assert.equal(pageResponse.statusCode, 200);
    assert.match(pageResponse.text(), /<title>LCF RegTech/);
    assert.match(pageResponse.text(), /canonical" href="https:\/\/preview\.example\.test\//);

    const apiResponse = response();
    await handler({
      method: 'GET', url: '/api/index?__path=public%2Foverview',
      headers: { host: 'preview.example.test', 'x-forwarded-proto': 'https' }, socket: {},
    }, apiResponse);
    assert.equal(apiResponse.statusCode, 200);
    assert.match(apiResponse.headers.get('x-robots-tag'), /noindex/);
    assert.equal(JSON.parse(apiResponse.text()).data_mode, 'DEMO_FIXTURES');

    const unknownPage = response();
    await handler({
      method: 'GET', url: '/api/index?__page=%2Fnot-a-public-route',
      headers: { host: 'preview.example.test', 'x-forwarded-proto': 'https' }, socket: {},
    }, unknownPage);
    assert.equal(unknownPage.statusCode, 404);
    assert.match(unknownPage.headers.get('x-robots-tag'), /noindex/);
    ({ db } = await getBootstrap());
  } finally {
    if (db) await closeDatabase(db);
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
