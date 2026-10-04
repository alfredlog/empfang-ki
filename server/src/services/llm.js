// LLM-Anbindung. Einheitliche Schnittstelle, damit der Anbieter austauschbar bleibt:
//   streamCompletion({ system, messages, tools, onText }) → { content, stopReason, usage }
// "system" ist eine Liste von Textblöcken; Blöcke mit cache: true werden für Prompt-Caching markiert.
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

let client;
function anthropic() {
  if (!client) client = new Anthropic({ apiKey: config.llm.apiKey });
  return client;
}

async function anthropicCompletion({ system, messages, tools, onText, signal }) {
  const stream = anthropic().messages.stream(
    {
      model: config.llm.model,
      max_tokens: config.llm.maxTokens,
      system: system.map((b) => ({
        type: 'text',
        text: b.text,
        ...(b.cache ? { cache_control: { type: 'ephemeral' } } : {}),
      })),
      messages,
      ...(tools?.length ? { tools } : {}),
    },
    { signal },
  );
  stream.on('text', (delta) => onText?.(delta));
  const msg = await stream.finalMessage();
  return {
    content: msg.content,
    stopReason: msg.stop_reason,
    usage: {
      input: (msg.usage.input_tokens || 0) + (msg.usage.cache_creation_input_tokens || 0),
      output: msg.usage.output_tokens || 0,
      cacheRead: msg.usage.cache_read_input_tokens || 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Mock-Modus: funktioniert ohne API-Key. Beantwortet Fragen mit dem passendsten
// Absatz aus der Wissensbasis und simuliert die Anfrage-Erfassung. Nur für
// lokale Entwicklung, Tests und Offline-Demos gedacht.
// ---------------------------------------------------------------------------
const INTENT = /(anfrage|angebot|termin|rückruf|rueckruf|mieten|miete|buchen|schaden|melden|reservier)/i;
const CONTACT = /(\+?\d[\d\s/-]{6,}\d|[\w.+-]+@[\w-]+\.[\w.]+)/;

function words(text) {
  return String(text).toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) || [];
}

async function mockCompletion({ system, messages, tools, onText }) {
  const last = messages[messages.length - 1];
  const lastText = typeof last.content === 'string'
    ? last.content
    : last.content.map((b) => b.text || b.content || '').join(' ');

  // Nach einem Tool-Ergebnis: Bestätigung ausgeben
  if (Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result')) {
    return emit('Vielen Dank! Ihre Anfrage ist beim Team angekommen. Wir melden uns so schnell wie möglich bei Ihnen.', onText);
  }

  const contact = lastText.match(CONTACT);
  if (contact && tools?.length) {
    const name = (lastText.match(/(?:ich bin|mein name ist|name:)\s*([\p{L}-]+(?:\s[\p{L}-]+)?)/iu) || [])[1] || 'Besucher (Demo)';
    const isMail = contact[0].includes('@');
    // Hat der Assistent vorher "weiß ich nicht" gesagt? → offene Frage mit der ursprünglichen Frage
    const textOf = (m) => (typeof m.content === 'string' ? m.content : '');
    const unknownIdx = messages.findLastIndex((m) => m.role === 'assistant' && textOf(m).includes('keine Information'));
    const openQuestion = unknownIdx > 0 ? textOf(messages[unknownIdx - 1]) : null;
    return {
      content: [{
        type: 'tool_use', id: `mock_${Date.now()}`, name: 'anfrage_erstellen',
        input: {
          art: openQuestion ? 'offene_frage' : 'rueckruf', name, ...(isMail ? { email: contact[0] } : { telefon: contact[0] }),
          ...(openQuestion ? { offene_frage: openQuestion } : {}),
          zusammenfassung: openQuestion ? `Besucher bittet um Rückmeldung zu: ${openQuestion}` : 'Anfrage über den Demo-Chat (Mock-Modus).',
        },
      }],
      stopReason: 'tool_use',
      usage: { input: 0, output: 0, cacheRead: 0 },
    };
  }

  if (INTENT.test(lastText)) {
    return emit('Sehr gern nehme ich Ihre Anfrage auf. Wie ist Ihr Name, und unter welcher Telefonnummer oder E-Mail-Adresse erreichen wir Sie? Beschreiben Sie Ihr Anliegen gern in einem Satz.', onText);
  }

  // Passendsten Absatz der Wissensbasis suchen
  const knowledge = system.map((b) => b.text).join('\n');
  const section = (knowledge.split('UNTERNEHMENSINFORMATIONEN (einzige Quelle für Fakten):')[1] || '').split('\n---\n')[1] || '';
  const paragraphs = section.split(/\n(?=## )|\n\n/).map((p) => p.trim()).filter(Boolean);
  const q = new Set(words(lastText));
  let best = null;
  let bestScore = 1; // mindestens 2 gemeinsame Wörter
  for (const p of paragraphs) {
    const score = words(p).filter((w) => q.has(w)).length;
    if (score > bestScore) { best = p; bestScore = score; }
  }
  const answer = best
    ? `${best.replace(/^## /, '').replace(/\n/, ':\n')}\n\nKann ich sonst noch helfen?`
    : 'Dazu habe ich leider keine Information. Gern meldet sich jemand aus dem Team persönlich bei Ihnen – wie ist Ihr Name und Ihre Telefonnummer oder E-Mail?';
  return emit(`(Demo-Modus) ${answer}`, onText);
}

async function emit(text, onText) {
  for (const part of text.match(/.{1,12}/gs) || []) {
    onText?.(part);
    await new Promise((r) => setTimeout(r, 15));
  }
  return { content: [{ type: 'text', text }], stopReason: 'end_turn', usage: { input: 0, output: 0, cacheRead: 0 } };
}

export function streamCompletion(args) {
  return config.llm.provider === 'anthropic' ? anthropicCompletion(args) : mockCompletion(args);
}
