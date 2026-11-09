//! Import: save the parsed hosts as devices, linking each jump to a device.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use uuid::Uuid;

use super::export::sanitize_alias;
use super::jump_spec::{JumpHopSpec, JumpSpec};
use super::mapping::{
    auth_of, current_username, dedup_key, home_dir, new_ssh_device, to_device, HostKey,
};
use super::parse::{parse_hosts, ParsedHost};
use super::SshImportSummary;
use crate::device::{Auth, Connection, Device};
use crate::error::AppError;
use crate::state::AppState;

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

/// Map each parsed host to a device and save it, skipping invalid hosts (e.g.
/// no resolvable username), duplicates, and hosts whose jump can't be linked
/// (see the module docs). Jump hosts created for a `ProxyJump` count as
/// imported. `default_user`/`home` are passed in (rather than read from the
/// environment here) so this — the part with the interesting branching — is
/// unit-testable with fixed inputs.
fn import_hosts(
    state: &AppState,
    hosts: Vec<ParsedHost>,
    default_user: Option<&str>,
    home: Option<&str>,
) -> Result<SshImportSummary, AppError> {
    let mut book = ImportBook::seeded(&state.device_store.list(), default_user);
    book.remember_aliases(&hosts, home);
    let total = hosts.len();
    let admitted: Vec<Planned> = hosts
        .into_iter()
        .filter_map(|host| plan(host, default_user, home))
        .filter(|planned| book.admit(planned))
        .collect();
    let linked: Vec<Device> = admitted
        .into_iter()
        .filter_map(|planned| book.linked(planned))
        .collect();
    let skipped = (total - linked.len()) as u32;
    // Jump hosts first: a write failing part-way must not leave a saved device
    // pointing at a jump host that was never written.
    let to_save: Vec<Device> = std::mem::take(&mut book.created)
        .into_iter()
        .chain(linked)
        .collect();
    for device in &to_save {
        state.device_store.upsert(device.clone())?;
    }
    Ok(SshImportSummary {
        imported: to_save.len() as u32,
        skipped,
    })
}

/// A valid host from the file, its id minted up front so another host's jump
/// can reference it before anything is saved.
struct Planned {
    device: Device,
    jump: JumpSpec,
}

/// `None` for a host that can't become a valid device.
fn plan(host: ParsedHost, default_user: Option<&str>, home: Option<&str>) -> Option<Planned> {
    let jump = host.jump.clone();
    let mut device = to_device(host, default_user, home);
    device.validate().ok()?;
    device.id = Uuid::new_v4().to_string();
    Some(Planned { device, jump })
}

/// What a name used in a `ProxyJump` stands for, before the hop's own user and
/// port override it. `user: None` falls back to the local login name.
#[derive(Clone)]
struct HopBase {
    host: String,
    port: u16,
    user: Option<String>,
    auth: Auth,
}

impl HopBase {
    fn of_parsed(host: &ParsedHost, home: Option<&str>) -> Self {
        HopBase {
            host: host.host_name.clone().unwrap_or_else(|| host.name.clone()),
            port: host.port.unwrap_or(22),
            user: host.user.clone(),
            auth: auth_of(host.identity_file.as_deref(), home),
        }
    }

    fn of_saved(device: &Device) -> Option<Self> {
        let Connection::Ssh {
            host,
            port,
            username,
            auth,
            ..
        } = &device.connection
        else {
            return None;
        };
        Some(HopBase {
            host: host.clone(),
            port: *port,
            user: Some(username.clone()),
            auth: auth.clone(),
        })
    }

    /// A hop naming no known host: that address, on port 22, by password.
    fn literal(host: &str) -> Self {
        HopBase {
            host: host.to_string(),
            port: 22,
            user: None,
            auth: Auth::Password,
        }
    }
}

/// A device a jump can be linked to, saved or about to be.
#[derive(Clone)]
struct JumpCandidate {
    id: String,
    /// It has a jump host of its own, so linking to it would make a chain.
    jumps: bool,
}

/// What the import knows while linking jumps: every SSH device by host/port/
/// user (saved ones, then the ones this import adds), the names a `ProxyJump`
/// may use for one (lowercased; the file's aliases take precedence over saved
/// devices' exported aliases), and the jump-host devices it had to create.
struct ImportBook<'a> {
    by_key: HashMap<HostKey, JumpCandidate>,
    file_aliases: HashMap<String, HopBase>,
    saved_aliases: HashMap<String, HopBase>,
    created: Vec<Device>,
    default_user: Option<&'a str>,
}

