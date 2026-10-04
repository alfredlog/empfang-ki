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

/** Allgemeiner Mailversand. Ohne SMTP-Konfiguration wird nur geloggt. */
export async function sendMail({ to, subject, text, html, replyTo }) {
  const t = getTransport();
  if (!t || !to) {
    console.log(`[mail:dry-run] an ${to || '(keine Adresse)'} – ${subject}`);
    return { sent: false };
  }
  await t.sendMail({ from: config.mail.from, to, replyTo: replyTo || undefined, subject, text, html });
  return { sent: true };
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

  const dashboardUrl = `${config.publicUrl}/app/#anfragen`;
  const text = `${subject}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\nBitte melden Sie sich zeitnah bei der Person zurück.\nAlle Anfragen im Dashboard: ${dashboardUrl}`;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px">
    <h2 style="margin:0 0 12px">${esc(subject)}</h2>
    <table style="border-collapse:collapse;width:100%">${rows
      .map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#666;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:6px 0">${esc(v)}</td></tr>`)
      .join('')}</table>
    <p style="margin-top:20px"><a href="${dashboardUrl}" style="display:inline-block;background:#0e5e63;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Im Dashboard ansehen</a></p>
    <p style="color:#666;font-size:13px;margin-top:16px">Diese Anfrage wurde vom KI-Assistenten auf Ihrer Website aufgenommen.</p></div>`;

  return sendMail({ to: tenant.contact_email, replyTo: lead.email, subject, text, html });
}
