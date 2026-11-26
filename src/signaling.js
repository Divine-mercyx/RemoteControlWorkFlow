import { Server } from 'socket.io';
import { STATES, publicSession } from './store.js';
import { iceServers } from './turn.js';

const MAX_SIGNAL_BYTES = 64 * 1024;
const other = (role) => (role === 'tech' ? 'agent' : 'tech');
const room = (id, role) => (role ? `s:${id}:${role}` : `s:${id}`);

/**
 * WebRTC signaling over Socket.IO.
 *
 * Client connects with auth: { sessionId, role: 'tech' | 'agent', token }.
 * Server -> client: ready, session:update, peer:joined, peer:left, signal, session:ended
 * Client -> server: consent (agent only), signal, end
 *
 * The server only relays offers/answers/ICE candidates, and only after the user
 * approved the session. Screen video and input events travel peer-to-peer
 * (or through TURN), never through this server.
 */
export function createSignaling(httpServer, { config, store, audit }) {
  const io = new Server(httpServer, {
    cors: config.corsOrigins.length ? { origin: config.corsOrigins } : undefined,
    maxHttpBufferSize: MAX_SIGNAL_BYTES * 2,
  });

  const hub = {
    sessionUpdated(s) {
      io.to(room(s.id)).emit('session:update', publicSession(s));
    },
    endSession(id, reason) {
      const s = store.get(id);
      if (!s) return;
      const wasActive = s.state !== STATES.ENDED;
      store.end(id, s.endReason || reason);
      if (wasActive) audit('session.ended', { sessionId: id, reason: s.endReason });
      io.to(room(id)).emit('session:ended', publicSession(s));
      io.in(room(id)).disconnectSockets(true);
    },
  };

  io.use((socket, next) => {
    const { sessionId, role, token } = socket.handshake.auth || {};
    const s = store.authenticate(String(sessionId || ''), role, token);
    if (!s) return next(new Error('unauthorized'));
    socket.data.sessionId = s.id;
    socket.data.role = role;
    next();
  });

  io.on('connection', async (socket) => {
    const { sessionId: id, role } = socket.data;

    // One live connection per role: a reconnect replaces the stale socket.
    for (const old of await io.in(room(id, role)).fetchSockets()) {
      if (old.id !== socket.id) old.disconnect(true);
    }
    socket.join([room(id), room(id, role)]);

    const s = store.get(id);
    const peers = await io.in(room(id, other(role))).fetchSockets();
    socket.emit('ready', {
      session: publicSession(s),
      iceServers: iceServers(config, id),
      peerPresent: peers.length > 0,
    });
    socket.to(room(id, other(role))).emit('peer:joined', { role });
    audit('socket.connected', { sessionId: id, role });

    socket.on('consent', ({ allow } = {}) => {
      if (role !== 'agent') return;
      const cur = store.get(id);
      if (!cur || cur.state !== STATES.CLAIMED) return;
      if (allow === true) {
        store.approve(id);
        audit('session.approved', { sessionId: id });
        hub.sessionUpdated(cur);
      } else {
        audit('session.denied', { sessionId: id });
        hub.endSession(id, 'denied_by_user');
      }
    });

    socket.on('signal', (data) => {
      const cur = store.get(id);
      if (!cur || cur.state !== STATES.APPROVED) return; // no media before consent
      let size;
      try {
        size = Buffer.byteLength(JSON.stringify(data ?? null));
      } catch {
        return;
      }
      if (size > MAX_SIGNAL_BYTES) return;
      socket.to(room(id, other(role))).emit('signal', data);
    });

    socket.on('end', () => {
      hub.endSession(id, role === 'agent' ? 'ended_by_user' : 'ended_by_technician');
    });

    socket.on('disconnect', () => {
      socket.to(room(id, other(role))).emit('peer:left', { role });
      audit('socket.disconnected', { sessionId: id, role });
    });
  });

  return { io, hub };
}
