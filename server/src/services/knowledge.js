// Wissensbasis: Texte in Abschnitte zerlegen, speichern und passend zur Frage abrufen.
//
// Strategie:
//  - Kleine Wissensbasis (typisch für kleine Betriebe): alles in den Prompt legen.
//    Mit Prompt-Caching ist das günstig und liefert die genauesten Antworten.
//  - Große Wissensbasis: HYBRIDE SUCHE
//      1. Volltextsuche (Postgres tsvector, deutsch): findet exakte Begriffe, Namen, Preise, Nummern.
//      2. Semantische Suche (Embeddings): findet Abschnitte mit gleicher BEDEUTUNG,
//         auch bei anderen Wörtern oder in einer anderen Sprache.
//      3. Reciprocal Rank Fusion (RRF): führt beide Ranglisten zu einer zusammen.
//    Sind Embeddings nicht verfügbar, läuft automatisch nur die Volltextsuche.
import { config } from '../config.js';
import { query, withTransaction } from '../db/pool.js';
import { dot, embedPassages, embedQuery } from './embeddings.js';

/** Grobe Token-Schätzung (deutsch ≈ 4 Zeichen pro Token) – reicht für Budgets. */
export const estimateTokens = (text) => Math.ceil(String(text).length / 4);

/**
 * Zerlegt einen Text an Überschriften/Absätzen in Abschnitte von ca. maxTokens.
 * Markdown-Überschriften (#, ##) werden als Titel übernommen.
 */
