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
//! Scope: the keywords that map onto our `Device` model —
//! `Host` / `HostName` / `Port` / `User` / `IdentityFile` / `ForwardAgent` /
//! `ProxyJump` (and `ProxyCommand`, only to refuse it). Everything else
//! (`Include`, …) is ignored, and `Include` directives are not followed.
//! Wildcard host patterns (`Host *`, `Host foo?`) describe defaults, not a
//! concrete server, so they never produce a device, and neither their keywords
//! nor a `Match` block's attach to one — except the proxy setting below.
//!
//! Jumps: a host's `ProxyJump`/`ProxyCommand` is the first one set by any
//! section that applies to it (its own block, a matching wildcard `Host`, the
//! lines before the first `Host`), as OpenSSH reads it. A device has at most
//! one jump host, itself direct. A single hop is linked to the device it names
//! — a `Host` alias in the file (case-insensitively), or an already-saved
//! device by its exported alias — otherwise to a saved device with the same
//! host/port/user, otherwise to a new device created for it. A host whose jump
//! can't be represented that way (a chain, a `ProxyCommand`, a `Match` block
//! that may set one, a jump host that itself jumps, itself, a malformed hop) is
//! skipped rather than imported as a direct connection.
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
use uuid::Uuid;

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
    /// Every concrete alias on the `Host` line (`name` first) — what another
    /// host's `ProxyJump` may call this one.
    aliases: Vec<String>,
    /// `HostName` if given, else the alias — the address we actually dial.
    host_name: Option<String>,
    /// `Port` if given and parseable; `None` ⇒ the SSH default (22).
    port: Option<u16>,
    /// `User` if given; `None` ⇒ fall back to the local login name at map time.
    user: Option<String>,
    /// First `IdentityFile` if given ⇒ key auth; `None` ⇒ password auth.
    identity_file: Option<String>,
    /// `ForwardAgent`: only `yes`/`true` enable it (a socket path names an
    /// agent other than the default one, which we don't support).
    forward_agent: Option<bool>,
    /// The host's effective `ProxyJump` / `ProxyCommand`, from whichever
    /// applicable section of the file sets one first (see [`effective_jump`]).
    jump: JumpSpec,
}

/// One section of the file: the lines before the first `Host`, a `Host` block
/// or a `Match` block. Only a concrete `Host` block yields a [`ParsedHost`];
/// every section can carry the proxy setting the hosts it applies to inherit.
struct Section {
    selector: Selector,
    host: Option<ParsedHost>,
    /// The section's first `ProxyJump` or `ProxyCommand`.
    proxy: Option<Proxy>,
}

enum Selector {
    /// `Host` patterns (the lines before the first `Host` behave as `Host *`).
    Host(Vec<String>),
    /// `Match` criteria, which we don't evaluate.
    Match(String),
}

/// `ProxyJump` and `ProxyCommand` share one slot: whichever OpenSSH reads
/// first wins.
enum Proxy {
    Jump(String),
    Command(String),
}

/// A host's `ProxyJump`, before it is matched to a device.
#[derive(Debug, Clone, PartialEq)]
enum JumpSpec {
    /// No `ProxyJump`, or `ProxyJump none`.
    Direct,
    /// One hop.
    Hop(JumpHopSpec),
    /// A chain (`a,b`) or a malformed hop — nothing a device can represent.
    Unsupported,
}

/// One `ProxyJump` hop: `[user@]host[:port]` or `ssh://[user@]host[:port]`.
#[derive(Debug, Clone, PartialEq)]
struct JumpHopSpec {
    host: String,
    user: Option<String>,
    port: Option<u16>,
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

/// The concrete aliases of a `Host` line: every token that is neither negated
/// (`!foo`) nor a wildcard (`*`/`?`). Empty for a wildcard-only line (e.g.
/// `Host *`), which describes defaults rather than a concrete server and so
/// yields no device.
fn concrete_aliases(patterns: &str) -> Vec<String> {
    patterns
        .split_whitespace()
        .filter(|p| !p.starts_with('!') && !p.contains('*') && !p.contains('?'))
        .map(str::to_string)
        .collect()
}

/// Parse config text into the concrete hosts it describes, in file order, each
/// with the jump it inherits from the whole file.
fn parse_hosts(contents: &str) -> Vec<ParsedHost> {
    let sections = parse_sections(contents);
    sections
        .iter()
        .filter_map(|section| section.host.clone())
        .map(|mut host| {
            host.jump = effective_jump(&host, &sections);
            host
        })
        .collect()
}

/// Split the file into sections. A `Host` or `Match` line starts a new one;
/// keywords fill the current one, the first value winning for single-valued
/// keywords (OpenSSH's "earliest obtained value" rule). Only a concrete `Host`
/// block keeps its own keywords: wildcard and `Match` defaults never leak into
/// a device, except the proxy setting (see [`effective_jump`]).
fn parse_sections(contents: &str) -> Vec<Section> {
    let mut sections = vec![Section::new(Selector::Host(vec!["*".to_string()]), None)];
    for (keyword, value) in contents.lines().filter_map(split_keyword) {
        match keyword.as_str() {
            "host" => sections.push(Section::host(&value)),
            "match" => sections.push(Section::new(Selector::Match(value), None)),
            _ => sections.last_mut().expect("seeded").apply(&keyword, value),
        }
    }
    sections
}

impl Section {
    fn new(selector: Selector, host: Option<ParsedHost>) -> Self {
        Section {
            selector,
            host,
            proxy: None,
        }
    }