impl<'a> ImportBook<'a> {
    fn seeded(saved: &[Device], default_user: Option<&'a str>) -> Self {
        let mut book = ImportBook {
            by_key: HashMap::new(),
            file_aliases: HashMap::new(),
            saved_aliases: HashMap::new(),
            created: Vec::new(),
            default_user,
        };
        for device in saved {
            book.remember_saved(device);
        }
        book
    }

    fn remember_saved(&mut self, device: &Device) {
        let (Some(key), Some(base)) = (dedup_key(device), HopBase::of_saved(device)) else {
            return;
        };
        let candidate = JumpCandidate {
            id: device.id.clone(),
            jumps: device.proxy_jump_id().is_some(),
        };
        self.by_key.entry(key).or_insert(candidate);
        let alias = sanitize_alias(&device.name).to_ascii_lowercase();
        self.saved_aliases.entry(alias).or_insert(base);
    }

    /// Every alias in the file, including those of hosts that end up skipped:
    /// a hop through one still means that block's address, not a DNS name.
    fn remember_aliases(&mut self, hosts: &[ParsedHost], home: Option<&str>) {
        for host in hosts {
            let base = HopBase::of_parsed(host, home);
            for alias in &host.aliases {
                self.file_aliases
                    .entry(alias.to_ascii_lowercase())
                    .or_insert_with(|| base.clone());
            }
        }
    }

    /// Register a host as a jump candidate; `false` when it duplicates a known
    /// device (its alias then still leads to that device).
    fn admit(&mut self, planned: &Planned) -> bool {
        let key = dedup_key(&planned.device).expect("an imported host is an SSH device");
        if self.by_key.contains_key(&key) {
            return false;
        }
        let candidate = JumpCandidate {
            id: planned.device.id.clone(),
            jumps: planned.jump != JumpSpec::Direct,
        };
        self.by_key.insert(key, candidate);
        true
    }

    /// The host's device with its jump linked; `None` when it can't be.
    fn linked(&mut self, planned: Planned) -> Option<Device> {
        let jump_id = self.jump_id_for(&planned.jump)?;
        let mut device = planned.device;
        if let Connection::Ssh { proxy_jump, .. } = &mut device.connection {
            *proxy_jump = jump_id;
        }
        Some(device)
    }

    /// `Some(None)` for a direct host; `None` when its jump can't be linked.
    fn jump_id_for(&mut self, jump: &JumpSpec) -> Option<Option<String>> {
        match jump {
            JumpSpec::Direct => Some(None),
            JumpSpec::Hop(hop) => self.jump_host_for(hop).map(Some),
            JumpSpec::Unsupported => None,
        }
    }

    /// The id of the device a hop names, created if need be; `None` when that
    /// device jumps itself (a chain, or the host jumping through itself), or no
    /// valid device can stand for the hop.
    fn jump_host_for(&mut self, hop: &JumpHopSpec) -> Option<String> {
        let (key, auth) = self.hop_target(hop)?;
        let candidate = match self.by_key.get(&key) {
            Some(known) => known.clone(),
            None => self.create_jump_host(&hop.host, key, auth)?,
        };
        (!candidate.jumps).then_some(candidate.id)
    }

    /// The host/port/user a hop connects to, and the auth a device created for
    /// it gets: what its name stands for, with the hop's user and port first.
    fn hop_target(&self, hop: &JumpHopSpec) -> Option<(HostKey, Auth)> {
        let name = hop.host.to_ascii_lowercase();
        let known = self
            .file_aliases
            .get(&name)
            .or_else(|| self.saved_aliases.get(&name));
        let base = known.cloned().unwrap_or_else(|| HopBase::literal(&name));
        let user = hop.user.clone().or(base.user);
        let user = user.or_else(|| self.default_user.map(str::to_string))?;
        let key = (
            base.host.to_ascii_lowercase(),
            hop.port.unwrap_or(base.port),
            user,
        );
        Some((key, base.auth))
    }