export function chunkText(text, { title = 'Allgemein', maxTokens = 350 } = {}) {
  const chunks = [];
  let currentTitle = title;
  let buffer = [];

  const flush = () => {
    const content = buffer.join('\n').trim();
    if (content) chunks.push({ title: currentTitle, content });
    buffer = [];
  };

  for (const rawLine of String(text).replace(/\r\n/g, '\n').split('\n')) {
    const heading = rawLine.match(/^#{1,3}\s+(.+)/);
    if (heading) {
      flush();
      currentTitle = heading[1].trim();
      continue;
    }
    buffer.push(rawLine);
    // Absatzgrenze und Budget überschritten → neuer Abschnitt
    if (rawLine.trim() === '' && estimateTokens(buffer.join('\n')) >= maxTokens) flush();
  }
  flush();

  // Sehr lange Abschnitte ohne Leerzeilen hart nach Sätzen teilen
  return chunks.flatMap((c) => splitLong(c, maxTokens));
}

function splitLong(chunk, maxTokens) {
  if (estimateTokens(chunk.content) <= maxTokens * 1.5) return [chunk];
  const sentences = chunk.content.split(/(?<=[.!?])\s+/);
  const parts = [];
  let cur = '';
  for (const s of sentences) {
    if (cur && estimateTokens(cur + ' ' + s) > maxTokens) {
      parts.push(cur);
      cur = s;
    } else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) parts.push(cur);
  return parts.map((content) => ({ title: chunk.title, content }));
}

/** Text, aus dem das Embedding eines Abschnitts berechnet wird: Titel + Inhalt. */
const passageText = (title, content) => `${title}\n${content}`;

/** Ersetzt die Wissensbasis einer Quelle (z. B. "manual") komplett. */
export async function replaceKnowledge(tenantId, { source = 'manual', title, text }) {
  const chunks = chunkText(text, { title });
  // Embeddings VOR der Transaktion berechnen (dauert etwas). null = nicht verfügbar → später nachholen.
  const vectors = await embedPassages(chunks.map((c) => passageText(c.title, c.content)));
  const count = await withTransaction(async (db) => {
    await db.query('DELETE FROM knowledge_chunks WHERE tenant_id = $1 AND source = $2', [tenantId, source]);
    let position = 0;
    for (const [i, c] of chunks.entries()) {
      await db.query(
        `INSERT INTO knowledge_chunks (tenant_id, source, title, content, tokens, position, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [tenantId, source, c.title, c.content, estimateTokens(c.title + c.content), position++, vectors?.[i] ?? null],
      );
    }
    return chunks.length;
  });
  invalidateVectorCache(tenantId);
  return count;
}

export async function knowledgeStats(tenantId) {
  const { rows } = await query(
    'SELECT count(*)::int AS chunks, coalesce(sum(tokens), 0)::int AS tokens FROM knowledge_chunks WHERE tenant_id = $1',
    [tenantId],
  );
  return rows[0];
}

/**
 * Liefert den Wissenskontext für eine Frage.
 * @returns {{ mode: 'full'|'hybrid'|'search', text: string, chunkIds: number[] }}
 *   full = ganze Wissensbasis im Prompt, hybrid = Volltext + semantisch, search = nur Volltext
 */
export async function retrieveContext(tenantId, question) {
  const { tokens } = await knowledgeStats(tenantId);

  if (tokens <= config.knowledge.fullContextTokenBudget) {
    const { rows } = await query(
      'SELECT id, title, content FROM knowledge_chunks WHERE tenant_id = $1 ORDER BY source, position',
      [tenantId],
    );
    return { mode: 'full', text: formatChunks(rows), chunkIds: rows.map((r) => r.id) };
  }

  const { rows, method } = await searchChunks(tenantId, question, { method: 'hybrid', limit: config.knowledge.topK });

  // Immer die ersten Abschnitte (meist Kontakt/Öffnungszeiten) mitgeben
  const { rows: base } = await query(
    'SELECT id, title, content FROM knowledge_chunks WHERE tenant_id = $1 ORDER BY source, position LIMIT 2',
    [tenantId],
  );
  const seen = new Set();
  const merged = [...base, ...rows].filter((r) => (seen.has(r.id) ? false : seen.add(r.id)));
  return { mode: method === 'hybrid' ? 'hybrid' : 'search', text: formatChunks(merged), chunkIds: merged.map((r) => r.id) };
}

/**
 * Sucht die passendsten Abschnitte zu einer Frage.
 * @param {'fts'|'vector'|'hybrid'} method  fts = nur Volltext, vector = nur semantisch, hybrid = beides + RRF
 * @returns {{ rows: {id, title, content}[], method: 'fts'|'vector'|'hybrid' }}  method = tatsächlich genutzte Methode
 */
export async function searchChunks(tenantId, question, { method = 'hybrid', limit = config.knowledge.topK } = {}) {
  const n = Math.max(limit, config.knowledge.candidateK);

  const vectorIds = method === 'fts' ? null : await vectorSearch(tenantId, question, n);

  let ids;
  let used;
  if (method === 'fts' || vectorIds === null) {
    // Nur Volltext (gewollt oder weil Embeddings gerade nicht verfügbar sind):
    // breite ODER-Suche, damit überhaupt etwas gefunden wird.
    ids = await fullTextSearch(tenantId, question, n, { match: 'any' });
    used = 'fts';
  } else if (method === 'vector') {
    ids = vectorIds;
    used = 'vector';
  } else {
    // Hybrid: strenge UND-Suche. Sie liefert nur dann Treffer, wenn ALLE Suchwörter vorkommen –
    // also genau bei exakten Begriffen, Modell- und Telefonnummern. Die breite ODER-Suche
    // würde hier nur Rauschen beisteuern (siehe eval/retrieval/RESULTS.md).
    const ftsIds = await fullTextSearch(tenantId, question, n, { match: 'all' });
    ids = reciprocalRankFusion([ftsIds, vectorIds], config.knowledge.rrfK);
    used = 'hybrid';
  }
  return { rows: await chunksByIds(tenantId, ids.slice(0, limit)), method: used };
}

/**
 * Volltextsuche (lexikalisch): "websearch_to_tsquery" verträgt freie Nutzereingaben,
 * 'german' reduziert Wörter auf ihren Stamm (öffnen/geöffnet → "offn") und ignoriert Füllwörter.
 * @param {'any'|'all'} match  any = mindestens ein Wort muss vorkommen (ODER), all = alle Wörter (UND)
 * Liefert IDs, beste zuerst.
 */
export async function fullTextSearch(tenantId, question, n, { match = 'any' } = {}) {
  const words = String(question)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 20);
  if (!words.length) return [];
  const text = match === 'all' ? words.join(' ') : words.join(' OR ');
  const { rows } = await query(
    `SELECT id, ts_rank(tsv, q) AS rank
       FROM knowledge_chunks, websearch_to_tsquery('german', $2) q
      WHERE tenant_id = $1 AND tsv @@ q
      ORDER BY rank DESC, id LIMIT $3`,
    [tenantId, text, n],
  );
  return rows.map((r) => Number(r.id));
}

/**
 * Semantische Suche: Frage → Embedding, dann die Abschnitte mit der höchsten
 * Kosinus-Ähnlichkeit (exakte Suche über alle Abschnitte des Kunden).
 * Liefert IDs (beste zuerst) oder null, wenn Embeddings nicht verfügbar sind.
 */
export async function vectorSearch(tenantId, question, n) {
  const q = await embedQuery(question);
  if (!q) return null;
  const items = await tenantVectors(tenantId);
  return topKBySimilarity(q, items, n).map((x) => x.id);
}

/** Die n Einträge mit der höchsten Ähnlichkeit zum Vektor q (Vektoren sind normalisiert → Skalarprodukt). */
export function topKBySimilarity(q, items, n) {
  return items
    .map(({ id, vector }) => ({ id, score: dot(q, vector) }))
    .sort((a, b) => b.score - a.score || a.id - b.id)
    .slice(0, n);
}

/**
 * Reciprocal Rank Fusion: führt mehrere Ranglisten zusammen.
 * Jedes Dokument bekommt pro Liste 1 / (k + Rang) Punkte (Rang ab 1), die Punkte werden addiert.
 * Vorteil: nutzt nur die Ränge, nicht die Scores – die sind bei Volltext und Embeddings
 * nicht vergleichbar (ts_rank vs. Kosinus). Wer in beiden Listen weit oben steht, gewinnt.
 */
export function reciprocalRankFusion(lists, k = 60) {
  const scores = new Map();
  for (const list of lists) {
    list.forEach((id, index) => scores.set(id, (scores.get(id) || 0) + 1 / (k + index + 1)));
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([id]) => id);
}

/** Lädt Abschnitte in der Reihenfolge der übergebenen IDs. */
async function chunksByIds(tenantId, ids) {
  if (!ids.length) return [];
  const { rows } = await query(
    'SELECT id, title, content FROM knowledge_chunks WHERE tenant_id = $1 AND id = ANY($2::bigint[])',
    [tenantId, ids],
  );
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Vektor-Cache: die Embeddings eines Kunden werden einmal aus der Datenbank geladen
// und im Speicher gehalten, statt sie bei jeder Frage neu zu lesen.
// Wird bei jeder Änderung der Wissensbasis geleert; nach 5 Minuten sowieso neu geladen.
// ---------------------------------------------------------------------------
const VECTOR_CACHE_TTL_MS = 5 * 60 * 1000;
const vectorCache = new Map();

async function tenantVectors(tenantId) {
  const cached = vectorCache.get(tenantId);
  if (cached && Date.now() - cached.loadedAt < VECTOR_CACHE_TTL_MS) return cached.items;
  const { rows } = await query(
    'SELECT id, embedding FROM knowledge_chunks WHERE tenant_id = $1 AND embedding IS NOT NULL',
    [tenantId],
  );
  const items = rows.map((r) => ({ id: Number(r.id), vector: Float32Array.from(r.embedding) }));
  vectorCache.set(tenantId, { loadedAt: Date.now(), items });
  return items;
}

export function invalidateVectorCache(tenantId) {
  vectorCache.delete(tenantId);
}

/**
 * Berechnet fehlende Embeddings nach (z. B. nach dem Update oder wenn das Modell
 * beim Speichern nicht verfügbar war). Liefert die Anzahl neu berechneter Abschnitte.
 */
export async function embedMissingChunks({ batchSize = 64, log = () => {} } = {}) {
  let total = 0;
  for (;;) {
    const { rows } = await query(
      'SELECT id, tenant_id, title, content FROM knowledge_chunks WHERE embedding IS NULL ORDER BY id LIMIT $1',
      [batchSize],
    );
    if (!rows.length) break;
    const vectors = await embedPassages(rows.map((r) => passageText(r.title, r.content)));
    if (!vectors) break; // Modell nicht verfügbar → später erneut
    for (const [i, r] of rows.entries()) {
      await query('UPDATE knowledge_chunks SET embedding = $2 WHERE id = $1', [r.id, vectors[i]]);
      invalidateVectorCache(r.tenant_id);
    }
    total += rows.length;
    log(`[embeddings] ${total} Abschnitte nachberechnet`);
  }
  return total;
}

export function formatChunks(rows) {
  return rows.map((r) => `## ${r.title}\n${r.content}`).join('\n\n');
}

/** Fügt einen einzelnen Wissensabschnitt hinzu (z. B. eine FAQ-Antwort), ohne andere zu löschen. */
export async function addKnowledgeEntry(tenantId, { source = 'faq', title, content }) {
  const vectors = await embedPassages([passageText(title, content)]);
  const { rows } = await query(
    `INSERT INTO knowledge_chunks (tenant_id, source, title, content, tokens, position, embedding)
     VALUES ($1, $2, $3, $4, $5,
       (SELECT coalesce(max(position), -1) + 1 FROM knowledge_chunks WHERE tenant_id = $1 AND source = $2), $6)
     RETURNING id`,
    [tenantId, source, title, content, estimateTokens(title + content), vectors?.[0] ?? null],
  );
  invalidateVectorCache(tenantId);
  return rows[0].id;
}

/** Übersicht der Wissensquellen eines Kunden (manuell, Website, PDFs, FAQ). */
export async function listSources(tenantId) {
  const { rows } = await query(
    `SELECT source, count(*)::int AS chunks, sum(tokens)::int AS tokens, max(created_at) AS updated_at
       FROM knowledge_chunks WHERE tenant_id = $1 GROUP BY source ORDER BY min(created_at)`,
    [tenantId],
  );
  return rows;
}

export async function deleteSource(tenantId, source) {
  const { rowCount } = await query('DELETE FROM knowledge_chunks WHERE tenant_id = $1 AND source = $2', [tenantId, source]);
  invalidateVectorCache(tenantId);
  return rowCount;
}

export async function deleteChunk(tenantId, chunkId) {
  const { rowCount } = await query('DELETE FROM knowledge_chunks WHERE tenant_id = $1 AND id = $2', [tenantId, chunkId]);
  invalidateVectorCache(tenantId);
  return rowCount;
}
