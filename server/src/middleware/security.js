import crypto from 'node:crypto';
import { config, isProd } from '../config.js';

const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

/**
 * Ermittelt, von welcher Website eine Anfrage kommt.
 * Browser senden bei GET-Anfragen von derselben Domain KEINEN Origin-Header –
 * dann gilt Sec-Fetch-Site: same-origin (bzw. der Referer) als Nachweis für unsere eigene Domain.
 */
export function requestOrigin(req) {
  const h = req.headers || {};
  if (h.origin && h.origin !== 'null') return h.origin;
  if (h['sec-fetch-site'] === 'same-origin') return config.publicUrl;
  if (h.referer) {
    try { return new URL(h.referer).origin; } catch { /* ungültiger Referer */ }
  }
  return null;
}

/**
 * Darf dieses Widget auf der anfragenden Website laufen?
 * Erlaubt: vom Kunden hinterlegte Domains, unsere eigene Domain (Demos, gehostete Chat-Seite)
 * und in der Entwicklung localhost.
 */
export function isOriginAllowed(tenant, origin) {
  if (!origin) return !isProd; // curl & Co. nur in der Entwicklung
  const o = origin.toLowerCase().replace(/\/+$/, '');
  if (o === config.publicUrl.toLowerCase()) return true;
  if (!isProd && LOCAL.test(o)) return true;
  return (tenant.allowed_origins || []).includes(o);
}

/** Setzt CORS-Header für eine bereits geprüfte Origin. */
export function applyCors(res, origin) {
  if (!origin) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
}

/** Preflight: wird erlaubt; die eigentliche Prüfung passiert bei der echten Anfrage. */
export function preflight(req, res) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Vary', 'Origin');
  res.sendStatus(204);
}

/** Schützt die Admin-API mit einem Bearer-Token (ADMIN_TOKEN). */
export function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const expected = config.adminToken;
  const ok =
    expected &&
    token.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  if (!ok) return res.status(401).json({ error: 'unauthorized' });
  next();
}
