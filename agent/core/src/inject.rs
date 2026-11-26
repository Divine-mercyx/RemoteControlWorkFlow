use std::collections::HashSet;

use enigo::{Axis, Button, Direction, Enigo, Key, Keyboard, Mouse, Settings};

use crate::keys::map_key;
use crate::protocol::{KeyAction, KeyMsg, Message, MouseAction, MouseMsg};
use crate::screen::Screen;

/// Browsers report one wheel notch as ~100 px.
const WHEEL_NOTCH_PX: i32 = 100;

/// Where input actually goes. The real one is enigo; tests use a recorder.
pub trait Backend {
    fn move_to(&mut self, x: i32, y: i32) -> Result<(), String>;
    fn button(&mut self, b: Button, d: Direction) -> Result<(), String>;
    fn key(&mut self, k: Key, d: Direction) -> Result<(), String>;
    fn scroll(&mut self, clicks: i32, axis: Axis) -> Result<(), String>;
}

pub struct EnigoBackend(Enigo);

impl EnigoBackend {
    pub fn new() -> Result<Self, String> {
        Enigo::new(&Settings::default()).map(Self).map_err(|e| e.to_string())
    }
}

impl Backend for EnigoBackend {
    fn move_to(&mut self, x: i32, y: i32) -> Result<(), String> {
        // enigo's absolute move only covers the main display on Windows;
        // SetCursorPos takes virtual-desktop pixels, so other monitors work too.
        #[cfg(windows)]
        {
            unsafe { windows::Win32::UI::WindowsAndMessaging::SetCursorPos(x, y) }.map_err(|e| e.to_string())
        }
        #[cfg(not(windows))]
        {
            self.0.move_mouse(x, y, enigo::Coordinate::Abs).map_err(|e| e.to_string())
        }
    }
    fn button(&mut self, b: Button, d: Direction) -> Result<(), String> {
        self.0.button(b, d).map_err(|e| e.to_string())
    }
    fn key(&mut self, k: Key, d: Direction) -> Result<(), String> {
        self.0.key(k, d).map_err(|e| e.to_string())
    }
    fn scroll(&mut self, clicks: i32, axis: Axis) -> Result<(), String> {
        self.0.scroll(clicks, axis).map_err(|e| e.to_string())
    }
}

/// Applies technician input to one monitor and remembers what is held down,
/// so everything can be released when the session stops (no stuck Ctrl).
pub struct Injector<B: Backend> {
    backend: B,
    screen: Screen,
    keys_down: HashSet<Key>,
    buttons_down: Vec<Button>,
    wheel: (i32, i32),
}

impl<B: Backend> Injector<B> {
    pub fn new(backend: B, screen: Screen) -> Self {
        Self { backend, screen, keys_down: HashSet::new(), buttons_down: Vec::new(), wheel: (0, 0) }
    }

    pub fn screen(&self) -> Screen {
        self.screen
    }

    /// Apply a mouse or key message. Commands and unknown messages are ignored here.
    pub fn handle(&mut self, msg: &Message) -> Result<(), String> {
        match msg {
            Message::Mouse(m) => self.mouse(m),
            Message::Key(k) => self.key(k),
            Message::Cmd(_) | Message::Unknown => Ok(()),
        }
    }

    fn mouse(&mut self, m: &MouseMsg) -> Result<(), String> {
        if let (Some(x), Some(y)) = (m.x, m.y) {
            if m.a != MouseAction::Wheel {
                let (px, py) = self.screen.to_pixel(x, y);
                self.backend.move_to(px, py)?;
            }
        }
        match m.a {
            MouseAction::Move => Ok(()),
            MouseAction::Down | MouseAction::Up => {
                let Some(button) = dom_button(m.b) else { return Ok(()) };
                if m.a == MouseAction::Down {
                    if !self.buttons_down.contains(&button) {
                        self.buttons_down.push(button);
                    }
                    self.backend.button(button, Direction::Press)
                } else {
                    self.buttons_down.retain(|b| *b != button);
                    self.backend.button(button, Direction::Release)
                }
            }
            MouseAction::Wheel => {
                self.wheel.0 += m.dx;
                self.wheel.1 += m.dy;
                let (cx, cy) = (self.wheel.0 / WHEEL_NOTCH_PX, self.wheel.1 / WHEEL_NOTCH_PX);
                self.wheel.0 -= cx * WHEEL_NOTCH_PX;
                self.wheel.1 -= cy * WHEEL_NOTCH_PX;
                if cy != 0 {
                    self.backend.scroll(cy, Axis::Vertical)?;
                }
                if cx != 0 {
                    self.backend.scroll(cx, Axis::Horizontal)?;
                }
                Ok(())
            }
        }
    }

