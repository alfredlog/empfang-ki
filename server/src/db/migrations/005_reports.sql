-- Versandprotokoll der Monatsberichte (verhindert doppelten Versand)
CREATE TABLE report_log (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  month       date NOT NULL,
  recipients  text[] NOT NULL DEFAULT '{}',
  sent_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, month)
);
