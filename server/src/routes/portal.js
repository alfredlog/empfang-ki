// Kunden-Dashboard-API (/api/portal). Anmeldung per Magic Link, danach Session-Cookie.
// Die Kunden-ID kommt ausschließlich aus der Sitzung – nie aus der Anfrage.
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config.js';
import {
  SESSION_COOKIE, destroySession, getSession, normalizeEmail, readCookie, requestLogin,
} from '../services/auth.js';
import { PLANS } from '../services/tenants.js';
import { listIndustries } from '../templates/industries.js';
import { buildTenantRouter } from './tenant-scope.js';

export const portalRouter = Router();
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * Schutz gegen Cross-Site-Anfragen (CSRF): Ändernde Anfragen müssen von unserer eigenen Seite kommen.
 * Zusätzlich ist das Cookie SameSite=Lax und die API erwartet JSON.
 */
function sameOriginOnly(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  const ok = origin ? origin === config.publicUrl : req.headers['sec-fetch-site'] === 'same-origin';
  if (!ok) return res.status(403).json({ error: 'forbidden', message: 'Ungültige Herkunft der Anfrage.' });
  next();
}
portalRouter.use(sameOriginOnly);

// Login-Link anfordern – pro IP und pro Adresse begrenzt
const loginIpLimit = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false });
const loginMailLimit = rateLimit({
  windowMs: 15 * 60_000, limit: 3, keyGenerator: (req) => `mail:${normalizeEmail(req.body?.email)}`,
  handler: (req, res) => res.json({ ok: true }), // gleiche Antwort, keine Infos preisgeben
});

portalRouter.post('/login', loginIpLimit, loginMailLimit, asyncRoute(async (req, res) => {
  const { email, next } = z.object({ email: z.email(), next: z.string().max(200).optional() }).parse(req.body);
  try {
    await requestLogin(email, next);
  } catch (err) {
    console.error('[login] Mailversand fehlgeschlagen:', err.message);
  }
  // Immer dieselbe Antwort – verrät nicht, ob es die Adresse gibt
  res.json({ ok: true });
}));

portalRouter.post('/logout', asyncRoute(async (req, res) => {
  await destroySession(readCookie(req, SESSION_COOKIE));
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
}));

// Ab hier: nur mit gültiger Sitzung
portalRouter.use(asyncRoute(async (req, res, next) => {
  const session = await getSession(readCookie(req, SESSION_COOKIE));
  if (!session) return res.status(401).json({ error: 'unauthorized' });
  req.session = session;
  req.tenantId = session.tenant_id;
  next();
}));

portalRouter.get('/me', (req, res) => res.json({
  ok: true, role: 'customer', email: req.session.email, tenantId: req.tenantId, publicUrl: config.publicUrl, llm: config.llm.provider,
}));
portalRouter.get('/industries', (req, res) => res.json(listIndustries()));
portalRouter.get('/plans', (req, res) => res.json(PLANS));

portalRouter.use('/tenant', buildTenantRouter({ role: 'customer' }));
