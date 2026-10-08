// Legt die Demo-Betriebe an (idempotent – kann beliebig oft ausgeführt werden).
// Alle Muster-Betriebe sind frei erfunden und verschicken in der Demo keine E-Mails.
import { config } from '../config.js';
import { migrate } from '../db/migrate.js';
import { pool, query } from '../db/pool.js';
import { replaceKnowledge } from '../services/knowledge.js';
import { normalizeOrigins } from '../services/tenants.js';

const demos = [
  {
    // Der eigene Assistent auf der Landing-Page – beantwortet Fragen zum Produkt
    publicKey: 'pk_empfang_ki',
    slug: 'empfang-ki',
    name: 'Empfang KI',
    industry: 'allgemein',
    city: 'Darmstadt',
    settings: {
      color: '#0e5e63',
      assistantName: 'Empfang KI',
      greeting: 'Hallo! Ich bin der Assistent von Empfang KI. Fragen Sie mich, was ich für Ihren Betrieb tun kann. Oder klingeln Sie oben bei einem Demo-Betrieb.',
      quickReplies: ['Was kostet das?', 'Wie kommt das auf meine Website?', 'Ist das DSGVO-konform?'],
      extraInstructions: 'Du sprichst mit Inhaberinnen und Inhabern kleiner Betriebe, die das Produkt kennenlernen. Wenn jemand Interesse an einer Beratung oder Demo hat, nimm Name, Betrieb und Telefon oder E-Mail mit der Anfrage-Art "anfrage" auf.',
    },
    knowledge: `# Was ist Empfang KI?
Empfang KI ist ein KI-Assistent für die Website kleiner Betriebe in Darmstadt, Frankfurt, Mainz, Mannheim und Ludwigshafen. Er beantwortet Kundenfragen rund um die Uhr, nimmt Anfragen auf (Angebot, Termin, Rückruf, Schadensmeldung) und schickt sie per E-Mail an den Betrieb. Fragen, die er nicht beantworten kann, leitet er mit den Kontaktdaten des Kunden weiter; der Betrieb kann die Antwort danach ergänzen.

# Für welche Branchen?
Handwerk, Hausverwaltungen, Kosmetik- und Friseurstudios, Autovermietungen und Werkstätten, Arztpraxen, Kanzleien und Steuerberatungen sowie andere kleine Betriebe. Jede Branche hat eine eigene Vorlage mit passenden Fragen und Regeln.

# Preise
Alle Pakete enthalten alle Funktionen (Antworten aus Website/PDFs, Anfragen per E-Mail und im Dashboard, offene Fragen, Online-Terminbuchung über freie Termine, Wissen selbst ändern, eigene Farben und Begrüßung, Einbau auf mehreren Websites, eigene Chat-Seite, Einrichtung durch uns). Die Pakete unterscheiden sich nur in der Anzahl der Gespräche pro Monat.
Gründerpreise für die ersten zehn Betriebe aus der Region, garantiert für zwölf Monate, ohne Einrichtungsgebühr:
Starter: 29 € pro Monat (später 49 €), bis 200 Gespräche.
Business: 59 € pro Monat (später 99 €), bis 600 Gespräche.
Pro: 99 € pro Monat (später 179 €), bis 1.500 Gespräche.
Neue Kunden können den Assistenten 14 Tage kostenlos testen. Monatlich kündbar.

# Einbau
Der Betrieb gibt seine Infos (Website, Preisliste, Stichpunkte). Danach wird eine Zeile Code in die Website eingefügt; das funktioniert mit WordPress, Jimdo, Wix und allen anderen Websites. Die Einrichtung übernehmen wir auf Wunsch. Betriebe ohne Website bekommen eine eigene Chat-Seite mit Link und QR-Code.

# Terminbuchung
Der Betrieb trägt im Dashboard freie Termine ein, einzeln oder jede Woche wiederkehrend. Der Assistent schlägt Kunden passende freie Termine vor und bucht den gewünschten direkt. Der Betrieb bekommt die Buchung per E-Mail und sieht sie im Dashboard. Vergangene oder bereits gebuchte Termine werden nicht mehr angeboten.

# Datenschutz
Die Anwendung und die Gesprächsdaten liegen auf einem Server in Deutschland. Gespräche werden nach 30 Tagen automatisch gelöscht. Der Assistent fragt nur Name, Kontakt und Anliegen ab. Für die Antworten wird ein KI-Sprachmodell (Claude von Anthropic) genutzt. Ein Vertrag zur Auftragsverarbeitung (AVV) wird bereitgestellt.

# Kontakt
Ansprechpartner: Alfred Mushagalusa Munganga, Darmstadt. E-Mail: support@empfang-ki.de. Beratung und Demo dauern etwa 15 Minuten, gern auch persönlich vor Ort.`,
  },
  {
    publicKey: 'pk_demo_auto',
    slug: 'autovermietung-demo',
    name: 'Autovermietung',
    industry: 'autovermietung',
    city: 'Darmstadt',
    phone: '06151 000000',
    settings: {
      color: '#c8102e',
      assistantName: 'Mietwagen-Assistent',
      quickReplies: ['Transporter mieten', 'TÜV-Termin anfragen', 'Öffnungszeiten'],
    },
    knowledge: `# Über uns
Die (fiktive) Autovermietung in Darmstadt bietet Mietwagen, eine meistergeführte Kfz-Werkstatt und Fahrzeugpflege aus einer Hand.

# Kontakt
Telefon: 06151 000000
Adresse: Musterstraße 1, 64283 Darmstadt

# Öffnungszeiten
Vermietung: Montag bis Freitag 08:00–18:00 Uhr, Samstag 09:00–13:00 Uhr.
Werkstatt: Montag bis Freitag 07:30–17:00 Uhr.
Sonntag geschlossen – Anfragen über diesen Chat werden am nächsten Werktag bearbeitet.

# Mietwagen
Kleinwagen (z. B. VW Polo): ab 39 € pro Tag.
Kombi (z. B. Skoda Octavia): ab 55 € pro Tag.
Transporter (z. B. VW Crafter, 3,5 t): ab 69 € pro Tag, ideal für Umzüge.
9-Sitzer (z. B. Ford Transit Kombi): ab 89 € pro Tag.
Wochenend-Tarif: Freitag 16 Uhr bis Montag 9 Uhr zum Preis von zwei Tagen.
Inklusive 200 Freikilometer pro Tag, jeder weitere Kilometer 0,25 €.
Mindestalter 21 Jahre, Führerschein seit mindestens 2 Jahren. Kaution 300 € (nur Kreditkarte).
Reservierung: telefonisch oder über eine Anfrage in diesem Chat. Das Team bestätigt Verfügbarkeit und Preis.

# Werkstatt
Meistergeführte Werkstatt für alle Marken: Inspektion, TÜV und AU, Reifenwechsel (ab 25 €), Einlagerung von Reifen (40 € pro Saison), Klimaservice, Bremsen, Unfallreparatur.

# Fahrzeugpflege
Innen- und Außenreinigung, Polsterreinigung, Politur.

# Zahlung
EC-Karte, Kreditkarte oder bar.`,
  },
  {
    publicKey: 'pk_demo_maler',
    slug: 'malerbetrieb-farbwerk',
    name: 'Malerbetrieb Farbwerk',
    industry: 'handwerk',
    city: 'Darmstadt',
    phone: '06151 000000',
    settings: { color: '#2f6b4f', assistantName: 'Farbwerk-Assistent' },
    knowledge: `# Über uns
Malerbetrieb Farbwerk ist ein (fiktiver) Meisterbetrieb mit 6 Mitarbeitenden in Darmstadt. Seit 2009 für Privatkunden, Hausverwaltungen und Gewerbe.

# Einzugsgebiet
Darmstadt, Griesheim, Weiterstadt, Pfungstadt, Roßdorf, Mühltal und Ober-Ramstadt. Größere Aufträge auch im Rhein-Main-Gebiet.

# Leistungen
Innenanstrich (Wände, Decken, Treppenhäuser), Fassadenanstrich, Tapezieren (Raufaser, Vlies, Designtapeten), Lackierarbeiten an Türen, Fenstern und Heizkörpern, Spachteltechnik und Kalkputz, Schimmelsanierung (malerseitig), Bodenbeläge (Vinyl, Laminat), Renovierung bei Auszug.

# Ablauf
1. Anfrage per Chat, Telefon oder E-Mail. 2. Kostenloser Besichtigungstermin innerhalb von ca. 5 Werktagen. 3. Schriftliches Festpreis-Angebot innerhalb von 3 Werktagen nach Besichtigung. 4. Ausführung mit Abdeckung, Möbelschutz und Endreinigung.
Für kleinere Innenarbeiten reichen oft Fotos und die ungefähre Raumgröße für ein erstes Angebot.

# Preise
Richtwert Innenanstrich weiß inkl. Material: ab 9 € pro m² Wandfläche. Der genaue Preis hängt vom Untergrund und Aufwand ab und steht im Angebot.

# Öffnungszeiten
Büro: Montag bis Freitag 7:30–16:30 Uhr. Auf Baustellen arbeiten wir Montag bis Freitag 7:00–17:00 Uhr.

# Kontakt
Telefon 06151 000000 (Demo-Nummer), E-Mail info@farbwerk-demo.de. Adresse: Musterstraße 12, 64283 Darmstadt.`,
  },
  {
    publicKey: 'pk_demo_hausverwaltung',
    slug: 'hausverwaltung-rheinblick',
    name: 'Hausverwaltung Rheinblick',
    industry: 'hausverwaltung',
    city: 'Mainz',
    phone: '06131 000000',
    settings: { color: '#1f4e79', assistantName: 'Rheinblick-Service' },
    knowledge: `# Über uns
Hausverwaltung Rheinblick (fiktiv) verwaltet rund 900 Wohnungen in Mainz, Wiesbaden und Rüsselsheim – Miet- und WEG-Verwaltung.

# Erreichbarkeit
Büro: Montag bis Donnerstag 9–16 Uhr, Freitag 9–13 Uhr. Telefonische Sprechzeiten: Dienstag und Donnerstag 10–12 Uhr unter 06131 000000.
Adresse: Rheinallee 1, 55116 Mainz (Demo-Adresse).

# Notfälle außerhalb der Bürozeiten
Notdienst (Wasserrohrbruch, Heizungsausfall, Stromausfall im Gemeinschaftsbereich, Sturmschäden): 06131 000001.
Bei Feuer oder Gasgeruch immer zuerst 112 bzw. die Störungsnummer der Mainzer Stadtwerke wählen.
Schlüsseldienst: Bei verlorenem Wohnungsschlüssel bitte selbst einen Schlüsseldienst beauftragen; Kosten trägt der Mieter.

# Schadensmeldung
Schäden können rund um die Uhr hier im Chat gemeldet werden. Bitte angeben: Adresse und Wohnung, was kaputt ist, seit wann, ob es dringend ist, und wie wir Sie erreichen. Fotos können Sie anschließend an schaden@rheinblick-demo.de senden.
Für kleinere Reparaturen beauftragt die Verwaltung einen Handwerksbetrieb; dieser meldet sich direkt zur Terminabsprache.

# Nebenkostenabrechnung
Die Betriebskostenabrechnung wird jährlich bis spätestens 31. Dezember für das Vorjahr verschickt. Belegeinsicht ist nach Terminvereinbarung im Büro möglich.

# Ansprechpartner
Objekte in Mainz: Frau Muster. Objekte in Wiesbaden und Rüsselsheim: Herr Beispiel. Buchhaltung und Mietzahlungen: Frau Demo.

# Häufige Fragen
Untervermietung, Tierhaltung und bauliche Veränderungen müssen schriftlich beantragt werden.
Wohnungsgeberbestätigung für das Bürgeramt: wird beim Einzug automatisch ausgestellt; Ersatz per E-Mail anfordern.
Kündigung: schriftlich mit Unterschrift per Post an die Verwaltung.`,
  },
  {
    publicKey: 'pk_demo_kosmetik',
    slug: 'kosmetikstudio-lumen',
    name: 'Kosmetikstudio Lumen',
    industry: 'kosmetik',
    city: 'Frankfurt am Main',
    phone: '069 000000',
    settings: { color: '#9a4e6b', assistantName: 'Lumen-Rezeption' },
    knowledge: `# Über uns
Kosmetikstudio Lumen (fiktiv) in Frankfurt-Bornheim. Zwei Kosmetikerinnen, ruhige Atmosphäre, Naturkosmetik.

# Adresse und Anfahrt
Berger Straße 100, 60316 Frankfurt (Demo-Adresse). U4 Haltestelle Bornheim Mitte, 3 Minuten zu Fuß. Parken in der Umgebung schwierig.

# Öffnungszeiten
Dienstag bis Freitag 10–19 Uhr, Samstag 9–15 Uhr. Sonntag und Montag geschlossen.

# Behandlungen und Preise
Klassische Gesichtsbehandlung (75 Min.): 79 €
Express-Gesichtsbehandlung (45 Min.): 52 €
Anti-Aging-Behandlung mit Massage (90 Min.): 98 €
Augenbrauen zupfen und färben (20 Min.): 22 €
Wimpern färben (15 Min.): 16 €
Maniküre mit Lack (45 Min.): 35 €
Pediküre kosmetisch (50 Min.): 42 €
Gutscheine sind im Studio und per E-Mail erhältlich.

# Termine
Online-Buchung über unseren Buchungslink oder Terminwunsch hier im Chat. Absagen bitte mindestens 24 Stunden vorher, sonst berechnen wir 50 % des Behandlungspreises.

# Zahlung
Bar, EC-Karte und Apple Pay.`,
  },
];

