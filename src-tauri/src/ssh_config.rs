//! Import SSH devices from an OpenSSH client config (`~/.ssh/config`).
//!
//! This is a *one-way, best-effort* importer: it reads a user's existing
//! `ssh` config and turns each concrete `Host` block into a DaSSHboard SSH
//! device, so someone who already keeps their servers in `~/.ssh/config`
//! doesn't have to re-enter them by hand. It is deliberately lenient — an
//! external, hand-edited file is messy — so unlike the strict JSON importer in
//! [`crate::transfer`], a host that can't be turned into a valid device is
//! *skipped and counted*, never a hard failure that aborts the whole import.
//!
//! Scope (v1): the keywords that map onto our `Device` model —
//! `Host` / `HostName` / `Port` / `User` / `IdentityFile`. Everything else
//! (`ProxyJump`, `ForwardAgent`, `Include`, `Match`, …) is ignored: a `Match`
//! block ends attribution to the preceding host (its keywords are skipped until
//! the next `Host`), and `Include` directives are not followed. Wildcard host
//! patterns (`Host *`, `Host foo?`) describe defaults, not a concrete server,
//! so they never produce a device.
//!
//! Secrets: an `ssh` config never contains a password, so a host with an
//! `IdentityFile` becomes **key** auth (that path, `~` expanded) and a host
//! without one becomes **password** auth with *no* stored secret — the user
//! fills it in later by editing the device. Nothing is ever written to the
//! keyring by an import.

use std::collections::HashSet;
use std::fs;
use std::path::Path;

use serde::Serialize;

use crate::device::{Auth, Connection, Device};
use crate::error::AppError;
use crate::state::AppState;

/// Outcome of an SSH-config import, returned to the frontend so it can report
/// how many devices were added versus skipped (a wildcard/`Match`-only block,
/// an entry that produced no valid device, or a duplicate of one already saved).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshImportSummary {
    /// Devices actually upserted into the store.
    pub imported: u32,
    /// Hosts parsed but not imported: invalid (e.g. no resolvable username) or
    /// a duplicate of an existing / already-imported device.
    pub skipped: u32,
}

/// One `Host` block reduced to the fields we can map onto a `Device`. Built by
/// the pure parser ([`parse_hosts`]) with no disk or environment access, so the
/// parsing rules are unit-testable in isolation.
#[derive(Debug, Clone, PartialEq)]
struct ParsedHost {
    /// The alias that names the device (first non-wildcard token of `Host`).
    name: String,
    /// `HostName` if given, else the alias — the address we actually dial.
    host_name: Option<String>,
    /// `Port` if given and parseable; `None` ⇒ the SSH default (22).
    port: Option<u16>,
    /// `User` if given; `None` ⇒ fall back to the local login name at map time.
    user: Option<String>,
    /// First `IdentityFile` if given ⇒ key auth; `None` ⇒ password auth.
    identity_file: Option<String>,
}

/* ============================================================================
 * Pure parsing (no disk / no env) — unit-testable.
 * ============================================================================ */

/// Split an SSH-config line into `(keyword_lowercased, value)`. Keywords are
/// case-insensitive and the separator may be whitespace or `=` (both
/// `Port 22` and `Port=22` are valid), optionally with surrounding spaces.
/// Returns `None` for a blank or comment (`#`) line.
fn split_keyword(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }
    // Keyword ends at the first whitespace or '='; the value is the remainder
    // with a single leading '=' (and surrounding whitespace) stripped.
    let split_at = trimmed.find(|c: char| c.is_whitespace() || c == '=')?;
    let keyword = trimmed[..split_at].to_ascii_lowercase();
    let rest = trimmed[split_at..].trim_start();
    let value = rest.strip_prefix('=').unwrap_or(rest).trim();
    Some((keyword, unquote(value).to_string()))
}

/// Strip one layer of matching surrounding quotes from an SSH-config value
/// (`"my host"` → `my host`). Values without quotes pass through untouched.
fn unquote(value: &str) -> &str {
    let bytes = value.as_bytes();
    if value.len() >= 2
        && ((bytes[0] == b'"' && bytes[value.len() - 1] == b'"')
            || (bytes[0] == b'\'' && bytes[value.len() - 1] == b'\''))
    {
        &value[1..value.len() - 1]
    } else {
        value
    }
}

