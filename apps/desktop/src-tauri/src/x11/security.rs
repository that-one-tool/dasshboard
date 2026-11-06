//! Untrusted X11 (`ssh -X`): a fresh untrusted cookie from the local X server's
//! SECURITY extension, as `xauth generate . MIT-MAGIC-COOKIE-1 untrusted` does.
//! The server, not this connection, owns the cookie: it outlives the
//! connection that asked for it, and is dropped `COOKIE_TIMEOUT_SECS` after its
//! last client leaves.

use std::io;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use super::setup::{append_padded, ClientSetup};
use super::xauthority::COOKIE_PROTOCOL;

const QUERY_EXTENSION: u8 = 98;
const EXTENSION_NAME: &[u8] = b"SECURITY";
const QUERY_VERSION: u8 = 0;
const GENERATE_AUTHORIZATION: u8 = 1;
const SUPPORTED_MAJOR_VERSION: u16 = 1;
const TIMEOUT_ATTRIBUTE: u32 = 1 << 0;
const TRUST_LEVEL_ATTRIBUTE: u32 = 1 << 1;
const CLIENT_UNTRUSTED: u32 = 1;
/// Counted only while no client uses the cookie; ours is used at once.
const COOKIE_TIMEOUT_SECS: u32 = 60;
const REPLY_LEN: usize = 32;
/// Our replies carry at most a cookie; anything longer is not one of them.
const MAX_REPLY_EXTRA: usize = 1024;

/// The cookie for a client using `cookie` (the real one, `None` without
/// access control) on `x_server`, a fresh connection to the X server.
pub(crate) async fn generate_untrusted_cookie<S>(
    mut x_server: S,
    cookie: Option<&[u8]>,
) -> io::Result<Vec<u8>>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let setup = ClientSetup::little_endian().with_cookie(cookie);
    x_server.write_all(&setup).await?;
    read_setup_reply(&mut x_server).await?;
    let opcode = query_extension_opcode(&mut x_server).await?;
    check_version(&mut x_server, opcode).await?;
    let reply = round_trip(&mut x_server, &generate_request(opcode)).await?;
    generated_cookie(&reply)
}

async fn read_setup_reply<S: AsyncRead + Unpin>(x_server: &mut S) -> io::Result<()> {
    let mut header = [0u8; 8];
    x_server.read_exact(&mut header).await?;
    let mut extra = vec![0u8; usize::from(u16_at(&header, 6)) * 4];
    x_server.read_exact(&mut extra).await?;
    match header[0] {
        1 => Ok(()),
        0 => Err(invalid(format!(
            "the X server refused the connection ({})",
            refusal_reason(&extra, header[1])
        ))),
        _ => Err(invalid("the X server asked for more authentication")),
    }
}

fn refusal_reason(extra: &[u8], len: u8) -> String {
    let reason = extra.get(..usize::from(len)).unwrap_or(extra);
    String::from_utf8_lossy(reason).trim().to_string()
}

async fn query_extension_opcode<S>(x_server: &mut S) -> io::Result<u8>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let reply = round_trip(x_server, &query_extension_request()).await?;
    if reply[8] == 0 {
        return Err(invalid("the X server has no SECURITY extension"));
    }
    Ok(reply[9])
}

async fn check_version<S>(x_server: &mut S, opcode: u8) -> io::Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let mut request = vec![opcode, QUERY_VERSION, 2, 0];
    request.extend_from_slice(&SUPPORTED_MAJOR_VERSION.to_le_bytes());
    request.extend_from_slice(&0u16.to_le_bytes());
    let reply = round_trip(x_server, &request).await?;
    if u16_at(&reply, 8) != SUPPORTED_MAJOR_VERSION {
        return Err(invalid("unsupported SECURITY extension version"));
    }
    Ok(())
}

fn query_extension_request() -> Vec<u8> {
    let mut request = vec![QUERY_EXTENSION, 0];
    request.extend_from_slice(&request_words(8 + EXTENSION_NAME.len()));
    request.extend_from_slice(&u16_le(EXTENSION_NAME.len()));
    request.extend_from_slice(&[0, 0]);
    append_padded(&mut request, EXTENSION_NAME);
    request
}

