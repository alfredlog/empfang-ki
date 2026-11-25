// Tests der Wissenssuche: Fusion, Ähnlichkeitssuche und hybride Suche gegen eine echte Datenbank.
// Embeddings im Mock-Modus (ohne Modell). Datenbank-Tests werden übersprungen, wenn keine erreichbar ist.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

process.env.EMBEDDINGS_PROVIDER = 'mock';
process.env.KNOWLEDGE_FULL_CONTEXT_TOKENS = '10'; // sofort Such-Modus statt "alles in den Prompt"

const { pool, query } = await import('../server/src/db/pool.js');
const { mockEmbedding, dot, DIMENSIONS } = await import('../server/src/services/embeddings.js');
const {
  reciprocalRankFusion, topKBySimilarity, replaceKnowledge, retrieveContext, searchChunks, addKnowledgeEntry,
} = await import('../server/src/services/knowledge.js');

test('RRF: wer in beiden Listen weit oben steht, gewinnt', () => {
  // 3 steht in beiden Listen auf Platz 2 → schlägt die beiden Einzel-Ersten 1 und 2
  assert.deepEqual(reciprocalRankFusion([[1, 3, 5], [2, 3, 6]]).slice(0, 1), [3]);
});

test('RRF: Punkte = Summe von 1/(k + Rang)', () => {
  const fused = reciprocalRankFusion([[10], [10, 20]], 60);
  assert.deepEqual(fused, [10, 20]); // 10: 1/61 + 1/61, 20: 1/62
  assert.deepEqual(reciprocalRankFusion([[], []]), []);
});

test('Ähnlichkeitssuche sortiert nach Skalarprodukt', () => {
  const items = [
    { id: 1, vector: [1, 0] },
    { id: 2, vector: [0.6, 0.8] },
    { id: 3, vector: [0, 1] },
  ];
  assert.deepEqual(topKBySimilarity([0, 1], items, 2).map((x) => x.id), [3, 2]);
});

test('Mock-Embedding: normalisiert, gleiche Wörter → ähnlich', () => {
  const a = mockEmbedding('passage: Öffnungszeiten Montag bis Freitag');
  assert.equal(a.length, DIMENSIONS);
  assert.ok(Math.abs(dot(a, a) - 1) < 1e-9);
  const near = dot(mockEmbedding('query: Öffnungszeiten am Freitag'), a);
  const far = dot(mockEmbedding('query: Preise für Fliesen'), a);
  assert.ok(near > far);
});

// --- mit Datenbank ---------------------------------------------------------
let dbOk = true;
try { await pool.query('SELECT 1'); } catch { dbOk = false; }
const opts = { skip: dbOk ? false : 'keine Datenbank erreichbar' };
let tenantId;

before(async () => {
  if (!dbOk) return;
  const { migrate } = await import('../server/src/db/migrate.js');
  await migrate({ log: () => {} });
  const slug = `retrieval-${Date.now()}`;
  ({ rows: [{ id: tenantId }] } = await query(
    `INSERT INTO tenants (public_key, slug, name, industry) VALUES ($1, $2, 'Retrieval Test', 'handwerk') RETURNING id`,
    [`pk_${slug}`, slug],
  ));
  await replaceKnowledge(tenantId, {
    source: 'manual',
    text: [
      '# Kontakt', 'Telefon 06151 123 456, info@test.de',
      '# Öffnungszeiten', 'Montag bis Freitag von 8 bis 17 Uhr geöffnet.',
      '# Fliesen', 'Wir verlegen Fliesen im Bad und in der Küche.',
      '# Ersatzteile', 'Teile für die Gastherme VC 206/5-5 sind am Lager.',
      '# Wärmepumpen', 'Wir installieren Luft-Wasser-Wärmepumpen.',
    ].join('\n'),
  });
});

after(async () => {
  if (tenantId) await query('DELETE FROM tenants WHERE id = $1', [tenantId]);
  await pool.end();
});

test('Beim Speichern bekommt jeder Abschnitt ein Embedding', opts, async () => {
  const { rows } = await query('SELECT embedding FROM knowledge_chunks WHERE tenant_id = $1', [tenantId]);
  assert.equal(rows.length, 5);
  assert.ok(rows.every((r) => Array.isArray(r.embedding) && r.embedding.length === DIMENSIONS));
});

test('Große Wissensbasis → hybride Suche findet den passenden Abschnitt', opts, async () => {
  const ctx = await retrieveContext(tenantId, 'Verlegt ihr Fliesen in der Küche?');
  assert.equal(ctx.mode, 'hybrid');
  assert.match(ctx.text, /## Fliesen/);
  assert.match(ctx.text, /## Kontakt/); // die ersten Abschnitte sind immer dabei
});

test('Alle drei Methoden liefern Ergebnisse; Modellnummer über Volltext', opts, async () => {
  for (const method of ['fts', 'vector', 'hybrid']) {
    const { rows, method: used } = await searchChunks(tenantId, 'Habt ihr Teile für VC 206/5-5?', { method, limit: 3 });
    assert.equal(used, method);
    assert.equal(rows[0].title, 'Ersatzteile', `Methode ${method}`);
  }
});

test('Neuer FAQ-Eintrag ist sofort über die semantische Suche auffindbar', opts, async () => {
  await addKnowledgeEntry(tenantId, { title: 'Parkplätze', content: 'Kundenparkplätze direkt vor dem Haus.' });
  const { rows } = await searchChunks(tenantId, 'Gibt es Parkplätze?', { method: 'vector', limit: 1 });
  assert.equal(rows[0].title, 'Parkplätze');
});
