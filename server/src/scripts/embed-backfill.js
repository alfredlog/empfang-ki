// Berechnet alle fehlenden Embeddings der Wissensbasis (alle Kunden).
// Normalerweise nicht nötig – die App macht das beim Start automatisch im Hintergrund.
//   npm run embeddings:backfill
import { migrate } from '../db/migrate.js';
import { pool } from '../db/pool.js';
import { embedMissingChunks } from '../services/knowledge.js';

await migrate();
const n = await embedMissingChunks({ log: console.log });
console.log(n ? `Fertig: ${n} Abschnitte berechnet.` : 'Nichts zu tun (oder Embeddings nicht verfügbar).');
await pool.end();
