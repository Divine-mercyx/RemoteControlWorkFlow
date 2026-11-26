// Browser agent (view-only). Phase 2's native agent follows the same protocol
// and additionally executes the input messages it receives on the control channel.
(() => {
  const $ = (id) => document.getElementById(id);
  const show = (id) => {
    for (const p of ['startPanel', 'consentPanel', 'activePanel', 'donePanel']) $(p).classList.toggle('hidden', p !== id);
  };
  const fail = (msg) => { $('error').textContent = msg; $('error').classList.remove('hidden'); };

  const joinToken = decodeURIComponent(location.pathname.split('/').pop() || '');
  const saved = (() => { try { return JSON.parse(sessionStorage.getItem(`nolt.join.${joinToken}`) || 'null'); } catch { return null; } })();
  const remember = (v) => { try { sessionStorage.setItem(`nolt.join.${joinToken}`, JSON.stringify(v)); } catch {} };

  const platform = (() => {
    const ua = navigator.userAgent;
    if (/Windows/i.test(ua)) return 'windows';
    if (/Android/i.test(ua)) return 'android';
    if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
    if (/Mac/i.test(ua)) return 'macos';
    if (/Linux/i.test(ua)) return 'linux';
    return 'unknown';
  })();
  const canShare = !!navigator.mediaDevices?.getDisplayMedia;
  if (!canShare) {
    $('downloadNote').textContent = platform === 'ios' || platform === 'android'
      ? 'Screen sharing from a phone browser is not supported yet. Please open this link on a computer.'
      : 'This browser cannot share the screen. Please use Chrome, Edge or Firefox.';
    $('startBtn').disabled = true;
  } else {
    $('downloadNote').textContent = 'The Nolt Support app for full remote control is coming soon.';
  }

  let socket = null;
  let pc = null;
  let stream = null;
  let iceServers = [];
  let state = null;

  $('startBtn').onclick = async () => {
    $('startBtn').disabled = true;
    try {
      const res = await fetch('/api/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: joinToken, agentInfo: { platform, agent: 'browser', version: '0.1.0' } }),
      });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({}));
        throw new Error(error === 'already_used' ? 'This link has already been used. Ask the technician for a new one.'
          : error === 'too_many_attempts' ? 'Too many attempts. Please wait a few minutes.'
          : 'This link has expired. Ask the technician for a new one.');
      }
      const data = await res.json();
      remember({ sessionId: data.sessionId, agentToken: data.agentToken, code: data.code });
      begin(data);
    } catch (e) {
      $('startBtn').disabled = false;
      fail(e.message);
    }
  };

  function begin({ sessionId, agentToken, code }) {
    $('code').textContent = `${code.slice(0, 3)} ${code.slice(3)}`;
    show('consentPanel');
    socket = io({ auth: { sessionId, role: 'agent', token: agentToken } });
    socket.on('connect_error', (e) => {
      if (e.message === 'unauthorized') { socket.disconnect(); finish('This support session has ended.'); }
      else fail('Connection problem. Retrying…');
    });
    socket.on('connect', () => $('error').classList.add('hidden'));
    socket.on('ready', (d) => { iceServers = d.iceServers; state = d.session.state; });
    socket.on('session:update', (s) => {
      const was = state;
      state = s.state;
      if (s.state === 'approved' && was !== 'approved') startPeer();
    });
    // The technician reconnected (e.g. refreshed the page): send a fresh offer.
    socket.on('peer:joined', () => { if (state === 'approved' && stream) startPeer(); });
    socket.on('signal', onSignal);
    socket.on('session:ended', (s) => finish(s.endReason === 'denied_by_user' ? 'You declined the request.' : 'The support session has ended.'));
  }

  $('allowBtn').onclick = async () => {
    try {
      // Must run inside the click so the browser allows the screen picker.
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
    } catch {
      return fail('Screen sharing was cancelled. Click Allow to try again, or Deny.');
    }
    $('error').classList.add('hidden');
    stream.getVideoTracks()[0].addEventListener('ended', () => stop());
    // After a page reload the session may already be approved: just reconnect the video.
    if (state === 'approved') startPeer(); else socket.emit('consent', { allow: true });
    $('banner').classList.remove('hidden');
    show('activePanel');
  };
  $('denyBtn').onclick = () => socket.emit('consent', { allow: false });
  $('stopBtn').onclick = () => stop();

  async function startPeer() {
    if (!stream) return;
    if (pc) pc.close();
    pc = new RTCPeerConnection({ iceServers });
    for (const track of stream.getTracks()) pc.addTrack(track, stream);
    const control = pc.createDataChannel('control', { ordered: true });
    control.onopen = () => control.send(JSON.stringify({ t: 'hello', agent: 'browser', control: false }));
    control.onmessage = (m) => handleInput(m.data);
    pc.onicecandidate = (e) => e.candidate && socket.emit('signal', { type: 'candidate', candidate: e.candidate });
    pc.onconnectionstatechange = () => {
      $('status').textContent = pc.connectionState === 'connected' ? 'sharing' : pc.connectionState;
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('signal', { type: 'offer', sdp: offer.sdp });
  }

  async function onSignal(msg) {
    if (!pc) return;
    if (msg.type === 'answer') await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
    else if (msg.type === 'candidate') { try { await pc.addIceCandidate(msg.candidate); } catch {} }
  }

  // A browser cannot move the mouse or press keys, so it only shows what arrived.
  // The native agent turns these messages into real input.
  let shown = 0;
  function handleInput(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.t === 'mouse' && msg.a === 'move') return;
    if (++shown > 50) $('inputLog').lastChild?.remove();
    const line = document.createElement('div');
    line.textContent = msg.t === 'cmd' ? `Technician asked to ${msg.name.replace('_', ' ')}: ${msg.url || msg.app}`
      : `Technician input: ${msg.t} ${msg.a}${msg.key ? ' ' + msg.key : ''}`;
    $('inputLog').prepend(line);
  }

  function stop() {
    if (socket) socket.emit('end');
    finish('You stopped sharing. The session has ended.');
  }

  function finish(text) {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (pc) pc.close();
    stream = pc = null;
    $('banner').classList.add('hidden');
    $('doneText').textContent = text;
    show('donePanel');
    try { sessionStorage.removeItem(`nolt.join.${joinToken}`); } catch {}
  }

  // Page reload after claiming: rejoin with the saved agent token.
  if (saved) begin(saved);
})();