/// Value-mask in the fixed header, as libXext and the X server lay it out
/// (the spec's encoding table puts it after the strings).
fn generate_request(opcode: u8) -> Vec<u8> {
    let mut request = vec![opcode, GENERATE_AUTHORIZATION];
    // Fixed header, padded auth name (no auth data), two attribute values.
    let len = 12 + COOKIE_PROTOCOL.len().next_multiple_of(4) + 8;
    request.extend_from_slice(&request_words(len));
    request.extend_from_slice(&u16_le(COOKIE_PROTOCOL.len()));
    request.extend_from_slice(&0u16.to_le_bytes());
    request.extend_from_slice(&(TIMEOUT_ATTRIBUTE | TRUST_LEVEL_ATTRIBUTE).to_le_bytes());
    append_padded(&mut request, COOKIE_PROTOCOL);
    request.extend_from_slice(&COOKIE_TIMEOUT_SECS.to_le_bytes());
    request.extend_from_slice(&CLIENT_UNTRUSTED.to_le_bytes());
    request
}

fn generated_cookie(reply: &[u8]) -> io::Result<Vec<u8>> {
    let len = usize::from(u16_at(reply, 12));
    match reply.get(REPLY_LEN..REPLY_LEN + len) {
        Some(cookie) if !cookie.is_empty() => Ok(cookie.to_vec()),
        _ => Err(invalid("the X server sent a malformed cookie")),
    }
}

async fn round_trip<S>(x_server: &mut S, request: &[u8]) -> io::Result<Vec<u8>>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    x_server.write_all(request).await?;
    let mut reply = vec![0u8; REPLY_LEN];
    x_server.read_exact(&mut reply).await?;
    check_is_reply(&reply)?;
    reply.resize(REPLY_LEN + extra_len(&reply)?, 0);
    x_server.read_exact(&mut reply[REPLY_LEN..]).await?;
    Ok(reply)
}

fn check_is_reply(reply: &[u8]) -> io::Result<()> {
    match reply[0] {
        1 => Ok(()),
        0 => Err(invalid(format!("the X server sent error {}", reply[1]))),
        _ => Err(invalid("the X server sent an event instead of a reply")),
    }
}

fn extra_len(reply: &[u8]) -> io::Result<usize> {
    let words = u32::from_le_bytes([reply[4], reply[5], reply[6], reply[7]]);
    usize::try_from(words)
        .ok()
        .and_then(|words| words.checked_mul(4))
        .filter(|len| *len <= MAX_REPLY_EXTRA)
        .ok_or_else(|| invalid("the X server sent an oversized reply"))
}

/// The request-length field: total bytes, padded, in 4-byte words.
fn request_words(bytes: usize) -> [u8; 2] {
    u16_le(bytes.div_ceil(4))
}

/// Every length here is a small constant.
fn u16_le(value: usize) -> [u8; 2] {
    u16::try_from(value).unwrap_or(u16::MAX).to_le_bytes()
}

