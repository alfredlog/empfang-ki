import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { ZodError } from 'zod';
import { pool } from './db/pool.js';
import { adminRouter } from './routes/admin.js';
import { portalRouter } from './routes/portal.js';
import { SESSION_COOKIE, sessionCookieOptions, verifyLoginToken } from './services/auth.js';
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
          styleSrc: ["'self'", "'unsafe-inline'"],
          fontSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
        },
      },
    }),
  );
  // Admin-API zuerst einbinden: braucht ein höheres Limit für PDF-Uploads
  app.use('/api/admin', express.json({ limit: '30mb' }), adminRouter);
  app.use('/api/portal', express.json({ limit: '30mb' }), portalRouter);
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

  // Das einbettbare Widget
  app.get('/widget.js', (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.sendFile(path.join(widgetDir, 'widget.js'));
  });

  // Magic Link aus der Login-Mail einlösen → Sitzung starten → ins Dashboard
  app.get('/login/verify', async (req, res, next) => {
    try {
      const result = await verifyLoginToken(req.query.token);
      if (!result) return res.redirect(303, '/app/?login=abgelaufen');
      res.cookie(SESSION_COOKIE, result.sessionToken, sessionCookieOptions());
      res.redirect(303, result.next);
    } catch (err) { next(err); }
  });
  app.get('/login', (req, res) => res.redirect(301, '/app/'));

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
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'too_large', message: 'Die Datei ist zu groß.' });
    if (err.status && err.status < 500) return res.status(err.status).json({ error: 'request', message: err.message });
    console.error(err);
    res.status(500).json({ error: 'internal' });
  });

  return app;
}
