-- Gründerpreis: die ersten zehn zahlenden Kunden behalten ihren Preis zwölf Monate ab Vertragsbeginn
ALTER TABLE tenants
  ADD COLUMN founder_since date,
  ADD COLUMN founder_notice_sent_at timestamptz,
  ADD COLUMN founder_end_notified_at timestamptz;
