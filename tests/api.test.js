// Integrationstest gegen eine echte Postgres-Datenbank (Mock-LLM).
// Wird übersprungen, wenn keine Datenbank erreichbar ist.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

process.env.LLM_PROVIDER = 'mock';
process.env.ADMIN_TOKEN = 'test-admin-token';

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
