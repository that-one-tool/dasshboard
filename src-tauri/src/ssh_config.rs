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

use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
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

/// Outcome of an SSH-config *export*, returned to the frontend so it can report
/// how many devices were written versus skipped (a non-SSH device — serial or
/// local shell — has no `ssh` config representation and is left out).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshExportSummary {
    /// SSH devices written as `Host` blocks.
    pub exported: u32,
    /// Non-SSH devices (serial / local shell) skipped — they have no `ssh`
    /// config equivalent.
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
            forward_agent: false,
            proxy_jump: None,
        },
        auto_reconnect: false,
        tags: Vec::new(),
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
        // Non-SSH devices never collide with an imported SSH host.
        _ => None,
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

/* ============================================================================
 * Export: DaSSHboard devices → OpenSSH client config (the reverse of import).
 * ============================================================================ */

/// Turn a device name into a safe `Host` alias token: SSH config splits `Host`
/// patterns on whitespace, so a name with spaces (`"My NAS"`) would become two
/// patterns. Collapse whitespace runs to `-`, and fall back to `"device"` for a
/// name that is empty once trimmed (never happens for a validated device, but
/// keeps the output well-formed regardless).
fn sanitize_alias(name: &str) -> String {
    let joined = name.split_whitespace().collect::<Vec<_>>().join("-");
    // Drop any remaining control chars / double-quotes so the `Host` line is a
    // single safe token even for a name that arrived via JSON import (which
    // bypasses the UI's single-line inputs).
    let cleaned: String = joined
        .chars()
        .filter(|c| !c.is_control() && *c != '"')
        .collect();
    if cleaned.is_empty() {
        "device".to_string()
    } else {
        cleaned
    }
}

/// Render a keyword's value as a single safe OpenSSH-config token. Two layers:
/// (1) strip control characters and embedded double-quotes — a newline would
/// terminate the line and let the remainder inject a directive (e.g.
/// `ProxyCommand`) into a file the system `ssh` executes, and OpenSSH's
/// quoted-token parser can't represent an embedded `"`; (2) wrap the result in
/// double quotes when it contains whitespace, `#` or `=` (or is empty) so a path
/// with spaces (`C:\Users\John Doe\...`, common on Windows) parses as one token.
/// `Device::validate` already rejects control chars in these fields for saved
/// devices; this is the belt-and-suspenders at the file-writing boundary.
fn quote_config_value(value: &str) -> String {
    let cleaned: String = value
        .chars()
        .filter(|c| !c.is_control() && *c != '"')
        .collect();
    let needs_quotes = cleaned.is_empty()
        || cleaned
            .chars()
            .any(|c| c.is_whitespace() || c == '#' || c == '=');
    if needs_quotes {
        format!("\"{cleaned}\"")
    } else {
        cleaned
    }
}

/// Assign each SSH device a unique `Host` alias, keyed by device id. Aliases are
/// sanitized names (see [`sanitize_alias`]); a collision gets a `-2`, `-3`, …
/// suffix so every block names a distinct host and `ProxyJump` references
/// resolve unambiguously. Non-SSH devices get no alias (they aren't exported).
fn assign_aliases(devices: &[Device]) -> HashMap<String, String> {
    let mut used: HashSet<String> = HashSet::new();
    let mut by_id: HashMap<String, String> = HashMap::new();
    for device in devices {
        if !matches!(device.connection, Connection::Ssh { .. }) {
            continue;
        }
        let base = sanitize_alias(&device.name);
        let mut alias = base.clone();
        let mut n = 2;
        while !used.insert(alias.clone()) {
            alias = format!("{base}-{n}");
            n += 1;
        }
        by_id.insert(device.id.clone(), alias);
    }
    by_id
}

