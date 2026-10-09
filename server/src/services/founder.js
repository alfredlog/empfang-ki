// Gründerpreis: Die ersten zehn zahlenden Kunden behalten ihren Preis zwölf Monate ab Vertragsbeginn.
// Einen Monat vor Ablauf bekommt der Kunde automatisch eine Info-Mail (Kopie an den Admin),
// am Ablauftag bekommt der Admin eine Erinnerung, den Preis umzustellen.
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { reportRecipients } from './insights.js';
import { sendMail } from './mailer.js';
import { PLANS } from './tenants.js';

export const FOUNDER_LIMIT = 10;
export const FOUNDER_MONTHS = 12;
export const NOTICE_DAYS = 30;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const day = (d) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
const fmtDay = (d) => new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${day(d)}T00:00:00Z`));

/** Ablaufdatum = Startdatum + 12 Monate (als YYYY-MM-DD). */
export function founderEndsOn(since) {
  const d = new Date(`${day(since)}T00:00:00Z`);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + FOUNDER_MONTHS, d.getUTCDate()));
  // 31.01. + 12 Monate bleibt 31.01.; 29.02. → 28.02. bzw. 01.03. ist hier unkritisch
  return target.toISOString().slice(0, 10);
}

export function founderInfo(t, today = new Date().toISOString().slice(0, 10)) {
  if (!t.founder_since) return { isFounder: false };
  const endsOn = founderEndsOn(t.founder_since);
  const daysLeft = Math.round((Date.parse(endsOn) - Date.parse(today)) / 864e5);
  const plan = PLANS[t.plan] || PLANS.starter;
  return {
    isFounder: true,
    since: day(t.founder_since),
    endsOn,
    daysLeft,
    expired: daysLeft <= 0,
    noticeDue: daysLeft <= NOTICE_DAYS,
    noticeOn: new Date(Date.parse(endsOn) - NOTICE_DAYS * 864e5).toISOString().slice(0, 10),
    noticeSentAt: t.founder_notice_sent_at || null,
    endNotifiedAt: t.founder_end_notified_at || null,
    priceEur: plan.priceEur,
    regularEur: plan.regularEur ?? plan.priceEur,
  };
}

export async function founderCount(db = { query }) {
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM tenants WHERE founder_since IS NOT NULL AND plan <> 'demo'`);
  return rows[0].n;
}

/**
 * Beim ersten Bezahlen: als Gründerkunde markieren, solange noch Plätze frei sind.
 * Läuft innerhalb der Abrechnungs-Transaktion (db = Client).
 */
export async function autoAssignFounder(db, tenantId) {
  const { rows } = await db.query(
    `UPDATE tenants SET founder_since = current_date
      WHERE id = $1 AND founder_since IS NULL AND plan <> 'demo'
        AND (SELECT count(*) FROM tenants WHERE founder_since IS NOT NULL AND plan <> 'demo') < $2
      RETURNING founder_since`,
    [tenantId, FOUNDER_LIMIT],
  );
  return rows[0]?.founder_since || null;
}

/** Admin: Gründerpreis setzen (Startdatum) oder entfernen (null). Setzt den Mail-Status zurück. */
export async function setFounder(tenantId, since) {
  const { rows } = await query(
    `UPDATE tenants SET founder_since = $2, founder_notice_sent_at = NULL, founder_end_notified_at = NULL
      WHERE id = $1 RETURNING *`,
    [tenantId, since || null],
  );
  return rows[0] || null;
}

