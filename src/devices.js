import crypto from 'node:crypto';

const token = () => crypto.randomBytes(24).toString('base64url');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const clean = (s, max = 100) => String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);

/**
 * Registry of enrolled company devices (the unattended-access fleet).
 *
 * A device is enrolled once, at install time, using the shared company
 * enrollment key baked into the installer. It gets back a long-lived device
 * token which it stores on the machine and presents on every reconnect, so a
 * technician can reach it later without anyone clicking anything on the device.
 *
 * In-memory for now. Enrolled devices must survive a server restart in
 * production, so this is written to a small interface that a Postgres-backed
 * store can implement later without touching the routes or signaling.
 */
export class DeviceStore {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.devices = new Map(); // id -> device
    this.byTokenHash = new Map(); // sha256(deviceToken) -> id
  }

  /** Register a new device. Returns the device and its one-time-shown token. */
  enroll({ name, platform, version, hostname } = {}) {
    const id = crypto.randomUUID();
    const deviceToken = token();
    const t = this.now();
    const device = {
      id,
      name: clean(name) || clean(hostname) || 'Unnamed device',
      platform: clean(platform, 32) || 'windows',
      version: clean(version, 32),
      hostname: clean(hostname),
      tokenHash: sha(deviceToken),
      enrolledAt: t,
      lastSeen: t,
      online: false,
    };
    this.devices.set(id, device);
    this.byTokenHash.set(device.tokenHash, id);
    return { device, deviceToken };
  }

  get(id) {
    return this.devices.get(id) || null;
  }

  /** Newest first, so the admin list shows recently enrolled devices on top. */
  list() {
    return [...this.devices.values()].sort((a, b) => b.enrolledAt - a.enrolledAt);
  }

  /** Resolve a device by its long-lived token (used for the presence socket). */
  authenticate(deviceToken) {
    const id = this.byTokenHash.get(sha(String(deviceToken || '')));
    return id ? this.get(id) : null;
  }

  setOnline(id, online) {
    const d = this.get(id);
    if (!d) return null;
    d.online = online;
    d.lastSeen = this.now();
    return d;
  }

  rename(id, name) {
    const d = this.get(id);
    if (!d) return null;
    const next = clean(name);
    if (next) d.name = next;
    return d;
  }

  /** Unenroll a device: its token stops working immediately. */
  remove(id) {
    const d = this.devices.get(id);
    if (!d) return false;
    this.byTokenHash.delete(d.tokenHash);
    this.devices.delete(id);
    return true;
  }
}

/** The view of a device that is safe to send to a technician (no token hash). */
export function publicDevice(d) {
  return {
    id: d.id,
    name: d.name,
    platform: d.platform,
    version: d.version,
    hostname: d.hostname,
    enrolledAt: d.enrolledAt,
    lastSeen: d.lastSeen,
    online: d.online,
  };
}
