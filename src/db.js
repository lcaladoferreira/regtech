import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedDatabase } from './seed.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
export const DATABASE_PATH = resolve(repoRoot, 'data', 'regtech.sqlite');

export function createDatabase(path = DATABASE_PATH, { seed = true } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  applyMigrations(db);
  if (seed) seedDatabase(db);
  return db;
}

export function applyMigrations(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  );`);
  const migrationDir = resolve(repoRoot, 'migrations');
  const files = readdirSync(migrationDir).filter((file) => /^\d+_[a-z0-9_-]+\.sql$/i.test(file)).sort();
  const appliedMigrations = [];
  for (const migration of files) {
    if (db.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(migration)) continue;
    const sql = readFileSync(resolve(migrationDir, migration), 'utf8');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(migration, new Date().toISOString());
      db.exec('COMMIT');
      appliedMigrations.push(migration);
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* preserve the migration error */ }
      throw error;
    }
  }
  return appliedMigrations;
}

export function closeDatabase(db) {
  try { db.close(); } catch { /* already closed */ }
}
