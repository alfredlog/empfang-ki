// Admin-API (geschützt per ADMIN_TOKEN) – wird von der Admin-Oberfläche unter /admin genutzt.
// Kundenliste und Neuanlage hier; alles zu EINEM Kunden kommt aus tenant-scope.js.
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { requireAdmin } from '../middleware/security.js';
import { logBillingEvent } from '../services/billing.js';
import { normalizeUrl } from '../services/importers.js';
import { pool } from '../db/pool.js';
import { PLANS, newPublicKey, normalizeOrigins } from '../services/tenants.js';
import { listIndustries } from '../templates/industries.js';
import { buildTenantRouter, embedInfo, tenantFields } from './tenant-scope.js';

export const adminRouter = Router();
// Schutz gegen Passwort-Raten: max. 20 Fehlversuche pro 15 Minuten und IP
adminRouter.use(rateLimit({ windowMs: 15 * 60_000, limit: 20, skipSuccessfulRequests: true, standardHeaders: 'draft-8', legacyHeaders: false }));
adminRouter.use(requireAdmin);

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const UUID = /^[0-9a-f-]{36}$/i;

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
  const root = base.length >= 3 ? base : `${base}-kunde`;
  let slug = root;
  for (let i = 2; ; i++) {
    const { rowCount } = await query('SELECT 1 FROM tenants WHERE slug = $1', [slug]);
    if (!rowCount) return slug;
    slug = `${root}-${i}`;
  }
}

function hostOf(website) {
  try { return new URL(normalizeUrl(website)).hostname.replace(/^www\./, ''); } catch { return null; }
}

adminRouter.get('/me', (req, res) => res.json({ ok: true, role: 'admin', publicUrl: config.publicUrl, llm: config.llm.provider }));
adminRouter.get('/industries', (req, res) => res.json(listIndustries()));
adminRouter.get('/plans', (req, res) => res.json(PLANS));

adminRouter.get('/tenants', asyncRoute(async (req, res) => {
  const { rows } = await query(
    `SELECT t.id, t.slug, t.name, t.industry, t.city, t.plan, t.active, t.created_at,
            coalesce(u.conversations, 0) AS conversations_month,
            (SELECT count(*)::int FROM leads l WHERE l.tenant_id = t.id AND l.status = 'neu') AS new_leads,
            (SELECT coalesce(sum(tokens), 0)::int FROM knowledge_chunks k WHERE k.tenant_id = t.id) AS knowledge_tokens,
            t.billing_status, t.billing_method, t.paid_until, t.trial_ends_at
       FROM tenants t
       LEFT JOIN usage_monthly u ON u.tenant_id = t.id AND u.month = date_trunc('month', now())::date
      ORDER BY t.plan = 'demo', t.created_at DESC`,
  );
  res.json(rows);
}));

const createSchema = z.object({
  ...tenantFields,
  slug: z.string().regex(/^[a-z0-9-]{3,60}$/).optional(),
  plan: tenantFields.plan.default('starter'),
  allowedOrigins: tenantFields.allowedOrigins.optional(),
  settings: tenantFields.settings.optional(),
  active: tenantFields.active.optional(),
});

adminRouter.post('/tenants', asyncRoute(async (req, res) => {
  const v = createSchema.parse(req.body);
  const slug = await uniqueSlug(v.slug || slugify(v.name));
  // Ohne Angabe: die Domain der Website automatisch freischalten
  const origins = v.allowedOrigins?.length ? v.allowedOrigins : [hostOf(v.website)].filter(Boolean);
  const { rows } = await query(
    `INSERT INTO tenants (public_key, slug, name, industry, city, website, contact_email, phone, plan, allowed_origins, settings,
                          billing_status, trial_ends_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'trial', now() + make_interval(days => $12)) RETURNING *`,
    [newPublicKey(), slug, v.name, v.industry, v.city, v.website, v.contactEmail, v.phone, v.plan, normalizeOrigins(origins), v.settings || {}, config.trialDays],
  );
  await logBillingEvent(pool, { tenantId: rows[0].id, source: 'system', type: 'testphase', detail: { days: config.trialDays, until: rows[0].trial_ends_at } });
  res.status(201).json({ ...rows[0], ...embedInfo(rows[0]) });
}));

// Alles zu einem bestimmten Kunden
adminRouter.use('/tenants/:id', (req, res, next) => {
  if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'not_found' });
  req.tenantId = req.params.id;
  next();
}, buildTenantRouter({ role: 'admin' }));
