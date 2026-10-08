// Freie Termine: der Betrieb trägt sie im Dashboard ein, der Assistent bietet sie an und bucht sie.
// Vergangene Termine werden nie angeboten; gebuchte Termine sind nicht mehr frei.
import { query } from '../db/pool.js';

export const MAX_SLOTS_IN_PROMPT = 30;
const LEAD_MINUTES = 30; // Termine, die in weniger als 30 Minuten beginnen, nicht mehr anbieten

const fmt = new Intl.DateTimeFormat('de-DE', {
  timeZone: 'Europe/Berlin', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
});
export const formatSlot = (date) => `${fmt.format(new Date(date))} Uhr`;

/**
 * Wandelt Datum + Uhrzeit (deutsche Ortszeit) in einen Zeitpunkt um.
 * Funktioniert auch über die Sommer-/Winterzeit-Umstellung hinweg.
 */
export function berlinToDate(dateStr, timeStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Berlin', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(guess));
  const p = Object.fromEntries(parts.map((x) => [x.type, Number(x.value)]));
  const asBerlin = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return new Date(guess - (asBerlin - guess));
}

/** Legt Termine an. times: ["09:00", "10:30"], repeatWeeks: 1 = nur dieser Tag. Doppelte werden übersprungen. */
export async function addSlots(tenantId, { date, times, durationMin = 30, repeatWeeks = 1, note }) {
  let created = 0;
  for (let w = 0; w < repeatWeeks; w++) {
    for (const t of times) {
      const start = berlinToDate(date, t);
      start.setTime(start.getTime() + w * 7 * 864e5);
      // Wochen-Wiederholung über die Zeitumstellung: Uhrzeit in Berlin beibehalten
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(start);
      const exact = berlinToDate(day, t);
      if (exact.getTime() <= Date.now()) continue;
      const { rowCount } = await query(
        `INSERT INTO appointment_slots (tenant_id, starts_at, duration_min, note) VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, starts_at) DO NOTHING`,
        [tenantId, exact, durationMin, note || null],
      );
      created += rowCount;
    }
  }
  return created;
}

/** Alle kommenden Termine (frei und gebucht) für das Dashboard. */
export async function listSlots(tenantId) {
  const { rows } = await query(
    `SELECT s.id, s.starts_at, s.duration_min, s.note, s.booked_at, s.lead_id, l.name AS lead_name, l.phone AS lead_phone, l.email AS lead_email
       FROM appointment_slots s LEFT JOIN leads l ON l.id = s.lead_id
      WHERE s.tenant_id = $1 AND s.starts_at > now() - interval '1 day'
      ORDER BY s.starts_at LIMIT 500`,
    [tenantId],
  );
  return rows;
}

/** Freie, zukünftige Termine für den Assistenten. */
export async function freeSlots(tenantId, limit = MAX_SLOTS_IN_PROMPT) {
  const { rows } = await query(
    `SELECT id, starts_at, duration_min, note FROM appointment_slots
      WHERE tenant_id = $1 AND booked_at IS NULL AND starts_at > now() + make_interval(mins => $2)
      ORDER BY starts_at LIMIT $3`,
    [tenantId, LEAD_MINUTES, limit],
  );
  return rows;
}

/** Bucht einen Termin atomar. Gibt null zurück, wenn er nicht (mehr) frei ist. */
export async function bookSlot(tenantId, slotId, leadId, db = { query }) {
  const { rows } = await db.query(
    `UPDATE appointment_slots SET booked_at = now(), lead_id = $3
      WHERE id = $2 AND tenant_id = $1 AND booked_at IS NULL AND starts_at > now()
      RETURNING id, starts_at, duration_min`,
    [tenantId, slotId, leadId],
  );
  return rows[0] || null;
}

export async function deleteSlot(tenantId, slotId) {
  const { rowCount } = await query('DELETE FROM appointment_slots WHERE id = $1 AND tenant_id = $2', [slotId, tenantId]);
  return rowCount;
}

/** Gebuchten Termin wieder freigeben (z. B. nach Absage). */
export async function releaseSlot(tenantId, slotId) {
  const { rowCount } = await query(
    'UPDATE appointment_slots SET booked_at = NULL, lead_id = NULL WHERE id = $1 AND tenant_id = $2',
    [slotId, tenantId],
  );
  return rowCount;
}

/** Text für den Systemprompt: Liste der freien Termine mit Kennung. */
export function slotsPromptBlock(slots) {
  if (!slots.length) return '';
  return [
    'FREIE TERMINE (nur diese anbieten; jeder Termin hat eine Kennung in eckigen Klammern):',
    ...slots.map((s) => `- [${s.id}] ${formatSlot(s.starts_at)}, ${s.duration_min} Minuten${s.note ? ` (${s.note})` : ''}`),
    'Fragt jemand nach einem Termin, schlage passende freie Termine vor (höchstens 3–4 auf einmal, nach Wunschtag oder -zeit gefiltert). ' +
      'Hat sich der Besucher für einen Termin entschieden und Name sowie Telefon oder E-Mail genannt, fasse zusammen, hol die Bestätigung ein ' +
      'und nutze "anfrage_erstellen" mit art "termin" und der Kennung im Feld "termin_id". Erfinde niemals Termine, die nicht in dieser Liste stehen.',
  ].join('\n');
}

/** Alte Termine aufräumen (älter als 30 Tage). */
export async function purgeOldSlots() {
  const { rowCount } = await query(`DELETE FROM appointment_slots WHERE starts_at < now() - interval '30 days'`);
  return rowCount;
}
