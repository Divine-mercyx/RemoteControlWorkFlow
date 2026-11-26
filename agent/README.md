# Nolt Support: Windows app

The desktop app the user runs so a technician can **see and control** their screen. Built with [Tauri 2](https://tauri.app). The app is about 5–10 MB and uses Windows' built-in WebView2.

## How the user gets in

1. The technician sends the usual join link. On Windows, the join page offers **Download Nolt Support**.
2. The server sends the app as `NoltSupport-<token>.exe`. When the app starts, it reads the token from its own file name, so the user doesn't have to type anything.
3. On first run, the app registers the `noltsupport://` scheme for the current user. After that, the join page's **I already have the app** button opens it directly, with no download.
4. The app shows the technician's name and the 6-digit code, then waits for **Allow** or **Deny**.
5. On **Allow**, Windows asks what to share. If the user picks **Entire screen**, the technician gets mouse and keyboard control. If they pick a single window, the technician can only view.
6. While sharing, the app stays on top of other windows with a red **Stop** bar, and lists what the technician did ("Clicked", "Typed", "Opened https://…").

If the app is opened with no token, the user can paste the join link into it.

## How it is built

```
agent/
  core/        Rust library, no UI; unit-tested on Linux and Windows
    protocol   technician messages (mouse, key, cmd)
    keys       browser KeyboardEvent.code -> Windows virtual keys (so Ctrl+C works)
    screen     0..1 coordinates -> pixels on the shared monitor (multi-monitor aware)
    launch     token from noltsupport:// link, download file name, or pasted link
    commands   validation for open_url / open_app
    inject     input via enigo; mouse position via SetCursorPos (covers all monitors)
  src-tauri/   the app: commands, deep links, single instance, dedicated input thread
  ui/          the window: signaling + WebRTC (same protocol as the browser agent)
```

Screen capture and WebRTC run inside WebView2 (`getDisplayMedia`), the same code path as the browser agent. Rust does only what a browser can't: inject input, open URLs and apps, and handle `noltsupport://` links.

Safeguards in the app:
- Control only starts after **Allow**, and only when a whole monitor is shared.
- Every key and mouse button still held down is released when the session stops or the window closes, so no keys get stuck.
- `open_app` accepts only simple names (`notepad`, `msedge`, `ms-settings:`), so no extra commands can be added on. `open_url` accepts only http(s) links.
- The server URL is built into the app. A link can't point the app at a different server.

## Building

GitHub Actions builds it: see `.github/workflows/agent-windows.yml`.

1. Set the repository variable `NOLT_SERVER_URL` (Settings → Secrets and variables → Actions → Variables) to the server's public URL, e.g. `https://support.example.com`.
2. Push changes under `agent/`, or run the workflow by hand (**Actions → Windows agent → Run workflow**). You can enter a server URL there too.
3. Download the `nolt-support-windows` artifact:
   - `NoltSupport.exe`: the portable app. Put it on the server and set `AGENT_WINDOWS_EXE=/path/to/NoltSupport.exe`.
   - `Nolt Support_<version>_x64-setup.exe`: an optional installer.

Building locally on Windows (needs Rust and Node):

```bash
cd agent/src-tauri
```

```bash
set NOLT_SERVER_URL=http://localhost:8080 && npx @tauri-apps/cli@2.12.6 dev
```

Core tests run on any OS:

```bash
cd agent && cargo test -p nolt-agent-core
```

## Testing on a real PC

1. Run the server with `AGENT_WINDOWS_EXE` pointing at the built exe, and with `PUBLIC_URL` and `NOLT_SERVER_URL` both set to an address the PC can reach.
2. Open `tech.html`, create a session, and open the link on the Windows PC.
3. Click **Download Nolt Support**, run it, and click **Allow** → **Entire screen**.
4. Check: clicks land in the right place (also on a second monitor), typing and Ctrl+C / Ctrl+V work, scrolling works, **Open URL** and **Open app** work, and **Stop** releases everything.

## Known limits

- **The app isn't code-signed yet.** SmartScreen will show "Windows protected your PC", and the user has to click **More info → Run anyway**. Signing comes in Phase 3.
- **Admin (UAC) prompts and the lock screen can't be controlled.** Windows shows them on a protected desktop that normal apps can't reach.
- **WebView2 shows its own screen picker,** so the user has to choose **Entire screen** themselves.
- **Keys are sent by physical position.** If the technician and user have different keyboard layouts (e.g. AZERTY vs QWERTY), some characters will differ.