/// Pick the alias that will name the device from a `Host` line's patterns: the
/// first token that is neither negated (`!foo`) nor a wildcard (`*`/`?`).
/// Returns `None` for a wildcard-only line (e.g. `Host *`), which describes
/// defaults rather than a concrete server and so yields no device.
fn first_concrete_alias(patterns: &str) -> Option<String> {
    patterns
        .split_whitespace()
        .find(|p| !p.starts_with('!') && !p.contains('*') && !p.contains('?'))
        .map(str::to_string)
}

/// Parse config text into the concrete hosts it describes, in file order.
///
/// State machine over lines: a `Host` line finalizes the block being built and
/// starts a new one (or, for a wildcard-only line, a "sink" that swallows and
/// discards keywords until the next `Host`). A `Match` line likewise ends
/// attribution to the current host. Between them, the mappable keywords fill
/// the current block; the first value wins for single-valued keywords, matching
/// OpenSSH's "earliest obtained value" rule.
fn parse_hosts(contents: &str) -> Vec<ParsedHost> {
    let mut hosts = Vec::new();
    // The block currently being filled. `None` means "not inside an importable
    // Host" (before the first Host, or inside a wildcard-only / Match section).
    let mut current: Option<ParsedHost> = None;

    for line in contents.lines() {
        let Some((keyword, value)) = split_keyword(line) else {
            continue;
        };
        match keyword.as_str() {
            "host" => {
                if let Some(done) = current.take() {
                    hosts.push(done);
                }
                current = first_concrete_alias(&value).map(|name| ParsedHost {
                    name,
                    host_name: None,
                    port: None,
                    user: None,
                    identity_file: None,
                });
            }
            "match" => {
                // A Match block's settings are conditional; we don't model them.
                // End the current host so nothing after it is misattributed.
                if let Some(done) = current.take() {
                    hosts.push(done);
                }
            }
            "hostname" | "port" | "user" | "identityfile" => {
                if let Some(host) = current.as_mut() {
                    apply_keyword(host, &keyword, value);
                }
            }
            _ => {} // ignored keyword
        }
    }
    if let Some(done) = current.take() {
        hosts.push(done);
    }
    hosts
}

/// Apply one mappable keyword to the block under construction. Single-valued
/// fields keep their first value (`is_none()` guard) to mirror OpenSSH, where
/// the first setting obtained for a parameter is the one used. An unparseable
/// `Port` is dropped (leaving the default) rather than aborting the host.
fn apply_keyword(host: &mut ParsedHost, keyword: &str, value: String) {
    match keyword {
        "hostname" if host.host_name.is_none() && !value.is_empty() => {
            host.host_name = Some(value);
        }
        "port" if host.port.is_none() => {
            if let Ok(port) = value.parse::<u16>() {
                host.port = Some(port);
            }
        }
        "user" if host.user.is_none() && !value.is_empty() => {
            host.user = Some(value);
        }
        "identityfile" if host.identity_file.is_none() && !value.is_empty() => {
            host.identity_file = Some(value);
        }
        _ => {}
    }
}

