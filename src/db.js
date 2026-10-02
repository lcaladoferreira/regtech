/**
 * Database access layer.
 *
 * Production: PostgreSQL (Neon / Vercel Postgres / Supabase / compatible) via DATABASE_URL.
 * Development and automated tests: node:sqlite (never used as production persistence).
 *
 * Both drivers expose the same async statement API used by the rest of the codebase:
 *   await db.prepare(sql).get(...params) / .all(...params) / .run(...params)
 *   await db.exec(sql)
 *   await db.transaction(async (tx) => { ... })
 * SQL is written with `?` placeholders; the PostgreSQL driver rewrites them to `$n`.
 * SQLite-specific expressions (datetime('now'), GROUP_CONCAT, INSERT OR IGNORE) are not used
 * in application SQL — dates are computed in JavaScript and upserts use ON CONFLICT DO NOTHING,
 * which both engines support.
 */
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedAllowed, seedDatabase, DEMO_FIXTURES } from './seed.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
export const MIGRATIONS_ROOT = resolve(repoRoot, 'migrations');
const PG_URL_PATTERN = /^postgres(ql)?:\/\//i;

export function isProductionRuntime(env = process.env) {
  return env.NODE_ENV === 'production' || env.VERCEL === '1';
}

export function isPostgresConfigured(env = process.env) {
  return PG_URL_PATTERN.test(String(env.DATABASE_URL || ''));
}

export function sqlitePathFor(env = process.env) {
  if (env.DATABASE_PATH) return env.DATABASE_PATH;
  return resolve(repoRoot, 'data', 'regtech.sqlite');
}

export function defaultStorageDir(env = process.env) {
  return env.STORAGE_DIR || resolve(repoRoot, 'storage');
}

/**
 * Opens the configured database. Never falls back to a fake store in production:
 * when PostgreSQL is not configured while running in production the call rejects
 * with a DatabaseNotConfigured error that the HTTP layer reports honestly.
 */
export async function openDatabase(options = {}) {
  const env = options.env || process.env;
  const production = isProductionRuntime(env);
  if (isPostgresConfigured(env)) {
    const db = await openPostgres(env.DATABASE_URL, { env, pgModule: options.pg });
    await applyMigrations(db, options);
    db.dataMode = 'LIVE';
    return db;
  }
  if (production && options.path === undefined) {
    throw new DatabaseNotConfiguredError();
  }
  const path = options.path ?? sqlitePathFor(env);
  const seed = options.seed ?? (seedAllowed(env) && !options.noSeed);
  const db = await openSqlite(path);
  await applyMigrations(db, options);
  if (seed) await db.transaction(async (tx) => seedDatabase(tx));
  db.dataMode = seed ? DEMO_FIXTURES : 'LIVE_EMPTY';
  return db;
}

export class DatabaseNotConfiguredError extends Error {
  constructor() {
    super('Production persistence is not configured: set DATABASE_URL to a PostgreSQL connection string (Neon, Vercel Postgres, Supabase or compatible). SQLite is development-only and will not be used as production storage.');
    this.name = 'DATABASE_NOT_CONFIGURED';
    this.statusCode = 503;
    this.code = 'DATABASE_NOT_CONFIGURED';
  }
}

async function openSqlite(path) {
  const { DatabaseSync } = await import('node:sqlite');
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const handle = new DatabaseSync(path);
  handle.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (path !== ':memory:') handle.exec('PRAGMA journal_mode = WAL;');
  return {
    dialect: 'sqlite',
    path,
    prepare(sql) {
      const statement = handle.prepare(sql);
      return {
        async get(...params) { return normalizeRow(statement.get(...params)); },
        async all(...params) { return statement.all(...params).map(normalizeRow); },
        async run(...params) { return statement.run(...params); },
      };
    },
    async exec(sql) { handle.exec(sql); },
    async transaction(fn) {
      handle.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(this);
        handle.exec('COMMIT');
        return result;
      } catch (error) {
        try { handle.exec('ROLLBACK'); } catch { /* preserve the original error */ }
        throw error;
      }
    },
    async close() { try { handle.close(); } catch { /* already closed */ } },
  };
}

