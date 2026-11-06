//! Reads the local X server's cookie from an Xauthority file.
//!
//! Each entry is: family (u16), then address, display number, auth name and
//! auth data, each a big-endian u16 length and its bytes. An entry applies
//! when its family and address name the X server we connected to (as Xlib
//! picks it), so a cookie for one host never goes to another.

use std::net::IpAddr;
use std::path::PathBuf;

pub(crate) const COOKIE_PROTOCOL: &[u8] = b"MIT-MAGIC-COOKIE-1";

const FAMILY_INTERNET: u16 = 0;
const FAMILY_INTERNET6: u16 = 6;
const FAMILY_LOCAL: u16 = 256;
const FAMILY_WILD: u16 = 65535;

/// The X server as Xauthority names it: this machine by hostname (a socket or
/// loopback connection), or another host by IP.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AuthAddress {
    family: u16,
    address: Vec<u8>,
}

impl AuthAddress {
    pub(crate) fn local(hostname: &str) -> AuthAddress {
        AuthAddress {
            family: FAMILY_LOCAL,
            address: hostname.as_bytes().to_vec(),
        }
    }

    pub(crate) fn ip(ip: IpAddr) -> AuthAddress {
        match ip.to_canonical() {
            IpAddr::V4(v4) => AuthAddress {
                family: FAMILY_INTERNET,
                address: v4.octets().to_vec(),
            },
            IpAddr::V6(v6) => AuthAddress {
                family: FAMILY_INTERNET6,
                address: v6.octets().to_vec(),
            },
        }
    }

    fn matches(&self, entry: &Entry) -> bool {
        let same = entry.family == self.family && entry.address == self.address;
        same || entry.family == FAMILY_WILD
    }
}

struct Entry<'a> {
    family: u16,
    address: &'a [u8],
    number: &'a [u8],
    name: &'a [u8],
    data: &'a [u8],
}

/// `$XAUTHORITY`, else `~/.Xauthority`.
pub(crate) fn xauthority_path(xauthority: Option<&str>, home: Option<&str>) -> Option<PathBuf> {
    let set = |value: &&str| !value.is_empty();
    if let Some(path) = xauthority.filter(set) {
        return Some(PathBuf::from(path));
    }
    home.filter(set)
        .map(|home| PathBuf::from(home).join(".Xauthority"))
}

/// The `MIT-MAGIC-COOKIE-1` data for display `display_number` of the X
/// server at `server`. An entry with no number applies to every display.
pub(crate) fn find_cookie(
    mut file: &[u8],
    server: &AuthAddress,
    display_number: u32,
) -> Option<Vec<u8>> {
    let number = display_number.to_string();
    std::iter::from_fn(|| read_entry(&mut file))
        .filter(|entry| entry.name == COOKIE_PROTOCOL && server.matches(entry))
        .find(|entry| matches_number(entry, &number))
        .map(|entry| entry.data.to_vec())
}

fn matches_number(entry: &Entry, number: &str) -> bool {
    entry.number.is_empty() || entry.number == number.as_bytes()
}

fn read_entry<'a>(input: &mut &'a [u8]) -> Option<Entry<'a>> {
    Some(Entry {
        family: read_u16(input)?,
        address: read_field(input)?,
        number: read_field(input)?,
        name: read_field(input)?,
        data: read_field(input)?,
    })
}

fn read_u16(input: &mut &[u8]) -> Option<u16> {
    let (head, rest) = input.split_first_chunk::<2>()?;
    *input = rest;
    Some(u16::from_be_bytes(*head))
}