/// Render one SSH device as an OpenSSH `Host` block, appending to `out`. Emits
/// only the keywords our model carries and the importer round-trips: `HostName`,
/// `Port` (only when non-default), `User`, `IdentityFile` (for key auth),
/// `ProxyJump` (as the jump host's alias, when it resolves to an exported SSH
/// device) and `ForwardAgent yes` (when enabled). A password never appears — it
/// lives only in the OS keyring, never in the device — so an exported host with
/// password auth simply has no credential line, exactly like a fresh `ssh`
/// config entry.
fn write_host_block(
    out: &mut String,
    device: &Device,
    alias: &str,
    aliases: &HashMap<String, String>,
) {
    let Connection::Ssh {
        host,
        port,
        username,
        auth,
        proxy_jump,
        forward_agent,
        ..
    } = &device.connection
    else {
        return;
    };

    let _ = writeln!(out, "Host {alias}");
    let _ = writeln!(out, "    HostName {}", quote_config_value(host));
    if *port != 22 {
        let _ = writeln!(out, "    Port {port}");
    }
    if !username.is_empty() {
        let _ = writeln!(out, "    User {}", quote_config_value(username));
    }
    if let Auth::Key { key_path } = auth {
        let _ = writeln!(out, "    IdentityFile {}", quote_config_value(key_path));
    }
    // A ProxyJump only round-trips if the referenced device is itself an exported
    // SSH device; a jump pointing at a since-deleted or non-SSH device is dropped
    // (an unresolvable `ProxyJump` alias would make `ssh` fail on this host).
    if let Some(jump_id) = proxy_jump {
        if let Some(jump_alias) = aliases.get(jump_id) {
            let _ = writeln!(out, "    ProxyJump {jump_alias}");
        }
    }
    if *forward_agent {
        let _ = writeln!(out, "    ForwardAgent yes");
    }
}

/// Serialize every SSH device to OpenSSH client-config text. Non-SSH devices are
/// skipped (they have no `ssh` representation). Blocks are separated by a blank
/// line and preceded by a provenance header comment. Pure (no disk/env), so the
/// formatting is unit-testable in isolation.
fn devices_to_ssh_config(devices: &[Device]) -> String {
    let aliases = assign_aliases(devices);
    let mut out = String::from("# Written by DaSSHboard — OpenSSH client config export\n");
    for device in devices {
        if let Some(alias) = aliases.get(&device.id) {
            out.push('\n');
            write_host_block(&mut out, device, alias, &aliases);
        }
    }
    out
}

