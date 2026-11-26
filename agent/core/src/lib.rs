//! Platform-independent pieces of the Nolt Support agent, kept out of the Tauri
//! crate so they can be unit-tested on any OS:
//! - `protocol`: messages the technician sends over the WebRTC "control" channel
//! - `keys`:     browser `KeyboardEvent.code`/`key` -> enigo keys
//! - `screen`:   normalised 0..1 coordinates -> physical pixels on the shared monitor
//! - `launch`:   finding the one-time join token (deep link or download file name)
//! - `commands`: validation for open_url / open_app
//! - `inject`:   applying input with enigo (and `SetCursorPos` on Windows)

pub mod commands;
pub mod inject;
pub mod keys;
pub mod launch;
pub mod protocol;
pub mod screen;
