import nodemailer from 'nodemailer';
import { config } from '../config.js';

let transport;
function getTransport() {
  if (!config.mail.host) return null;
  if (!transport) {
    transport = nodemailer.createTransport({
      host: config.mail.host,
      port: config.mail.port,
      secure: config.mail.port === 465,
      auth: config.mail.user ? { user: config.mail.user, pass: config.mail.pass } : undefined,
    });
  }
  return transport;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const KIND_LABEL = {
  angebot: 'Angebotsanfrage', rueckruf: 'Rückrufbitte', termin: 'Terminwunsch', schaden: 'Schadensmeldung',
  miete: 'Mietanfrage', rezept: 'Rezeptanfrage', offene_frage: 'offene Frage', erstanfrage: 'Erstanfrage', anfrage: 'Anfrage', sonstiges: 'Anfrage',
};
export const kindLabel = (k) => KIND_LABEL[k] || 'Anfrage';

/** Schickt eine neue Anfrage an das Unternehmen. Ohne SMTP-Konfiguration wird nur geloggt. */
export async function sendLeadEmail(tenant, lead) {
  const subject = lead.kind === 'offene_frage'
    ? `Offene Frage – bitte zurückmelden: ${lead.name}`
    : `Neue ${kindLabel(lead.kind)} über den Website-Chat – ${lead.name}`;
  const rows = [
    ['Art', kindLabel(lead.kind)],
    ['Name', lead.name],
    ['Telefon', lead.phone],
    ['E-Mail', lead.email],
    ['Unbeantwortete Frage', lead.open_question],
    ['Anliegen', lead.summary],
    ...Object.entries(lead.details || {}).map(([k, v]) => [k, v]),
  ].filter(([, v]) => v);

  const text = `${subject}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\nBitte melden Sie sich zeitnah bei der Person zurück.`;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px">
    <h2 style="margin:0 0 12px">${esc(subject)}</h2>
    <table style="border-collapse:collapse;width:100%">${rows
      .map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#666;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:6px 0">${esc(v)}</td></tr>`)
      .join('')}</table>
    <p style="color:#666;font-size:13px;margin-top:20px">Diese Anfrage wurde vom KI-Assistenten auf Ihrer Website aufgenommen.</p></div>`;

  const t = getTransport();
  if (!t || !tenant.contact_email) {
    console.log(`[mail:dry-run] an ${tenant.contact_email || '(keine Adresse)'} – ${subject}`);
    return { sent: false };
  }
  await t.sendMail({
    from: config.mail.from,
    to: tenant.contact_email,
    replyTo: lead.email || undefined,
    subject,
    text,
    html,
  });
  return { sent: true };
}
