# Nolt Remote Support

Consent-based remote support. A technician creates a session and sends the user a link. The user opens it, both sides see the same 6-digit code, and the user clicks **Allow**. After that, the user's screen streams to the technician over WebRTC, and the technician's mouse, keyboard and commands go back over a data channel.

```
Technician (tech.html)          This service                  User (join link / agent)
  POST /api/sessions  ───────►  session + one-time link
  send link ─────────────────────────────────────────────────► opens /join/<token>
                                POST /api/claim  ◄──────────── clicks Continue
  ◄── session:update (code) ──  6-digit code   ──────────────► shows code
                                consent ◄──────────────────── clicks Allow
  ◄────── offer / answer / ICE relayed (only after Allow) ────►
  ◄═════════════ screen video, peer-to-peer or via TURN ═══════
  ═════════════ input + commands (data channel "control") ════►
```

## Status

| Phase | What | State |
|---|---|---|
| 1 | Session API, signaling, technician viewer, browser agent (view only) | **Done** |
| 2 | Windows app (Tauri): remote control, `noltsupport://` links, per-session download. See [`agent/`](agent/README.md) | **Built; needs testing on a real PC** |
| 3 | Production: coturn, Redis store, JWT from the admin backend, signed installers, audit in the admin panel | |
| 4 | Android agent; iOS view-only | |

## Run locally

```bash
npm install
npm start          # http://localhost:8080/tech.html  (dev API key: dev-tech-key)
npm test
```

Open `tech.html`, enter the API key and click **New session**. Then open the join link in another browser window and click **Continue**, then **Allow**.

## Configuration

See `.env.example`. In production, `TECH_API_KEY` is required. Set `AGENT_WINDOWS_EXE` to the built `NoltSupport.exe` to offer the Windows app on the join page. TURN relay (needed when the two devices are on different networks): set `TURN_URLS` plus either `TURN_SECRET` (your own coturn) or `TURN_USERNAME` and `TURN_CREDENTIAL` (a hosted relay service). The desktop app's origins (`http://tauri.localhost`, `tauri://localhost`) are always allowed for CORS.

## HTTP API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/sessions` | `Authorization: Bearer <TECH_API_KEY>` | Create a session. Returns `session`, `joinUrl`, `techToken` |
| GET | `/api/sessions/:id` | tech key | Session status |
| POST | `/api/sessions/:id/end` | tech key | End a session |
| POST | `/api/claim` | none (rate limited: 20 per 10 min per IP) | Body `{ token, agentInfo }`. Returns `{ sessionId, agentToken, code, technician }` |
| GET | `/api/agents` | none | Which native apps are available, e.g. `{ windows: true }` |
| GET | `/download/windows/:token` | none (rate limited) | The Windows app, named `NoltSupport-<token>.exe`. Doesn't use up the link |
| GET | `/join/:token` | none | Landing page. Opening it does **not** use up the token, so link previews in WhatsApp or SMS can't burn it |
| GET | `/healthz` | none | Health check |

## Signaling (Socket.IO)

Connect with `auth: { sessionId, role: 'tech' | 'agent', token }`.

| Direction | Event | Payload |
|---|---|---|
| server → client | `ready` | `{ session, iceServers, peerPresent }` |
| server → client | `session:update` | session (`created` → `claimed` → `approved`) |
| server → client | `session:ended` | session with `endReason` |
| server → client | `peer:joined` / `peer:left` | `{ role }` |
| agent → server | `consent` | `{ allow: boolean }`. `false` ends the session |
| both | `signal` | `{ type: 'offer' \| 'answer', sdp }` or `{ type: 'candidate', candidate }`. Relayed only after consent |
| both | `end` | Ends the session for both sides |

The agent always makes the WebRTC offer and opens the `control` data channel.

## Control channel protocol

This protocol is what the Phase 2 native agent implements. JSON messages, coordinates normalised to 0–1 of the shared screen:

```jsonc
{ "t": "mouse", "a": "move", "x": 0.42, "y": 0.31 }
{ "t": "mouse", "a": "down" | "up", "b": 0 /*left*/ | 1 /*middle*/ | 2 /*right*/, "x": 0.42, "y": 0.31 }
{ "t": "mouse", "a": "wheel", "dx": 0, "dy": 120 }
{ "t": "key",   "a": "down" | "up", "key": "a", "code": "KeyA", "mods": { "ctrl": false, "alt": false, "shift": false, "meta": false } }
{ "t": "cmd",   "name": "open_url", "url": "https://…" }
{ "t": "cmd",   "name": "open_app", "app": "notepad" }
// agent → technician
{ "t": "hello", "agent": "browser" | "nolt-support", "platform": "windows", "control": false | true }
```

## Safeguards built in

- Join links work once and expire after 10 minutes. Sessions end after 2 hours at most.
- Nothing is streamed until the user clicks Allow. The server drops signaling messages before that.
- The user sees a "technician can see your screen" banner with a **Stop sharing** button.
- Tokens are compared in constant time, and join tokens are stored only as hashes.
- `Referrer-Policy: no-referrer` keeps the token in the link from leaking to other sites.
- Every session event is written to the audit log (stdout, JSON lines).
