/**
 * Vercel Serverless entry point (single function gateway for /api/*, routed by vercel.json
 * rewrites — same shape proven by the previous production deployments of this project).
 *
 * Persistence rules on Vercel:
 * - Production data lives ONLY in PostgreSQL (DATABASE_URL). Never SQLite, never /tmp.
 * - If DATABASE_URL is missing or unreachable the function still answers /api/health with a
 *   degraded status and returns 503 on data routes — it never fabricates data and never
 *   silently falls back to a synthetic store.
 * - The database handle is opened once per warm instance (lazily); migrations are additive-only.
 */
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/db.js';
import { handleApi, handlePublicPage } from '../src/server.js';

let bootstrap = null;
export function getBootstrap() {
  if (!bootstrap) {
    bootstrap = openDatabase()
      .then((db) => ({ db, error: null }))
      .catch((error) => ({ db: null, error }));
  }
  return bootstrap;
}

export default async function handler(req, res) {
  const base = `https://${req.headers.host || 'localhost'}`;
  const rewritten = new URL(req.url || '/api', base);
  const pagePath = rewritten.searchParams.get('__page');
  const requestId = randomUUID();
  const { db, error: dbError } = await getBootstrap();

  try {
    if (pagePath) {
      const pageUrl = new URL(pagePath, base);
      for (const [key, value] of rewritten.searchParams.entries()) if (key !== '__page' && key !== '__path') pageUrl.searchParams.set(key, value);
      const handled = await handlePublicPage(req, res, db, pageUrl, requestId);
      if (!handled && !res.headersSent) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('X-Robots-Tag', 'noindex, nofollow');
        res.end('Not found.');
      }
      return;
    }
    const path = rewritten.searchParams.get('__path') || '';
    rewritten.searchParams.delete('__path');
    rewritten.pathname = path ? `/api/${path}` : '/api';
    await handleApi(req, res, db, rewritten, requestId);
  } catch (error) {
    if (res.headersSent) return;
    const status = Number(error?.statusCode) || 500;
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({
      error: error?.code || 'INTERNAL_ERROR',
      message: error?.message || 'Unexpected server error.',
      database_error: dbError ? String(dbError.message || dbError) : null,
      request_id: requestId,
      timestamp: new Date().toISOString(),
    }));
  }
}
