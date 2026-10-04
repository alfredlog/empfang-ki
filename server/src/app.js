import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { ZodError } from 'zod';
import { pool } from './db/pool.js';
import { adminRouter } from './routes/admin.js';
import { publicRouter } from './routes/public.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const webDir = path.join(root, 'web');
const widgetDir = path.join(root, 'widget');

export function createApp() {
  const app = express();
  app.set('trust proxy', 1); // hinter Caddy
  app.disable('x-powered-by');

  app.use(
    helmet({
      // widget.js wird von fremden Websites geladen
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com'],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
        },
      },
    }),
  );
  app.use(express.json({ limit: '1mb' }));

  app.get('/healthz', async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  app.use('/api/v1', publicRouter);
  app.use('/api/admin', adminRouter);

  // Das einbettbare Widget
  app.get('/widget.js', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.sendFile(path.join(widgetDir, 'widget.js'));
  });

  // Gehostete Chat-Seite für Betriebe ohne eigene Website: /c/<slug>
  app.get('/c/:slug', (req, res) => res.sendFile(path.join(webDir, 'chat.html')));

  // Landing-Page & Demo-Seiten
  app.use(express.static(webDir, { extensions: ['html'], maxAge: '5m' }));

  app.use((req, res) => res.status(404).json({ error: 'not_found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ZodError) return res.status(400).json({ error: 'validation', issues: err.issues });
    if (err.code === '23505') return res.status(409).json({ error: 'conflict', detail: err.detail });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
    console.error(err);
    res.status(500).json({ error: 'internal' });
  });

  return app;
}
