// Integrationstest gegen eine echte Postgres-Datenbank (Mock-LLM).
// Wird übersprungen, wenn keine Datenbank erreichbar ist.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

process.env.LLM_PROVIDER = 'mock';
process.env.ADMIN_TOKEN = 'test-admin-token';
process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret';
process.env.STRIPE_PRICE_BUSINESS = 'price_business_test';

const { pool, query } = await import('../server/src/db/pool.js');
let dbOk = true;
try { await pool.query('SELECT 1'); } catch { dbOk = false; }

const opts = { skip: dbOk ? false : 'keine Datenbank erreichbar' };
let server;
let base;
let tenantId;
const admin = { Authorization: 'Bearer test-admin-token', 'Content-Type': 'application/json' };
const slug = `test-${Date.now()}`;

async function chat(body, origin) {
  const res = await fetch(`${base}/api/v1/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const events = text.split('\n\n').filter(Boolean).map((b) => {
    const ev = b.match(/^event: (.+)$/m)?.[1];
    const data = JSON.parse(b.match(/^data: (.+)$/m)?.[1] || '{}');
    return { ev, data };
  });
  return { status: res.status, events, answer: events.filter((e) => e.ev === 'delta').map((e) => e.data.text).join('') };
}

before(async () => {
  if (!dbOk) return;
  const { migrate } = await import('../server/src/db/migrate.js');
  await migrate({ log: () => {} });
  const { createApp } = await import('../server/src/app.js');
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (tenantId) await query('DELETE FROM tenants WHERE id = $1', [tenantId]);
  server?.close();
  await pool.end();
});

test('Admin-API ist ohne Token gesperrt', opts, async () => {
  const res = await fetch(`${base}/api/admin/tenants`);
  assert.equal(res.status, 401);
});

test('Kunde anlegen und Wissen hinterlegen', opts, async () => {
  const res = await fetch(`${base}/api/admin/tenants`, {
    method: 'POST', headers: admin,
    body: JSON.stringify({ name: 'Testbetrieb', slug, industry: 'handwerk', allowedOrigins: ['testbetrieb.de'] }),
  });
  assert.equal(res.status, 201);
  const t = await res.json();
  tenantId = t.id;
  assert.match(t.public_key, /^pk_/);
  assert.ok(t.allowed_origins.includes('https://www.testbetrieb.de'));

  const k = await fetch(`${base}/api/admin/tenants/${t.id}/knowledge`, {
    method: 'PUT', headers: admin,
    body: JSON.stringify({ text: '# Öffnungszeiten Büro\nMontag bis Freitag 8 bis 17 Uhr geöffnet.\n\n# Leistungen\nFassaden streichen und tapezieren.' }),
  });
  assert.equal((await k.json()).chunks, 2);
});

test('Chat beantwortet Fragen aus der Wissensbasis', opts, async () => {
  const { public_key: key } = (await query('SELECT public_key FROM tenants WHERE id = $1', [tenantId])).rows[0];
  const r = await chat({ key, message: 'Wann ist das Büro geöffnet?' }, 'https://testbetrieb.de');
  assert.equal(r.status, 200);
  assert.ok(r.events.some((e) => e.ev === 'meta' && e.data.conversationId));
  assert.match(r.answer, /Montag bis Freitag/);
});

test('fremde Domains werden abgewiesen', opts, async () => {
  const { public_key: key } = (await query('SELECT public_key FROM tenants WHERE id = $1', [tenantId])).rows[0];
  const r = await chat({ key, message: 'Hallo' }, 'https://evil.example');
  assert.equal(r.status, 403);
});

test('offene Frage wird als Anfrage gespeichert', opts, async () => {
  const { public_key: key } = (await query('SELECT public_key FROM tenants WHERE id = $1', [tenantId])).rows[0];
  const first = await chat({ key, message: 'Verlegt ihr auch Parkett aus Eiche?' }, 'https://testbetrieb.de');
  assert.match(first.answer, /keine Information/);
  const conversationId = first.events.find((e) => e.ev === 'meta').data.conversationId;
  const second = await chat({ key, conversationId, message: 'Ich bin Eva Test, eva@example.de' }, 'https://testbetrieb.de');
  assert.ok(second.events.some((e) => e.ev === 'lead' && e.data.kind === 'offene_frage'));

  const res = await fetch(`${base}/api/admin/tenants/${tenantId}/open-questions`, { headers: admin });
  const list = await res.json();
  assert.equal(list[0].open_question, 'Verlegt ihr auch Parkett aus Eiche?');
  assert.equal(list[0].email, 'eva@example.de');
});

test('zu lange Nachrichten werden abgelehnt', opts, async () => {
  const { public_key: key } = (await query('SELECT public_key FROM tenants WHERE id = $1', [tenantId])).rows[0];
  const r = await chat({ key, message: 'x'.repeat(5000) }, 'https://testbetrieb.de');
  assert.ok(r.events.some((e) => e.ev === 'error' && e.data.code === 'too_long'));
});

// ---------------------------------------------------------------- Admin-Oberfläche: Import & FAQ
let adminTenant;

test('Kunde ohne Slug anlegen: Slug, Domain und Code-Zeile werden erzeugt', opts, async () => {
  const res = await fetch(`${base}/api/admin/tenants`, {
    method: 'POST', headers: admin,
    body: JSON.stringify({ name: `Malerei Müller ${Date.now()}`, industry: 'handwerk', website: 'www.malerei-mueller-test.de', contactEmail: '' }),
  });
  assert.equal(res.status, 201);
  adminTenant = await res.json();
  assert.match(adminTenant.slug, /^malerei-mueller-/);
  assert.ok(adminTenant.allowed_origins.includes('https://malerei-mueller-test.de'));
  assert.match(adminTenant.snippet, /data-bot-id="pk_/);
});

test('PDF-Import liest den Text ein', opts, async () => {
  const { readFile } = await import('node:fs/promises');
  const dataBase64 = (await readFile(new URL('./fixtures/preisliste.pdf', import.meta.url))).toString('base64');
  const res = await fetch(`${base}/api/admin/tenants/${adminTenant.id}/import/pdf`, {
    method: 'POST', headers: admin, body: JSON.stringify({ filename: 'Preisliste 2026.pdf', dataBase64 }),
  });
  const r = await res.json();
  assert.equal(res.status, 200, JSON.stringify(r));
  assert.equal(r.pages, 2);
  assert.match(r.preview, /11 Euro pro Quadratmeter/);
});

test('Website-Import liest Seiten der eigenen Demo-Website', opts, async () => {
  process.env.IMPORT_ALLOW_PRIVATE = '1';
  const res = await fetch(`${base}/api/admin/tenants/${adminTenant.id}/import/website`, {
    method: 'POST', headers: admin, body: JSON.stringify({ url: `${base}/demo/farbwerk`, maxPages: 2 }),
  });
  const r = await res.json();
  assert.equal(res.status, 200, JSON.stringify(r));
  assert.ok(r.pages.length >= 1);
  assert.match(r.preview, /Malerarbeiten in Darmstadt/);
});

test('FAQ-Antwort ergänzt das Wissen und erscheint in den Quellen', opts, async () => {
  const res = await fetch(`${base}/api/admin/tenants/${adminTenant.id}/faq`, {
    method: 'POST', headers: admin, body: JSON.stringify({ question: 'Lackiert ihr Metallzäune?', answer: 'Ja, ab 25 € pro laufendem Meter.' }),
  });
  assert.equal(res.status, 201);
  const t = await (await fetch(`${base}/api/admin/tenants/${adminTenant.id}`, { headers: admin })).json();
  const sources = t.sources.map((s) => s.source);
  assert.ok(sources.includes('faq') && sources.includes('website') && sources.includes('pdf:Preisliste 2026.pdf'), sources.join());
  await query('DELETE FROM tenants WHERE id = $1', [adminTenant.id]);
});

// ---------------------------------------------------------------- Kunden-Dashboard: Login & Mandantentrennung
test('Kunden-Login per Magic Link und Zugriff nur auf den eigenen Betrieb', opts, async () => {
  const { config } = await import('../server/src/config.js');
  const origin = { Origin: config.publicUrl, 'Content-Type': 'application/json' };
  const mk = async (name) => (await (await fetch(`${base}/api/admin/tenants`, {
    method: 'POST', headers: admin, body: JSON.stringify({ name, industry: 'kosmetik', website: `${name.toLowerCase().replace(/\W+/g, '')}.de` }),
  })).json());
  const a = await mk(`Studio A ${Date.now()}`);
  const b = await mk(`Studio B ${Date.now()}`);
  await query(`INSERT INTO leads (tenant_id, kind, name, summary) VALUES ($1, 'termin', 'Fremde Anfrage', 'gehört B')`, [b.id]);
  const foreignLead = (await query('SELECT id FROM leads WHERE tenant_id = $1', [b.id])).rows[0].id;

  try {
    // Ohne Sitzung: kein Zugriff
    assert.equal((await fetch(`${base}/api/portal/tenant`)).status, 401);

    // Admin legt Zugang an → Login-Link
    const created = await (await fetch(`${base}/api/admin/tenants/${a.id}/users`, {
      method: 'POST', headers: admin, body: JSON.stringify({ email: 'Chefin@Studio-A.de' }),
    })).json();
    assert.equal(created.user.email, 'chefin@studio-a.de');
    assert.match(created.loginUrl, /\/login\/verify\?token=/);

    // Link einlösen → Cookie
    const verify = await fetch(created.loginUrl.replace(config.publicUrl, base), { redirect: 'manual' });
    assert.equal(verify.status, 303);
    assert.equal(verify.headers.get('location'), '/app/');
    const cookie = verify.headers.get('set-cookie').split(';')[0];
    assert.match(cookie, /^ek_session=/);

    // Link ist nur einmal gültig
    const again = await fetch(created.loginUrl.replace(config.publicUrl, base), { redirect: 'manual' });
    assert.equal(again.headers.get('location'), '/app/?login=abgelaufen');

    const auth = { Cookie: cookie, ...origin };
    const me = await (await fetch(`${base}/api/portal/me`, { headers: auth })).json();
    assert.equal(me.tenantId, a.id);
    const t = await (await fetch(`${base}/api/portal/tenant`, { headers: auth })).json();
    assert.equal(t.id, a.id);

    // Fremde Anfrage kann nicht geändert werden
    const patch = await fetch(`${base}/api/portal/tenant/leads/${foreignLead}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ status: 'erledigt' }) });
    assert.equal(patch.status, 404);
    const leads = await (await fetch(`${base}/api/portal/tenant/leads`, { headers: auth })).json();
    assert.equal(leads.length, 0);

    // Kunde darf Paket/Status nicht ändern, aber Domains und Begrüßung
    const upd = await (await fetch(`${base}/api/portal/tenant`, {
      method: 'PATCH', headers: auth,
      body: JSON.stringify({ plan: 'pro', active: false, allowedOrigins: ['studio-a.de', 'shop.studio-a.de'], settings: { greeting: 'Hallo!', internal: 'x' } }),
    })).json();
    assert.equal(upd.plan, 'starter');
    assert.equal(upd.active, true);
    assert.ok(upd.allowed_origins.includes('https://shop.studio-a.de'));
    assert.equal(upd.settings.greeting, 'Hallo!');
    assert.equal(upd.settings.internal, undefined);

    // Admin-API bleibt für Kunden gesperrt
    assert.equal((await fetch(`${base}/api/admin/tenants`, { headers: { Cookie: cookie } })).status, 401);

    // Fremde Herkunft (CSRF) wird abgewiesen
    const csrf = await fetch(`${base}/api/portal/tenant`, { method: 'PATCH', headers: { Cookie: cookie, Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{"name":"Hack"}' });
    assert.equal(csrf.status, 403);

    // Abmelden beendet die Sitzung
    await fetch(`${base}/api/portal/logout`, { method: 'POST', headers: auth });
    assert.equal((await fetch(`${base}/api/portal/tenant`, { headers: auth })).status, 401);

    // Login-Anfrage verrät nicht, ob es die Adresse gibt
    const unknown = await (await fetch(`${base}/api/portal/login`, { method: 'POST', headers: origin, body: JSON.stringify({ email: 'gibtsnicht@example.de' }) })).json();
    assert.deepEqual(unknown, { ok: true });
  } finally {
    await query('DELETE FROM tenants WHERE id = ANY($1)', [[a.id, b.id]]);
  }
});

