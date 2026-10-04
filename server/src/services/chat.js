// Kern-Logik eines Chat-Turns: Gespräch laden, Notfall prüfen, Wissen abrufen,
// Claude antworten lassen (Streaming), Anfragen per Werkzeug erfassen, alles speichern.
import { z } from 'zod';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { buildSystemPrompt, getIndustry } from '../templates/industries.js';
import { retrieveContext } from './knowledge.js';
import { streamCompletion } from './llm.js';
import { sendLeadEmail } from './mailer.js';
import { PLANS, monthlyUsage, recordUsage } from './tenants.js';

export class ChatError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const MAX_TOOL_ROUNDS = 3;

// Emojis wirken in Firmen-Chats unprofessionell – werden unabhängig vom Modell entfernt
// (©, ®, ™ und Pfeile bleiben erhalten)
const EMOJI_RE = /(?![©®™←-⇿])\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}️‍]/gu;
export function stripEmoji(text) {
  return text.replace(EMOJI_RE, '').replace(/[ \t]{2,}/g, ' ').replace(/ +([.,!?])/g, '$1');
}

export function leadTool(tenant) {
  const kinds = getIndustry(tenant.industry).leadKinds;
  return {
    name: 'anfrage_erstellen',
    description:
      'Leitet eine Anfrage (z. B. Terminwunsch, Rückrufbitte, Angebots-, Miet- oder Schadensanfrage) an das Team des Unternehmens weiter. ' +
      'Nur verwenden, nachdem Name und mindestens Telefon oder E-Mail vorliegen und der Besucher die Zusammenfassung bestätigt hat.',
    input_schema: {
      type: 'object',
      properties: {
        art: { type: 'string', enum: kinds, description: 'Art der Anfrage' },
        name: { type: 'string', description: 'Name der Person' },
        telefon: { type: 'string', description: 'Telefonnummer (falls angegeben)' },
        email: { type: 'string', description: 'E-Mail-Adresse (falls angegeben)' },
        zusammenfassung: { type: 'string', description: 'Anliegen in 1–3 sachlichen Sätzen für das Team, IMMER auf Deutsch (auch wenn der Besucher eine andere Sprache spricht; dann die Sprache des Besuchers kurz nennen)' },
        offene_frage: { type: 'string', description: 'Nur bei art "offene_frage": die Frage, die du nicht beantworten konntest, möglichst im Wortlaut' },
        details: {
          type: 'object',
          description: 'Weitere strukturierte Angaben auf Deutsch, z. B. {"Wunschtermin": "Do vormittags", "Ort": "64283 Darmstadt"}',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['art', 'name', 'zusammenfassung'],
    },
  };
}

const leadSchema = z
  .object({
    art: z.string().max(40),
    name: z.string().trim().min(1).max(120),
    telefon: z.string().trim().max(40).optional(),
    email: z.string().trim().max(160).optional(),
    zusammenfassung: z.string().trim().min(3).max(1500),
    offene_frage: z.string().trim().max(1000).optional(),
    details: z.record(z.string(), z.string().max(500)).optional(),
  })
  .refine((v) => v.telefon || v.email, { message: 'Telefon oder E-Mail fehlt' });

async function createLead(tenant, conversationId, input) {
  const parsed = leadSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: `Anfrage unvollständig: ${parsed.error.issues.map((i) => i.message).join(', ')}. Bitte die fehlenden Angaben erfragen.` };
  }
  const v = parsed.data;
  const kinds = getIndustry(tenant.industry).leadKinds;
  const kind = kinds.includes(v.art) ? v.art : 'sonstiges';
  const details = Object.fromEntries(Object.entries(v.details || {}).slice(0, 12));
  const { rows } = await query(
    `INSERT INTO leads (tenant_id, conversation_id, kind, name, phone, email, summary, details, open_question)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [tenant.id, conversationId, kind, v.name, v.telefon || null, v.email || null, v.zusammenfassung, details, v.offene_frage || null],
  );
  const lead = rows[0];
  try {
    const { sent } = await sendLeadEmail(tenant, lead);
    if (sent) await query('UPDATE leads SET notified_at = now() WHERE id = $1', [lead.id]);
  } catch (err) {
    console.error('[mail] Versand fehlgeschlagen:', err.message);
  }
  return { ok: true, lead };
}

function berlinNow() {
  return new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date());
}

/** Baut die System-Blöcke. Statischer Teil (+ ggf. ganze Wissensbasis) wird gecacht. */
export function buildSystemBlocks(tenant, context) {
  const base = buildSystemPrompt(tenant);
  const knowledge = `UNTERNEHMENSINFORMATIONEN (einzige Quelle für Fakten):\n---\n${context.text || '(Noch keine Informationen hinterlegt.)'}\n---`;
  const now = {
    text:
      `Aktuelles Datum und Uhrzeit (Deutschland): ${berlinNow()}. Nutze das, um z. B. zu sagen, ob gerade geöffnet ist.\n\n` +
      'WICHTIG BEI JEDER ANTWORT: Sie-Form, keine Emojis. Steht die Antwort nicht ausdrücklich in den Unternehmensinformationen, ' +
      'sag „Dazu habe ich leider keine Angabe“ und biete an, die Frage an das Team weiterzugeben.',
  };
  if (context.mode === 'full') return [{ text: `${base}\n\n${knowledge}`, cache: true }, now];
  return [{ text: base, cache: true }, { text: knowledge }, now];
}

async function getOrCreateConversation(tenant, { conversationId, visitorId, origin }) {
  if (conversationId) {
    const { rows } = await query('SELECT * FROM conversations WHERE id = $1 AND tenant_id = $2', [conversationId, tenant.id]);
    if (rows[0]) return { conversation: rows[0], isNew: false };
  }
  const usage = await monthlyUsage(tenant.id);
  const limit = (PLANS[tenant.plan] || PLANS.starter).monthlyConversations;
  if (usage.conversations >= limit) {
    throw new ChatError('limit_reached', 'Der Chat ist im Moment nicht verfügbar. Bitte kontaktieren Sie uns telefonisch oder per E-Mail.', 429);
  }
  const { rows } = await query(
    'INSERT INTO conversations (tenant_id, visitor_id, origin) VALUES ($1, $2, $3) RETURNING *',
    [tenant.id, visitorId?.slice(0, 64) || null, origin?.slice(0, 200) || null],
  );
  return { conversation: rows[0], isNew: true };
}

async function saveMessage(conversationId, role, content) {
  await query('INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)', [conversationId, role, content]);
  await query('UPDATE conversations SET message_count = message_count + 1, last_at = now() WHERE id = $1', [conversationId]);
}

async function loadHistory(conversationId) {
  const { rows } = await query(
    'SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT $2',
    [conversationId, config.chat.historyMessages],
  );
  const history = rows.reverse();
  // Die Anthropic-API erwartet, dass die Liste mit einer user-Nachricht beginnt
  while (history.length && history[0].role !== 'user') history.shift();
  // Aufeinanderfolgende Nachrichten derselben Rolle zusammenführen (z. B. nach einem Fehler)
  const merged = [];
  for (const m of history) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += `\n\n${m.content}`;
    else merged.push({ role: m.role, content: m.content });
  }
  if (merged.length && merged[merged.length - 1].role === 'user') {
    // Die neue Nachricht folgt als user – vorherige unbeantwortete Nachricht als Kontext behalten
    merged.push({ role: 'assistant', content: '(Keine Antwort gesendet.)' });
  }
  return merged;
}

/**
 * Führt einen Chat-Turn aus.
 * @param {object} p
 * @param {(event: string, data: object) => void} p.emit – sendet Events an den Client (SSE)
 */
export async function handleChatTurn({ tenant, conversationId, visitorId, origin, message, emit, signal }) {
  const text = String(message || '').trim();
  if (!text) throw new ChatError('empty', 'Bitte geben Sie eine Nachricht ein.');
  if (text.length > config.chat.maxMessageChars) throw new ChatError('too_long', 'Die Nachricht ist zu lang. Bitte fassen Sie sich etwas kürzer.');

  const { conversation, isNew } = await getOrCreateConversation(tenant, { conversationId, visitorId, origin });
  if (conversation.message_count >= config.chat.maxMessagesPerConversation) {
    throw new ChatError('conversation_full', 'Dieses Gespräch ist sehr lang geworden. Bitte starten Sie ein neues Gespräch oder rufen Sie uns an.', 429);
  }
  emit('meta', { conversationId: conversation.id });

  const history = await loadHistory(conversation.id);
  await saveMessage(conversation.id, 'user', text);

  // 1) Notfall-Erkennung ohne LLM – deterministisch und sofort
  const emergency = getIndustry(tenant.industry).emergency;
  if (emergency && emergency.pattern.test(text)) {
    emit('delta', { text: emergency.message });
    emit('emergency', {});
    await saveMessage(conversation.id, 'assistant', emergency.message);
    await recordUsage(tenant.id, { conversations: isNew ? 1 : 0, messages: 1 });
    emit('done', {});
    return;
  }

  // 2) Wissen abrufen und Prompt bauen
  const context = await retrieveContext(tenant.id, `${history.filter((m) => m.role === 'user').slice(-2).map((m) => m.content).join(' ')} ${text}`);
  const system = buildSystemBlocks(tenant, context);
  const tools = [leadTool(tenant)];
  const messages = [...history, { role: 'user', content: text }];

  // 3) Antwort generieren, ggf. Werkzeug ausführen und weiter antworten
  const usage = { input: 0, output: 0, cacheRead: 0 };
  let answer = '';
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let roundText = '';
    const result = await streamCompletion({
      system,
      messages,
      tools,
      signal,
      onText: (raw) => {
        const delta = stripEmoji(raw);
        if (!delta) return;
        if (!roundText && answer) {
          emit('delta', { text: '\n\n' });
          answer += '\n\n';
        }
        roundText += delta;
        answer += delta;
        emit('delta', { text: delta });
      },
    });
    usage.input += result.usage.input;
    usage.output += result.usage.output;
    usage.cacheRead += result.usage.cacheRead;

    const toolUses = result.content.filter((b) => b.type === 'tool_use');
    if (result.stopReason !== 'tool_use' || toolUses.length === 0) break;

    messages.push({ role: 'assistant', content: result.content });
    const toolResults = [];
    for (const tu of toolUses) {
      let output;
      if (tu.name === 'anfrage_erstellen') {
        const r = await createLead(tenant, conversation.id, tu.input);
        if (r.ok) emit('lead', { kind: r.lead.kind });
        output = r.ok
          ? { status: 'gespeichert', hinweis: 'Das Team wurde benachrichtigt und meldet sich. Bestätige dem Besucher kurz und freundlich.' }
          : { status: 'fehler', hinweis: r.error };
      } else {
        output = { status: 'fehler', hinweis: 'Unbekanntes Werkzeug' };
      }
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(output) });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  if (!answer.trim()) {
    answer = 'Entschuldigung, das habe ich nicht verstanden. Können Sie Ihre Frage anders formulieren?';
    emit('delta', { text: answer });
  }
  await saveMessage(conversation.id, 'assistant', answer);
  await recordUsage(tenant.id, { conversations: isNew ? 1 : 0, messages: 1, ...usage });
  emit('done', {});
}

/** Löscht alte Gespräche (Datensparsamkeit). Anfragen bleiben erhalten. */
export async function purgeOldConversations() {
  const { rowCount } = await query(
    `DELETE FROM conversations WHERE last_at < now() - make_interval(days => $1)`,
    [config.retentionDays],
  );
  return rowCount;
}
