import { createHash, createHmac, randomUUID } from 'node:crypto';

const DELIVERY_MODES = new Set(['IMMEDIATE','DAILY']);
const TOPICS = new Set(['ALL','NORMS','LAYOUTS','MANUALS','DEADLINES','GENERAL']);

export function alertEmailConfigured(env = process.env) {
  return Boolean(String(env.RESEND_API_KEY || '').trim() && String(env.ALERT_FROM_EMAIL || '').trim());
}

export async function publicAlertConfig(db, env = process.env) {
  const regulators = await db.prepare(`SELECT acronym, name FROM regulators WHERE active = 1 ORDER BY acronym`).all();
  return {
    email_delivery_configured: alertEmailConfigured(env),
    confirmation_required: true,
    delivery_modes: [
      { id: 'IMMEDIATE', label: 'Quando houver mudança detectada' },
      { id: 'DAILY', label: 'Resumo diário' },
    ],
    authorities: regulators.map((row) => ({ id: String(row.acronym || '').toUpperCase(), name: row.name })),
    topics: [
      { id: 'ALL', label: 'Todas as mudanças' },
      { id: 'NORMS', label: 'Normas e atos' },
      { id: 'LAYOUTS', label: 'Layouts e schemas' },
      { id: 'MANUALS', label: 'Manuais técnicos' },
      { id: 'DEADLINES', label: 'Prazos e calendários' },
      { id: 'GENERAL', label: 'Outras fontes oficiais' },
    ],
  };
}

export async function subscribeToAlerts(db, body = {}, env = process.env) {
  const email = normalizeEmail(body.email);
  if (!email) throw alertError('Informe um e-mail válido.', 400, 'INVALID_EMAIL');
  if (!truthy(body.consent)) throw alertError('É necessário consentir com o recebimento dos alertas.', 400, 'CONSENT_REQUIRED');

  const deliveryMode = String(body.delivery_mode || 'IMMEDIATE').toUpperCase();
  if (!DELIVERY_MODES.has(deliveryMode)) throw alertError('Modo de entrega inválido.', 400, 'INVALID_DELIVERY_MODE');

  const config = await publicAlertConfig(db, env);
  const allowedAuthorities = new Set(config.authorities.map((row) => row.id));
  const authorities = normalizeList(body.authorities).map((value) => value.toUpperCase()).filter((value) => allowedAuthorities.has(value));
  const topics = normalizeList(body.topics).map((value) => value.toUpperCase()).filter((value) => TOPICS.has(value));
  const selectedAuthorities = authorities.length ? [...new Set(authorities)] : ['*'];
  const selectedTopics = topics.length ? [...new Set(topics)] : ['ALL'];

  const existing = await db.prepare('SELECT id FROM alert_subscribers WHERE email = ?').get(email);
  const id = existing?.id || randomUUID();
  const token = manageToken(id, email, env);
  const tokenHash = sha256(token);
  const now = new Date().toISOString();

  await db.prepare(`INSERT INTO alert_subscribers
    (id,email,status,delivery_mode,authorities_json,topics_json,manage_token_hash,consent_at,confirmed_at,unsubscribed_at,last_digest_at,created_at,updated_at)
    VALUES (?,?,'PENDING',?,?,?,?,?,NULL,NULL,NULL,?,?)
    ON CONFLICT(email) DO UPDATE SET
      status='PENDING', delivery_mode=excluded.delivery_mode, authorities_json=excluded.authorities_json,
      topics_json=excluded.topics_json, manage_token_hash=excluded.manage_token_hash, consent_at=excluded.consent_at,
      confirmed_at=NULL, unsubscribed_at=NULL, last_digest_at=NULL, updated_at=excluded.updated_at`)
    .run(id, email, deliveryMode, JSON.stringify(selectedAuthorities), JSON.stringify(selectedTopics), tokenHash, now, now, now);

  let confirmationSent = false;
  if (alertEmailConfigured(env)) {
    try {
      await sendConfirmationEmail({ id, email, token, deliveryMode, authorities: selectedAuthorities, topics: selectedTopics }, env);
      confirmationSent = true;
    } catch (error) {
      console.error(JSON.stringify({ level:'error', component:'alerts', action:'confirmation', message:String(error?.message || error) }));
    }
  }

  return {
    status: 'PENDING_CONFIRMATION',
    email,
    confirmation_sent: confirmationSent,
    email_delivery_configured: alertEmailConfigured(env),
    message: confirmationSent
      ? 'Confira seu e-mail e confirme a inscrição para começar a receber alertas.'
      : 'A preferência foi registrada, mas o canal de e-mail ainda não está configurado para enviar a confirmação.',
  };
}

