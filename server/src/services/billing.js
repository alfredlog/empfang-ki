// Abrechnung: zwei Wege, einen Kunden einzuschalten.
//   1. Manuell – Kunde zahlt bei dir (Überweisung/bar), du markierst ihn im Admin als bezahlt.
//   2. Stripe  – Kunde zahlt über Stripe Checkout; der Webhook schaltet ihn automatisch ein/aus.
// Neue Kunden starten in einer Testphase; läuft sie ohne Zahlung ab, wird der Assistent ausgeschaltet.
import Stripe from 'stripe';
import { config } from '../config.js';
import { query, withTransaction } from '../db/pool.js';
import { FOUNDER_LIMIT, autoAssignFounder, founderCount, founderInfo } from './founder.js';
import { PLANS } from './tenants.js';

let stripeClient;
export function stripe() {
  if (!config.stripe.secretKey) {
    const err = new Error('Stripe ist noch nicht eingerichtet (STRIPE_SECRET_KEY fehlt in der .env).');
    err.status = 400;
    throw err;
  }
  if (!stripeClient) stripeClient = new Stripe(config.stripe.secretKey);
  return stripeClient;
}

export const stripeEnabled = () => Boolean(config.stripe.secretKey);

const PAID_PLANS = ['starter', 'business', 'pro'];
const planForPrice = (priceId) => PAID_PLANS.find((p) => priceId && (config.stripe.prices[p] === priceId || config.stripe.regularPrices[p] === priceId)) || null;

/** Gründerpreis, solange Plätze frei sind bzw. der Kunde Gründerkunde mit laufender Garantie ist – sonst regulärer Preis. */
export async function useRegularPrice(tenant) {
  if (tenant.founder_since) return founderInfo(tenant).expired;
  return (await founderCount()) >= FOUNDER_LIMIT;
}

export async function logBillingEvent(db, { tenantId, source, type, detail = {}, stripeEventId = null }) {
  const { rowCount } = await db.query(
    `INSERT INTO billing_events (tenant_id, source, type, detail, stripe_event_id)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (stripe_event_id) DO NOTHING`,
    [tenantId, source, type, detail, stripeEventId],
  );
  return rowCount === 1;
}

export async function billingEvents(tenantId) {
  const { rows } = await query(
    'SELECT source, type, detail, created_at FROM billing_events WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 50',
    [tenantId],
  );
  return rows;
}

/** Status für die Oberfläche (Admin und Kunde). */
export function billingSummary(t, { foundersFull = false } = {}) {
  const founder = founderInfo(t);
  const regular = founder.isFounder ? founder.expired : foundersFull;
  const plan = PLANS[t.plan] || null;
  const today = new Date().toISOString().slice(0, 10);
  const paidUntil = t.paid_until ? String(t.paid_until).slice(0, 10) : null;
  return {
    status: t.billing_status,
    method: t.billing_method,
    active: t.active,
    plan: t.plan,
    priceEur: plan ? (regular ? (plan.regularEur ?? plan.priceEur) : plan.priceEur) : null,
    regularPrice: regular,
    trialEndsAt: t.trial_ends_at,
    paidUntil,
    overdue: t.billing_method === 'manual' && paidUntil !== null && paidUntil < today,
    stripeCustomer: Boolean(t.stripe_customer_id),
    stripeEnabled: stripeEnabled(),
    founder,
  };
}

// ---------------------------------------------------------------- Manuell (Admin)

/** Kunde hat bei dir bezahlt → einschalten und "bezahlt bis" verlängern. */
export async function markPaidManually(tenantId, { months = 1, note } = {}) {
  return withTransaction(async (db) => {
    const { rows } = await db.query(
      `UPDATE tenants SET
         active = true, billing_status = 'active', billing_method = 'manual', trial_ends_at = NULL,
         paid_until = (greatest(coalesce(paid_until, current_date), current_date) + make_interval(months => $2))::date
       WHERE id = $1 RETURNING paid_until, plan`,
      [tenantId, months],
    );
    if (!rows[0]) return null;
    const founderSince = await autoAssignFounder(db, tenantId);
    if (founderSince) await logBillingEvent(db, { tenantId, source: 'system', type: 'gruenderpreis', detail: { since: founderSince } });
    await logBillingEvent(db, {
      tenantId, source: 'manual', type: 'bezahlt',
      detail: { months, paidUntil: rows[0].paid_until, plan: rows[0].plan, note: note || undefined },
    });
    return rows[0];
  });
}

