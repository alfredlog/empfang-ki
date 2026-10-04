// Import von Wissen: Website eines Kunden einlesen und PDFs auslesen.
// Das Ergebnis ist Markdown mit Überschriften, das direkt in die Wissensbasis geht.
import dns from 'node:dns/promises';
import net from 'node:net';
import * as cheerio from 'cheerio';
import { extractText, getDocumentProxy } from 'unpdf';
import { completeText } from './llm.js';

const UA = 'Mozilla/5.0 (compatible; EmpfangKI-Import/1.0; +https://empfang-ki.de)';
const MAX_PAGE_CHARS = 8000;
const MAX_TOTAL_CHARS = 80000;

// Seiten mit diesen Wörtern im Pfad sind für einen Empfangs-Assistenten am wertvollsten
const PRIORITY = /(leistung|service|angebot|preis|kosten|tarif|kontakt|anfahrt|oeffnung|öffnung|zeiten|ueber|über|about|team|faq|fragen|impressum|standort|termin|buchung|behandlung|vermietung|werkstatt|mieter|eigentuemer)/i;
const SKIP = /\.(pdf|jpe?g|png|gif|webp|svg|zip|docx?|xlsx?|mp4|mp3)(\?|$)|\/(wp-admin|wp-login|feed|tag|author|cart|warenkorb|login|account)\b|datenschutz|privacy|cookie|agb/i;

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  return v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:127.');
}

/** Schutz: keine Anfragen an interne Adressen des Servers (SSRF). */
async function assertPublicUrl(url) {
  const u = new URL(url);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Nur http- und https-Adressen sind erlaubt.');
  if (process.env.NODE_ENV !== 'production' && process.env.IMPORT_ALLOW_PRIVATE === '1') return; // nur für Tests
  const { address } = await dns.lookup(u.hostname);
  if (isPrivateIp(address)) throw new Error('Diese Adresse ist nicht erlaubt.');
}

export function normalizeUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('Bitte eine Website-Adresse angeben.');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  u.hash = '';
  return u.toString();
}

async function fetchHtml(url) {
  await assertPublicUrl(url);
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    redirect: 'follow',
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get('content-type') || '';
  if (!type.includes('html')) throw new Error('keine HTML-Seite');
  const text = await res.text();
  return { html: text.slice(0, 2_000_000), finalUrl: res.url };
}

/** Wandelt eine HTML-Seite in lesbares Markdown um und sammelt interne Links. */
export function htmlToMarkdown(html, baseUrl) {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, iframe, form, nav, [aria-hidden="true"], .cookie, #cookie, [class*="cookie"]').remove();

  const title = $('title').first().text().trim() || $('h1').first().text().trim();
  const lines = [];
  const seen = new Set();
  $('body').find('h1, h2, h3, h4, p, li, td, th, address, dt, dd, blockquote').each((_, el) => {
    // Nur "Blatt"-Elemente nehmen, damit Text nicht doppelt vorkommt
    if ($(el).find('p, li, h1, h2, h3, h4').length) return;
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (!text || text.length < 2 || seen.has(text)) return;
    seen.add(text);
    const tag = el.tagName.toLowerCase();
    if (/^h[1-4]$/.test(tag)) lines.push(`\n# ${text}`);
    else if (tag === 'li') lines.push(`- ${text}`);
    else lines.push(text);
  });

  const base = new URL(baseUrl);
  const links = new Set();
  $('a[href]').each((_, a) => {
    try {
      const u = new URL($(a).attr('href'), base);
      u.hash = '';
      if (u.hostname.replace(/^www\./, '') === base.hostname.replace(/^www\./, '') && /^https?:$/.test(u.protocol) && !SKIP.test(u.pathname)) {
        links.add(u.toString());
      }
    } catch { /* ungültiger Link */ }
  });

  return { title, markdown: lines.join('\n').trim().slice(0, MAX_PAGE_CHARS), links: [...links] };
}

