//! A `ProxyJump` value: direct, one hop, or something a device can't hold.

/// A host's `ProxyJump`, before it is matched to a device.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum JumpSpec {
    /// No `ProxyJump`, or `ProxyJump none`.
    Direct,
    /// One hop.
    Hop(JumpHopSpec),
    /// A chain (`a,b`) or a malformed hop — nothing a device can represent.
    Unsupported,
}

/// One `ProxyJump` hop: `[user@]host[:port]` or `ssh://[user@]host[:port]`.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct JumpHopSpec {
    pub(super) host: String,
    pub(super) user: Option<String>,
    pub(super) port: Option<u16>,
}

/// Read a `ProxyJump` value (see [`JumpSpec`]).
pub(super) fn parse_jump_spec(value: Option<&str>) -> JumpSpec {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssh_config::test_support::*;

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
}
