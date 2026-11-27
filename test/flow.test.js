import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { io as connect } from 'socket.io-client';
import { loadConfig } from '../src/config.js';
import { createServer } from '../src/server.js';

let server, base, events, config;
const KEY = 'test-key';

before(async () => {
  events = [];
  config = loadConfig({ TECH_API_KEY: KEY, PORT: '0' });
  server = createServer(config, { audit: (e, d) => events.push({ e, ...d }) });
  const { port } = await server.listen(0);
  base = `http://127.0.0.1:${port}`;
  config.publicUrl = base;
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

async function createSession() {
  const res = await api('/api/sessions', { key: KEY, body: { technician: 'ada' } });
  assert.equal(res.status, 201);
  return res.json();
}

test('creating a session requires the technician key', async () => {
  assert.equal((await api('/api/sessions', { key: 'wrong' })).status, 401);
  assert.equal((await api('/api/sessions')).status, 401);
});

test('join page is served without consuming the token', async () => {
  const { joinUrl } = await createSession();
  const page = await fetch(joinUrl);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  const token = joinUrl.split('/').pop();
  assert.equal((await api('/api/claim', { body: { token } })).status, 200);
});

test('full flow: claim, code, consent, signaling relay, end', async () => {
  const created = await createSession();
  const sessionId = created.session.id;
  const tech = sock({ sessionId, role: 'tech', token: created.techToken });
  const techReady = await once(tech, 'ready');
  assert.equal(techReady.session.state, 'created');
  assert.ok(Array.isArray(techReady.iceServers));

  // User clicks the link: agent claims it, technician is told the code.
  const techUpdate = once(tech, 'session:update');
  const claim = await (await api('/api/claim', {
    body: { token: created.joinUrl.split('/').pop(), agentInfo: { platform: 'windows', agent: 'test' } },
  })).json();
  assert.match(claim.code, /^\d{6}$/);
  const update = await techUpdate;
  assert.equal(update.state, 'claimed');
  assert.equal(update.code, claim.code);

  const agent = sock({ sessionId, role: 'agent', token: claim.agentToken });
  await once(agent, 'ready');

  // Before Allow, signals are dropped.
  let leaked = false;
  tech.once('signal', () => (leaked = true));
  agent.emit('signal', { type: 'offer', sdp: 'early' });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(leaked, false, 'signal relayed before consent');

  // User clicks Allow.
  const approved = once(tech, 'session:update');
  agent.emit('consent', { allow: true });
  assert.equal((await approved).state, 'approved');

  // Now offers and answers are relayed both ways.
  const gotOffer = once(tech, 'signal');
  agent.emit('signal', { type: 'offer', sdp: 'v=0' });
  assert.deepEqual(await gotOffer, { type: 'offer', sdp: 'v=0' });
  const gotAnswer = once(agent, 'signal');
  tech.emit('signal', { type: 'answer', sdp: 'v=0 answer' });
  assert.equal((await gotAnswer).type, 'answer');

  // The user presses Stop: both sides are told and disconnected.
  const techEnded = once(tech, 'session:ended');
  agent.emit('end');
  assert.equal((await techEnded).endReason, 'ended_by_user');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(tech.connected, false);

  // The ended session can no longer be joined.
  const late = sock({ sessionId, role: 'tech', token: created.techToken });
  const err = await once(late, 'connect_error');
  assert.equal(err.message, 'unauthorized');

  const kinds = events.filter((e) => e.sessionId === sessionId).map((e) => e.e);
  for (const k of ['session.created', 'session.claimed', 'session.approved', 'session.ended']) assert.ok(kinds.includes(k), k);
});

test('denying ends the session', async () => {
  const created = await createSession();
  const claim = await (await api('/api/claim', { body: { token: created.joinUrl.split('/').pop() } })).json();
  const tech = sock({ sessionId: created.session.id, role: 'tech', token: created.techToken });
  await once(tech, 'ready');
  const agent = sock({ sessionId: created.session.id, role: 'agent', token: claim.agentToken });
  await once(agent, 'ready');
  const ended = once(tech, 'session:ended');
  agent.emit('consent', { allow: false });
  assert.equal((await ended).endReason, 'denied_by_user');
});

test('a claimed link cannot be claimed again', async () => {
  const { joinUrl } = await createSession();
  const token = joinUrl.split('/').pop();
  assert.equal((await api('/api/claim', { body: { token } })).status, 200);
  assert.equal((await api('/api/claim', { body: { token } })).status, 404);
});

test('claim tells the agent who the technician is', async () => {
  const { joinUrl } = await createSession();
  const claim = await (await api('/api/claim', { body: { token: joinUrl.split('/').pop() } })).json();
  assert.equal(claim.technician, 'ada');
});

test('windows agent download is named after the link and does not use it up', async () => {
  const { joinUrl } = await createSession();
  const token = joinUrl.split('/').pop();

  assert.deepEqual(await (await fetch(`${base}/api/agents`)).json(), { windows: false });
  assert.equal((await fetch(`${base}/download/windows/${token}`)).status, 404);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nolt-agent-'));
  config.agentWindowsExe = path.join(dir, 'NoltSupport.exe');
  fs.writeFileSync(config.agentWindowsExe, 'MZ fake exe');
  try {
    assert.deepEqual(await (await fetch(`${base}/api/agents`)).json(), { windows: true });
    const dl = await fetch(`${base}/download/windows/${token}`);
    assert.equal(dl.status, 200);
    assert.match(dl.headers.get('content-disposition'), new RegExp(`filename="NoltSupport-${token}\\.exe"`));
    assert.equal(await dl.text(), 'MZ fake exe');
    assert.ok(events.some((e) => e.e === 'agent.downloaded'));

    // The app can still claim the session after the download...
    assert.equal((await api('/api/claim', { body: { token } })).status, 200);
    // ...after which the link no longer downloads.
    assert.equal((await fetch(`${base}/download/windows/${token}`)).status, 410);
    assert.equal((await fetch(`${base}/download/windows/not-a-token`)).status, 404);
  } finally {
    config.agentWindowsExe = '';
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
