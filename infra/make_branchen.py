# Erzeugt die Branchen-Seiten (SEO): /handwerk, /hausverwaltung, /kosmetik, /autowerkstatt
# Ausführen: python3 infra/make_branchen.py
import html, os

WEB = os.path.join(os.path.dirname(__file__), '..', 'web')
BASE = 'https://empfang-ki.de'
CITIES = 'Darmstadt, Frankfurt, Mainz, Mannheim und Ludwigshafen'

PAGES = {
  'handwerk': dict(
    title='KI-Chatbot für Handwerksbetriebe',
    h1='Keine Anfrage mehr verpassen, auch wenn Sie auf der Baustelle stehen.',
    lead='Der KI-Assistent auf Ihrer Website beantwortet Fragen zu Leistungen, Einzugsgebiet und Ablauf und nimmt Angebotsanfragen vollständig auf: was, wo, wie groß, bis wann. Sie bekommen alles per E-Mail und rufen gezielt zurück.',
    pains=['Das Telefon klingelt, während Sie arbeiten, und der Kunde ruft beim nächsten Betrieb an.',
           'Abends und am Wochenende kommen Anfragen, die bis Montag liegen bleiben.',
           'Viele Anfragen sind unvollständig, und Sie müssen erst hinterhertelefonieren.'],
    does=['Beantwortet Fragen zu Leistungen, Einzugsgebiet, Öffnungszeiten und Ablauf',
          'Nimmt Angebotsanfragen strukturiert auf: Art der Arbeit, Ort, Umfang, Zeitraum, Kontakt',
          'Weist bei Notfällen auf Ihre Notdienstnummer hin',
          'Nennt keine Fantasiepreise, sondern nur Ihre echten Richtwerte'],
    chat=[('user', 'Was kostet es, ein Wohnzimmer mit 25 m² zu streichen?'),
          ('bot', 'Für einen Innenanstrich in Weiß rechnen wir ab 9 € pro m² Wandfläche. Den genauen Preis nennen wir nach einer kostenlosen Besichtigung. Soll ich eine Angebotsanfrage für Sie aufnehmen?'),
          ('user', 'Ja, gern. Max Muster, 0151 2345678, Darmstadt-Bessungen.')],
    demo='/demo/farbwerk', demo_label='Demo: Malerbetrieb ansehen',
    examples='Maler, Elektriker, Sanitär und Heizung, Dachdecker, Fliesenleger, Schreiner, Garten- und Landschaftsbau'),
  'hausverwaltung': dict(
    title='KI-Chatbot für Hausverwaltungen',
    h1='Weniger Anrufe, sauber aufgenommene Schadensmeldungen.',
    lead='Mieterinnen, Mieter und Eigentümer bekommen rund um die Uhr Antworten auf die immer gleichen Fragen. Schäden werden vollständig gemeldet, mit Adresse, Wohnung, Art und Dringlichkeit, und landen direkt bei Ihnen.',
    pains=['Telefonische Sprechzeiten sind überlaufen, immer mit denselben Fragen.',
           'Schadensmeldungen kommen unvollständig per Telefon, Zettel oder WhatsApp.',
           'Bei Notfällen außerhalb der Bürozeiten weiß niemand, wen er anrufen soll.'],
    does=['Beantwortet Fragen zu Ansprechpartnern, Nebenkostenabrechnung, Formularen und Abläufen',
          'Nimmt Schadensmeldungen vollständig auf und schickt sie sofort per E-Mail',
          'Erkennt Notfälle wie Gasgeruch oder Wasserrohrbruch und nennt sofort die richtigen Nummern',
          'Gibt keine Rechtsauskünfte zu Mietrecht oder Mietminderung'],
    chat=[('user', 'Bei uns im Bad tropft es von der Decke.'),
          ('bot', 'Das nehme ich gleich als Schadensmeldung auf. Wie lautet die Adresse und Ihre Wohnung, seit wann tropft es, und wie erreichen wir Sie?'),
          ('user', 'Rheinallee 12, 3. OG links, seit heute Morgen, 0176 1112233.')],
    demo='/demo/rheinblick', demo_label='Demo: Hausverwaltung ansehen',
    examples='Mietverwaltung, WEG-Verwaltung, Sondereigentumsverwaltung, Gewerbeverwaltung'),
  'kosmetik': dict(
    title='KI-Chatbot für Kosmetik- und Friseurstudios',
    h1='Ihre Rezeption beantwortet Fragen, während Sie behandeln.',
    lead='Preise, Dauer, Öffnungszeiten, Anfahrt: Der Assistent beantwortet die häufigsten Fragen sofort, verweist auf Ihren Online-Buchungslink oder nimmt Terminwünsche auf. Sie werden nicht mehr mitten in der Behandlung unterbrochen.',
    pains=['Während der Behandlung können Sie nicht ans Telefon gehen.',
           'Dieselben Fragen zu Preisen und freien Terminen kommen jeden Tag.',
           'Kundinnen schreiben abends, und die Anfrage geht unter.'],
    does=['Beantwortet Fragen zu Behandlungen, Preisen, Dauer und Öffnungszeiten',
          'Verweist auf Ihren Buchungslink (z. B. Treatwell, Shore, Planity) oder nimmt Terminwünsche auf',
          'Antwortet auch auf Türkisch, Englisch, Arabisch und weiteren Sprachen',
          'Gibt keine medizinischen Empfehlungen, z. B. bei Hautproblemen'],
    chat=[('user', 'Was kostet eine klassische Gesichtsbehandlung und wie lange dauert sie?'),
          ('bot', 'Die klassische Gesichtsbehandlung dauert 75 Minuten und kostet 79 €. Möchten Sie direkt online einen Termin buchen?'),
          ('user', 'Ja, am liebsten Samstagvormittag.')],
    demo='/demo/lumen', demo_label='Demo: Kosmetikstudio ansehen',
    examples='Kosmetikstudios, Friseure, Nagelstudios, Barbershops, Massage- und Wellnessstudios'),
  'autowerkstatt': dict(
    title='KI-Chatbot für Kfz-Werkstätten und Autovermietungen',
    h1='Werkstatttermine und Mietanfragen, auch nach Feierabend.',
    lead='Kunden fragen nach TÜV-Terminen, Reifenwechsel oder einem Transporter fürs Wochenende, oft dann, wenn das Büro geschlossen ist. Der Assistent beantwortet die Fragen und nimmt Termin- und Mietanfragen vollständig auf.',
    pains=['Das Büro ist nur zu Werkstattzeiten besetzt, Anfragen kommen aber rund um die Uhr.',
           'Viele Anrufe drehen sich um dieselben Fragen: Öffnungszeiten, Preise, Verfügbarkeit.',
           'Mietanfragen am Wochenende gehen verloren.'],
    does=['Beantwortet Fragen zu Leistungen, Standorten, Öffnungszeiten und Mietbedingungen',
          'Nimmt Werkstatttermine auf: Leistung, Fahrzeug, Wunschzeitraum, Kontakt',
          'Nimmt Mietanfragen auf: Fahrzeugart, Abholung, Rückgabe, Standort',
          'Bestätigt keine Verfügbarkeit, die nicht feststeht, sondern leitet weiter'],
    chat=[('user', 'Kann ich am Samstag einen Transporter abholen?'),
          ('bot', 'Unser Vermietungsbüro ist samstags geschlossen. Ich nehme Ihre Anfrage aber gern auf, dann meldet sich das Team am Montag mit Verfügbarkeit und Preis. Welche Fahrzeuggröße brauchen Sie?'),
          ('user', 'Einen Transporter, Freitag bis Sonntag.')],
    demo='/demo/autovermietung', demo_label='Demo: Autovermietung & Werkstatt ansehen',
    examples='Kfz-Werkstätten, Reifenservice, Autovermietungen, Autohäuser, Fahrzeugpflege'),
}

