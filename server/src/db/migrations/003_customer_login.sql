-- Kunden-Zugänge fürs Dashboard: Login per Magic Link (ohne Passwort).
CREATE TABLE tenant_users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email          text NOT NULL,
  name           text,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);
CREATE INDEX tenant_users_email_idx ON tenant_users (lower(email));

-- Einmal-Links (nur der SHA-256-Hash wird gespeichert)
CREATE TABLE login_tokens (
  token_hash  text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES tenant_users(id) ON DELETE CASCADE,
  next_path   text,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Angemeldete Sitzungen (Cookie enthält das Token, DB nur den Hash)
CREATE TABLE sessions (
  token_hash  text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES tenant_users(id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
