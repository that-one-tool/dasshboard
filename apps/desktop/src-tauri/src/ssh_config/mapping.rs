//! A parsed host as a `Device`, and the local defaults it falls back on.

use super::parse::ParsedHost;
use crate::device::{Auth, Connection, Device, X11Mode};

/// Expand a leading `~` (as `~/` or `~\`, or a bare `~`) to `home`. Any other
/// use of `~` (mid-path, or `~user`) is left untouched — we only special-case
/// the current user's home, which is what an `IdentityFile` overwhelmingly uses.
pub(crate) fn expand_tilde(path: &str, home: Option<&str>) -> String {
    let Some(home) = home else {
        return path.to_string();
    };
    if path == "~" {
        return home.to_string();
    }
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        let sep = if home.contains('\\') { '\\' } else { '/' };
        return format!("{home}{sep}{rest}");
    }
    path.to_string()
}

/// Map a parsed host to a `Device` (id left empty; the importer mints one, no
/// jump yet). The username falls back to the local login name when the
/// config omits `User`, mirroring OpenSSH; an `IdentityFile` becomes key auth
/// (`~` expanded), otherwise password auth with no stored secret.
pub(super) fn to_device(
    host: ParsedHost,
    default_user: Option<&str>,
    home: Option<&str>,
) -> Device {
    let x11_mode = x11_mode_of(&host);
    let username = host
        .user
        .or_else(|| default_user.map(str::to_string))
        .unwrap_or_default();
    let auth = auth_of(host.identity_file.as_deref(), home);
    let endpoint = (
        host.host_name.unwrap_or(host.name.clone()),
        host.port.unwrap_or(22),
        username,
    );
    let mut device = new_ssh_device(host.name, endpoint, auth);
    if let Connection::Ssh {
        forward_agent,
        x11_forwarding,
        ..
    } = &mut device.connection
    {
        *forward_agent = host.forward_agent.unwrap_or(false);
        *x11_forwarding = x11_mode;
    }
    device
}

/// Untrusted unless `ForwardX11Trusted yes`: OpenSSH's own default.
fn x11_mode_of(host: &ParsedHost) -> X11Mode {
    match (host.forward_x11, host.forward_x11_trusted) {
        (Some(true), Some(true)) => X11Mode::Trusted,
        (Some(true), _) => X11Mode::Untrusted,
        _ => X11Mode::Off,
    }
}

/// Key auth for an `IdentityFile` (`~` expanded), else password auth.
pub(super) fn auth_of(identity_file: Option<&str>, home: Option<&str>) -> Auth {
    match identity_file {
        Some(path) => Auth::Key {
            key_path: expand_tilde(path, home),
        },
        None => Auth::Password,
    }
}

/// A plain SSH device (no forwards, no jump, no agent forwarding).
pub(super) fn new_ssh_device(name: String, (host, port, username): HostKey, auth: Auth) -> Device {
    Device {
        id: String::new(),
        name,
        connection: Connection::Ssh {
            host,
            port,
            username,
            auth,
            forwards: Vec::new(),
            tunnel_auto_start: false,
            forward_agent: false,
            x11_forwarding: X11Mode::Off,
            proxy_jump: None,
        },
        auto_reconnect: false,
        tags: Vec::new(),
        connect_snippet: None,
    }
}

/// An SSH device's host (lowercased), port and username.
pub(super) type HostKey = (String, u16, String);

/// The identity key used to detect a duplicate on import: an SSH device is "the
/// same" as one already saved when host (case-insensitively), port and username
/// all match. Serial devices never collide with an imported SSH host.
pub(super) fn dedup_key(device: &Device) -> Option<HostKey> {
    match &device.connection {
        Connection::Ssh {
            host,
            port,
            username,
            ..
        } => Some((host.to_ascii_lowercase(), *port, username.clone())),
        // Non-SSH devices never collide with an imported SSH host.
        _ => None,
    }
}

/* ============================================================================
 * Environment helpers (read-only) — the local home dir and login name.
 * ============================================================================ */

/// The current user's home directory from the environment: `USERPROFILE` on
/// Windows, `HOME` elsewhere. Used only to expand `~` in a key path.
pub(crate) fn home_dir() -> Option<String> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .filter(|s| !s.is_empty())
}

