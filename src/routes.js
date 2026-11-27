import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import rateLimit from 'express-rate-limit';
import { publicSession } from './store.js';
import { publicDevice } from './devices.js';

const safeKeyEqual = (presented, expected) => {
  const a = Buffer.from(String(presented || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

export function apiRouter({ config, store, deviceStore, hub, audit }) {
  const r = express.Router();
  r.use(express.json({ limit: '16kb' }));

  const requireTech = (req, res, next) => {
    const header = req.get('authorization') || '';
    const key = header.startsWith('Bearer ') ? header.slice(7) : req.get('x-api-key') || '';
    if (!safeKeyEqual(key, config.techApiKey)) {
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
    res.json({
      sessionId: s.id,
      agentToken: s.agentToken,
      code: s.code,
      technician: s.technician,
      expiresAt: s.expiresAt,
    });
  });

  // Which native agents this server can hand out (the join page uses this).
  r.get('/agents', (_req, res) => {
    res.json({ windows: agentAvailable(config.agentWindowsExe) });
  });

  // ---- Unattended access: enrolled company devices ----

  // Device self-enrolls at install time with the shared company key.
  // Rate limited so a leaked key can't be used to mass-enroll quickly.
  const enrollLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });
  r.post('/devices/enroll', enrollLimiter, (req, res) => {
    if (!config.companyEnrollmentKey) return res.status(404).json({ error: 'enrollment_disabled' });
    const { enrollmentKey, name, platform, version, hostname } = req.body || {};
    if (!safeKeyEqual(enrollmentKey, config.companyEnrollmentKey)) {
      audit('device.enroll_rejected', { ip: req.ip });
      return res.status(401).json({ error: 'invalid_enrollment_key' });
    }
    const { device, deviceToken } = deviceStore.enroll({ name, platform, version, hostname });
    audit('device.enrolled', { deviceId: device.id, name: device.name, ip: req.ip });
    res.status(201).json({ device: publicDevice(device), deviceToken });
  });

  // Technician: list the fleet, newest first, with online status.
  r.get('/devices', requireTech, (_req, res) => {
    res.json({ devices: deviceStore.list().map(publicDevice) });
  });

  r.patch('/devices/:id', requireTech, (req, res) => {
    const d = deviceStore.rename(req.params.id, req.body?.name);
    if (!d) return res.status(404).json({ error: 'not_found' });
    res.json({ device: publicDevice(d) });
  });

  // Unenroll a device: its token stops working at once.
  r.delete('/devices/:id', requireTech, (req, res) => {
    if (!deviceStore.remove(req.params.id)) return res.status(404).json({ error: 'not_found' });
    audit('device.removed', { deviceId: req.params.id });
    res.json({ ok: true });
  });

  // Technician: start an unattended session to an enrolled device. If the
  // device is online, it is told to connect now; no click on the device.
  r.post('/devices/:id/connect', requireTech, (req, res) => {
    const device = deviceStore.get(req.params.id);
    if (!device) return res.status(404).json({ error: 'not_found' });
    const session = store.createUnattended({ technician: req.technician, device });
    audit('session.created', { sessionId: session.id, technician: session.technician, deviceId: device.id, unattended: true });
    if (device.online) hub.startOnDevice(device.id, session);
    res.status(201).json({
      session: publicSession(session),
      techToken: session.techToken,
      deviceOnline: device.online,
    });
  });

  return r;
}

export function agentAvailable(file) {
  try {
    return Boolean(file) && fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** GET /download/windows/:token — the agent, named after the session's link token. */
export function downloadRouter({ config, store, audit }) {
  const r = express.Router();
  const limiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });
  r.get('/windows/:token', limiter, (req, res) => {
    const { token } = req.params;
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) return res.status(404).send('Link not found');
    if (!agentAvailable(config.agentWindowsExe)) return res.status(404).send('The Windows app is not available yet');
    const s = store.peek(token);
    if (!s) return res.status(410).send('This support link has expired or was already used. Ask the technician for a new one.');
    audit('agent.downloaded', { sessionId: s.id, platform: 'windows', ip: req.ip });
    res.set('Cache-Control', 'no-store');
    res.download(config.agentWindowsExe, `NoltSupport-${token}.exe`);
  });
  return r;
}
