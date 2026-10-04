// Admin-API (geschützt per ADMIN_TOKEN) – wird von der Admin-Oberfläche unter /admin genutzt.
// Kunden anlegen, Wissen importieren (Website, PDF, Text), Anfragen & offene Fragen bearbeiten.
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { requireAdmin } from '../middleware/security.js';
import { extractPdfText, importWebsite, normalizeUrl } from '../services/importers.js';
import {
  addKnowledgeEntry, deleteChunk, deleteSource, knowledgeStats, listSources, replaceKnowledge,
} from '../services/knowledge.js';
import { PLANS, monthlyUsage, newPublicKey, normalizeOrigins } from '../services/tenants.js';
import { industries, listIndustries } from '../templates/industries.js';

export const adminRouter = Router();
// Schutz gegen Passwort-Raten: max. 20 Fehlversuche pro 15 Minuten und IP
adminRouter.use(rateLimit({ windowMs: 15 * 60_000, limit: 20, skipSuccessfulRequests: true, standardHeaders: 'draft-8', legacyHeaders: false }));
adminRouter.use(requireAdmin);

const asyncRoute = (fn) => (req, res, next) => fn(req, res).catch(next);
const UUID = /^[0-9a-f-]{36}$/i;
adminRouter.param('id', (req, res, next, id) => (UUID.test(id) ? next() : res.status(404).json({ error: 'not_found' })));

const optionalText = (max) => z.string().trim().max(max).optional().transform((v) => v || undefined);

const tenantSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z.string().regex(/^[a-z0-9-]{3,60}$/).optional(),
  industry: z.enum(Object.keys(industries)),
  city: optionalText(80),
  website: optionalText(200),
  contactEmail: z.union([z.email(), z.literal('')]).optional().transform((v) => v || undefined),
  phone: optionalText(40),
  plan: z.enum(Object.keys(PLANS)).default('starter'),
  allowedOrigins: z.array(z.string()).optional(),
  active: z.boolean().optional(),
  settings: z.record(z.string(), z.any()).optional(),
});

/** "Malerei Müller & Söhne" → "malerei-mueller-soehne" */
export function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'kunde';
}

async function uniqueSlug(base) {
  let slug = base.length >= 3 ? base : `${base}-kunde`;
  for (let i = 2; ; i++) {
    const { rowCount } = await query('SELECT 1 FROM tenants WHERE slug = $1', [slug]);
    if (!rowCount) return slug;
    slug = `${base}-${i}`;
  }
}

function hostOf(website) {
  try { return new URL(normalizeUrl(website)).hostname.replace(/^www\./, ''); } catch { return null; }
}

/** Die Code-Zeile, die der Kunde in seine Website einfügt. */
function embedInfo(tenant) {
  return {
    snippet: `<script src="${config.publicUrl}/widget.js" data-bot-id="${tenant.public_key}" defer></script>`,
    hostedUrl: `${config.publicUrl}/c/${tenant.slug}`,
  };
}

adminRouter.get('/me', (req, res) => res.json({ ok: true, publicUrl: config.publicUrl, llm: config.llm.provider }));
adminRouter.get('/industries', (req, res) => res.json(listIndustries()));
adminRouter.get('/plans', (req, res) => res.json(PLANS));

adminRouter.get('/tenants', asyncRoute(async (req, res) => {
  const { rows } = await query(
    `SELECT t.id, t.slug, t.name, t.industry, t.city, t.plan, t.active, t.created_at,
            coalesce(u.conversations, 0) AS conversations_month,
            (SELECT count(*)::int FROM leads l WHERE l.tenant_id = t.id AND l.status = 'neu') AS new_leads,
            (SELECT coalesce(sum(tokens), 0)::int FROM knowledge_chunks k WHERE k.tenant_id = t.id) AS knowledge_tokens
       FROM tenants t
       LEFT JOIN usage_monthly u ON u.tenant_id = t.id AND u.month = date_trunc('month', now())::date
      ORDER BY t.plan = 'demo', t.created_at DESC`,
  );
  res.json(rows);
}));