export async function confirmAlertSubscription(db, token) {
  const tokenHash = sha256(String(token || ''));
  const subscriber = await db.prepare('SELECT * FROM alert_subscribers WHERE manage_token_hash = ?').get(tokenHash);
  if (!subscriber) throw alertError('Link de confirmação inválido.', 404, 'ALERT_TOKEN_NOT_FOUND');
  const now = new Date().toISOString();
  await db.prepare(`UPDATE alert_subscribers SET status='ACTIVE', confirmed_at=COALESCE(confirmed_at, ?),
    unsubscribed_at=NULL, updated_at=? WHERE id=?`).run(now, now, subscriber.id);
  return { ...safeSubscriber(subscriber), status:'ACTIVE', confirmed_at: subscriber.confirmed_at || now };
}

export async function unsubscribeAlertSubscription(db, token) {
  const tokenHash = sha256(String(token || ''));
  const subscriber = await db.prepare('SELECT * FROM alert_subscribers WHERE manage_token_hash = ?').get(tokenHash);
  if (!subscriber) throw alertError('Link de cancelamento inválido.', 404, 'ALERT_TOKEN_NOT_FOUND');
  const now = new Date().toISOString();
  await db.prepare(`UPDATE alert_subscribers SET status='UNSUBSCRIBED', unsubscribed_at=?, updated_at=? WHERE id=?`)
    .run(now, now, subscriber.id);
  return { ...safeSubscriber(subscriber), status:'UNSUBSCRIBED', unsubscribed_at:now };
}

export async function dispatchImmediateAlerts(db, env = process.env) {
  return dispatchAlerts(db, 'IMMEDIATE', env);
}

export async function dispatchDailyAlerts(db, env = process.env) {
  return dispatchAlerts(db, 'DAILY', env);
}

