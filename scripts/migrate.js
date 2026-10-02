#!/usr/bin/env node
/**
 * Explicit, non-destructive migration runner.
 *
 *   npm run migrate                → uses DATABASE_URL (PostgreSQL) or local SQLite (dev)
 *   DATABASE_URL=postgres://… npm run migrate
 *
 * Migrations are additive (CREATE/ALTER ADD COLUMN/CREATE INDEX/CREATE TRIGGER). Destructive
 * migrations must be authored as separate numbered files and are never run implicitly by a
 * request handler; this script is the only automatic path and it refuses to run in production
 * against a missing/unreachable database (it never creates one).
 */
import { openDatabase, closeDatabase } from '../src/db.js';

const db = await openDatabase({ seed: false });
console.log(JSON.stringify({ dialect: db.dialect, migrations_expected: true }));
const applied = await db.prepare('SELECT version, applied_at FROM schema_migrations ORDER BY version').all();
console.log('Applied migrations:');
for (const row of applied) console.log(`  ${row.version} (${row.applied_at})`);
if (!applied.length) console.log('  (none recorded — check applyMigrations output above)');
await closeDatabase(db);
console.log(JSON.stringify({ status: 'ok', database: db.dialect }));