    fn key(&mut self, k: &KeyMsg) -> Result<(), String> {
        let Some(key) = map_key(&k.code, &k.key) else { return Ok(()) };
        match k.a {
            KeyAction::Down => {
                self.keys_down.insert(key);
                self.backend.key(key, Direction::Press)
            }
            KeyAction::Up => {
                self.keys_down.remove(&key);
                self.backend.key(key, Direction::Release)
            }
        }
    }

    /// Release every key and button still held. Call when control stops.
    pub fn release_all(&mut self) {
        for key in self.keys_down.drain().collect::<Vec<_>>() {
            let _ = self.backend.key(key, Direction::Release);
        }
        for b in std::mem::take(&mut self.buttons_down) {
            let _ = self.backend.button(b, Direction::Release);
        }
        self.wheel = (0, 0);
    }

    #[cfg(test)]
    fn backend(&self) -> &B {
        &self.backend
    }
}

fn dom_button(b: u8) -> Option<Button> {
    Some(match b {
        0 => Button::Left,
        1 => Button::Middle,
        2 => Button::Right,
        3 => Button::Back,
        4 => Button::Forward,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::parse;

    #[derive(Default)]
    struct Rec(Vec<String>);
    impl Backend for Rec {
        fn move_to(&mut self, x: i32, y: i32) -> Result<(), String> {
            self.0.push(format!("move {x},{y}"));
            Ok(())
        }
        fn button(&mut self, b: Button, d: Direction) -> Result<(), String> {
            self.0.push(format!("{b:?} {d:?}"));
            Ok(())
        }
        fn key(&mut self, k: Key, d: Direction) -> Result<(), String> {
            self.0.push(format!("{k:?} {d:?}"));
            Ok(())
        }
        fn scroll(&mut self, c: i32, a: Axis) -> Result<(), String> {
            self.0.push(format!("scroll {c} {a:?}"));
            Ok(())
        }
    }

    const SIDE: Screen = Screen { x: 1920, y: 0, width: 1000, height: 500 };

    fn run(msgs: &[&str]) -> Injector<Rec> {
        let mut inj = Injector::new(Rec::default(), SIDE);
        for m in msgs {
            inj.handle(&parse(m).unwrap()).unwrap();
        }
        inj
    }

    #[test]
    fn click_moves_then_presses_on_the_right_monitor() {
        let inj = run(&[
            r#"{"t":"mouse","a":"down","b":0,"x":0.5,"y":0.5}"#,
            r#"{"t":"mouse","a":"up","b":0,"x":0.5,"y":0.5}"#,
        ]);
        assert_eq!(inj.backend().0, ["move 2420,250", "Left Press", "move 2420,250", "Left Release"]);
    }

    #[test]
    fn wheel_accumulates_small_deltas() {
        let inj = run(&[
            r#"{"t":"mouse","a":"wheel","dy":40}"#,
            r#"{"t":"mouse","a":"wheel","dy":40}"#,
            r#"{"t":"mouse","a":"wheel","dy":40}"#,
            r#"{"t":"mouse","a":"wheel","dy":-300}"#,
        ]);
        assert_eq!(inj.backend().0, ["scroll 1 Vertical", "scroll -2 Vertical"]);
    }

    #[test]
    fn release_all_lifts_held_keys_and_buttons() {
        let mut inj = run(&[
            r#"{"t":"key","a":"down","code":"ControlLeft","key":"Control"}"#,
            r#"{"t":"mouse","a":"down","b":2,"x":0,"y":0}"#,
        ]);
        inj.release_all();
        let log = inj.backend().0.clone();
        assert!(log.ends_with(&["LControl Release".to_string(), "Right Release".to_string()]), "{log:?}");
        // A second release is a no-op.
        inj.release_all();
        assert_eq!(inj.backend().0.len(), log.len());
    }

    #[test]
    fn unmapped_keys_and_commands_do_nothing() {
        let inj = run(&[
            r#"{"t":"key","a":"down","code":"Unidentified","key":"Dead"}"#,
            r#"{"t":"cmd","name":"open_url","url":"https://example.com"}"#,
            r#"{"t":"mouse","a":"down","b":9,"x":0,"y":0}"#,
        ]);
        assert_eq!(inj.backend().0, ["move 1920,0"]);
    }
}
