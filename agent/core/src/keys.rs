use enigo::Key;

/// Map a browser key event to a key on the user's machine.
///
/// Physical keys (`KeyboardEvent.code`) are replayed rather than characters, so
/// shortcuts like Ctrl+C work and Shift is applied by the user's own layout.
/// On Windows, letters, digits and punctuation use virtual-key codes directly.
pub fn map_key(code: &str, key: &str) -> Option<Key> {
    if let Some(k) = named(code) {
        return Some(k);
    }
    if let Some(k) = physical(code) {
        return Some(k);
    }
    // Last resort: the produced character (e.g. keys with no `code`).
    let mut chars = key.chars();
    match (chars.next(), chars.next()) {
        (Some(c), None) => Some(Key::Unicode(c.to_ascii_lowercase())),
        _ => None,
    }
}

fn named(code: &str) -> Option<Key> {
    Some(match code {
        "Enter" | "NumpadEnter" => Key::Return,
        "Backspace" => Key::Backspace,
        "Tab" => Key::Tab,
        "Escape" => Key::Escape,
        "Space" => Key::Space,
        "Delete" => Key::Delete,
        "Home" => Key::Home,
        "End" => Key::End,
        "PageUp" => Key::PageUp,
        "PageDown" => Key::PageDown,
        "ArrowLeft" => Key::LeftArrow,
        "ArrowRight" => Key::RightArrow,
        "ArrowUp" => Key::UpArrow,
        "ArrowDown" => Key::DownArrow,
        "ShiftLeft" => Key::LShift,
        "ShiftRight" => Key::RShift,
        "ControlLeft" => Key::LControl,
        "ControlRight" => Key::RControl,
        "AltLeft" | "AltRight" => Key::Alt,
        "MetaLeft" | "MetaRight" | "OSLeft" | "OSRight" => Key::Meta,
        "CapsLock" => Key::CapsLock,
        "F1" => Key::F1,
        "F2" => Key::F2,
        "F3" => Key::F3,
        "F4" => Key::F4,
        "F5" => Key::F5,
        "F6" => Key::F6,
        "F7" => Key::F7,
        "F8" => Key::F8,
        "F9" => Key::F9,
        "F10" => Key::F10,
        "F11" => Key::F11,
        "F12" => Key::F12,
        _ => return None,
    })
}

/// Windows virtual-key code for a physical key, if it is a printable key.
pub fn windows_vk(code: &str) -> Option<u32> {
    if let Some(l) = code.strip_prefix("Key") {
        let c = single_char(l)?;
        return c.is_ascii_uppercase().then_some(c as u32); // VK_A..VK_Z = 'A'..'Z'
    }
    if let Some(d) = code.strip_prefix("Digit") {
        let c = single_char(d)?;
        return c.is_ascii_digit().then_some(c as u32); // VK_0..VK_9 = '0'..'9'
    }
    if let Some(d) = code.strip_prefix("Numpad") {
        if let Some(c) = single_char(d).filter(char::is_ascii_digit) {
            return Some(0x60 + (c as u32 - '0' as u32)); // VK_NUMPAD0..9
        }
    }
    Some(match code {
        "Semicolon" => 0xBA,
        "Equal" => 0xBB,
        "Comma" => 0xBC,
        "Minus" => 0xBD,
        "Period" => 0xBE,
        "Slash" => 0xBF,
        "Backquote" => 0xC0,
        "BracketLeft" => 0xDB,
        "Backslash" => 0xDC,
        "BracketRight" => 0xDD,
        "Quote" => 0xDE,
        "NumpadMultiply" => 0x6A,
        "NumpadAdd" => 0x6B,
        "NumpadSubtract" => 0x6D,
        "NumpadDecimal" => 0x6E,
        "NumpadDivide" => 0x6F,
        _ => return None,
    })
}

/// US-layout character for a physical key (used on non-Windows platforms).
fn us_char(code: &str) -> Option<char> {
    if let Some(l) = code.strip_prefix("Key") {
        return single_char(l).filter(char::is_ascii_uppercase).map(|c| c.to_ascii_lowercase());
    }
    if let Some(d) = code.strip_prefix("Digit").or_else(|| code.strip_prefix("Numpad")) {
        if let Some(c) = single_char(d).filter(char::is_ascii_digit) {
            return Some(c);
        }
    }
    Some(match code {
        "Semicolon" => ';',
        "Equal" => '=',
        "Comma" => ',',
        "Minus" => '-',
        "Period" => '.',
        "Slash" => '/',
        "Backquote" => '`',
        "BracketLeft" => '[',
        "Backslash" => '\\',
        "BracketRight" => ']',
        "Quote" => '\'',
        _ => return None,
    })
}

fn physical(code: &str) -> Option<Key> {
    if cfg!(windows) {
        windows_vk(code).map(Key::Other)
    } else {
        us_char(code).map(Key::Unicode)
    }
}

fn single_char(s: &str) -> Option<char> {
    let mut it = s.chars();
    match (it.next(), it.next()) {
        (Some(c), None) => Some(c),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn named_keys() {
        assert_eq!(map_key("Enter", "Enter"), Some(Key::Return));
        assert_eq!(map_key("ArrowLeft", "ArrowLeft"), Some(Key::LeftArrow));
        assert_eq!(map_key("ControlLeft", "Control"), Some(Key::LControl));
        assert_eq!(map_key("F5", "F5"), Some(Key::F5));
    }

    #[test]
    fn windows_virtual_keys() {
        assert_eq!(windows_vk("KeyA"), Some(0x41));
        assert_eq!(windows_vk("KeyZ"), Some(0x5A));
        assert_eq!(windows_vk("Digit0"), Some(0x30));
        assert_eq!(windows_vk("Numpad7"), Some(0x67));
        assert_eq!(windows_vk("Slash"), Some(0xBF));
        assert_eq!(windows_vk("Keya"), None);
        assert_eq!(windows_vk("KeyAB"), None);
        assert_eq!(windows_vk("Lang1"), None);
    }

    #[test]
    fn printable_keys_use_physical_position() {
        // Shift+A arrives as code KeyA / key "A": the key itself is still "a".
        let expected = if cfg!(windows) { Key::Other(0x41) } else { Key::Unicode('a') };
        assert_eq!(map_key("KeyA", "A"), Some(expected));
    }

    #[test]
    fn unknown_code_falls_back_to_character() {
        assert_eq!(map_key("", "é"), Some(Key::Unicode('é')));
        assert_eq!(map_key("Unidentified", "Dead"), None);
    }
}