fn read_field<'a>(input: &mut &'a [u8]) -> Option<&'a [u8]> {
    let len = usize::from(read_u16(input)?);
    let field = input.get(..len)?;
    *input = &input[len..];
    Some(field)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    pub(crate) fn entry_for(family: u16, address: &[u8], number: &str, data: &[u8]) -> Vec<u8> {
        let mut out = family.to_be_bytes().to_vec();
        for field in [address, number.as_bytes(), COOKIE_PROTOCOL, data] {
            out.extend_from_slice(&u16::try_from(field.len()).unwrap().to_be_bytes());
            out.extend_from_slice(field);
        }
        out
    }

    /// An entry for display `number` of this machine named `myhost`.
    fn local(number: &str, data: &[u8]) -> Vec<u8> {
        entry_for(FAMILY_LOCAL, b"myhost", number, data)
    }

    /// An entry for display `number` of any host.
    pub(crate) fn wild(number: &str, data: &[u8]) -> Vec<u8> {
        entry_for(FAMILY_WILD, b"", number, data)
    }

    fn myhost() -> AuthAddress {
        AuthAddress::local("myhost")
    }

    #[test]
    fn finds_the_cookie_for_the_display_number() {
        let file = [local("0", b"zero"), local("1", b"one")].concat();
        assert_eq!(find_cookie(&file, &myhost(), 1), Some(b"one".to_vec()));
    }

    #[test]
    fn skips_other_protocols() {
        let mut other = local("0", b"xdm");
        let name_at = 2 + 2 + 6 + 2 + 1 + 2;
        other[name_at] = b'X';
        let file = [other, local("0", b"cookie")].concat();
        assert_eq!(find_cookie(&file, &myhost(), 0), Some(b"cookie".to_vec()));
    }

    #[test]
    fn a_local_cookie_needs_this_hostname() {
        let file = [
            entry_for(FAMILY_LOCAL, b"otherhost", "0", b"other"),
            local("0", b"mine"),
        ]
        .concat();
        assert_eq!(find_cookie(&file, &myhost(), 0), Some(b"mine".to_vec()));
        assert_eq!(find_cookie(&file, &AuthAddress::local("third"), 0), None);
    }

    #[test]
    fn a_remote_server_gets_only_its_own_ip_cookie() {
        let remote = AuthAddress::ip(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 7)));
        let file = [
            local("0", b"local"),
            entry_for(FAMILY_INTERNET, &[10, 0, 0, 8], "0", b"neighbour"),
            entry_for(FAMILY_INTERNET, &[10, 0, 0, 7], "0", b"remote"),
        ]
        .concat();
        assert_eq!(find_cookie(&file, &remote, 0), Some(b"remote".to_vec()));
        assert_eq!(find_cookie(&file[..file.len() / 3], &remote, 0), None);
    }

    #[test]
    fn ipv6_and_mapped_ipv4_addresses_match_their_family() {
        let v6 = Ipv6Addr::new(0xfd00, 0, 0, 0, 0, 0, 0, 1);
        let file = [
            entry_for(FAMILY_INTERNET6, &v6.octets(), "0", b"six"),
            entry_for(FAMILY_INTERNET, &[10, 0, 0, 7], "0", b"four"),
        ]
        .concat();
        let found = |ip| find_cookie(&file, &AuthAddress::ip(ip), 0);
        assert_eq!(found(IpAddr::V6(v6)), Some(b"six".to_vec()));
        let mapped = Ipv4Addr::new(10, 0, 0, 7).to_ipv6_mapped();
        assert_eq!(found(IpAddr::V6(mapped)), Some(b"four".to_vec()));
    }

    #[test]
    fn a_wild_entry_matches_any_server() {
        let file = wild("0", b"wild");
        let remote = AuthAddress::ip(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 7)));
        assert_eq!(find_cookie(&file, &remote, 0), Some(b"wild".to_vec()));
        assert_eq!(find_cookie(&file, &myhost(), 0), Some(b"wild".to_vec()));
    }

    #[test]
    fn an_entry_without_number_matches_any_display() {
        let file = local("", b"any");
        assert_eq!(find_cookie(&file, &myhost(), 7), Some(b"any".to_vec()));
    }

    #[test]
    fn missing_or_truncated_entries_give_none() {
        let file = local("0", b"cookie");
        assert_eq!(find_cookie(&file, &myhost(), 1), None);
        assert_eq!(find_cookie(&file[..file.len() - 1], &myhost(), 0), None);
        assert_eq!(find_cookie(&[], &myhost(), 0), None);
    }

    #[test]
    fn path_prefers_xauthority_then_home() {
        let path = |x, h| xauthority_path(x, h);
        assert_eq!(
            path(Some("/x/auth"), Some("/home/u")),
            Some(PathBuf::from("/x/auth"))
        );
        assert_eq!(
            path(Some(""), Some("/home/u")),
            Some(PathBuf::from("/home/u/.Xauthority"))
        );
        assert_eq!(path(None, None), None);
    }
}