async function openPostgres(connectionString, { env, pgModule } = {}) {
  const pg = pgModule || await import('pg');
  // Keep the HTTP API contract identical across dialects: numeric counts as numbers,
  // timestamps as ISO strings and dates as YYYY-MM-DD strings.
  pg.types.setTypeParser(20, (value) => (value === null ? null : Number(value)));           // int8 / COUNT(*)
  pg.types.setTypeParser(1184, (value) => (value ? new Date(value).toISOString() : value)); // timestamptz
  pg.types.setTypeParser(1114, (value) => (value ? new Date(`${value}Z`).toISOString() : value)); // timestamp
  pg.types.setTypeParser(1082, (value) => value); // date stays 'YYYY-MM-DD'
  const pool = new pg.Pool({
    connectionString,
    max: Number(env.PG_POOL_MAX || 3),
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    application_name: 'lcf-regtech',
  });
  await pool.query('SELECT 1');
  const db = {
    dialect: 'postgres',
    // prepare() is synchronous (mirrors the SQLite driver): callers do `db.prepare(sql).get(...)`.
    prepare(sql) {
      const text = toPgParams(sql);
      return {
        async get(...params) { const result = await pool.query(text, params); return normalizeRow(result.rows[0]); },
        async all(...params) { const result = await pool.query(text, params); return result.rows.map(normalizeRow); },
        async run(...params) { const result = await pool.query(text, params); return { changes: result.rowCount ?? 0 }; },
      };
    },
    async exec(sql) { await pool.query(toPgParams(sql)); },
    async transaction(fn) {
      const client = await pool.connect();
      const tx = createTransactionHandle(client);
      try {
        await client.query('BEGIN');
        const result = await fn(tx);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* preserve the original error */ }
        throw error;
      } finally {
        client.release();
      }
    },
    async close() { await pool.end(); },
  };
  return db;
}

function createTransactionHandle(client) {
  return {
    dialect: 'postgres',
    prepare(sql) {
      const text = toPgParams(sql);
      return {
        async get(...params) { const result = await client.query(text, params); return normalizeRow(result.rows[0]); },
        async all(...params) { const result = await client.query(text, params); return result.rows.map(normalizeRow); },
        async run(...params) { const result = await client.query(text, params); return { changes: result.rowCount ?? 0 }; },
      };
    },
    async exec(sql) { await client.query(toPgParams(sql)); },
    async transaction(fn) { return fn(this); },
  };
}

/**
 * Rewrites `?` placeholders into PostgreSQL `$n` parameters, skipping string
 * literals and quoted identifiers. Exported for tests.
 */
export function toPgParams(sql) {
  let index = 0;
  let out = '';
  let state = 'sql';
  for (let position = 0; position < sql.length; position += 1) {
    const char = sql[position];
    if (state === 'sql') {
      if (char === "'") { state = 'single'; out += char; continue; }
      if (char === '"') { state = 'double'; out += char; continue; }
      if (char === '-' && sql[position + 1] === '-') { state = 'line'; out += char; continue; }
      if (char === '/' && sql[position + 1] === '*') { state = 'block'; out += char; continue; }
      if (char === '?') { index += 1; out += `$${index}`; continue; }
      out += char;
    } else if (state === 'block') {
      out += char;
      if (char === '*' && sql[position + 1] === '/') { out += '/'; position += 1; state = 'sql'; }
      continue;
    } else if (state === 'single') {
      out += char;
      if (char === "'") {
        if (sql[position + 1] === "'") { out += "'"; position += 1; }
        else state = 'sql';
      }
    } else if (state === 'double') {
      out += char;
      if (char === '"') state = 'sql';
    } else if (state === 'line') {
      out += char;
      if (char === '\n') state = 'sql';
    }
  }
  return out;
}

function normalizeRow(row) {
  if (!row) return row;
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] = value instanceof Uint8Array && !Buffer.isBuffer(value) ? Buffer.from(value) : value;
  }
  return out;
}

export async function applyMigrations(db, options = {}) {
  await db.exec(db.dialect === 'sqlite'
    ? 'CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL);'
    : 'CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL);');
  const migrationDir = resolve(MIGRATIONS_ROOT, db.dialect);
  const files = readdirSync(migrationDir).filter((file) => /^\d+_[a-z0-9_-]+\.sql$/i.test(file)).sort();
  const applied = [];
  for (const migration of files) {
    const already = await db.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(migration);
    if (already) continue;
    if (options.offline === true && db.dialect === 'postgres') continue;
    const sql = readFileSync(resolve(migrationDir, migration), 'utf8');
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(migration, new Date().toISOString());
    });
    applied.push(migration);
  }
  return applied;
}

export async function closeDatabase(db) {
  try { if (db) await db.close(); } catch { /* already closed */ }
}
