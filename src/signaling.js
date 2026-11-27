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
export function createSignaling(httpServer, { config, store, deviceStore, audit }) {
  const io = new Server(httpServer, {
    cors: config.corsOrigins.length ? { origin: config.corsOrigins } : undefined,
    maxHttpBufferSize: MAX_SIGNAL_BYTES * 2,
  });

  const deviceRoom = (deviceId) => `d:${deviceId}`;

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
    /** Tell an online enrolled device to start an unattended session now. */
    startOnDevice(deviceId, session) {
      io.to(deviceRoom(deviceId)).emit('session:start', {
        sessionId: session.id,
        agentToken: session.agentToken,
        technician: session.technician,
        iceServers: iceServers(config, session.id),
      });
    },
  };

  io.use((socket, next) => {
    const auth = socket.handshake.auth || {};
    // An enrolled device keeps one persistent presence connection.
    if (auth.role === 'device') {
      const device = deviceStore?.authenticate(auth.deviceToken);
      if (!device) return next(new Error('unauthorized'));
      socket.data.role = 'device';
      socket.data.deviceId = device.id;
      return next();
    }
    const s = store.authenticate(String(auth.sessionId || ''), auth.role, auth.token);
    if (!s) return next(new Error('unauthorized'));
    socket.data.sessionId = s.id;
    socket.data.role = auth.role;
    next();
  });

  io.on('connection', async (socket) => {
    const { role } = socket.data;

    if (role === 'device') {
      const deviceId = socket.data.deviceId;
      // One live presence connection per device.
      for (const old of await io.in(deviceRoom(deviceId)).fetchSockets()) {
        if (old.id !== socket.id) old.disconnect(true);
      }
      socket.join(deviceRoom(deviceId));
      deviceStore.setOnline(deviceId, true);
      audit('device.online', { deviceId });
      socket.emit('ready', { role: 'device' });
      socket.on('disconnect', async () => {
        const live = await io.in(deviceRoom(deviceId)).fetchSockets();
        if (live.every((x) => x.id === socket.id)) {
          deviceStore.setOnline(deviceId, false);
          audit('device.offline', { deviceId });
        }
      });
      return;
    }

    const id = socket.data.sessionId;

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

    // Unattended sessions carry their consent from enrollment: approve as soon
    // as the enrolled agent joins, with no per-session click on the device.
    if (role === 'agent' && s && s.unattended && s.state === STATES.CLAIMED) {
      store.approve(id);
      audit('session.approved', { sessionId: id, unattended: true });
      hub.sessionUpdated(store.get(id));
    }

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
