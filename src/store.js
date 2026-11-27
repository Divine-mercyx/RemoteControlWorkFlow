import crypto from 'node:crypto';

// Session lifecycle:
//   created  -> link sent, waiting for the user to open it
//   claimed  -> agent opened the link; 6-digit code shown on both sides
//   approved -> user clicked Allow; WebRTC signaling is permitted
//   ended    -> stopped by either side, expired, or denied
export const STATES = Object.freeze({
  CREATED: 'created',
  CLAIMED: 'claimed',
  APPROVED: 'approved',
  ENDED: 'ended',
});

const token = () => crypto.randomBytes(24).toString('base64url');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/**
 * In-memory session store. Fine for a single instance.
 * Phase 3: swap for a Redis-backed store (same interface) to run several instances.
 */
export class SessionStore {
  constructor({ linkTtlMs, sessionMaxMs, now = () => Date.now() }) {
    this.linkTtlMs = linkTtlMs;
    this.sessionMaxMs = sessionMaxMs;
    this.now = now;
    this.sessions = new Map(); // id -> session
    this.byJoinHash = new Map(); // sha256(joinToken) -> id
  }

  create({ technician }) {
    const id = crypto.randomUUID();
    const joinToken = token();
    const techToken = token();
    const t = this.now();
    const s = {
      id,
      technician,
      state: STATES.CREATED,
      createdAt: t,
      linkExpiresAt: t + this.linkTtlMs,
      expiresAt: t + this.sessionMaxMs,
      joinHash: sha(joinToken),
      techToken,
      agentToken: null,
      code: null,
      agentInfo: null,
      claimedAt: null,
      approvedAt: null,
      endedAt: null,
      endReason: null,
    };
    this.sessions.set(id, s);
    this.byJoinHash.set(s.joinHash, id);
    return { session: s, joinToken };
  }

  get(id) {
    const s = this.sessions.get(id);
    if (s) this.#expireIfNeeded(s);
    return s || null;
  }

  /** Look up an unused, unexpired link without using it up. */
  peek(joinToken) {
    const id = this.byJoinHash.get(sha(String(joinToken || '')));
    const s = id && this.get(id);
    return s && s.state === STATES.CREATED ? s : null;
  }

  /** Agent exchanges the one-time join token for an agent token + code. */
  claim(joinToken, agentInfo = {}) {
    const id = this.byJoinHash.get(sha(String(joinToken || '')));
    const s = id && this.get(id);
    if (!s || s.state === STATES.ENDED) return { error: 'invalid_or_expired' };
    if (s.state !== STATES.CREATED) return { error: 'already_used' };
    // One-time: the link cannot be claimed again.
    this.byJoinHash.delete(s.joinHash);
    s.state = STATES.CLAIMED;
    s.claimedAt = this.now();
    s.agentToken = token();
    s.code = this.#uniqueCode();
    s.agentInfo = {
      platform: String(agentInfo.platform || 'unknown').slice(0, 64),
      agent: String(agentInfo.agent || 'unknown').slice(0, 64),
      version: String(agentInfo.version || '').slice(0, 32),
    };
    return { session: s };
  }

  approve(id) {
    const s = this.get(id);
    if (!s || s.state !== STATES.CLAIMED) return null;
    s.state = STATES.APPROVED;
    s.approvedAt = this.now();
    return s;
  }

  end(id, reason) {
    const s = this.sessions.get(id);
    if (!s || s.state === STATES.ENDED) return s || null;
    s.state = STATES.ENDED;
    s.endedAt = this.now();
    s.endReason = reason;
    s.code = null;
    this.byJoinHash.delete(s.joinHash);
    return s;
  }

  /** Check a role/token pair for a socket connection. */
  authenticate(id, role, presented) {
    const s = this.get(id);
    if (!s || s.state === STATES.ENDED) return null;
    const expected = role === 'tech' ? s.techToken : role === 'agent' ? s.agentToken : null;
    if (!expected || !presented || !safeEqual(expected, presented)) return null;
    return s;
  }

  /** Expire stale sessions; returns the ones that just ended so callers can notify peers. */
  sweep() {
    const ended = [];
    for (const s of this.sessions.values()) {
      const before = s.state;
      this.#expireIfNeeded(s);
      if (before !== STATES.ENDED && s.state === STATES.ENDED) ended.push(s);
      // Forget ended sessions after an hour.
      if (s.state === STATES.ENDED && this.now() - s.endedAt > 3600_000) this.sessions.delete(s.id);
    }
    return ended;
  }

  #expireIfNeeded(s) {
    if (s.state === STATES.ENDED) return;
    const t = this.now();
    if (s.state === STATES.CREATED && t > s.linkExpiresAt) this.end(s.id, 'link_expired');
    else if (t > s.expiresAt) this.end(s.id, 'session_expired');
  }

  #uniqueCode() {
    const active = new Set();
    for (const s of this.sessions.values()) if (s.code) active.add(s.code);
    for (let i = 0; i < 50; i++) {
      const c = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
      if (!active.has(c)) return c;
    }
    throw new Error('could not allocate a unique code');
  }
}

/** The view of a session that is safe to send to the technician. */
export function publicSession(s) {
  return {
    id: s.id,
    state: s.state,
    code: s.code,
    agentInfo: s.agentInfo,
    createdAt: s.createdAt,
    linkExpiresAt: s.linkExpiresAt,
    expiresAt: s.expiresAt,
    claimedAt: s.claimedAt,
    approvedAt: s.approvedAt,
    endedAt: s.endedAt,
    endReason: s.endReason,
  };
}
