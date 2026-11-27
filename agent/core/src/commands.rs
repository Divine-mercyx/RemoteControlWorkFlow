//! Validation for technician commands. The technician already controls the
//! mouse and keyboard, so these checks are not a security boundary; they stop
//! malformed input from reaching the shell or the URL opener.

/// Only http(s) URLs, no control characters, bounded length.
pub fn validate_url(url: &str) -> Result<&str, String> {
    let url = url.trim();
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return Err("only http:// and https:// links can be opened".into());
    }
    if url.len() > 2048 || url.chars().any(|c| c.is_control() || c == ' ' || c == '"') {
        return Err("invalid URL".into());
    }
    Ok(url)
}

/// App names like `notepad`, `calc`, `msedge`, `ms-settings:`: letters, digits,
/// and `. _ - :` only, so nothing can be chained onto the shell command.
pub fn validate_app(app: &str) -> Result<&str, String> {
    let app = app.trim();
    let ok = !app.is_empty()
        && app.len() <= 64
        && !app.starts_with(['-', '.'])
        && app.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':'));
    if ok {
        Ok(app)
    } else {
        Err("app name may only contain letters, digits, '.', '_', '-' and ':'".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls() {
        assert!(validate_url("https://example.com/a?b=c").is_ok());
        assert!(validate_url("HTTP://example.com").is_ok());
        assert!(validate_url("file:///C:/Windows").is_err());
        assert!(validate_url("javascript:alert(1)").is_err());
        assert!(validate_url("https://x.com/\" & calc").is_err());
        assert!(validate_url("https://x.com/\nfoo").is_err());
    }

    #[test]
    fn apps() {
        for ok in ["notepad", "calc", "msedge", "ms-settings:", "excel.exe"] {
            assert!(validate_app(ok).is_ok(), "{ok}");
        }
        for bad in ["", "notepad & del x", "calc|x", "..\\x", "a b", "-x", "%COMSPEC%", "c\"x"] {
            assert!(validate_app(bad).is_err(), "{bad}");
        }
    }
}
