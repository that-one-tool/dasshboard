//! Server side of the SOCKS handshake for dynamic port-forwards (`ssh -D`).
//!
//! A dynamic forward's local listener speaks SOCKS to the client (a browser,
//! `curl --socks5-hostname`, ...) only long enough to learn where it wants to
//! go; `tunnel.rs` then opens a `direct-tcpip` channel to that target and
//! reports the outcome with [`reply`]. Supports SOCKS5 (no-auth only — the
//! listener is loopback-bound, SPEC §8), SOCKS4 and SOCKS4a, `CONNECT` only.
//! A domain name is passed through unresolved, so the SSH server does the DNS
//! lookup (no local DNS leak).
//!
//! Generic over the stream so the whole protocol unit-tests against an
//! in-memory pipe.

use std::io;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

const SOCKS4: u8 = 4;
const SOCKS5: u8 = 5;
const CMD_CONNECT: u8 = 1;

const AUTH_NONE: u8 = 0x00;
const AUTH_NO_ACCEPTABLE: u8 = 0xFF;

const ATYP_IPV4: u8 = 1;
const ATYP_DOMAIN: u8 = 3;
const ATYP_IPV6: u8 = 4;

const V4_GRANTED: u8 = 0x5A;
const V4_REJECTED: u8 = 0x5B;

/// Upper bound on a SOCKS4 NUL-terminated field (user id / 4a host name), so a
/// client can't make us buffer without end.
const MAX_NUL_TERMINATED_LEN: usize = 255;

/// How long [`close`] waits for the client to stop sending after a rejection.
const LINGER: Duration = Duration::from_secs(2);

/// Which protocol the client spoke; the reply must use the same one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Version {
    V4,
    V5,
}

/// The answer to a request, as a SOCKS5 reply code (RFC 1928 §6). SOCKS4 can
/// only say granted or rejected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reply {
    Granted = 0x00,
    GeneralFailure = 0x01,
    NotAllowed = 0x02,
    HostUnreachable = 0x04,
    ConnectionRefused = 0x05,
    CommandNotSupported = 0x07,
    AddressNotSupported = 0x08,
}

/// A client's `CONNECT` request: the target as the client named it (an IP
/// literal or an unresolved host name).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectRequest {
    pub version: Version,
    pub host: String,
    pub port: u16,
}

/// A request read off the wire, before deciding whether we serve it. Reading
/// the whole request first means a rejection is never sent while request
/// bytes are still unread (see [`close`]).
struct ParsedRequest {
    version: Version,
    command: u8,
    target: Result<(String, u16), Reply>,
}

/// Run the client's side of the handshake up to its `CONNECT` request. On a
/// request we can't serve (wrong auth method, command, address type or host
/// name) the matching SOCKS error is written before returning `Err`; the caller
/// should then [`close`] the stream.
pub async fn accept<S>(stream: &mut S) -> io::Result<ConnectRequest>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let parsed = read_request(stream).await?;
    let version = parsed.version;
    match check_request(parsed) {
        Ok(request) => Ok(request),
        Err(rejection) => {
            reply(stream, version, rejection).await?;
            Err(protocol_error("SOCKS request rejected"))
        }
    }
}

/// Answer the `CONNECT` request: [`Reply::Granted`] once the SSH channel to the
/// target is open, otherwise why it isn't.
pub async fn reply<S>(stream: &mut S, version: Version, outcome: Reply) -> io::Result<()>
where
    S: AsyncWrite + Unpin,
{
    match version {
        Version::V4 => stream.write_all(&v4_reply(outcome == Reply::Granted)).await,
        Version::V5 => stream.write_all(&v5_reply(outcome as u8)).await,
    }
}

/// Close after a failure reply without resetting the connection. A socket
/// dropped with unread input is reset (RST), which can discard the reply before
/// the client reads it; so stop writing, then drain whatever the client still
/// sends (for at most [`LINGER`]) before dropping.
pub async fn close<S>(stream: &mut S)
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    close_within(stream, LINGER).await;
}

async fn close_within<S>(stream: &mut S, linger: Duration)
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let _ = stream.shutdown().await;
    let mut discard = tokio::io::sink();
    let drain = tokio::io::copy(stream, &mut discard);
    let _ = tokio::time::timeout(linger, drain).await;
}