/// Expand a leading `~` (as `~/` or `~\`, or a bare `~`) to `home`. Any other
/// use of `~` (mid-path, or `~user`) is left untouched — we only special-case
/// the current user's home, which is what an `IdentityFile` overwhelmingly uses.
fn expand_tilde(path: &str, home: Option<&str>) -> String {
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

/// Map a parsed host to a `Device` (id left empty so the store mints a fresh
/// UUID on upsert). The username falls back to the local login name when the
/// config omits `User`, mirroring OpenSSH; an `IdentityFile` becomes key auth
/// (`~` expanded), otherwise password auth with no stored secret.
fn to_device(host: ParsedHost, default_user: Option<&str>, home: Option<&str>) -> Device {
    let username = host
        .user
        .or_else(|| default_user.map(str::to_string))
        .unwrap_or_default();
    let auth = match host.identity_file {
        Some(path) => Auth::Key {
            key_path: expand_tilde(&path, home),
        },
        None => Auth::Password,
    };
    Device {
        id: String::new(),
        name: host.name.clone(),
        connection: Connection::Ssh {
            host: host.host_name.unwrap_or(host.name),
            port: host.port.unwrap_or(22),
            username,
            auth,
            forwards: Vec::new(),
            tunnel_auto_start: false,
        },
        auto_reconnect: false,
    }
}

/// The identity key used to detect a duplicate on import: an SSH device is "the
/// same" as one already saved when host (case-insensitively), port and username
/// all match. Serial devices never collide with an imported SSH host.
fn dedup_key(device: &Device) -> Option<(String, u16, String)> {
    match &device.connection {
        Connection::Ssh {
            host,
            port,
            username,
            ..
        } => Some((host.to_ascii_lowercase(), *port, username.clone())),
        Connection::Serial { .. } => None,
    }
}

/* ============================================================================
 * Environment helpers (read-only) — the local home dir and login name.
 * ============================================================================ */

/// The current user's home directory from the environment: `USERPROFILE` on
/// Windows, `HOME` elsewhere. Used only to expand `~` in an `IdentityFile`.
fn home_dir() -> Option<String> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .filter(|s| !s.is_empty())
}

/// The local login name from the environment (`USERNAME` on Windows, then
/// `USER` / `LOGNAME`). This is OpenSSH's default `User` when a host omits it.
fn current_username() -> Option<String> {
    std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .or_else(|_| std::env::var("LOGNAME"))
        .ok()
        .filter(|s| !s.is_empty())
}

/* ============================================================================
 * Impl function (disk I/O) — testable with a hand-built AppState.
 * ============================================================================ */

/// Read `path`, parse the hosts, and upsert each into the device store,
/// skipping any that don't validate or that duplicate an existing/just-imported
/// device. A missing/unreadable file surfaces as `AppError::Io`; parsing itself
/// never fails. Returns the imported/skipped counts. Thin wrapper that resolves
/// the environment-derived defaults (login name, home dir) once and hands the
/// rest to [`import_hosts`], which takes them as parameters so it is testable
/// without mutating process-global environment variables.
pub(crate) fn import_ssh_config_impl(
    state: &AppState,
    path: &Path,
) -> Result<SshImportSummary, AppError> {
    let contents = fs::read_to_string(path)?;
    let hosts = parse_hosts(&contents);
    import_hosts(
        state,
        hosts,
        current_username().as_deref(),
        home_dir().as_deref(),
    )
}

