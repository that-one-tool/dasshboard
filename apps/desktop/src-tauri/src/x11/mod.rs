//! X11 forwarding (`ssh -X`/`-Y`). The server gets a fake cookie; each X11
//! channel it opens must present it, and is then relayed to the local X server
//! with another cookie, so the real one never leaves this machine (OpenSSH's
//! spoofing). Trusted (`-Y`) swaps in the real cookie: full access to the
//! display. Untrusted (`-X`) swaps in a fresh one the X server limits through
//! its SECURITY extension.

mod display;
mod hostname;
mod security;
mod setup;
mod xauthority;

use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::timeout;
use uuid::Uuid;

pub(crate) use display::{DisplayAddress, LocalDisplay};

use crate::relay::{bridge, Pace};
use security::generate_untrusted_cookie;
use setup::{read_setup, ClientSetup};
use xauthority::AuthAddress;

/// A client that never finishes its setup must not hold a channel slot; nor
/// must an X server that never answers.
const SETUP_TIMEOUT: Duration = Duration::from_secs(10);

/// Shows the user a line of text (the session's terminal).
pub(crate) type Notice = Box<dyn Fn(&str) + Send + Sync>;

/// The local X server: its display, the file holding its cookie, and whether
/// forwarded clients are trusted.
#[derive(Debug, Clone)]
pub struct X11Local {
    display: LocalDisplay,
    xauthority: Option<PathBuf>,
    trusted: bool,
}

/// What `run_shell` sends in its `x11-req`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct X11Request {
    pub(crate) protocol: &'static str,
    pub(crate) cookie_hex: String,
    pub(crate) screen: u32,
}

/// One session's forwarding: the local X server and the fake cookie given to
/// the remote.
pub(crate) struct X11Forward {
    local: X11Local,
    fake_cookie: [u8; 16],
    notice: Notice,
    /// Each kind of problem is told once, so one kind never hides another.
    failure_warned: AtomicBool,
    cookie_warned: AtomicBool,
    limit_warned: AtomicBool,
    deadline: Duration,
}

trait XStream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> XStream for T {}

/// The line `ssh` would print about an X11 problem, without control
/// characters (the reason may come from the X server).
pub(crate) fn warning_line(reason: &str) -> String {
    note_line(&format!("X11 forwarding failed: {reason}"))
}

/// A line about X11 that is not a failure.
fn note_line(text: &str) -> String {
    let text: String = text.chars().filter(|c| !c.is_control()).collect();
    format!("\r\n[DaSSHboard] {text}\r\n")
}

impl X11Local {
    /// From `$DISPLAY` and `$XAUTHORITY`/`$HOME` (`%USERPROFILE%`). The error says why there
    /// is no display.
    pub fn from_env(trusted: bool) -> Result<X11Local, String> {
        let var = |name| std::env::var(name).ok();
        let display = display::display_from(var("DISPLAY").as_deref())?;
        // Windows rarely sets HOME.
        let home = var("HOME").or_else(|| var("USERPROFILE"));
        let xauthority = xauthority::xauthority_path(var("XAUTHORITY").as_deref(), home.as_deref());
        Ok(X11Local {
            display,
            xauthority,
            trusted,
        })
    }

    /// An explicit display, for tests.
    pub fn new(display: &str, xauthority: Option<PathBuf>, trusted: bool) -> Option<X11Local> {
        Some(X11Local {
            display: display::parse_display(display)?,
            xauthority,
            trusted,
        })
    }

    async fn read_cookie(&self, server: &AuthAddress) -> Option<Vec<u8>> {
        let path = self.xauthority.clone()?;
        let file = tokio::task::spawn_blocking(move || std::fs::read(path))
            .await
            .ok()?
            .ok()?;
        xauthority::find_cookie(&file, server, self.display.number)
    }

    /// A connection to the X server, and how Xauthority names that server.
    async fn connect(&self) -> io::Result<(Box<dyn XStream>, AuthAddress)> {
        match &self.display.address {
            DisplayAddress::Socket(path) => {
                Ok((Box::new(connect_socket(path).await?), this_machine()))
            }
            DisplayAddress::Tcp { host, port } => connect_tcp(host, *port).await,
        }
    }
}