async fn read_request<S>(stream: &mut S) -> io::Result<ParsedRequest>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    match stream.read_u8().await? {
        SOCKS5 => read_v5_request(stream).await,
        SOCKS4 => read_v4_request(stream).await,
        _ => Err(protocol_error("unsupported SOCKS version")),
    }
}

fn check_request(parsed: ParsedRequest) -> Result<ConnectRequest, Reply> {
    if parsed.command != CMD_CONNECT {
        return Err(Reply::CommandNotSupported);
    }
    let (host, port) = parsed.target?;
    Ok(ConnectRequest {
        version: parsed.version,
        host,
        port,
    })
}

async fn read_v5_request<S>(stream: &mut S) -> io::Result<ParsedRequest>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    negotiate_v5_auth(stream).await?;
    let [version, command, _reserved, address_type] = read_array::<4, _>(stream).await?;
    if version != SOCKS5 {
        reply(stream, Version::V5, Reply::GeneralFailure).await?;
        return Err(protocol_error("bad SOCKS5 request version"));
    }
    let target = read_v5_target(stream, address_type).await?;
    Ok(ParsedRequest {
        version: Version::V5,
        command,
        target,
    })
}

/// Pick "no authentication" if the client offers it, else refuse.
async fn negotiate_v5_auth<S>(stream: &mut S) -> io::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let count = stream.read_u8().await?;
    let mut methods = vec![0u8; usize::from(count)];
    stream.read_exact(&mut methods).await?;
    if !methods.contains(&AUTH_NONE) {
        stream.write_all(&[SOCKS5, AUTH_NO_ACCEPTABLE]).await?;
        return Err(protocol_error("client offered no supported auth method"));
    }
    stream.write_all(&[SOCKS5, AUTH_NONE]).await
}

async fn read_v5_target<S>(
    stream: &mut S,
    address_type: u8,
) -> io::Result<Result<(String, u16), Reply>>
where
    S: AsyncRead + Unpin,
{
    let host = match address_type {
        ATYP_IPV4 => Ok(Ipv4Addr::from(read_array::<4, _>(stream).await?).to_string()),
        ATYP_IPV6 => Ok(Ipv6Addr::from(read_array::<16, _>(stream).await?).to_string()),
        ATYP_DOMAIN => host_name(read_v5_domain(stream).await?),
        // The address's length is unknown, so the rest can't be read.
        _ => return Ok(Err(Reply::AddressNotSupported)),
    };
    let port = stream.read_u16().await?;
    Ok(host.map(|host| (host, port)))
}

async fn read_v5_domain<S>(stream: &mut S) -> io::Result<Vec<u8>>
where
    S: AsyncRead + Unpin,
{
    let len = stream.read_u8().await?;
    let mut name = vec![0u8; usize::from(len)];
    stream.read_exact(&mut name).await?;
    Ok(name)
}

/// SOCKS4: `CMD PORT IP USERID\0`, plus `HOST\0` for 4a (IP `0.0.0.x`, x ≠ 0).
async fn read_v4_request<S>(stream: &mut S) -> io::Result<ParsedRequest>
where
    S: AsyncRead + Unpin,
{
    let command = stream.read_u8().await?;
    let port = stream.read_u16().await?;
    let ip = read_array::<4, _>(stream).await?;
    read_nul_terminated(stream).await?; // user id: ignored, no auth on loopback
    let host = read_v4_host(stream, ip).await?;
    Ok(ParsedRequest {
        version: Version::V4,
        command,
        target: host.map(|host| (host, port)),
    })
}

async fn read_v4_host<S>(stream: &mut S, ip: [u8; 4]) -> io::Result<Result<String, Reply>>
where
    S: AsyncRead + Unpin,
{
    if is_socks4a_marker(ip) {
        Ok(host_name(read_nul_terminated(stream).await?))
    } else {
        Ok(Ok(Ipv4Addr::from(ip).to_string()))
    }
}

