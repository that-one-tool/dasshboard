//! Export: DaSSHboard devices → OpenSSH client config (the reverse of import).

use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::fs;
use std::path::Path;

use super::SshExportSummary;
use crate::device::{Auth, Connection, Device, X11Mode};
use crate::error::AppError;
use crate::state::AppState;

/// Characters OpenSSH reads as more than a name in a `Host` alias: pattern
/// wildcards and negation (`Host *` would apply the block to every host), the
/// `ProxyJump` hop separator and its `[user@]host[:port]` / `[addr]` syntax, a
/// comment start, and the quote/escape characters.
const ALIAS_SPECIAL_CHARS: [char; 11] = ['*', '?', '!', ',', '@', ':', '[', ']', '#', '\'', '\\'];

/// Turn a device name into a safe `Host` alias token: SSH config splits `Host`
/// patterns on whitespace, so a name with spaces (`"My NAS"`) would become two
/// patterns. Collapse whitespace runs and special characters to `-`, trim
/// `-` from both ends, and fall back to `"device"` for a name left empty
/// (`"*"`).
pub(super) fn sanitize_alias(name: &str) -> String {
    let joined = name.split_whitespace().collect::<Vec<_>>().join("-");
    // Drop any remaining control chars / double-quotes so the `Host` line is a
    // single safe token even for a name that arrived via JSON import (which
    // bypasses the UI's single-line inputs).
    let cleaned: String = joined
        .chars()
        .filter(|c| !c.is_control() && *c != '"')
        .map(|c| {
            if ALIAS_SPECIAL_CHARS.contains(&c) {
                '-'
            } else {
                c
            }
        })
        .collect();
    match cleaned.trim_matches('-') {
        "" => "device".to_string(),
        alias => alias.to_string(),
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
/// sanitized names (see [`sanitize_alias`]); a collision — ignoring case, as
/// OpenSSH matches `Host` — gets a `-2`, `-3`, … suffix so every block names a
/// distinct host and `ProxyJump` references resolve unambiguously. Non-SSH devices get no alias (they aren't exported).
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
        while !used.insert(alias.to_lowercase()) {
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
/// device), `ForwardAgent yes` and `ForwardX11`/`ForwardX11Trusted` (when
/// enabled). A password never appears — it lives only in the OS keyring, never
/// in the device — so an exported host with password auth simply has no
/// credential line, exactly like a fresh `ssh` config entry.
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
        x11_forwarding,
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
    write_x11(out, *x11_forwarding);
}

/// `ForwardX11Trusted` is always written: some distributions default it to
/// `yes`, which would turn an untrusted host trusted.
fn write_x11(out: &mut String, mode: X11Mode) {
    let Some(trusted) = mode.trusted() else {
        return;
    };
    let trusted = if trusted { "yes" } else { "no" };
    let _ = writeln!(out, "    ForwardX11 yes");
    let _ = writeln!(out, "    ForwardX11Trusted {trusted}");
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
    use crate::ssh_config::import_ssh_config_impl;
    use crate::ssh_config::test_support::*;
    use tempfile::tempdir;

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

    fn exported_host_lines(names: &[&str]) -> Vec<String> {
        let devices: Vec<Device> = names
            .iter()
            .enumerate()
            .map(|(i, name)| {
                let conn = ssh_conn("h", 22, "u", Auth::Password, None, false);
                ssh_device(&format!("id{i}"), name, conn)
            })
            .collect();
        devices_to_ssh_config(&devices)
            .lines()
            .filter_map(|l| l.strip_prefix("Host ").map(str::to_string))
            .collect()
    }

    #[test]
    fn export_never_writes_a_pattern_as_a_host_alias() {
        // `Host *` would apply this device's HostName/User/ProxyJump to every
        // host the user's ssh connects to; `,` would split a ProxyJump value.
        let hosts = exported_host_lines(&["*", "web*", "a?b", "!x", "a,b", "#1", "o'k"]);
        assert_eq!(hosts, ["device", "web", "a-b", "x", "a-b-2", "1", "o-k"]);
    }

    #[test]
    fn export_never_writes_a_user_or_port_into_a_host_alias() {
        // OpenSSH reads `[user@]host[:port]` in a ProxyJump: `root@bastion`
        // would jump as `root` to whatever `bastion` resolves to.
        let hosts = exported_host_lines(&["root@bastion", "web:8080", "[::1]"]);
        assert_eq!(hosts, ["root-bastion", "web-8080", "1"]);
    }

    #[test]
    fn export_deduplicates_aliases_ignoring_case() {
        // OpenSSH matches Host case-insensitively: `nas` would be shadowed.
        assert_eq!(exported_host_lines(&["NAS", "nas"]), ["NAS", "nas-2"]);
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
    fn export_then_import_keeps_proxy_jump_and_forward_agent() {
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

        let dst_dir = tempdir().unwrap();
        let dst = test_state(dst_dir.path());
        import_ssh_config_impl(&dst, &file).unwrap();
        let bastion = named(&dst, "bastion");
        let target = named(&dst, "target");
        assert_eq!(target.proxy_jump_id(), Some(bastion.id.as_str()));
        assert!(target.forward_agent_enabled());
        assert!(!bastion.forward_agent_enabled());
    }

    #[test]
    fn export_then_import_keeps_the_x11_mode() {
        let src_dir = tempdir().unwrap();
        let src = test_state(src_dir.path());
        for (name, mode) in [
            ("off", X11Mode::Off),
            ("untrusted", X11Mode::Untrusted),
            ("trusted", X11Mode::Trusted),
        ] {
            let host = format!("{name}.example");
            let mut connection = ssh_conn(&host, 22, "u", Auth::Password, None, false);
            if let Connection::Ssh { x11_forwarding, .. } = &mut connection {
                *x11_forwarding = mode;
            }
            src.device_store
                .upsert(ssh_device("", name, connection))
                .unwrap();
        }

        let file = src_dir.path().join("config");
        export_ssh_config_impl(&src, &file).unwrap();
        let raw = fs::read_to_string(&file).unwrap();
        assert_eq!(raw.matches("    ForwardX11 yes\n").count(), 2);
        assert_eq!(raw.matches("    ForwardX11Trusted no\n").count(), 1);
        assert_eq!(raw.matches("    ForwardX11Trusted yes\n").count(), 1);

        let dst_dir = tempdir().unwrap();
        let dst = test_state(dst_dir.path());
        import_ssh_config_impl(&dst, &file).unwrap();
        assert_eq!(named(&dst, "off").x11_mode(), X11Mode::Off);
        assert_eq!(named(&dst, "untrusted").x11_mode(), X11Mode::Untrusted);
        assert_eq!(named(&dst, "trusted").x11_mode(), X11Mode::Trusted);
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
                connect_snippet: None,
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
