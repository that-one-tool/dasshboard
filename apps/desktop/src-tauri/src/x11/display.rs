//! Where the local X server listens, read from a `$DISPLAY` value.

use std::path::PathBuf;

/// Used when `$DISPLAY` is unset, on Windows only: its X servers (VcXsrv,
/// Xming) listen there and rarely set it. Elsewhere an unset `$DISPLAY` means
/// no X server, and port 6000 may belong to another user.
#[cfg(windows)]
const FALLBACK_DISPLAY: Option<&str> = Some("localhost:0");
#[cfg(unix)]
const FALLBACK_DISPLAY: Option<&str> = None;
const X11_TCP_BASE_PORT: u32 = 6000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DisplayAddress {
    Socket(PathBuf),
    Tcp { host: String, port: u16 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LocalDisplay {
    pub(crate) address: DisplayAddress,
    pub(crate) number: u32,
    pub(crate) screen: u32,
}

/// The display named by `value` (`$DISPLAY`), or the fallback when unset.
/// The error says why there is none.
pub(crate) fn display_from(value: Option<&str>) -> Result<LocalDisplay, String> {
    let value = value.filter(|text| !text.is_empty()).or(FALLBACK_DISPLAY);
    let value = value.ok_or("DISPLAY is not set")?;
    parse_display(value).ok_or_else(|| format!("DISPLAY \"{value}\" is not valid"))
}

/// `[host]:number[.screen]`. A host that is a path is a socket (XQuartz's
/// launchd socket on macOS).
pub(crate) fn parse_display(text: &str) -> Option<LocalDisplay> {
    let (host, rest) = text.rsplit_once(':')?;
    let (number, screen) = parse_number_and_screen(rest)?;
    let address = address_of(host, number)?;
    Some(LocalDisplay {
        address,
        number,
        screen,
    })
}

fn parse_number_and_screen(text: &str) -> Option<(u32, u32)> {
    let (number, screen) = text.split_once('.').unwrap_or((text, "0"));
    Some((number.parse().ok()?, screen.parse().ok()?))
}

fn address_of(host: &str, number: u32) -> Option<DisplayAddress> {
    if host.starts_with('/') {
        let path = format!("{host}:{number}");
        return Some(DisplayAddress::Socket(PathBuf::from(path)));
    }
    if is_local_host(host) {
        return local_address(number);
    }
    tcp_address(host, number)
}

fn is_local_host(host: &str) -> bool {
    matches!(host, "" | "unix")
}

fn tcp_address(host: &str, number: u32) -> Option<DisplayAddress> {
    let port = u16::try_from(X11_TCP_BASE_PORT.checked_add(number)?).ok()?;
    Some(DisplayAddress::Tcp {
        host: host.to_string(),
        port,
    })
}

#[cfg(unix)]
fn local_address(number: u32) -> Option<DisplayAddress> {
    Some(DisplayAddress::Socket(PathBuf::from(format!(
        "/tmp/.X11-unix/X{number}"
    ))))
}

// Windows has no X11 socket directory: a local display is a TCP port.
#[cfg(windows)]
fn local_address(number: u32) -> Option<DisplayAddress> {
    tcp_address("localhost", number)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tcp(host: &str, port: u16) -> DisplayAddress {
        DisplayAddress::Tcp {
            host: host.to_string(),
            port,
        }
    }

    #[test]
    fn reads_number_and_screen() {
        let display = parse_display("localhost:10.2").unwrap();
        assert_eq!(display.address, tcp("localhost", 6010));
        assert_eq!((display.number, display.screen), (10, 2));
    }

    #[test]
    fn screen_defaults_to_zero() {
        assert_eq!(parse_display("host:1").unwrap().screen, 0);
    }

    #[cfg(unix)]
    #[test]
    fn local_display_is_the_x11_unix_socket() {
        let socket = DisplayAddress::Socket(PathBuf::from("/tmp/.X11-unix/X1"));
        assert_eq!(parse_display(":1").unwrap().address, socket);
        assert_eq!(parse_display("unix:1.0").unwrap().address, socket);
    }

    #[cfg(windows)]
    #[test]
    fn local_display_is_a_localhost_port_on_windows() {
        assert_eq!(parse_display(":1").unwrap().address, tcp("localhost", 6001));
    }

    #[test]
    fn path_host_is_a_launchd_socket() {
        let display = parse_display("/private/tmp/launchd.x/org.xquartz:0").unwrap();
        let socket = PathBuf::from("/private/tmp/launchd.x/org.xquartz:0");
        assert_eq!(display.address, DisplayAddress::Socket(socket));
    }

    #[test]
    fn rejects_malformed_values() {
        for text in ["", "localhost", "host:x", "host:0.y", "host:70000"] {
            assert_eq!(parse_display(text), None, "{text}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn unset_or_empty_display_falls_back_to_localhost_zero_on_windows() {
        assert_eq!(display_from(None).unwrap().address, tcp("localhost", 6000));
        assert_eq!(
            display_from(Some("")).unwrap().address,
            tcp("localhost", 6000)
        );
    }

    #[cfg(unix)]
    #[test]
    fn unset_or_empty_display_has_no_fallback_on_unix() {
        assert_eq!(display_from(None), Err("DISPLAY is not set".to_string()));
        assert_eq!(
            display_from(Some("")),
            Err("DISPLAY is not set".to_string())
        );
    }

    #[test]
    fn display_from_names_a_bad_value() {
        assert_eq!(display_from(Some("other:3")).unwrap().number, 3);
        let err = display_from(Some("nonsense")).unwrap_err();
        assert_eq!(err, "DISPLAY \"nonsense\" is not valid");
    }
}