/** Ein-/Ausschalten von Hand (z. B. Pilotkunde, Kündigung, Zahlung offen). */
export async function setActiveManually(tenantId, active, note) {
  return withTransaction(async (db) => {
    const { rowCount } = await db.query(
      `UPDATE tenants SET active = $2,
         billing_status = CASE WHEN $2 THEN (CASE WHEN billing_status IN ('canceled','expired','unpaid') THEN 'active' ELSE billing_status END)
                               ELSE (CASE WHEN billing_status = 'trial' THEN 'expired' ELSE 'canceled' END) END
       WHERE id = $1`,
      [tenantId, active],
    );
    if (rowCount) await logBillingEvent(db, { tenantId, source: 'manual', type: active ? 'eingeschaltet' : 'ausgeschaltet', detail: { note: note || undefined } });
    return rowCount;
  });
}

/** Testphase starten oder verlängern. */
export async function setTrial(tenantId, days) {
  return withTransaction(async (db) => {
    const { rows } = await db.query(
      `UPDATE tenants SET active = true, billing_status = 'trial',
         trial_ends_at = greatest(coalesce(trial_ends_at, now()), now()) + make_interval(days => $2)
       WHERE id = $1 RETURNING trial_ends_at`,
      [tenantId, days],
    );
    if (rows[0]) await logBillingEvent(db, { tenantId, source: 'manual', type: 'testphase', detail: { days, until: rows[0].trial_ends_at } });
    return rows[0];
  });
}

/** Täglich: abgelaufene Testphasen ausschalten. */
export async function expireTrials() {
  return withTransaction(async (db) => {
    const { rows } = await db.query(
      `UPDATE tenants SET active = false, billing_status = 'expired'
        WHERE billing_status = 'trial' AND trial_ends_at < now() RETURNING id`,
    );
    for (const r of rows) await logBillingEvent(db, { tenantId: r.id, source: 'system', type: 'testphase_abgelaufen' });
    return rows.length;
  });
}

// ---------------------------------------------------------------- Stripe

/** Zahlungsseite (Stripe Checkout) für ein Monatsabo erstellen. */
export async function createCheckout(tenant, { plan, returnPath, email }) {
  const chosen = PAID_PLANS.includes(plan) ? plan : (PAID_PLANS.includes(tenant.plan) ? tenant.plan : 'starter');
  const regular = await useRegularPrice(tenant);
  const price = regular ? config.stripe.regularPrices[chosen] : config.stripe.prices[chosen];
  if (!price) {
    const name = `STRIPE_PRICE_${chosen.toUpperCase()}${regular ? '_REGULAR' : ''}`;
    const err = new Error(`Für das Paket „${chosen}“ ist keine Stripe-Preis-ID hinterlegt (${name} in der .env).`);
    err.status = 400;
    throw err;
  }
  const back = `${config.publicUrl}${returnPath || '/app/#abrechnung'}`;
  const session = await stripe().checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price, quantity: 1 }],
    ...(tenant.stripe_customer_id ? { customer: tenant.stripe_customer_id } : { customer_email: email || tenant.contact_email || undefined }),
    client_reference_id: tenant.id,
    metadata: { tenant_id: tenant.id, plan: chosen },
    subscription_data: { metadata: { tenant_id: tenant.id, plan: chosen } },
    locale: 'de',
    allow_promotion_codes: true,
    billing_address_collection: 'required',
    tax_id_collection: { enabled: true },
    success_url: `${back}${back.includes('?') ? '&' : '?'}bezahlt=1`,
    cancel_url: back,
  });
  return { url: session.url, plan: chosen, regular };
}

/** Stripe-Kundenportal (Zahlungsmethode, Rechnungen, Kündigung). */
export async function createPortalSession(tenant, returnPath) {
  if (!tenant.stripe_customer_id) {
    const err = new Error('Für diesen Kunden gibt es noch kein Stripe-Abo.');
    err.status = 400;
    throw err;
  }
  const session = await stripe().billingPortal.sessions.create({
    customer: tenant.stripe_customer_id,
    return_url: `${config.publicUrl}${returnPath || '/app/#abrechnung'}`,
    locale: 'de',
  });
  return { url: session.url };
}

/** Webhook-Signatur prüfen (rawBody = Buffer). */
export function constructWebhookEvent(rawBody, signature) {
  if (!config.stripe.webhookSecret) throw Object.assign(new Error('STRIPE_WEBHOOK_SECRET fehlt'), { status: 400 });
  return stripe().webhooks.constructEvent(rawBody, signature, config.stripe.webhookSecret);
}