async function dispatchAlerts(db, deliveryType, env) {
  if (!alertEmailConfigured(env)) {
    return { status:'SKIPPED', reason:'EMAIL_NOT_CONFIGURED', delivery_type:deliveryType, subscribers:0, sent:0, changes:0, failed:0 };
  }
  const subscribers = await db.prepare(`SELECT * FROM alert_subscribers
    WHERE status='ACTIVE' AND delivery_mode=? ORDER BY created_at`).all(deliveryType);
  const result = { status:'SUCCEEDED', delivery_type:deliveryType, subscribers:subscribers.length, sent:0, changes:0, failed:0 };

  for (const subscriber of subscribers) {
    const since = deliveryType === 'DAILY'
      ? (subscriber.last_digest_at || subscriber.confirmed_at || subscriber.created_at)
      : (subscriber.confirmed_at || subscriber.created_at);
    const rows = await db.prepare(`SELECT c.id,c.summary,c.change_type,c.diff_summary,c.detected_at,c.source_url,c.change_level,
        s.source_title,s.source_type,s.source_authority,s.authority,s.regulator_id,r.acronym AS regulator_acronym
      FROM regulatory_changes c
      JOIN regulatory_sources s ON c.entity_type='SOURCE' AND s.id=c.entity_id
      LEFT JOIN regulators r ON r.id=s.regulator_id
      WHERE c.is_demo=0 AND c.change_level='SOURCE_CHANGED'
        AND c.previous_snapshot_id IS NOT NULL AND c.current_snapshot_id IS NOT NULL
        AND c.detected_at >= ?
        AND NOT EXISTS (
          SELECT 1 FROM alert_deliveries d
          WHERE d.subscriber_id=? AND d.change_id=c.id AND d.delivery_type=? AND d.status='SENT'
        )
      ORDER BY c.detected_at ASC LIMIT 100`).all(since, subscriber.id, deliveryType);

    const matched = rows.filter((row) => matchesPreferences(subscriber, row));
    if (!matched.length) {
      if (deliveryType === 'DAILY') {
        await db.prepare('UPDATE alert_subscribers SET last_digest_at=?, updated_at=? WHERE id=?')
          .run(new Date().toISOString(), new Date().toISOString(), subscriber.id);
      }
      continue;
    }

    try {
      const token = manageToken(subscriber.id, subscriber.email, env);
      const sent = await sendChangesEmail(subscriber, matched, deliveryType, token, env);
      const sentAt = new Date().toISOString();
      for (const change of matched) {
        await recordDelivery(db, subscriber.id, change.id, deliveryType, 'SENT', sent.id || null, sentAt, null);
      }
      if (deliveryType === 'DAILY') {
        await db.prepare('UPDATE alert_subscribers SET last_digest_at=?, updated_at=? WHERE id=?').run(sentAt, sentAt, subscriber.id);
      }
      result.sent += 1;
      result.changes += matched.length;
    } catch (error) {
      result.failed += 1;
      result.status = result.sent ? 'PARTIAL' : 'FAILED';
      const message = String(error?.message || error).slice(0,700);
      for (const change of matched) {
        await recordDelivery(db, subscriber.id, change.id, deliveryType, 'FAILED', null, null, message);
      }
      console.error(JSON.stringify({ level:'error', component:'alerts', action:'dispatch', subscriber_id:subscriber.id, message }));
    }
  }
  return result;
}

async function recordDelivery(db, subscriberId, changeId, deliveryType, status, providerMessageId, sentAt, error) {
  await db.prepare(`INSERT INTO alert_deliveries
    (id,subscriber_id,change_id,delivery_type,status,provider_message_id,sent_at,error,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(subscriber_id,change_id,delivery_type) DO UPDATE SET
      status=excluded.status, provider_message_id=excluded.provider_message_id,
      sent_at=excluded.sent_at, error=excluded.error`)
    .run(randomUUID(), subscriberId, changeId, deliveryType, status, providerMessageId, sentAt, error, new Date().toISOString());
}

function matchesPreferences(subscriber, change) {
  const authorities = parseList(subscriber.authorities_json, ['*']);
  const topics = parseList(subscriber.topics_json, ['ALL']);
  const authority = String(change.authority || change.regulator_acronym || change.regulator_id || '').toUpperCase();
  if (!authorities.includes('*') && !authorities.includes(authority)) return false;
  const topic = topicForSourceType(change.source_type);
  return topics.includes('ALL') || topics.includes(topic);
}

function topicForSourceType(sourceType) {
  const type = String(sourceType || '').toUpperCase();
  if (type.includes('LAYOUT') || type.includes('SCHEMA')) return 'LAYOUTS';
  if (type.includes('DEADLINE') || type.includes('CALENDAR')) return 'DEADLINES';
  if (type.includes('MANUAL')) return 'MANUALS';
  if (['RESOLUTION','LAW','REGULATION','INSTRUCTION','NORM','CIRCULAR'].some((value) => type.includes(value))) return 'NORMS';
  return 'GENERAL';
}