def page(slug, p):
    e = html.escape
    desc = f"{p['title']} in {CITIES}: beantwortet Kundenfragen rund um die Uhr und leitet Anfragen direkt an Sie weiter. 14 Tage kostenlos testen."
    chat = ''.join(f'<li class="{r}">{e(t)}</li>' for r, t in p['chat'])
    return f'''<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{e(p['title'])} in Darmstadt, Frankfurt, Mainz | Empfang KI</title>
  <meta name="description" content="{e(desc)}">
  <link rel="canonical" href="{BASE}/{slug}">
  <meta property="og:title" content="{e(p['title'])} | Empfang KI">
  <meta property="og:description" content="{e(desc)}">
  <meta property="og:image" content="{BASE}/assets/brand/og-image.png">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="stylesheet" href="/assets/fonts.css">
  <link rel="stylesheet" href="/assets/site.css">
</head>
<body>
  <header class="top">
    <div class="wrap">
      <a class="brand" href="/"><img class="brand-mark" src="/assets/brand/logo-symbol.svg" alt="" width="30" height="30">Empfang KI</a>
      <nav aria-label="Hauptnavigation"><a href="/#preise">Preise</a><a href="/#kontakt">Kontakt</a><a href="/app/">Kunden-Login</a></nav>
    </div>
  </header>
  <main>
    <section class="hero branche-hero">
      <div class="wrap">
        <div>
          <p class="crumb"><a href="/">Empfang KI</a> / {e(p['title'])}</p>
          <h1>{e(p['h1'])}</h1>
          <p class="lead">{e(p['lead'])}</p>
          <div class="actions">
            <a class="btn btn-primary" href="{p['demo']}">{e(p['demo_label'])}</a>
            <a class="btn btn-ghost" href="/#kontakt">14 Tage kostenlos testen</a>
          </div>
          <p class="cities">Für Betriebe in {CITIES}.</p>
        </div>
        <ul class="chat-sample" aria-label="Beispielgespräch">{chat}</ul>
      </div>
    </section>
    <section class="section section-paper">
      <div class="wrap jobs-2">
        <div>
          <h2>Kennen Sie das?</h2>
          <ul class="pains">{''.join(f'<li>{e(x)}</li>' for x in p['pains'])}</ul>
        </div>
        <div>
          <h2>Das übernimmt Ihr Assistent</h2>
          <ul class="does">{''.join(f'<li>{e(x)}</li>' for x in p['does'])}</ul>
        </div>
      </div>
    </section>
    <section class="section">
      <div class="wrap">
        <h2>Geeignet für</h2>
        <p class="intro">{e(p['examples'])}.</p>
        <h2>Preis</h2>
        <p class="intro">Ab 29 € im Monat, alle Funktionen in jedem Paket, monatlich kündbar. Gründerpreis für die ersten zehn Betriebe aus der Region, ohne Einrichtungsgebühr. <a href="/#preise">Alle Pakete ansehen</a></p>
        <a class="btn btn-primary" href="/#kontakt">14 Tage kostenlos testen</a>
      </div>
    </section>
  </main>
  <footer class="foot"><div class="wrap"><span>© 2026 Empfang KI, Darmstadt</span>
    <nav aria-label="Branchen"><a href="/handwerk">Handwerk</a><a href="/hausverwaltung">Hausverwaltung</a><a href="/kosmetik">Kosmetik &amp; Friseur</a><a href="/autowerkstatt">Werkstatt &amp; Vermietung</a></nav>
    <nav aria-label="Rechtliches"><a href="/impressum">Impressum</a><a href="/datenschutz">Datenschutz</a></nav></div></footer>
  <script src="/widget.js" data-bot-id="pk_empfang_ki" defer></script>
</body>
</html>
'''

for slug, p in PAGES.items():
    open(os.path.join(WEB, f'{slug}.html'), 'w').write(page(slug, p))

urls = ['', 'handwerk', 'hausverwaltung', 'kosmetik', 'autowerkstatt', 'impressum', 'datenschutz']
open(os.path.join(WEB, 'sitemap.xml'), 'w').write(
  '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
  + ''.join(f'  <url><loc>{BASE}/{u}</loc></url>\n' for u in urls) + '</urlset>\n')
open(os.path.join(WEB, 'robots.txt'), 'w').write(
  f'User-agent: *\nDisallow: /admin/\nDisallow: /app/\nDisallow: /api/\nDisallow: /c/\nDisallow: /demo/\n\nSitemap: {BASE}/sitemap.xml\n')
print('Branchen-Seiten erzeugt:', ', '.join(PAGES))