    fn host(patterns: &str) -> Self {
        let aliases = concrete_aliases(patterns);
        let host = aliases.first().map(|name| ParsedHost {
            name: name.clone(),
            aliases: aliases.clone(),
            host_name: None,
            port: None,
            user: None,
            identity_file: None,
            forward_agent: None,
            jump: JumpSpec::Direct,
        });
        let patterns = patterns.split_whitespace().map(str::to_string).collect();
        Section::new(Selector::Host(patterns), host)
    }

    fn apply(&mut self, keyword: &str, value: String) {
        match keyword {
            "proxyjump" if self.proxy.is_none() => self.proxy = Some(Proxy::Jump(value)),
            "proxycommand" if self.proxy.is_none() => self.proxy = Some(Proxy::Command(value)),
            _ => self.apply_to_host(keyword, value),
        }
    }

    fn apply_to_host(&mut self, keyword: &str, value: String) {
        if let Some(host) = self.host.as_mut() {
            apply_keyword(host, keyword, value);
        }
    }

    /// The jump this section gives `host`, if it sets a proxy and applies. A
    /// `Match` block that might apply makes it unsupported: we can't evaluate
    /// it, and importing the host as direct could route it wrongly.
    fn jump_for(&self, host: &ParsedHost) -> Option<JumpSpec> {
        let proxy = self.proxy.as_ref()?;
        match &self.selector {
            Selector::Host(patterns) => host_matches(patterns, &host.name).then(|| proxy.jump()),
            Selector::Match(criteria) => {
                match_may_apply(criteria, host).then_some(JumpSpec::Unsupported)
            }
        }
    }
}

impl Proxy {
    fn jump(&self) -> JumpSpec {
        match self {
            Proxy::Jump(value) => parse_jump_spec(Some(value)),
            Proxy::Command(command) if command.eq_ignore_ascii_case("none") => JumpSpec::Direct,
            Proxy::Command(_) => JumpSpec::Unsupported,
        }
    }
}

/// The jump a host gets from the first section, in file order, that applies
/// to it and sets a proxy — its own block or any other.
fn effective_jump(host: &ParsedHost, sections: &[Section]) -> JumpSpec {
    sections
        .iter()
        .find_map(|section| section.jump_for(host))
        .unwrap_or(JumpSpec::Direct)
}

/// Whether `Host` patterns select `name`: some pattern matches and no negated
/// one does. Case-insensitive, like OpenSSH.
fn host_matches(patterns: &[String], name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    let hits = |pattern: &str| glob_match(pattern.to_ascii_lowercase().as_bytes(), name.as_bytes());
    let excluded = patterns
        .iter()
        .filter_map(|p| p.strip_prefix('!'))
        .any(hits);
    !excluded && patterns.iter().any(|p| !p.starts_with('!') && hits(p))
}

/// Whether `Match` criteria could select `host`. Only a `host`/`originalhost`
/// list is checked (against the alias and the `HostName`); every other
/// criterion is assumed to match.
fn match_may_apply(criteria: &str, host: &ParsedHost) -> bool {
    let tokens: Vec<&str> = criteria.split_whitespace().collect();
    let Some(list) = tokens
        .windows(2)
        .find(|w| is_host_criterion(w[0]))
        .map(|w| w[1])
    else {
        return true;
    };
    let patterns: Vec<String> = list.split(',').map(str::to_string).collect();
    std::iter::once(&host.name)
        .chain(host.host_name.as_ref())
        .any(|name| host_matches(&patterns, name))
}

fn is_host_criterion(token: &str) -> bool {
    token.eq_ignore_ascii_case("host") || token.eq_ignore_ascii_case("originalhost")
}

/// Shell-style glob over bytes: `*` matches any run, `?` exactly one byte.
fn glob_match(pattern: &[u8], text: &[u8]) -> bool {
    match (pattern.split_first(), text.split_first()) {
        (None, _) => text.is_empty(),
        (Some((b'*', rest)), _) => {
            glob_match(rest, text) || (!text.is_empty() && glob_match(pattern, &text[1..]))
        }
        (Some(_), None) => false,
        (Some((&p, rest)), Some((&c, tail))) => (p == b'?' || p == c) && glob_match(rest, tail),
    }
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
        "forwardagent" if host.forward_agent.is_none() => {
            let on = value.eq_ignore_ascii_case("yes") || value.eq_ignore_ascii_case("true");
            host.forward_agent = Some(on);
        }
        _ => {}
    }
}