/// Map each parsed host to a device and upsert it, skipping invalid hosts (e.g.
/// no resolvable username) and duplicates. `default_user`/`home` are passed in
/// (rather than read from the environment here) so this — the part with the
/// interesting branching — is unit-testable with fixed inputs.
fn import_hosts(
    state: &AppState,
    hosts: Vec<ParsedHost>,
    default_user: Option<&str>,
    home: Option<&str>,
) -> Result<SshImportSummary, AppError> {
    // Seed the seen-set from existing devices so a re-import is idempotent, then
    // grow it as we import so two identical hosts within the file don't both land.
    let mut seen: HashSet<(String, u16, String)> = state
        .device_store
        .list()
        .iter()
        .filter_map(dedup_key)
        .collect();

    let mut summary = SshImportSummary {
        imported: 0,
        skipped: 0,
    };
    for host in hosts {
        let device = to_device(host, default_user, home);
        if device.validate().is_err() {
            summary.skipped += 1;
            continue;
        }
        // A duplicate of an existing or already-imported device (same
        // host/port/user) is skipped, keeping a re-import idempotent.
        if let Some(key) = dedup_key(&device) {
            if !seen.insert(key) {
                summary.skipped += 1;
                continue;
            }
        }
        state.device_store.upsert(device)?;
        summary.imported += 1;
    }
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use crate::known_hosts::KnownHostsStore;
    use crate::profile_store::ProfileStore;
    use crate::secret::InMemorySecretStore;
    use crate::serial::SerialSessionManager;
    use crate::session::SessionManager;
    use crate::settings::SettingsStore;
    use crate::store::DeviceStore;
    use crate::tunnel::TunnelManager;
    use tempfile::tempdir;

    /// Same store stack the `transfer`/`commands` tests use: real temp-dir
    /// stores plus an in-memory keyring, no Tauri runtime required.
    fn test_state(dir: &std::path::Path) -> AppState {
        let known_hosts = Arc::new(KnownHostsStore::load(dir.to_path_buf()));
        let session_manager = Arc::new(SessionManager::with_defaults(known_hosts));
        let tunnel_manager = Arc::new(TunnelManager::with_defaults(session_manager.known_hosts()));
        let sftp_manager = Arc::new(crate::sftp::SftpManager::with_defaults(
            session_manager.known_hosts(),
        ));
        AppState {
            device_store: DeviceStore::load(dir.to_path_buf()),
            profile_store: ProfileStore::load(dir.to_path_buf()),
            settings_store: SettingsStore::load(dir.to_path_buf()),
            secret_store: Arc::new(InMemorySecretStore::new()),
            session_manager,
            tunnel_manager,
            sftp_manager,
            serial_manager: Arc::new(SerialSessionManager::new()),
        }
    }

    /* -- pure parser ---------------------------------------------------- */

    #[test]
    fn parses_a_basic_host_block() {
        let cfg = "\
Host nas
    HostName 192.168.1.10
    User admin
    Port 2222
";
        let hosts = parse_hosts(cfg);
        assert_eq!(
            hosts,
            vec![ParsedHost {
                name: "nas".to_string(),
                host_name: Some("192.168.1.10".to_string()),
                port: Some(2222),
                user: Some("admin".to_string()),
                identity_file: None,
            }]
        );
    }

    #[test]
    fn keywords_are_case_insensitive_and_accept_equals_separator() {
        let cfg = "HOST=box\n  hostname=example.com\n  PORT = 22\n";
        let hosts = parse_hosts(cfg);
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].name, "box");
        assert_eq!(hosts[0].host_name.as_deref(), Some("example.com"));
        assert_eq!(hosts[0].port, Some(22));
    }

    #[test]
    fn comments_and_blank_lines_are_ignored() {
        let cfg = "# a comment\n\nHost web\n  # inline note\n  HostName w.example\n";
        let hosts = parse_hosts(cfg);
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].host_name.as_deref(), Some("w.example"));
    }

    #[test]
    fn wildcard_only_host_blocks_produce_no_device() {
        // `Host *` describes defaults, not a server — and its keywords must not
        // bleed into a following concrete host.
        let cfg = "\
Host *
    User default
    IdentityFile ~/.ssh/id_ed25519

Host real
    HostName r.example
";
        let hosts = parse_hosts(cfg);
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].name, "real");
        assert_eq!(hosts[0].user, None, "wildcard defaults must not leak");
        assert_eq!(hosts[0].identity_file, None);
    }

    #[test]
    fn first_concrete_alias_of_a_multi_pattern_host_names_the_device() {
        // A negated/wildcard leading pattern is skipped; the first concrete
        // alias wins.
        let cfg = "Host *.internal !bad good\n  HostName g.example\n";
        let hosts = parse_hosts(cfg);
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].name, "good");
    }

    #[test]
    fn match_block_ends_attribution_to_the_previous_host() {
        let cfg = "\
Host keep
    HostName k.example
Match host *.corp
    User corpuser
";
        let hosts = parse_hosts(cfg);
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].name, "keep");
        assert_eq!(
            hosts[0].user, None,
            "Match keywords must not attach to keep"
        );
    }

    #[test]
    fn first_value_wins_for_single_valued_keywords() {
        let cfg =
            "Host h\n  HostName first\n  HostName second\n  IdentityFile a\n  IdentityFile b\n";
        let hosts = parse_hosts(cfg);
        assert_eq!(hosts[0].host_name.as_deref(), Some("first"));
        assert_eq!(hosts[0].identity_file.as_deref(), Some("a"));
    }

    #[test]
    fn unparseable_port_is_dropped_leaving_the_default() {
        let cfg = "Host h\n  HostName x\n  Port not-a-number\n";
        let hosts = parse_hosts(cfg);
        assert_eq!(hosts[0].port, None);
    }

    #[test]
    fn quoted_values_are_unquoted() {
        let cfg = "Host h\n  HostName \"my.host\"\n";
        assert_eq!(parse_hosts(cfg)[0].host_name.as_deref(), Some("my.host"));
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
            host_name: Some("h.example".to_string()),
            port: None,
            user: Some("me".to_string()),
            identity_file: Some("~/.ssh/id_ed25519".to_string()),
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
            host_name: Some("h.example".to_string()),
            port: None,
            user: None,
            identity_file: None,
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
            host_name: None,
            port: None,
            user: Some("me".to_string()),
            identity_file: None,
        };
        let device = to_device(host, None, None);
        match device.connection {
            Connection::Ssh { host, .. } => assert_eq!(host, "onlyalias"),
            other => panic!("expected SSH, got {other:?}"),
        }
    }

    /* -- import impl (disk) --------------------------------------------- */

    #[test]
    fn import_creates_devices_and_reports_counts() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        let cfg = "\
Host nas
    HostName 192.168.1.10
    User admin
    Port 2222