/// SOCKS4a signals "host name follows" with the invalid IP `0.0.0.x`, x ≠ 0.
fn is_socks4a_marker(ip: [u8; 4]) -> bool {
    ip[..3] == [0, 0, 0] && ip[3] != 0
}

async fn read_nul_terminated<S>(stream: &mut S) -> io::Result<Vec<u8>>
where
    S: AsyncRead + Unpin,
{
    let mut bytes = Vec::new();
    loop {
        let byte = stream.read_u8().await?;
        if byte == 0 {
            return Ok(bytes);
        }
        push_bounded(&mut bytes, byte)?;
    }
}

fn push_bounded(bytes: &mut Vec<u8>, byte: u8) -> io::Result<()> {
    if bytes.len() == MAX_NUL_TERMINATED_LEN {
        return Err(protocol_error("SOCKS4 field too long"));
    }
    bytes.push(byte);
    Ok(())
}

/// A client-supplied host name, restricted to what DNS names and IP literals
/// use. Anything else (NUL, control bytes, spaces, non-ASCII) is refused here:
/// passed on, OpenSSH treats a NUL inside the `direct-tcpip` host as a fatal
/// protocol error and drops the whole SSH connection — every forward with it.
fn host_name(bytes: Vec<u8>) -> Result<String, Reply> {
    let valid = !bytes.is_empty() && bytes.iter().copied().all(is_host_name_byte);
    match (valid, String::from_utf8(bytes)) {
        (true, Ok(name)) => Ok(name),
        _ => Err(Reply::HostUnreachable),
    }
}

/// Letters, digits, `.`, `-`, `_` (seen in real DNS names) and `:` (IPv6).
fn is_host_name_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_' | b':')
}

async fn read_array<const N: usize, S>(stream: &mut S) -> io::Result<[u8; N]>
where
    S: AsyncRead + Unpin,
{
    let mut buf = [0u8; N];
    stream.read_exact(&mut buf).await?;
    Ok(buf)
}

/// A SOCKS5 reply. The bound address is reported as `0.0.0.0:0`: the real one
/// lives on the SSH server and clients don't use it for `CONNECT`.
fn v5_reply(code: u8) -> [u8; 10] {
    [SOCKS5, code, 0, ATYP_IPV4, 0, 0, 0, 0, 0, 0]
}

fn v4_reply(granted: bool) -> [u8; 8] {
    let code = if granted { V4_GRANTED } else { V4_REJECTED };
    [0, code, 0, 0, 0, 0, 0, 0]
}

