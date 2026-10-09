import crypto from 'node:crypto';
import { query } from '../db/pool.js';
import { getIndustry } from '../templates/industries.js';

// Gründerpreise für die ersten zehn Kunden, 12 Monate ab Vertragsbeginn garantiert (danach: 49 / 99 / 179 €)
export const PLANS = {
  starter: { label: 'Starter', priceEur: 29, regularEur: 49, monthlyConversations: 200 },
  business: { label: 'Business', priceEur: 59, regularEur: 99, monthlyConversations: 600 },
  pro: { label: 'Pro', priceEur: 99, regularEur: 179, monthlyConversations: 1500 },
  demo: { label: 'Demo', priceEur: 0, monthlyConversations: 5000 },
};

export const newPublicKey = () => `pk_${crypto.randomBytes(12).toString('base64url')}`;

export async function getTenantByKey(publicKey) {
  if (!publicKey || typeof publicKey !== 'string' || publicKey.length > 64) return null;
  const { rows } = await query('SELECT * FROM tenants WHERE public_key = $1 AND active', [publicKey]);
  return rows[0] || null;
}

export async function getTenantBySlug(slug) {
  const { rows } = await query('SELECT * FROM tenants WHERE slug = $1 AND active', [slug]);
  return rows[0] || null;
}

/** Öffentliche Widget-Konfiguration (keine internen Daten!). */
export function publicWidgetConfig(tenant) {
  const t = getIndustry(tenant.industry);
  const s = tenant.settings || {};
  return {
    name: tenant.name,
    assistantName: s.assistantName || 'Digitaler Assistent',
    color: s.color || '#1f4e79',
    greeting: s.greeting || t.greeting,
    quickReplies: s.quickReplies || t.quickReplies,
    privacyUrl: s.privacyUrl || null,
    position: s.position === 'left' ? 'left' : 'right',
    bookingUrl: s.bookingUrl || null,
  };
}

/** Normalisiert Domains zu Origins: "praxis-mueller.de" → https://praxis-mueller.de + www. */
export function normalizeOrigins(list = []) {
  const out = new Set();
  for (const raw of list) {
    const v = String(raw).trim().toLowerCase().replace(/\/+$/, '');
    if (!v) continue;
    if (/^https?:\/\//.test(v)) {
      out.add(v);
      continue;
    }
    out.add(`https://${v}`);
    if (!v.startsWith('www.')) out.add(`https://www.${v}`);
  }
  return [...out];
}

export async function monthlyUsage(tenantId) {
  const { rows } = await query(
    `SELECT * FROM usage_monthly WHERE tenant_id = $1 AND month = date_trunc('month', now())::date`,
    [tenantId],
  );
  return rows[0] || { conversations: 0, messages: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 };
}

export async function recordUsage(tenantId, { conversations = 0, messages = 0, input = 0, output = 0, cacheRead = 0 }) {
  await query(
    `INSERT INTO usage_monthly (tenant_id, month, conversations, messages, input_tokens, output_tokens, cache_read_tokens)
     VALUES ($1, date_trunc('month', now())::date, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id, month) DO UPDATE SET
       conversations = usage_monthly.conversations + EXCLUDED.conversations,
       messages = usage_monthly.messages + EXCLUDED.messages,
       input_tokens = usage_monthly.input_tokens + EXCLUDED.input_tokens,
       output_tokens = usage_monthly.output_tokens + EXCLUDED.output_tokens,
       cache_read_tokens = usage_monthly.cache_read_tokens + EXCLUDED.cache_read_tokens`,
    [tenantId, conversations, messages, input, output, cacheRead],
  );
}