adminRouter.post('/tenants', asyncRoute(async (req, res) => {
  const v = tenantSchema.parse(req.body);
  const slug = await uniqueSlug(v.slug || slugify(v.name));
  // Ohne Angabe: die Domain der Website automatisch freischalten
  const origins = v.allowedOrigins?.length ? v.allowedOrigins : [hostOf(v.website)].filter(Boolean);
  const { rows } = await query(
    `INSERT INTO tenants (public_key, slug, name, industry, city, website, contact_email, phone, plan, allowed_origins, settings)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [newPublicKey(), slug, v.name, v.industry, v.city, v.website, v.contactEmail, v.phone, v.plan, normalizeOrigins(origins), v.settings || {}],
  );
  res.status(201).json({ ...rows[0], ...embedInfo(rows[0]) });
}));

adminRouter.get('/tenants/:id', asyncRoute(async (req, res) => {
  const { rows } = await query('SELECT * FROM tenants WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  const [knowledge, usage, sources] = await Promise.all([knowledgeStats(rows[0].id), monthlyUsage(rows[0].id), listSources(rows[0].id)]);
  res.json({ ...rows[0], ...embedInfo(rows[0]), knowledge, usage, sources, planInfo: PLANS[rows[0].plan] || null });
}));

adminRouter.patch('/tenants/:id', asyncRoute(async (req, res) => {
  const v = tenantSchema.partial().parse(req.body);
  const map = {
    name: 'name', industry: 'industry', city: 'city', website: 'website', contactEmail: 'contact_email',
    phone: 'phone', plan: 'plan', settings: 'settings', active: 'active',
  };
  const sets = [];
  const params = [];
  for (const [k, col] of Object.entries(map)) {
    if (k in req.body && v[k] !== undefined) { params.push(v[k]); sets.push(`${col} = $${params.length}`); }
    else if (k in req.body && req.body[k] === '') { sets.push(`${col} = NULL`); }
  }
  if (v.allowedOrigins) { params.push(normalizeOrigins(v.allowedOrigins)); sets.push(`allowed_origins = $${params.length}`); }
  if (!sets.length) return res.status(400).json({ error: 'nothing_to_update' });
  params.push(req.params.id);
  const { rows } = await query(`UPDATE tenants SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json({ ...rows[0], ...embedInfo(rows[0]) });
}));

// ---------------------------------------------------------------- Wissen

adminRouter.get('/tenants/:id/knowledge', asyncRoute(async (req, res) => {
  const { rows } = await query(
    'SELECT id, source, title, content, tokens FROM knowledge_chunks WHERE tenant_id = $1 ORDER BY source, position',
    [req.params.id],
  );
  res.json(rows);
}));

/** Text direkt eingeben (ersetzt die Quelle "manual"). */
adminRouter.put('/tenants/:id/knowledge', asyncRoute(async (req, res) => {
  const v = z.object({
    source: z.string().max(80).default('manual'),
    title: z.string().max(120).default('Allgemein'),
    text: z.string().min(1).max(400_000),
  }).parse(req.body);
  const chunks = await replaceKnowledge(req.params.id, v);
  res.json({ chunks, ...(await knowledgeStats(req.params.id)) });
}));

/** Website einlesen. Ergebnis ersetzt die Quelle "website". */
adminRouter.post('/tenants/:id/import/website', asyncRoute(async (req, res) => {
  const v = z.object({
    url: z.string().min(3).max(300),
    maxPages: z.number().int().min(1).max(30).default(12),
    condense: z.boolean().default(true),
  }).parse(req.body);
  let result;
  try {
    result = await importWebsite(v.url, v);
  } catch (err) {
    return res.status(422).json({ error: 'import_failed', message: err.message });
  }
  const chunks = await replaceKnowledge(req.params.id, { source: 'website', title: 'Website', text: result.markdown });
  // Website als Kundendaten übernehmen, falls noch leer
  await query('UPDATE tenants SET website = coalesce(website, $2) WHERE id = $1', [req.params.id, normalizeUrl(v.url)]);
  res.json({ chunks, condensed: result.condensed, pages: result.pages, errors: result.errors, preview: result.markdown.slice(0, 3000) });
}));

/** PDF hochladen (als Base64 im JSON). Jede Datei ist eine eigene Quelle "pdf:<Dateiname>". */
adminRouter.post('/tenants/:id/import/pdf', asyncRoute(async (req, res) => {
  const v = z.object({
    filename: z.string().min(1).max(150),
    dataBase64: z.string().min(10).max(28_000_000),
  }).parse(req.body);
  let pdf;
  try {
    pdf = await extractPdfText(Buffer.from(v.dataBase64, 'base64'));
  } catch (err) {
    return res.status(422).json({ error: 'import_failed', message: err.message });
  }
  const name = v.filename.replace(/[^\p{L}\p{N} ._()-]/gu, '').slice(0, 70) || 'dokument.pdf';
  const chunks = await replaceKnowledge(req.params.id, { source: `pdf:${name}`, title: name.replace(/\.pdf$/i, ''), text: pdf.text });
  res.json({ chunks, pages: pdf.totalPages, preview: pdf.text.slice(0, 1500) });
}));

adminRouter.delete('/tenants/:id/knowledge/source/:source', asyncRoute(async (req, res) => {
  const deleted = await deleteSource(req.params.id, req.params.source);
  res.json({ deleted });
}));

adminRouter.delete('/tenants/:id/knowledge/:chunkId', asyncRoute(async (req, res) => {
  const deleted = await deleteChunk(req.params.id, Number(req.params.chunkId));
  res.json({ deleted });
}));

/** Antwort auf eine offene Frage ergänzen → der Assistent weiß es ab sofort. */
adminRouter.post('/tenants/:id/faq', asyncRoute(async (req, res) => {
  const v = z.object({
    question: z.string().trim().min(3).max(500),
    answer: z.string().trim().min(1).max(4000),
    leadId: z.string().regex(UUID).optional(),
  }).parse(req.body);
  const id = await addKnowledgeEntry(req.params.id, { source: 'faq', title: v.question, content: v.answer });
  if (v.leadId) await query(`UPDATE leads SET status = 'erledigt' WHERE id = $1 AND tenant_id = $2`, [v.leadId, req.params.id]);
  res.status(201).json({ id });
}));

// ---------------------------------------------------------------- Anfragen & Gespräche

adminRouter.get('/tenants/:id/leads', asyncRoute(async (req, res) => {
  const { rows } = await query('SELECT * FROM leads WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 200', [req.params.id]);
  res.json(rows);
}));

// Wissenslücken: Fragen, die der Assistent nicht beantworten konnte
adminRouter.get('/tenants/:id/open-questions', asyncRoute(async (req, res) => {
  const { rows } = await query(
    `SELECT id, open_question, name, phone, email, status, created_at FROM leads
      WHERE tenant_id = $1 AND open_question IS NOT NULL ORDER BY created_at DESC LIMIT 200`,
    [req.params.id],
  );
  res.json(rows);
}));

adminRouter.patch('/leads/:id', asyncRoute(async (req, res) => {
  const { status } = z.object({ status: z.enum(['neu', 'in_bearbeitung', 'erledigt']) }).parse(req.body);
  const { rows } = await query('UPDATE leads SET status = $1 WHERE id = $2 RETURNING *', [status, req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json(rows[0]);
}));

adminRouter.get('/tenants/:id/conversations', asyncRoute(async (req, res) => {
  const { rows } = await query(
    `SELECT c.id, c.started_at, c.last_at, c.message_count, c.origin,
            (SELECT json_agg(json_build_object('role', m.role, 'content', m.content, 'at', m.created_at) ORDER BY m.id)
               FROM messages m WHERE m.conversation_id = c.id) AS messages
       FROM conversations c WHERE c.tenant_id = $1 ORDER BY c.last_at DESC LIMIT 50`,
    [req.params.id],
  );
  res.json(rows);
}));
