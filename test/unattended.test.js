import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { loadConfig } from '../src/config.js';
import { createServer } from '../src/server.js';

let server, base, events;
const KEY = 'test-key';
const ENROLL = 'test-enroll-key';

before(async () => {
  events = [];
  const config = loadConfig({ TECH_API_KEY: KEY, COMPANY_ENROLLMENT_KEY: ENROLL, PORT: '0' });
  server = createServer(config, { audit: (e, d) => events.push({ e, ...d }) });
  const { port } = await server.listen(0);
  base = `http://127.0.0.1:${port}`;
});
after(() => server.close());

const api = (path, { key, body, method = 'POST' } = {}) =>
  fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

const once = (socket, event) => new Promise((resolve) => socket.once(event, resolve));
const sock = (auth) => connect(base, { auth, transports: ['websocket'], reconnection: false });

async function enroll(name) {
  const res = await api('/api/devices/enroll', { body: { enrollmentKey: ENROLL, name, platform: 'windows', version: '0.3.0' } });
  assert.equal(res.status, 201);
  return res.json();
}

test('enrollment requires the company key', async () => {
  assert.equal((await api('/api/devices/enroll', { body: { enrollmentKey: 'nope', name: 'x' } })).status, 401);
  assert.equal((await api('/api/devices/enroll', { body: { name: 'x' } })).status, 401);
});

test('listing devices requires the technician key', async () => {
  assert.equal((await api('/api/devices', { method: 'GET' })).status, 401);
  assert.equal((await api('/api/devices', { method: 'GET', key: 'wrong' })).status, 401);
});

test('an enrolled device shows online once its presence socket connects', async () => {
  const { device, deviceToken } = await enroll('Reception PC');

  let listed = await (await api('/api/devices', { method: 'GET', key: KEY })).json();
  let row = listed.devices.find((d) => d.id === device.id);
  assert.equal(row.online, false);
  assert.equal(row.name, 'Reception PC');

  const presence = sock({ role: 'device', deviceToken });
  await once(presence, 'ready');
  // Give the server a moment to record presence.
  await new Promise((r) => setTimeout(r, 50));

  listed = await (await api('/api/devices', { method: 'GET', key: KEY })).json();
  assert.equal(listed.devices.find((d) => d.id === device.id).online, true);

  presence.disconnect();
  await new Promise((r) => setTimeout(r, 80));
  listed = await (await api('/api/devices', { method: 'GET', key: KEY })).json();
  assert.equal(listed.devices.find((d) => d.id === device.id).online, false);
});

test('a bad device token is rejected by the presence socket', async () => {
  const s = sock({ role: 'device', deviceToken: 'bogus' });
  assert.equal((await once(s, 'connect_error')).message, 'unauthorized');
});

test('technician connects to an online device; it auto-approves with no click', async () => {
  const { device, deviceToken } = await enroll('Workshop laptop');
  const presence = sock({ role: 'device', deviceToken });
  await once(presence, 'ready');

  // The device is told to start a session the instant the technician connects.
  const startP = once(presence, 'session:start');
  const connectRes = await (await api(`/api/devices/${device.id}/connect`, { key: KEY, body: { technician: 'ada' } })).json();
  assert.equal(connectRes.deviceOnline, true);
  assert.equal(connectRes.session.unattended, true);
  assert.equal(connectRes.session.deviceId, device.id);

  const start = await startP;
  assert.equal(start.sessionId, connectRes.session.id);
  assert.ok(start.agentToken);
  assert.ok(Array.isArray(start.iceServers));

  // Technician joins with its token; agent joins with the pushed token.
  const tech = sock({ sessionId: start.sessionId, role: 'tech', token: connectRes.techToken });
  await once(tech, 'ready');
  const approved = once(tech, 'session:update');
  const agent = sock({ sessionId: start.sessionId, role: 'agent', token: start.agentToken });
  await once(agent, 'ready');

  // No consent was sent; the session is approved because the device is enrolled.
  assert.equal((await approved).state, 'approved');

  // Signaling now relays in both directions.
  const gotOffer = once(tech, 'signal');
  agent.emit('signal', { type: 'offer', sdp: 'v=0' });
  assert.equal((await gotOffer).type, 'offer');

  assert.ok(events.some((e) => e.e === 'session.approved' && e.unattended === true));
  tech.disconnect();
  agent.disconnect();
  presence.disconnect();
});

test('connecting to an offline device still creates the session for when it returns', async () => {
  const { device } = await enroll('Offline PC');
  const res = await (await api(`/api/devices/${device.id}/connect`, { key: KEY, body: { technician: 'ada' } })).json();
  assert.equal(res.deviceOnline, false);
  assert.equal(res.session.unattended, true);
});

test('connecting to an unknown device is a 404', async () => {
  assert.equal((await api('/api/devices/does-not-exist/connect', { key: KEY })).status, 404);
});

test('a removed device can no longer connect its presence socket', async () => {
  const { device, deviceToken } = await enroll('Temp');
  assert.equal((await api(`/api/devices/${device.id}`, { method: 'DELETE', key: KEY })).status, 200);
  const s = sock({ role: 'device', deviceToken });
  assert.equal((await once(s, 'connect_error')).message, 'unauthorized');
});
