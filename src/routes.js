import express from 'express';
import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { publicSession } from './store.js';

export function apiRouter({ config, store, hub, audit }) {
  const r = express.Router();
  r.use(express.json({ limit: '16kb' }));

  const requireTech = (req, res, next) => {
    const header = req.get('authorization') || '';
    const key = header.startsWith('Bearer ') ? header.slice(7) : req.get('x-api-key') || '';
    const a = Buffer.from(key);
    const b = Buffer.from(config.techApiKey);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    // Phase 3: take the technician identity from the admin backend's JWT instead.
    req.technician = String(req.body?.technician || req.get('x-technician') || 'technician').slice(0, 120);
    next();
  };

  // Technician: create a session and get the link to send to the user.
  r.post('/sessions', requireTech, (req, res) => {
    const { session, joinToken } = store.create({ technician: req.technician });
    audit('session.created', { sessionId: session.id, technician: session.technician });
    res.status(201).json({
      session: publicSession(session),
      joinUrl: `${config.publicUrl}/join/${joinToken}`,
      techToken: session.techToken,
    });
  });

  r.get('/sessions/:id', requireTech, (req, res) => {
    const s = store.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not_found' });
    res.json({ session: publicSession(s) });
  });

  r.post('/sessions/:id/end', requireTech, (req, res) => {
    const s = store.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not_found' });
    hub.endSession(s.id, 'ended_by_technician');
    res.json({ session: publicSession(s) });
  });

  // Agent: exchange the one-time link token for an agent token and the 6-digit code.
  // Rate limited per IP so tokens cannot be brute-forced.
  const claimLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'too_many_attempts' },
  });
  r.post('/claim', claimLimiter, (req, res) => {
    const { token, agentInfo } = req.body || {};
    const result = store.claim(token, agentInfo);
    if (result.error) {
      audit('session.claim_failed', { reason: result.error, ip: req.ip });
      return res.status(result.error === 'already_used' ? 409 : 404).json({ error: result.error });
    }
    const s = result.session;
    audit('session.claimed', { sessionId: s.id, agentInfo: s.agentInfo, ip: req.ip });
    hub.sessionUpdated(s);
    res.json({ sessionId: s.id, agentToken: s.agentToken, code: s.code, expiresAt: s.expiresAt });
  });

  return r;
}
