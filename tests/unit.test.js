import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chunkText, estimateTokens } from '../server/src/services/knowledge.js';
import { normalizeOrigins, publicWidgetConfig } from '../server/src/services/tenants.js';
import { isOriginAllowed } from '../server/src/middleware/security.js';
import { buildSystemPrompt, industries } from '../server/src/templates/industries.js';
import { buildSystemBlocks, leadTool } from '../server/src/services/chat.js';

const tenant = (over = {}) => ({
  id: 't1', name: 'Malerbetrieb Test', industry: 'handwerk', city: 'Darmstadt',
  phone: '06151 123', contact_email: 'info@test.de', settings: {}, allowed_origins: ['https://maler-test.de'], ...over,
});

test('chunkText übernimmt Überschriften als Titel', () => {
  const chunks = chunkText('# Öffnungszeiten\nMo–Fr 8–17 Uhr\n\n# Preise\nAb 9 € pro m²');
  assert.deepEqual(chunks.map((c) => c.title), ['Öffnungszeiten', 'Preise']);
  assert.match(chunks[1].content, /9 €/);
});

test('chunkText teilt sehr lange Abschnitte', () => {
  const long = Array.from({ length: 200 }, (_, i) => `Satz Nummer ${i} mit etwas Inhalt.`).join(' ');
  const chunks = chunkText(long, { maxTokens: 100 });
  assert.ok(chunks.length > 5);
  assert.ok(chunks.every((c) => estimateTokens(c.content) <= 150));
});

test('normalizeOrigins ergänzt https und www', () => {
  assert.deepEqual(normalizeOrigins(['Praxis-Mueller.de/']).sort(), ['https://praxis-mueller.de', 'https://www.praxis-mueller.de']);
  assert.deepEqual(normalizeOrigins(['http://localhost:8080']), ['http://localhost:8080']);
});

test('isOriginAllowed: hinterlegte Domain ja, fremde Domain nein', () => {
  const t = tenant();
  assert.equal(isOriginAllowed(t, 'https://maler-test.de'), true);
  assert.equal(isOriginAllowed(t, 'https://evil.example'), false);
});

test('Systemprompt enthält Firmenname, Regeln und Kontakt', () => {
  const p = buildSystemPrompt(tenant({ settings: { bookingUrl: 'https://buchen.test' } }));
  assert.match(p, /Malerbetrieb Test/);
  assert.match(p, /Erfinde niemals/);
  assert.match(p, /buchen\.test/);
  assert.match(p, /06151 123/);
});

test('kleine Wissensbasis wird komplett und gecacht in den Prompt gelegt', () => {
  const blocks = buildSystemBlocks(tenant(), { mode: 'full', text: '## Preise\nAb 9 €' });
  assert.equal(blocks[0].cache, true);
  assert.match(blocks[0].text, /Ab 9 €/);
  const search = buildSystemBlocks(tenant(), { mode: 'search', text: 'x' });
  assert.equal(search.length, 3);
  assert.equal(search[1].cache, undefined);
});

test('jede Branche kennt die Anfrage-Art "offene_frage"', () => {
  for (const [key, t] of Object.entries(industries)) {
    assert.ok(t.leadKinds.includes('offene_frage'), key);
  }
  assert.ok(leadTool(tenant()).input_schema.properties.offene_frage);
});

test('Notfall-Erkennung Hausverwaltung', () => {
  const { pattern } = industries.hausverwaltung.emergency;
  assert.ok(pattern.test('Im Keller riecht es nach Gas'));
  assert.ok(pattern.test('Wasserrohrbruch in der Küche'));
  assert.ok(!pattern.test('Wann kommt die Gasabrechnung?'));
});

test('Notfall-Erkennung Arztpraxis', () => {
  const { pattern } = industries.arztpraxis.emergency;
  assert.ok(pattern.test('Ich habe starke Brustschmerzen'));
  assert.ok(!pattern.test('Wann haben Sie Sprechstunde?'));
});

test('öffentliche Widget-Konfiguration enthält keine internen Daten', () => {
  const cfg = publicWidgetConfig(tenant());
  assert.equal(cfg.name, 'Malerbetrieb Test');
  assert.equal(cfg.contact_email, undefined);
  assert.equal(cfg.allowed_origins, undefined);
  assert.ok(cfg.quickReplies.length > 0);
});

test('requestOrigin: gleiche Domain ohne Origin-Header wird erkannt', async () => {
  const { requestOrigin } = await import('../server/src/middleware/security.js');
  const { config } = await import('../server/src/config.js');
  assert.equal(requestOrigin({ headers: { origin: 'https://kunde.de' } }), 'https://kunde.de');
  assert.equal(requestOrigin({ headers: { 'sec-fetch-site': 'same-origin' } }), config.publicUrl);
  assert.equal(requestOrigin({ headers: { referer: 'https://kunde.de/kontakt?x=1' } }), 'https://kunde.de');
  assert.equal(requestOrigin({ headers: {} }), null);
});
