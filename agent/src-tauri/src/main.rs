// No console window in release builds on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;

use nolt_agent_core::commands::{validate_app, validate_url};
use nolt_agent_core::inject::{EnigoBackend, Injector};
use nolt_agent_core::launch;
use nolt_agent_core::protocol::{self, Message};
use nolt_agent_core::screen::{self, Screen};
use serde::Serialize;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;

/// Display name for this build. The managed build sets NOLT_PRODUCT_NAME.
const PRODUCT_NAME: &str = match option_env!("NOLT_PRODUCT_NAME") {
    Some(n) => n,
    None => "Nolt Support",
};

/// The support server this build talks to. Set NOLT_SERVER_URL at build time.
/// Deliberately not overridable from a link, so a crafted link cannot point
/// the agent at someone else's server.
const SERVER_URL: &str = match option_env!("NOLT_SERVER_URL") {
    Some(url) => url,
    None => "http://localhost:8080",
};

/// When a company enrollment key is baked in at build time, this is an
/// unattended (managed-device) build: it enrolls itself and lets IT connect
/// without a per-session click. Without it, this is the normal attended app.
const ENROLLMENT_KEY: Option<&str> = option_env!("NOLT_ENROLLMENT_KEY");

fn is_unattended() -> bool {
    ENROLLMENT_KEY.is_some()
}

fn hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "unknown".into())
}

/// File that holds this device's long-lived token once enrolled.
fn device_token_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("device.token"))
}

fn read_device_token(app: &AppHandle) -> Option<String> {
    let p = device_token_path(app)?;
    let t = std::fs::read_to_string(p).ok()?.trim().to_string();
    (!t.is_empty()).then_some(t)
}

/// Work for the input thread, which owns the (not thread-safe) input backend.
enum InputJob {
    Start(Screen, Sender<Result<(), String>>),
    Input(Message),
    Stop,
}

struct AgentState {
    pending_token: Mutex<Option<String>>,
    input: Mutex<Sender<InputJob>>,
}

fn spawn_input_thread() -> Sender<InputJob> {
    let (tx, rx) = mpsc::channel::<InputJob>();
    std::thread::Builder::new()
        .name("input".into())
        .spawn(move || {
            let mut injector: Option<Injector<EnigoBackend>> = None;
            for job in rx {
                match job {
                    InputJob::Start(screen, reply) => {
                        if let Some(old) = injector.as_mut() {
                            old.release_all();
                        }
                        let result = EnigoBackend::new().map(|b| injector = Some(Injector::new(b, screen)));
                        let _ = reply.send(result);
                    }
                    InputJob::Input(msg) => {
                        if let Some(inj) = injector.as_mut() {
                            if let Err(e) = inj.handle(&msg) {
                                eprintln!("[input] {e}");
                            }
                        }
                    }
                    InputJob::Stop => {
                        if let Some(mut inj) = injector.take() {
                            inj.release_all();
                        }
                    }
                }
            }
        })
        .expect("failed to start input thread");
    tx
}

fn send_job(state: &AgentState, job: InputJob) -> Result<(), String> {
    state.input.lock().map_err(|_| "input lock poisoned")?.send(job).map_err(|_| "input thread stopped".to_string())
}

