//! How the agent learns which session to join:
//! 1. A `noltsupport://join?token=...` link (deep link, passed as a process argument), or
//! 2. The download's file name, `NoltSupport-<token>.exe` (the server names it that way),
//!    possibly with a browser-added suffix such as ` (1)`, or
//! 3. The user pasting the https join link into the app.

pub const SCHEME: &str = "noltsupport";
const FILE_PREFIX: &str = "noltsupport";

/// Join tokens are base64url, 32 characters from the server; allow some slack.
pub fn is_valid_token(t: &str) -> bool {
    (20..=128).contains(&t.len()) && t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// `noltsupport://join?token=abc` or `noltsupport://join/abc`.
pub fn token_from_deep_link(url: &str) -> Option<String> {
    let rest = strip_prefix_ci(url.trim(), &format!("{SCHEME}://"))?;
    let rest = rest.trim_end_matches('/');
    let candidate = if let Some((_, query)) = rest.split_once('?') {
        query.split('&').find_map(|kv| kv.strip_prefix("token="))?
    } else {
        rest.strip_prefix("join/")?
    };
    let candidate = candidate.split(['#', '/']).next()?;
    is_valid_token(candidate).then(|| candidate.to_string())
}

/// `https://support.example.com/join/<token>` pasted by the user.
pub fn token_from_join_url(url: &str) -> Option<String> {
    if let Some(t) = token_from_deep_link(url) {
        return Some(t);
    }
    let (_, after) = url.trim().split_once("/join/")?;
    let t = after.split(['?', '#', '/']).next()?;
    is_valid_token(t).then(|| t.to_string())
}

/// `NoltSupport-<token>.exe`, `NoltSupport-<token> (1).exe`.
pub fn token_from_file_name(name: &str) -> Option<String> {
    let stem = name.rsplit(['/', '\\']).next()?;
    let stem = match stem.rsplit_once('.') {
        Some((s, ext)) if ext.eq_ignore_ascii_case("exe") => s,
        Some(_) => return None,
        None => stem,
    };
    let rest = strip_prefix_ci(stem, FILE_PREFIX)?;
    let rest = rest.strip_prefix(['-', '_'])?;
    // Drop " (1)" style suffixes browsers add to repeated downloads.
    let rest = match rest.rsplit_once(" (") {
        Some((t, n)) if n.ends_with(')') && n[..n.len() - 1].bytes().all(|b| b.is_ascii_digit()) => t,
        _ => rest,
    };
    is_valid_token(rest).then(|| rest.to_string())
}

/// Token from process arguments (deep link) first, then from the exe's file name.
pub fn find_token(args: &[String], exe_file_name: &str) -> Option<String> {
    args.iter()
        .find_map(|a| token_from_deep_link(a))
        .or_else(|| token_from_file_name(exe_file_name))
}

fn strip_prefix_ci<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    let head = s.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix).then(|| &s[prefix.len()..])
}

#[cfg(test)]
mod tests {
    use super::*;

    const T: &str = "AbCdEfGhIjKlMnOpQrStUvWx-_0123456";

    #[test]
    fn deep_links() {
        assert_eq!(token_from_deep_link(&format!("noltsupport://join?token={T}")).as_deref(), Some(T));
        assert_eq!(token_from_deep_link(&format!("NoltSupport://join?x=1&token={T}&y=2")).as_deref(), Some(T));
        assert_eq!(token_from_deep_link(&format!("noltsupport://join/{T}/")).as_deref(), Some(T));
        assert_eq!(token_from_deep_link(&format!("https://evil/join?token={T}")), None);
        assert_eq!(token_from_deep_link("noltsupport://join?token=short"), None);
        assert_eq!(token_from_deep_link("noltsupport://join?token=bad%20chars%20here%20xxxxxxxx"), None);
    }

    #[test]
    fn file_names() {
        assert_eq!(token_from_file_name(&format!("NoltSupport-{T}.exe")).as_deref(), Some(T));
        assert_eq!(token_from_file_name(&format!("C:\\Users\\a\\Downloads\\NoltSupport-{T} (2).exe")).as_deref(), Some(T));
        assert_eq!(token_from_file_name(&format!("noltsupport_{T}.EXE")).as_deref(), Some(T));
        assert_eq!(token_from_file_name("NoltSupport.exe"), None);
        assert_eq!(token_from_file_name("nolt-support.exe"), None);
        assert_eq!(token_from_file_name(&format!("NoltSupport-{T}.pdf")), None);
    }

    #[test]
    fn pasted_join_urls() {
        assert_eq!(token_from_join_url(&format!(" https://support.nolt.app/join/{T}?utm=x ")).as_deref(), Some(T));
        assert_eq!(token_from_join_url("https://support.nolt.app/tech.html"), None);
    }

    #[test]
    fn deep_link_wins_over_file_name() {
        let other = "ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";
        let args = vec!["nolt-support.exe".to_string(), format!("noltsupport://join?token={other}")];
        assert_eq!(find_token(&args, &format!("NoltSupport-{T}.exe")).as_deref(), Some(other));
        assert_eq!(find_token(&args[..1], &format!("NoltSupport-{T}.exe")).as_deref(), Some(T));
    }
}