/// Write every SSH device to `path` as OpenSSH client-config text (overwriting
/// any existing file), skipping non-SSH devices. Returns the exported/skipped
/// counts. A write failure surfaces as `AppError::Io`.
pub(crate) fn export_ssh_config_impl(
    state: &AppState,
    path: &Path,
) -> Result<SshExportSummary, AppError> {
    let devices = state.device_store.list();
    let exported = devices
        .iter()
        .filter(|d| matches!(d.connection, Connection::Ssh { .. }))
        .count() as u32;
    let skipped = devices.len() as u32 - exported;
    fs::write(path, devices_to_ssh_config(&devices))?;
    // The file lists hosts/users/key paths and typically lands under `~/.ssh`;
    // make it owner-only on Unix, matching how `ssh` treats its own config.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(SshExportSummary { exported, skipped })
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
            workspace_store: crate::workspace_store::WorkspaceStore::load(dir.to_path_buf()),
            secret_store: Arc::new(InMemorySecretStore::new()),
            session_manager,
            tunnel_manager,
            sftp_manager,
            serial_manager: Arc::new(SerialSessionManager::new()),
            local_shell_manager: Arc::new(crate::local_shell::LocalShellManager::new()),
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

    /* -- export (devices → ssh config) ---------------------------------- */

    /// Build an SSH device with an explicit id/name and connection knobs.
    fn ssh_device(id: &str, name: &str, connection: Connection) -> Device {
        Device {
            id: id.to_string(),
            name: name.to_string(),
            connection,
            auto_reconnect: false,
            tags: Vec::new(),
        }
    }

    /// A key-auth SSH connection with the given knobs (defaults elsewhere).
    fn ssh_conn(
        host: &str,
        port: u16,
        user: &str,
        auth: Auth,
        proxy_jump: Option<String>,
        forward_agent: bool,
    ) -> Connection {
        Connection::Ssh {
            host: host.to_string(),
            port,
            username: user.to_string(),
            auth,
            forwards: Vec::new(),
            tunnel_auto_start: false,
            proxy_jump,
            forward_agent,
        }
    }

    #[test]
    fn export_writes_a_full_host_block_with_key_auth() {
        let device = ssh_device(
            "id1",
            "nas",
            ssh_conn(
                "192.168.1.10",
                2222,
                "admin",
                Auth::Key {
                    key_path: "~/.ssh/id_ed25519".to_string(),
                },
                None,
                true,
            ),
        );
        let out = devices_to_ssh_config(&[device]);
        assert!(out.contains("Host nas\n"));
        assert!(out.contains("    HostName 192.168.1.10\n"));
        assert!(out.contains("    Port 2222\n"));
        assert!(out.contains("    User admin\n"));
        assert!(out.contains("    IdentityFile ~/.ssh/id_ed25519\n"));
        assert!(out.contains("    ForwardAgent yes\n"));
    }

    #[test]
    fn export_omits_default_port_and_password_credentials() {
        // Port 22 and password auth ⇒ no Port line, no credential line at all
        // (the password lives only in the keyring, never in the config).
        let device = ssh_device(
            "id1",
            "web",
            ssh_conn("web.example", 22, "deploy", Auth::Password, None, false),
        );
        let out = devices_to_ssh_config(&[device]);
        assert!(out.contains("HostName web.example"));
        assert!(!out.contains("Port"), "default port must be omitted");
        assert!(!out.contains("IdentityFile"));
        assert!(!out.contains("ForwardAgent"));
    }

    #[test]
    fn export_sanitizes_and_deduplicates_host_aliases() {
        // Two devices whose names collapse to the same alias get distinct blocks.
        let a = ssh_device(
            "a",
            "My NAS",
            ssh_conn("h1", 22, "u", Auth::Password, None, false),
        );
        let b = ssh_device(
            "b",
            "My  NAS",
            ssh_conn("h2", 22, "u", Auth::Password, None, false),
        );
        let out = devices_to_ssh_config(&[a, b]);
        assert!(out.contains("Host My-NAS\n"), "spaces collapse to dashes");
        assert!(out.contains("Host My-NAS-2\n"), "a collision is suffixed");
    }

    #[test]
    fn export_quotes_values_containing_spaces() {
        // A Windows key path with a space must be quoted so `ssh` reads it as one
        // token instead of truncating at the space.
        let device = ssh_device(
            "id1",
            "win",
            ssh_conn(
                "host.example",
                22,
                "admin",
                Auth::Key {
                    key_path: r"C:\Users\John Doe\.ssh\id_ed25519".to_string(),
                },
                None,
                false,
            ),
        );
        let out = devices_to_ssh_config(&[device]);
        assert!(out.contains("    IdentityFile \"C:\\Users\\John Doe\\.ssh\\id_ed25519\"\n"));
    }

    #[test]
    fn export_neutralizes_control_chars_in_values() {
        // Defense-in-depth at the file-writing boundary: even if a device with a
        // newline in its host slipped past validation, the exporter must not emit
        // an injected directive. The formatter strips the newline, so no line
        // begins with the injected `ProxyCommand`.
        let device = ssh_device(
            "id1",
            "evil",
            ssh_conn(
                "example.com\n    ProxyCommand calc",
                22,
                "admin",
                Auth::Password,
                None,
                false,
            ),
        );
        let out = devices_to_ssh_config(&[device]);
        assert!(
            !out.lines()
                .any(|l| l.trim_start().starts_with("ProxyCommand")),
            "a newline in HostName must not inject a directive: {out:?}"
        );
    }

    #[test]
    fn export_then_import_drops_proxy_jump_and_forward_agent() {
        // Documents the known (intentional) round-trip loss: the exporter writes
        // ProxyJump/ForwardAgent, but the v1 importer ignores those keywords, so
        // they do not survive export→import. A change here is a deliberate scope
        // decision, not an accidental regression.
        let src_dir = tempdir().unwrap();
        let src = test_state(src_dir.path());
        src.device_store
            .upsert(ssh_device(
                "",
                "bastion",
                ssh_conn("b.example", 22, "root", Auth::Password, None, false),
            ))
            .unwrap();
        let bastion_id = src.device_store.list()[0].id.clone();
        src.device_store
            .upsert(ssh_device(
                "",
                "target",
                ssh_conn(
                    "10.0.0.5",
                    22,
                    "app",
                    Auth::Password,
                    Some(bastion_id),
                    true,
                ),
            ))
            .unwrap();

        let file = src_dir.path().join("config");
        let written = export_ssh_config_impl(&src, &file).unwrap();
        assert_eq!(written.exported, 2);
        // The written file DOES carry both directives.
        let raw = fs::read_to_string(&file).unwrap();
        assert!(raw.contains("ProxyJump bastion"));
        assert!(raw.contains("ForwardAgent yes"));

        // But a fresh import drops them.
        let dst_dir = tempdir().unwrap();
        let dst = test_state(dst_dir.path());
        import_ssh_config_impl(&dst, &file).unwrap();
        for device in dst.device_store.list() {
            assert!(
                device.proxy_jump_id().is_none(),
                "ProxyJump not re-imported"
            );
            assert!(
                !device.forward_agent_enabled(),
                "ForwardAgent not re-imported"
            );
        }
    }

    #[test]
    fn export_writes_proxy_jump_as_the_jump_hosts_alias() {
        let bastion = ssh_device(
            "bastion-id",
            "bastion",
            ssh_conn("b.example", 22, "root", Auth::Password, None, false),
        );
        let target = ssh_device(
            "target-id",
            "target",
            ssh_conn(
                "10.0.0.5",
                22,
                "app",
                Auth::Password,
                Some("bastion-id".to_string()),
                false,
            ),
        );
        let out = devices_to_ssh_config(&[bastion, target]);
        assert!(out.contains("    ProxyJump bastion\n"));
    }

    #[test]
    fn export_drops_an_unresolvable_proxy_jump() {
        // A jump pointing at a device not in the export (deleted/non-SSH) is
        // dropped rather than emitting a broken ProxyJump alias.
        let target = ssh_device(
            "target-id",
            "target",
            ssh_conn(
                "10.0.0.5",
                22,
                "app",
                Auth::Password,
                Some("ghost-id".to_string()),
                false,
            ),
        );
        let out = devices_to_ssh_config(&[target]);
        assert!(!out.contains("ProxyJump"));
    }

    #[test]
    fn export_skips_non_ssh_devices_and_counts_them() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        state
            .device_store
            .upsert(ssh_device(
                "",
                "nas",
                ssh_conn("h", 22, "u", Auth::Password, None, false),
            ))
            .unwrap();
        state
            .device_store
            .upsert(Device {
                id: String::new(),
                name: "Arduino".to_string(),
                connection: Connection::Serial {
                    port_name: "COM3".to_string(),
                    baud_rate: 115200,
                    data_bits: 8,
                    parity: crate::device::Parity::None,
                    stop_bits: 1,
                    flow_control: crate::device::FlowControl::None,
                },
                auto_reconnect: false,
                tags: Vec::new(),
            })
            .unwrap();

        let file = dir.path().join("config");
        let summary = export_ssh_config_impl(&state, &file).unwrap();
        assert_eq!((summary.exported, summary.skipped), (1, 1));

        let raw = fs::read_to_string(&file).unwrap();
        assert!(raw.contains("Host nas"));
        assert!(!raw.contains("COM3"), "serial device is not exported");
    }

    #[test]
    fn export_then_import_round_trips_into_an_equivalent_device() {
        // Export a device, then import the written config into a fresh store and
        // assert the mappable fields survive (ids differ — import mints new ones).
        let src_dir = tempdir().unwrap();
        let src = test_state(src_dir.path());
        src.device_store
            .upsert(ssh_device(
                "",
                "nas",
                ssh_conn(
                    "192.168.1.10",
                    2222,
                    "admin",
                    Auth::Key {
                        key_path: "/home/j/.ssh/id_ed25519".to_string(),
                    },
                    None,
                    false,
                ),
            ))
            .unwrap();

        let file = src_dir.path().join("config");
        export_ssh_config_impl(&src, &file).unwrap();

        let dst_dir = tempdir().unwrap();
        let dst = test_state(dst_dir.path());
        let summary = import_ssh_config_impl(&dst, &file).unwrap();
        assert_eq!(summary.imported, 1);

        let devices = dst.device_store.list();
        assert_eq!(devices.len(), 1);
        match &devices[0].connection {
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
                assert_eq!(
                    *auth,
                    Auth::Key {
                        key_path: "/home/j/.ssh/id_ed25519".to_string()
                    }
                );
            }
            other => panic!("expected SSH, got {other:?}"),
        }
    }
}
