// Öffentliche API für das Widget. Jede Anfrage enthält den Public Key (data-bot-id);
// daran erkennt der Server, zu welchem Unternehmen der Chat gehört.
import { Router } from 'express';
import QRCode from 'qrcode';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { config } from '../config.js';
import { applyCors, isOriginAllowed, preflight, requestOrigin } from '../middleware/security.js';
import { ChatError, handleChatTurn } from '../services/chat.js';
import { getTenantByKey, getTenantBySlug, publicWidgetConfig } from '../services/tenants.js';

export const publicRouter = Router();

publicRouter.options(/.*/, preflight);

/** Lädt den Mandanten zum Key und prüft die Herkunft der Anfrage. */
async function resolveTenant(req, res, key) {
  const origin = requestOrigin(req);
  const tenant = await getTenantByKey(key);
  if (!tenant) {
    res.status(404).json({ error: 'unknown_bot', message: 'Dieser Chat ist nicht verfügbar.' });
    return null;
  }
  if (!isOriginAllowed(tenant, origin)) {
    res.status(403).json({ error: 'origin_not_allowed', message: 'Dieser Chat ist für diese Website nicht freigeschaltet.' });
    return null;
  }
  if (req.headers.origin) applyCors(res, req.headers.origin);
  req.verifiedOrigin = origin;
  return tenant;
}

publicRouter.get('/widget/config', async (req, res) => {
  const tenant = await resolveTenant(req, res, req.query.key);
  if (!tenant) return;
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.json(publicWidgetConfig(tenant));
});

/** Für die gehostete Chat-Seite /c/<slug>: liefert den Public Key zum Slug. */
publicRouter.get('/hosted/:slug', async (req, res) => {
  const tenant = await getTenantBySlug(req.params.slug);
  if (!tenant) return res.status(404).json({ error: 'not_found' });
  res.json({ key: tenant.public_key, ...publicWidgetConfig(tenant) });
});

/** QR-Code zur gehosteten Chat-Seite (SVG), z. B. für Visitenkarte, Flyer oder Schaufenster. */
publicRouter.get('/hosted/:slug/qr.svg', async (req, res) => {
  const tenant = await getTenantBySlug(req.params.slug);
  if (!tenant) return res.status(404).end();
  const svg = await QRCode.toString(`${config.publicUrl}/c/${tenant.slug}`, {
    type: 'svg', margin: 2, errorCorrectionLevel: 'M', color: { dark: '#1b2a3a', light: '#ffffff' },
  });
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  if (req.query.download) res.setHeader('Content-Disposition', `attachment; filename="qr-${tenant.slug}.svg"`);
  res.send(svg);
});

const chatLimiter = rateLimit({
  windowMs: 60_000,
  limit: config.chat.perMinuteLimit,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip)}:${req.body?.key || ''}`,
  handler: (req, res) => {
    applyCors(res, req.headers.origin);
    res.status(429).json({ error: 'rate_limited', message: 'Zu viele Nachrichten in kurzer Zeit. Bitte warten Sie einen Moment.' });
  },
});

/**
 * Chat-Nachricht senden. Antwort kommt als Server-Sent Events:
 *   meta {conversationId} · delta {text} · lead {kind} · emergency · error {message} · done
 */
publicRouter.post('/chat', chatLimiter, async (req, res) => {
  const { key, conversationId, visitorId, message } = req.body || {};
  const tenant = await resolveTenant(req, res, key);
  if (!tenant) return;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const abort = new AbortController();
  res.on('close', () => abort.abort());

  try {
    await handleChatTurn({
      tenant,
      conversationId: typeof conversationId === 'string' && /^[0-9a-f-]{36}$/i.test(conversationId) ? conversationId : null,
      visitorId: typeof visitorId === 'string' ? visitorId : null,
      origin: req.verifiedOrigin,
      message,
      emit,
      signal: abort.signal,
    });
  } catch (err) {
    if (abort.signal.aborted) return;
    const known = err instanceof ChatError;
    if (!known) console.error('[chat] Fehler:', err);
    emit('error', {
      code: known ? err.code : 'internal',
      message: known ? err.message : 'Entschuldigung, gerade gibt es ein technisches Problem. Bitte versuchen Sie es gleich noch einmal oder kontaktieren Sie uns direkt.',
    });
  }
  res.end();
});
