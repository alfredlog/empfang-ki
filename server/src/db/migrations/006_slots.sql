-- Freie Termine, die der Betrieb im Dashboard einträgt und die der Assistent anbietet
CREATE TABLE appointment_slots (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  starts_at    timestamptz NOT NULL,
  duration_min integer NOT NULL DEFAULT 30 CHECK (duration_min BETWEEN 5 AND 480),
  note         text,
  lead_id      uuid REFERENCES leads(id) ON DELETE SET NULL,
  booked_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, starts_at)
);
CREATE INDEX appointment_slots_tenant_idx ON appointment_slots (tenant_id, starts_at);