/// A join token arrived while the app is running (second launch or deep link).
fn deliver_token(app: &AppHandle, token: String) {
    if let Ok(mut slot) = app.state::<AgentState>().pending_token.lock() {
        *slot = Some(token);
    }
    let _ = app.emit("launch-token", ());
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LaunchInfo {
    token: Option<String>,
    server_url: &'static str,
    version: &'static str,
    platform: &'static str,
}

/// Hands the UI the pending join token (once) and static info.
#[tauri::command]
fn launch_info(state: State<AgentState>) -> LaunchInfo {
    LaunchInfo {
        token: state.pending_token.lock().ok().and_then(|mut t| t.take()),
        server_url: SERVER_URL,
        version: env!("CARGO_PKG_VERSION"),
        platform: std::env::consts::OS,
    }
}

/// Token from a join link the user pasted.
#[tauri::command]
fn token_from_link(link: String) -> Option<String> {
    launch::token_from_join_url(&link)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UnattendedInfo {
    mode: &'static str,
    product_name: &'static str,
    server_url: &'static str,
    version: &'static str,
    platform: &'static str,
    enrollment_key: Option<&'static str>,
    device_token: Option<String>,
    hostname: String,
}

/// Tells the UI whether this is a managed (unattended) build, and gives it what
/// it needs to enroll and keep a presence connection.
#[tauri::command]
fn unattended_info(app: AppHandle) -> UnattendedInfo {
    let unattended = is_unattended();
    UnattendedInfo {
        mode: if unattended { "unattended" } else { "attended" },
        product_name: PRODUCT_NAME,
        server_url: SERVER_URL,
        version: env!("CARGO_PKG_VERSION"),
        platform: std::env::consts::OS,
        enrollment_key: if unattended { ENROLLMENT_KEY } else { None },
        device_token: if unattended { read_device_token(&app) } else { None },
        hostname: hostname(),
    }
}

/// Persist (or clear, with an empty string) this device's enrollment token.
#[tauri::command]
fn save_device_token(app: AppHandle, token: String) -> Result<(), String> {
    let path = device_token_path(&app).ok_or("no config directory")?;
    if token.trim().is_empty() {
        let _ = std::fs::remove_file(&path);
        return Ok(());
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, token.trim()).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ControlInfo {
    screen: Screen,
    matched: bool,
}

/// Called after the user picked what to share. Works out which monitor the
/// video shows and starts accepting input for it.
#[tauri::command]
fn start_control(
    window: WebviewWindow,
    state: State<AgentState>,
    video_width: u32,
    video_height: u32,
) -> Result<ControlInfo, String> {
    let to_screen = |m: &tauri::Monitor| Screen {
        x: m.position().x,
        y: m.position().y,
        width: m.size().width,
        height: m.size().height,
    };
    let monitors: Vec<Screen> = window.available_monitors().map_err(|e| e.to_string())?.iter().map(to_screen).collect();
    let primary = window.primary_monitor().map_err(|e| e.to_string())?.as_ref().map(to_screen);
    let (screen, matched) =
        screen::pick_monitor(&monitors, primary, video_width, video_height).ok_or("no monitor found")?;
    if !matched {
        return Ok(ControlInfo { screen, matched });
    }
    let (reply_tx, reply_rx) = mpsc::channel();
    send_job(&state, InputJob::Start(screen, reply_tx))?;
    reply_rx.recv().map_err(|_| "input thread stopped".to_string())??;
    Ok(ControlInfo { screen, matched })
}

/// Mouse / keyboard message from the technician (raw JSON from the data channel).
#[tauri::command]
fn inject(state: State<AgentState>, raw: String) -> Result<(), String> {
    match protocol::parse(&raw)? {
        msg @ (Message::Mouse(_) | Message::Key(_)) => send_job(&state, InputJob::Input(msg)),
        _ => Ok(()),
    }
}

#[tauri::command]
fn stop_control(state: State<AgentState>) -> Result<(), String> {
    send_job(&state, InputJob::Stop)
}

/// open_url / open_app from the technician. Returns a line for the user's log.
#[tauri::command]
fn run_command(app: AppHandle, raw: String) -> Result<String, String> {
    let Message::Cmd(cmd) = protocol::parse(&raw)? else {
        return Err("not a command".into());
    };
    match cmd.name.as_str() {
        "open_url" => {
            let url = validate_url(cmd.url.as_deref().unwrap_or_default())?;
            app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())?;
            Ok(format!("Opened {url}"))
        }
        "open_app" => {
            let name = validate_app(cmd.app.as_deref().unwrap_or_default())?;
            open_app(name)?;
            Ok(format!("Opened app: {name}"))
        }
        other => Err(format!("unknown command {other}")),
    }
}

#[cfg(windows)]
fn open_app(name: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    // `start` resolves App Paths (msedge, excel), System32 tools and URI schemes (ms-settings:).
    std::process::Command::new("cmd")
        .args(["/C", "start", "", name])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
fn open_app(name: &str) -> Result<(), String> {
    std::process::Command::new("open").args(["-a", name]).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(not(any(windows, target_os = "macos")))]
fn open_app(_name: &str) -> Result<(), String> {
    Err("opening apps is not supported on this platform yet".into())
}

/// Keep the agent window (with its Stop button) above other windows while sharing.
/// On a managed device the window is hidden when idle, so this also brings it up
/// as the visible "a session is active" indicator, and hides it again afterwards.
#[tauri::command]
fn set_sharing(window: WebviewWindow, sharing: bool) -> Result<(), String> {
    window.set_always_on_top(sharing).map_err(|e| e.to_string())?;
    if is_unattended() {
        if sharing {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        } else {
            let _ = window.hide();
        }
    }
    Ok(())
}

fn main() {
    // Unattended builds auto-select the whole screen so capture needs no picker.
    // The source is matched by its (localized) label; verify on non-English Windows.
    if is_unattended() {
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "--auto-select-desktop-capture-source=\"Entire screen\" --enable-usermedia-screen-capturing",
        );
    }
    tauri::Builder::default()
        // Must be first: a second launch (e.g. clicking another link) is forwarded here.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(token) = argv.iter().find_map(|a| launch::token_from_deep_link(a)) {
                deliver_token(app, token);
            } else if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        // Managed builds launch at login (hidden); harmless for the attended app.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .manage(AgentState { pending_token: Mutex::new(None), input: Mutex::new(spawn_input_thread()) })
        .setup(|app| {
            // Managed device: run in the background with a tray icon, start at login,
            // and keep the window hidden until a session makes it appear.
            if is_unattended() {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
                if let Err(e) = app.autolaunch().enable() {
                    eprintln!("[autostart] could not enable launch-at-login: {e}");
                }
                let show = MenuItem::with_id(app, "show", "Show status", true, None::<&str>)?;
                let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show, &quit])?;
                let tray = TrayIconBuilder::new()
                    .icon(app.default_window_icon().unwrap().clone())
                    .tooltip(PRODUCT_NAME)
                    .menu(&menu)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "show" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                        "quit" => app.exit(0),
                        _ => {}
                    })
                    .build(app)?;
                app.manage(tray); // keep the tray icon alive for the app's lifetime
            }
            // Register noltsupport:// for this exe (per user), so later links open the app directly.
            #[cfg(any(windows, target_os = "linux"))]
            if let Err(e) = app.deep_link().register_all() {
                eprintln!("[deep-link] could not register scheme: {e}");
            }
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                if let Some(token) = event.urls().iter().find_map(|u| launch::token_from_deep_link(u.as_str())) {
                    deliver_token(&handle, token);
                }
            });

            let args: Vec<String> = std::env::args().collect();
            let exe_name = std::env::current_exe()
                .ok()
                .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
                .unwrap_or_default();
            if let Some(token) = launch::find_token(&args, &exe_name) {
                *app.state::<AgentState>().pending_token.lock().unwrap() = Some(token);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // On a managed device, closing the window just hides it (the agent keeps
            // running in the tray); on the attended app it ends the session.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if is_unattended() {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            // Destroying the window must never leave keys held down.
            if let tauri::WindowEvent::Destroyed = event {
                let _ = send_job(&window.state::<AgentState>(), InputJob::Stop);
            }
        })
        .invoke_handler(tauri::generate_handler![
            launch_info,
            unattended_info,
            save_device_token,
            token_from_link,
            start_control,
            inject,
            stop_control,
            run_command,
            set_sharing
        ])
        .run(tauri::generate_context!())
        .expect("error while running Nolt Support");
}
