import { createApp } from './app.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { pool } from './db/pool.js';
import { purgeOldConversations } from './services/chat.js';

await migrate();

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`Empfang KI läuft auf ${config.publicUrl} (Port ${config.port}, LLM: ${config.llm.provider}/${config.llm.model})`);
});

// Datensparsamkeit: alte Gespräche täglich löschen
const purge = async () => {
  try {
    const n = await purgeOldConversations();
    if (n) console.log(`[retention] ${n} alte Gespräche gelöscht`);
  } catch (err) {
    console.error('[retention]', err.message);
  }
};
purge();
const timer = setInterval(purge, 24 * 60 * 60 * 1000);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    clearInterval(timer);
    server.close(() => pool.end().then(() => process.exit(0)));
  });
}
