// Statistik für Dashboard und Monatsbericht: Zahlen, Anfragen nach Art, häufigste Fragen.
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { completeText } from './llm.js';
import { kindLabel, sendMail } from './mailer.js';
import { PLANS } from './tenants.js';

const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

/** "2026-09" → { start: Date(2026-09-01), end: Date(2026-10-01), label: "September 2026" } */
export function monthRange(ym) {
  const [y, m] = String(ym).split('-').map(Number);
  const pad = (n) => String(n).padStart(2, '0');
  // Als Text 'YYYY-MM-01' übergeben – Postgres wertet das in der Zeitzone Europe/Berlin aus (siehe pool.js)
  const start = `${y}-${pad(m)}-01`;
  const end = m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`;
  return { start, end, label: `${MONTHS[m - 1]} ${y}`, key: `${y}-${pad(m)}` };
}

export function currentMonthKey(date = new Date()) {
  const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit' }).format(date);
  return d.slice(0, 7);
}

export function previousMonthKey(date = new Date()) {
  const [y, m] = currentMonthKey(date).split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** Fragen vergleichbar machen: Kleinschreibung, Satzzeichen weg, Leerzeichen zusammenfassen. */
export function normalizeQuestion(q) {
  return String(q).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** Häufigste erste Fragen der Gespräche (gleiche Fragen zusammengefasst). */
export function topQuestions(firstMessages, limit = 8) {
  const groups = new Map();
  for (const text of firstMessages) {
    const key = normalizeQuestion(text);
    if (key.length < 3) continue;
    const g = groups.get(key) || { question: String(text).trim().slice(0, 160), count: 0 };
    g.count += 1;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}

export async function getInsights(tenantId, monthKey = currentMonthKey()) {
  const { start, end, label, key } = monthRange(monthKey);
  const [usage, leads, open, firsts, daily, tenant] = await Promise.all([
    query('SELECT conversations, messages FROM usage_monthly WHERE tenant_id = $1 AND month = $2', [tenantId, start]),
    query(`SELECT kind, count(*)::int AS n FROM leads WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3 GROUP BY kind ORDER BY n DESC`, [tenantId, start, end]),
    query(`SELECT count(*) FILTER (WHERE status <> 'erledigt')::int AS pending, count(*)::int AS total
             FROM leads WHERE tenant_id = $1 AND open_question IS NOT NULL AND created_at >= $2 AND created_at < $3`, [tenantId, start, end]),
    query(`SELECT (SELECT m.content FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user' ORDER BY m.id LIMIT 1) AS first
             FROM conversations c WHERE c.tenant_id = $1 AND c.started_at >= $2 AND c.started_at < $3`, [tenantId, start, end]),
    query(`SELECT to_char(date_trunc('day', started_at AT TIME ZONE 'Europe/Berlin'), 'YYYY-MM-DD') AS day, count(*)::int AS n
             FROM conversations WHERE tenant_id = $1 AND started_at >= $2 AND started_at < $3 GROUP BY 1 ORDER BY 1`, [tenantId, start, end]),
    query('SELECT plan FROM tenants WHERE id = $1', [tenantId]),
  ]);
  const leadsTotal = leads.rows.reduce((s, r) => s + r.n, 0);
  const plan = PLANS[tenant.rows[0]?.plan];
  return {
    month: key,
    label,
    conversations: usage.rows[0]?.conversations || 0,
    answers: usage.rows[0]?.messages || 0,
    limit: plan?.monthlyConversations || null,
    leads: { total: leadsTotal, byKind: leads.rows.map((r) => ({ kind: r.kind, label: kindLabel(r.kind), count: r.n })) },
    openQuestions: open.rows[0],
    topQuestions: topQuestions(firsts.rows.map((r) => r.first).filter(Boolean)),
    daily: daily.rows,
  };
}

// ---------------------------------------------------------------- Monatsbericht

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Optional: Claude fasst die Fragen des Monats in wenige Themen zusammen. */
async function summarizeThemes(questions) {
  if (questions.length < 5) return null;
  try {
    const text = await completeText({
      system: 'Du fasst Kundenfragen eines kleinen Betriebs zusammen. Antworte nur mit 3 bis 5 Zeilen im Format "Thema – kurze Erklärung", ohne Einleitung, auf Deutsch. Nenne keine Namen oder Kontaktdaten.',
      prompt: `Häufigste Fragen (mit Anzahl):\n${questions.map((q) => `${q.count}× ${q.question}`).join('\n')}`,
      maxTokens: 300,
    });
    return text ? text.split('\n').map((l) => l.replace(/^[-•*\d.\s]+/, '').trim()).filter(Boolean).slice(0, 5) : null;
  } catch {
    return null;
  }
}

export async function buildMonthlyReport(tenantId, monthKey = previousMonthKey()) {
  const { rows } = await query('SELECT id, name, contact_email FROM tenants WHERE id = $1', [tenantId]);
  const tenant = rows[0];
  if (!tenant) return null;
  const s = await getInsights(tenantId, monthKey);
  const themes = await summarizeThemes(s.topQuestions);
  const dash = `${config.publicUrl}/app/`;

  const subject = `Ihr Monatsbericht ${s.label} – ${tenant.name}`;
  const kindLines = s.leads.byKind.map((k) => `${k.count}× ${k.label}`);
  const tips = [];
  if (s.openQuestions.pending) tips.push(`${s.openQuestions.pending} Frage(n) konnte Ihr Assistent noch nicht beantworten. Ergänzen Sie die Antworten im Dashboard unter „Offene Fragen“, dann weiß er es beim nächsten Mal.`);
  if (!s.conversations) tips.push('Diesen Monat gab es noch keine Gespräche. Ist die Code-Zeile auf Ihrer Website eingebaut? Wir helfen gern beim Einbau.');
  if (s.limit && s.conversations > s.limit * 0.8) tips.push(`Sie haben ${Math.round((s.conversations / s.limit) * 100)} % Ihrer Gespräche im Paket genutzt. Bei Bedarf wechseln wir gern in ein größeres Paket.`);

  const text = [
    `Guten Tag,`,
    ``,
    `so hat Ihr digitaler Assistent im ${s.label} gearbeitet:`,
    ``,
    `• ${s.conversations} Gespräche geführt`,
    `• ${s.answers} Antworten gegeben`,
    `• ${s.leads.total} Anfragen an Sie weitergeleitet${kindLines.length ? ` (${kindLines.join(', ')})` : ''}`,
    ``,
    ...(themes?.length ? ['Worüber Ihre Kunden gefragt haben:', ...themes.map((t) => `• ${t}`), ''] : s.topQuestions.length ? ['Häufigste Fragen:', ...s.topQuestions.slice(0, 5).map((q) => `• ${q.question} (${q.count}×)`), ''] : []),
    ...(tips.length ? ['Tipps:', ...tips.map((t) => `• ${t}`), ''] : []),
    `Alle Details im Dashboard: ${dash}`,
    ``,
    `Viele Grüße`,
    `Empfang KI`,
  ].join('\n');

  const stat = (n, l) => `<td style="padding:14px 16px;background:#f4f6f2;border-radius:10px;text-align:center"><div style="font-size:26px;font-weight:800;color:#1b2a3a">${n}</div><div style="font-size:13px;color:#4a5868">${l}</div></td>`;
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;color:#1b2a3a;line-height:1.5">
    <img src="${config.publicUrl}/assets/brand/logo.png" alt="Empfang KI" width="170" style="display:block;margin:0 0 20px">
    <h2 style="margin:0 0 6px;font-size:22px">Ihr Monatsbericht ${esc(s.label)}</h2>
    <p style="margin:0 0 18px;color:#4a5868">${esc(tenant.name)}</p>
    <table role="presentation" style="width:100%;border-collapse:separate;border-spacing:8px 0"><tr>
      ${stat(s.conversations, 'Gespräche')}${stat(s.answers, 'Antworten')}${stat(s.leads.total, 'Anfragen')}
    </tr></table>
    ${kindLines.length ? `<p style="margin:14px 0 0;color:#4a5868;font-size:14px">Anfragen: ${esc(kindLines.join(', '))}</p>` : ''}
    ${themes?.length
      ? `<h3 style="margin:24px 0 8px;font-size:16px">Worüber Ihre Kunden gefragt haben</h3><ul style="margin:0;padding-left:20px">${themes.map((t) => `<li style="margin-bottom:4px">${esc(t)}</li>`).join('')}</ul>`
      : s.topQuestions.length ? `<h3 style="margin:24px 0 8px;font-size:16px">Häufigste Fragen</h3><ul style="margin:0;padding-left:20px">${s.topQuestions.slice(0, 5).map((q) => `<li style="margin-bottom:4px">${esc(q.question)} <span style="color:#6b7684">(${q.count}×)</span></li>`).join('')}</ul>` : ''}
    ${tips.length ? `<div style="margin:24px 0 0;padding:14px 16px;background:#fdf3dd;border-radius:10px">${tips.map((t) => `<p style="margin:0 0 6px">${esc(t)}</p>`).join('')}</div>` : ''}
    <p style="margin:26px 0 0"><a href="${dash}" style="display:inline-block;background:#0e5e63;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">Dashboard öffnen</a></p>
    <p style="margin:26px 0 0;font-size:13px;color:#6b7684">Diesen Bericht bekommen Sie einmal im Monat. Fragen? Antworten Sie einfach auf diese E-Mail.</p>
  </div>`;
  return { tenant, subject, text, html, stats: s, themes };
}

async function reportRecipients(tenant) {
  const { rows } = await query('SELECT email FROM tenant_users WHERE tenant_id = $1', [tenant.id]);
  return [...new Set([tenant.contact_email, ...rows.map((r) => r.email)].filter(Boolean).map((e) => e.toLowerCase()))];
}

export async function sendMonthlyReport(tenantId, monthKey = previousMonthKey(), { force = false } = {}) {
  const { start } = monthRange(monthKey);
  if (!force) {
    const { rowCount } = await query('SELECT 1 FROM report_log WHERE tenant_id = $1 AND month = $2', [tenantId, start]);
    if (rowCount) return { skipped: 'already_sent' };
  }
  const report = await buildMonthlyReport(tenantId, monthKey);
  if (!report) return { skipped: 'not_found' };
  const to = await reportRecipients(report.tenant);
  if (!to.length) return { skipped: 'no_recipients' };
  const { sent } = await sendMail({ to: to.join(', '), replyTo: config.mail.user || undefined, subject: report.subject, text: report.text, html: report.html });
  if (sent) {
    await query(
      `INSERT INTO report_log (tenant_id, month, recipients) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, month) DO UPDATE SET recipients = EXCLUDED.recipients, sent_at = now()`,
      [tenantId, start, to],
    );
  }
  return { sent, to };
}

/** Am 1. des Monats ab 8 Uhr (Berlin): Berichte für den Vormonat an alle aktiven, echten Kunden. */
export async function runMonthlyReports(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', day: 'numeric', hour: 'numeric', hourCycle: 'h23' })
    .formatToParts(now).map((p) => [p.type, p.value]));
  if (Number(parts.day) !== 1 || Number(parts.hour) < 8) return 0;
  const monthKey = previousMonthKey(now);
  const { start } = monthRange(monthKey);
  const { rows } = await query(
    `SELECT t.id FROM tenants t WHERE t.active AND t.plan <> 'demo'
       AND NOT EXISTS (SELECT 1 FROM report_log r WHERE r.tenant_id = t.id AND r.month = $1)`,
    [start],
  );
  let sent = 0;
  for (const r of rows) {
    try {
      const res = await sendMonthlyReport(r.id, monthKey);
      if (res.sent) sent += 1;
    } catch (err) {
      console.error('[report]', r.id, err.message);
    }
  }
  return sent;
}
