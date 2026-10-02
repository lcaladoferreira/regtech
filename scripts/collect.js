#!/usr/bin/env node
/**
 * Manual collection runner (same code path as the Vercel Cron job):
 *
 *   npm run collect                       # poll sources that are due
 *   npm run collect -- --all              # force-check all enabled sources
 *   npm run collect -- --limit=5          # cap the number of sources this run
 *   CRON_SECRET=… ADMIN_API_KEY=… for auth on the HTTP endpoint (not needed in CLI mode)
 */
import { openDatabase, closeDatabase } from '../src/db.js';
import { runCollectSources } from '../src/engines/ingestion.js';

const args = process.argv.slice(2);
const all = args.includes('--all');
const limitArg = args.find((arg) => arg.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : 25;

const db = await openDatabase();
try {
  const result = await runCollectSources(db, { dueOnly: !all, limit, trigger: 'cli' });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await closeDatabase(db);
}