async function sendConfirmationEmail(subscriber, env) {
  const base = publicBaseUrl(env);
  const confirmUrl = `${base}/alertas/confirmar?token=${encodeURIComponent(subscriber.token)}`;
  const cancelUrl = `${base}/alertas/cancelar?token=${encodeURIComponent(subscriber.token)}`;
  const authorityText = subscriber.authorities.includes('*') ? 'todos os órgãos monitorados' : subscriber.authorities.join(', ');
  const modeText = subscriber.deliveryMode === 'DAILY' ? 'resumo diário' : 'quando houver mudança detectada';
  return sendEmail({
    to:subscriber.email,
    subject:'Confirme seus alertas — LCF RegTech',
    text:`Confirme sua inscrição no LCF RegTech: ${confirmUrl}\n\nPreferências: ${authorityText}; ${modeText}.\n\nCancelar: ${cancelUrl}`,
    html:`<div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;color:#203449"><p style="font-size:12px;letter-spacing:.08em;font-weight:700">LCF REGTECH · ALERTAS</p><h1 style="font-size:24px">Confirme sua inscrição</h1><p>Você pediu alertas sobre <strong>${escapeHtml(authorityText)}</strong>, com entrega <strong>${escapeHtml(modeText)}</strong>.</p><p><a href="${escapeAttr(confirmUrl)}" style="display:inline-block;padding:11px 16px;background:#0d8b83;color:#fff;text-decoration:none;border-radius:6px;font-weight:700">CONFIRMAR ALERTAS</a></p><p style="color:#66788b;font-size:12px">O LCF RegTech envia alertas baseados em mudanças detectadas em fontes oficiais. Detecção de conteúdo não equivale automaticamente a mudança jurídica confirmada.</p><p style="font-size:11px"><a href="${escapeAttr(cancelUrl)}">Cancelar inscrição</a></p></div>`,
  }, env);
}

async function sendChangesEmail(subscriber, changes, deliveryType, token, env) {
  const base = publicBaseUrl(env);
  const authorities = [...new Set(changes.map((change) => String(change.authority || change.regulator_acronym || change.regulator_id || 'Fonte oficial').toUpperCase()))];
  const subject = changes.length === 1
    ? `[LCF RegTech] ${authorities[0]} — mudança detectada em ${truncate(changes[0].source_title,70)}`
    : `[LCF RegTech] ${changes.length} mudanças detectadas — ${authorities.slice(0,4).join(', ')}`;
  const heading = deliveryType === 'DAILY' ? 'Resumo diário de mudanças' : 'Mudanças detectadas';
  const listHtml = changes.map((change) => {
    const authority = String(change.authority || change.regulator_acronym || change.regulator_id || 'Fonte oficial').toUpperCase();
    const link = `${base}/mudancas/${encodeURIComponent(change.id)}`;
    return `<div style="border:1px solid #e1e7ed;border-radius:7px;padding:14px;margin:12px 0"><div style="font-size:11px;font-weight:800;color:#0d8b83">${escapeHtml(authority)} · MUDANÇA DETECTADA</div><h2 style="font-size:16px;margin:6px 0">${escapeHtml(change.source_title || 'Fonte oficial')}</h2><p style="font-size:13px;line-height:1.55;color:#51677c">${escapeHtml(change.diff_summary || change.summary || 'O conteúdo da fonte oficial mudou.')}</p><a href="${escapeAttr(link)}" style="font-size:12px;font-weight:700;color:#0d7770">Ver evidências e comparação →</a></div>`;
  }).join('');
  const cancelUrl = `${base}/alertas/cancelar?token=${encodeURIComponent(token)}`;
  const consultingUrl = 'https://www.lcfconsulting.com.br/?utm_source=regtech&utm_medium=email&utm_campaign=lcf_regtech_alerts';
  const text = changes.map((change) => `${change.authority || change.regulator_acronym || ''} — ${change.source_title}\n${change.diff_summary || change.summary || ''}\n${base}/mudancas/${change.id}`).join('\n\n');
  return sendEmail({
    to:subscriber.email,
    subject,
    text:`${heading}\n\n${text}\n\nAplicar a inteligência à sua organização: ${consultingUrl}\nCancelar: ${cancelUrl}`,
    html:`<div style="font-family:Arial,sans-serif;max-width:680px;margin:auto;color:#203449"><p style="font-size:12px;letter-spacing:.08em;font-weight:700">LCF REGTECH · REGULATORY DATA INTELLIGENCE</p><h1 style="font-size:24px">${escapeHtml(heading)}</h1><p style="font-size:13px;color:#66788b">O conteúdo de uma ou mais fontes oficiais mudou. Isso não confirma, por si só, uma alteração regulatória material.</p>${listHtml}<div style="border-left:3px solid #0d8b83;padding:12px 14px;margin-top:20px;background:#f8fbfb"><strong>Isso afeta sua operação?</strong><p style="font-size:13px">A LCF Consulting conecta mudanças regulatórias a processos, dados, sistemas e controles da organização.</p><a href="${escapeAttr(consultingUrl)}" style="font-size:12px;font-weight:700;color:#0d7770">Falar com a LCF Consulting →</a></div><p style="font-size:11px;color:#7b8997;margin-top:24px"><a href="${escapeAttr(cancelUrl)}">Cancelar alertas</a></p></div>`,
  }, env);
}