    /// Queue a device for a jump host no known device matches.
    fn create_jump_host(&mut self, name: &str, key: HostKey, auth: Auth) -> Option<JumpCandidate> {
        let mut device = new_ssh_device(name.to_string(), key.clone(), auth);
        device.validate().ok()?;
        device.id = Uuid::new_v4().to_string();
        let candidate = JumpCandidate {
            id: device.id.clone(),
            jumps: false,
        };
        self.by_key.insert(key, candidate.clone());
        self.created.push(device);
        Some(candidate)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssh_config::test_support::*;
    use tempfile::tempdir;

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

    fn endpoint_of(device: &Device) -> (String, u16, String, Auth) {
        match &device.connection {
            Connection::Ssh {
                host,
                port,
                username,
                auth,
                ..
            } => (host.clone(), *port, username.clone(), auth.clone()),
            other => panic!("expected SSH, got {other:?}"),
        }
    }

    fn import_text(state: &AppState, cfg: &str) -> SshImportSummary {
        import_hosts(state, parse_hosts(cfg), Some("me"), None).unwrap()
    }

    #[test]
    fn import_links_a_jump_through_a_host_defined_later_in_the_file() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        let summary = import_text(
            &state,
            "\
Host app
    HostName 10.0.0.5
    ProxyJump bastion
Host bastion
    HostName b.example
",
        );
        assert_eq!((summary.imported, summary.skipped), (2, 0));
        let bastion = named(&state, "bastion");
        assert_eq!(
            named(&state, "app").proxy_jump_id(),
            Some(bastion.id.as_str())
        );
        assert_eq!(bastion.proxy_jump_id(), None);
    }

    #[test]
    fn import_links_a_jump_to_an_already_saved_device_by_name() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        let saved = state
            .device_store
            .upsert(ssh_device(
                "",
                "My Bastion",
                ssh_conn("b.example", 22, "root", Auth::Password, None, false),
            ))
            .unwrap();
        let summary = import_text(
            &state,
            "Host app\n  HostName 10.0.0.5\n  ProxyJump My-Bastion\n",
        );
        assert_eq!((summary.imported, summary.skipped), (1, 0));
        assert_eq!(
            named(&state, "app").proxy_jump_id(),
            Some(saved.id.as_str())
        );
    }

    #[test]
    fn import_links_a_jump_through_a_host_skipped_as_a_duplicate_to_the_saved_one() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        let saved = state
            .device_store
            .upsert(ssh_device(
                "",
                "old-name",
                ssh_conn("b.example", 22, "me", Auth::Password, None, false),
            ))
            .unwrap();
        let summary = import_text(
            &state,
            "Host bastion\n  HostName b.example\nHost app\n  HostName 10.0.0.5\n  ProxyJump bastion\n",
        );
        assert_eq!((summary.imported, summary.skipped), (1, 1));
        assert_eq!(
            named(&state, "app").proxy_jump_id(),
            Some(saved.id.as_str())
        );
    }

    #[test]
    fn import_creates_a_password_device_for_a_literal_jump_host() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        let summary = import_text(
            &state,
            "Host app\n  HostName 10.0.0.5\n  ProxyJump ops@jump.example:2200\n",
        );
        assert_eq!((summary.imported, summary.skipped), (2, 0));
        let jump = named(&state, "jump.example");
        assert_eq!(
            endpoint_of(&jump),
            (
                "jump.example".to_string(),
                2200,
                "ops".to_string(),
                Auth::Password
            )
        );
        assert_eq!(named(&state, "app").proxy_jump_id(), Some(jump.id.as_str()));
    }

    #[test]
    fn import_reuses_a_saved_device_matching_a_literal_jump_host() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        let saved = state
            .device_store
            .upsert(ssh_device(
                "",
                "jumpbox",
                ssh_conn("jump.example", 22, "me", Auth::Password, None, false),
            ))
            .unwrap();
        let summary = import_text(
            &state,
            "Host app\n  HostName 10.0.0.5\n  ProxyJump jump.example\n",
        );
        assert_eq!((summary.imported, summary.skipped), (1, 0));
        assert_eq!(state.device_store.list().len(), 2);
        assert_eq!(
            named(&state, "app").proxy_jump_id(),
            Some(saved.id.as_str())
        );
    }

    #[test]
    fn import_applies_jump_user_and_port_over_the_aliased_host() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        let summary = import_text(
            &state,
            "\
Host bastion
    HostName b.example
    User root
Host app
    HostName 10.0.0.5
    ProxyJump admin@bastion:2200
",
        );
        assert_eq!((summary.imported, summary.skipped), (3, 0));
        let app = named(&state, "app");
        let jump = state
            .device_store
            .list()
            .into_iter()
            .find(|d| Some(d.id.as_str()) == app.proxy_jump_id())
            .expect("the jump device");
        assert_eq!(
            endpoint_of(&jump),
            (
                "b.example".to_string(),
                2200,
                "admin".to_string(),
                Auth::Password
            )
        );
    }

    fn jump_device_of(state: &AppState, name: &str) -> Device {
        let host = named(state, name);
        state
            .device_store
            .list()
            .into_iter()
            .find(|d| Some(d.id.as_str()) == host.proxy_jump_id())
            .expect("the jump device")
    }

    #[test]
    fn import_matches_jump_aliases_case_insensitively() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        let summary = import_text(
            &state,
            "Host bastion\n  HostName b.example\nHost app\n  HostName 10.0.0.5\n  ProxyJump Bastion\n",
        );
        assert_eq!((summary.imported, summary.skipped), (2, 0));
        assert_eq!(jump_device_of(&state, "app").name, "bastion");
    }

    #[test]
    fn import_resolves_any_alias_of_a_multi_alias_host() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        let summary = import_text(
            &state,
            "Host bastion bastion.corp\n  HostName b.example\nHost app\n  HostName 10.0.0.5\n  ProxyJump bastion.corp\n",
        );
        assert_eq!((summary.imported, summary.skipped), (2, 0));
        assert_eq!(jump_device_of(&state, "app").name, "bastion");
    }

    #[test]
    fn import_resolves_a_jump_through_the_alias_of_a_skipped_host() {
        // No login name: `bastion` has no user and is skipped, but `ops@bastion`
        // still means its HostName, not the DNS name "bastion".
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        let cfg = "\
Host bastion
    HostName b.example
Host app
    HostName 10.0.0.5
    User me
    ProxyJump ops@bastion
";
        let summary = import_hosts(&state, parse_hosts(cfg), None, None).unwrap();
        assert_eq!((summary.imported, summary.skipped), (2, 1));
        let (host, port, user, _) = endpoint_of(&jump_device_of(&state, "app"));
        assert_eq!(
            (host.as_str(), port, user.as_str()),
            ("b.example", 22, "ops")
        );
    }

    #[test]
    fn import_keeps_the_aliased_hosts_key_file_on_a_user_override() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        let cfg = "\
Host bastion
    HostName b.example
    IdentityFile ~/.ssh/id_bastion
