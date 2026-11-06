//! The connection setup an X client sends first. It carries the fake cookie
//! the server was given; it goes to the local X server with the real one.

use std::io;

use tokio::io::{AsyncRead, AsyncReadExt};

use super::xauthority::COOKIE_PROTOCOL;

const HEADER_LEN: usize = 12;
/// Byte order, padding, protocol major and minor: copied as is.
const PREFIX_LEN: usize = 6;

pub(crate) struct ClientSetup {
    prefix: [u8; PREFIX_LEN],
    big_endian: bool,
    name: Vec<u8>,
    data: Vec<u8>,
}

pub(crate) async fn read_setup<R: AsyncRead + Unpin>(reader: &mut R) -> io::Result<ClientSetup> {
    let mut header = [0u8; HEADER_LEN];
    reader.read_exact(&mut header).await?;
    let big_endian = is_big_endian(header[0])?;
    let name_len = decode_u16([header[6], header[7]], big_endian);
    let data_len = decode_u16([header[8], header[9]], big_endian);
    let name = read_padded(reader, name_len).await?;
    let data = read_padded(reader, data_len).await?;
    let mut prefix = [0u8; PREFIX_LEN];
    prefix.copy_from_slice(&header[..PREFIX_LEN]);
    Ok(ClientSetup {
        prefix,
        big_endian,
        name,
        data,
    })
}

impl ClientSetup {
    /// A protocol 11.0 setup of our own, in little-endian byte order.
    pub(crate) fn little_endian() -> ClientSetup {
        ClientSetup {
            prefix: [b'l', 0, 11, 0, 0, 0],
            big_endian: false,
            name: Vec::new(),
            data: Vec::new(),
        }
    }

    pub(crate) fn carries_cookie(&self, cookie: &[u8]) -> bool {
        self.name == COOKIE_PROTOCOL && constant_time_eq(&self.data, cookie)
    }

    /// This setup with `cookie` as its auth, or with no auth when `None` (an
    /// X server without access control).
    pub(crate) fn with_cookie(&self, cookie: Option<&[u8]>) -> Vec<u8> {
        let (name, data) = match cookie {
            Some(cookie) => (COOKIE_PROTOCOL, cookie),
            None => (&[][..], &[][..]),
        };
        let mut out = self.prefix.to_vec();
        out.extend_from_slice(&self.encode_len(name.len()));
        out.extend_from_slice(&self.encode_len(data.len()));
        out.extend_from_slice(&[0, 0]);
        append_padded(&mut out, name);
        append_padded(&mut out, data);
        out
    }

    fn encode_len(&self, len: usize) -> [u8; 2] {
        // Cookies come from a u16-length Xauthority field.
        let len = u16::try_from(len).unwrap_or(u16::MAX);
        match self.big_endian {
            true => len.to_be_bytes(),
            false => len.to_le_bytes(),
        }
    }
}

fn is_big_endian(order: u8) -> io::Result<bool> {
    match order {
        b'B' => Ok(true),
        b'l' => Ok(false),
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "not an X11 connection setup",
        )),
    }
}

fn decode_u16(bytes: [u8; 2], big_endian: bool) -> usize {
    match big_endian {
        true => usize::from(u16::from_be_bytes(bytes)),
        false => usize::from(u16::from_le_bytes(bytes)),
    }
}

fn padded_len(len: usize) -> usize {
    len.next_multiple_of(4)
}

async fn read_padded<R: AsyncRead + Unpin>(reader: &mut R, len: usize) -> io::Result<Vec<u8>> {
    let mut field = vec![0u8; padded_len(len)];
    reader.read_exact(&mut field).await?;
    field.truncate(len);
    Ok(field)
}

pub(super) fn append_padded(out: &mut Vec<u8>, field: &[u8]) {
    out.extend_from_slice(field);
    out.resize(out.len() + padded_len(field.len()) - field.len(), 0);
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    let diff = left.iter().zip(right).fold(0, |acc, (l, r)| acc | (l ^ r));
    left.len() == right.len() && diff == 0
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A client setup as an X client writes it.
    pub(crate) fn setup_bytes(order: u8, name: &[u8], data: &[u8]) -> Vec<u8> {
        let encode = |len: usize| {
            let len = u16::try_from(len).unwrap();
            match order {
                b'B' => len.to_be_bytes(),
                _ => len.to_le_bytes(),
            }
        };
        let mut out = vec![order, 0];
        out.extend_from_slice(&encode(11));
        out.extend_from_slice(&[0, 0]);
        out.extend_from_slice(&encode(name.len()));
        out.extend_from_slice(&encode(data.len()));
        out.extend_from_slice(&[0, 0]);
        append_padded(&mut out, name);
        append_padded(&mut out, data);
        out
    }

    async fn parse(bytes: &[u8]) -> io::Result<ClientSetup> {
        read_setup(&mut &bytes[..]).await
    }

    #[tokio::test]
    async fn checks_the_cookie_in_either_byte_order() {
        for order in *b"Bl" {
            let setup = parse(&setup_bytes(order, COOKIE_PROTOCOL, b"fake"))
                .await
                .unwrap();
            assert!(setup.carries_cookie(b"fake"));
            assert!(!setup.carries_cookie(b"fakf"));
            assert!(!setup.carries_cookie(b"fak"));
        }
    }

    #[tokio::test]
    async fn another_protocol_never_carries_the_cookie() {
        let setup = parse(&setup_bytes(b'l', b"OTHER", b"fake")).await.unwrap();
        assert!(!setup.carries_cookie(b"fake"));
    }

    #[tokio::test]
    async fn swaps_in_the_real_cookie() {
        for order in *b"Bl" {
            let setup = parse(&setup_bytes(order, COOKIE_PROTOCOL, b"fake"))
                .await
                .unwrap();
            let expected = setup_bytes(order, COOKIE_PROTOCOL, b"real cookie");
            assert_eq!(setup.with_cookie(Some(b"real cookie")), expected);
        }
    }

    #[tokio::test]
    async fn drops_the_auth_when_there_is_no_real_cookie() {
        let setup = parse(&setup_bytes(b'B', COOKIE_PROTOCOL, b"fake"))
            .await
            .unwrap();
        assert_eq!(setup.with_cookie(None), setup_bytes(b'B', b"", b""));
    }

    #[tokio::test]
    async fn rejects_a_bad_byte_order_or_short_setup() {
        let mut bad = setup_bytes(b'B', COOKIE_PROTOCOL, b"fake");
        bad[0] = b'x';
        assert!(parse(&bad).await.is_err());
        let good = setup_bytes(b'B', COOKIE_PROTOCOL, b"fake");
        assert!(parse(&good[..good.len() - 1]).await.is_err());
    }
}