async function sendEmail(message, env) {
  if (!alertEmailConfigured(env)) throw new Error('Email delivery is not configured.');
  const response = await fetch('https://api.resend.com/emails', {
    method:'POST',
    headers:{ Authorization:`Bearer ${String(env.RESEND_API_KEY).trim()}`, 'Content-Type':'application/json' },
    body:JSON.stringify({
      from:String(env.ALERT_FROM_EMAIL).trim(),
      to:[message.to],
      subject:message.subject,
      html:message.html,
      text:message.text,
      ...(String(env.ALERT_REPLY_TO || '').trim() ? { reply_to:String(env.ALERT_REPLY_TO).trim() } : {}),
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Email provider returned HTTP ${response.status}: ${payload?.message || 'delivery failed'}`);
  return payload;
}

function manageToken(id, email, env) {
  const secret = String(env.ALERT_TOKEN_SECRET || env.CRON_SECRET || env.ADMIN_API_KEY || '').trim();
  if (!secret) throw alertError('Alert token secret is not configured.', 503, 'ALERT_TOKEN_SECRET_NOT_CONFIGURED');
  return createHmac('sha256', secret).update(`${id}:${email}`).digest('base64url');
}

function publicBaseUrl(env) {
  const fallback = 'https://regtech-umber.vercel.app';
  try {
    const url = new URL(String(env.PUBLIC_SITE_URL || fallback));
    return url.origin;
  } catch {
    return fallback;
  }
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}
function normalizeList(value) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return [];
}
function parseList(value, fallback) {
  try { const parsed = JSON.parse(String(value || '')); return Array.isArray(parsed) ? parsed.map(String) : fallback; }
  catch { return fallback; }
}
function truthy(value) { return value === true || value === 'true' || value === 'on' || value === 1 || value === '1'; }
function sha256(value) { return createHash('sha256').update(String(value)).digest('hex'); }
function truncate(value, max) { const text=String(value || 'Fonte oficial'); return text.length > max ? `${text.slice(0,max-1)}…` : text; }
function safeSubscriber(row) {
  return { id:row.id,email:row.email,status:row.status,delivery_mode:row.delivery_mode,
    authorities:parseList(row.authorities_json,['*']),topics:parseList(row.topics_json,['ALL']),
    consent_at:row.consent_at,confirmed_at:row.confirmed_at,unsubscribed_at:row.unsubscribed_at };
}
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])); }
function escapeAttr(value) { return escapeHtml(value); }
function alertError(message,statusCode,code) { const error=new Error(message); error.statusCode=statusCode; error.code=code; return error; }