async fn connect_tcp(host: &str, port: u16) -> io::Result<(Box<dyn XStream>, AuthAddress)> {
    let stream = TcpStream::connect((host, port)).await?;
    let server = auth_address_of(stream.peer_addr()?.ip());
    Ok((Box::new(stream), server))
}

/// Like libxcb, names 127.0.0.1 and ::1 (only) like a local X server: by
/// hostname.
fn auth_address_of(ip: IpAddr) -> AuthAddress {
    let canonical = ip.to_canonical();
    if canonical == Ipv4Addr::LOCALHOST || canonical == Ipv6Addr::LOCALHOST {
        return this_machine();
    }
    AuthAddress::ip(ip)
}

fn this_machine() -> AuthAddress {
    AuthAddress::local(&hostname::local_hostname())
}

impl X11Forward {
    /// `notice` tells the user, once, when forwarding fails.
    pub(crate) fn new(local: X11Local, notice: Notice) -> X11Forward {
        X11Forward {
            local,
            // v4 UUIDs come from the OS CSPRNG (122 random bits): plenty for
            // a cookie that only has to be unguessable.
            fake_cookie: *Uuid::new_v4().as_bytes(),
            notice,
            failure_warned: AtomicBool::new(false),
            cookie_warned: AtomicBool::new(false),
            limit_warned: AtomicBool::new(false),
            deadline: SETUP_TIMEOUT,
        }
    }

    #[cfg(test)]
    fn with_deadline(self, deadline: Duration) -> X11Forward {
        X11Forward { deadline, ..self }
    }

    pub(crate) fn request(&self) -> X11Request {
        X11Request {
            protocol: "MIT-MAGIC-COOKIE-1",
            cookie_hex: hex(&self.fake_cookie),
            screen: self.local.display.screen,
        }
    }

    /// Relay one server-opened X11 channel to the local X server. Failures
    /// end only this channel.
    pub(crate) async fn serve<S>(&self, channel: S)
    where
        S: AsyncRead + AsyncWrite + Unpin,
    {
        if let Err(err) = self.try_serve(channel).await {
            eprintln!("[DaSSHboard] X11 forwarding channel ended: {err}");
        }
    }

    /// Tell the user why a channel failed, the first time only: one failure
    /// tends to repeat for every window.
    pub(crate) fn warn_failure(&self, reason: &str) {
        self.warn_once(&self.failure_warned, warning_line(reason));
    }

    /// Tell the user, once, that a window was refused for going over `limit`.
    pub(crate) fn warn_channel_limit(&self, limit: usize) {
        let reason = format!("more than {limit} X11 connections at once");
        self.warn_once(&self.limit_warned, warning_line(&reason));
    }

    /// Trusted mode without a cookie still tries (an X server may need
    /// none), but a refusal would only reach the remote program.
    fn warn_if_no_cookie(&self, found: bool) {
        if found {
            return;
        }
        let number = self.local.display.number;
        let text =
            format!("X11 forwarding: no X11 cookie found for display {number}; trying without one");
        self.warn_once(&self.cookie_warned, note_line(&text));
    }

    fn no_answer(&self) -> io::Error {
        let message = format!("the X server did not answer within {:?}", self.deadline);
        io::Error::new(io::ErrorKind::TimedOut, message)
    }

    fn warn_once(&self, warned: &AtomicBool, line: String) {
        if warned.swap(true, Ordering::Relaxed) {
            return;
        }
        (self.notice)(&line);
    }

    async fn try_serve<S>(&self, mut channel: S) -> io::Result<()>
    where
        S: AsyncRead + AsyncWrite + Unpin,
    {
        let setup = self.read_client_setup(&mut channel).await?;
        let x_server = self.open_x_server_in_time(&setup).await?;
        bridge(x_server, channel, Pace::DEFAULT).await
    }

