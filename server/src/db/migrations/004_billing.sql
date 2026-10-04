-- Abrechnung: Testphase, manuelle Zahlung (Überweisung/bar) oder Stripe-Abo.
ALTER TABLE tenants
  ADD COLUMN billing_status text NOT NULL DEFAULT 'active',  -- trial | active | past_due | canceled | expired | unpaid
  ADD COLUMN billing_method text,                            -- manual | stripe | NULL
  ADD COLUMN trial_ends_at timestamptz,
  ADD COLUMN paid_until date,                                -- bei manueller Zahlung
  ADD COLUMN stripe_customer_id text,
  ADD COLUMN stripe_subscription_id text;
-- Bestehende Kunden bleiben aktiv ('active'); neue Kunden starten in der Testphase (siehe Admin-API).
CREATE UNIQUE INDEX tenants_stripe_sub_idx ON tenants (stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;

-- Zahlungsverlauf (manuell und Stripe). stripe_event_id verhindert doppelte Verarbeitung von Webhooks.
CREATE TABLE billing_events (
  id               bigserial PRIMARY KEY,
  tenant_id        uuid REFERENCES tenants(id) ON DELETE CASCADE,
  source           text NOT NULL,     -- manual | stripe | system
  type             text NOT NULL,
  detail           jsonb NOT NULL DEFAULT '{}'::jsonb,
  stripe_event_id  text UNIQUE,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX billing_events_tenant_idx ON billing_events (tenant_id, created_at DESC);
