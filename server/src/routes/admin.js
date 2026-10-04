// Admin-API (geschützt per ADMIN_TOKEN): Kunden anlegen, Wissen pflegen, Anfragen & Verbrauch ansehen.
// Grundlage für das spätere Kunden-Dashboard.
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { requireAdmin } from '../middleware/security.js';
import { knowledgeStats, replaceKnowledge } from '../services/knowledge.js';
import { PLANS, monthlyUsage, newPublicKey, normalizeOrigins } from '../services/tenants.js';
import { industries, listIndustries } from '../templates/industries.js';

export const adminRouter = Router();
adminRouter.use(requireAdmin);

const tenantSchema = z.object({
  name: z.string().min(2).max(120),
  slug: z.string().regex(/^[a-z0-9-]{3,60}$/),
  industry: z.enum(Object.keys(industries)),
  city: z.string().max(80).optional(),
  website: z.string().max(200).optional(),
  contactEmail: z.email().optional(),
  phone: z.string().max(40).optional(),
  plan: z.enum(Object.keys(PLANS)).default('starter'),
  allowedOrigins: z.array(z.string()).default([]),
  settings: z.record(z.string(), z.any()).default({}),
});

const asyncRoute = (fn) => (req, res, next) => fn(req, res).catch(next);

adminRouter.get('/industries', (req, res) => res.json(listIndustries()));
adminRouter.get('/plans', (req, res) => res.json(PLANS));

adminRouter.get('/tenants', asyncRoute(async (req, res) => {
  const { rows } = await query('SELECT id, slug, name, industry, city, plan, public_key, active, created_at FROM tenants ORDER BY created_at DESC');
  res.json(rows);
}));

adminRouter.post('/tenants', asyncRoute(async (req, res) => {
  const v = tenantSchema.parse(req.body);
  const { rows } = await query(
    `INSERT INTO tenants (public_key, slug, name, industry, city, website, contact_email, phone, plan, allowed_origins, settings)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [newPublicKey(), v.slug, v.name, v.industry, v.city, v.website, v.contactEmail, v.phone, v.plan, normalizeOrigins(v.allowedOrigins), v.settings],
  );
  res.status(201).json(rows[0]);
}));

adminRouter.get('/tenants/:id', asyncRoute(async (req, res) => {
  const { rows } = await query('SELECT * FROM tenants WHERE id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  const [knowledge, usage] = await Promise.all([knowledgeStats(rows[0].id), monthlyUsage(rows[0].id)]);
  res.json({ ...rows[0], knowledge, usage });
}));

adminRouter.patch('/tenants/:id', asyncRoute(async (req, res) => {
  const v = tenantSchema.partial().parse(req.body);
  const map = {
    name: 'name', industry: 'industry', city: 'city', website: 'website', contactEmail: 'contact_email',
    phone: 'phone', plan: 'plan', settings: 'settings',
  };
  const sets = [];
  const params = [];
  for (const [k, col] of Object.entries(map)) {
    if (v[k] !== undefined) { params.push(v[k]); sets.push(`${col} = $${params.length}`); }
  }
  if (v.allowedOrigins) { params.push(normalizeOrigins(v.allowedOrigins)); sets.push(`allowed_origins = $${params.length}`); }
  if (!sets.length) return res.status(400).json({ error: 'nothing_to_update' });
  params.push(req.params.id);
  const { rows } = await query(`UPDATE tenants SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
  if (!rows[0]) return res.status(404).json({ error: 'not_found' });
  res.json(rows[0]);
}));

adminRouter.put('/tenants/:id/knowledge', asyncRoute(async (req, res) => {
  const v = z.object({
    source: z.string().max(40).default('manual'),
    title: z.string().max(120).default('Allgemein'),
    text: z.string().min(1).max(400_000),
  }).parse(req.body);
  const chunks = await replaceKnowledge(req.params.id, v);
  res.json({ chunks, ...(await knowledgeStats(req.params.id)) });
}));

adminRouter.get('/tenants/:id/knowledge', asyncRoute(async (req, res) => {
  const { rows } = await query(
    'SELECT id, source, title, content, tokens FROM knowledge_chunks WHERE tenant_id = $1 ORDER BY source, position',
    [req.params.id],
  );
  res.json(rows);
}));

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