/** Info-Mail an den Kunden (1 Monat vor Ablauf). */
export function buildFounderNotice(t) {
  const f = founderInfo(t);
  const plan = PLANS[t.plan] || PLANS.starter;
  const subject = `Ihr Gründerpreis bei Empfang KI endet am ${fmtDay(f.endsOn)}`;
  const dashboard = `${config.publicUrl}/app/#abrechnung`;
  const lines = [
    'Guten Tag,',
    '',
    `vielen Dank, dass ${t.name} seit ${fmtDay(f.since)} Empfang KI nutzt.`,
    '',
    `Wie vereinbart gilt Ihr Gründerpreis zwölf Monate. Bis einschließlich ${fmtDay(new Date(Date.parse(f.endsOn) - 864e5))} zahlen Sie weiterhin ${f.priceEur} € im Monat.`,
    `Ab ${fmtDay(f.endsOn)} gilt für Ihr Paket „${plan.label}“ der reguläre Preis von ${f.regularEur} € im Monat. Am Leistungsumfang ändert sich nichts.`,
    '',
    'Sie müssen nichts tun. Wenn Sie lieber ein kleineres Paket möchten oder kündigen wollen, geht das jederzeit zum Monatsende, ohne Mindestlaufzeit. Antworten Sie einfach auf diese E-Mail oder schauen Sie in Ihr Dashboard:',
    dashboard,
    '',
    'Bei Fragen erreichen Sie uns unter support@empfang-ki.de.',
    '',
    'Viele Grüße',
    'Alfred Mushagalusa Munganga',
    'Empfang KI',
  ];
  const text = lines.join('\n');
  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px;color:#1b2a3a;line-height:1.55">
    <p>Guten Tag,</p>
    <p>vielen Dank, dass <strong>${esc(t.name)}</strong> seit ${fmtDay(f.since)} Empfang KI nutzt.</p>
    <p>Wie vereinbart gilt Ihr Gründerpreis zwölf Monate. Bis einschließlich ${fmtDay(new Date(Date.parse(f.endsOn) - 864e5))} zahlen Sie weiterhin <strong>${f.priceEur} €</strong> im Monat.</p>
    <table style="border-collapse:collapse;margin:14px 0">
      <tr><td style="padding:6px 16px 6px 0;color:#666">Paket</td><td style="padding:6px 0">${esc(plan.label)}</td></tr>
      <tr><td style="padding:6px 16px 6px 0;color:#666">Bisher (Gründerpreis)</td><td style="padding:6px 0">${f.priceEur} € / Monat</td></tr>
      <tr><td style="padding:6px 16px 6px 0;color:#666">Ab ${fmtDay(f.endsOn)}</td><td style="padding:6px 0"><strong>${f.regularEur} € / Monat</strong></td></tr>
    </table>
    <p>Am Leistungsumfang ändert sich nichts. <strong>Sie müssen nichts tun.</strong></p>
    <p>Wenn Sie lieber ein kleineres Paket möchten oder kündigen wollen, geht das jederzeit zum Monatsende, ohne Mindestlaufzeit. Antworten Sie einfach auf diese E-Mail oder schauen Sie in Ihr Dashboard.</p>
    <p><a href="${dashboard}" style="display:inline-block;background:#0e5e63;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Zum Dashboard</a></p>
    <p>Viele Grüße<br>Alfred Mushagalusa Munganga<br>Empfang KI · support@empfang-ki.de</p>
  </div>`;
  return { subject, text, html };
}

async function loadTenant(tenantId) {
  const { rows } = await query('SELECT * FROM tenants WHERE id = $1', [tenantId]);
  return rows[0] || null;
}

/** Info-Mail senden (automatisch oder per Knopf). Kopie an den Admin. */
export async function sendFounderNotice(tenantId, { force = false } = {}) {
  const t = await loadTenant(tenantId);
  if (!t?.founder_since) return { skipped: 'not_founder' };
  if (t.founder_notice_sent_at && !force) return { skipped: 'already_sent' };
  const to = await reportRecipients(t);
  if (!to.length) return { skipped: 'no_recipients' };
  const mail = buildFounderNotice(t);
  const { sent } = await sendMail({ to: to.join(', '), replyTo: config.adminEmail || undefined, ...mail });
  if (sent) {
    await query('UPDATE tenants SET founder_notice_sent_at = now() WHERE id = $1', [tenantId]);
    if (config.adminEmail) {
      await sendMail({
        to: config.adminEmail,
        subject: `[Kopie] ${mail.subject} – ${t.name}`,
        text: `Diese Info-Mail ging an: ${to.join(', ')}\n\n${mail.text}`,
        html: `<p style="font-family:system-ui;color:#666">Diese Info-Mail ging an: ${esc(to.join(', '))}</p>${mail.html}`,
      }).catch(() => {});
    }
  }
  return { sent, to };
}

/** Erinnerung an den Admin am Ablauftag. */
async function sendEndReminder(t) {
  if (!config.adminEmail) return { sent: false };
  const f = founderInfo(t);
  const steps = t.billing_method === 'stripe'
    ? `Stripe: Im Stripe-Dashboard beim Abo von ${t.name} den Preis auf ${f.regularEur} € / Monat umstellen (Abo bearbeiten → Preis ändern).`
    : `Rechnung: Ab sofort ${f.regularEur} € / Monat statt ${f.priceEur} € in Rechnung stellen.`;
  const subject = `Gründerpreis abgelaufen: ${t.name} jetzt auf ${f.regularEur} € umstellen`;
  const text = `Der Gründerpreis von ${t.name} ist am ${fmtDay(f.endsOn)} abgelaufen.\n\n${steps}\n\nDie Info-Mail an den Kunden ${f.noticeSentAt ? 'wurde verschickt' : 'wurde NICHT verschickt – bitte vor der Umstellung nachholen'}.\n\nAdmin: ${config.publicUrl}/admin/#kunde/${t.id}/abrechnung`;
  return sendMail({ to: config.adminEmail, subject, text, html: `<div style="font-family:system-ui;line-height:1.5">${text.split('\n').map((l) => esc(l)).join('<br>')}</div>` });
}

/** Stündlicher Lauf: fällige Info-Mails und Ablauf-Erinnerungen verschicken. */
export async function runFounderJobs() {
  let notices = 0;
  let reminders = 0;
  const { rows: due } = await query(
    `SELECT id FROM tenants
      WHERE founder_since IS NOT NULL AND founder_notice_sent_at IS NULL AND active AND plan <> 'demo'
        AND (founder_since + make_interval(months => $1))::date - $2::int <= current_date`,
    [FOUNDER_MONTHS, NOTICE_DAYS],
  );
  for (const r of due) {
    try {
      if ((await sendFounderNotice(r.id)).sent) notices += 1;
    } catch (err) {
      console.error('[gruenderpreis]', r.id, err.message);
    }
  }
  const { rows: ended } = await query(
    `SELECT * FROM tenants
      WHERE founder_since IS NOT NULL AND founder_end_notified_at IS NULL AND plan <> 'demo'
        AND (founder_since + make_interval(months => $1))::date <= current_date`,
    [FOUNDER_MONTHS],
  );
  for (const t of ended) {
    try {
      const { sent } = await sendEndReminder(t);
      if (sent) {
        await query('UPDATE tenants SET founder_end_notified_at = now() WHERE id = $1', [t.id]);
        reminders += 1;
      }
    } catch (err) {
      console.error('[gruenderpreis]', t.id, err.message);
    }
  }
  return { notices, reminders };
}

/** Übersicht für den Admin: alle Gründerkunden, bald ablaufende zuerst. */
export async function listFounders() {
  const { rows } = await query(`SELECT * FROM tenants WHERE founder_since IS NOT NULL AND plan <> 'demo' ORDER BY founder_since`);
  return rows.map((t) => ({ id: t.id, name: t.name, plan: t.plan, active: t.active, ...founderInfo(t) }))
    .sort((a, b) => a.daysLeft - b.daysLeft);
}
