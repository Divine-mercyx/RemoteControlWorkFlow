// Nolt Support agent UI. Runs inside the Tauri window (WebView2 on Windows).
// WebRTC + signaling happen here; real mouse/keyboard input is done by Rust via invoke().
(() => {
  const $ = (id) => document.getElementById(id);
  const PANELS = ['idlePanel', 'loadingPanel', 'consentPanel', 'activePanel', 'donePanel'];
  const show = (id) => PANELS.forEach((p) => $(p).classList.toggle('hidden', p !== id));
  const fail = (msg) => { $('error').textContent = msg; $('error').classList.toggle('hidden', !msg); };

  // Outside Tauri (e.g. testing in a normal browser) use a stand-in that records calls.
  const tauri = window.__TAURI__;
  const invoke = tauri ? tauri.core.invoke : mockInvoke;
  const listen = tauri ? tauri.event.listen : async () => {};

  let info = null;      // { serverUrl, version, platform }
  let socket = null;
  let pc = null;
  let stream = null;
  let state = null;
  let control = false;  // whether the technician may use mouse/keyboard
  let session = null;   // { sessionId, agentToken, code, technician }
  let iceServers = [];

  async function init() {
    info = await invoke('launch_info');
    $('footer').textContent = `Nolt Support ${info.version}`;
    // A new link was clicked while the app is open.
    await listen('launch-token', async () => {
      const next = await invoke('launch_info');
      if (next.token && !socket) claim(next.token);
    });
    if (info.token) claim(info.token);
    else show('idlePanel');
  }

  $('linkBtn').onclick = async () => {
    const token = await invoke('token_from_link', { link: $('linkInput').value });
    if (!token) return fail('That does not look like a Nolt support link.');
    claim(token);
  };
  $('againBtn').onclick = () => { fail(''); show('idlePanel'); };

  async function claim(token) {
    fail('');
    show('loadingPanel');
    try {
      const res = await fetch(`${info.serverUrl}/api/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, agentInfo: { platform: info.platform, agent: 'nolt-support', version: info.version } }),
      });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({}));
        throw new Error(error === 'already_used' ? 'This link has already been used. Ask the technician for a new one.'
          : error === 'too_many_attempts' ? 'Too many attempts. Please wait a few minutes and try again.'
          : 'This link has expired. Ask the technician for a new one.');
      }
      session = await res.json();
      connect();
    } catch (e) {
      show('idlePanel');
      fail(e instanceof TypeError ? 'Could not reach Nolt Support. Check your internet connection.' : e.message);
    }
  }

  function connect() {
    $('code').textContent = `${session.code.slice(0, 3)} ${session.code.slice(3)}`;
    $('techName').textContent = session.technician ? `${session.technician} from Nolt Support` : 'A Nolt technician';
    $('allowBtn').disabled = false;
    show('consentPanel');
    socket = io(info.serverUrl, { auth: { sessionId: session.sessionId, role: 'agent', token: session.agentToken } });
    socket.on('connect', () => fail(''));
    socket.on('connect_error', (e) => {
      if (e.message === 'unauthorized') { socket.disconnect(); finish('This support session has ended.'); }
      else fail('Connection problem. Retrying…');
    });
    socket.on('ready', (d) => { iceServers = d.iceServers; state = d.session.state; });
    socket.on('session:update', (s) => {
      const was = state;
      state = s.state;
      if (s.state === 'approved' && was !== 'approved') startPeer();
    });
    socket.on('peer:joined', () => { if (state === 'approved' && stream) startPeer(); });
    socket.on('signal', onSignal);
    socket.on('session:ended', (s) => finish(
      s.endReason === 'denied_by_user' ? 'You declined the request.'
        : s.endReason === 'ended_by_user' ? 'You stopped sharing. The session has ended.'
        : 'The technician ended the session.'));
  }

  $('allowBtn').onclick = async () => {
    $('allowBtn').disabled = true;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'monitor', frameRate: 15 },
        audio: false,
        selfBrowserSurface: 'exclude',
        monitorTypeSurfaces: 'include',
      });
    } catch {
      $('allowBtn').disabled = false;
      return fail('Screen sharing was cancelled. Click Allow to try again, or Deny.');
    }
    fail('');
    const track = stream.getVideoTracks()[0];
    track.addEventListener('ended', () => stop());
    await setupControl(track.getSettings());
    socket.emit('consent', { allow: true });
    $('banner').classList.remove('hidden');
    await invoke('set_sharing', { sharing: true }).catch(() => {});
    show('activePanel');
  };
  $('denyBtn').onclick = () => socket && socket.emit('consent', { allow: false });
  $('stopBtn').onclick = () => stop();

  // Control is only possible when a whole monitor is shared, so clicks land where the technician sees them.
  async function setupControl(settings) {
    control = false;
    if (settings.displaySurface && settings.displaySurface !== 'monitor') {
      $('controlNote').textContent = 'You shared a single window, so the technician can only view it. Stop and share your entire screen to let them use your mouse and keyboard.';
      return;
    }
    try {
      const res = await invoke('start_control', { videoWidth: settings.width, videoHeight: settings.height });
      control = res.matched;
    } catch (e) {
      console.error(e);
    }
    $('controlNote').textContent = control
      ? 'The technician can use your mouse and keyboard. Click Stop at any time.'
      : 'The technician can view your screen but not control it.';
  }

  async function startPeer() {
    if (!stream) return;
    if (pc) pc.close();
    pc = new RTCPeerConnection({ iceServers });
    for (const track of stream.getTracks()) pc.addTrack(track, stream);
    const channel = pc.createDataChannel('control', { ordered: true });
    channel.onopen = () => channel.send(JSON.stringify({ t: 'hello', agent: 'nolt-support', platform: info.platform, version: info.version, control }));
    channel.onmessage = (m) => onControl(m.data);
    pc.onicecandidate = (e) => e.candidate && socket.emit('signal', { type: 'candidate', candidate: e.candidate });
    pc.onconnectionstatechange = () => {
      $('status').textContent = pc.connectionState === 'connected' ? 'connected' : pc.connectionState;
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

  let lastActivity = '';
  function activity(text) {
    if (text === lastActivity) return;
    lastActivity = text;
    const line = document.createElement('div');
    line.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
    $('activity').prepend(line);
    while ($('activity').childElementCount > 50) $('activity').lastChild.remove();
  }

  function onControl(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.t === 'cmd') {
      invoke('run_command', { raw }).then(activity, (e) => activity(`Blocked: ${e}`));
    } else if ((msg.t === 'mouse' || msg.t === 'key') && control) {
      invoke('inject', { raw }).catch((e) => console.error(e));
      if (msg.t === 'mouse' && msg.a === 'down') activity('Clicked');
      else if (msg.t === 'key' && msg.a === 'down') activity('Typed');
    }
  }

  function stop() {
    if (socket) socket.emit('end');
    finish('You stopped sharing. The session has ended.');
  }

  function finish(text) {
    invoke('stop_control').catch(() => {});
    invoke('set_sharing', { sharing: false }).catch(() => {});
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (pc) pc.close();
    if (socket) socket.disconnect();
    stream = pc = socket = null;
    control = false;
    state = null;
    $('banner').classList.add('hidden');
    $('activity').textContent = '';
    $('doneText').textContent = text;
    show('donePanel');
  }

  // ---- Browser stand-in for development and automated tests ----
  async function mockInvoke(cmd, args = {}) {
    const calls = (window.__agentCalls ||= []);
    calls.push({ cmd, args });
    switch (cmd) {
      case 'launch_info': {
        const p = new URLSearchParams(location.hash.slice(1));
        const token = p.get('token');
        history.replaceState(null, '', location.pathname);
        return { token, serverUrl: p.get('server') || window.__serverUrl || location.origin, version: 'dev', platform: 'browser' };
      }
      case 'token_from_link': {
        const m = /\/join\/([A-Za-z0-9_-]{20,128})/.exec(args.link || '');
        return m ? m[1] : null;
      }
      case 'start_control': return { screen: { x: 0, y: 0, width: args.videoWidth, height: args.videoHeight }, matched: true };
      case 'run_command': return `Opened ${JSON.parse(args.raw).url || JSON.parse(args.raw).app}`;
      default: return null;
    }
  }

  init().catch((e) => { show('idlePanel'); fail(String(e)); });
})();
