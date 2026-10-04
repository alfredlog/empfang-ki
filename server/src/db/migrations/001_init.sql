-- Grundschema: mandantenfähig, jede Tabelle hängt an tenant_id.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE tenants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_key      text NOT NULL UNIQUE,          -- steht im Widget-Script (data-bot-id)
  slug            text NOT NULL UNIQUE,          -- für die gehostete Chat-Seite /c/<slug>
  name            text NOT NULL,
  industry        text NOT NULL,                 -- Schlüssel einer Branchen-Vorlage
  city            text,
  website         text,
  contact_email   text,                          -- hierhin gehen neue Anfragen
  phone           text,
  plan            text NOT NULL DEFAULT 'starter',
  settings        jsonb NOT NULL DEFAULT '{}'::jsonb,  -- Farbe, Begrüßung, Schnellantworten, Buchungslink …
  allowed_origins text[] NOT NULL DEFAULT '{}',  -- Domains, auf denen das Widget laufen darf
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE knowledge_chunks (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source      text NOT NULL DEFAULT 'manual',    -- manual | website | pdf
  title       text NOT NULL,
  content     text NOT NULL,
  tokens      integer NOT NULL,
  position    integer NOT NULL DEFAULT 0,
  tsv         tsvector GENERATED ALWAYS AS (
                setweight(to_tsvector('german', coalesce(title, '')), 'A') ||
                setweight(to_tsvector('german', content), 'B')
              ) STORED,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX knowledge_chunks_tenant_idx ON knowledge_chunks (tenant_id, position);
CREATE INDEX knowledge_chunks_tsv_idx ON knowledge_chunks USING gin (tsv);

CREATE TABLE conversations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  visitor_id     text,
  origin         text,
  message_count  integer NOT NULL DEFAULT 0,
  started_at     timestamptz NOT NULL DEFAULT now(),
  last_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_tenant_idx ON conversations (tenant_id, last_at DESC);

CREATE TABLE messages (
  id               bigserial PRIMARY KEY,
  conversation_id  uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role             text NOT NULL CHECK (role IN ('user', 'assistant')),
  content          text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conversation_idx ON messages (conversation_id, id);

CREATE TABLE leads (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id  uuid REFERENCES conversations(id) ON DELETE SET NULL,
  kind             text NOT NULL,              -- termin | rueckruf | angebot | schaden | sonstiges
  name             text NOT NULL,
  phone            text,
  email            text,
  summary          text NOT NULL,
  details          jsonb NOT NULL DEFAULT '{}'::jsonb,
  status           text NOT NULL DEFAULT 'neu', -- neu | in_bearbeitung | erledigt
  notified_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX leads_tenant_idx ON leads (tenant_id, created_at DESC);

-- Verbrauch pro Monat (für Paket-Limits und deine Kostenkontrolle)
CREATE TABLE usage_monthly (
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  month          date NOT NULL,
  conversations  integer NOT NULL DEFAULT 0,
  messages       integer NOT NULL DEFAULT 0,
  input_tokens   bigint NOT NULL DEFAULT 0,
  output_tokens  bigint NOT NULL DEFAULT 0,
  cache_read_tokens bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, month)
);