    /// The remote client's setup, once it shows the fake cookie.
    async fn read_client_setup<S>(&self, channel: &mut S) -> io::Result<ClientSetup>
    where
        S: AsyncRead + Unpin,
    {
        let setup = timeout(self.deadline, read_setup(channel)).await??;
        if !setup.carries_cookie(&self.fake_cookie) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "wrong X11 cookie",
            ));
        }
        Ok(setup)
    }

    /// [`Self::open_x_server`] within the deadline; the user hears of a failure.
    async fn open_x_server_in_time(&self, setup: &ClientSetup) -> io::Result<Box<dyn XStream>> {
        timeout(self.deadline, self.open_x_server(setup))
            .await
            .unwrap_or_else(|_| Err(self.no_answer()))
            .inspect_err(|err| self.warn_failure(&err.to_string()))
    }

    /// A connection to the X server that has been sent the client's setup,
    /// with the cookie of this forwarding's mode. Untrusted mode never falls
    /// back to the real cookie.
    async fn open_x_server(&self, setup: &ClientSetup) -> io::Result<Box<dyn XStream>> {
        let (x_server, server) = self.local.connect().await?;
        let real = self.local.read_cookie(&server).await;
        if self.local.trusted {
            self.warn_if_no_cookie(real.is_some());
            return send_setup(x_server, setup.with_cookie(real.as_deref())).await;
        }
        self.open_untrusted(x_server, setup, real.as_deref()).await
    }

    /// `generator` asks the X server for an untrusted cookie; a second
    /// connection carries the client's setup with it.
    async fn open_untrusted(
        &self,
        generator: Box<dyn XStream>,
        setup: &ClientSetup,
        real: Option<&[u8]>,
    ) -> io::Result<Box<dyn XStream>> {
        let generated = generate_untrusted_cookie(generator, real)
            .await
            .map_err(untrusted_failure)?;
        let (x_server, _) = self.local.connect().await?;
        send_setup(x_server, setup.with_cookie(Some(&generated))).await
    }
}

async fn send_setup(
    mut x_server: Box<dyn XStream>,
    setup: Vec<u8>,
) -> io::Result<Box<dyn XStream>> {
    x_server.write_all(&setup).await?;
    Ok(x_server)
}

fn untrusted_failure(err: io::Error) -> io::Error {
    io::Error::new(
        err.kind(),
        format!("no untrusted cookie ({err}). Use Trusted in the device settings."),
    )
}

#[cfg(unix)]
async fn connect_socket(path: &std::path::Path) -> io::Result<tokio::net::UnixStream> {
    tokio::net::UnixStream::connect(path).await
}