fn u16_at(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::x11::setup::read_setup;
    use crate::x11::xauthority::COOKIE_PROTOCOL;
    use tokio::io::{duplex, AsyncReadExt, AsyncWriteExt};

    const OPCODE: u8 = 140;

    /// A 32-byte reply (type 1) with `body` from byte 8 and `extra` after it.
    fn reply(body: &[u8], extra: &[u8]) -> Vec<u8> {
        let words = u32::try_from(extra.len() / 4).unwrap();
        let mut out = vec![1, 0, 1, 0];
        out.extend_from_slice(&words.to_le_bytes());
        out.extend_from_slice(body);
        out.resize(32, 0);
        out.extend_from_slice(extra);
        out
    }

    fn setup_reply(status: u8, extra: &[u8]) -> Vec<u8> {
        let words = u16::try_from(extra.len() / 4).unwrap();
        let mut out = vec![status, 0, 11, 0, 0, 0];
        out.extend_from_slice(&words.to_le_bytes());
        out.extend_from_slice(extra);
        out
    }

    fn extension_reply(present: bool) -> Vec<u8> {
        reply(&[u8::from(present), OPCODE, 0, 0], &[])
    }

    fn version_reply(major: u16) -> Vec<u8> {
        reply(&[major.to_le_bytes(), [0, 0]].concat(), &[])
    }

    fn generate_reply(cookie: &[u8]) -> Vec<u8> {
        let length = u16::try_from(cookie.len()).unwrap().to_le_bytes();
        let mut extra = cookie.to_vec();
        extra.resize(cookie.len().next_multiple_of(4), 0);
        reply(&[&7u32.to_le_bytes()[..], &length].concat(), &extra)
    }

    /// Everything a cooperative X server answers, in order, granting `cookie`.
    pub(crate) fn security_replies(cookie: &[u8]) -> Vec<u8> {
        [
            setup_reply(1, &[0; 8]),
            extension_reply(true),
            version_reply(1),
            generate_reply(cookie),
        ]
        .concat()
    }

    /// Run the exchange against a server that answers `replies` up front.
    /// Returns its result and what the client sent.
    async fn exchange(replies: &[u8], cookie: Option<&[u8]>) -> (io::Result<Vec<u8>>, Vec<u8>) {
        let (client, mut server) = duplex(64 * 1024);
        server.write_all(replies).await.unwrap();
        server.shutdown().await.unwrap();
        let result = generate_untrusted_cookie(client, cookie).await;
        let mut sent = Vec::new();
        server.read_to_end(&mut sent).await.unwrap();
        (result, sent)
    }

    fn error_text(result: io::Result<Vec<u8>>) -> String {
        result.unwrap_err().to_string()
    }

    #[tokio::test]
    async fn returns_the_cookie_the_server_generated() {
        let (result, _) = exchange(&security_replies(b"untrusted cookie"), Some(b"real")).await;
        assert_eq!(result.unwrap(), b"untrusted cookie");
    }

    #[tokio::test]
    async fn sends_the_requests_the_security_extension_expects() {
        let (_, sent) = exchange(&security_replies(b"generated"), Some(b"real")).await;
        let mut sent = &sent[..];
        let setup = read_setup(&mut sent).await.unwrap();
        assert!(setup.carries_cookie(b"real"));
        let query_extension = [&[98, 0, 4, 0, 8, 0, 0, 0][..], b"SECURITY"].concat();
        let query_version = [OPCODE, 0, 2, 0, 1, 0, 0, 0];
        let generate = [
            &[OPCODE, 1, 10, 0, 18, 0, 0, 0, 3, 0, 0, 0][..],
            COOKIE_PROTOCOL,
            &[0, 0],
            &60u32.to_le_bytes(),
            &1u32.to_le_bytes(),
        ]
        .concat();
        assert_eq!(
            sent,
            [query_extension, query_version.to_vec(), generate].concat()
        );
    }

    #[tokio::test]
    async fn connects_without_auth_when_there_is_no_real_cookie() {
        let (_, sent) = exchange(&security_replies(b"generated"), None).await;
        assert_eq!(&sent[..12], &[b'l', 0, 11, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    }

    #[tokio::test]
    async fn reports_why_the_server_refused_the_connection() {
        let reason = b"No protocol specified\0\0\0";
        let mut refused = setup_reply(0, reason);
        refused[1] = 21;
        let (result, _) = exchange(&refused, None).await;
        assert!(error_text(result).contains("No protocol specified"));
    }

    #[tokio::test]
    async fn fails_when_the_server_wants_more_authentication() {
        let (result, _) = exchange(&setup_reply(2, &[0; 4]), None).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn fails_without_the_security_extension() {
        let replies = [setup_reply(1, &[]), extension_reply(false)].concat();
        let (result, sent) = exchange(&replies, None).await;
        assert!(error_text(result).contains("SECURITY"));
        assert_eq!(
            sent.len(),
            12 + 16,
            "nothing is asked of a missing extension"
        );
    }

    #[tokio::test]
    async fn fails_on_another_extension_version() {
        let replies = [setup_reply(1, &[]), extension_reply(true), version_reply(2)].concat();
        let (result, _) = exchange(&replies, None).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn fails_on_an_x_error() {
        let mut error = extension_reply(true);
        error[0] = 0;
        let (result, _) = exchange(&[setup_reply(1, &[]), error].concat(), None).await;
        assert!(error_text(result).contains("error"));
    }

    #[tokio::test]
    async fn fails_on_an_event_instead_of_a_reply() {
        let mut event = extension_reply(true);
        event[0] = 2;
        let (result, _) = exchange(&[setup_reply(1, &[]), event].concat(), None).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn rejects_an_oversized_reply() {
        let mut huge = extension_reply(true);
        huge[4..8].copy_from_slice(&u32::MAX.to_le_bytes());
        let (result, _) = exchange(&[setup_reply(1, &[]), huge].concat(), None).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn rejects_a_cookie_longer_than_its_reply() {
        let mut generated = generate_reply(b"1234");
        generated[12..14].copy_from_slice(&64u16.to_le_bytes());
        let replies = [
            setup_reply(1, &[]),
            extension_reply(true),
            version_reply(1),
            generated,
        ]
        .concat();
        let (result, _) = exchange(&replies, None).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn rejects_an_empty_cookie() {
        let replies = [
            setup_reply(1, &[]),
            extension_reply(true),
            version_reply(1),
            generate_reply(b""),
        ]
        .concat();
        let (result, _) = exchange(&replies, None).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn fails_when_the_server_hangs_up() {
        let (result, _) = exchange(&setup_reply(1, &[]), None).await;
        assert!(result.is_err());
    }
}
