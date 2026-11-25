// Embeddings: wandelt Text in einen Vektor aus 384 Zahlen um, der die BEDEUTUNG des Textes beschreibt.
// Texte mit ähnlicher Bedeutung bekommen ähnliche Vektoren – auch ohne gemeinsame Wörter
// ("Wann habt ihr auf?" ≈ "Öffnungszeiten") und über Sprachen hinweg ("When are you open?").
//
// Modell: multilingual-e5-small (läuft lokal auf der CPU über ONNX Runtime):
//  - mehrsprachig, also auch für deutsche Texte geeignet
//  - E5-Modelle erwarten Präfixe: "query: " für Fragen, "passage: " für Wissenstexte
//  - Ausgabe wird normalisiert (Länge 1) → Kosinus-Ähnlichkeit = einfaches Skalarprodukt
//
// Robustheit: Ist das Modell nicht verfügbar (z. B. Download fehlgeschlagen), liefern die
// Funktionen null. Die Wissenssuche fällt dann automatisch auf die reine Volltextsuche zurück.
import { config } from '../config.js';

export const DIMENSIONS = 384;
const BATCH_SIZE = 16;
const RETRY_AFTER_MS = 10 * 60 * 1000;

let extractorPromise = null;
let disabledUntil = 0;

export function embeddingsEnabled() {
  return config.embeddings.provider !== 'none';
}

/** Lädt das Modell genau einmal (beim ersten Aufruf) und merkt es sich. */
async function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');
      if (config.embeddings.cacheDir) env.cacheDir = config.embeddings.cacheDir;
      if (config.embeddings.localModelPath) {
        env.localModelPath = config.embeddings.localModelPath;
        env.allowRemoteModels = false;
      }
      const started = Date.now();
      const extractor = await pipeline('feature-extraction', config.embeddings.model, { dtype: config.embeddings.dtype });
      console.log(`[embeddings] Modell ${config.embeddings.model} geladen (${Date.now() - started} ms)`);
      return extractor;
    })();
    // Fehler nicht dauerhaft speichern: nach einer Pause neu versuchen
    extractorPromise.catch(() => { extractorPromise = null; });
  }
  return extractorPromise;
}

/**
 * Berechnet Embeddings für mehrere Texte. Liefert ein Array von Zahlen-Arrays
 * (gleiche Reihenfolge wie die Eingabe) oder null, wenn Embeddings nicht verfügbar sind.
 */
async function embed(texts) {
  if (!texts.length) return [];
  if (!embeddingsEnabled() || Date.now() < disabledUntil) return null;
  if (config.embeddings.provider === 'mock') return texts.map(mockEmbedding);

  try {
    const extractor = await getExtractor();
    const vectors = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      // mean pooling: Durchschnitt über alle Token-Vektoren; normalize: Länge 1
      const output = await extractor(batch, { pooling: 'mean', normalize: true });
      vectors.push(...output.tolist());
    }
    return vectors;
  } catch (err) {
    disabledUntil = Date.now() + RETRY_AFTER_MS;
    console.error(`[embeddings] nicht verfügbar, nutze nur Volltextsuche (neuer Versuch in 10 Min.): ${err.message}`);
    return null;
  }
}

/** Embeddings für Wissensabschnitte (Präfix "passage: "). */
export function embedPassages(passages) {
  return embed(passages.map((p) => `passage: ${p}`));
}

/** Embedding für eine Frage (Präfix "query: "). Liefert einen Vektor oder null. */
export async function embedQuery(question) {
  const result = await embed([`query: ${question}`]);
  return result ? result[0] : null;
}

/** Lädt das Modell beim Start im Hintergrund vor, damit die erste Frage nicht wartet. */
export async function warmupEmbeddings() {
  if (config.embeddings.provider !== 'local') return;
  await embed(['warmup']);
}

/** Skalarprodukt zweier gleich langer Vektoren (bei normalisierten Vektoren = Kosinus-Ähnlichkeit). */
export function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

/**
 * Nur für Tests: deterministischer "Bag of Words"-Vektor ohne Modell.
 * Gleiche Wörter → ähnliche Vektoren. Versteht keine Bedeutung, reicht aber zum Testen der Abläufe.
 */
export function mockEmbedding(text) {
  const v = new Array(DIMENSIONS).fill(0);
  for (const word of String(text).toLowerCase().replace(/^(query|passage): /, '').split(/[^\p{L}\p{N}]+/u)) {
    if (word.length < 3) continue;
    let h = 0;
    for (const ch of word) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    v[h % DIMENSIONS] += 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}
