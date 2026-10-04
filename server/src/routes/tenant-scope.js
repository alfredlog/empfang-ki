// Alle Funktionen rund um EINEN Kunden – einmal geschrieben, zweimal eingehängt:
//   Admin:  /api/admin/tenants/:id/...   (req.tenantId aus der URL, du darfst alles)
//   Kunde:  /api/portal/...              (req.tenantId aus der Login-Sitzung, eingeschränkt)
// Jede Datenbankabfrage filtert nach req.tenantId – so sieht ein Kunde nie fremde Daten.
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { addUser, listUsers, removeUser, sendLoginToUser } from '../services/auth.js';
import {
  billingEvents, billingSummary, createCheckout, createPortalSession, markPaidManually, setActiveManually, setTrial,
} from '../services/billing.js';
import { extractPdfText, importWebsite, normalizeUrl } from '../services/importers.js';
import {
  addKnowledgeEntry, deleteChunk, deleteSource, knowledgeStats, listSources, replaceKnowledge,
} from '../services/knowledge.js';
import { PLANS, monthlyUsage, normalizeOrigins } from '../services/tenants.js';
import { industries } from '../templates/industries.js';

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const UUID = /^[0-9a-f-]{36}$/i;
const MAX_KNOWLEDGE_TOKENS = 250_000; // Obergrenze pro Kunde (Kostenschutz)

const optionalText = (max) => z.string().trim().max(max).optional().transform((v) => v || undefined);

export const tenantFields = {
  name: z.string().trim().min(2).max(120),
  industry: z.enum(Object.keys(industries)),
  city: optionalText(80),
  website: optionalText(200),
  contactEmail: z.union([z.email(), z.literal('')]).optional().transform((v) => v || undefined),
  phone: optionalText(40),
  plan: z.enum(Object.keys(PLANS)),
  allowedOrigins: z.array(z.string().max(200)).max(20),
  active: z.boolean(),
  settings: z.record(z.string(), z.any()),
};

// Diese Einstellungen darf ein Kunde selbst ändern
const CUSTOMER_SETTINGS = ['color', 'position', 'greeting', 'quickReplies', 'bookingUrl', 'privacyUrl', 'extraInstructions', 'assistantName'];
const COLUMN = {
  name: 'name', industry: 'industry', city: 'city', website: 'website', contactEmail: 'contact_email',
  phone: 'phone', plan: 'plan', active: 'active',
};

export function embedInfo(tenant) {
  return {
    snippet: `<script src="${config.publicUrl}/widget.js" data-bot-id="${tenant.public_key}" defer></script>`,
    hostedUrl: `${config.publicUrl}/c/${tenant.slug}`,
  };
}

/** Öffentliche Sicht auf einen Kunden (für Admin und Kunde). */
export async function tenantDetail(tenantId) {
  const { rows } = await query('SELECT * FROM tenants WHERE id = $1', [tenantId]);
  if (!rows[0]) return null;
  const t = rows[0];
  const [knowledge, usage, sources, leads] = await Promise.all([
    knowledgeStats(t.id), monthlyUsage(t.id), listSources(t.id),
    query(`SELECT count(*)::int AS n FROM leads WHERE tenant_id = $1 AND status = 'neu'`, [t.id]),
  ]);
  return {
    ...t, ...embedInfo(t), knowledge, usage, sources, newLeads: leads.rows[0].n, planInfo: PLANS[t.plan] || null, billing: billingSummary(t),
  };
}

async function assertKnowledgeRoom(tenantId, replacingSource) {
  const { rows } = await query(
    'SELECT coalesce(sum(tokens), 0)::int AS tokens FROM knowledge_chunks WHERE tenant_id = $1 AND source <> $2',
    [tenantId, replacingSource || ''],
  );
  if (rows[0].tokens > MAX_KNOWLEDGE_TOKENS) {
    const err = new Error('Die Wissensbasis ist voll. Bitte zuerst alte Quellen löschen.');
    err.status = 422;
    throw err;
  }
}

