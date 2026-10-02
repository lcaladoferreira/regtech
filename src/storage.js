/**
 * Durable storage abstraction for raw official source bytes.
 *
 * Providers:
 *   blob       — Vercel Blob (requires BLOB_READ_WRITE_TOKEN). Preferred in production.
 *   database   — PostgreSQL BYTEA (storage_objects) / SQLite BLOB. Durable because the
 *                database itself is persistent; used when no blob token is provisioned.
 *   filesystem — local directory, DEVELOPMENT ONLY (production refuses it: /tmp is ephemeral).
 *
 * Snapshots are addressed by immutable keys: snapshots/<sourceId>/<sha256>[.<ext>].
 * save() never overwrites an existing key (first writer wins, content is content-addressed).
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { dirname, resolve, extname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isProductionRuntime, defaultStorageDir } from './db.js';

export class StorageUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'STORAGE_UNAVAILABLE';
    this.code = 'STORAGE_UNAVAILABLE';
    this.statusCode = 503;
  }
}

export function resolveStorageProvider(env = process.env, dialect = 'sqlite') {
  const explicit = String(env.STORAGE_PROVIDER || '').trim().toLowerCase();
  if (explicit) return assertProductionSafe(explicit, env);
  if (env.BLOB_READ_WRITE_TOKEN) return 'blob';
  if (isProductionRuntime(env)) return 'database';
  return 'filesystem';
}

function assertProductionSafe(provider, env) {
  if (provider === 'filesystem' && isProductionRuntime(env) && env.ALLOW_FS_STORAGE_DEV !== '1') {
    throw new StorageUnavailableError('Filesystem storage is only allowed outside production. Configure Vercel Blob (BLOB_READ_WRITE_TOKEN) or the database provider; /tmp is ephemeral on Vercel and will silently lose snapshots.');
  }
  if (!['blob', 'database', 'filesystem'].includes(provider)) {
    throw new StorageUnavailableError(`Unknown STORAGE_PROVIDER "${provider}" (expected blob, database or filesystem).`);
  }
  return provider;
}

const EXTENSIONS = {
  'text/html': '.html', 'application/json': '.json', 'text/csv': '.csv', 'application/csv': '.csv',
  'application/pdf': '.pdf', 'application/xml': '.xml', 'text/xml': '.xml', 'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx', 'application/zip': '.zip',
  'text/plain': '.txt', 'application/octet-stream': '',
};

export function snapshotKey(sourceId, sha256, mimeType) {
  const ext = EXTENSIONS[String(mimeType || '').split(';')[0]] ?? extname(String(mimeType || '')) ?? '';
  return `snapshots/${String(sourceId).replace(/[^a-zA-Z0-9._-]/g, '_')}/${sha256}${ext}`;
}

export async function createStorage({ env = process.env, db } = {}) {
  const provider = resolveStorageProvider(env, db?.dialect);
  if (provider === 'blob') return createBlobStorage(env);
  if (provider === 'database') return createDatabaseStorage(db);
  return createFilesystemStorage(env.STORAGE_DIR || defaultStorageDir(env));
}

function describe(base) {
  return { ...base, readOnly: false };
}

async function createBlobStorage(env) {
  if (!env.BLOB_READ_WRITE_TOKEN) {
    throw new StorageUnavailableError('STORAGE_PROVIDER=blob requires BLOB_READ_WRITE_TOKEN.');
  }
  let blob;
  try {
    blob = await import('@vercel/blob');
  } catch {
    throw new StorageUnavailableError('The @vercel/blob package is not installed; run `npm install` or use STORAGE_PROVIDER=database.');
  }
  return describe({
    provider: 'blob',
    async save(key, bytes, { contentType = 'application/octet-stream' } = {}) {
      const uploaded = await blob.put(key, bytes, {
        access: 'public',
        contentType,
        addRandomSuffix: false,
        allowOverwrite: false,
      });
      return { provider: 'blob', key, url: uploaded.url, size: bytes.length };
    },
    async read(key) {
      const url = key.startsWith('https://') ? key : undefined;
      if (!url) {
        const listed = await blob.head(key);
        return blob.download(listed.url);
      }
      return blob.download(url);
    },
    async exists(key) {
      try { await blob.head(key); return true; } catch { return false; }
    },
  });
}

function createDatabaseStorage(db) {
  if (!db) throw new StorageUnavailableError('STORAGE_PROVIDER=database requires an open database handle.');
  return describe({
    provider: 'database',
    dialect: db.dialect,
    async save(key, bytes, { contentType = 'application/octet-stream' } = {}) {
      await db.prepare(`INSERT INTO storage_objects (key, content_type, sha256, size_bytes, created_at, content)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (key) DO NOTHING`)
        .run(key, contentType.split(';')[0], hashHex(bytes), bytes.length, new Date().toISOString(), Buffer.from(bytes));
      return { provider: 'database', key: `db:${key}`, size: bytes.length };
    },
    async read(key) {
      const name = String(key).replace(/^db:/, '');
      const row = await db.prepare('SELECT content FROM storage_objects WHERE key = ?').get(name);
      return row ? Buffer.from(row.content) : null;
    },
    async exists(key) {
      const name = String(key).replace(/^db:/, '');
      return Boolean(await db.prepare('SELECT key FROM storage_objects WHERE key = ?').get(name));
    },
  });
}

function createFilesystemStorage(baseDir) {
  const root = resolve(baseDir);
  return describe({
    provider: 'filesystem',
    root,
    async save(key, bytes, { contentType = 'application/octet-stream' } = {}) {
      const target = resolve(root, key);
      if (!target.startsWith(root)) throw new Error('Storage key escaped the snapshot root.');
      if (existsQuiet(target)) return { provider: 'filesystem', key: `fs:${key}`, size: bytes.length, alreadyPresent: true };
      mkdirSync(dirname(target), { recursive: true });
      const tmp = `${target}.${randomUUID()}.tmp`;
      writeFileSync(tmp, bytes);
      renameSync(tmp, target);
      return { provider: 'filesystem', key: `fs:${key}`, size: bytes.length };
    },
    async read(key) {
      const target = resolve(root, String(key).replace(/^fs:/, ''));
      if (!target.startsWith(root)) throw new Error('Storage key escaped the snapshot root.');
      return existsQuiet(target) ? readFileSync(target) : null;
    },
    async exists(key) {
      const target = resolve(root, String(key).replace(/^fs:/, ''));
      return target.startsWith(root) && existsQuiet(target);
    },
  });
}

function existsQuiet(path) {
  try { return statSync(path).isFile(); } catch { return false; }
}

function hashHex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
