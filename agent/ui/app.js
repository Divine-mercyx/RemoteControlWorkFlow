// Nolt Support agent UI. Runs inside the Tauri window (WebView2 on Windows).
// WebRTC + signaling happen here; real mouse/keyboard input is done by Rust via invoke().
//
// Two modes:
//   attended   - the customer-support flow: paste a link / click Allow, per session.
//   unattended - a company-managed device: enrolled once, IT connects with no click.
//                The build is "unattended" when a company enrollment key was baked in.
(() => {
  const $ = (id) => document.getElementById(id);
  const PANELS = ['idlePanel', 'loadingPanel', 'managedPanel', 'consentPanel', 'activePanel', 'donePanel'];
  const show = (id) => PANELS.forEach((p) => $(p).classList.toggle('hidden', p !== id));
  const fail = (msg) => { $('error').textContent = msg; $('error').classList.toggle('hidden', !msg); };

  // Outside Tauri (e.g. testing in a normal browser) use a stand-in that records calls.
  const tauri = window.__TAURI__;
  const invoke = tauri ? tauri.core.invoke : mockInvoke;
  const listen = tauri ? tauri.event.listen : async () => {};

  let info = null;      // { mode, serverUrl, version, platform, ... }
  let mode = 'attended';
  let socket = null;    // per-session signaling socket (role: agent)
  let presence = null;  // unattended: long-lived presence socket (role: device)
  let pc = null;
  let stream = null;
  let state = null;
  let control = false;  // whether the technician may use mouse/keyboard
  let session = null;   // { sessionId, agentToken, code, technician }
  let iceServers = [];

  async function init() {
    const cfg = await invoke('unattended_info');
    mode = cfg.mode;
    if (mode === 'unattended') {
      info = cfg;
      const name = info.productName || 'Nolt Support';
      $('appName').textContent = name;
      document.title = name;
      $('footer').textContent = `${name} ${info.version} · managed device`;
      return runManaged();
    }
    // Attended: the original customer-support flow.
    info = await invoke('launch_info');
    $('footer').textContent = `Nolt Support ${info.version}`;
    await listen('launch-token', async () => {
      const next = await invoke('launch_info');
      if (next.token && !socket) claim(next.token);
    });
    if (info.token) claim(info.token);
    else show('idlePanel');
  }

  // ===================== Managed (unattended) =====================

  function managedStatus(text, cls = '') {
    $('managedStatus').textContent = text;
    $('managedStatus').className = `status ${cls}`;
  }

  async function runManaged() {
    show('managedPanel');
    managedStatus('setting up…');
    try {
      let deviceToken = info.deviceToken;
      if (!deviceToken) deviceToken = await enrollDevice();
      openPresence(deviceToken);
    } catch (e) {
      managedStatus('setup problem', 'bad');
      fail(`${e.message}. Retrying shortly…`);
      setTimeout(runManaged, 15000);
    }
  }

  async function enrollDevice() {
    const res = await fetch(`${info.serverUrl}/api/devices/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enrollmentKey: info.enrollmentKey,
        name: info.hostname,
        hostname: info.hostname,
        platform: info.platform,
        version: info.version,
      }),
    });
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({}));
      throw new Error(error === 'invalid_enrollment_key' ? 'this device is not authorised (bad enrollment key)' : `enrollment failed (${res.status})`);
    }
    const { deviceToken } = await res.json();
    await invoke('save_device_token', { token: deviceToken });
    return deviceToken;
  }

  function openPresence(deviceToken) {
    if (presence) presence.disconnect();
    presence = io(info.serverUrl, { auth: { role: 'device', deviceToken } });
    presence.on('connect', () => { fail(''); if (!session) managedStatus('ready — IT can connect', 'ok'); });
    presence.on('disconnect', () => { if (!session) managedStatus('reconnecting…'); });
    presence.on('connect_error', async (e) => {
      if (e.message === 'unauthorized') {
        // Device was removed, or its token is stale: forget it and re-enroll once.
        presence.disconnect();
        presence = null;
        await invoke('save_device_token', { token: '' }).catch(() => {});
        info.deviceToken = null;
        setTimeout(runManaged, 2000);
      }
    });
    presence.on('session:start', (d) => beginManagedSession(d));
  }

  async function beginManagedSession(d) {
    if (session) return; // already serving one
    session = { sessionId: d.sessionId, agentToken: d.agentToken, technician: d.technician };
    iceServers = d.iceServers || [];
    managedStatus('a technician is connecting…', 'ok');
    try {
      // Unattended builds pass a WebView2 flag so this does not show a picker.
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: 'monitor', frameRate: 15 },
        audio: false,
      });
    } catch (e) {
      // Capture refused (needs a gesture, or the screen label did not match the flag).
      session = null;
      managedStatus('could not start screen capture', 'bad');
      fail(`Screen capture was blocked: ${e.name || e.message}. This is the case that needs the native-capture build.`);
      return;
    }
    stream.getVideoTracks()[0].addEventListener('ended', () => stop());
    await setupControl(stream.getVideoTracks()[0].getSettings());
    connectAgentSocket();
    $('banner').querySelector('span').innerHTML = `<span class="dot"></span> ${info.productName || 'IT support'} is connected to this device`;
    $('banner').classList.remove('hidden');
    await invoke('set_sharing', { sharing: true }).catch(() => {});
    showManagedActive();
  }

  function showManagedActive() {
    show('activePanel');
    $('controlNote').textContent = control
      ? 'A technician is connected and can control this computer.'
      : 'A technician is connected and can view this computer.';
  }

  function connectAgentSocket() {
    socket = io(info.serverUrl, { auth: { sessionId: session.sessionId, role: 'agent', token: session.agentToken } });
    socket.on('connect_error', (e) => { if (e.message === 'unauthorized') endManagedSession(); });
    socket.on('ready', (d) => { iceServers = d.iceServers || iceServers; state = d.session && d.session.state; if (state === 'approved' && stream) startPeer(); });
    socket.on('session:update', (s) => { const was = state; state = s.state; if (s.state === 'approved' && was !== 'approved') startPeer(); });
    socket.on('peer:joined', () => { if (state === 'approved' && stream) startPeer(); });
    socket.on('signal', onSignal);
    socket.on('session:ended', () => endManagedSession());
  }

  // End the current session but stay enrolled and ready for the next one.
  function endManagedSession() {
    invoke('stop_control').catch(() => {});
    invoke('set_sharing', { sharing: false }).catch(() => {});
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (pc) pc.close();
    if (socket) socket.disconnect();
    stream = pc = socket = null;
    control = false;
    state = null;
    session = null;
    $('banner').classList.add('hidden');
    $('activity').textContent = '';
    managedStatus(presence && presence.connected ? 'ready — IT can connect' : 'reconnecting…', presence && presence.connected ? 'ok' : '');
    show('managedPanel');
  }

  // ===================== Attended (customer support) =====================

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

  // ===================== Shared: capture, peer, input =====================

  // Control is only possible when a whole monitor is shared, so clicks land where the technician sees them.
  async function setupControl(settings) {
    control = false;
    if (settings.displaySurface && settings.displaySurface !== 'monitor') {
      $('controlNote').textContent = 'A single window is shared, so the technician can only view it.';
      return;
    }
    try {
      const res = await invoke('start_control', { videoWidth: settings.width, videoHeight: settings.height });
      control = res.matched;
    } catch (e) {
      console.error(e);
    }
    if (mode === 'attended') {
      $('controlNote').textContent = control
        ? 'The technician can use your mouse and keyboard. Click Stop at any time.'
        : 'The technician can view your screen but not control it.';
    }
  }

  async function startPeer() {
    if (!stream) return;
    if (pc) pc.close();
    pc = new RTCPeerConnection({ iceServers });
    for (const track of stream.getTracks()) pc.addTrack(track, stream);
    const channel = pc.createDataChannel('control', { ordered: true });
    channel.onopen = () => channel.send(JSON.stringify({ t: 'hello', agent: mode === 'unattended' ? 'nolt-agent' : 'nolt-support', platform: info.platform, version: info.version, control }));
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
    if (mode === 'unattended') endManagedSession();
    else finish('You stopped sharing. The session has ended.');
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
    const p = new URLSearchParams(location.hash.slice(1));
    switch (cmd) {
      case 'unattended_info': {
        const serverUrl = p.get('server') || window.__serverUrl || location.origin;
        if (p.get('mode') === 'unattended') {
          return { mode: 'unattended', productName: p.get('product') || 'Finance Support', serverUrl, version: 'dev', platform: 'browser',
            enrollmentKey: p.get('enroll') || 'dev-enroll-key', deviceToken: window.__deviceToken || null, hostname: 'DEV-PC' };
        }
        return { mode: 'attended', serverUrl, version: 'dev', platform: 'browser' };
      }
      case 'launch_info': {
        const token = p.get('token');
        history.replaceState(null, '', location.pathname);
        return { token, serverUrl: p.get('server') || window.__serverUrl || location.origin, version: 'dev', platform: 'browser' };
      }
      case 'save_device_token': { window.__deviceToken = args.token || null; return null; }
      case 'token_from_link': {
        const m = /\/join\/([A-Za-z0-9_-]{20,128})/.exec(args.link || '');
        return m ? m[1] : null;
      }
      case 'start_control': return { screen: { x: 0, y: 0, width: args.videoWidth, height: args.videoHeight }, matched: true };
      case 'run_command': return `Opened ${JSON.parse(args.raw).url || JSON.parse(args.raw).app}`;
      default: return null;
    }
  }

  init().catch((e) => { show(mode === 'unattended' ? 'managedPanel' : 'idlePanel'); fail(String(e)); });
})();
