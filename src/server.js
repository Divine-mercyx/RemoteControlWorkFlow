import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { SessionStore } from './store.js';
import { createSignaling } from './signaling.js';
import { apiRouter } from './routes.js';
import { createAudit } from './audit.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createServer(config, { audit = createAudit(), now } = {}) {
  const store = new SessionStore({ linkTtlMs: config.linkTtlMs, sessionMaxMs: config.sessionMaxMs, now });
  const app = express();
  const httpServer = http.createServer(app);
  const { io, hub } = createSignaling(httpServer, { config, store, audit });

  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      // Join links carry a secret token: never leak it via the Referer header.
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
    });
    const origin = req.get('origin');
    if (origin && config.corsOrigins.includes(origin)) {
      res.set({
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Api-Key, X-Technician',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        Vary: 'Origin',
      });
      if (req.method === 'OPTIONS') return res.sendStatus(204);
    }
    next();
  });

  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.use('/api', apiRouter({ config, store, hub, audit }));

  // The link the user clicks. Opening it does NOT use up the token (link previews in
  // WhatsApp/SMS would otherwise burn it); the token is claimed when the user acts.
  app.get('/join/:token', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(publicDir, 'join.html'));
  });
  app.get('/', (_req, res) => res.redirect('/tech.html'));
  app.use(express.static(publicDir, { index: false }));

  const sweeper = setInterval(() => {
    for (const s of store.sweep()) {
      audit('session.ended', { sessionId: s.id, reason: s.endReason });
      hub.endSession(s.id, s.endReason);
    }
  }, 15_000);
  sweeper.unref();

  return {
    app,
    httpServer,
    io,
    store,
    listen(port = config.port) {
      return new Promise((resolve) => httpServer.listen(port, () => resolve(httpServer.address())));
    },
    async close() {
      clearInterval(sweeper);
      io.close();
      await new Promise((resolve) => httpServer.close(() => resolve()));
    },
  };
}