fn protocol_error(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{duplex, DuplexStream};

    /// Feed `client_bytes` to [`accept`] over an in-memory pipe; return its
    /// result and everything it wrote back to the client.
    async fn run_accept(client_bytes: &[u8]) -> (io::Result<ConnectRequest>, Vec<u8>) {
        let (mut client, mut server) = duplex(1024);
        client.write_all(client_bytes).await.unwrap();
        client.shutdown().await.unwrap();
        let result = accept(&mut server).await;
        drop(server);
        (result, read_all(&mut client).await)
    }

    async fn read_all(client: &mut DuplexStream) -> Vec<u8> {
        let mut written = Vec::new();
        client.read_to_end(&mut written).await.unwrap();
        written
    }

    fn connect(version: Version, host: &str, port: u16) -> ConnectRequest {
        ConnectRequest {
            version,
            host: host.to_string(),
            port,
        }
    }

    /// A SOCKS5 no-auth greeting + CONNECT to `host` (as a domain) on port 80.
    fn socks5_domain_request(host: &[u8]) -> Vec<u8> {
        let mut bytes = vec![5, 1, 0, 5, 1, 0, 3, host.len() as u8];
        bytes.extend_from_slice(host);
        bytes.extend_from_slice(&80u16.to_be_bytes());
        bytes
    }

    #[tokio::test]
    async fn socks5_connect_by_domain_passes_the_name_through_unresolved() {
        let mut bytes = vec![5, 1, 0, 5, 1, 0, 3, 11];
        bytes.extend_from_slice(b"example.com");
        bytes.extend_from_slice(&443u16.to_be_bytes());
        let (result, written) = run_accept(&bytes).await;
        assert_eq!(result.unwrap(), connect(Version::V5, "example.com", 443));
        assert_eq!(written, vec![5, 0], "only the auth choice is written");
    }

    #[tokio::test]
    async fn socks5_connect_by_ipv4() {
        let bytes = [5, 1, 0, 5, 1, 0, 1, 10, 0, 0, 5, 0x15, 0x38];
        let (result, _) = run_accept(&bytes).await;
        assert_eq!(result.unwrap(), connect(Version::V5, "10.0.0.5", 5432));
    }

    #[tokio::test]
    async fn socks5_connect_by_ipv6() {
        let mut bytes = vec![5, 1, 0, 5, 1, 0, 4];
        bytes.extend_from_slice(&Ipv6Addr::LOCALHOST.octets());
        bytes.extend_from_slice(&80u16.to_be_bytes());
        let (result, _) = run_accept(&bytes).await;
        assert_eq!(result.unwrap(), connect(Version::V5, "::1", 80));
    }

    #[tokio::test]
    async fn socks5_accepts_underscores_and_ipv6_literal_names() {
        for name in ["_dmarc.example.com", "fe80::1"] {
            let (result, _) = run_accept(&socks5_domain_request(name.as_bytes())).await;
            assert_eq!(result.unwrap().host, name);
        }
    }

    #[tokio::test]
    async fn socks5_picks_no_auth_among_several_offered_methods() {
        let bytes = [5, 2, 2, 0, 5, 1, 0, 1, 127, 0, 0, 1, 0, 80];
        let (result, written) = run_accept(&bytes).await;
        assert!(result.is_ok());
        assert_eq!(written, vec![5, 0]);
    }

    #[tokio::test]
    async fn socks5_refuses_a_client_that_requires_auth() {
        let (result, written) = run_accept(&[5, 1, 2]).await;
        assert!(result.is_err());
        assert_eq!(written, vec![5, 0xFF]);
    }

    #[tokio::test]
    async fn socks5_rejects_commands_other_than_connect() {
        // BIND (2) to 127.0.0.1:80.
        let (result, written) = run_accept(&[5, 1, 0, 5, 2, 0, 1, 127, 0, 0, 1, 0, 80]).await;
        assert!(result.is_err());
        assert_eq!(written[2..], v5_reply(Reply::CommandNotSupported as u8));
    }

    #[tokio::test]
    async fn socks5_rejects_unknown_address_types() {
        let (result, written) = run_accept(&[5, 1, 0, 5, 1, 0, 9]).await;
        assert!(result.is_err());
        assert_eq!(written[2..], v5_reply(Reply::AddressNotSupported as u8));
    }

    #[tokio::test]
    async fn socks5_answers_a_bad_request_version_with_a_failure() {
        let (result, written) = run_accept(&[5, 1, 0, 4, 1, 0, 1]).await;
        assert!(result.is_err());
        assert_eq!(written[2..], v5_reply(Reply::GeneralFailure as u8));
    }

    #[tokio::test]
    async fn socks5_rejects_an_empty_domain() {
        let (result, written) = run_accept(&socks5_domain_request(b"")).await;
        assert!(result.is_err());
        assert_eq!(written[2..], v5_reply(Reply::HostUnreachable as u8));
    }

    #[tokio::test]
    async fn socks5_rejects_names_that_could_break_the_ssh_connection() {
        let names: [&[u8]; 5] = [b"a\0b", b"a\nb", b"a b", b"\xff\xfe", "café.lan".as_bytes()];
        for name in names {
            let (result, written) = run_accept(&socks5_domain_request(name)).await;
            assert!(result.is_err(), "{name:?} must be refused");
            assert_eq!(written[2..], v5_reply(Reply::HostUnreachable as u8));
        }
    }

    #[tokio::test]
    async fn socks4_connect_by_ipv4_ignores_the_user_id() {
        let mut bytes = vec![4, 1, 0, 22, 192, 168, 1, 10];
        bytes.extend_from_slice(b"alice\0");
        let (result, written) = run_accept(&bytes).await;
        assert_eq!(result.unwrap(), connect(Version::V4, "192.168.1.10", 22));
        assert!(written.is_empty(), "SOCKS4 has no greeting reply");
    }

    #[tokio::test]
    async fn socks4a_connect_by_domain() {
        let mut bytes = vec![4, 1, 0, 80, 0, 0, 0, 1, 0];
        bytes.extend_from_slice(b"nas.lan\0");
        let (result, _) = run_accept(&bytes).await;
        assert_eq!(result.unwrap(), connect(Version::V4, "nas.lan", 80));
    }

    #[tokio::test]
    async fn socks4a_rejects_an_empty_or_invalid_host() {
        for host in [&b"\0"[..], b"a\nb\0"] {
            let mut bytes = vec![4, 1, 0, 80, 0, 0, 0, 1, 0];
            bytes.extend_from_slice(host);
            let (result, written) = run_accept(&bytes).await;
            assert!(result.is_err());
            assert_eq!(written, v4_reply(false));
        }
    }

    #[tokio::test]
    async fn socks4_rejects_bind() {
        let (result, written) = run_accept(&[4, 2, 0, 80, 127, 0, 0, 1, 0]).await;
        assert!(result.is_err());
        assert_eq!(written, v4_reply(false));
    }

    #[tokio::test]
    async fn socks4a_bind_is_read_in_full_before_the_rejection() {
        // BIND with a 4a host: the host must be consumed, not left unread.
        let mut bytes = vec![4, 2, 0, 80, 0, 0, 0, 1, 0];
        bytes.extend_from_slice(b"nas.lan\0");
        let (mut client, mut server) = duplex(1024);
        client.write_all(&bytes).await.unwrap();
        assert!(accept(&mut server).await.is_err());
        client.shutdown().await.unwrap();
        let mut rest = Vec::new();
        server.read_to_end(&mut rest).await.unwrap();
        assert!(rest.is_empty(), "unread request bytes: {rest:?}");
    }

    #[tokio::test]
    async fn socks4_rejects_an_overlong_user_id() {
        let mut bytes = vec![4, 1, 0, 80, 127, 0, 0, 1];
        bytes.extend(std::iter::repeat_n(b'a', MAX_NUL_TERMINATED_LEN + 1));
        bytes.push(0);
        let (result, _) = run_accept(&bytes).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn rejects_unknown_protocol_versions() {
        let (result, written) = run_accept(b"GET / HTTP/1.1\r\n").await;
        assert!(result.is_err());
        assert!(written.is_empty());
    }

    #[tokio::test]
    async fn replies_use_the_client_protocol() {
        let cases = [
            (Version::V5, Reply::Granted, v5_reply(0x00).to_vec()),
            (
                Version::V5,
                Reply::ConnectionRefused,
                v5_reply(0x05).to_vec(),
            ),
            (Version::V5, Reply::NotAllowed, v5_reply(0x02).to_vec()),
            (Version::V4, Reply::Granted, vec![0, 0x5A, 0, 0, 0, 0, 0, 0]),
            (
                Version::V4,
                Reply::ConnectionRefused,
                vec![0, 0x5B, 0, 0, 0, 0, 0, 0],
            ),
        ];
        for (version, outcome, expected) in cases {
            let mut written = Vec::new();
            reply(&mut written, version, outcome).await.unwrap();
            assert_eq!(written, expected, "{version:?} {outcome:?}");
        }
    }

    #[tokio::test]
    async fn close_ends_our_side_and_drains_the_client() {
        let (mut client, mut server) = duplex(1024);
        client.write_all(b"early data").await.unwrap();
        let closing = tokio::spawn(async move { close(&mut server).await });
        // The client sees our end close (EOF), then closes its own.
        let mut seen = Vec::new();
        client.read_to_end(&mut seen).await.unwrap();
        assert!(seen.is_empty());
        client.shutdown().await.unwrap();
        tokio::time::timeout(Duration::from_secs(1), closing)
            .await
            .expect("close returns once the client is done")
            .unwrap();
    }

    #[tokio::test]
    async fn close_gives_up_on_a_client_that_never_finishes() {
        let (_client, mut server) = duplex(1024);
        let linger = Duration::from_millis(50);
        tokio::time::timeout(Duration::from_secs(1), close_within(&mut server, linger))
            .await
            .expect("close must give up after its linger time");
    }
}
