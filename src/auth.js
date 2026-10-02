/**
 * Administrative authentication.
 *
 * Rule: every mutating endpoint (POST/PUT/DELETE) requires a bearer secret.
 *   - ADMIN_API_KEY guards manual ingestion, change registration, mapping/controls/evidence
 *     writes, internal deadlines, pipelines, retries and other administrative actions.
 *   - CRON_SECRET (Authorization: Bearer) is additionally accepted by POST /api/jobs/collect
 *     so Vercel Cron can trigger collection without exposing the admin key.
 *
 * In production the endpoints fail CLOSED (503) when the secret is not configured — writing
 * mutations are never left open. Outside production, requests are allowed when no ADMIN_API_KEY
 * is set so local development and automated tests stay practical.
 */
import { timingSafeEqual, createHash } from 'node:crypto';

function digest(value) {
  return createHash('sha256').update(String(value || '')).digest();
}

export function safeEquals(a, b) {
  if (!a || !b) return false; // empty/absent secrets never compare equal
  const left = digest(a);
  const right = digest(b);
  return timingSafeEqual(left, right);
}

export function bearerToken(req) {
  const header = req.headers?.authorization || req.headers?.Authorization || '';
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  if (match) return match[1].trim();
  const apiKey = req.headers?.['x-admin-key'];
  return apiKey ? String(apiKey).trim() : '';
}

export class AuthError extends Error {
  constructor(message, status, code) {
    super(message);
    this.statusCode = status;
    this.code = code;
  }
}

export function assertAdmin(req, { production, adminKey } = {}) {
  if (!adminKey) {
    if (production) {
      throw new AuthError('Administrative mutations are disabled because ADMIN_API_KEY is not configured. Set ADMIN_API_KEY in the deployment environment (fail-closed policy).', 503, 'AUTH_NOT_CONFIGURED');
    }
    return { actor: 'dev-unauthenticated', enforced: false };
  }
  const token = bearerToken(req);
  if (!token || !safeEquals(token, adminKey)) {
    throw new AuthError('Missing or invalid administrator credentials. Provide the Authorization: Bearer <ADMIN_API_KEY> header.', 401, 'ADMIN_AUTH_REQUIRED');
  }
  return { actor: 'admin', enforced: true };
}

export function assertCronOrAdmin(req, { production, adminKey, cronSecret } = {}) {
  if (!adminKey && !cronSecret) {
    if (production) {
      throw new AuthError('Cron ingestion is disabled because neither CRON_SECRET nor ADMIN_API_KEY is configured (fail-closed policy).', 503, 'AUTH_NOT_CONFIGURED');
    }
    return { actor: 'dev-cron', enforced: false };
  }
  const token = bearerToken(req);
  if (token && cronSecret && safeEquals(token, cronSecret)) return { actor: 'cron', enforced: true };
  if (token && adminKey && safeEquals(token, adminKey)) return { actor: 'admin', enforced: true };
  throw new AuthError('Missing or invalid bearer token for the collection job. Provide Authorization: Bearer <CRON_SECRET>.', 401, 'CRON_AUTH_REQUIRED');
}