/// The local login name from the environment (`USERNAME` on Windows, then
/// `USER` / `LOGNAME`). This is OpenSSH's default `User` when a host omits it.
pub(super) fn current_username() -> Option<String> {
    std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .or_else(|_| std::env::var("LOGNAME"))
        .ok()
        .filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssh_config::jump_spec::JumpSpec;
    use crate::ssh_config::parse::parse_hosts;

    fn imported_x11(lines: &str) -> X11Mode {
        let host = parse_hosts(&format!("Host a\n{lines}")).remove(0);
        to_device(host, None, None).x11_mode()
    }

    #[test]
    fn imports_x11_as_untrusted_unless_forward_x11_trusted_says_yes() {
        for (lines, expected) in [
            ("", X11Mode::Off),
            ("  ForwardX11 no\n  ForwardX11Trusted yes\n", X11Mode::Off),
            ("  ForwardX11 yes\n", X11Mode::Untrusted),
            (
                "  ForwardX11 TRUE\n  ForwardX11Trusted no\n",
                X11Mode::Untrusted,
            ),
            (
                "  ForwardX11 yes\n  ForwardX11Trusted yes\n",
                X11Mode::Trusted,
            ),
            (
                "  ForwardX11Trusted true\n  ForwardX11 yes\n",
                X11Mode::Trusted,
            ),
        ] {
            assert_eq!(imported_x11(lines), expected, "{lines}");
        }
    }

    #[test]
    fn the_first_x11_value_wins() {
        let lines =
            "  ForwardX11 yes\n  ForwardX11 no\n  ForwardX11Trusted yes\n  ForwardX11Trusted no\n";
        assert_eq!(imported_x11(lines), X11Mode::Trusted);
        let lines = "  ForwardX11 no\n  ForwardX11 yes\n";
        assert_eq!(imported_x11(lines), X11Mode::Off);
    }

    /* -- tilde expansion + mapping -------------------------------------- */

    #[test]
    fn expand_tilde_handles_unix_and_windows_and_bare() {
        assert_eq!(
            expand_tilde("~/.ssh/id", Some("/home/j")),
            "/home/j/.ssh/id"
        );
        assert_eq!(
            expand_tilde("~\\keys\\id", Some("C:\\Users\\j")),
            "C:\\Users\\j\\keys\\id"
        );
        assert_eq!(expand_tilde("~", Some("/home/j")), "/home/j");
        // No home available ⇒ untouched.
        assert_eq!(expand_tilde("~/.ssh/id", None), "~/.ssh/id");
        // Non-leading tilde ⇒ untouched.
        assert_eq!(expand_tilde("/etc/~x", Some("/home/j")), "/etc/~x");
    }

    #[test]
    fn identity_file_maps_to_key_auth_with_expanded_path() {
        let host = ParsedHost {
            name: "h".to_string(),
            aliases: vec!["h".to_string()],
            host_name: Some("h.example".to_string()),
            port: None,
            user: Some("me".to_string()),
            identity_file: Some("~/.ssh/id_ed25519".to_string()),
            forward_agent: None,
            forward_x11: None,
            forward_x11_trusted: None,
            jump: JumpSpec::Direct,
        };
        let device = to_device(host, None, Some("/home/j"));
        match device.connection {
            Connection::Ssh { auth, port, .. } => {
                assert_eq!(port, 22, "missing Port defaults to 22");
                assert_eq!(
                    auth,
                    Auth::Key {
                        key_path: "/home/j/.ssh/id_ed25519".to_string()
                    }
                );
            }
            other => panic!("expected SSH, got {other:?}"),
        }
    }

    #[test]
    fn missing_user_falls_back_to_local_login_name() {
        let host = ParsedHost {
            name: "h".to_string(),
            aliases: vec!["h".to_string()],
            host_name: Some("h.example".to_string()),
            port: None,
            user: None,
            identity_file: None,
            forward_agent: None,
            forward_x11: None,
            forward_x11_trusted: None,
            jump: JumpSpec::Direct,
        };
        let device = to_device(host, Some("localjoe"), None);
        match device.connection {
            Connection::Ssh { username, auth, .. } => {
                assert_eq!(username, "localjoe");
                assert_eq!(auth, Auth::Password, "no IdentityFile ⇒ password auth");
            }
            other => panic!("expected SSH, got {other:?}"),
        }
    }

    #[test]
    fn host_name_defaults_to_the_alias_when_absent() {
        let host = ParsedHost {
            name: "onlyalias".to_string(),
            aliases: vec!["onlyalias".to_string()],
            host_name: None,
            port: None,
            user: Some("me".to_string()),
            identity_file: None,
            forward_agent: None,
            forward_x11: None,
            forward_x11_trusted: None,
            jump: JumpSpec::Direct,
        };
        let device = to_device(host, None, None);
        match device.connection {
            Connection::Ssh { host, .. } => assert_eq!(host, "onlyalias"),
            other => panic!("expected SSH, got {other:?}"),
        }
    }
}
