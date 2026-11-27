import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeviceStore, publicDevice } from '../src/devices.js';

const make = () => {
  let t = 1_000_000;
  return { store: new DeviceStore({ now: () => t }), advance: (ms) => (t += ms) };
};

test('enroll returns a device and a one-time token', () => {
  const { store } = make();
  const { device, deviceToken } = store.enroll({ name: 'Reception PC', platform: 'windows', version: '0.3.0', hostname: 'NOLT-01' });
  assert.match(deviceToken, /^[A-Za-z0-9_-]+$/);
  assert.equal(device.name, 'Reception PC');
  assert.equal(device.online, false);
  // The token itself is never stored, only its hash.
  assert.equal(publicDevice(device).tokenHash, undefined);
  assert.ok(!('tokenHash' in publicDevice(device)));
});

test('a device authenticates with its token and nothing else', () => {
  const { store } = make();
  const { device, deviceToken } = store.enroll({ name: 'A' });
  assert.equal(store.authenticate(deviceToken)?.id, device.id);
  assert.equal(store.authenticate('wrong'), null);
  assert.equal(store.authenticate(''), null);
  assert.equal(store.authenticate(undefined), null);
});

test('name falls back to hostname then a placeholder', () => {
  const { store } = make();
  assert.equal(store.enroll({ hostname: 'HOST-9' }).device.name, 'HOST-9');
  assert.equal(store.enroll({}).device.name, 'Unnamed device');
});

test('control characters are stripped from enrolled fields', () => {
  const { store } = make();
  const { device } = store.enroll({ name: 'Front\u0000 Desk\n', platform: 'win\u0007dows' });
  assert.equal(device.name, 'Front Desk');
  assert.equal(device.platform, 'windows');
});

test('presence and lastSeen update', () => {
  const { store, advance } = make();
  const { device } = store.enroll({ name: 'A' });
  advance(5000);
  store.setOnline(device.id, true);
  assert.equal(store.get(device.id).online, true);
  assert.equal(store.get(device.id).lastSeen, 1_005_000);
});

test('rename keeps the old name when given nothing usable', () => {
  const { store } = make();
  const { device } = store.enroll({ name: 'Old' });
  assert.equal(store.rename(device.id, 'New').name, 'New');
  assert.equal(store.rename(device.id, '   ').name, 'New');
  assert.equal(store.rename('nope', 'x'), null);
});

test('removing a device revokes its token immediately', () => {
  const { store } = make();
  const { device, deviceToken } = store.enroll({ name: 'A' });
  assert.equal(store.remove(device.id), true);
  assert.equal(store.authenticate(deviceToken), null);
  assert.equal(store.get(device.id), null);
  assert.equal(store.remove(device.id), false);
});

test('list is newest first', () => {
  const { store, advance } = make();
  const a = store.enroll({ name: 'A' }).device;
  advance(10);
  const b = store.enroll({ name: 'B' }).device;
  assert.deepEqual(store.list().map((d) => d.id), [b.id, a.id]);
});