/** Liest bis zu maxPages Seiten einer Website (gleiche Domain), wichtige Seiten zuerst. */
export async function crawlWebsite(startUrl, { maxPages = 12 } = {}) {
  const start = normalizeUrl(startUrl);
  const queue = [start];
  const visited = new Set();
  const pages = [];
  const errors = [];
  let total = 0;

  while (queue.length && pages.length < maxPages && total < MAX_TOTAL_CHARS) {
    const url = queue.shift();
    const key = url.replace(/\/$/, '');
    if (visited.has(key)) continue;
    visited.add(key);
    try {
      const { html, finalUrl } = await fetchHtml(url);
      const page = htmlToMarkdown(html, finalUrl);
      if (page.markdown.length > 80) {
        pages.push({ url: finalUrl, title: page.title, markdown: page.markdown });
        total += page.markdown.length;
      }
      const fresh = page.links.filter((l) => !visited.has(l.replace(/\/$/, '')) && !queue.includes(l));
      fresh.sort((a, b) => Number(PRIORITY.test(b)) - Number(PRIORITY.test(a)));
      queue.push(...fresh.slice(0, 40));
      queue.sort((a, b) => Number(PRIORITY.test(b)) - Number(PRIORITY.test(a)));
    } catch (err) {
      errors.push({ url, error: err.message });
      if (url === start && !pages.length) throw new Error(`Die Website konnte nicht geladen werden (${err.message}).`);
    }
  }
  return { pages, errors };
}

const CONDENSE_SYSTEM = `Du bereitest Website-Inhalte eines kleinen Unternehmens als Wissensbasis für einen Kunden-Chat-Assistenten auf.
Regeln:
- Übernimm NUR Fakten, die im Text stehen. Erfinde nichts, ergänze nichts, schätze nichts.
- Schreibe auf Deutsch, sachlich und vollständig: Preise, Zeiten, Adressen, Telefonnummern und Bedingungen exakt übernehmen.
- Gliedere mit Markdown-Überschriften (# …). Sinnvolle Abschnitte, soweit Informationen vorhanden: Über uns, Kontakt, Standorte und Anfahrt, Öffnungszeiten, Leistungen, Preise, Ablauf/Termine/Buchung, Bedingungen, Häufige Fragen.
- Lass Navigation, Werbeslogans ohne Inhalt, Cookie-Hinweise, Rechtstexte (Datenschutz, AGB) und Wiederholungen weg.
- Abschnitte ohne Informationen weglassen. Gib nur das Markdown aus, ohne Einleitung.`;

/**
 * Website importieren: crawlen und – wenn Claude verfügbar ist – zu einer sauberen,
 * kompakten Wissensbasis zusammenfassen. Sonst wird der Rohtext pro Seite verwendet.
 */
export async function importWebsite(url, { maxPages = 12, condense = true } = {}) {
  const { pages, errors } = await crawlWebsite(url, { maxPages });
  if (!pages.length) throw new Error('Auf der Website wurde kein lesbarer Text gefunden.');

  const raw = pages.map((p) => `# Seite: ${p.title || p.url}\nQuelle: ${p.url}\n${p.markdown}`).join('\n\n');
  let markdown = null;
  if (condense) {
    try {
      markdown = await completeText({ system: CONDENSE_SYSTEM, prompt: raw.slice(0, MAX_TOTAL_CHARS), maxTokens: 6000 });
    } catch (err) {
      errors.push({ url: 'Zusammenfassung', error: err.message });
    }
  }
  return {
    markdown: markdown || raw,
    condensed: Boolean(markdown),
    pages: pages.map((p) => ({ url: p.url, title: p.title, chars: p.markdown.length })),
    errors,
  };
}

/** Text aus einer PDF-Datei (Buffer) extrahieren. */
export async function extractPdfText(buffer) {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const pages = (Array.isArray(text) ? text : [text]).map((t) => String(t).replace(/[ \t]+/g, ' ').trim());
  const joined = pages.filter(Boolean).join('\n\n');
  if (joined.length < 20) {
    throw new Error('In dieser PDF wurde kein Text gefunden (evtl. eingescannt). Bitte den Text manuell einfügen.');
  }
  return { totalPages, text: joined.slice(0, 300_000) };
}