await migrate({ log: () => {} });

// Frühere Demo mit echten Firmendaten entfernen
await query("DELETE FROM tenants WHERE slug = 'autovermietung-prinz' OR public_key = 'pk_demo_prinz'");

for (const d of demos) {
  const { rows } = await query(
    `INSERT INTO tenants (public_key, slug, name, industry, city, website, phone, plan, allowed_origins, settings)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'demo',$8,$9)
     ON CONFLICT (slug) DO UPDATE SET
       public_key = EXCLUDED.public_key, name = EXCLUDED.name, industry = EXCLUDED.industry, city = EXCLUDED.city,
       website = EXCLUDED.website, phone = EXCLUDED.phone, allowed_origins = EXCLUDED.allowed_origins, settings = EXCLUDED.settings
     RETURNING id`,
    [d.publicKey, d.slug, d.name, d.industry, d.city, d.website || null, d.phone, normalizeOrigins(d.allowedOrigins || []),
      { privacyUrl: `${config.publicUrl}/datenschutz`, ...d.settings }],
  );
  const chunks = await replaceKnowledge(rows[0].id, { source: 'manual', title: 'Allgemein', text: d.knowledge });
  console.log(`✓ ${d.name} (${d.publicKey}) – ${chunks} Wissensabschnitte`);
}

await pool.end();