Host web
    HostName web.example
    User deploy
    IdentityFile ~/.ssh/id_ed25519
";
        let file = dir.path().join("config");
        fs::write(&file, cfg).unwrap();

        let summary = import_ssh_config_impl(&state, &file).unwrap();
        assert_eq!(summary.imported, 2);
        assert_eq!(summary.skipped, 0);

        let devices = state.device_store.list();
        assert_eq!(devices.len(), 2);
        let nas = devices.iter().find(|d| d.name == "nas").unwrap();
        match &nas.connection {
            Connection::Ssh {
                host,
                port,
                username,
                auth,
                ..
            } => {
                assert_eq!(host, "192.168.1.10");
                assert_eq!(*port, 2222);
                assert_eq!(username, "admin");
                assert_eq!(*auth, Auth::Password);
            }
            other => panic!("expected SSH, got {other:?}"),
        }
    }

    #[test]
    fn import_is_idempotent_by_host_port_user() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        let cfg = "Host nas\n  HostName 192.168.1.10\n  User admin\n";
        let file = dir.path().join("config");
        fs::write(&file, cfg).unwrap();

        let first = import_ssh_config_impl(&state, &file).unwrap();
        assert_eq!((first.imported, first.skipped), (1, 0));
        // Re-importing the same file must not duplicate the device.
        let second = import_ssh_config_impl(&state, &file).unwrap();
        assert_eq!((second.imported, second.skipped), (0, 1));
        assert_eq!(state.device_store.list().len(), 1);
    }

    #[test]
    fn import_skips_duplicate_hosts_within_one_file() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        // Two aliases resolving to the same host:port:user — one device.
        let cfg = "\
Host a
    HostName same.example
    User me
Host b
    HostName same.example
    User me
";
        let file = dir.path().join("config");
        fs::write(&file, cfg).unwrap();

        let summary = import_ssh_config_impl(&state, &file).unwrap();
        assert_eq!((summary.imported, summary.skipped), (1, 1));
        assert_eq!(state.device_store.list().len(), 1);
    }

    #[test]
    fn import_skips_a_host_with_no_resolvable_username() {
        // No `User` in the file and no login name available ⇒ the device fails
        // validation (empty username) and is skipped, not fatal. Driven through
        // `import_hosts` with `default_user = None` so the test needs no
        // process-env mutation.
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        let hosts = parse_hosts("Host nouser\n  HostName h.example\n");
        let summary = import_hosts(&state, hosts, None, None).unwrap();
        assert_eq!((summary.imported, summary.skipped), (0, 1));
        assert!(state.device_store.list().is_empty());
    }

    #[test]
    fn import_of_missing_file_is_an_io_error() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        let err = import_ssh_config_impl(&state, &dir.path().join("nope")).unwrap_err();
        assert!(matches!(err, AppError::Io(_)));
    }
}
