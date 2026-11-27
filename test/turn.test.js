import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { iceServers } from '../src/turn.js';

const cfg = (env) => loadConfig({ TECH_API_KEY: 'k', ...env });
const URLS = 'turn:relay.example.com:3478,turns:relay.example.com:443?transport=tcp';

test('no TURN settings: STUN only', () => {
  const servers = iceServers(cfg({}));
  assert.equal(servers.length, 1);
  assert.ok(servers[0].urls[0].startsWith('stun:'));
});

test('fixed username and password from a hosted relay are passed through', () => {
  const servers = iceServers(cfg({ TURN_URLS: URLS, TURN_USERNAME: 'user1', TURN_CREDENTIAL: 'pass1' }));
  assert.deepEqual(servers[1], { urls: URLS.split(','), username: 'user1', credential: 'pass1' });
});

test('a username without a password adds no TURN server', () => {
  assert.equal(iceServers(cfg({ TURN_URLS: URLS, TURN_USERNAME: 'user1' })).length, 1);
  assert.equal(iceServers(cfg({ TURN_USERNAME: 'u', TURN_CREDENTIAL: 'p' })).length, 1);
});

test('coturn secret produces time-limited credentials and wins over fixed ones', () => {
  const servers = iceServers(cfg({ TURN_URLS: URLS, TURN_SECRET: 's3cret', TURN_USERNAME: 'u', TURN_CREDENTIAL: 'p' }), 'sess1');
  const { username, credential } = servers[1];
  assert.match(username, /^\d+:sess1$/);
  assert.equal(credential, crypto.createHmac('sha1', 's3cret').update(username).digest('base64'));
  assert.ok(Number(username.split(':')[0]) > Date.now() / 1000);
});
