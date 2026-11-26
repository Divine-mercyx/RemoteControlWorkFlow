// Technician viewer: creates a session, receives the user's screen, sends input.
(() => {
  const $ = (id) => document.getElementById(id);
  const log = (msg) => {
    const line = document.createElement('div');
    line.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
    $('log').prepend(line);
  };
  const store = {
    get: (k) => { try { return sessionStorage.getItem(k) || ''; } catch { return ''; } },
    set: (k, v) => { try { sessionStorage.setItem(k, v); } catch {} },
  };

  $('apiKey').value = store.get('nolt.apiKey');
  $('techName').value = store.get('nolt.techName');

  let socket = null;
  let pc = null;
  let control = null;
  let session = null;
  let iceServers = [];

  function setStatus(state, cls = '') {
    $('status').textContent = state;
    $('status').className = `status ${cls}`;
  }

  function render(s) {
    session = s;
    const labels = {
      created: ['waiting for user to open the link', ''],
      claimed: ['user opened the link, waiting for Allow', ''],
      approved: ['approved, connecting…', 'ok'],
      ended: [`ended (${s.endReason || ''})`, 'bad'],
    };
    const [text, cls] = labels[s.state] || [s.state, ''];
    setStatus(text, cls);
    $('linkBox').classList.toggle('hidden', s.state !== 'created');
    $('codeBox').classList.toggle('hidden', !s.code);
    $('code').textContent = s.code ? `${s.code.slice(0, 3)} ${s.code.slice(3)}` : '';
    $('endBtn').disabled = s.state === 'ended';
  }

  $('newSession').onclick = async () => {
    $('setupError').classList.add('hidden');
    const apiKey = $('apiKey').value.trim();
    store.set('nolt.apiKey', apiKey);
    store.set('nolt.techName', $('techName').value.trim());
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ technician: $('techName').value.trim() || undefined }),
    });
    if (!res.ok) {
      $('setupError').textContent = res.status === 401 ? 'Wrong API key' : `Error ${res.status}`;
      $('setupError').classList.remove('hidden');
      return;
    }
    const data = await res.json();
    teardown();
    $('joinUrl').textContent = data.joinUrl;
    $('sessionPanel').classList.remove('hidden');
    $('viewerPanel').classList.add('hidden');
    render(data.session);
    log(`session ${data.session.id} created`);
    connect(data.session.id, data.techToken);
  };

  $('copyBtn').onclick = async () => {
    try {
      await navigator.clipboard.writeText($('joinUrl').textContent);
      $('copyBtn').textContent = 'Copied';
      setTimeout(() => ($('copyBtn').textContent = 'Copy'), 1500);
    } catch { /* clipboard blocked; the link is selectable */ }
  };

  $('endBtn').onclick = () => socket && socket.emit('end');

  function connect(sessionId, token) {
    socket = io({ auth: { sessionId, role: 'tech', token } });
    socket.on('connect_error', (e) => log(`connection error: ${e.message}`));
    socket.on('ready', (d) => { iceServers = d.iceServers; render(d.session); log('signaling connected'); });
    socket.on('session:update', (s) => {
      render(s);
      if (s.state === 'claimed') log(`user opened link (${s.agentInfo?.platform}, ${s.agentInfo?.agent})`);
      if (s.state === 'approved') log('user clicked Allow');
    });
    socket.on('peer:joined', () => log('user device connected'));
    socket.on('peer:left', () => log('user device disconnected'));
    socket.on('session:ended', (s) => { render(s); log(`session ended: ${s.endReason}`); closePeer(); });
    socket.on('signal', onSignal);
  }

  async function onSignal(msg) {
    if (msg.type === 'offer') {
      closePeer();
      pc = new RTCPeerConnection({ iceServers });
      pc.onicecandidate = (e) => e.candidate && socket.emit('signal', { type: 'candidate', candidate: e.candidate });
      pc.ontrack = (e) => {
        $('screen').srcObject = e.streams[0] || new MediaStream([e.track]);
        $('viewerPanel').classList.remove('hidden');
        setStatus('connected', 'ok');
        log('receiving screen');
      };
      pc.ondatachannel = (e) => {
        if (e.channel.label !== 'control') return;
        control = e.channel;
        control.onopen = () => log('control channel open');
        control.onmessage = (m) => log(`agent: ${m.data}`);
      };
      pc.onconnectionstatechange = () => {
        log(`peer connection: ${pc.connectionState}`);
        if (pc.connectionState === 'connected') showRoute();
      };
      await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('signal', { type: 'answer', sdp: answer.sdp });
    } else if (msg.type === 'candidate' && pc) {
      try { await pc.addIceCandidate(msg.candidate); } catch (e) { log(`ICE error: ${e.message}`); }
    }
  }

  // Show whether the connection is direct or relayed through TURN.
  async function showRoute() {
    try {
      const stats = await pc.getStats();
      let pair;
      stats.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId); });
      const local = pair && stats.get(pair.localCandidateId);
      $('route').textContent = local ? (local.candidateType === 'relay' ? '· via TURN relay' : '· direct') : '';
    } catch { /* stats are optional */ }
  }

  function closePeer() {
    if (pc) pc.close();
    pc = null;
    control = null;
    $('screen').srcObject = null;
  }

  function teardown() {
    closePeer();
    if (socket) socket.disconnect();
    socket = null;
  }

  // ---- Input capture -> control channel (protocol documented in README) ----
  const send = (msg) => control && control.readyState === 'open' && control.send(JSON.stringify(msg));
  const video = $('screen');

  // Map a pointer position to 0..1 coordinates of the remote screen, ignoring letterboxing.
  function norm(e) {
    const r = video.getBoundingClientRect();
    const vw = video.videoWidth || r.width;
    const vh = video.videoHeight || r.height;
    const scale = Math.min(r.width / vw, r.height / vh);
    const w = vw * scale, h = vh * scale;
    const x = (e.clientX - r.left - (r.width - w) / 2) / w;
    const y = (e.clientY - r.top - (r.height - h) / 2) / h;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x: +x.toFixed(4), y: +y.toFixed(4) };
  }

  let lastMove = 0;
  video.addEventListener('pointermove', (e) => {
    const now = performance.now();
    if (now - lastMove < 16) return; // ~60 per second
    lastMove = now;
    const p = norm(e);
    if (p) send({ t: 'mouse', a: 'move', ...p });
  });
  video.addEventListener('pointerdown', (e) => {
    video.focus();
    const p = norm(e);
    if (p) send({ t: 'mouse', a: 'down', b: e.button, ...p });
  });
  video.addEventListener('pointerup', (e) => {
    const p = norm(e);
    if (p) send({ t: 'mouse', a: 'up', b: e.button, ...p });
  });
  video.addEventListener('wheel', (e) => {
    e.preventDefault();
    send({ t: 'mouse', a: 'wheel', dx: Math.round(e.deltaX), dy: Math.round(e.deltaY) });
  }, { passive: false });
  video.addEventListener('contextmenu', (e) => e.preventDefault());
  for (const type of ['keydown', 'keyup']) {
    video.addEventListener(type, (e) => {
      if (!control) return;
      e.preventDefault();
      send({ t: 'key', a: type === 'keydown' ? 'down' : 'up', key: e.key, code: e.code,
             mods: { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey } });
    });
  }

  $('openUrlBtn').onclick = () => {
    const url = $('urlInput').value.trim();
    if (!/^https?:\/\//i.test(url)) return log('URL must start with http:// or https://');
    send({ t: 'cmd', name: 'open_url', url });
    log(`sent open_url ${url}`);
  };
  $('openAppBtn').onclick = () => {
    const app = $('appInput').value.trim();
    if (!app) return;
    send({ t: 'cmd', name: 'open_app', app });
    log(`sent open_app ${app}`);
  };
})();