// Stripe-Abo-Status → unser Status
function mapSubscription(sub) {
  switch (sub.status) {
    case 'active':
    case 'trialing':
      return { billing: 'active', active: true };
    case 'past_due':
      return { billing: 'past_due', active: true }; // Kulanz: Stripe versucht es erneut
    case 'unpaid':
      return { billing: 'unpaid', active: false };
    case 'canceled':
    case 'incomplete_expired':
      return { billing: 'canceled', active: false };
    default: // incomplete, paused
      return { billing: 'unpaid', active: false };
  }
}

async function tenantIdForSubscription(db, sub) {
  if (sub.metadata?.tenant_id) return sub.metadata.tenant_id;
  const { rows } = await db.query('SELECT id FROM tenants WHERE stripe_subscription_id = $1 OR stripe_customer_id = $2 LIMIT 1', [sub.id, sub.customer]);
  return rows[0]?.id || null;
}

/**
 * Verarbeitet ein (bereits verifiziertes) Stripe-Event. Idempotent: jedes Event nur einmal.
 * @returns {Promise<{handled: boolean, duplicate?: boolean, tenantId?: string}>}
 */
export async function handleStripeEvent(event) {
  return withTransaction(async (db) => {
    const obj = event.data.object;
    let tenantId = null;
    let type = event.type;
    let detail = {};

    if (event.type === 'checkout.session.completed') {
      tenantId = obj.metadata?.tenant_id || obj.client_reference_id;
      if (!tenantId) return { handled: false };
      const plan = PAID_PLANS.includes(obj.metadata?.plan) ? obj.metadata.plan : null;
      await db.query(
        `UPDATE tenants SET active = true, billing_status = 'active', billing_method = 'stripe', trial_ends_at = NULL,
           stripe_customer_id = coalesce($2, stripe_customer_id), stripe_subscription_id = coalesce($3, stripe_subscription_id),
           plan = coalesce($4, plan)
         WHERE id = $1`,
        [tenantId, obj.customer || null, obj.subscription || null, plan],
      );
      const founderSince = await autoAssignFounder(db, tenantId);
      if (founderSince) await logBillingEvent(db, { tenantId, source: 'system', type: 'gruenderpreis', detail: { since: founderSince } });
      type = 'stripe_bezahlt';
      detail = { plan, amountEur: obj.amount_total != null ? obj.amount_total / 100 : undefined };
    } else if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      tenantId = await tenantIdForSubscription(db, obj);
      if (!tenantId) return { handled: false };
      const mapped = event.type === 'customer.subscription.deleted' ? { billing: 'canceled', active: false } : mapSubscription(obj);
      const plan = planForPrice(obj.items?.data?.[0]?.price?.id);
      await db.query(
        `UPDATE tenants SET active = $2, billing_status = $3, billing_method = 'stripe',
           stripe_customer_id = coalesce($4, stripe_customer_id), stripe_subscription_id = $5, plan = coalesce($6, plan)
         WHERE id = $1`,
        [tenantId, mapped.active, mapped.billing, obj.customer || null, obj.id, plan],
      );
      type = event.type === 'customer.subscription.deleted' ? 'stripe_gekuendigt' : `stripe_abo_${mapped.billing}`;
      detail = { stripeStatus: obj.status, plan, cancelAtPeriodEnd: obj.cancel_at_period_end || undefined };
    } else if (event.type === 'invoice.payment_failed') {
      const { rows } = await db.query('SELECT id FROM tenants WHERE stripe_customer_id = $1 LIMIT 1', [obj.customer]);
      tenantId = rows[0]?.id;
      if (!tenantId) return { handled: false };
      await db.query(`UPDATE tenants SET billing_status = 'past_due' WHERE id = $1 AND billing_status = 'active'`, [tenantId]);
      type = 'stripe_zahlung_fehlgeschlagen';
      detail = { amountEur: obj.amount_due != null ? obj.amount_due / 100 : undefined };
    } else if (event.type === 'invoice.paid') {
      const { rows } = await db.query('SELECT id FROM tenants WHERE stripe_customer_id = $1 LIMIT 1', [obj.customer]);
      tenantId = rows[0]?.id;
      if (!tenantId) return { handled: false };
      type = 'stripe_rechnung_bezahlt';
      detail = { amountEur: obj.amount_paid != null ? obj.amount_paid / 100 : undefined };
    } else {
      return { handled: false };
    }

    const fresh = await logBillingEvent(db, { tenantId, source: 'stripe', type, detail, stripeEventId: event.id });
    if (!fresh) throw Object.assign(new Error('duplicate'), { duplicate: true });
    return { handled: true, tenantId };
  }).catch((err) => {
    if (err.duplicate) return { handled: true, duplicate: true }; // Rollback der doppelten Änderung, Stripe bekommt trotzdem 200
    throw err;
  });
}
