import pg from 'pg';
import { config } from '../config.js';

// DATE-Spalten als Text 'YYYY-MM-DD' lesen (sonst verschiebt die Zeitzone das Datum um einen Tag)
pg.types.setTypeParser(1082, (value) => value);

// Alle Datums-/Monatsgrenzen in deutscher Zeit auswerten (Sitzungs-Zeitzone der Verbindung)
export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10, options: '-c timezone=Europe/Berlin' });

export const query = (text, params) => pool.query(text, params);

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
