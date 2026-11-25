// Evaluation der Wissenssuche: vergleicht Volltext, semantische Suche und hybride Suche.
//   npm run eval:retrieval
//
// Ablauf:
//  1. Legt einen temporären Test-Kunden an und lädt eval/retrieval/wissensbasis.md als Wissen.
//  2. Stellt jede Frage aus eval/retrieval/fragen.json mit allen drei Methoden.
//  3. Prüft, an welcher Stelle der erwartete Abschnitt in den Top 5 steht.
//  4. Berechnet Kennzahlen pro Methode und pro Kategorie, schreibt eval/retrieval/RESULTS.md.
//  5. Löscht den Test-Kunden wieder.
//
// Kennzahlen:
//  - Hit@1  : Anteil der Fragen, bei denen der richtige Abschnitt auf Platz 1 steht
//  - Recall@3 / Recall@5 : Anteil der Fragen, bei denen er in den Top 3 / Top 5 steht
//  - MRR@5  : Mean Reciprocal Rank – Durchschnitt von 1/Platz (Platz 1 → 1, Platz 2 → 0,5, nicht gefunden → 0)
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { migrate } from '../db/migrate.js';
import { pool, query } from '../db/pool.js';
import { embeddingsEnabled } from '../services/embeddings.js';
import { replaceKnowledge, searchChunks } from '../services/knowledge.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dir = path.join(root, 'eval/retrieval');
const METHODS = ['fts', 'vector', 'hybrid'];
const NAMES = { fts: 'Volltext', vector: 'Semantisch', hybrid: 'Hybrid (RRF)' };
const K = 5;

if (!embeddingsEnabled()) {
  console.error('EMBEDDINGS_PROVIDER ist "none" – für den Vergleich werden Embeddings gebraucht.');
  process.exit(1);
}

await migrate({ log: () => {} });
const knowledge = await readFile(path.join(dir, 'wissensbasis.md'), 'utf8');
const { fragen } = JSON.parse(await readFile(path.join(dir, 'fragen.json'), 'utf8'));

const slug = `eval-${Date.now()}`;
const { rows: [tenant] } = await query(
  `INSERT INTO tenants (public_key, slug, name, industry) VALUES ($1, $2, 'Eval Haustechnik', 'handwerk') RETURNING id`,
  [`pk_${slug}`, slug],
);

try {
  const chunks = await replaceKnowledge(tenant.id, { source: 'manual', title: 'Allgemein', text: knowledge });
  const { rows: [{ missing }] } = await query(
    'SELECT count(*)::int AS missing FROM knowledge_chunks WHERE tenant_id = $1 AND embedding IS NULL', [tenant.id],
  );
  if (missing) throw new Error(`${missing} Abschnitte ohne Embedding – Modell nicht verfügbar?`);
  console.log(`Wissensbasis: ${chunks} Abschnitte, ${fragen.length} Fragen, Modell ${config.embeddings.model}\n`);

  const results = []; // { kategorie, frage, method, rank, ms, top }
  for (const f of fragen) {
    for (const method of METHODS) {
      const t0 = performance.now();
      const { rows, method: used } = await searchChunks(tenant.id, f.frage, { method, limit: K });
      const ms = performance.now() - t0;
      if (used !== method) throw new Error(`Methode ${method} nicht verfügbar (genutzt: ${used})`);
      const idx = rows.findIndex((r) => f.erwartet.includes(r.title));
      results.push({ kategorie: f.kategorie, frage: f.frage, method, rank: idx === -1 ? null : idx + 1, ms, top: rows[0]?.title ?? '—' });
    }
  }

  const metrics = (list) => {
    const n = list.length || 1;
    const hit = (k) => list.filter((r) => r.rank && r.rank <= k).length / n;
    return {
      n: list.length,
      hit1: hit(1),
      recall3: hit(3),
      recall5: hit(5),
      mrr: list.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / n,
      ms: list.reduce((s, r) => s + r.ms, 0) / n,
    };
  };
  const pct = (x) => `${Math.round(x * 100)} %`;
  const kategorien = [...new Set(fragen.map((f) => f.kategorie))];

  let md = `# Evaluation der Wissenssuche\n\n`;
  md += `Erzeugt mit \`npm run eval:retrieval\` am ${new Date().toISOString().slice(0, 10)}.\n\n`;
  md += `- Wissensbasis: fiktiver Sanitär- und Heizungsbetrieb, ${chunks} Abschnitte (\`eval/retrieval/wissensbasis.md\`)\n`;
  md += `- ${fragen.length} Testfragen mit erwartetem Abschnitt (\`eval/retrieval/fragen.json\`)\n`;
  md += `- Embedding-Modell: ${config.embeddings.model} (${config.embeddings.dtype}), Fusion: Reciprocal Rank Fusion mit k = ${config.knowledge.rrfK}\n\n`;
  md += `## Gesamt (Top ${K})\n\n| Methode | Hit@1 | Recall@3 | Recall@5 | MRR@5 | Ø Zeit |\n|---|---|---|---|---|---|\n`;
  for (const m of METHODS) {
    const s = metrics(results.filter((r) => r.method === m));
    md += `| ${NAMES[m]} | ${pct(s.hit1)} | ${pct(s.recall3)} | ${pct(s.recall5)} | ${s.mrr.toFixed(2)} | ${s.ms.toFixed(0)} ms |\n`;
  }
  md += `\n## Recall@3 nach Fragetyp\n\n| Fragetyp | Anzahl | ${METHODS.map((m) => NAMES[m]).join(' | ')} |\n|---|---|${METHODS.map(() => '---').join('|')}|\n`;
  for (const k of kategorien) {
    const cells = METHODS.map((m) => pct(metrics(results.filter((r) => r.method === m && r.kategorie === k)).recall3));
    md += `| ${k} | ${fragen.filter((f) => f.kategorie === k).length} | ${cells.join(' | ')} |\n`;
  }
  md += `\n## Einzelergebnisse (Platz des richtigen Abschnitts, – = nicht in den Top ${K})\n\n| Typ | Frage | ${METHODS.map((m) => NAMES[m]).join(' | ')} |\n|---|---|${METHODS.map(() => '---').join('|')}|\n`;
  for (const f of fragen) {
    const cells = METHODS.map((m) => results.find((r) => r.frage === f.frage && r.method === m).rank ?? '–');
    md += `| ${f.kategorie} | ${f.frage} | ${cells.join(' | ')} |\n`;
  }
  md += `\n**Hinweis:** Wissensbasis und Fragen sind selbst erstellt und klein (${fragen.length} Fragen). Die Zahlen zeigen Tendenzen, keine allgemeingültigen Werte.\n`;

  await writeFile(path.join(dir, 'RESULTS.md'), md);
  console.log(md);
} finally {
  await query('DELETE FROM tenants WHERE id = $1', [tenant.id]);
  await pool.end();
}
