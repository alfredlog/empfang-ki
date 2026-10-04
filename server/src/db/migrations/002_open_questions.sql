-- Fragen, die der Assistent nicht beantworten konnte ("Wissenslücken").
-- Werden im Dashboard angezeigt, damit der Kunde die Antwort ergänzen kann.
ALTER TABLE leads ADD COLUMN open_question text;
CREATE INDEX leads_open_question_idx ON leads (tenant_id, created_at DESC) WHERE open_question IS NOT NULL;
