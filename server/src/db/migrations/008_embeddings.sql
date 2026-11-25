-- Semantische Suche: jeder Wissensabschnitt bekommt ein Embedding (384 Zahlen, Modell multilingual-e5-small).
-- Gespeichert als real[] direkt in PostgreSQL. Die Ähnlichkeitssuche läuft in der App (exakte Suche):
-- Wissensbasen kleiner Betriebe haben selten mehr als ein paar tausend Abschnitte, das dauert nur Millisekunden.
-- Bei sehr großen Datenmengen wäre der nächste Schritt pgvector mit einem HNSW-Index (Näherungssuche).
-- NULL = noch nicht berechnet; wird beim Start der App automatisch nachgeholt.
ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS embedding real[];
