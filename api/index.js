import { randomUUID } from 'node:crypto';
import { createDatabase } from '../src/db.js';
import { handleApi } from '../src/server.js';

const db = createDatabase();

export default async function handler(req, res) {
  const base = `https://${req.headers.host || 'localhost'}`;
  const rewritten = new URL(req.url || '/api', base);
  const path = rewritten.searchParams.get('__path') || '';
  rewritten.searchParams.delete('__path');
  rewritten.pathname = path ? `/api/${path}` : '/api';

  const requestId = randomUUID();

  try {
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
      request_id: requestId,
      timestamp: new Date().toISOString()
    }));
  }
}
