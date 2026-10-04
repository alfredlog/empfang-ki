# Empfang KI

**Der digitale Empfang für die Website kleiner Betriebe.** Ein KI-Assistent, der Kundenfragen rund um die Uhr beantwortet, Anfragen (Angebot, Termin, Rückruf, Schadensmeldung) strukturiert aufnimmt und per E-Mail an den Betrieb weiterleitet. Für Handwerksbetriebe, Hausverwaltungen, Studios, Werkstätten, Praxen und Kanzleien in der Region Rhein-Main/Rhein-Neckar.

Live-Demo: **https://chatbot.pdf-libre.de**

## Funktionen

- **Einbettbares Widget**: eine Zeile `<script>` in jede Website (WordPress, Jimdo, Wix …). Shadow DOM, keine CSS-Konflikte, Streaming-Antworten, mobil im Vollbild, barrierearm.
- **Mandantenfähig**: ein Server, beliebig viele Betriebe. Jeder Betrieb hat einen Public Key (`data-bot-id`) und eine Liste erlaubter Domains.
- **Antworten nur aus der Wissensbasis**: Kleine Wissensbasen kommen komplett in den Prompt (mit Prompt-Caching), große werden per deutscher Volltextsuche (Postgres `tsvector`) gefiltert.
- **Anfragen per Tool-Use**: Claude ruft `anfrage_erstellen` auf, sobald Name, Kontakt und Anliegen bestätigt sind. Die Anfrage wird gespeichert und per E-Mail an den Betrieb geschickt.
- **Offene Fragen und Wissenslücken**: Kann der Assistent etwas nicht beantworten, nimmt er die Kontaktdaten auf und speichert die unbeantwortete Frage. Der Betrieb ruft zurück und kann die Antwort ergänzen.
- **Branchen-Vorlagen**: Aufgaben, Grenzen und Ton pro Branche, z. B. keine medizinische oder rechtliche Beratung, Notfall-Hinweise (112, 116 117) per deterministischer Erkennung vor dem LLM.
- **Gehostete Chat-Seite** `/c/<slug>` für Betriebe ohne Website (Link/QR-Code).
- **Datensparsamkeit**: automatische Löschung von Gesprächen nach `RETENTION_DAYS`, Origin-Prüfung, Rate-Limits, Paket-Limits pro Monat.
- **Austauschbares LLM**: Anthropic Claude (Standard: Haiku 4.5) oder ein Mock-Modus für Entwicklung ohne API-Key.

## Architektur

```
Website des Betriebs ──<script data-bot-id>──▶ widget.js (Vanilla JS, Shadow DOM)
                                                   │  POST /api/v1/chat  (SSE-Stream)
                                                   ▼
                                  Express-API ── Origin-Check, Rate-Limit
                                     │
             ┌───────────────────────┼─────────────────────────┐
     Branchen-Vorlage +       Wissensbasis-Retrieval      Anthropic API (Claude)
     Systemprompt             (Full-Context / FTS)         + Tool "anfrage_erstellen"
                                     │                           │
                               PostgreSQL ◀── Anfragen ──▶ E-Mail an den Betrieb
```

```
server/src/
  app.js, index.js          Express-App, Start, tägliche Löschung alter Gespräche
  config.js                 Konfiguration aus Umgebungsvariablen
  db/                       Pool, Migrations-Runner, SQL-Migrationen
  routes/public.js          Widget-Config, Chat (SSE), gehostete Chat-Seite
  routes/admin.js           Kunden, Wissensbasis, Anfragen, offene Fragen, Gespräche
  services/chat.js          Chat-Turn: Notfall-Check → Retrieval → LLM → Tool-Use → Speichern
  services/knowledge.js     Chunking, Speicherung, Retrieval
  services/llm.js           Anthropic-Streaming + Mock
  services/mailer.js        Benachrichtigung per SMTP
  templates/industries.js   Branchen-Vorlagen und Systemprompt
widget/widget.js            Einbettbares Chat-Widget
web/                        Landing-Page, Demo-Websites, gehostete Chat-Seite
tests/                      Unit- und Integrationstests (node:test)
```

## Lokal starten

Voraussetzungen: Node.js 20+ und PostgreSQL 14+.

```bash
npm install                      # Abhängigkeiten installieren
cp .env.example .env             # Konfiguration anlegen (ohne API-Key läuft der Mock-Modus)
npm run seed                     # Tabellen anlegen + Demo-Betriebe einspielen
npm run dev                      # Server mit Auto-Reload auf http://localhost:3000
npm test                         # Tests ausführen
```

## Deployment (VPS mit Docker)

```bash
git clone https://github.com/alfredlog/empfang-ki.git && cd empfang-ki
cp .env.example .env && nano .env          # PUBLIC_URL, POSTGRES_PASSWORD, ANTHROPIC_API_KEY, ADMIN_TOKEN, SMTP
docker compose up -d --build               # App + Datenbank starten (App auf 127.0.0.1:3010)
docker compose exec app node server/src/scripts/seed.js   # Demo-Betriebe einspielen
```

Danach den Reverse-Proxy einrichten: `infra/Caddyfile.example` (Caddy) oder `infra/nginx.example.conf` (nginx), und einen DNS-A-Record für die Subdomain auf die Server-IP setzen.

## Neuen Kunden anlegen

```bash
curl -X POST https://chatbot.pdf-libre.de/api/admin/tenants \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Malerei Beispiel","slug":"malerei-beispiel","industry":"handwerk","city":"Darmstadt",
       "contactEmail":"info@malerei-beispiel.de","plan":"business","allowedOrigins":["malerei-beispiel.de"]}'

curl -X PUT https://chatbot.pdf-libre.de/api/admin/tenants/<id>/knowledge \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"text":"# Öffnungszeiten\nMo–Fr 7–16 Uhr\n\n# Leistungen\n..."}'
```

Der Kunde bekommt dann die Zeile `<script src="https://chatbot.pdf-libre.de/widget.js" data-bot-id="pk_…" defer></script>`.

Branchen: `handwerk`, `hausverwaltung`, `kosmetik`, `autovermietung`, `arztpraxis`, `kanzlei`, `allgemein`.

## Roadmap

- Kunden-Dashboard (Login, Anfragen, offene Fragen mit „Antwort hinzufügen“, Gespräche, Einstellungen)
- Wissensbasis automatisch aus der Website des Kunden und aus PDFs einlesen
- Stripe-Abos für die Pakete
- Benachrichtigung zusätzlich per SMS/WhatsApp
- Optional semantische Suche mit Embeddings (pgvector)

---

Entwickelt von Alfred Mushagalusa Munganga, Informatik an der TU Darmstadt.