/// Read a `ProxyJump` value (see [`JumpSpec`]).
fn parse_jump_spec(value: Option<&str>) -> JumpSpec {
    match value {
        None => JumpSpec::Direct,
        Some(v) if v.eq_ignore_ascii_case("none") => JumpSpec::Direct,
        Some(v) if v.contains(',') => JumpSpec::Unsupported,
        Some(v) => parse_hop(v).map_or(JumpSpec::Unsupported, JumpSpec::Hop),
    }
}

/// Split one hop into its user, host and port; `None` when malformed.
fn parse_hop(value: &str) -> Option<JumpHopSpec> {
    let value = value.strip_prefix("ssh://").unwrap_or(value);
    let (user, host_port) = match value.rsplit_once('@') {
        Some((user, rest)) => (Some(user.to_string()), rest),
        None => (None, value),
    };
    let (host, port) = split_host_port(host_port)?;
    let usable = !host.is_empty() && user.as_ref().is_none_or(|u| !u.is_empty());
    usable.then_some(JumpHopSpec { host, user, port })
}

/// `host`, `host:port`, `[v6]` or `[v6]:port`; `None` for a bad port or an
/// unclosed bracket. A bare IPv6 address (several colons) has no port.
fn split_host_port(value: &str) -> Option<(String, Option<u16>)> {
    if let Some(bracketed) = value.strip_prefix('[') {
        return split_bracketed(bracketed);
    }
    match value.split_once(':') {
        Some((host, port)) if !port.contains(':') => {
            Some((host.to_string(), Some(port.parse().ok()?)))
        }
        _ => Some((value.to_string(), None)),
    }
}

/// `v6]` or `v6]:port`, the opening bracket already stripped.
fn split_bracketed(value: &str) -> Option<(String, Option<u16>)> {
    let (host, rest) = value.split_once(']')?;
    Some((host.to_string(), parse_port(rest)?))
}

/// The `:port` suffix after a bracketed host: empty ⇒ no port.
fn parse_port(suffix: &str) -> Option<Option<u16>> {
    match suffix.strip_prefix(':') {
        Some(port) => port.parse().ok().map(Some),
        None => suffix.is_empty().then_some(None),
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

/// Map a parsed host to a `Device` (id left empty; the importer mints one, no
/// jump yet). The username falls back to the local login name when the
/// config omits `User`, mirroring OpenSSH; an `IdentityFile` becomes key auth
/// (`~` expanded), otherwise password auth with no stored secret.
fn to_device(host: ParsedHost, default_user: Option<&str>, home: Option<&str>) -> Device {
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
    if let Connection::Ssh { forward_agent, .. } = &mut device.connection {
        *forward_agent = host.forward_agent.unwrap_or(false);
    }
    device
}

/// Key auth for an `IdentityFile` (`~` expanded), else password auth.
fn auth_of(identity_file: Option<&str>, home: Option<&str>) -> Auth {
    match identity_file {
        Some(path) => Auth::Key {
            key_path: expand_tilde(path, home),
        },
        None => Auth::Password,
    }
}

/// A plain SSH device (no forwards, no jump, no agent forwarding).
fn new_ssh_device(name: String, (host, port, username): HostKey, auth: Auth) -> Device {
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
            proxy_jump: None,
        },
        auto_reconnect: false,
        tags: Vec::new(),
        connect_snippet: None,
    }
}

/// An SSH device's host (lowercased), port and username.
type HostKey = (String, u16, String);

