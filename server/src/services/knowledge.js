// Wissensbasis: Texte in Abschnitte zerlegen, speichern und passend zur Frage abrufen.
//
// Strategie:
//  - Kleine Wissensbasis (typisch für kleine Betriebe): alles in den Prompt legen.
//    Mit Prompt-Caching ist das günstig und liefert die genauesten Antworten.
//  - Große Wissensbasis: deutsche Volltextsuche (Postgres tsvector) liefert die Top-K Abschnitte.
//    Embeddings/pgvector können später als weiterer Retriever ergänzt werden.
import { config } from '../config.js';
import { query, withTransaction } from '../db/pool.js';

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

/** Ersetzt die Wissensbasis einer Quelle (z. B. "manual") komplett. */
export async function replaceKnowledge(tenantId, { source = 'manual', title, text }) {
  const chunks = chunkText(text, { title });
  return withTransaction(async (db) => {
    await db.query('DELETE FROM knowledge_chunks WHERE tenant_id = $1 AND source = $2', [tenantId, source]);
    let position = 0;
    for (const c of chunks) {
      await db.query(
        `INSERT INTO knowledge_chunks (tenant_id, source, title, content, tokens, position)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [tenantId, source, c.title, c.content, estimateTokens(c.title + c.content), position++],
      );
    }
    return chunks.length;
  });
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
 * @returns {{ mode: 'full'|'search', text: string, chunkIds: number[] }}
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

  // Volltextsuche; "websearch_to_tsquery" verträgt freie Nutzereingaben.
  // OR-Verknüpfung der Wörter, damit auch Teiltreffer zählen.
  const orQuery = String(question)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 20)
    .join(' OR ');

  let rows = [];
  if (orQuery) {
    ({ rows } = await query(
      `SELECT id, title, content, ts_rank(tsv, q) AS rank
         FROM knowledge_chunks, websearch_to_tsquery('german', $2) q
        WHERE tenant_id = $1 AND tsv @@ q
        ORDER BY rank DESC LIMIT $3`,
      [tenantId, orQuery, config.knowledge.topK],
    ));
  }
  // Immer die ersten Abschnitte (meist Kontakt/Öffnungszeiten) mitgeben
  const { rows: base } = await query(
    'SELECT id, title, content FROM knowledge_chunks WHERE tenant_id = $1 ORDER BY source, position LIMIT 2',
    [tenantId],
  );
  const seen = new Set();
  const merged = [...base, ...rows].filter((r) => (seen.has(r.id) ? false : seen.add(r.id)));
  return { mode: 'search', text: formatChunks(merged), chunkIds: merged.map((r) => r.id) };
}

export function formatChunks(rows) {
  return rows.map((r) => `## ${r.title}\n${r.content}`).join('\n\n');
}