/**
 * @param {{ role: 'admin' | 'customer' }} opts
 */
export function buildTenantRouter({ role }) {
  const isAdmin = role === 'admin';
  const r = Router();

  // Kunden: Importe begrenzen (Website-Import kostet KI-Tokens)
  const importLimit = isAdmin
    ? (req, res, next) => next()
    : rateLimit({
      windowMs: 60 * 60_000, limit: 20, keyGenerator: (req) => `import:${req.tenantId}`,
      handler: (req, res) => res.status(429).json({ error: 'rate_limited', message: 'Zu viele Importe in kurzer Zeit. Bitte später erneut versuchen.' }),
    });

  r.get('/', asyncRoute(async (req, res) => {
    const t = await tenantDetail(req.tenantId);
    if (!t) return res.status(404).json({ error: 'not_found' });
    if (!isAdmin) { delete t.stripe_customer_id; delete t.stripe_subscription_id; }
    res.json(t);
  }));

  // ------------------------------------------------------------ Abrechnung
  r.get('/billing', asyncRoute(async (req, res) => {
    const t = await tenantDetail(req.tenantId);
    if (!t) return res.status(404).json({ error: 'not_found' });
    res.json({ ...t.billing, events: await billingEvents(req.tenantId) });
  }));

  /** Stripe-Zahlungsseite erstellen. Admin: Link zum Weitergeben; Kunde: direkt weiterleiten. */
  r.post('/billing/checkout', asyncRoute(async (req, res) => {
    const { plan } = z.object({ plan: z.enum(['starter', 'business', 'pro']).optional() }).parse(req.body || {});
    const { rows } = await query('SELECT * FROM tenants WHERE id = $1', [req.tenantId]);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    const result = await createCheckout(rows[0], { plan, email: req.session?.email, returnPath: isAdmin ? '/app/#abrechnung' : '/app/#abrechnung' });
    res.json(result);
  }));

  r.post('/billing/portal', asyncRoute(async (req, res) => {
    const { rows } = await query('SELECT * FROM tenants WHERE id = $1', [req.tenantId]);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json(await createPortalSession(rows[0], isAdmin ? `/admin/#kunde/${req.tenantId}/abrechnung` : '/app/#abrechnung'));
  }));

  if (isAdmin) {
    /** Kunde hat bei dir bezahlt (Überweisung/bar) → einschalten. */
    r.post('/billing/manual', asyncRoute(async (req, res) => {
      const v = z.object({ months: z.number().int().min(1).max(36).default(1), note: z.string().max(300).optional() }).parse(req.body || {});
      const result = await markPaidManually(req.tenantId, v);
      if (!result) return res.status(404).json({ error: 'not_found' });
      res.json(await tenantDetail(req.tenantId));
    }));

    r.post('/billing/active', asyncRoute(async (req, res) => {
      const v = z.object({ active: z.boolean(), note: z.string().max(300).optional() }).parse(req.body || {});
      if (!(await setActiveManually(req.tenantId, v.active, v.note))) return res.status(404).json({ error: 'not_found' });
      res.json(await tenantDetail(req.tenantId));
    }));

    r.post('/billing/trial', asyncRoute(async (req, res) => {
      const v = z.object({ days: z.number().int().min(1).max(90) }).parse(req.body || {});
      if (!(await setTrial(req.tenantId, v.days))) return res.status(404).json({ error: 'not_found' });
      res.json(await tenantDetail(req.tenantId));
    }));
  }

  r.patch('/', asyncRoute(async (req, res) => {
    const allowed = isAdmin
      ? Object.keys(tenantFields)
      : ['name', 'city', 'website', 'contactEmail', 'phone', 'allowedOrigins', 'settings'];
    const schema = z.object(Object.fromEntries(allowed.map((k) => [k, tenantFields[k]]))).partial().strict();
    const body = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => allowed.includes(k)));
    const v = schema.parse(body);

    const sets = [];
    const params = [];
    for (const [k, col] of Object.entries(COLUMN)) {
      if (!(k in body)) continue;
      if (v[k] === undefined) sets.push(`${col} = NULL`);
      else { params.push(v[k]); sets.push(`${col} = $${params.length}`); }
    }
    if (v.allowedOrigins) { params.push(normalizeOrigins(v.allowedOrigins)); sets.push(`allowed_origins = $${params.length}`); }
    if (v.settings) {
      let settings = v.settings;
      if (!isAdmin) {
        // Kunde: nur erlaubte Schlüssel übernehmen, Rest (vom Admin gesetzt) behalten
        const { rows } = await query('SELECT settings FROM tenants WHERE id = $1', [req.tenantId]);
        const current = rows[0]?.settings || {};
        const keep = Object.fromEntries(Object.entries(current).filter(([k]) => !CUSTOMER_SETTINGS.includes(k)));
        const mine = Object.fromEntries(Object.entries(v.settings).filter(([k, val]) => CUSTOMER_SETTINGS.includes(k) && val !== undefined && val !== null && val !== ''));
        settings = { ...keep, ...mine };
      }
      params.push(settings);
      sets.push(`settings = $${params.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: 'nothing_to_update' });
    params.push(req.tenantId);
    const { rowCount } = await query(`UPDATE tenants SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    if (!rowCount) return res.status(404).json({ error: 'not_found' });
    res.json(await tenantDetail(req.tenantId));
  }));

  // ------------------------------------------------------------ Wissen
  r.get('/knowledge', asyncRoute(async (req, res) => {
    const { rows } = await query(
      'SELECT id, source, title, content, tokens FROM knowledge_chunks WHERE tenant_id = $1 ORDER BY source, position',
      [req.tenantId],
    );
    res.json(rows);
  }));

  r.put('/knowledge', asyncRoute(async (req, res) => {
    const v = z.object({
      source: z.literal('manual').default('manual'),
      title: z.string().max(120).default('Allgemein'),
      text: z.string().min(1).max(200_000),
    }).parse(req.body);
    await assertKnowledgeRoom(req.tenantId, 'manual');
    const chunks = await replaceKnowledge(req.tenantId, v);
    res.json({ chunks, ...(await knowledgeStats(req.tenantId)) });
  }));

  r.post('/import/website', importLimit, asyncRoute(async (req, res) => {
    const v = z.object({
      url: z.string().min(3).max(300),
      maxPages: z.number().int().min(1).max(isAdmin ? 30 : 15).default(12),
      condense: z.boolean().default(true),
    }).parse(req.body);
    await assertKnowledgeRoom(req.tenantId, 'website');
    let result;
    try {
      result = await importWebsite(v.url, v);
    } catch (err) {
      return res.status(422).json({ error: 'import_failed', message: err.message });
    }
    const chunks = await replaceKnowledge(req.tenantId, { source: 'website', title: 'Website', text: result.markdown });
    await query('UPDATE tenants SET website = coalesce(website, $2) WHERE id = $1', [req.tenantId, normalizeUrl(v.url)]);
    res.json({ chunks, condensed: result.condensed, pages: result.pages, errors: result.errors, preview: result.markdown.slice(0, 3000) });
  }));

  r.post('/import/pdf', importLimit, asyncRoute(async (req, res) => {
    const v = z.object({
      filename: z.string().min(1).max(150),
      dataBase64: z.string().min(10).max(28_000_000),
    }).parse(req.body);
    await assertKnowledgeRoom(req.tenantId);
    let pdf;
    try {
      pdf = await extractPdfText(Buffer.from(v.dataBase64, 'base64'));
    } catch (err) {
      return res.status(422).json({ error: 'import_failed', message: err.message });
    }
    const name = v.filename.replace(/[^\p{L}\p{N} ._()-]/gu, '').slice(0, 70) || 'dokument.pdf';
    const chunks = await replaceKnowledge(req.tenantId, { source: `pdf:${name}`, title: name.replace(/\.pdf$/i, ''), text: pdf.text });
    res.json({ chunks, pages: pdf.totalPages, preview: pdf.text.slice(0, 1500) });
  }));

  r.delete('/knowledge/source/:source', asyncRoute(async (req, res) => {
    res.json({ deleted: await deleteSource(req.tenantId, req.params.source) });
  }));

  r.delete('/knowledge/:chunkId', asyncRoute(async (req, res) => {
    res.json({ deleted: await deleteChunk(req.tenantId, Number(req.params.chunkId) || 0) });
  }));

  r.post('/faq', asyncRoute(async (req, res) => {
    const v = z.object({
      question: z.string().trim().min(3).max(500),
      answer: z.string().trim().min(1).max(4000),
      leadId: z.string().regex(UUID).optional(),
    }).parse(req.body);
    const id = await addKnowledgeEntry(req.tenantId, { source: 'faq', title: v.question, content: v.answer });
    if (v.leadId) await query(`UPDATE leads SET status = 'erledigt' WHERE id = $1 AND tenant_id = $2`, [v.leadId, req.tenantId]);
    res.status(201).json({ id });
  }));

  // ------------------------------------------------------------ Anfragen & Gespräche
  r.get('/leads', asyncRoute(async (req, res) => {
    const { rows } = await query('SELECT * FROM leads WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 200', [req.tenantId]);
    res.json(rows);
  }));

  r.patch('/leads/:leadId', asyncRoute(async (req, res) => {
    if (!UUID.test(req.params.leadId)) return res.status(404).json({ error: 'not_found' });
    const { status } = z.object({ status: z.enum(['neu', 'in_bearbeitung', 'erledigt']) }).parse(req.body);
    const { rows } = await query('UPDATE leads SET status = $1 WHERE id = $2 AND tenant_id = $3 RETURNING *', [status, req.params.leadId, req.tenantId]);
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    res.json(rows[0]);
  }));

  r.get('/open-questions', asyncRoute(async (req, res) => {
    const { rows } = await query(
      `SELECT id, open_question, name, phone, email, status, created_at FROM leads
        WHERE tenant_id = $1 AND open_question IS NOT NULL ORDER BY created_at DESC LIMIT 200`,
      [req.tenantId],
    );
    res.json(rows);
  }));

  r.get('/conversations', asyncRoute(async (req, res) => {
    const { rows } = await query(
      `SELECT c.id, c.started_at, c.last_at, c.message_count, c.origin,
              (SELECT json_agg(json_build_object('role', m.role, 'content', m.content, 'at', m.created_at) ORDER BY m.id)
                 FROM messages m WHERE m.conversation_id = c.id) AS messages
         FROM conversations c WHERE c.tenant_id = $1 ORDER BY c.last_at DESC LIMIT 50`,
      [req.tenantId],
    );
    res.json(rows);
  }));

  // ------------------------------------------------------------ Zugänge (nur Admin)
  if (isAdmin) {
    r.get('/users', asyncRoute(async (req, res) => res.json(await listUsers(req.tenantId))));

    r.post('/users', asyncRoute(async (req, res) => {
      const v = z.object({ email: z.email(), name: optionalText(80), sendLogin: z.boolean().default(true) }).parse(req.body);
      const user = await addUser(req.tenantId, v);
      const login = v.sendLogin ? await sendLoginToUser(req.tenantId, user.id) : null;
      res.status(201).json({ user, loginUrl: login?.url || null, mailSent: login?.sent || false });
    }));

    r.post('/users/:userId/login-link', asyncRoute(async (req, res) => {
      if (!UUID.test(req.params.userId)) return res.status(404).json({ error: 'not_found' });
      const login = await sendLoginToUser(req.tenantId, req.params.userId);
      if (!login) return res.status(404).json({ error: 'not_found' });
      res.json({ loginUrl: login.url, mailSent: login.sent });
    }));

    r.delete('/users/:userId', asyncRoute(async (req, res) => {
      if (!UUID.test(req.params.userId)) return res.status(404).json({ error: 'not_found' });
      res.json({ deleted: await removeUser(req.tenantId, req.params.userId) });
    }));
  }

  return r;
}