/// The identity key used to detect a duplicate on import: an SSH device is "the
/// same" as one already saved when host (case-insensitively), port and username
/// all match. Serial devices never collide with an imported SSH host.
fn dedup_key(device: &Device) -> Option<HostKey> {
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
            edit_manager: crate::sftp_edit::EditManager::new(dir.join("sftp-edit")),
            serial_manager: Arc::new(SerialSessionManager::new()),
            local_shell_manager: Arc::new(crate::local_shell::LocalShellManager::new()),
            bookmark_store: crate::bookmark_store::BookmarkStore::load(dir.to_path_buf()),
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
                aliases: vec!["nas".to_string()],
                host_name: Some("192.168.1.10".to_string()),
                port: Some(2222),
                user: Some("admin".to_string()),
                identity_file: None,
                forward_agent: None,
                jump: JumpSpec::Direct,
            }]
        );
    }

    #[test]
    fn parses_proxy_jump_and_forward_agent_first_value_wins() {
        let cfg = "\
Host app
    ProxyJump bastion
    ProxyJump other
    ForwardAgent yes
    ForwardAgent no
";
        let hosts = parse_hosts(cfg);
        assert_eq!(hosts[0].jump, hop("bastion", None, None));
        assert_eq!(hosts[0].forward_agent, Some(true));
    }

    #[test]
    fn only_forward_agent_yes_or_true_enables_forwarding() {
        for (value, expected) in [
            ("yes", true),
            ("YES", true),
            ("true", true),
            ("no", false),
            ("false", false),
            ("/tmp/agent.sock", false),
        ] {
            let hosts = parse_hosts(&format!("Host a\n  ForwardAgent {value}\n"));
            assert_eq!(
                hosts[0].forward_agent,
                Some(expected),
                "ForwardAgent {value}"
            );
        }
    }

    fn hop(host: &str, user: Option<&str>, port: Option<u16>) -> JumpSpec {
        JumpSpec::Hop(JumpHopSpec {
            host: host.to_string(),
            user: user.map(str::to_string),
            port,
        })
    }

    #[test]
    fn parse_jump_spec_reads_one_hop_in_every_form() {
        assert_eq!(parse_jump_spec(None), JumpSpec::Direct);
        assert_eq!(parse_jump_spec(Some("none")), JumpSpec::Direct);
        assert_eq!(parse_jump_spec(Some("NONE")), JumpSpec::Direct);
        assert_eq!(parse_jump_spec(Some("bastion")), hop("bastion", None, None));
        assert_eq!(
            parse_jump_spec(Some("ops@jump.example:2200")),
            hop("jump.example", Some("ops"), Some(2200))
        );
        assert_eq!(
            parse_jump_spec(Some("ssh://ops@jump.example:2200")),
            hop("jump.example", Some("ops"), Some(2200))
        );
        assert_eq!(
            parse_jump_spec(Some("[::1]:2222")),
            hop("::1", None, Some(2222))
        );
        assert_eq!(
            parse_jump_spec(Some("[fe80::1]")),
            hop("fe80::1", None, None)
        );
    }

    #[test]
    fn parse_jump_spec_rejects_chains_and_malformed_hops() {
        assert_eq!(parse_jump_spec(Some("a,b")), JumpSpec::Unsupported);
        assert_eq!(parse_jump_spec(Some("h:notaport")), JumpSpec::Unsupported);
        assert_eq!(parse_jump_spec(Some("u@")), JumpSpec::Unsupported);
        assert_eq!(parse_jump_spec(Some("[::1")), JumpSpec::Unsupported);
    }

    fn jump_of(hosts: &[ParsedHost], name: &str) -> JumpSpec {
        hosts
            .iter()
            .find(|h| h.name == name)
            .expect(name)
            .jump
            .clone()
    }

    #[test]
    fn a_wildcard_host_block_proxy_jump_applies_to_the_hosts_it_matches() {
        let cfg = "\
Host db.corp
    User me
Host *.corp !bastion.corp
    ProxyJump bastion.corp
Host bastion.corp
    User me
Host www.example
";
        let hosts = parse_hosts(cfg);
        assert_eq!(jump_of(&hosts, "db.corp"), hop("bastion.corp", None, None));
        assert_eq!(jump_of(&hosts, "bastion.corp"), JumpSpec::Direct, "negated");
        assert_eq!(jump_of(&hosts, "www.example"), JumpSpec::Direct);
    }

    #[test]
    fn host_patterns_match_case_insensitively_with_globs() {
        let cfg = "Host DB?.Corp\n  ProxyJump b\nHost db1.corp db22.corp\n";
        let hosts = parse_hosts(cfg);
        assert_eq!(jump_of(&hosts, "db1.corp"), hop("b", None, None));
        let second = parse_hosts("Host DB?.Corp\n  ProxyJump b\nHost db22.corp\n");
        assert_eq!(
            jump_of(&second, "db22.corp"),
            JumpSpec::Direct,
            "? is one char"
        );
    }

    #[test]
    fn the_first_proxy_setting_obtained_wins_across_blocks() {
        let cfg = "\
Host *
    ProxyJump early
Host x
    ProxyJump late
";
        assert_eq!(jump_of(&parse_hosts(cfg), "x"), hop("early", None, None));
        let own_first = "Host x\n  ProxyJump own\nHost *\n  ProxyJump later\n";
        assert_eq!(
            jump_of(&parse_hosts(own_first), "x"),
            hop("own", None, None)
        );
    }

    #[test]
    fn a_proxy_jump_before_any_host_line_applies_to_every_host() {
        let hosts = parse_hosts("ProxyJump gw\nHost a\nHost b\n");
        assert_eq!(jump_of(&hosts, "a"), hop("gw", None, None));
        assert_eq!(jump_of(&hosts, "b"), hop("gw", None, None));
    }

    #[test]
    fn a_proxy_command_makes_the_jump_unsupported_unless_none() {
        let own = parse_hosts("Host a\n  ProxyCommand nc %h %p\n");
        assert_eq!(jump_of(&own, "a"), JumpSpec::Unsupported);
        let inherited = parse_hosts("Host a\nHost *\n  ProxyCommand nc %h %p\n");
        assert_eq!(jump_of(&inherited, "a"), JumpSpec::Unsupported);
        let none = parse_hosts("Host a\n  ProxyCommand none\n  ProxyJump b\n");
        assert_eq!(jump_of(&none, "a"), JumpSpec::Direct, "first setting wins");
    }

    #[test]
    fn a_match_block_setting_a_proxy_makes_the_hosts_it_may_apply_to_unsupported() {
        let by_host = "\
Host db.corp
Host other.example
Match host *.corp
    ProxyJump b
";
        let hosts = parse_hosts(by_host);
        assert_eq!(jump_of(&hosts, "db.corp"), JumpSpec::Unsupported);
        assert_eq!(jump_of(&hosts, "other.example"), JumpSpec::Direct);

        let by_hostname = "Host db\n  HostName db.corp\nMatch host *.corp\n  ProxyJump b\n";
        assert_eq!(
            jump_of(&parse_hosts(by_hostname), "db"),
            JumpSpec::Unsupported
        );

        let by_exec = "Host a\nMatch exec \"true\"\n  ProxyCommand nc %h %p\n";
        assert_eq!(jump_of(&parse_hosts(by_exec), "a"), JumpSpec::Unsupported);
    }

    #[test]
    fn every_concrete_alias_of_a_host_line_is_kept() {
        let hosts = parse_hosts("Host bastion *.x !no bastion.corp\n");
        assert_eq!(hosts[0].aliases, ["bastion", "bastion.corp"]);
    }

    #[test]
    fn glob_match_handles_star_and_question_mark() {
        assert!(glob_match(b"*", b""));
        assert!(glob_match(b"*.corp", b"db.corp"));
        assert!(glob_match(b"db?", b"db1"));
        assert!(!glob_match(b"db?", b"db"));
        assert!(!glob_match(b"*.corp", b"corp"));
        assert!(glob_match(b"a*b*c", b"axxbyyc"));
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
            aliases: vec!["h".to_string()],
            host_name: Some("h.example".to_string()),
            port: None,
            user: Some("me".to_string()),
            identity_file: Some("~/.ssh/id_ed25519".to_string()),
            forward_agent: None,
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
            jump: JumpSpec::Direct,
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

    /* -- import: ProxyJump / ForwardAgent ------------------------------ */

    fn named(state: &AppState, name: &str) -> Device {
        state
            .device_store
            .list()
            .into_iter()
            .find(|d| d.name == name)
            .unwrap_or_else(|| panic!("no device named {name}"))
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

    /* -- export (devices → ssh config) ---------------------------------- */

    /// Build an SSH device with an explicit id/name and connection knobs.
    fn ssh_device(id: &str, name: &str, connection: Connection) -> Device {
        Device {
            id: id.to_string(),
            name: name.to_string(),
            connection,
            auto_reconnect: false,
            tags: Vec::new(),
            connect_snippet: None,
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