#[cfg(windows)]
async fn connect_socket(_path: &std::path::Path) -> io::Result<TcpStream> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "X11 display sockets are not supported on Windows",
    ))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use security::tests::security_replies;
    use setup::tests::setup_bytes;
    use std::sync::{Arc, Mutex};
    use tokio::io::{duplex, AsyncReadExt};
    use tokio::net::TcpListener;
    use xauthority::COOKIE_PROTOCOL;

    fn decode_hex(text: &str) -> Vec<u8> {
        (0..text.len())
            .step_by(2)
            .map(|at| u8::from_str_radix(&text[at..at + 2], 16).unwrap())
            .collect()
    }

    fn xauthority_file(dir: &std::path::Path, number: &str, cookie: &[u8]) -> PathBuf {
        let path = dir.join("Xauthority");
        std::fs::write(&path, xauthority::tests::wild(number, cookie)).unwrap();
        path
    }

    /// Send a valid setup with the forward's fake cookie down `remote`.
    async fn send_fake_setup(remote: &mut tokio::io::DuplexStream, forward: &X11Forward) {
        let fake = decode_hex(&forward.request().cookie_hex);
        let setup = setup_bytes(b'l', COOKIE_PROTOCOL, &fake);
        remote.write_all(&setup).await.unwrap();
    }

    fn forward(local: X11Local) -> X11Forward {
        X11Forward::new(local, Box::new(|_| {}))
    }

    /// A forward that records its notices.
    fn noting_forward(local: X11Local) -> (X11Forward, Arc<Mutex<Vec<String>>>) {
        let notices = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&notices);
        let notice = Box::new(move |text: &str| sink.lock().unwrap().push(text.to_string()));
        (X11Forward::new(local, notice), notices)
    }

    fn display_number(display: &str) -> &str {
        display
            .split(':')
            .nth(1)
            .unwrap()
            .split('.')
            .next()
            .unwrap()
    }

    async fn fake_x_server() -> (TcpListener, String) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let number = listener.local_addr().unwrap().port() - 6000;
        (listener, format!("127.0.0.1:{number}.1"))
    }

    #[test]
    fn request_carries_a_random_hex_cookie_and_the_screen() {
        let local = X11Local::new(":0.2", None, true).unwrap();
        let first = forward(local.clone()).request();
        let second = forward(local).request();
        assert_eq!(first.protocol, "MIT-MAGIC-COOKIE-1");
        assert_eq!(first.cookie_hex.len(), 32);
        assert_ne!(first.cookie_hex, second.cookie_hex);
        assert_eq!(first.screen, 2);
    }

    #[tokio::test]
    async fn relays_to_the_x_server_with_the_real_cookie() {
        let dir = tempfile::tempdir().unwrap();
        let (listener, display) = fake_x_server().await;
        let path = xauthority_file(dir.path(), display_number(&display), b"real");
        let forward = forward(X11Local::new(&display, Some(path), true).unwrap());
        let fake = decode_hex(&forward.request().cookie_hex);

        let (mut remote, channel) = duplex(1024);
        let serving = tokio::spawn(async move { forward.serve(channel).await });
        remote
            .write_all(&setup_bytes(b'l', COOKIE_PROTOCOL, &fake))
            .await
            .unwrap();
        remote.write_all(b"ping").await.unwrap();

        let (mut x_conn, _) = listener.accept().await.unwrap();
        let expected = [
            setup_bytes(b'l', COOKIE_PROTOCOL, b"real"),
            b"ping".to_vec(),
        ]
        .concat();
        let mut received = vec![0u8; expected.len()];
        x_conn.read_exact(&mut received).await.unwrap();
        assert_eq!(received, expected);

        x_conn.write_all(b"pong").await.unwrap();
        let mut reply = [0u8; 4];
        remote.read_exact(&mut reply).await.unwrap();
        assert_eq!(&reply, b"pong");
        drop((x_conn, remote));
        serving.await.unwrap();
    }

    #[tokio::test]
    async fn without_a_cookie_file_the_setup_goes_without_auth() {
        let (listener, display) = fake_x_server().await;
        let forward = forward(X11Local::new(&display, None, true).unwrap());
        let fake = decode_hex(&forward.request().cookie_hex);

        let (mut remote, channel) = duplex(1024);
        tokio::spawn(async move { forward.serve(channel).await });
        remote
            .write_all(&setup_bytes(b'B', COOKIE_PROTOCOL, &fake))
            .await
            .unwrap();

        let (mut x_conn, _) = listener.accept().await.unwrap();
        let expected = setup_bytes(b'B', b"", b"");
        let mut received = vec![0u8; expected.len()];
        x_conn.read_exact(&mut received).await.unwrap();
        assert_eq!(received, expected);
    }

    #[tokio::test]
    async fn a_wrong_cookie_never_reaches_the_x_server() {
        let (listener, display) = fake_x_server().await;
        let forward = forward(X11Local::new(&display, None, true).unwrap());

        let (mut remote, channel) = duplex(1024);
        let serving = tokio::spawn(async move { forward.serve(channel).await });
        remote
            .write_all(&setup_bytes(b'l', COOKIE_PROTOCOL, &[0; 16]))
            .await
            .unwrap();
        serving.await.unwrap();

        let accepted = timeout(Duration::from_millis(100), listener.accept()).await;
        assert!(accepted.is_err());
        let mut rest = Vec::new();
        assert_eq!(remote.read_to_end(&mut rest).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn untrusted_channels_get_a_cookie_generated_by_the_x_server() {
        let dir = tempfile::tempdir().unwrap();
        let (listener, display) = fake_x_server().await;
        let path = xauthority_file(dir.path(), display_number(&display), b"real");
        let (forward, notices) =
            noting_forward(X11Local::new(&display, Some(path), false).unwrap());
        let fake = decode_hex(&forward.request().cookie_hex);

        let (mut remote, channel) = duplex(1024);
        tokio::spawn(async move { forward.serve(channel).await });
        remote
            .write_all(&setup_bytes(b'l', COOKIE_PROTOCOL, &fake))
            .await
            .unwrap();
        remote.write_all(b"ping").await.unwrap();

        let (mut security_conn, _) = listener.accept().await.unwrap();
        security_conn
            .write_all(&security_replies(b"generated"))
            .await
            .unwrap();
        let asked_with = read_setup(&mut security_conn).await.unwrap();
        assert!(asked_with.carries_cookie(b"real"));

        let (mut x_conn, _) = listener.accept().await.unwrap();
        let expected = [
            setup_bytes(b'l', COOKIE_PROTOCOL, b"generated"),
            b"ping".to_vec(),
        ]
        .concat();
        let mut received = vec![0u8; expected.len()];
        x_conn.read_exact(&mut received).await.unwrap();
        assert_eq!(received, expected);
        assert!(notices.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_failed_untrusted_cookie_closes_the_channel_and_warns_once() {
        let (listener, display) = fake_x_server().await;
        let (forward, notices) = noting_forward(X11Local::new(&display, None, false).unwrap());
        let forward = Arc::new(forward);
        let fake = decode_hex(&forward.request().cookie_hex);
        tokio::spawn(async move {
            while let Ok((mut conn, _)) = listener.accept().await {
                let _ = conn.write_all(&[0, 0, 11, 0, 0, 0, 0, 0]).await;
            }
        });

        for _ in 0..2 {
            let (mut remote, channel) = duplex(1024);
            let forward = Arc::clone(&forward);
            let serving = tokio::spawn(async move { forward.serve(channel).await });
            remote
                .write_all(&setup_bytes(b'l', COOKIE_PROTOCOL, &fake))
                .await
                .unwrap();
            serving.await.unwrap();
            let mut rest = Vec::new();
            assert_eq!(remote.read_to_end(&mut rest).await.unwrap(), 0);
        }

        let notices = notices.lock().unwrap();
        assert_eq!(notices.len(), 1);
        assert!(notices[0].contains("X11 forwarding failed: no untrusted cookie"));
        assert!(notices[0].contains("Use Trusted"));
        assert!(notices[0].starts_with("\r\n") && notices[0].ends_with("\r\n"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn an_unreachable_x_server_warns_without_blaming_untrusted_mode() {
        let dir = tempfile::tempdir().unwrap();
        let display = format!("{}:0", dir.path().join("none").display());
        let (forward, notices) = noting_forward(X11Local::new(&display, None, false).unwrap());

        let (mut remote, channel) = duplex(1024);
        let serving = tokio::spawn(async move {
            send_fake_setup(&mut remote, &forward).await;
            forward.serve(channel).await;
        });
        serving.await.unwrap();

        let notices = notices.lock().unwrap();
        assert_eq!(notices.len(), 1);
        assert!(notices[0].contains("X11 forwarding failed"));
        assert!(!notices[0].contains("Trusted"));
    }

    #[tokio::test]
    async fn an_x_server_that_never_answers_times_out_with_a_warning() {
        let (listener, display) = fake_x_server().await;
        let (forward, notices) = noting_forward(X11Local::new(&display, None, false).unwrap());
        let forward = forward.with_deadline(Duration::from_millis(200));
        let (mut remote, channel) = duplex(1024);
        send_fake_setup(&mut remote, &forward).await;
        let _held = tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((conn, _)) = listener.accept().await {
                held.push(conn);
            }
        });

        forward.serve(channel).await;

        let notices = notices.lock().unwrap();
        assert_eq!(notices.len(), 1);
        assert!(notices[0].contains("the X server did not answer within"));
    }

    #[tokio::test]
    async fn a_loopback_x_server_gets_this_machines_cookie() {
        use xauthority::tests::entry_for;
        let dir = tempfile::tempdir().unwrap();
        let (listener, display) = fake_x_server().await;
        let number = display_number(&display);
        let hostname = hostname::local_hostname();
        let file = [
            entry_for(0, &[10, 0, 0, 7], number, b"other host"),
            entry_for(256, b"elsewhere", number, b"other machine"),
            entry_for(256, hostname.as_bytes(), number, b"mine"),
        ]
        .concat();
        let path = dir.path().join("Xauthority");
        std::fs::write(&path, file).unwrap();
        let forward = forward(X11Local::new(&display, Some(path), true).unwrap());

        let (mut remote, channel) = duplex(1024);
        send_fake_setup(&mut remote, &forward).await;
        tokio::spawn(async move { forward.serve(channel).await });

        let (mut x_conn, _) = listener.accept().await.unwrap();
        let expected = setup_bytes(b'l', COOKIE_PROTOCOL, b"mine");
        let mut received = vec![0u8; expected.len()];
        x_conn.read_exact(&mut received).await.unwrap();
        assert_eq!(received, expected);
    }

    #[test]
    fn only_the_loopback_addresses_xlib_knows_name_this_machine() {
        use std::net::{Ipv4Addr, Ipv6Addr};
        for ip in [
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            IpAddr::V6(Ipv6Addr::LOCALHOST),
            IpAddr::V6(Ipv4Addr::LOCALHOST.to_ipv6_mapped()),
        ] {
            assert_eq!(auth_address_of(ip), this_machine(), "{ip}");
        }
        let other_loopback = IpAddr::V4(Ipv4Addr::new(127, 0, 0, 2));
        assert_eq!(
            auth_address_of(other_loopback),
            AuthAddress::ip(other_loopback)
        );
    }

    #[tokio::test]
    async fn trusted_without_a_matching_cookie_warns_once_and_still_connects() {
        let dir = tempfile::tempdir().unwrap();
        let (listener, display) = fake_x_server().await;
        let path = xauthority_file(dir.path(), "99999", b"another display");
        let local = X11Local::new(&display, Some(path), true).unwrap();
        let (forward, notices) = noting_forward(local);
        let forward = Arc::new(forward);

        for _ in 0..2 {
            let (mut remote, channel) = duplex(1024);
            send_fake_setup(&mut remote, &forward).await;
            let forward = Arc::clone(&forward);
            tokio::spawn(async move { forward.serve(channel).await });
            let (mut x_conn, _) = listener.accept().await.unwrap();
            let expected = setup_bytes(b'l', b"", b"");
            let mut received = vec![0u8; expected.len()];
            x_conn.read_exact(&mut received).await.unwrap();
            assert_eq!(received, expected);
        }

        let notices = notices.lock().unwrap();
        assert_eq!(notices.len(), 1);
        let expected = "[DaSSHboard] X11 forwarding: no X11 cookie found for display";
        assert!(notices[0].contains(expected), "{}", notices[0]);
        assert!(!notices[0].contains("failed"));
    }

    #[test]
    fn the_channel_limit_warning_never_hides_a_later_failure() {
        let local = X11Local::new(":0", None, true).unwrap();
        let (forward, notices) = noting_forward(local);
        forward.warn_channel_limit(32);
        forward.warn_channel_limit(32);
        forward.warn_failure("first failure");
        forward.warn_failure("second failure");

        let notices = notices.lock().unwrap();
        assert_eq!(notices.len(), 2);
        assert!(notices[0].contains("more than 32 X11 connections at once"));
        assert!(notices[1].contains("first failure"));
    }

    #[test]
    fn warning_lines_drop_control_characters() {
        let line = warning_line("bad\x1b[2Jreason\n");
        assert_eq!(
            line,
            "\r\n[DaSSHboard] X11 forwarding failed: bad[2Jreason\r\n"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn connects_to_a_socket_display() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("X");
        let listener = tokio::net::UnixListener::bind(dir.path().join("X:0")).unwrap();
        let display = format!("{}:0", socket.display());
        let forward = forward(X11Local::new(&display, None, true).unwrap());
        let fake = decode_hex(&forward.request().cookie_hex);

        let (mut remote, channel) = duplex(1024);
        tokio::spawn(async move { forward.serve(channel).await });
        remote
            .write_all(&setup_bytes(b'l', COOKIE_PROTOCOL, &fake))
            .await
            .unwrap();
        assert!(listener.accept().await.is_ok());
    }
}
