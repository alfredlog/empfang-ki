// Kunden-Login per Magic Link: E-Mail eingeben → Link per Mail → Klick → 30 Tage angemeldet.
import crypto from 'node:crypto';
import { config, isProd } from '../config.js';
import { query } from '../db/pool.js';
import { sendMail } from './mailer.js';

export const SESSION_COOKIE = 'ek_session';
const LINK_MINUTES = 30;
const SESSION_DAYS = 30;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');
export const normalizeEmail = (e) => String(e || '').trim().toLowerCase();

/** Nur interne Pfade als Ziel nach dem Login erlauben (kein Open Redirect). */
export function safeNext(next) {
  const n = String(next || '');
  return /^\/app\/?[\w\-/#?=&.]*$/.test(n) ? n : '/app/';
}

export async function listUsers(tenantId) {
  const { rows } = await query(
    'SELECT id, email, name, last_login_at, created_at FROM tenant_users WHERE tenant_id = $1 ORDER BY created_at',
    [tenantId],
  );
  return rows;
}

export async function addUser(tenantId, { email, name }) {
  const { rows } = await query(
    `INSERT INTO tenant_users (tenant_id, email, name) VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, email) DO UPDATE SET name = coalesce(EXCLUDED.name, tenant_users.name)
     RETURNING id, email, name, last_login_at, created_at`,
    [tenantId, normalizeEmail(email), name || null],
  );
  return rows[0];
}

export async function removeUser(tenantId, userId) {
  const { rowCount } = await query('DELETE FROM tenant_users WHERE tenant_id = $1 AND id = $2', [tenantId, userId]);
  return rowCount;
}

/** Erstellt einen Einmal-Login-Link für einen Zugang. */
export async function createLoginLink(userId, nextPath) {
  const token = newToken();
  await query(
    `INSERT INTO login_tokens (token_hash, user_id, next_path, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(mins => $4))`,
    [sha256(token), userId, safeNext(nextPath), LINK_MINUTES],
  );
  return `${config.publicUrl}/login/verify?token=${token}`;
}

function loginMail(user, links) {
  const multi = links.length > 1;
  const subject = 'Ihr Anmeldelink für Empfang KI';
  const text = `Guten Tag,

${multi ? 'hier sind Ihre Anmeldelinks:' : 'hier ist Ihr Anmeldelink für das Dashboard:'}

${links.map((l) => `${l.tenantName}: ${l.url}`).join('\n')}

Der Link ist ${LINK_MINUTES} Minuten gültig und kann einmal verwendet werden.
Falls Sie keinen Link angefordert haben, können Sie diese E-Mail ignorieren.

Empfang KI`;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:520px;color:#1b2a3a">
    <p>Guten Tag,</p>
    <p>${multi ? 'hier sind Ihre Anmeldelinks:' : 'mit diesem Button melden Sie sich im Dashboard an:'}</p>
    ${links.map((l) => `<p><a href="${l.url}" style="display:inline-block;background:#0e5e63;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">${multi ? `Anmelden: ${escapeHtml(l.tenantName)}` : 'Im Dashboard anmelden'}</a></p>`).join('')}
    <p style="color:#4a5868;font-size:14px">Der Link ist ${LINK_MINUTES} Minuten gültig und kann einmal verwendet werden. Falls Sie keinen Link angefordert haben, ignorieren Sie diese E-Mail einfach.</p>
  </div>`;
  return { to: user.email, subject, text, html };
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * Login anfordern. Antwortet nach außen immer gleich (verrät nicht, ob die Adresse existiert).
 * Hat eine Adresse Zugänge zu mehreren Betrieben, bekommt sie einen Link pro Betrieb.
 */
export async function requestLogin(email, nextPath) {
  const { rows } = await query(
    `SELECT u.id, u.email, t.name AS tenant_name FROM tenant_users u
       JOIN tenants t ON t.id = u.tenant_id
      WHERE lower(u.email) = $1 AND t.active ORDER BY t.name`,
    [normalizeEmail(email)],
  );
  if (!rows.length) return { sent: false };
  const links = [];
  for (const r of rows) links.push({ tenantName: r.tenant_name, url: await createLoginLink(r.id, nextPath) });
  const { sent } = await sendMail(loginMail(rows[0], links));
  if (!sent && !isProd) console.log(`[login] Link für ${rows[0].email}: ${links.map((l) => l.url).join(' ')}`);
  return { sent };
}

/** Admin: Willkommens-/Login-Mail an einen bestimmten Zugang schicken und den Link zurückgeben. */
export async function sendLoginToUser(tenantId, userId) {
  const { rows } = await query(
    `SELECT u.id, u.email, t.name AS tenant_name FROM tenant_users u JOIN tenants t ON t.id = u.tenant_id
      WHERE u.id = $1 AND u.tenant_id = $2`,
    [userId, tenantId],
  );
  if (!rows[0]) return null;
  const url = await createLoginLink(rows[0].id, '/app/');
  const { sent } = await sendMail(loginMail(rows[0], [{ tenantName: rows[0].tenant_name, url }]));
  return { url, sent };
}

/** Einmal-Link einlösen → neue Sitzung. */
export async function verifyLoginToken(token) {
  if (!token || typeof token !== 'string' || token.length > 100) return null;
  const { rows } = await query(
    `UPDATE login_tokens SET used_at = now()
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
      RETURNING user_id, next_path`,
    [sha256(token)],
  );
  if (!rows[0]) return null;
  const sessionToken = newToken();
  await query(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))`,
    [sha256(sessionToken), rows[0].user_id, SESSION_DAYS],
  );
  await query('UPDATE tenant_users SET last_login_at = now() WHERE id = $1', [rows[0].user_id]);
  return { sessionToken, next: safeNext(rows[0].next_path) };
}

export async function getSession(sessionToken) {
  if (!sessionToken) return null;
  const { rows } = await query(
    `SELECT s.user_id, u.email, u.tenant_id FROM sessions s
       JOIN tenant_users u ON u.id = s.user_id
       JOIN tenants t ON t.id = u.tenant_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND t.active`,
    [sha256(sessionToken)],
  );
  return rows[0] || null;
}

export async function destroySession(sessionToken) {
  if (sessionToken) await query('DELETE FROM sessions WHERE token_hash = $1', [sha256(sessionToken)]);
}

export async function purgeExpiredAuth() {
  await query('DELETE FROM login_tokens WHERE expires_at < now() - interval \'1 day\'');
  await query('DELETE FROM sessions WHERE expires_at < now()');
}

export const sessionCookieOptions = () => ({
  httpOnly: true,
  secure: config.publicUrl.startsWith('https://'),
  sameSite: 'lax',
  path: '/',
  maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
});

export function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}
