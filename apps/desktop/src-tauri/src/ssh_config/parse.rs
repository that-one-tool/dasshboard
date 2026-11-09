//! Pure parsing of the config text into concrete hosts (no disk, no env).

use super::jump_spec::{parse_jump_spec, JumpSpec};

/// One `Host` block reduced to the fields we can map onto a `Device`. Built by
/// the pure parser ([`parse_hosts`]) with no disk or environment access, so the
/// parsing rules are unit-testable in isolation.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct ParsedHost {
    /// The alias that names the device (first non-wildcard token of `Host`).
    pub(super) name: String,
    /// Every concrete alias on the `Host` line (`name` first) — what another
    /// host's `ProxyJump` may call this one.
    pub(super) aliases: Vec<String>,
    /// `HostName` if given, else the alias — the address we actually dial.
    pub(super) host_name: Option<String>,
    /// `Port` if given and parseable; `None` ⇒ the SSH default (22).
    pub(super) port: Option<u16>,
    /// `User` if given; `None` ⇒ fall back to the local login name at map time.
    pub(super) user: Option<String>,
    /// First `IdentityFile` if given ⇒ key auth; `None` ⇒ password auth.
    pub(super) identity_file: Option<String>,
    /// `ForwardAgent`: only `yes`/`true` enable it (a socket path names an
    /// agent other than the default one, which we don't support).
    pub(super) forward_agent: Option<bool>,
    /// `ForwardX11`: only `yes`/`true` enable it.
    pub(super) forward_x11: Option<bool>,
    /// `ForwardX11Trusted`: `yes`/`true` makes forwarding trusted (`-Y`).
    pub(super) forward_x11_trusted: Option<bool>,
    /// The host's effective `ProxyJump` / `ProxyCommand`, from whichever
    /// applicable section of the file sets one first (see [`effective_jump`]).
    pub(super) jump: JumpSpec,
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
pub(super) fn parse_hosts(contents: &str) -> Vec<ParsedHost> {
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
            forward_x11: None,
            forward_x11_trusted: None,
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

/// Sets one mappable keyword on the block under construction.
type KeywordSetter = fn(&mut ParsedHost, String);

/// The keywords we map, by lowercased name. Single-valued fields keep their
/// first value to mirror OpenSSH, where the first setting obtained for a
/// parameter is the one used. An unparseable `Port` is dropped (leaving the
/// default, and the next `Port` a chance) rather than aborting the host.
const KEYWORDS: &[(&str, KeywordSetter)] = &[
    ("hostname", |host, value| {
        set_first(&mut host.host_name, value)
    }),
    ("port", |host, value| {
        if host.port.is_none() {
            host.port = value.parse().ok();
        }
    }),
    ("user", |host, value| set_first(&mut host.user, value)),
    ("identityfile", |host, value| {
        set_first(&mut host.identity_file, value)
    }),
    ("forwardagent", |host, value| {
        set_first_flag(&mut host.forward_agent, &value)
    }),
    ("forwardx11", |host, value| {
        set_first_flag(&mut host.forward_x11, &value)
    }),
    ("forwardx11trusted", |host, value| {
        set_first_flag(&mut host.forward_x11_trusted, &value)
    }),
];

fn apply_keyword(host: &mut ParsedHost, keyword: &str, value: String) {
    let setter = KEYWORDS.iter().find(|(name, _)| *name == keyword);
    if let Some((_, set)) = setter {
        set(host, value);
    }
}

/// Keep the first non-empty value.
fn set_first(slot: &mut Option<String>, value: String) {
    if slot.is_none() && !value.is_empty() {
        *slot = Some(value);
    }
}

fn set_first_flag(slot: &mut Option<bool>, value: &str) {
    if slot.is_none() {
        *slot = Some(is_yes(value));
    }
}

fn is_yes(value: &str) -> bool {
    value.eq_ignore_ascii_case("yes") || value.eq_ignore_ascii_case("true")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssh_config::test_support::*;

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
                forward_x11: None,
                forward_x11_trusted: None,
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
}