Host app
    HostName 10.0.0.5
    ProxyJump admin@bastion
";
        let summary = import_hosts(&state, parse_hosts(cfg), Some("me"), Some("/home/j")).unwrap();
        assert_eq!((summary.imported, summary.skipped), (3, 0));
        assert_eq!(
            endpoint_of(&jump_device_of(&state, "app")),
            (
                "b.example".to_string(),
                22,
                "admin".to_string(),
                Auth::Key {
                    key_path: "/home/j/.ssh/id_bastion".to_string()
                }
            )
        );
    }

    #[test]
    fn import_saves_a_created_jump_host_before_the_host_using_it() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        import_text(
            &state,
            "Host app\n  HostName 10.0.0.5\n  ProxyJump jump.example\n",
        );
        let names: Vec<String> = state
            .device_store
            .list()
            .into_iter()
            .map(|d| d.name)
            .collect();
        assert_eq!(names, ["jump.example", "app"]);
    }

    #[test]
    fn import_skips_a_host_whose_jump_is_set_by_a_match_block() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        let summary = import_text(&state, "Host db.corp\nMatch host *.corp\n  ProxyJump b\n");
        assert_eq!((summary.imported, summary.skipped), (0, 1));
    }

    #[test]
    fn import_skips_a_host_with_a_jump_chain() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        let summary = import_text(
            &state,
            "Host app\n  HostName 10.0.0.5\n  ProxyJump a.example,b.example\n",
        );
        assert_eq!((summary.imported, summary.skipped), (0, 1));
        assert!(state.device_store.list().is_empty());
    }

    #[test]
    fn import_skips_a_host_whose_jump_host_itself_jumps() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        let summary = import_text(
            &state,
            "\
Host outer
    HostName o.example
Host inner
    HostName i.example
    ProxyJump outer
Host app
    HostName 10.0.0.5
    ProxyJump inner
",
        );
        assert_eq!((summary.imported, summary.skipped), (2, 1));
        assert!(state.device_store.list().iter().all(|d| d.name != "app"));
    }

    #[test]
    fn import_skips_a_host_that_jumps_through_itself() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        let summary = import_text(&state, "Host app\n  HostName 10.0.0.5\n  ProxyJump app\n");
        assert_eq!((summary.imported, summary.skipped), (0, 1));
    }

    #[test]
    fn import_skips_a_host_whose_jump_has_no_resolvable_username() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        let hosts =
            parse_hosts("Host app\n  HostName 10.0.0.5\n  User me\n  ProxyJump jump.example\n");
        let summary = import_hosts(&state, hosts, None, None).unwrap();
        assert_eq!((summary.imported, summary.skipped), (0, 1));
        assert!(state.device_store.list().is_empty());
    }

    #[test]
    fn import_maps_forward_agent() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        import_text(
            &state,
            "Host a\n  HostName a.example\n  ForwardAgent yes\nHost b\n  HostName b.example\n",
        );
        assert!(named(&state, "a").forward_agent_enabled());
        assert!(!named(&state, "b").forward_agent_enabled());
    }
}
