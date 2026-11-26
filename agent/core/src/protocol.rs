use serde::Deserialize;

/// A message from the technician on the "control" data channel.
/// Wire format is documented in the repository README.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum Message {
    Mouse(MouseMsg),
    Key(KeyMsg),
    Cmd(CmdMsg),
    /// Anything newer than this agent understands is ignored.
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MouseAction {
    Move,
    Down,
    Up,
    Wheel,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct MouseMsg {
    pub a: MouseAction,
    /// 0..1 across the shared screen.
    pub x: Option<f64>,
    pub y: Option<f64>,
    /// DOM button: 0 left, 1 middle, 2 right.
    #[serde(default)]
    pub b: u8,
    /// Wheel deltas in browser pixels.
    #[serde(default)]
    pub dx: i32,
    #[serde(default)]
    pub dy: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyAction {
    Down,
    Up,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct KeyMsg {
    pub a: KeyAction,
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub code: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct CmdMsg {
    pub name: String,
    pub url: Option<String>,
    pub app: Option<String>,
}

pub fn parse(raw: &str) -> Result<Message, String> {
    serde_json::from_str(raw).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_mouse() {
        let m = parse(r#"{"t":"mouse","a":"down","b":2,"x":0.5,"y":0.25}"#).unwrap();
        assert_eq!(
            m,
            Message::Mouse(MouseMsg { a: MouseAction::Down, x: Some(0.5), y: Some(0.25), b: 2, dx: 0, dy: 0 })
        );
    }

    #[test]
    fn parses_wheel_without_coordinates() {
        let m = parse(r#"{"t":"mouse","a":"wheel","dx":0,"dy":-120}"#).unwrap();
        assert!(matches!(m, Message::Mouse(MouseMsg { a: MouseAction::Wheel, dy: -120, x: None, .. })));
    }

    #[test]
    fn parses_key_and_ignores_extra_fields() {
        let m = parse(r#"{"t":"key","a":"down","key":"c","code":"KeyC","mods":{"ctrl":true}}"#).unwrap();
        assert_eq!(m, Message::Key(KeyMsg { a: KeyAction::Down, key: "c".into(), code: "KeyC".into() }));
    }

    #[test]
    fn parses_command() {
        let m = parse(r#"{"t":"cmd","name":"open_url","url":"https://example.com"}"#).unwrap();
        assert!(matches!(m, Message::Cmd(CmdMsg { ref name, .. }) if name == "open_url"));
    }

    #[test]
    fn unknown_types_are_tolerated() {
        assert_eq!(parse(r#"{"t":"clipboard","text":"x"}"#).unwrap(), Message::Unknown);
    }

    #[test]
    fn garbage_is_an_error() {
        assert!(parse("not json").is_err());
        assert!(parse(r#"{"t":"mouse","a":"teleport"}"#).is_err());
    }
}
