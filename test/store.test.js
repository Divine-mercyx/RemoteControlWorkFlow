import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore, STATES } from '../src/store.js';

const make = () => {
  let t = 1_000_000;
  const store = new SessionStore({ linkTtlMs: 600_000, sessionMaxMs: 7_200_000, now: () => t });
  return { store, advance: (ms) => (t += ms) };
};

test('a join token can be claimed exactly once', () => {
  const { store } = make();
  const { joinToken } = store.create({ technician: 'ada' });
  const first = store.claim(joinToken, { platform: 'windows' });
  assert.equal(first.session.state, STATES.CLAIMED);
  assert.match(first.session.code, /^\d{6}$/);
  assert.ok(first.session.agentToken);
  assert.equal(store.claim(joinToken).error, 'invalid_or_expired');
});

test('wrong tokens are rejected', () => {
  const { store } = make();
  store.create({ technician: 'ada' });
  assert.equal(store.claim('nope').error, 'invalid_or_expired');
  assert.equal(store.claim(undefined).error, 'invalid_or_expired');
});

test('an unclaimed link expires', () => {
  const { store, advance } = make();
  const { session, joinToken } = store.create({ technician: 'ada' });
  advance(600_001);
  assert.equal(store.claim(joinToken).error, 'invalid_or_expired');
  assert.equal(store.get(session.id).endReason, 'link_expired');
});

test('sessions hit the hard time limit', () => {
  const { store, advance } = make();
  const { session, joinToken } = store.create({ technician: 'ada' });
  store.claim(joinToken);
  store.approve(session.id);
  advance(7_200_001);
  const ended = store.sweep();
  assert.deepEqual(ended.map((s) => s.id), [session.id]);
  assert.equal(ended[0].endReason, 'session_expired');
});

test('approve only works after a claim', () => {
  const { store } = make();
  const { session, joinToken } = store.create({ technician: 'ada' });
  assert.equal(store.approve(session.id), null);
  store.claim(joinToken);
  assert.equal(store.approve(session.id).state, STATES.APPROVED);
});

test('socket authentication checks role and token', () => {
  const { store } = make();
  const { session, joinToken } = store.create({ technician: 'ada' });
  assert.ok(store.authenticate(session.id, 'tech', session.techToken));
  assert.equal(store.authenticate(session.id, 'agent', session.techToken), null);
  const { session: claimed } = store.claim(joinToken);
  assert.ok(store.authenticate(session.id, 'agent', claimed.agentToken));
  assert.equal(store.authenticate(session.id, 'tech', 'x'), null);
  store.end(session.id, 'done');
  assert.equal(store.authenticate(session.id, 'tech', session.techToken), null);
});

test('active codes are unique', () => {
  const { store } = make();
  const codes = new Set();
  for (let i = 0; i < 500; i++) {
    const { joinToken } = store.create({ technician: 't' });
    codes.add(store.claim(joinToken).session.code);
  }
  assert.equal(codes.size, 500);
});