// ---------------------------------------------------------------- Abrechnung: manuell, Testphase, Stripe-Webhook
test('Abrechnung: Testphase, manuell bezahlt, Ein/Aus und Stripe-Webhook', opts, async () => {
  const Stripe = (await import('stripe')).default;
  const stripe = new Stripe('sk_test_dummy');
  const t = await (await fetch(`${base}/api/admin/tenants`, {
    method: 'POST', headers: admin, body: JSON.stringify({ name: `Abrechnung Test ${Date.now()}`, industry: 'handwerk', plan: 'starter' }),
  })).json();
  const billing = async () => (await fetch(`${base}/api/admin/tenants/${t.id}/billing`, { headers: admin })).json();
  const widgetStatus = async () => (await fetch(`${base}/api/v1/widget/config?key=${t.public_key}`)).status;
  const sendEvent = async (event, secret = 'whsec_test_secret') => {
    const payload = JSON.stringify(event);
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
    return fetch(`${base}/api/stripe/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': header }, body: payload });
  };

  try {
    // 1) Neue Kunden starten in der Testphase und sind aktiv
    let b = await billing();
    assert.equal(b.status, 'trial');
    assert.equal(b.active, true);
    assert.equal(await widgetStatus(), 200);

    // 2) Abgelaufene Testphase schaltet aus
    await query(`UPDATE tenants SET trial_ends_at = now() - interval '1 hour' WHERE id = $1`, [t.id]);
    const { expireTrials } = await import('../server/src/services/billing.js');
    assert.ok((await expireTrials()) >= 1);
    b = await billing();
    assert.equal(b.status, 'expired');
    assert.equal(b.active, false);
    assert.equal(await widgetStatus(), 404);

    // 3) Kunde zahlt bei mir → manuell 3 Monate
    await fetch(`${base}/api/admin/tenants/${t.id}/billing/manual`, { method: 'POST', headers: admin, body: JSON.stringify({ months: 3, note: 'Überweisung' }) });
    b = await billing();
    assert.equal(b.status, 'active');
    assert.equal(b.method, 'manual');
    assert.equal(b.active, true);
    const expected = new Date(); expected.setMonth(expected.getMonth() + 3);
    assert.ok(Math.abs(new Date(b.paidUntil) - expected) < 3 * 86400000, b.paidUntil);
    assert.equal(await widgetStatus(), 200);

    // 4) Von Hand ausschalten
    await fetch(`${base}/api/admin/tenants/${t.id}/billing/active`, { method: 'POST', headers: admin, body: JSON.stringify({ active: false }) });
    assert.equal(await widgetStatus(), 404);

    // 5) Ungültige Signatur wird abgelehnt
    const bad = await sendEvent({ id: 'evt_bad', type: 'checkout.session.completed', data: { object: {} } }, 'whsec_falsch');
    assert.equal(bad.status, 400);

    // 6) Stripe: Checkout abgeschlossen → automatisch an, Paket übernommen
    const completed = {
      id: `evt_${Date.now()}_1`, type: 'checkout.session.completed',
      data: { object: { id: 'cs_test', client_reference_id: t.id, metadata: { tenant_id: t.id, plan: 'business' }, customer: `cus_${t.id.slice(0, 8)}`, subscription: `sub_${t.id.slice(0, 8)}`, amount_total: 5900 } },
    };
    assert.equal((await sendEvent(completed)).status, 200);
    b = await billing();
    assert.equal(b.active, true);
    assert.equal(b.method, 'stripe');
    assert.equal(b.plan, 'business');
    assert.equal(await widgetStatus(), 200);

    // Gleiches Event noch einmal → keine doppelte Verarbeitung
    assert.equal((await sendEvent(completed)).status, 200);
    const { rows } = await query(`SELECT count(*)::int AS n FROM billing_events WHERE tenant_id = $1 AND type = 'stripe_bezahlt'`, [t.id]);
    assert.equal(rows[0].n, 1);

    // 7) Abo gekündigt → automatisch aus
    const deleted = {
      id: `evt_${Date.now()}_2`, type: 'customer.subscription.deleted',
      data: { object: { id: `sub_${t.id.slice(0, 8)}`, customer: `cus_${t.id.slice(0, 8)}`, status: 'canceled', metadata: { tenant_id: t.id }, items: { data: [{ price: { id: 'price_business_test' } }] } } },
    };
    assert.equal((await sendEvent(deleted)).status, 200);
    b = await billing();
    assert.equal(b.status, 'canceled');
    assert.equal(b.active, false);
    assert.equal(await widgetStatus(), 404);

    // Verlauf enthält alle Schritte
    assert.ok(b.events.length >= 5);
  } finally {
    await query('DELETE FROM tenants WHERE id = $1', [t.id]);
  }
});
