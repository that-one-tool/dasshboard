//! SSH integration tests (SPEC.md §9), Phase 2.
//!
//! These run entirely in-process against a minimal `russh` **server** — no
//! Docker, no external SSH daemon, no network beyond `127.0.0.1` — so
//! `cargo test` passes on any machine (SPEC §9's in-process fallback). Each
//! test spins up its own throwaway server on an ephemeral port and drives the
//! real client stack (`SessionManager` / `test_connection`), exercising:
//!
//! - password auth success / wrong password ⇒ `SshAuth`,
//! - unreachable host ⇒ `SshConnect`,
//! - echo through the PTY (write bytes, read them back),
//! - host-key TOFU accept / reject / mismatch,
//! - the host-key prompt **timeout** path (via an injected short timeout).
//!
//! The known-hosts *matching* logic is unit-tested separately in
//! `known_hosts.rs`; here we test the end-to-end handshake behaviour.
//!
//! This is a Cargo integration test (`tests/`), so it drives `dasshboard_lib`
//! through its public API rather than reaching into private internals.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU16, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use russh::keys::{HashAlg, PrivateKey};
use russh::server::{self, Auth, Msg, Server as _, Session};
use russh::{Channel, ChannelId, ChannelOpenFailure, MethodKind, MethodSet};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use zeroize::Zeroizing;

use dasshboard_lib::device::{Forward, ForwardKind};
use dasshboard_lib::error::AppError;
use dasshboard_lib::known_hosts::{KnownHost, KnownHostsStore};
use dasshboard_lib::session::{ConnectParams, SessionManager};
use dasshboard_lib::session_sink::{SessionSink, SessionStatus};
use dasshboard_lib::ssh::params::{AuthCredentials, JumpHop, KeepaliveConfig};
use dasshboard_lib::ssh::prompts::{AuthPromptPayload, ConnectPrompter, HostKeyPromptPayload};
use dasshboard_lib::tunnel::{
    ForwardStatus, TunnelManager, TunnelParams, TunnelSink, TunnelStatus,
};
use dasshboard_lib::x11::X11Local;

/// Throwaway ed25519 host key for the in-process test server. Generated once
/// with `ssh-keygen -t ed25519 -N ""`; it exists only to give the test server
/// an identity so the host-key path can run. It guards nothing real.
const TEST_HOST_KEY: &str = "-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACBRJ4iDGzJs43jMYshJeoVYmLVyzKFUnuLM0lqnhikkMAAAAJhcQzNPXEMz
TwAAAAtzc2gtZWQyNTUxOQAAACBRJ4iDGzJs43jMYshJeoVYmLVyzKFUnuLM0lqnhikkMA
AAAEBJ+yZPhKmtZJdowQFduvg+YkS2ChSegtIL5qTB3NLAL1EniIMbMmzjeMxiyEl6hViY
tXLMoVSe4szSWqeGKSQwAAAAFGRhc3NoYm9hcmQtdGVzdC1ob3N0AQ==
-----END OPENSSH PRIVATE KEY-----
";

const TEST_USER: &str = "tester";
const TEST_PASSWORD: &str = "correct-horse";
/// A `direct-tcpip` target the test server refuses (`ConnectFailed`).
const REFUSED_HOST: &str = "refused.test";

/// SHA256 fingerprint of [`TEST_HOST_KEY`], as russh renders it.
fn server_fingerprint() -> String {
    let key = PrivateKey::from_openssh(TEST_HOST_KEY).expect("valid test host key");
    key.public_key().fingerprint(HashAlg::Sha256).to_string()
}

/* ------------------------------------------------------------------------- *
 * In-process russh test server
 * ------------------------------------------------------------------------- */

#[derive(Clone)]
struct TestServer {
    password: String,
    /// When true, a `direct-tcpip` channel is bridged to a real TCP connection
    /// to the requested target (a working jump host for the ProxyJump test);
    /// when false, the channel is left to the echo `data` handler (the tunnel
    /// test's simple "remote service").
    bridge_direct_tcpip: bool,
    /// When set, the server opens an `auth-agent@openssh.com` channel back to the
    /// client on shell request and reports (via this sender) whether the client
    /// accepted it — used by the agent-forwarding tests to observe the client's
    /// accept/reject gate. `None` for every other test.
    agent_probe: Option<mpsc::UnboundedSender<bool>>,
    /// When set, echoed bytes go back in packets of at most this many bytes
    /// (a chatty remote); `None` echoes each received chunk as one packet.
    echo_chunk: Option<usize>,
    /// `ssh -R` misbehaviours: listen but answer "refused" (as a grant that
    /// arrives after the client gave up looks), never answer a cancel, and
    /// never answer a listen.
    refuse_remote_listen: bool,
    stall_cancel: bool,
    stall_listen: bool,
    /// When set, the server opens a `forwarded-tcpip` channel the client never
    /// asked for (on shell request, or for the port after a granted one) and
    /// reports whether the client accepted it.
    forward_probe: Option<mpsc::UnboundedSender<bool>>,
    /// A shell that stops reading: `data` never returns, so the server sends
    /// no more window adjusts and the client's writes block for good.
    stall_reads: bool,
    /// Receives every connection that ended in an error — as a client
    /// dropping the socket without an SSH disconnect does.
    session_errors: Option<mpsc::UnboundedSender<String>>,
    /// When set, the server opens every channel type a client never asks the
    /// server for (on shell request) and reports each type and whether the
    /// client accepted it.
    stray_probe: Option<mpsc::UnboundedSender<(&'static str, bool)>>,
    /// How the server uses keyboard-interactive auth, if at all.
    kbd: Option<KbdScenario>,
    /// When set, reports on shell request the X11 cookie the client asked
    /// for (`None` without an `x11-req`), then opens an X11 channel with it.
    x11_probe: Option<mpsc::UnboundedSender<Option<String>>>,
    /// When set, opens this many X11 channels on shell request (never sending
    /// a setup) and reports how many the client accepted.
    x11_flood: Option<(usize, mpsc::UnboundedSender<usize>)>,
    /// When set, a jump host opens an X11 channel back on each `direct-tcpip`
    /// and reports whether the client accepted it.
    jump_x11_probe: Option<mpsc::UnboundedSender<bool>>,
}

/// The one-time code a keyboard-interactive test server expects.
const TEST_CODE: &str = "424242";

/// Plain `password` auth is refused; keyboard-interactive asks for the
/// password, then (PAM + one-time code) for a code. russh's server can't
/// report a partial success, so the two factors share one conversation.
#[derive(Clone, Copy, PartialEq)]
enum KbdScenario {
    PasswordThroughKbd,
    PasswordThenCode,
}

const PASSWORD_QUESTION: &str = "Password: ";
const CODE_QUESTION: &str = "Verification code: ";

fn kbd_question(question: &'static str) -> Auth {
    Auth::Partial {
        name: "".into(),
        instructions: "".into(),
        prompts: vec![(question.into(), false)].into(),
    }
}

impl TestServer {
    fn new(password: &str) -> Self {
        TestServer {
            password: password.to_string(),
            bridge_direct_tcpip: false,
            agent_probe: None,
            echo_chunk: None,
            refuse_remote_listen: false,
            stall_cancel: false,
            stall_listen: false,
            forward_probe: None,
            stall_reads: false,
            session_errors: None,
            stray_probe: None,
            kbd: None,
            x11_probe: None,
            x11_flood: None,
            jump_x11_probe: None,
        }
    }
}

impl server::Server for TestServer {
    type Handler = TestServerHandler;
    fn new_client(&mut self, _peer: Option<std::net::SocketAddr>) -> TestServerHandler {
        TestServerHandler {
            password: self.password.clone(),
            bridge_direct_tcpip: self.bridge_direct_tcpip,
            agent_probe: self.agent_probe.clone(),
            echo_chunk: self.echo_chunk,
            refuse_remote_listen: self.refuse_remote_listen,
            stall_cancel: self.stall_cancel,
            stall_listen: self.stall_listen,
            forward_probe: self.forward_probe.clone(),
            stall_reads: self.stall_reads,
            stray_probe: self.stray_probe.clone(),
            kbd: self.kbd,
            x11_probe: self.x11_probe.clone(),
            x11_flood: self.x11_flood.clone(),
            jump_x11_probe: self.jump_x11_probe.clone(),
            x11_cookie: None,
            kbd_answers: 0,
            remote_listeners: HashMap::new(),
            forwarded: Arc::default(),
        }
    }

    fn handle_session_error(&mut self, error: russh::Error) {
        if let Some(tx) = &self.session_errors {
            let _ = tx.send(error.to_string());
        }
    }
}

struct TestServerHandler {
    password: String,
    bridge_direct_tcpip: bool,
    agent_probe: Option<mpsc::UnboundedSender<bool>>,
    echo_chunk: Option<usize>,
    refuse_remote_listen: bool,
    stall_cancel: bool,
    stall_listen: bool,
    forward_probe: Option<mpsc::UnboundedSender<bool>>,
    stall_reads: bool,
    stray_probe: Option<mpsc::UnboundedSender<(&'static str, bool)>>,
    kbd: Option<KbdScenario>,
    x11_probe: Option<mpsc::UnboundedSender<Option<String>>>,
    x11_flood: Option<(usize, mpsc::UnboundedSender<usize>)>,
    jump_x11_probe: Option<mpsc::UnboundedSender<bool>>,
    /// The cookie of this connection's `x11-req`, if any.
    x11_cookie: Option<String>,
    /// Keyboard-interactive answers accepted so far on this connection.
    kbd_answers: usize,
    /// `ssh -R`: one real listener per granted `tcpip-forward`, by port.
    remote_listeners: HashMap<u32, tokio::task::JoinHandle<()>>,
    /// The `forwarded-tcpip` channels opened back to the client: their bytes
    /// are bridged to the server-side connection, never echoed.
    forwarded: Arc<Mutex<HashSet<ChannelId>>>,
}

/// Like OpenSSH, stop listening for a client's remote forwards once it's gone.
impl Drop for TestServerHandler {
    fn drop(&mut self) {
        for listener in self.remote_listeners.values() {
            listener.abort();
        }
    }
}

/// Open each channel type a client never asks for and report whether the
/// client accepted it.
fn probe_stray_channels(
    handle: server::Handle,
    probe: mpsc::UnboundedSender<(&'static str, bool)>,
) {
    tokio::spawn(async move {
        let opened = handle.channel_open_session().await.is_ok();
        let _ = probe.send(("session", opened));
        let opened = handle
            .channel_open_direct_tcpip("127.0.0.1", 22, "127.0.0.1", 40000)
            .await
            .is_ok();
        let _ = probe.send(("direct-tcpip", opened));
        let opened = handle
            .channel_open_direct_streamlocal("/tmp/s")
            .await
            .is_ok();
        let _ = probe.send(("direct-streamlocal", opened));
        let opened = handle
            .channel_open_forwarded_streamlocal("/tmp/s")
            .await
            .is_ok();
        let _ = probe.send(("forwarded-streamlocal", opened));
        let opened = handle.channel_open_x11("127.0.0.1", 6000).await.is_ok();
        let _ = probe.send(("x11", opened));
    });
}

/// Stand in for a remote X client: open an X11 channel and send a setup
/// carrying `cookie_hex`, then `ping`. Its bytes are never echoed.
fn open_x11_client(
    handle: server::Handle,
    cookie_hex: String,
    forwarded: Arc<Mutex<HashSet<ChannelId>>>,
) {
    tokio::spawn(async move {
        let Ok(channel) = handle.channel_open_x11("127.0.0.1", 40000).await else {
            return;
        };
        forwarded.lock().unwrap().insert(channel.id());
        let setup = x11_setup(&decode_hex(&cookie_hex));
        let _ = channel.data(&[setup, b"ping".to_vec()].concat()[..]).await;
        // Hold the channel open until the test ends.
        std::future::pending::<()>().await;
    });
}

/// Open `count` X11 channels and hold them without sending a setup, then
/// report how many the client accepted.
fn flood_x11(handle: server::Handle, count: usize, probe: mpsc::UnboundedSender<usize>) {
    tokio::spawn(async move {
        let mut held = Vec::new();
        for _ in 0..count {
            if let Ok(channel) = handle.channel_open_x11("127.0.0.1", 40000).await {
                held.push(channel);
            }
        }
        let _ = probe.send(held.len());
        std::future::pending::<()>().await;
    });
}

const X11_COOKIE_PROTOCOL: &[u8] = b"MIT-MAGIC-COOKIE-1";

/// A little-endian X11 connection setup carrying `cookie`.
fn x11_setup(cookie: &[u8]) -> Vec<u8> {
    let pad = |len: usize| vec![0u8; len.next_multiple_of(4) - len];
    let len = |bytes: &[u8]| u16::try_from(bytes.len()).unwrap().to_le_bytes();
    [
        vec![b'l', 0, 11, 0, 0, 0],
        len(X11_COOKIE_PROTOCOL).to_vec(),
        len(cookie).to_vec(),
        vec![0, 0],
        X11_COOKIE_PROTOCOL.to_vec(),
        pad(X11_COOKIE_PROTOCOL.len()),
        cookie.to_vec(),
        pad(cookie.len()),
    ]
    .concat()
}

/// An Xauthority file holding `cookie` for display `number`.
fn xauthority_with(number: u16, cookie: &[u8]) -> Vec<u8> {
    let number = number.to_string();
    // FamilyWild: whatever address the X server is reached at.
    let mut out = 65535u16.to_be_bytes().to_vec();
    for field in [
        b"".as_slice(),
        number.as_bytes(),
        X11_COOKIE_PROTOCOL,
        cookie,
    ] {
        out.extend_from_slice(&u16::try_from(field.len()).unwrap().to_be_bytes());
        out.extend_from_slice(field);
    }
    out
}

fn decode_hex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&text[at..at + 2], 16).unwrap())
        .collect()
}

/// Open a `forwarded-tcpip` channel for `port` and report whether the client
/// accepted it (it should only accept one for a port it asked for).
fn probe_forwarded(handle: server::Handle, port: u32, probe: mpsc::UnboundedSender<bool>) {
    tokio::spawn(async move {
        let opened = handle
            .channel_open_forwarded_tcpip("localhost", port, "127.0.0.1", 40000)
            .await;
        let _ = probe.send(opened.is_ok());
    });
}

/// Accept connections on a granted remote forward's port and carry each one
/// over a `forwarded-tcpip` channel to the client; a channel the client
/// refuses drops the connection.
async fn serve_remote_forward(
    listener: TcpListener,
    handle: server::Handle,
    address: String,
    port: u32,
    forwarded: Arc<Mutex<HashSet<ChannelId>>>,
) {
    while let Ok((mut tcp, peer)) = listener.accept().await {
        let opened = handle
            .channel_open_forwarded_tcpip(
                address.clone(),
                port,
                peer.ip().to_string(),
                u32::from(peer.port()),
            )
            .await;
        let Ok(channel) = opened else { continue };
        forwarded.lock().unwrap().insert(channel.id());
        tokio::spawn(async move {
            let mut stream = channel.into_stream();
            let _ = tokio::io::copy_bidirectional(&mut tcp, &mut stream).await;
        });
    }
}

impl server::Handler for TestServerHandler {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        if self.kbd.is_some() {
            return Ok(Auth::Reject {
                proceed_with_methods: Some(MethodSet::from(&[MethodKind::KeyboardInteractive][..])),
                partial_success: false,
            });
        }
        if user == TEST_USER && password == self.password {
            Ok(Auth::Accept)
        } else {
            Ok(Auth::reject())
        }
    }

    async fn auth_keyboard_interactive<'a>(
        &'a mut self,
        _user: &str,
        _submethods: &str,
        response: Option<server::Response<'a>>,
    ) -> Result<Auth, Self::Error> {
        let Some(scenario) = self.kbd else {
            return Ok(Auth::reject());
        };
        let Some(mut response) = response else {
            self.kbd_answers = 0;
            return Ok(kbd_question(PASSWORD_QUESTION));
        };
        let expected = [self.password.as_str(), TEST_CODE][self.kbd_answers.min(1)];
        if response.next().as_deref() != Some(expected.as_bytes()) {
            return Ok(Auth::reject());
        }
        self.kbd_answers += 1;
        let wants_code = scenario == KbdScenario::PasswordThenCode && self.kbd_answers == 1;
        Ok(if wants_code {
            kbd_question(CODE_QUESTION)
        } else {
            Auth::Accept
        })
    }

    async fn channel_open_session(
        &mut self,
        _channel: Channel<Msg>,
        reply: server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    /// Accept a `direct-tcpip` (local-forward) channel so the tunnel integration
    /// test can round-trip bytes. The default impl rejects by dropping the reply
    /// handle, so this override is required. Bytes sent on the channel are echoed
    /// back by the shared `data` handler below — enough to prove the tunnel
    /// carries traffic end to end (the "remote service" is a simple echo).
    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<Msg>,
        host_to_connect: &str,
        port_to_connect: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: server::ChannelOpenHandle,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        // Lets the SOCKS tests see how a refused `direct-tcpip` is reported.
        if host_to_connect == REFUSED_HOST {
            reply.reject(ChannelOpenFailure::ConnectFailed).await;
            return Ok(());
        }
        reply.accept().await;
        if let Some(probe) = &self.jump_x11_probe {
            let (handle, probe) = (session.handle(), probe.clone());
            tokio::spawn(async move {
                let opened = handle.channel_open_x11("127.0.0.1", 40000).await.is_ok();
                let _ = probe.send(opened);
            });
        }
        if self.bridge_direct_tcpip {
            // Jump-host mode: actually connect to the requested target and pump
            // bytes both ways, so the client can complete a full SSH handshake
            // with the *target* server over this channel (that is what makes us
            // a real ProxyJump hop rather than an echo).
            let host = host_to_connect.to_string();
            let port = port_to_connect as u16;
            tokio::spawn(async move {
                if let Ok(mut tcp) = TcpStream::connect((host.as_str(), port)).await {
                    let _ = tcp.set_nodelay(true);
                    let mut stream = channel.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut stream, &mut tcp).await;
                }
            });
        } else {
            // Echo mode: drop the channel; the shared `data` handler echoes the
            // bytes back (the tunnel integration test's "remote service").
            drop(channel);
        }
        Ok(())
    }

    /// A real `ssh -R` listen on loopback; a port already taken is refused.
    async fn tcpip_forward(
        &mut self,
        address: &str,
        port: &mut u32,
        session: &mut Session,
    ) -> Result<bool, Self::Error> {
        if self.stall_listen {
            // Blocks this connection's server loop: a server that stopped answering.
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
        let Ok(listener) = TcpListener::bind(("127.0.0.1", *port as u16)).await else {
            return Ok(false);
        };
        let task = tokio::spawn(serve_remote_forward(
            listener,
            session.handle(),
            address.to_string(),
            *port,
            Arc::clone(&self.forwarded),
        ));
        self.remote_listeners.insert(*port, task);
        if let Some(probe) = &self.forward_probe {
            probe_forwarded(session.handle(), *port + 1, probe.clone());
        }
        Ok(!self.refuse_remote_listen)
    }

    async fn cancel_tcpip_forward(
        &mut self,
        _address: &str,
        port: u32,
        _session: &mut Session,
    ) -> Result<bool, Self::Error> {
        if self.stall_cancel {
            // Blocks this connection's server loop: a server that stopped answering.
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
        if let Some(listener) = self.remote_listeners.remove(&port) {
            listener.abort();
        }
        Ok(true)
    }

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _term: &str,
        _cols: u32,
        _rows: u32,
        _pw: u32,
        _ph: u32,
        _modes: &[(russh::Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        // For the agent-forwarding tests: open an agent channel back to the
        // client. If the client accepts it, `channel_open_confirmation` fires and
        // reports `true`; a rejecting client produces no confirmation, which the
        // test observes as a timeout (⇒ rejected).
        if self.agent_probe.is_some() {
            session.channel_open_agent()?;
        }
        if let Some(probe) = &self.forward_probe {
            probe_forwarded(session.handle(), 8080, probe.clone());
        }
        if let Some(probe) = &self.stray_probe {
            probe_stray_channels(session.handle(), probe.clone());
        }
        if let Some(probe) = &self.x11_probe {
            let _ = probe.send(self.x11_cookie.clone());
            if let Some(cookie) = &self.x11_cookie {
                open_x11_client(
                    session.handle(),
                    cookie.clone(),
                    Arc::clone(&self.forwarded),
                );
            }
        }
        if let Some((count, probe)) = &self.x11_flood {
            flood_x11(session.handle(), *count, probe.clone());
        }
        Ok(())
    }

    async fn x11_request(
        &mut self,
        _channel: ChannelId,
        _single_connection: bool,
        _protocol: &str,
        cookie: &str,
        _screen: u32,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.x11_cookie = Some(cookie.to_string());
        Ok(())
    }

    async fn channel_open_confirmation(
        &mut self,
        _id: ChannelId,
        _max_packet_size: u32,
        _window_size: u32,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        // The only channel the server itself opens is the agent-forward probe, so
        // a confirmation here means the client accepted agent forwarding.
        if let Some(tx) = &self.agent_probe {
            let _ = tx.send(true);
        }
        Ok(())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        // A jump host must NOT echo: its direct-tcpip bytes are forwarded to the
        // real target by the bridge task (via the held channel's stream), and
        // echoing them back here would loop the target's SSH handshake into the
        // client's stream and corrupt it. Only the plain (target) server echoes,
        // standing in for a shell's tty.
        if self.bridge_direct_tcpip || self.forwarded.lock().unwrap().contains(&channel) {
            return Ok(());
        }
        if self.stall_reads {
            std::future::pending::<()>().await;
        }
        // Standing in for a shell's `exit [code]`: end the channel the way
        // OpenSSH does — EOF, then the exit status, then close.
        if let Some(code) = exit_code_of(data) {
            session.eof(channel)?;
            session.exit_status_request(channel, code)?;
            session.close(channel)?;
            return Ok(());
        }
        for chunk in data.chunks(self.echo_chunk.unwrap_or(data.len().max(1))) {
            session.data(channel, chunk.to_vec())?;
        }
        Ok(())
    }
}

/// The exit code a test shell ends with: `exit\n` → 0, `exit N\n` → N.
fn exit_code_of(data: &[u8]) -> Option<u32> {
    let line = std::str::from_utf8(data).ok()?.strip_suffix('\n')?;
    match line.strip_prefix("exit") {
        Some("") => Some(0),
        Some(rest) => rest.trim().parse().ok(),
        None => None,
    }
}

/// Bind an ephemeral local port and run the test server on it forever (until
/// the test process exits). Returns the chosen port.
async fn spawn_test_server(password: &str) -> u16 {
    spawn_configured_server(password, false).await
}

/// Like [`spawn_test_server`], but the server bridges `direct-tcpip` channels to
/// a real TCP connection — a working jump host for the ProxyJump test.
async fn spawn_jump_server(password: &str) -> u16 {
    spawn_configured_server(password, true).await
}

async fn spawn_configured_server(password: &str, bridge_direct_tcpip: bool) -> u16 {
    spawn_full_server(password, bridge_direct_tcpip, None, Duration::from_secs(30)).await
}

/// A server that drops any connection idle for `inactivity` — a stand-in for a
/// server that goes away on its own (reboot, network loss).
async fn spawn_dropping_server(password: &str, inactivity: Duration) -> u16 {
    spawn_full_server(password, false, None, inactivity).await
}

/// Spawn a server that opens an agent-forward channel to the client on shell
/// request and reports (via the returned receiver) `true` when the client
/// accepts it. A rejecting client sends no confirmation, so the receiver stays
/// empty — the agent-forwarding tests distinguish accept from reject on that.
async fn spawn_agent_probe_server(password: &str) -> (u16, mpsc::UnboundedReceiver<bool>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let port = spawn_full_server(password, false, Some(tx), Duration::from_secs(30)).await;
    (port, rx)
}

async fn spawn_full_server(
    password: &str,
    bridge_direct_tcpip: bool,
    agent_probe: Option<mpsc::UnboundedSender<bool>>,
    inactivity: Duration,
) -> u16 {
    let server = TestServer {
        bridge_direct_tcpip,
        agent_probe,
        ..TestServer::new(password)
    };
    spawn_server(server, server_config(inactivity)).await
}

/// A server standing in for a remote shell flooding output: it grants the
/// client a small send window, so a large write has to wait on window adjusts
/// mid-way, and echoes every received chunk back as a burst of tiny packets.
async fn spawn_flooding_echo_server(password: &str) -> u16 {
    let server = TestServer {
        echo_chunk: Some(64),
        ..TestServer::new(password)
    };
    let config = server::Config {
        window_size: 16 * 1024,
        ..server_config(Duration::from_secs(30))
    };
    spawn_server(server, config).await
}

/// A server granting the client a send window small enough to sit in
/// the loopback socket buffers. russh's client and server loops both stop
/// reading while a socket write is blocked, so with megabytes in flight both
/// ways (an echo flood) and small buffers (macOS) each waits on the other for
/// good; a per-channel window that always fits keeps the client's writes from
/// blocking. OpenSSH reads while it writes: this needs russh on both ends.
/// `nodelay`: under Nagle, the many small window adjusts each wait out a
/// delayed ACK, which turns a one-second flood into a minute.
async fn spawn_narrow_window_server(server: TestServer) -> u16 {
    let config = server::Config {
        window_size: 16 * 1024,
        nodelay: true,
        ..server_config(Duration::from_secs(30))
    };
    spawn_server(server, config).await
}

/// A server whose shell stops reading after the first bytes, with a small
/// window so a client write soon has to wait for a window adjust that never
/// comes.
async fn spawn_stalled_server(password: &str) -> u16 {
    let server = TestServer {
        stall_reads: true,
        ..TestServer::new(password)
    };
    let config = server::Config {
        window_size: 16 * 1024,
        ..server_config(Duration::from_secs(30))
    };
    spawn_server(server, config).await
}

/// A server reporting every connection that ended in an error on the
/// returned receiver; `bridge_direct_tcpip` makes it a jump host.
async fn spawn_error_reporting_server(
    password: &str,
    bridge_direct_tcpip: bool,
) -> (u16, mpsc::UnboundedReceiver<String>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let server = TestServer {
        bridge_direct_tcpip,
        session_errors: Some(tx),
        ..TestServer::new(password)
    };
    let port = spawn_server(server, server_config(Duration::from_secs(30))).await;
    (port, rx)
}

/// A server probing the client with channels it never asked for (see
/// [`probe_stray_channels`]); the receiver gets one report per type.
async fn spawn_stray_channel_server(
    password: &str,
) -> (u16, mpsc::UnboundedReceiver<(&'static str, bool)>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let server = TestServer {
        stray_probe: Some(tx),
        ..TestServer::new(password)
    };
    let port = spawn_server(server, server_config(Duration::from_secs(30))).await;
    (port, rx)
}

fn server_config(inactivity: Duration) -> server::Config {
    let host_key = PrivateKey::from_openssh(TEST_HOST_KEY).expect("valid test host key");
    server::Config {
        keys: vec![host_key],
        // Keep wrong-password rejections snappy in tests.
        auth_rejection_time: Duration::from_millis(10),
        auth_rejection_time_initial: Some(Duration::ZERO),
        inactivity_timeout: Some(inactivity),
        ..Default::default()
    }
}

/// Bind an ephemeral local port and run `server` on it until the test process
/// exits. Returns the chosen port.
async fn spawn_server(mut server: TestServer, config: server::Config) -> u16 {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind test server");
    let port = listener.local_addr().expect("local addr").port();

    tokio::spawn(async move {
        // `run_on_socket` owns the accept loop and drives each session.
        let _ = server.run_on_socket(Arc::new(config), &listener).await;
    });

    port
}

/* ------------------------------------------------------------------------- *
 * Test sink: records everything the SSH core surfaces
 * ------------------------------------------------------------------------- */

struct TestSink {
    data_tx: mpsc::UnboundedSender<Vec<u8>>,
    status_tx: mpsc::UnboundedSender<(SessionStatus, Option<String>)>,
    prompt_tx: mpsc::UnboundedSender<HostKeyPromptPayload>,
    prompt_closed_tx: mpsc::UnboundedSender<String>,
    auth_prompt_tx: mpsc::UnboundedSender<AuthPromptPayload>,
    error_code_tx: mpsc::UnboundedSender<&'static str>,
}

impl SessionSink for TestSink {
    fn on_data(&self, bytes: &[u8]) {
        let _ = self.data_tx.send(bytes.to_vec());
    }
    fn on_status(&self, status: SessionStatus, message: Option<String>) {
        let _ = self.status_tx.send((status, message));
    }
    fn on_error(&self, err: &AppError) {
        let _ = self.error_code_tx.send(err.code());
        self.on_status(SessionStatus::Error, Some(err.to_string()));
    }
}

impl ConnectPrompter for TestSink {
    fn on_host_key_prompt(&self, payload: HostKeyPromptPayload) {
        let _ = self.prompt_tx.send(payload);
    }
    fn on_host_key_prompt_closed(&self, prompt_id: &str) {
        let _ = self.prompt_closed_tx.send(prompt_id.to_string());
    }
    fn on_auth_prompt(&self, payload: AuthPromptPayload) {
        let _ = self.auth_prompt_tx.send(payload);
    }
}

struct SinkChannels {
    data_rx: mpsc::UnboundedReceiver<Vec<u8>>,
    status_rx: mpsc::UnboundedReceiver<(SessionStatus, Option<String>)>,
    prompt_rx: mpsc::UnboundedReceiver<HostKeyPromptPayload>,
    prompt_closed_rx: mpsc::UnboundedReceiver<String>,
    auth_prompt_rx: mpsc::UnboundedReceiver<AuthPromptPayload>,
    error_code_rx: mpsc::UnboundedReceiver<&'static str>,
}

fn new_sink() -> (Arc<dyn SessionSink>, SinkChannels) {
    let (data_tx, data_rx) = mpsc::unbounded_channel();
    let (status_tx, status_rx) = mpsc::unbounded_channel();
    let (prompt_tx, prompt_rx) = mpsc::unbounded_channel();
    let (prompt_closed_tx, prompt_closed_rx) = mpsc::unbounded_channel();
    let (auth_prompt_tx, auth_prompt_rx) = mpsc::unbounded_channel();
    let (error_code_tx, error_code_rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn SessionSink> = Arc::new(TestSink {
        data_tx,
        status_tx,
        prompt_tx,
        prompt_closed_tx,
        auth_prompt_tx,
        error_code_tx,
    });
    (
        sink,
        SinkChannels {
            data_rx,
            status_rx,
            prompt_rx,
            prompt_closed_rx,
            auth_prompt_rx,
            error_code_rx,
        },
    )
}

async fn recv_timeout<T>(rx: &mut mpsc::UnboundedReceiver<T>, dur: Duration) -> Option<T> {
    tokio::time::timeout(dur, rx.recv()).await.ok().flatten()
}

/// Await the terminal status of a session start (past the initial
/// `Connecting`): returns `Connected` or `Error` (with its message).
async fn await_settled(
    status_rx: &mut mpsc::UnboundedReceiver<(SessionStatus, Option<String>)>,
) -> (SessionStatus, Option<String>) {
    loop {
        let (status, message) = recv_timeout(status_rx, Duration::from_secs(10))
            .await
            .expect("a status event within 10s");
        if status != SessionStatus::Connecting {
            return (status, message);
        }
    }
}

fn manager_with(dir: &std::path::Path, prompt_timeout: Duration) -> Arc<SessionManager> {
    let known_hosts = Arc::new(KnownHostsStore::load(dir.to_path_buf()));
    Arc::new(SessionManager::new(
        known_hosts,
        Duration::from_secs(10),
        prompt_timeout,
        Duration::from_secs(10),
    ))
}

fn password_creds() -> AuthCredentials {
    AuthCredentials::Password(TEST_PASSWORD.to_string())
}

/// Spawn a password-auth session against the local test server with the
/// standard 80x24 PTY. Every integration test uses this same shape, so this
/// keeps the call sites to just `id` + `sink` (B8: `ConnectParams`).
fn spawn_pw_session(
    manager: &Arc<SessionManager>,
    id: &str,
    port: u16,
    sink: Arc<dyn SessionSink>,
) {
    spawn_pw_session_with_agent(manager, id, port, sink, false);
}

/// Like [`spawn_pw_session`], but lets the test set `forward_agent` so the
/// agent-forwarding accept/reject gate can be exercised end to end.
fn spawn_pw_session_with_agent(
    manager: &Arc<SessionManager>,
    id: &str,
    port: u16,
    sink: Arc<dyn SessionSink>,
    forward_agent: bool,
) {
    manager.spawn_session(
        id.to_string(),
        ConnectParams {
            host: "127.0.0.1".to_string(),
            port,
            username: TEST_USER.to_string(),
            creds: password_creds(),
            cols: 80,
            rows: 24,
            jump: None,
            keepalive: KeepaliveConfig::disabled(),
            forward_agent,
            connect_snippet: None,
            x11: None,
        },
        sink,
    );
}

/// Spawn a password-auth session forwarding X11 to `x11`.
fn spawn_pw_session_with_x11(
    manager: &Arc<SessionManager>,
    port: u16,
    sink: Arc<dyn SessionSink>,
    x11: Option<Result<X11Local, String>>,
) {
    manager.spawn_session("s1".to_string(), x11_params(port, x11), sink);
}

fn x11_params(port: u16, x11: Option<Result<X11Local, String>>) -> ConnectParams {
    ConnectParams {
        host: "127.0.0.1".to_string(),
        port,
        username: TEST_USER.to_string(),
        creds: password_creds(),
        cols: 80,
        rows: 24,
        jump: None,
        keepalive: KeepaliveConfig::disabled(),
        forward_agent: false,
        connect_snippet: None,
        x11,
    }
}

/// Spawn a password-auth session carrying a connect snippet, so the end-to-end
/// test can observe the snippet being typed into the shell (the echo server
/// reflects it back on the data channel).
fn spawn_pw_session_with_snippet(
    manager: &Arc<SessionManager>,
    id: &str,
    port: u16,
    sink: Arc<dyn SessionSink>,
    connect_snippet: &str,
) {
    manager.spawn_session(
        id.to_string(),
        ConnectParams {
            host: "127.0.0.1".to_string(),
            port,
            username: TEST_USER.to_string(),
            creds: password_creds(),
            cols: 80,
            rows: 24,
            jump: None,
            keepalive: KeepaliveConfig::disabled(),
            forward_agent: false,
            connect_snippet: Some(connect_snippet.to_string()),
            x11: None,
        },
        sink,
    );
}

/* ------------------------------------------------------------------------- *
 * test_connection — auth outcomes
 * ------------------------------------------------------------------------- */

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn password_auth_succeeds() {
    let dir = tempfile::tempdir().unwrap();
    let port = spawn_test_server(TEST_PASSWORD).await;
    // Pre-trust the host key ON DISK before the manager loads its store, so
    // test_connection doesn't block on a host-key prompt.
    seed_trusted(dir.path(), port);
    let manager = manager_with(dir.path(), Duration::from_secs(60));

    let (sink, _chans) = new_sink();
    let result = manager
        .test_connection(
            "127.0.0.1".to_string(),
            port,
            TEST_USER.to_string(),
            password_creds(),
            None,
            sink,
        )
        .await;

    assert!(result.is_ok(), "expected auth success, got {result:?}");
    assert_eq!(
        manager.session_count(),
        0,
        "test_connection leaves no session"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn wrong_password_is_ssh_auth() {
    let dir = tempfile::tempdir().unwrap();
    let port = spawn_test_server(TEST_PASSWORD).await;
    seed_trusted(dir.path(), port);
    let manager = manager_with(dir.path(), Duration::from_secs(60));

    let (sink, _chans) = new_sink();
    let result = manager
        .test_connection(
            "127.0.0.1".to_string(),
            port,
            TEST_USER.to_string(),
            AuthCredentials::Password("wrong".to_string()),
            None,
            sink,
        )
        .await;

    assert!(
        matches!(result, Err(AppError::SshAuth(_))),
        "expected SshAuth, got {result:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unreachable_host_is_ssh_connect() {
    let dir = tempfile::tempdir().unwrap();
    // Short connect timeout so the test is fast even if the OS is slow to refuse.
    let known_hosts = Arc::new(KnownHostsStore::load(dir.path().to_path_buf()));
    let manager = Arc::new(SessionManager::new(
        known_hosts,
        Duration::from_secs(3),
        Duration::from_secs(60),
        Duration::from_secs(10),
    ));

    // A port nothing listens on, and no other test is handed.
    let port = free_local_port().await;

    let (sink, _chans) = new_sink();
    let result = manager
        .test_connection(
            "127.0.0.1".to_string(),
            port,
            TEST_USER.to_string(),
            password_creds(),
            None,
            sink,
        )
        .await;

    assert!(
        matches!(result, Err(AppError::SshConnect(_))),
        "expected SshConnect, got {result:?}"
    );
}

/// B3 regression: a host that completes the TCP handshake but then never
/// speaks SSH (no version banner, ever) must not hang `test_connection`
/// forever. Before the B3 fix, only `TcpStream::connect` was ever
/// timeout-bound — `client::connect_stream` (the SSH version exchange + KEX)
/// had no deadline, so this scenario hung indefinitely. Uses short
/// connect/prompt/handshake timeouts so the overall `establish` deadline
/// (their sum — see `SessionManager::overall_establish_timeout`) is reached
/// quickly, and wraps the call in an outer `tokio::time::timeout` as a test
/// safety net so a regression fails fast instead of hanging the suite.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn peer_accepts_tcp_but_never_speaks_ssh_times_out() {
    let dir = tempfile::tempdir().unwrap();
    let known_hosts = Arc::new(KnownHostsStore::load(dir.path().to_path_buf()));
    let manager = Arc::new(SessionManager::new(
        known_hosts,
        Duration::from_millis(300),
        Duration::from_millis(300),
        Duration::from_millis(300),
    ));

    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();

    // Accept the connection and then go silent forever — no SSH banner, ever.
    tokio::spawn(async move {
        if let Ok((stream, _)) = listener.accept().await {
            let _keep_socket_open = stream;
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    });

    let (sink, _chans) = new_sink();
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        manager.test_connection(
            "127.0.0.1".to_string(),
            port,
            TEST_USER.to_string(),
            password_creds(),
            None,
            sink,
        ),
    )
    .await
    .expect("establish must be bounded by an overall deadline, not hang forever");

    assert!(
        matches!(result, Err(AppError::SshConnect(_))),
        "expected a timeout SshConnect error, got {result:?}"
    );
}

/* ------------------------------------------------------------------------- *
 * Live session — PTY echo + cleanup
 * ------------------------------------------------------------------------- */

/// Spawn a session, wait for Connected, type `line`, and return the final status.
async fn final_status_after_typing(line: &[u8]) -> SessionStatus {
    let dir = tempfile::tempdir().unwrap();
    let port = spawn_test_server(TEST_PASSWORD).await;
    seed_trusted(dir.path(), port);
    let manager = manager_with(dir.path(), Duration::from_secs(60));

    let (sink, mut chans) = new_sink();
    spawn_pw_session(&manager, "s1", port, sink);
    let (status, message) = await_settled(&mut chans.status_rx).await;
    assert_eq!(status, SessionStatus::Connected, "message={message:?}");

    manager.write_stdin("s1", line.to_vec()).await;
    await_settled(&mut chans.status_rx).await.0
}

/// Not `Disconnected`: the frontend must not auto-reconnect a shell the user
/// ended themselves.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_shell_that_exits_cleanly_reports_exited() {
    assert_eq!(
        final_status_after_typing(b"exit\n").await,
        SessionStatus::Exited
    );
}

/// A shell ending with a failure code (or killed, e.g. on reboot) isn't a
/// deliberate logout: it stays `Disconnected`, so auto-reconnect applies.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_shell_that_exits_with_a_failure_code_reports_disconnected() {
    assert_eq!(
        final_status_after_typing(b"exit 1\n").await,
        SessionStatus::Disconnected
    );
}

/// A write whose output floods back while it is still being sent (a big paste
/// into a busy remote shell) must round-trip in full. The shell pump used to
/// stop reading server output while a write waited on russh, so russh's
/// session loop blocked delivering that output and never got to the window
/// adjust the write was waiting on: the terminal froze until a reconnect.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn output_flooding_back_during_a_write_does_not_freeze_the_session() {
    const PAYLOAD_LEN: usize = 256 * 1024;
    let dir = tempfile::tempdir().unwrap();
    let port = spawn_flooding_echo_server(TEST_PASSWORD).await;
    seed_trusted(dir.path(), port);
    let manager = manager_with(dir.path(), Duration::from_secs(60));

    let (sink, mut chans) = new_sink();
    spawn_pw_session(&manager, "s1", port, sink);
    let (status, message) = await_settled(&mut chans.status_rx).await;
    assert_eq!(status, SessionStatus::Connected, "message={message:?}");

    manager.write_stdin("s1", vec![b'x'; PAYLOAD_LEN]).await;

    let mut received = 0;
    while received < PAYLOAD_LEN {
        match recv_timeout(&mut chans.data_rx, Duration::from_secs(5)).await {
            Some(chunk) => received += chunk.len(),
            None => break,
        }
    }
    assert_eq!(received, PAYLOAD_LEN, "the echo stalled");

    manager.disconnect("s1").await;
    await_session_count(&manager, 0).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn echo_through_pty_and_clean_disconnect() {
    let dir = tempfile::tempdir().unwrap();
    let port = spawn_test_server(TEST_PASSWORD).await;
    seed_trusted(dir.path(), port);
    let manager = manager_with(dir.path(), Duration::from_secs(60));

    let (sink, mut chans) = new_sink();
    spawn_pw_session(&manager, "s1", port, sink);

    let (status, message) = await_settled(&mut chans.status_rx).await;
    assert_eq!(status, SessionStatus::Connected, "message={message:?}");
    assert_eq!(manager.session_count(), 1);

    manager.write_stdin("s1", b"hello\n".to_vec()).await;

    // Collect echoed bytes until we see our payload (or time out).
    let mut seen = Vec::new();
    for _ in 0..50 {
        match recv_timeout(&mut chans.data_rx, Duration::from_secs(5)).await {
            Some(chunk) => {
                seen.extend_from_slice(&chunk);
                if seen.windows(5).any(|w| w == b"hello") {
                    break;
                }
            }
            None => break,
        }
    }
    assert!(
        seen.windows(5).any(|w| w == b"hello"),
        "expected the PTY to echo 'hello', saw {:?}",
        String::from_utf8_lossy(&seen)
    );

    manager.disconnect("s1").await;

    // The task removes its own map entry on exit; wait for that to settle.
    let (final_status, _) = await_settled(&mut chans.status_rx).await;
    assert_eq!(final_status, SessionStatus::Disconnected);
    for _ in 0..50 {
        if manager.session_count() == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(
        manager.session_count(),
        0,
        "session entry must be cleaned up"
    );
}

/// A device's connect snippet is typed into the shell right after it opens: the
/// echo server reflects it back, so we should see the snippet's commands — each
/// terminated with a carriage return — arrive on the data channel without any
/// `write_stdin` from the test.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn connect_snippet_is_sent_to_the_shell_on_connect() {
    let dir = tempfile::tempdir().unwrap();
    let port = spawn_test_server(TEST_PASSWORD).await;
    seed_trusted(dir.path(), port);
    let manager = manager_with(dir.path(), Duration::from_secs(60));

    let (sink, mut chans) = new_sink();
    spawn_pw_session_with_snippet(&manager, "s1", port, sink, "uptime\nwhoami");

    let (status, message) = await_settled(&mut chans.status_rx).await;
    assert_eq!(status, SessionStatus::Connected, "message={message:?}");

    // The snippet is sent by the session itself (no write_stdin here); the echo
    // server reflects it, so we expect to see both commands, each CR-terminated.
    let mut seen = Vec::new();
    for _ in 0..50 {
        match recv_timeout(&mut chans.data_rx, Duration::from_secs(5)).await {
            Some(chunk) => {
                seen.extend_from_slice(&chunk);
                if seen.windows(8).any(|w| w == b"uptime\rw") {
                    break;
                }
            }
            None => break,
        }
    }
    assert!(
        seen.windows(7).any(|w| w == b"uptime\r"),
        "expected the snippet's first command CR-terminated, saw {:?}",
        String::from_utf8_lossy(&seen)
    );
    assert!(
        seen.windows(7).any(|w| w == b"whoami\r"),
        "expected the snippet's second command CR-terminated, saw {:?}",
        String::from_utf8_lossy(&seen)
    );

    manager.disconnect("s1").await;
}

/// Agent forwarding ON: the client must accept the server's
/// `auth-agent@openssh.com` channel. The probe server opens one on shell request
/// and reports acceptance; we assert it arrives. (The client then tries to reach
/// a local agent and may find none — that's fine; the accept happens first and is
/// what the gate controls.)
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn agent_forwarding_enabled_accepts_agent_channel() {
    let dir = tempfile::tempdir().unwrap();
    let (port, mut agent_rx) = spawn_agent_probe_server(TEST_PASSWORD).await;
    seed_trusted(dir.path(), port);
    let manager = manager_with(dir.path(), Duration::from_secs(60));

    let (sink, mut chans) = new_sink();
    spawn_pw_session_with_agent(&manager, "s1", port, sink, true);

    let (status, message) = await_settled(&mut chans.status_rx).await;
    assert_eq!(status, SessionStatus::Connected, "message={message:?}");

    let accepted = recv_timeout(&mut agent_rx, Duration::from_secs(5)).await;
    assert_eq!(
        accepted,
        Some(true),
        "with forwarding on, the client must accept the agent channel"
    );

    manager.disconnect("s1").await;
}

/// Agent forwarding OFF (the default): the client must REJECT the server's
/// agent-forward channel — russh's default handler would otherwise accept it, so
/// this locks in our override. A rejecting client sends no confirmation, so the
/// probe receiver stays empty within the timeout.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn agent_forwarding_disabled_rejects_agent_channel() {
    let dir = tempfile::tempdir().unwrap();
    let (port, mut agent_rx) = spawn_agent_probe_server(TEST_PASSWORD).await;
    seed_trusted(dir.path(), port);
    let manager = manager_with(dir.path(), Duration::from_secs(60));

    let (sink, mut chans) = new_sink();
    spawn_pw_session_with_agent(&manager, "s1", port, sink, false);

    let (status, message) = await_settled(&mut chans.status_rx).await;
    assert_eq!(status, SessionStatus::Connected, "message={message:?}");

    // No acceptance confirmation must arrive — the client rejected the channel.
    let accepted = recv_timeout(&mut agent_rx, Duration::from_secs(2)).await;
    assert_eq!(
        accepted, None,
        "with forwarding off, the client must reject the agent channel"
    );

    manager.disconnect("s1").await;
}

async fn spawn_x11_probe_server() -> (u16, mpsc::UnboundedReceiver<Option<String>>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let server = TestServer {
        x11_probe: Some(tx),
        ..TestServer::new(TEST_PASSWORD)
    };
    (
        spawn_server(server, server_config(Duration::from_secs(30))).await,
        rx,
    )
}

/// A 32-byte X reply (little-endian) with `body` from byte 8, then `extra`.
fn x_reply(body: &[u8], extra: &[u8]) -> Vec<u8> {
    let words = u32::try_from(extra.len() / 4).unwrap();
    let mut out = [&[1, 0, 1, 0][..], &words.to_le_bytes(), body].concat();
    out.resize(32, 0);
    [out, extra.to_vec()].concat()
}

/// What an X server with the SECURITY extension answers to a client asking
/// for an untrusted cookie (setup, QueryExtension, QueryVersion, Generate).
fn x_security_replies(present: bool, cookie: &[u8; 16]) -> Vec<u8> {
    let setup_ok = vec![1, 0, 11, 0, 0, 0, 0, 0];
    let extension = x_reply(&[u8::from(present), 140], &[]);
    let version = x_reply(&[1, 0, 0, 0], &[]);
    let generated = x_reply(&[0, 0, 0, 7, 16, 0], cookie);
    [setup_ok, extension, version, generated].concat()
}

/// A local X server on TCP, its display name, and an Xauthority file with
/// `real cookie` for it.
async fn x_server_with_cookie(dir: &std::path::Path) -> (TcpListener, String, std::path::PathBuf) {
    let x_server = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let number = x_server.local_addr().unwrap().port() - 6000;
    let xauthority = dir.join("Xauthority");
    std::fs::write(&xauthority, xauthority_with(number, b"real cookie")).unwrap();
    (x_server, format!("127.0.0.1:{number}"), xauthority)
}

async fn accept_x(x_server: &TcpListener) -> TcpStream {
    let accepted = tokio::time::timeout(Duration::from_secs(5), x_server.accept()).await;
    accepted
        .expect("the X11 channel must reach the X server")
        .unwrap()
        .0
}

async fn expect_x_bytes(x_conn: &mut TcpStream, expected: &[u8]) {
    use tokio::io::AsyncReadExt;
    let mut received = vec![0u8; expected.len()];
    x_conn.read_exact(&mut received).await.unwrap();
    assert_eq!(received, expected);
}

/// Untrusted X11 forwarding: the client asks the X server for an untrusted
/// cookie (with the real one), then relays the channel with that cookie.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn x11_untrusted_forwarding_relays_with_a_cookie_the_x_server_generated() {
    use tokio::io::AsyncWriteExt;
    let dir = tempfile::tempdir().unwrap();
    let (port, _x11_rx) = spawn_x11_probe_server().await;
    seed_trusted(dir.path(), port);
    let manager = manager_with(dir.path(), Duration::from_secs(60));
    let (x_server, display, xauthority) = x_server_with_cookie(dir.path()).await;
    let local = X11Local::new(&display, Some(xauthority), false).map(Ok);

    let (sink, _chans) = new_sink();
    spawn_pw_session_with_x11(&manager, port, sink, local);

    let mut security_conn = accept_x(&x_server).await;
    let generated = *b"generated cookie";
    security_conn
        .write_all(&x_security_replies(true, &generated))
        .await
        .unwrap();
    expect_x_bytes(&mut security_conn, &x11_setup(b"real cookie")).await;
    let mut x_conn = accept_x(&x_server).await;
    expect_x_bytes(
        &mut x_conn,
        &[x11_setup(&generated), b"ping".to_vec()].concat(),
    )
    .await;

    manager.disconnect("s1").await;
}

/// Untrusted X11 forwarding on an X server without SECURITY: the channel is
/// refused (never relayed with the real cookie) and the terminal says why.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn x11_untrusted_failure_is_written_to_the_terminal() {
    use tokio::io::AsyncWriteExt;
    let dir = tempfile::tempdir().unwrap();
    let (port, _x11_rx) = spawn_x11_probe_server().await;
    seed_trusted(dir.path(), port);
    let manager = manager_with(dir.path(), Duration::from_secs(60));
    let (x_server, display, xauthority) = x_server_with_cookie(dir.path()).await;
    let local = X11Local::new(&display, Some(xauthority), false).map(Ok);

    let (sink, mut chans) = new_sink();
    spawn_pw_session_with_x11(&manager, port, sink, local);

    let mut security_conn = accept_x(&x_server).await;
    security_conn
        .write_all(&x_security_replies(false, &[0; 16]))
        .await
        .unwrap();
    let marker = b"X11 forwarding failed: no untrusted cookie";
    let seen = read_until_marker(&mut chans.data_rx, marker).await;
    assert!(seen.windows(marker.len()).any(|w| w == marker));
    let relayed = tokio::time::timeout(Duration::from_millis(300), x_server.accept()).await;
    assert!(relayed.is_err(), "the channel must not reach the X server");

    manager.disconnect("s1").await;
}

/// Trusted X11 forwarding: the client asks for X11 with a fake cookie, and
/// relays the server's X11 channel to the local X server with the real cookie.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn x11_trusted_forwarding_relays_to_the_local_x_server_with_the_real_cookie() {
    use tokio::io::AsyncReadExt;
    let dir = tempfile::tempdir().unwrap();
    let (port, mut x11_rx) = spawn_x11_probe_server().await;
    seed_trusted(dir.path(), port);
    let manager = manager_with(dir.path(), Duration::from_secs(60));
    let x_server = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let number = x_server.local_addr().unwrap().port() - 6000;
    let xauthority = dir.path().join("Xauthority");
    std::fs::write(&xauthority, xauthority_with(number, b"real cookie")).unwrap();
    let local = X11Local::new(&format!("127.0.0.1:{number}"), Some(xauthority), true).map(Ok);

    let (sink, _chans) = new_sink();
    spawn_pw_session_with_x11(&manager, port, sink, local);

    let cookie = recv_timeout(&mut x11_rx, Duration::from_secs(5))
        .await
        .flatten();
    let cookie = cookie.expect("the client must send an x11-req");
    assert_ne!(decode_hex(&cookie), b"real cookie");
    let accepted = tokio::time::timeout(Duration::from_secs(5), x_server.accept()).await;
    let (mut x_conn, _) = accepted
        .expect("the X11 channel must reach the X server")
        .unwrap();
    let expected = [x11_setup(b"real cookie"), b"ping".to_vec()].concat();
    let mut received = vec![0u8; expected.len()];
    x_conn.read_exact(&mut received).await.unwrap();
    assert_eq!(received, expected);

    manager.disconnect("s1").await;
}

/// A `DISPLAY` that can't be used: no `x11-req`, and the terminal says why.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn x11_without_a_usable_display_warns_and_sends_no_request() {
    let dir = tempfile::tempdir().unwrap();
    let (port, mut x11_rx) = spawn_x11_probe_server().await;
    seed_trusted(dir.path(), port);
    let manager = manager_with(dir.path(), Duration::from_secs(60));

    let (sink, mut chans) = new_sink();
    let reason = "DISPLAY is not set".to_string();
    spawn_pw_session_with_x11(&manager, port, sink, Some(Err(reason)));

    let marker = b"X11 forwarding failed: DISPLAY is not set";
    let seen = read_until_marker(&mut chans.data_rx, marker).await;
    assert!(seen.windows(marker.len()).any(|w| w == marker));
    let cookie = recv_timeout(&mut x11_rx, Duration::from_secs(5)).await;
    assert_eq!(cookie, Some(None));

    manager.disconnect("s1").await;
}

/// The client serves at most 32 X11 channels at once; the 33rd is refused
/// and the terminal says why.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn x11_channels_beyond_the_cap_are_refused_with_a_warning() {
    let dir = tempfile::tempdir().unwrap();
    let (flood_tx, mut flood_rx) = mpsc::unbounded_channel();
    let server = TestServer {
        x11_flood: Some((33, flood_tx)),
        ..TestServer::new(TEST_PASSWORD)
    };
    let port = spawn_server(server, server_config(Duration::from_secs(30))).await;
    seed_trusted(dir.path(), port);
    let manager = manager_with(dir.path(), Duration::from_secs(60));
    let local = X11Local::new("127.0.0.1:0", None, true).map(Ok);

    let (sink, mut chans) = new_sink();
    spawn_pw_session_with_x11(&manager, port, sink, local);

    let accepted = recv_timeout(&mut flood_rx, Duration::from_secs(5)).await;
    assert_eq!(accepted, Some(32));
    let marker = b"more than 32 X11 connections at once";
    let seen = read_until_marker(&mut chans.data_rx, marker).await;
    assert!(seen.windows(marker.len()).any(|w| w == marker));

    manager.disconnect("s1").await;
}

/// X11 forwarding is for the target only: the jump host's X11 channels are
/// refused even when the target forwards X11.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_jump_host_cannot_open_x11_channels() {
    let dir = tempfile::tempdir().unwrap();
    let (target_port, mut x11_rx) = spawn_x11_probe_server().await;
    let (jump_tx, mut jump_rx) = mpsc::unbounded_channel();
    let jump = TestServer {
        bridge_direct_tcpip: true,
        jump_x11_probe: Some(jump_tx),
        ..TestServer::new(TEST_PASSWORD)
    };
    let jump_port = spawn_server(jump, server_config(Duration::from_secs(30))).await;
    seed_trusted(dir.path(), target_port);
    seed_trusted(dir.path(), jump_port);
    let manager = manager_with(dir.path(), Duration::from_secs(60));

    // A display nothing listens on: the target's X11 channel goes nowhere.
    let display = format!("{}:0", dir.path().join("no-x-server").display());
    let (sink, _chans) = new_sink();
    let mut params = x11_params(target_port, X11Local::new(&display, None, true).map(Ok));
    params.jump = Some(jump_hop(jump_port, TEST_PASSWORD));
    manager.spawn_session("s1".to_string(), params, sink);

    let cookie = recv_timeout(&mut x11_rx, Duration::from_secs(5)).await;
    assert!(
        matches!(cookie, Some(Some(_))),
        "the target must get an x11-req"
    );
    let opened = recv_timeout(&mut jump_rx, Duration::from_secs(5)).await;
    assert_eq!(opened, Some(false));

    manager.disconnect("s1").await;
}

/// X11 forwarding OFF: no `x11-req` is sent.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn x11_forwarding_off_sends_no_request() {
    let dir = tempfile::tempdir().unwrap();
    let (port, mut x11_rx) = spawn_x11_probe_server().await;
    seed_trusted(dir.path(), port);
    let manager = manager_with(dir.path(), Duration::from_secs(60));

    let (sink, _chans) = new_sink();
    spawn_pw_session_with_x11(&manager, port, sink, None);

    let cookie = recv_timeout(&mut x11_rx, Duration::from_secs(5)).await;
    assert_eq!(cookie, Some(None));

    manager.disconnect("s1").await;
}

/// ProxyJump: connect to a target through a jump host and prove the PTY works
/// end-to-end over the jumped connection. The jump server bridges its
/// `direct-tcpip` channel to the target server's real port, so the client runs a
/// full SSH handshake with the *target* over the channel — exactly the
/// production path. Both hosts share the test host key, so both ports must be
/// pre-trusted (known-hosts is keyed by host:port).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn connects_to_target_through_a_jump_host() {
    let dir = tempfile::tempdir().unwrap();
    let target_port = spawn_test_server(TEST_PASSWORD).await;
    let jump_port = spawn_jump_server(TEST_PASSWORD).await;
    seed_trusted(dir.path(), target_port);
    seed_trusted(dir.path(), jump_port);
    let manager = manager_with(dir.path(), Duration::from_secs(60));

    let (sink, mut chans) = new_sink();
    manager.spawn_session(
        "s1".to_string(),
        ConnectParams {
            host: "127.0.0.1".to_string(),
            port: target_port,
            username: TEST_USER.to_string(),
            creds: password_creds(),
            cols: 80,
            rows: 24,
            jump: Some(JumpHop {
                host: "127.0.0.1".to_string(),
                port: jump_port,
                username: TEST_USER.to_string(),
                creds: password_creds(),
            }),
            keepalive: KeepaliveConfig::disabled(),
            forward_agent: false,
            connect_snippet: None,
            x11: None,
        },
        sink,
    );

    let (status, message) = await_settled(&mut chans.status_rx).await;
    assert_eq!(
        status,
        SessionStatus::Connected,
        "expected a connected session through the jump host, message={message:?}"
    );

    manager.write_stdin("s1", b"hello\n".to_vec()).await;

    let mut seen = Vec::new();
    for _ in 0..50 {
        match recv_timeout(&mut chans.data_rx, Duration::from_secs(5)).await {
            Some(chunk) => {
                seen.extend_from_slice(&chunk);
                if seen.windows(5).any(|w| w == b"hello") {
                    break;
                }
            }
            None => break,
        }
    }
    assert!(
        seen.windows(5).any(|w| w == b"hello"),
        "expected the target PTY to echo 'hello' through the jump host, saw {:?}",
        String::from_utf8_lossy(&seen)
    );

    manager.disconnect("s1").await;
    let (final_status, _) = await_settled(&mut chans.status_rx).await;
    assert_eq!(final_status, SessionStatus::Disconnected);
    for _ in 0..50 {
        if manager.session_count() == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(
        manager.session_count(),
        0,
        "session entry must be cleaned up"
    );
}

/// A jump-host auth failure must be attributed to the jump host, not the target
/// — otherwise the user checks the wrong device's stored credentials. The jump
/// creds are wrong; the target creds are correct, so only hop 1 fails.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn jump_host_auth_failure_is_attributed_to_the_jump_host() {
    let dir = tempfile::tempdir().unwrap();
    let target_port = spawn_test_server(TEST_PASSWORD).await;
    let jump_port = spawn_jump_server(TEST_PASSWORD).await;
    seed_trusted(dir.path(), target_port);
    seed_trusted(dir.path(), jump_port);
    let manager = manager_with(dir.path(), Duration::from_secs(60));

    let (sink, mut chans) = new_sink();
    manager.spawn_session(
        "s1".to_string(),
        ConnectParams {
            host: "127.0.0.1".to_string(),
            port: target_port,
            username: TEST_USER.to_string(),
            creds: password_creds(), // target creds are correct
            cols: 80,
            rows: 24,
            jump: Some(JumpHop {
                host: "127.0.0.1".to_string(),
                port: jump_port,
                username: TEST_USER.to_string(),
                creds: AuthCredentials::Password("wrong-jump-password".to_string()),
            }),
            keepalive: KeepaliveConfig::disabled(),
            forward_agent: false,
            connect_snippet: None,
            x11: None,
        },
        sink,
    );

    let (status, message) = await_settled(&mut chans.status_rx).await;
    assert_eq!(status, SessionStatus::Error);
    let message = message.unwrap_or_default();
    assert!(
        message.contains("jump host"),
        "error should name the jump host, got: {message}"
    );
    // The code lets the frontend skip auto-reconnect (no lockout retries).
    assert_eq!(chans.error_code_rx.try_recv(), Ok("SshAuth"));
}

fn jump_hop(port: u16, password: &str) -> JumpHop {
    JumpHop {
        host: "127.0.0.1".to_string(),
        port,
        username: TEST_USER.to_string(),
        creds: AuthCredentials::Password(password.to_string()),
    }
}

/// "Test connection" on a device behind a jump host goes through it, like a
/// real connect: it succeeds over the jump, and a wrong jump password is
/// reported against the jump host (the target's credentials are correct).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_connection_goes_through_the_jump_host() {
    let dir = tempfile::tempdir().unwrap();
    let target_port = spawn_test_server(TEST_PASSWORD).await;
    let jump_port = spawn_jump_server(TEST_PASSWORD).await;
    seed_trusted(dir.path(), target_port);
    seed_trusted(dir.path(), jump_port);
    let manager = manager_with(dir.path(), Duration::from_secs(60));
    let test = |jump_password: &str| {
        let (sink, _chans) = new_sink();
        manager.test_connection(
            "127.0.0.1".to_string(),
            target_port,
            TEST_USER.to_string(),
            password_creds(),
            Some(jump_hop(jump_port, jump_password)),
            sink,
        )
    };

    test(TEST_PASSWORD)
        .await
        .expect("test connection through the jump host");
    let err = test("wrong")
        .await
        .expect_err("a wrong jump password must fail the test");
    assert!(
        err.to_string().contains("jump host"),
        "error should name the jump host, got: {err}"
    );
}

/* ------------------------------------------------------------------------- *
 * Host-key TOFU: accept / reject / mismatch / timeout
 * ------------------------------------------------------------------------- */

/// Pre-seed the on-disk known-hosts store so a connect finds a matching key.
fn seed_trusted(dir: &std::path::Path, port: u16) {
    let store = KnownHostsStore::load(dir.to_path_buf());
    store
        .trust(
            "127.0.0.1",
            port,
            KnownHost {
                key_type: "ssh-ed25519".to_string(),
                fingerprint: server_fingerprint(),
            },
        )
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn host_key_accept_persists_tofu() {
    let dir = tempfile::tempdir().unwrap();
    let manager = manager_with(dir.path(), Duration::from_secs(60));
    let port = spawn_test_server(TEST_PASSWORD).await;

    let (sink, mut chans) = new_sink();
    spawn_pw_session(&manager, "s1", port, sink);

    // First contact ⇒ prompt with changed:false.
    let prompt = recv_timeout(&mut chans.prompt_rx, Duration::from_secs(10))
        .await
        .expect("a host_key_prompt");
    assert!(!prompt.changed, "first contact must be changed:false");
    assert!(!prompt.trust_reset);
    assert_eq!(prompt.fingerprint, server_fingerprint());

    manager.respond_host_key(&prompt.prompt_id, true);

    let (status, message) = await_settled(&mut chans.status_rx).await;
    assert_eq!(status, SessionStatus::Connected, "message={message:?}");

    // The trust decision must be persisted (TOFU): a fresh store sees it.
    let reloaded = KnownHostsStore::load(dir.path().to_path_buf());
    assert_eq!(
        reloaded.get("127.0.0.1", port).map(|h| h.fingerprint),
        Some(server_fingerprint())
    );

    manager.disconnect("s1").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn host_key_reject_fails_with_host_key_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let manager = manager_with(dir.path(), Duration::from_secs(60));
    let port = spawn_test_server(TEST_PASSWORD).await;

    let (sink, mut chans) = new_sink();
    spawn_pw_session(&manager, "s1", port, sink);

    let prompt = recv_timeout(&mut chans.prompt_rx, Duration::from_secs(10))
        .await
        .expect("a host_key_prompt");
    manager.respond_host_key(&prompt.prompt_id, false);

    let (status, _message) = await_settled(&mut chans.status_rx).await;
    assert_eq!(status, SessionStatus::Error);
    // The code lets the frontend skip auto-reconnect (no re-prompting).
    assert_eq!(chans.error_code_rx.try_recv(), Ok("HostKeyRejected"));
    // Nothing must have been persisted on a rejected key.
    let reloaded = KnownHostsStore::load(dir.path().to_path_buf());
    assert!(reloaded.get("127.0.0.1", port).is_none());
    // Session cleaned up.
    for _ in 0..50 {
        if manager.session_count() == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(manager.session_count(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn changed_host_key_prompts_with_changed_true_and_overwrites_on_accept() {
    let dir = tempfile::tempdir().unwrap();
    let port = spawn_test_server(TEST_PASSWORD).await;

    // Seed a DIFFERENT fingerprint for this host:port ON DISK before the manager
    // loads its store ⇒ the connect sees a mismatch.
    {
        let store = KnownHostsStore::load(dir.path().to_path_buf());
        store
            .trust(
                "127.0.0.1",
                port,
                KnownHost {
                    key_type: "ssh-ed25519".to_string(),
                    fingerprint: "SHA256:this-is-a-different-key".to_string(),
                },
            )
            .unwrap();
    }
    let manager = manager_with(dir.path(), Duration::from_secs(60));

    let (sink, mut chans) = new_sink();
    spawn_pw_session(&manager, "s1", port, sink);

    let prompt = recv_timeout(&mut chans.prompt_rx, Duration::from_secs(10))
        .await
        .expect("a host_key_prompt");
    assert!(prompt.changed, "a mismatch must be changed:true");

    manager.respond_host_key(&prompt.prompt_id, true);

    let (status, _message) = await_settled(&mut chans.status_rx).await;
    assert_eq!(status, SessionStatus::Connected);

    // Accepting overwrites the stored fingerprint with the real one.
    let reloaded = KnownHostsStore::load(dir.path().to_path_buf());
    assert_eq!(
        reloaded.get("127.0.0.1", port).map(|h| h.fingerprint),
        Some(server_fingerprint())
    );

    manager.disconnect("s1").await;
}

/// After a damaged trust file was reset, a host with no record may be one
/// trusted before: the prompt says so instead of reading as a first contact.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_host_unknown_after_a_trust_reset_prompts_with_trust_reset() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("known_hosts.json"), "{ damaged").unwrap();
    let manager = manager_with(dir.path(), Duration::from_secs(60));
    let port = spawn_test_server(TEST_PASSWORD).await;

    let (sink, mut chans) = new_sink();
    spawn_pw_session(&manager, "s1", port, sink);

    let prompt = recv_timeout(&mut chans.prompt_rx, Duration::from_secs(10))
        .await
        .expect("a host_key_prompt");
    assert!(prompt.trust_reset);
    assert!(!prompt.changed);
    manager.respond_host_key(&prompt.prompt_id, false);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn host_key_prompt_timeout_rejects() {
    let dir = tempfile::tempdir().unwrap();
    // Inject a very short prompt timeout so we don't wait 60s.
    let manager = manager_with(dir.path(), Duration::from_millis(200));
    let port = spawn_test_server(TEST_PASSWORD).await;

    let (sink, mut chans) = new_sink();
    spawn_pw_session(&manager, "s1", port, sink);

    // A prompt is emitted, but we deliberately never respond.
    let _prompt = recv_timeout(&mut chans.prompt_rx, Duration::from_secs(10))
        .await
        .expect("a host_key_prompt");

    let (status, _message) = await_settled(&mut chans.status_rx).await;
    assert_eq!(
        status,
        SessionStatus::Error,
        "an unanswered prompt must time out and reject"
    );
    let reloaded = KnownHostsStore::load(dir.path().to_path_buf());
    assert!(reloaded.get("127.0.0.1", port).is_none());
}

/// Finding 2 (error-taxonomy): the live-session host-key tests above can only
/// assert the coarse `SessionStatus::Error`, since a live session surfaces a
/// free-text `session_status` message rather than a structured `AppError`. This
/// drives the SAME host-key rejection path through `test_connection`, which
/// returns the `AppError` directly, and asserts the SPEC §5/§6 variant
/// (`HostKeyRejected`) specifically — so a wrong-variant regression in
/// `map_connect_err` (e.g. `UnknownKey ⇒ SshConnect`) fails this test.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn test_connection_host_key_reject_is_host_key_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let manager = manager_with(dir.path(), Duration::from_secs(60));
    let port = spawn_test_server(TEST_PASSWORD).await;

    let (sink, mut chans) = new_sink();

    // `test_connection` blocks on the host-key prompt, so drive it on a task and
    // reject the prompt from here.
    let mgr = Arc::clone(&manager);
    let handle = tokio::spawn(async move {
        mgr.test_connection(
            "127.0.0.1".to_string(),
            port,
            TEST_USER.to_string(),
            password_creds(),
            None,
            sink,
        )
        .await
    });

    let prompt = recv_timeout(&mut chans.prompt_rx, Duration::from_secs(10))
        .await
        .expect("a host_key_prompt");
    manager.respond_host_key(&prompt.prompt_id, false);

    let result = handle.await.expect("test_connection task joins");
    assert!(
        matches!(result, Err(AppError::HostKeyRejected(_))),
        "a rejected host key must surface as HostKeyRejected, got {result:?}"
    );
    // Nothing persisted on a rejected key.
    let reloaded = KnownHostsStore::load(dir.path().to_path_buf());
    assert!(reloaded.get("127.0.0.1", port).is_none());
}

/// App-close (SPEC §7): `disconnect_all` must gracefully close every live
/// session and settle `session_count()` back to 0. Brings up 3 concurrent live
/// sessions, calls `disconnect_all`, and asserts nothing is left tracked.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn disconnect_all_closes_every_session() {
    let dir = tempfile::tempdir().unwrap();
    let port = spawn_test_server(TEST_PASSWORD).await;
    seed_trusted(dir.path(), port);
    let manager = manager_with(dir.path(), Duration::from_secs(60));

    let mut kept = Vec::new();
    for i in 0..3 {
        let (sink, mut chans) = new_sink();
        spawn_pw_session(&manager, &format!("s{i}"), port, sink);
        let (status, message) = await_settled(&mut chans.status_rx).await;
        assert_eq!(status, SessionStatus::Connected, "message={message:?}");
        kept.push(chans); // keep the sink receivers alive for the session's lifetime
    }
    assert_eq!(manager.session_count(), 3);

    manager.disconnect_all().await;

    assert_eq!(
        manager.session_count(),
        0,
        "disconnect_all must gracefully close every session"
    );
}

/// A server can't park channels on us that we never asked for (each would
/// hold memory for the connection's lifetime).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn channels_the_client_never_asked_for_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let (port, mut probes) = spawn_stray_channel_server(TEST_PASSWORD).await;
    seed_trusted(dir.path(), port);
    let manager = manager_with(dir.path(), Duration::from_secs(60));
    let (sink, mut chans) = new_sink();
    spawn_pw_session(&manager, "s1", port, sink);
    let (status, message) = await_settled(&mut chans.status_rx).await;
    assert_eq!(status, SessionStatus::Connected, "message={message:?}");

    for _ in 0..5 {
        let (kind, accepted) = recv_timeout(&mut probes, Duration::from_secs(5))
            .await
            .expect("a probe report");
        assert!(!accepted, "a stray {kind} channel was accepted");
    }

    manager.disconnect("s1").await;
    await_session_count(&manager, 0).await;
}

/// B3: a disconnect must not wait behind writes the server stopped taking. It
/// used to queue after them, so with the queue full it never got in and app
/// quit hung.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn disconnect_is_not_stuck_behind_a_stalled_write() {
    let dir = tempfile::tempdir().unwrap();
    let port = spawn_stalled_server(TEST_PASSWORD).await;
    seed_trusted(dir.path(), port);
    let manager = manager_with(dir.path(), Duration::from_secs(60));
    let (sink, mut chans) = new_sink();
    spawn_pw_session(&manager, "s1", port, sink);
    let (status, message) = await_settled(&mut chans.status_rx).await;
    assert_eq!(status, SessionStatus::Connected, "message={message:?}");

    // Far more than the window and the write queue hold.
    let writer = Arc::clone(&manager);
    tokio::spawn(async move {
        for _ in 0..400 {
            writer.write_stdin("s1", vec![b'x'; 1024]).await;
        }
    });
    tokio::time::sleep(Duration::from_millis(300)).await;

    tokio::time::timeout(Duration::from_secs(2), manager.disconnect("s1"))
        .await
        .expect("disconnect must return despite the stalled write");
    let (final_status, _) = await_settled(&mut chans.status_rx).await;
    assert_eq!(final_status, SessionStatus::Disconnected);
    await_session_count(&manager, 0).await;
}

/// A disconnect ends the SSH connection with a real SSH disconnect, so the
/// server sees a clean goodbye rather than a dropped socket (an error).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_disconnect_closes_the_connection_cleanly() {
    let dir = tempfile::tempdir().unwrap();
    let (port, mut errors) = spawn_error_reporting_server(TEST_PASSWORD, false).await;
    seed_trusted(dir.path(), port);
    let manager = manager_with(dir.path(), Duration::from_secs(60));
    let (sink, mut chans) = new_sink();
    spawn_pw_session(&manager, "s1", port, sink);
    let (status, message) = await_settled(&mut chans.status_rx).await;
    assert_eq!(status, SessionStatus::Connected, "message={message:?}");

    manager.disconnect("s1").await;
    await_session_count(&manager, 0).await;

    let error = recv_timeout(&mut errors, Duration::from_millis(500)).await;
    assert_eq!(error, None, "the server saw the connection drop");
}

/// Through a jump host, both the target's connection and the jump host's are
/// closed cleanly: the target's disconnect gets through before the jump's.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_disconnect_closes_the_target_and_jump_host_cleanly() {
    let dir = tempfile::tempdir().unwrap();
    let (target_port, mut target_errors) = spawn_error_reporting_server(TEST_PASSWORD, false).await;
    let (jump_port, mut jump_errors) = spawn_error_reporting_server(TEST_PASSWORD, true).await;
    seed_trusted(dir.path(), target_port);
    seed_trusted(dir.path(), jump_port);
    let manager = manager_with(dir.path(), Duration::from_secs(60));
    let (sink, mut chans) = new_sink();
    manager.spawn_session(
        "s1".to_string(),
        ConnectParams {
            host: "127.0.0.1".to_string(),
            port: target_port,
            username: TEST_USER.to_string(),
            creds: password_creds(),
            cols: 80,
            rows: 24,
            jump: Some(jump_hop(jump_port, TEST_PASSWORD)),
            keepalive: KeepaliveConfig::disabled(),
            forward_agent: false,
            connect_snippet: None,
            x11: None,
        },
        sink,
    );
    let (status, message) = await_settled(&mut chans.status_rx).await;
    assert_eq!(status, SessionStatus::Connected, "message={message:?}");

    manager.disconnect("s1").await;
    await_session_count(&manager, 0).await;

    let error = recv_timeout(&mut jump_errors, Duration::from_millis(500)).await;
    assert_eq!(error, None, "the jump host saw the connection drop");
    let error = recv_timeout(&mut target_errors, Duration::from_millis(500)).await;
    assert_eq!(error, None, "the target saw the connection drop");
}

/// Finding 4 (regression): disconnect while a host-key prompt is still pending —
/// the most deadlock-prone path. With a long (60 s) prompt timeout so a hang
/// would be unmistakable, we spawn a session, wait for the prompt, then
/// `disconnect()` WITHOUT ever responding. The biased `select!` in `run_session`
/// must abort the handshake promptly (dropping the `establish` future, whose
/// `PromptGuard` cleans the registry) and the task must remove its own map
/// entry — i.e. the session settles well under the prompt timeout and
/// `session_count()` returns to 0.
/// A prompt the backend stops waiting on (session torn down, timeout) must be
/// announced as closed, so the frontend dialog can drop it instead of offering
/// a Trust button that no longer does anything.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_abandoned_host_key_prompt_is_announced_closed() {
    let dir = tempfile::tempdir().unwrap();
    let manager = manager_with(dir.path(), Duration::from_secs(60));
    let port = spawn_test_server(TEST_PASSWORD).await;

    let (sink, mut chans) = new_sink();
    spawn_pw_session(&manager, "s1", port, sink);
    let prompt = recv_timeout(&mut chans.prompt_rx, Duration::from_secs(10))
        .await
        .expect("a host_key_prompt");

    manager.disconnect("s1").await;

    let closed = recv_timeout(&mut chans.prompt_closed_rx, Duration::from_secs(5))
        .await
        .expect("a prompt-closed notice");
    assert_eq!(closed, prompt.prompt_id);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn disconnect_while_host_key_prompt_pending_cleans_up() {
    let dir = tempfile::tempdir().unwrap();
    let manager = manager_with(dir.path(), Duration::from_secs(60));
    let port = spawn_test_server(TEST_PASSWORD).await;

    let (sink, mut chans) = new_sink();
    spawn_pw_session(&manager, "s1", port, sink);

    // Wait for the prompt, then disconnect without answering it.
    let _prompt = recv_timeout(&mut chans.prompt_rx, Duration::from_secs(10))
        .await
        .expect("a host_key_prompt");
    manager.disconnect("s1").await;

    // The session must settle PROMPTLY — well under the 60 s prompt timeout. If
    // the mid-prompt disconnect path were broken, this would hang for ~60 s and
    // trip the 5 s cap (rather than passing by coincidence of a short timeout).
    let settled = tokio::time::timeout(Duration::from_secs(5), await_settled(&mut chans.status_rx))
        .await
        .expect(
            "session must settle promptly after a mid-prompt disconnect, not hang on the prompt",
        );
    assert_eq!(
        settled.0,
        SessionStatus::Disconnected,
        "a mid-prompt disconnect is a clean disconnect"
    );

    // The RAII PromptGuard + single-owner cleanup free the map entry.
    for _ in 0..50 {
        if manager.session_count() == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(
        manager.session_count(),
        0,
        "disconnect mid-prompt must clean up the session"
    );
    // Nothing persisted (the key was never accepted).
    let reloaded = KnownHostsStore::load(dir.path().to_path_buf());
    assert!(reloaded.get("127.0.0.1", port).is_none());
}

/* ------------------------------------------------------------------------- *
 * Phase 3 — concurrency: N simultaneous sessions + connect/disconnect churn
 * ------------------------------------------------------------------------- */

/// Poll the manager's `session_count` down to `expected`, giving the
/// self-cleaning session tasks time to remove their own map entries. Fails the
/// test (via the caller's assert) if it never settles.
async fn await_session_count(manager: &SessionManager, expected: usize) {
    for _ in 0..250 {
        if manager.session_count() == expected {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(
        manager.session_count(),
        expected,
        "session_count never settled to {expected}"
    );
}

/// Drain a session's data channel until its own `marker` is observed (returns
/// the accumulated bytes) or a timeout elapses (returns whatever was seen).
async fn read_until_marker(rx: &mut mpsc::UnboundedReceiver<Vec<u8>>, marker: &[u8]) -> Vec<u8> {
    let mut seen = Vec::new();
    for _ in 0..100 {
        match recv_timeout(rx, Duration::from_secs(5)).await {
            Some(chunk) => {
                seen.extend_from_slice(&chunk);
                if seen.windows(marker.len()).any(|w| w == marker) {
                    break;
                }
            }
            None => break,
        }
    }
    seen
}

/// Task 5 (Rust half): four simultaneous live sessions, each with its own sink,
/// driven independently. Proves per-session channel routing — every pane's PTY
/// echoes back *its own* bytes and never another pane's — with all four open at
/// once, that `session_count()` reports 4 while live, and that it returns to 0
/// after every session disconnects. A routing bug (one session's channel bytes
/// delivered to another's sink) fails the cross-contamination assertion.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn four_concurrent_sessions_route_io_independently() {
    let dir = tempfile::tempdir().unwrap();
    let port = spawn_test_server(TEST_PASSWORD).await;
    // Pre-trust so none of the four blocks on a TOFU prompt.
    seed_trusted(dir.path(), port);
    let manager = manager_with(dir.path(), Duration::from_secs(60));

    // Distinct, non-overlapping markers: no marker is a substring of another,
    // so "session i's sink contains marker j (j != i)" is exactly a misroute.
    let markers: [Vec<u8>; 4] = [
        b"PANE0DATA0\n".to_vec(),
        b"PANE1DATA1\n".to_vec(),
        b"PANE2DATA2\n".to_vec(),
        b"PANE3DATA3\n".to_vec(),
    ];

    // Spawn all four at once, each with its own independent sink.
    let mut channels = Vec::new();
    for i in 0..4 {
        let (sink, chans) = new_sink();
        spawn_pw_session(&manager, &format!("s{i}"), port, sink);
        channels.push(chans);
    }

    // Every session must reach Connected.
    for (i, chans) in channels.iter_mut().enumerate() {
        let (status, message) = await_settled(&mut chans.status_rx).await;
        assert_eq!(
            status,
            SessionStatus::Connected,
            "session s{i} failed to connect: {message:?}"
        );
    }
    assert_eq!(
        manager.session_count(),
        4,
        "all four sessions must be live at once"
    );

    // Drive I/O on ALL of them: write each session its own distinct payload.
    for (i, marker) in markers.iter().enumerate() {
        manager.write_stdin(&format!("s{i}"), marker.clone()).await;
    }

    // Each session's sink must echo back its OWN marker and none of the others.
    for (i, chans) in channels.iter_mut().enumerate() {
        let seen = read_until_marker(&mut chans.data_rx, &markers[i]).await;
        assert!(
            seen.windows(markers[i].len()).any(|w| w == &markers[i][..]),
            "session s{i} never echoed its own bytes; saw {:?}",
            String::from_utf8_lossy(&seen)
        );
        for (j, foreign) in markers.iter().enumerate() {
            if j == i {
                continue;
            }
            assert!(
                !seen.windows(foreign.len()).any(|w| w == &foreign[..]),
                "session s{i} received session s{j}'s bytes — channel misrouting; saw {:?}",
                String::from_utf8_lossy(&seen)
            );
        }
    }

    // Disconnect all and prove every task tears its own entry down.
    for i in 0..4 {
        manager.disconnect(&format!("s{i}")).await;
    }
    await_session_count(&manager, 0).await;
    assert_eq!(
        manager.session_count(),
        0,
        "no session may leak after all four disconnect"
    );
}

/// Task 3 (DoD focus): rapid connect/disconnect churn must not leak tasks or
/// map entries. Sessions are spawned and torn down at every handshake stage —
/// disconnected immediately (mid-handshake, before the task even runs
/// `establish`), and in a different order than they were spawned — many times
/// over. Session ids are unique (matching production's per-connect `Uuid`).
/// After the storm settles, `session_count()` must be exactly 0: every task,
/// however it was interrupted, removed its own entry (single-owner cleanup).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn connect_disconnect_churn_leaks_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let port = spawn_test_server(TEST_PASSWORD).await;
    seed_trusted(dir.path(), port);
    let manager = manager_with(dir.path(), Duration::from_secs(60));

    let mut id = 0u32;
    let mut next_id = || {
        id += 1;
        format!("churn-{id}")
    };

    // Round A — mid-handshake churn: spawn and immediately disconnect without
    // ever awaiting a status. The Disconnect is queued on the control channel
    // before (or racing) the task's first poll, so `run_session`'s biased
    // `select!` aborts the handshake and the task self-cleans.
    for _ in 0..40 {
        let (sink, _chans) = new_sink();
        let sid = next_id();
        spawn_pw_session(&manager, &sid, port, sink);
        manager.disconnect(&sid).await;
    }

    // Round B — out-of-order churn: spawn a batch all at once, keep the sinks
    // alive, then disconnect them in reverse order (not spawn order).
    let mut batch = Vec::new();
    for _ in 0..12 {
        let (sink, chans) = new_sink();
        let sid = next_id();
        spawn_pw_session(&manager, &sid, port, sink);
        batch.push((sid, chans));
    }
    for (sid, _chans) in batch.iter().rev() {
        manager.disconnect(sid).await;
    }
    drop(batch);

    // Round C — churn on fully-established sessions torn down out of order:
    // let a few reach Connected, then disconnect them middle-first.
    let mut live = Vec::new();
    for _ in 0..4 {
        let (sink, mut chans) = new_sink();
        let sid = next_id();
        spawn_pw_session(&manager, &sid, port, sink);
        let (status, message) = await_settled(&mut chans.status_rx).await;
        assert_eq!(
            status,
            SessionStatus::Connected,
            "churn session {sid} failed to connect: {message:?}"
        );
        live.push(sid);
    }
    for idx in [1usize, 3, 0, 2] {
        manager.disconnect(&live[idx]).await;
    }

    // After all churn, nothing may remain: no leaked task holds a map entry.
    await_session_count(&manager, 0).await;
    assert_eq!(
        manager.session_count(),
        0,
        "connect/disconnect churn must leave zero live sessions"
    );
}

/* ------------------------------------------------------------------------- *
 * Tunnels (local port-forwarding) — end-to-end round trip + cleanup
 * ------------------------------------------------------------------------- */

/// Test [`TunnelSink`] recording every status transition (with its per-forward
/// bind state) into a channel.
struct TestTunnelSink {
    status_tx: mpsc::UnboundedSender<(TunnelStatus, Vec<ForwardStatus>)>,
    message_tx: mpsc::UnboundedSender<Option<String>>,
    code_tx: mpsc::UnboundedSender<&'static str>,
    prompt_tx: mpsc::UnboundedSender<HostKeyPromptPayload>,
}

impl TunnelSink for TestTunnelSink {
    fn on_status(
        &self,
        status: TunnelStatus,
        message: Option<String>,
        forwards: Vec<ForwardStatus>,
    ) {
        let _ = self.message_tx.send(message);
        let _ = self.status_tx.send((status, forwards));
    }
    fn on_error(&self, err: &AppError) {
        let _ = self.code_tx.send(err.code());
        self.on_status(TunnelStatus::Error, Some(err.to_string()), Vec::new());
    }
}

impl ConnectPrompter for TestTunnelSink {
    fn on_host_key_prompt(&self, payload: HostKeyPromptPayload) {
        let _ = self.prompt_tx.send(payload);
    }
    fn on_auth_prompt(&self, _payload: AuthPromptPayload) {}
}

struct TunnelSinkChannels {
    status_rx: mpsc::UnboundedReceiver<(TunnelStatus, Vec<ForwardStatus>)>,
    /// The message of each status, in the same order as `status_rx`.
    message_rx: mpsc::UnboundedReceiver<Option<String>>,
    /// The `AppError` code of each error the tunnel ended on.
    code_rx: mpsc::UnboundedReceiver<&'static str>,
    #[allow(dead_code)]
    prompt_rx: mpsc::UnboundedReceiver<HostKeyPromptPayload>,
}

fn new_tunnel_sink() -> (Arc<dyn TunnelSink>, TunnelSinkChannels) {
    let (status_tx, status_rx) = mpsc::unbounded_channel();
    let (message_tx, message_rx) = mpsc::unbounded_channel();
    let (code_tx, code_rx) = mpsc::unbounded_channel();
    let (prompt_tx, prompt_rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn TunnelSink> = Arc::new(TestTunnelSink {
        status_tx,
        message_tx,
        code_tx,
        prompt_tx,
    });
    (
        sink,
        TunnelSinkChannels {
            status_rx,
            message_rx,
            code_rx,
            prompt_rx,
        },
    )
}

fn tunnel_manager_with(dir: &std::path::Path) -> Arc<TunnelManager> {
    Arc::new(new_tunnel_manager(dir))
}

fn new_tunnel_manager(dir: &std::path::Path) -> TunnelManager {
    let known_hosts = Arc::new(KnownHostsStore::load(dir.to_path_buf()));
    TunnelManager::new(
        known_hosts,
        Duration::from_secs(10),
        Duration::from_secs(60),
        Duration::from_secs(10),
    )
}

/// Await the `Listening` status (past the initial `Connecting`), returning its
/// per-forward statuses; fails if an `Error`/`Disconnected` arrives first.
async fn await_listening(
    status_rx: &mut mpsc::UnboundedReceiver<(TunnelStatus, Vec<ForwardStatus>)>,
) -> Vec<ForwardStatus> {
    loop {
        let (status, forwards) = recv_timeout(status_rx, Duration::from_secs(10))
            .await
            .expect("a tunnel status within 10s");
        match status {
            TunnelStatus::Connecting => continue,
            TunnelStatus::Listening => return forwards,
            other => panic!("expected Listening, got {other:?}"),
        }
    }
}

/// A free local port no other test gets: handed out once each, from below the
/// kernel's ephemeral range, so a parallel test's `bind(0)` or outgoing
/// connection can't take it between this check and the tunnel's bind. The
/// pid-derived start keeps concurrent test processes apart.
async fn free_local_port() -> u16 {
    static NEXT: OnceLock<AtomicU16> = OnceLock::new();
    let next = NEXT.get_or_init(|| AtomicU16::new(20_000 + (std::process::id() % 50) as u16 * 200));
    loop {
        let port = next.fetch_add(1, Ordering::Relaxed);
        assert!(port < 32_000, "ran out of test ports");
        if std::net::TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return port;
        }
    }
}

/// A tunnel binds a local listener and round-trips bytes to the SSH server over
/// a `direct-tcpip` channel; stopping it releases the listener and leaves no
/// tracked tunnel. The in-process server echoes channel data, so writing to the
/// local port and reading it back proves the whole forward path works.
/// With keepalive off nothing probes the link, but a transport the server
/// closed must still end the tunnel (as an error) instead of showing Listening.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tunnel_reports_a_lost_connection_without_keepalive() {
    let dir = tempfile::tempdir().unwrap();
    let port = spawn_dropping_server(TEST_PASSWORD, Duration::from_millis(300)).await;
    seed_trusted(dir.path(), port);
    let manager = tunnel_manager_with(dir.path());
    let local_port = free_local_port().await;

    let (sink, mut chans) = new_tunnel_sink();
    manager.spawn_tunnel(
        "t1".to_string(),
        TunnelParams {
            device_id: "dev-1".to_string(),
            host: "127.0.0.1".to_string(),
            port,
            username: TEST_USER.to_string(),
            creds: password_creds(),
            forwards: vec![Forward {
                id: "f1".to_string(),
                name: "echo".to_string(),
                kind: ForwardKind::Local,
                local_addr: "127.0.0.1".to_string(),
                local_port,
                remote_host: "127.0.0.1".to_string(),
                remote_port: 9,
            }],
            keepalive: KeepaliveConfig::disabled(),
            jump: None,
        },
        sink,
    );
    await_listening(&mut chans.status_rx).await;

    let (status, _) = recv_timeout(&mut chans.status_rx, Duration::from_secs(5))
        .await
        .expect("the tunnel must notice the lost connection");
    assert_eq!(status, TunnelStatus::Error);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tunnel_forwards_bytes_and_cleans_up() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let dir = tempfile::tempdir().unwrap();
    let port = spawn_test_server(TEST_PASSWORD).await;
    // Pre-trust the host key so the tunnel doesn't block on a TOFU prompt.
    seed_trusted(dir.path(), port);
    let manager = tunnel_manager_with(dir.path());

    let local_port = free_local_port().await;
    let forward = Forward {
        id: "f1".to_string(),
        name: "echo".to_string(),
        kind: ForwardKind::Local,
        local_addr: "127.0.0.1".to_string(),
        local_port,
        // The echo server ignores the direct-tcpip target, so any host:port works.
        remote_host: "127.0.0.1".to_string(),
        remote_port: 9,
    };

    let (sink, mut chans) = new_tunnel_sink();
    manager.spawn_tunnel(
        "t1".to_string(),
        TunnelParams {
            device_id: "dev-1".to_string(),
            host: "127.0.0.1".to_string(),
            port,
            username: TEST_USER.to_string(),
            creds: password_creds(),
            forwards: vec![forward],
            keepalive: KeepaliveConfig::disabled(),
            jump: None,
        },
        sink,
    );

    // The forward must bind and the tunnel must report Listening.
    let forwards = await_listening(&mut chans.status_rx).await;
    assert_eq!(forwards.len(), 1);
    assert!(forwards[0].bound, "the forward's local port must bind");
    assert_eq!(manager.tunnel_count(), 1);

    // Connect to the local end, write bytes, and read the echo back through the
    // tunnel — retrying the connect briefly in case accept isn't ready yet.
    let mut stream = None;
    for _ in 0..50 {
        match TcpStream::connect(("127.0.0.1", local_port)).await {
            Ok(s) => {
                stream = Some(s);
                break;
            }
            Err(_) => tokio::time::sleep(Duration::from_millis(20)).await,
        }
    }
    let mut stream = stream.expect("connect to the tunnel's local port");
    stream.write_all(b"PING\n").await.expect("write to tunnel");

    let mut buf = [0u8; 5];
    let read = tokio::time::timeout(Duration::from_secs(10), stream.read_exact(&mut buf))
        .await
        .expect("the tunnel must echo bytes back within 10s");
    assert!(read.is_ok(), "read echoed bytes: {read:?}");
    assert_eq!(&buf, b"PING\n", "the tunnel must round-trip the bytes");

    drop(stream);

    // Stopping the tunnel releases the listener and clears the map entry.
    manager.stop_tunnel("t1").await;
    for _ in 0..50 {
        if manager.tunnel_count() == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(
        manager.tunnel_count(),
        0,
        "the tunnel entry must be cleaned up"
    );

    // The local port is free again after stop (the listener was released).
    assert!(
        TcpListener::bind(("127.0.0.1", local_port)).await.is_ok(),
        "the local port must be released when the tunnel stops"
    );
}

fn echo_forward(id: &str, local_port: u16) -> Forward {
    Forward {
        id: id.to_string(),
        name: id.to_string(),
        kind: ForwardKind::Local,
        local_addr: "127.0.0.1".to_string(),
        local_port,
        remote_host: "127.0.0.1".to_string(),
        remote_port: 9,
    }
}

/// Start a one-forward tunnel to `target_port` through the jump host on
/// `jump_port`, authenticating to the jump host with `jump_password`.
fn spawn_jumped_tunnel(
    manager: &Arc<TunnelManager>,
    target_port: u16,
    jump_port: u16,
    jump_password: &str,
    forward: Forward,
) -> TunnelSinkChannels {
    let (sink, chans) = new_tunnel_sink();
    manager.spawn_tunnel(
        "t1".to_string(),
        TunnelParams {
            device_id: "dev-1".to_string(),
            host: "127.0.0.1".to_string(),
            port: target_port,
            username: TEST_USER.to_string(),
            creds: password_creds(),
            forwards: vec![forward],
            keepalive: KeepaliveConfig::disabled(),
            jump: Some(JumpHop {
                host: "127.0.0.1".to_string(),
                port: jump_port,
                username: TEST_USER.to_string(),
                creds: AuthCredentials::Password(jump_password.to_string()),
            }),
        },
        sink,
    );
    chans
}

/// ProxyJump for tunnels: the tunnel's SSH connection to the target rides a
/// `direct-tcpip` channel over the jump host, and forwarded bytes still
/// round-trip through the target (whose echo stands in for the remote service).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tunnel_forwards_bytes_through_a_jump_host() {
    let dir = tempfile::tempdir().unwrap();
    let target_port = spawn_test_server(TEST_PASSWORD).await;
    let jump_port = spawn_jump_server(TEST_PASSWORD).await;
    seed_trusted(dir.path(), target_port);
    seed_trusted(dir.path(), jump_port);
    let manager = tunnel_manager_with(dir.path());
    let local_port = free_local_port().await;

    let mut chans = spawn_jumped_tunnel(
        &manager,
        target_port,
        jump_port,
        TEST_PASSWORD,
        echo_forward("f1", local_port),
    );
    let forwards = await_listening(&mut chans.status_rx).await;
    assert!(forwards[0].bound, "the forward's local port must bind");

    let mut stream = connect_local(local_port).await;
    assert_echoes(&mut stream).await;
    drop(stream);

    manager.stop_tunnel("t1").await;
    await_no_tunnels(&manager).await;
}

/// Through a jump host the target's SSH connection rides a channel of the jump
/// connection: an upload waiting on that channel's window must not stop the
/// target's download, or it fills the jump connection's queue in front of the
/// window adjust the upload waits for. Both servers' windows are narrow, so a
/// freeze can't come from the test servers themselves (see
/// [`spawn_narrow_window_server`]). One connection only: the bridging test
/// server itself freezes under a dozen parallel floods (a real sshd doesn't).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_upload_and_a_download_through_a_jump_host_do_not_freeze_the_tunnel() {
    const CONNECTIONS: usize = 1;
    const FLOOD: usize = 32 << 20;

    let dir = tempfile::tempdir().unwrap();
    let service_port = spawn_flood_service(FLOOD).await;
    let target_port = spawn_narrow_window_server(TestServer {
        bridge_direct_tcpip: true,
        ..TestServer::new(TEST_PASSWORD)
    })
    .await;
    let jump_port = spawn_narrow_window_server(TestServer {
        bridge_direct_tcpip: true,
        ..TestServer::new(TEST_PASSWORD)
    })
    .await;
    seed_trusted(dir.path(), target_port);
    seed_trusted(dir.path(), jump_port);
    let manager = tunnel_manager_with(dir.path());
    let local_port = free_local_port().await;
    let forward = Forward {
        remote_port: service_port,
        ..echo_forward("f1", local_port)
    };
    let mut chans = spawn_jumped_tunnel(&manager, target_port, jump_port, TEST_PASSWORD, forward);
    await_listening(&mut chans.status_rx).await;

    let received = Arc::new(Progress::start());
    let mut transfers = tokio::task::JoinSet::new();
    for _ in 0..CONNECTIONS {
        let stream = connect_local(local_port).await;
        transfers.spawn(upload_and_download(stream, FLOOD, Arc::clone(&received)));
    }
    if tokio::time::timeout(STUCK, transfers.join_all())
        .await
        .is_err()
    {
        panic!(
            "the jumped tunnel froze: downloaded {} of {} bytes, last moving at {:?}",
            received.done(),
            CONNECTIONS * FLOOD,
            received.last_move()
        );
    }
    manager.stop_tunnel("t1").await;
}

/// Send `size` bytes on `stream` while reading `size` back, counting them.
async fn upload_and_download(stream: TcpStream, size: usize, received: Arc<Progress>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    const CHUNK: usize = 64 * 1024;
    let (mut reader, mut writer) = stream.into_split();
    let upload = async {
        for chunk in vec![0u8; size].chunks(CHUNK) {
            writer.write_all(chunk).await.unwrap();
        }
    };
    let download = async {
        let mut buf = vec![0u8; CHUNK];
        let mut done = 0;
        while done < size {
            let read = reader.read(&mut buf).await.unwrap();
            assert_ne!(read, 0, "the connection ended early");
            done += read;
            received.add(read);
        }
    };
    tokio::join!(upload, download);
}

/// Stopping a jumped tunnel mid-download closes the target's connection and
/// the jump host's cleanly: the target's disconnect isn't lost behind the
/// download still arriving for it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stopping_a_jumped_tunnel_mid_download_closes_both_cleanly() {
    use tokio::io::AsyncReadExt;
    let dir = tempfile::tempdir().unwrap();
    let service_port = spawn_flood_service(64 << 20).await;
    let (target_port, mut target_errors) = spawn_error_reporting_server(TEST_PASSWORD, true).await;
    let (jump_port, mut jump_errors) = spawn_error_reporting_server(TEST_PASSWORD, true).await;
    seed_trusted(dir.path(), target_port);
    seed_trusted(dir.path(), jump_port);
    let manager = tunnel_manager_with(dir.path());
    let local_port = free_local_port().await;
    let forward = Forward {
        remote_port: service_port,
        ..echo_forward("f1", local_port)
    };
    let mut chans = spawn_jumped_tunnel(&manager, target_port, jump_port, TEST_PASSWORD, forward);
    await_listening(&mut chans.status_rx).await;
    let mut stream = connect_local(local_port).await;
    stream.read_exact(&mut [0u8; 64 * 1024]).await.unwrap();

    manager.stop_tunnel("t1").await;
    await_no_tunnels(&manager).await;

    let error = recv_timeout(&mut target_errors, Duration::from_millis(500)).await;
    assert_eq!(error, None, "the target saw the connection drop");
    let error = recv_timeout(&mut jump_errors, Duration::from_millis(500)).await;
    assert_eq!(error, None, "the jump host saw the connection drop");
}

/// A jumped tunnel none of whose forwards start still closes the target's
/// connection and the jump host's cleanly before reporting the error.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_jumped_tunnel_that_binds_nothing_closes_both_cleanly() {
    let dir = tempfile::tempdir().unwrap();
    let (target_port, mut target_errors) = spawn_error_reporting_server(TEST_PASSWORD, false).await;
    let (jump_port, mut jump_errors) = spawn_error_reporting_server(TEST_PASSWORD, true).await;
    seed_trusted(dir.path(), target_port);
    seed_trusted(dir.path(), jump_port);
    let manager = tunnel_manager_with(dir.path());
    let occupied = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let forward = echo_forward("f1", occupied.local_addr().unwrap().port());
    let mut chans = spawn_jumped_tunnel(&manager, target_port, jump_port, TEST_PASSWORD, forward);

    let (status, _) = recv_timeout(&mut chans.status_rx, Duration::from_secs(10))
        .await
        .expect("a tunnel status");
    let status = match status {
        TunnelStatus::Connecting => {
            recv_timeout(&mut chans.status_rx, Duration::from_secs(10))
                .await
                .expect("a tunnel status")
                .0
        }
        other => other,
    };
    assert_eq!(status, TunnelStatus::Error);
    await_no_tunnels(&manager).await;

    let error = recv_timeout(&mut target_errors, Duration::from_millis(500)).await;
    assert_eq!(error, None, "the target saw the connection drop");
    let error = recv_timeout(&mut jump_errors, Duration::from_millis(500)).await;
    assert_eq!(error, None, "the jump host saw the connection drop");
}

/// A local TCP service that sends each connection `size` bytes while
/// discarding whatever it receives; returns its port.
async fn spawn_flood_service(size: usize) -> u16 {
    use tokio::io::AsyncWriteExt;
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((tcp, _)) = listener.accept().await {
            let (mut reader, mut writer) = tcp.into_split();
            tokio::spawn(async move { tokio::io::copy(&mut reader, &mut tokio::io::sink()).await });
            tokio::spawn(async move { writer.write_all(&vec![7u8; size]).await });
        }
    });
    port
}

/// A jump-host auth failure ends the tunnel with an error naming the jump host,
/// which also proves the tunnel really went through it (the target's own
/// credentials are correct).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tunnel_jump_host_auth_failure_is_attributed_to_the_jump_host() {
    let dir = tempfile::tempdir().unwrap();
    let target_port = spawn_test_server(TEST_PASSWORD).await;
    let jump_port = spawn_jump_server(TEST_PASSWORD).await;
    seed_trusted(dir.path(), target_port);
    seed_trusted(dir.path(), jump_port);
    let manager = tunnel_manager_with(dir.path());
    let local_port = free_local_port().await;

    let mut chans = spawn_jumped_tunnel(
        &manager,
        target_port,
        jump_port,
        "wrong",
        echo_forward("f1", local_port),
    );
    loop {
        let (status, _) = recv_timeout(&mut chans.status_rx, Duration::from_secs(10))
            .await
            .expect("a tunnel status within 10s");
        let message = chans.message_rx.recv().await.flatten().unwrap_or_default();
        if status == TunnelStatus::Connecting {
            continue;
        }
        assert_eq!(status, TunnelStatus::Error);
        assert!(
            message.contains("jump host"),
            "error should name the jump host, got: {message}"
        );
        break;
    }
    await_no_tunnels(&manager).await;
}

/// Wait (briefly) until the manager no longer tracks any tunnel.
async fn await_no_tunnels(manager: &TunnelManager) {
    for _ in 0..50 {
        if manager.tunnel_count() == 0 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("the tunnel must be cleaned up");
}

/// Forwards can be bound and released one at a time on a live tunnel's single
/// SSH connection: each change re-reports the full forward set, `list` mirrors
/// it, and releasing the last bound forward ends the tunnel.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tunnel_adds_and_removes_forwards_while_live() {
    let dir = tempfile::tempdir().unwrap();
    let port = spawn_test_server(TEST_PASSWORD).await;
    seed_trusted(dir.path(), port);
    let manager = tunnel_manager_with(dir.path());
    let (first_port, second_port) = (free_local_port().await, free_local_port().await);

    let (sink, mut chans) = new_tunnel_sink();
    manager.spawn_tunnel(
        "t1".to_string(),
        TunnelParams {
            device_id: "dev-1".to_string(),
            host: "127.0.0.1".to_string(),
            port,
            username: TEST_USER.to_string(),
            creds: password_creds(),
            forwards: vec![echo_forward("f1", first_port)],
            keepalive: KeepaliveConfig::disabled(),
            jump: None,
        },
        sink,
    );
    // Even before it has connected, the tunnel reports what it will bind.
    assert_eq!(manager.list()[0].forward_ids, ["f1"]);
    await_listening(&mut chans.status_rx).await;

    assert!(
        manager
            .add_forward("t1", echo_forward("f2", second_port))
            .await
    );
    let forwards = await_listening(&mut chans.status_rx).await;
    let ids: Vec<&str> = forwards.iter().map(|f| f.forward_id.as_str()).collect();
    assert_eq!(ids, ["f1", "f2"]);
    assert!(forwards.iter().all(|f| f.bound));
    assert_eq!(manager.list()[0].forwards.len(), 2);
    assert_eq!(manager.list()[0].forward_ids, ["f1", "f2"]);
    let mut stream = connect_local(second_port).await;
    assert_echoes(&mut stream).await;
    drop(stream);

    manager.remove_forward("t1", "f1".to_string()).await;
    let forwards = await_listening(&mut chans.status_rx).await;
    assert_eq!(forwards.len(), 1);
    assert_eq!(forwards[0].forward_id, "f2");
    assert!(
        TcpListener::bind(("127.0.0.1", first_port)).await.is_ok(),
        "a removed forward's port must be released"
    );

    manager.remove_forward("t1", "f2".to_string()).await;
    let (status, _) = recv_timeout(&mut chans.status_rx, Duration::from_secs(5))
        .await
        .expect("removing the last forward must end the tunnel");
    assert_eq!(status, TunnelStatus::Disconnected);
    await_no_tunnels(&manager).await;
    assert!(
        !manager
            .add_forward("t1", echo_forward("f3", first_port))
            .await
    );
}

/// Start a one-forward echo tunnel whose connections' clients may fall
/// `backlog_limit` bytes behind and then stall for `stall`; returns the manager
/// (to stop it) and the local port.
async fn start_echo_tunnel_with_backlog(
    dir: &std::path::Path,
    backlog_limit: usize,
    stall: Duration,
) -> (Arc<TunnelManager>, u16) {
    let port = spawn_narrow_window_server(TestServer::new(TEST_PASSWORD)).await;
    seed_trusted(dir, port);
    let manager = Arc::new(
        new_tunnel_manager(dir)
            .with_backlog_limit(backlog_limit)
            .with_stall_timeout(stall),
    );
    let local_port = free_local_port().await;
    let (sink, mut chans) = new_tunnel_sink();
    manager.spawn_tunnel(
        "t1".to_string(),
        TunnelParams {
            device_id: "dev-1".to_string(),
            host: "127.0.0.1".to_string(),
            port,
            username: TEST_USER.to_string(),
            creds: password_creds(),
            forwards: vec![echo_forward("f1", local_port)],
            keepalive: KeepaliveConfig::disabled(),
            jump: None,
        },
        sink,
    );
    await_listening(&mut chans.status_rx).await;
    (manager, local_port)
}

/// A deadline for the tests that push megabytes through a tunnel: generous
/// enough that only a stuck tunnel misses it, however slow the machine (a CI
/// runner with a debug build), so the outcome never depends on throughput.
const STUCK: Duration = Duration::from_secs(120);

/// russh blocks its whole connection while one channel's reader is full, so a
/// local client that paused reading used to freeze every connection of the
/// tunnel. Its data now waits in its own backlog: the connection keeps
/// flowing, so the paused client's whole upload goes through, the others echo,
/// and the paused client still gets every byte once it reads again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_client_that_pauses_reading_does_not_hold_up_the_tunnel() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    const FLOOD: usize = 24 << 20;
    const CHUNK: usize = 64 * 1024;

    let dir = tempfile::tempdir().unwrap();
    // A stall timeout far past `STUCK`: a tunnel that froze must stay frozen
    // for the whole test, not recover by cutting the paused client.
    let (manager, local_port) =
        start_echo_tunnel_with_backlog(dir.path(), 64 << 20, 5 * STUCK).await;

    // Far more than russh's and the sockets' buffers hold, never read back
    // yet: a frozen tunnel would stop taking the upload before its end.
    let paused = connect_local(local_port).await;
    let (mut paused_rd, mut paused_wr) = paused.into_split();
    let uploaded = Progress::start();
    let upload = async {
        for chunk in vec![0u8; FLOOD].chunks(CHUNK) {
            paused_wr.write_all(chunk).await.unwrap();
            uploaded.add(chunk.len());
        }
    };
    if tokio::time::timeout(STUCK, upload).await.is_err() {
        // Counted as the local socket took it: includes the kernel buffers
        // between the client and the tunnel.
        let report = stall_report(&manager, local_port, "uploaded", &uploaded, FLOOD).await;
        panic!("the tunnel stopped taking the paused client's upload: {report}");
    }

    // The flood's echo may still be queued ahead of this one.
    let mut other = connect_local(local_port).await;
    assert_echoes_within(&mut other, STUCK).await;

    let received = Progress::start();
    let read_back = async {
        let mut buf = vec![0u8; CHUNK];
        while received.done() < FLOOD {
            let read = paused_rd.read(&mut buf).await.unwrap();
            assert_ne!(read, 0, "the paused client's connection ended early");
            received.add(read);
        }
    };
    if tokio::time::timeout(STUCK, read_back).await.is_err() {
        let report = stall_report(&manager, local_port, "received", &received, FLOOD).await;
        panic!("the paused client stopped getting its data back: {report}");
    }
    assert_eq!(received.done(), FLOOD, "more came back than was sent");
    manager.stop_tunnel("t1").await;
}

/// A transfer's byte count and when it last moved: progress up to the deadline
/// means slow, an early last move means a freeze (and when it began).
struct Progress {
    started: std::time::Instant,
    done: AtomicUsize,
    last_move_ms: AtomicU64,
}

impl Progress {
    fn start() -> Self {
        Progress {
            started: std::time::Instant::now(),
            done: AtomicUsize::new(0),
            last_move_ms: AtomicU64::new(0),
        }
    }

    fn add(&self, bytes: usize) {
        self.done.fetch_add(bytes, Ordering::Relaxed);
        let elapsed = self.started.elapsed().as_millis() as u64;
        self.last_move_ms.store(elapsed, Ordering::Relaxed);
    }

    fn done(&self) -> usize {
        self.done.load(Ordering::Relaxed)
    }

    fn last_move(&self) -> Duration {
        Duration::from_millis(self.last_move_ms.load(Ordering::Relaxed))
    }
}

/// What a stalled backlog test saw, for a failure that only happens on CI:
/// how far the stalled transfer got and when it last moved, whether the
/// tunnel still carries a new connection (one frozen connection vs. the whole
/// SSH connection), and the tunnel as the manager lists it.
async fn stall_report(
    manager: &TunnelManager,
    local_port: u16,
    what: &str,
    progress: &Progress,
    total: usize,
) -> String {
    let fresh_echoes = probe_echo(local_port, Duration::from_secs(10)).await;
    format!(
        "{what} {} of {total} bytes, last moving at {:?} of {STUCK:?}; \
         a new connection echoes: {fresh_echoes}; tunnels: {:?}",
        progress.done(),
        progress.last_move(),
        manager.list()
    )
}

/// Whether a new connection to `port` echoes a line within `limit`.
async fn probe_echo(port: u16, limit: Duration) -> bool {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let probe = async {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.ok()?;
        stream.write_all(b"PROBE\n").await.ok()?;
        let mut reply = [0u8; 6];
        stream.read_exact(&mut reply).await.ok()?;
        Some(&reply == b"PROBE\n")
    };
    matches!(tokio::time::timeout(limit, probe).await, Ok(Some(true)))
}

/// A client that falls further behind than the backlog limit and then stops
/// reading is cut off, and only it: the tunnel's other connections flow again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_client_too_far_behind_is_closed_alone() {
    use tokio::io::AsyncWriteExt;

    let dir = tempfile::tempdir().unwrap();
    let (manager, local_port) =
        start_echo_tunnel_with_backlog(dir.path(), 1 << 20, Duration::from_secs(1)).await;

    // Flood the echo and never read it back, keeping the socket open.
    let mut stalled = connect_local(local_port).await;
    let flood = tokio::spawn(async move { stalled.write_all(&vec![0u8; 64 << 20]).await });

    let cut = tokio::time::timeout(STUCK, flood)
        .await
        .expect("the stalled client must be cut off")
        .unwrap();
    assert!(cut.is_err(), "its connection is closed under it");
    let mut other = connect_local(local_port).await;
    assert_echoes_within(&mut other, STUCK).await;
    manager.stop_tunnel("t1").await;
}

/// Connect to a tunnel's local port, retrying briefly until its listener accepts.
async fn connect_local(port: u16) -> TcpStream {
    for _ in 0..50 {
        if let Ok(stream) = TcpStream::connect(("127.0.0.1", port)).await {
            return stream;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("could not connect to the tunnel's local port {port}");
}

/// A local TCP echo service; returns its port.
async fn spawn_echo_service() -> u16 {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut tcp, _)) = listener.accept().await {
            tokio::spawn(async move {
                let (mut reader, mut writer) = tcp.split();
                let _ = tokio::io::copy(&mut reader, &mut writer).await;
            });
        }
    });
    port
}

/// A running dynamic (SOCKS) tunnel against a bridging test server.
struct DynamicTunnel {
    manager: Arc<TunnelManager>,
    chans: TunnelSinkChannels,
    local_port: u16,
    _dir: tempfile::TempDir,
}

async fn start_dynamic_tunnel() -> DynamicTunnel {
    let dir = tempfile::tempdir().unwrap();
    let port = spawn_configured_server(TEST_PASSWORD, true).await;
    seed_trusted(dir.path(), port);
    let manager = tunnel_manager_with(dir.path());
    let local_port = free_local_port().await;

    let (sink, mut chans) = new_tunnel_sink();
    manager.spawn_tunnel(
        "t1".to_string(),
        TunnelParams {
            device_id: "dev-1".to_string(),
            host: "127.0.0.1".to_string(),
            port,
            username: TEST_USER.to_string(),
            creds: password_creds(),
            forwards: vec![Forward {
                id: "f1".to_string(),
                name: "proxy".to_string(),
                kind: ForwardKind::Dynamic,
                local_addr: "127.0.0.1".to_string(),
                local_port,
                remote_host: String::new(),
                remote_port: 0,
            }],
            keepalive: KeepaliveConfig::disabled(),
            jump: None,
        },
        sink,
    );
    let forwards = await_listening(&mut chans.status_rx).await;
    assert!(forwards[0].bound, "the SOCKS port must bind");
    DynamicTunnel {
        manager,
        chans,
        local_port,
        _dir: dir,
    }
}

/// Stop the tunnel and assert it is untracked and its port released.
async fn stop_and_assert_cleanup(tunnel: &DynamicTunnel) {
    tunnel.manager.stop_tunnel("t1").await;
    for _ in 0..50 {
        if tunnel.manager.tunnel_count() == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(
        tunnel.manager.tunnel_count(),
        0,
        "the tunnel must be cleaned up"
    );
    assert!(
        TcpListener::bind(("127.0.0.1", tunnel.local_port))
            .await
            .is_ok(),
        "the SOCKS port must be released"
    );
}

async fn read_exactly(stream: &mut TcpStream, len: usize) -> Vec<u8> {
    read_exactly_within(stream, len, Duration::from_secs(10)).await
}

async fn read_exactly_within(stream: &mut TcpStream, len: usize, limit: Duration) -> Vec<u8> {
    use tokio::io::AsyncReadExt;
    let mut buf = vec![0u8; len];
    tokio::time::timeout(limit, stream.read_exact(&mut buf))
        .await
        .unwrap_or_else(|_| panic!("bytes within {limit:?}"))
        .unwrap();
    buf
}

async fn assert_echoes(stream: &mut TcpStream) {
    assert_echoes_within(stream, Duration::from_secs(10)).await;
}

async fn assert_echoes_within(stream: &mut TcpStream, limit: Duration) {
    use tokio::io::AsyncWriteExt;
    stream.write_all(b"PING\n").await.unwrap();
    assert_eq!(read_exactly_within(stream, 5, limit).await, b"PING\n");
}

/// A SOCKS5 greeting + CONNECT to `host` (as a domain name) on `port`.
fn socks5_request(host: &str, port: u16) -> Vec<u8> {
    let mut request = vec![5, 1, 0, 5, 1, 0, 3, host.len() as u8];
    request.extend_from_slice(host.as_bytes());
    request.extend_from_slice(&port.to_be_bytes());
    request
}

/// A dynamic forward is a SOCKS proxy: the client's SOCKS5 request (here by
/// host name) decides where the SSH server connects. The server bridges
/// `direct-tcpip` to the requested target — an echo service only reachable at
/// the port the SOCKS request names — so the echo proves the target came from
/// the request, not from the forward's config.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dynamic_tunnel_connects_to_the_socks_target() {
    use tokio::io::AsyncWriteExt;

    let tunnel = start_dynamic_tunnel().await;
    let echo_port = spawn_echo_service().await;

    let mut stream = connect_local(tunnel.local_port).await;
    stream
        .write_all(&socks5_request("127.0.0.1", echo_port))
        .await
        .unwrap();
    let replies = read_exactly(&mut stream, 12).await;
    assert_eq!(&replies[..2], &[5, 0], "no-auth chosen");
    assert_eq!(&replies[2..4], &[5, 0], "CONNECT granted");
    assert_echoes(&mut stream).await;

    drop(stream);
    stop_and_assert_cleanup(&tunnel).await;
}

/// SOCKS4a (host name after the user id) works end to end too.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dynamic_tunnel_serves_socks4a() {
    use tokio::io::AsyncWriteExt;

    let tunnel = start_dynamic_tunnel().await;
    let echo_port = spawn_echo_service().await;

    let mut stream = connect_local(tunnel.local_port).await;
    let mut request = vec![4, 1];
    request.extend_from_slice(&echo_port.to_be_bytes());
    request.extend_from_slice(&[0, 0, 0, 1]);
    request.extend_from_slice(b"me\x00127.0.0.1\x00");
    stream.write_all(&request).await.unwrap();
    assert_eq!(
        read_exactly(&mut stream, 8).await[..2],
        [0, 0x5A],
        "granted"
    );
    assert_echoes(&mut stream).await;

    drop(stream);
    stop_and_assert_cleanup(&tunnel).await;
}

/// A target the SSH server refuses is reported as "connection refused" to that
/// one client; the tunnel itself keeps listening.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dynamic_tunnel_reports_a_refused_target_and_keeps_listening() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let mut tunnel = start_dynamic_tunnel().await;

    let mut stream = connect_local(tunnel.local_port).await;
    stream
        .write_all(&socks5_request(REFUSED_HOST, 80))
        .await
        .unwrap();
    let replies = read_exactly(&mut stream, 12).await;
    assert_eq!(&replies[2..4], &[5, 5], "connection refused");
    let mut rest = Vec::new();
    stream.read_to_end(&mut rest).await.unwrap();
    assert!(
        rest.is_empty(),
        "the proxy closes the client after refusing"
    );

    assert_eq!(tunnel.manager.tunnel_count(), 1, "the tunnel keeps running");
    assert!(
        recv_timeout(&mut tunnel.chans.status_rx, Duration::from_millis(300))
            .await
            .is_none(),
        "a refused target must not change the tunnel's status"
    );
    stop_and_assert_cleanup(&tunnel).await;
}

/// Stopping the tunnel while a client is mid-handshake ends that connection
/// too: nothing outlives the tunnel.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stopping_a_dynamic_tunnel_drops_clients_mid_handshake() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let tunnel = start_dynamic_tunnel().await;
    let mut stream = connect_local(tunnel.local_port).await;
    stream.write_all(&[5]).await.unwrap(); // greeting started, never finished

    stop_and_assert_cleanup(&tunnel).await;
    let mut buf = [0u8; 1];
    let read = tokio::time::timeout(Duration::from_secs(5), stream.read(&mut buf))
        .await
        .expect("the half-open client must be dropped when the tunnel stops");
    assert!(matches!(read, Ok(0) | Err(_)), "expected EOF, got {read:?}");
}

/// A tunnel whose only forward cannot bind its local port (already in use) ends
/// with an error and leaves nothing tracked.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tunnel_bind_failure_errors_and_cleans_up() {
    let dir = tempfile::tempdir().unwrap();
    let port = spawn_test_server(TEST_PASSWORD).await;
    seed_trusted(dir.path(), port);
    let manager = tunnel_manager_with(dir.path());

    // Hold a listener on the local port so the tunnel's bind fails.
    let occupied = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let local_port = occupied.local_addr().unwrap().port();

    let forward = Forward {
        id: "f1".to_string(),
        name: "echo".to_string(),
        kind: ForwardKind::Local,
        local_addr: "127.0.0.1".to_string(),
        local_port,
        remote_host: "127.0.0.1".to_string(),
        remote_port: 9,
    };

    let (sink, mut chans) = new_tunnel_sink();
    manager.spawn_tunnel(
        "t1".to_string(),
        TunnelParams {
            device_id: "dev-1".to_string(),
            host: "127.0.0.1".to_string(),
            port,
            username: TEST_USER.to_string(),
            creds: password_creds(),
            forwards: vec![forward],
            keepalive: KeepaliveConfig::disabled(),
            jump: None,
        },
        sink,
    );

    // With no forward able to bind, the tunnel settles on Error, not Listening.
    let mut saw_error = false;
    for _ in 0..10 {
        let (status, _) = recv_timeout(&mut chans.status_rx, Duration::from_secs(10))
            .await
            .expect("a tunnel status");
        match status {
            TunnelStatus::Connecting => continue,
            TunnelStatus::Error => {
                saw_error = true;
                break;
            }
            other => panic!("expected Error when no forward binds, got {other:?}"),
        }
    }
    assert!(
        saw_error,
        "a tunnel that binds nothing must surface an error"
    );
    // A local port in use won't free itself: not worth reconnecting.
    assert_eq!(chans.code_rx.try_recv().unwrap(), "TunnelBind");

    for _ in 0..50 {
        if manager.tunnel_count() == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(manager.tunnel_count(), 0, "a failed tunnel must not leak");
    drop(occupied);
}

/* ------------------------------------------------------------------------- *
 * Remote forwards (`ssh -R`)
 * ------------------------------------------------------------------------- */

/// The server listens on `server_port`; connections go to `local_port` here.
fn remote_forward(id: &str, server_port: u16, local_port: u16) -> Forward {
    Forward {
        id: id.to_string(),
        name: id.to_string(),
        kind: ForwardKind::Remote,
        local_addr: "127.0.0.1".to_string(),
        local_port,
        remote_host: "localhost".to_string(),
        remote_port: server_port,
    }
}

struct RemoteTunnel {
    manager: Arc<TunnelManager>,
    chans: TunnelSinkChannels,
    _dir: tempfile::TempDir,
}

fn start_remote_tunnel(port: u16, dir: tempfile::TempDir, forwards: Vec<Forward>) -> RemoteTunnel {
    seed_trusted(dir.path(), port);
    let manager = tunnel_manager_with(dir.path());
    let (sink, chans) = new_tunnel_sink();
    manager.spawn_tunnel(
        "t1".to_string(),
        TunnelParams {
            device_id: "dev-1".to_string(),
            host: "127.0.0.1".to_string(),
            port,
            username: TEST_USER.to_string(),
            creds: password_creds(),
            forwards,
            keepalive: KeepaliveConfig::disabled(),
            jump: None,
        },
        sink,
    );
    RemoteTunnel {
        manager,
        chans,
        _dir: dir,
    }
}

async fn remote_tunnel(forwards: Vec<Forward>) -> RemoteTunnel {
    let port = spawn_test_server(TEST_PASSWORD).await;
    start_remote_tunnel(port, tempfile::tempdir().unwrap(), forwards)
}

/// Wait until nothing accepts on `port` any more.
async fn await_port_closed(port: u16) {
    for _ in 0..50 {
        if TcpStream::connect(("127.0.0.1", port)).await.is_err() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("port {port} must stop accepting");
}

/// A connection to the server's port reaches the local service through the
/// tunnel; stopping the tunnel ends the server's listen.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remote_forward_carries_server_connections_to_the_local_target() {
    let echo_port = spawn_echo_service().await;
    let server_port = free_local_port().await;
    let mut tunnel = remote_tunnel(vec![remote_forward("r1", server_port, echo_port)]).await;

    let forwards = await_listening(&mut tunnel.chans.status_rx).await;
    assert!(forwards[0].bound, "the server must grant the listen");
    assert_eq!(forwards[0].remote_port, server_port);
    let mut stream = connect_local(server_port).await;
    assert_echoes(&mut stream).await;
    drop(stream);

    tunnel.manager.stop_tunnel("t1").await;
    await_no_tunnels(&tunnel.manager).await;
    await_port_closed(server_port).await;
}

/// A local target that refuses the connection: the server's client sees its
/// connection closed, and the forward keeps serving.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remote_forward_to_a_closed_local_target_drops_the_connection() {
    use tokio::io::AsyncReadExt;

    let closed_port = free_local_port().await;
    let server_port = free_local_port().await;
    let mut tunnel = remote_tunnel(vec![remote_forward("r1", server_port, closed_port)]).await;
    await_listening(&mut tunnel.chans.status_rx).await;

    let mut stream = connect_local(server_port).await;
    let mut buf = [0u8; 1];
    let read = tokio::time::timeout(Duration::from_secs(10), stream.read(&mut buf))
        .await
        .expect("the connection must close within 10s");
    assert_eq!(read.unwrap_or(0), 0, "no bytes: the connection is closed");
    assert_eq!(tunnel.manager.tunnel_count(), 1);
}

/// A server that refuses the listen (port taken there) reports the forward
/// unbound; the tunnel's other forwards keep running.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remote_forward_refused_by_the_server_is_reported_unbound() {
    let taken = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let taken_port = taken.local_addr().unwrap().port();
    let local_port = free_local_port().await;
    let mut tunnel = remote_tunnel(vec![
        echo_forward("f1", local_port),
        remote_forward("r1", taken_port, 9),
    ])
    .await;

    let forwards = await_listening(&mut tunnel.chans.status_rx).await;
    let bound: Vec<(&str, bool)> = forwards
        .iter()
        .map(|f| (f.forward_id.as_str(), f.bound))
        .collect();
    assert_eq!(bound, [("f1", true), ("r1", false)]);
    drop(taken);
}

/// A tunnel whose only forwards are remote ones the server refused ends with
/// an error worth reconnecting: after a network drop the server's stale
/// session often still holds the ports for a while.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_tunnel_whose_remote_forwards_were_all_refused_may_be_retried() {
    let taken = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let taken_port = taken.local_addr().unwrap().port();
    let mut tunnel = remote_tunnel(vec![remote_forward("r1", taken_port, 9)]).await;

    let code = recv_timeout(&mut tunnel.chans.code_rx, Duration::from_secs(15))
        .await
        .expect("the tunnel must end on an error");

    assert_eq!(code, "SshConnect");
    drop(taken);
}

/// Removing a remote forward from a live tunnel cancels the server's listen.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn removing_a_remote_forward_stops_the_server_listening() {
    let echo_port = spawn_echo_service().await;
    let (local_port, server_port) = (free_local_port().await, free_local_port().await);
    let mut tunnel = remote_tunnel(vec![
        echo_forward("f1", local_port),
        remote_forward("r1", server_port, echo_port),
    ])
    .await;
    await_listening(&mut tunnel.chans.status_rx).await;
    let mut stream = connect_local(server_port).await;
    assert_echoes(&mut stream).await;

    tunnel.manager.remove_forward("t1", "r1".to_string()).await;
    let forwards = await_listening(&mut tunnel.chans.status_rx).await;
    assert_eq!(forwards.len(), 1);
    await_port_closed(server_port).await;
    // Its open connection is closed too, as for a removed local forward.
    let mut buf = [0u8; 1];
    let read = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::io::AsyncReadExt::read(&mut stream, &mut buf),
    )
    .await
    .expect("the open connection must close within 10s");
    assert_eq!(read.unwrap_or(0), 0);
}

async fn spawn_remote_test_server(configure: impl FnOnce(&mut TestServer)) -> u16 {
    let mut server = TestServer::new(TEST_PASSWORD);
    configure(&mut server);
    spawn_server(server, server_config(Duration::from_secs(30))).await
}

/// A listen the server granted after reporting it refused (or past the
/// client's timeout) must not carry connections: the forward reads as not
/// running, so nothing may reach its local target.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_refused_remote_forward_carries_no_connections() {
    use tokio::io::AsyncReadExt;

    let echo_port = spawn_echo_service().await;
    let (local_port, server_port) = (free_local_port().await, free_local_port().await);
    let port = spawn_remote_test_server(|s| s.refuse_remote_listen = true).await;
    let mut tunnel = start_remote_tunnel(
        port,
        tempfile::tempdir().unwrap(),
        vec![
            echo_forward("f1", local_port),
            remote_forward("r1", server_port, echo_port),
        ],
    );
    let forwards = await_listening(&mut tunnel.chans.status_rx).await;
    assert!(!forwards[1].bound);

    let mut stream = connect_local(server_port).await;
    tokio::io::AsyncWriteExt::write_all(&mut stream, b"PING\n")
        .await
        .unwrap();
    let mut buf = [0u8; 5];
    let read = tokio::time::timeout(Duration::from_secs(10), stream.read(&mut buf))
        .await
        .expect("the connection must close within 10s");
    assert_eq!(
        read.unwrap_or(0),
        0,
        "an unrouted connection must be dropped"
    );
}

/// Only a tunnel routes `forwarded-tcpip` channels: a shell rejects them.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_shell_connection_rejects_forwarded_tcpip_channels() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let port = spawn_remote_test_server(|s| s.forward_probe = Some(tx)).await;
    let dir = tempfile::tempdir().unwrap();
    seed_trusted(dir.path(), port);
    let manager = manager_with(dir.path(), Duration::from_secs(60));
    let (sink, _chans) = new_sink();
    spawn_pw_session(&manager, "s1", port, sink);

    let accepted = recv_timeout(&mut rx, Duration::from_secs(10))
        .await
        .expect("the probe must get an answer");
    assert!(!accepted, "a shell must reject a forwarded-tcpip channel");
}

/// A tunnel accepts `forwarded-tcpip` only for the ports its forwards asked for.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_tunnel_rejects_forwarded_tcpip_for_a_port_no_forward_asked_for() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let echo_port = spawn_echo_service().await;
    let server_port = free_local_port().await;
    let port = spawn_remote_test_server(|s| s.forward_probe = Some(tx)).await;
    let mut tunnel = start_remote_tunnel(
        port,
        tempfile::tempdir().unwrap(),
        vec![remote_forward("r1", server_port, echo_port)],
    );
    await_listening(&mut tunnel.chans.status_rx).await;

    let accepted = recv_timeout(&mut rx, Duration::from_secs(10))
        .await
        .expect("the probe must get an answer");
    assert!(
        !accepted,
        "the port after the granted one was never asked for"
    );
}

/// Through a jump host, the target's connection still routes the server's
/// connections back to the local target.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn remote_forward_works_through_a_jump_host() {
    let dir = tempfile::tempdir().unwrap();
    let target_port = spawn_test_server(TEST_PASSWORD).await;
    let jump_port = spawn_jump_server(TEST_PASSWORD).await;
    seed_trusted(dir.path(), target_port);
    seed_trusted(dir.path(), jump_port);
    let manager = tunnel_manager_with(dir.path());
    let (echo_port, server_port) = (spawn_echo_service().await, free_local_port().await);

    let (sink, mut chans) = new_tunnel_sink();
    manager.spawn_tunnel(
        "t1".to_string(),
        TunnelParams {
            device_id: "dev-1".to_string(),
            host: "127.0.0.1".to_string(),
            port: target_port,
            username: TEST_USER.to_string(),
            creds: password_creds(),
            forwards: vec![remote_forward("r1", server_port, echo_port)],
            keepalive: KeepaliveConfig::disabled(),
            jump: Some(jump_hop(jump_port, TEST_PASSWORD)),
        },
        sink,
    );
    assert!(await_listening(&mut chans.status_rx).await[0].bound);
    let mut stream = connect_local(server_port).await;
    assert_echoes(&mut stream).await;
}

/// Ending a tunnel doesn't wait on the server to cancel each remote forward:
/// closing the connection ends its listens anyway.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stopping_a_tunnel_does_not_wait_on_an_unresponsive_server() {
    let echo_port = spawn_echo_service().await;
    let (first, second) = (free_local_port().await, free_local_port().await);
    let port = spawn_remote_test_server(|s| s.stall_cancel = true).await;
    let mut tunnel = start_remote_tunnel(
        port,
        tempfile::tempdir().unwrap(),
        vec![
            remote_forward("r1", first, echo_port),
            remote_forward("r2", second, echo_port),
        ],
    );
    await_listening(&mut tunnel.chans.status_rx).await;

    let started = std::time::Instant::now();
    tunnel.manager.stop_tunnel("t1").await;
    await_no_tunnels(&tunnel.manager).await;
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "stop took {:?}",
        started.elapsed()
    );
}

/// A stop isn't held up by a forward change still waiting on the server (a
/// cancel or listen can take up to its 10 s timeout).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stop_does_not_wait_behind_a_pending_forward_change() {
    let echo_port = spawn_echo_service().await;
    let (first, second) = (free_local_port().await, free_local_port().await);
    let port = spawn_remote_test_server(|s| s.stall_cancel = true).await;
    let mut tunnel = start_remote_tunnel(
        port,
        tempfile::tempdir().unwrap(),
        vec![
            remote_forward("r1", first, echo_port),
            remote_forward("r2", second, echo_port),
        ],
    );
    await_listening(&mut tunnel.chans.status_rx).await;
    tunnel.manager.remove_forward("t1", "r2".to_string()).await;
    tokio::time::sleep(Duration::from_millis(100)).await;

    let started = std::time::Instant::now();
    tunnel.manager.stop_tunnel("t1").await;
    await_no_tunnels(&tunnel.manager).await;
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "stop took {:?}",
        started.elapsed()
    );
}

/// The forwards of the next `Listening` status within `limit`, skipping any
/// other status; `None` when none arrives in time.
async fn next_listening_within(
    status_rx: &mut mpsc::UnboundedReceiver<(TunnelStatus, Vec<ForwardStatus>)>,
    limit: Duration,
) -> Option<Vec<ForwardStatus>> {
    let deadline = tokio::time::Instant::now() + limit;
    loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        match recv_timeout(status_rx, left).await? {
            (TunnelStatus::Listening, forwards) => return Some(forwards),
            _ => continue,
        }
    }
}

fn bound_ids(forwards: &[ForwardStatus]) -> Vec<(&str, bool)> {
    forwards
        .iter()
        .map(|f| (f.forward_id.as_str(), f.bound))
        .collect()
}

/// A server slow to cancel a removed remote forward doesn't hold up the
/// tunnel's next change: a local forward added meanwhile binds right away.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_change_does_not_wait_behind_a_slow_remote_cancel() {
    let echo_port = spawn_echo_service().await;
    let (local_port, server_port, added_port) = (
        free_local_port().await,
        free_local_port().await,
        free_local_port().await,
    );
    let port = spawn_remote_test_server(|s| s.stall_cancel = true).await;
    let mut tunnel = start_remote_tunnel(
        port,
        tempfile::tempdir().unwrap(),
        vec![
            echo_forward("f1", local_port),
            remote_forward("r1", server_port, echo_port),
        ],
    );
    await_listening(&mut tunnel.chans.status_rx).await;

    tunnel.manager.remove_forward("t1", "r1".to_string()).await;
    let removed = next_listening_within(&mut tunnel.chans.status_rx, Duration::from_secs(3))
        .await
        .expect("the removal must be reported without waiting on the server");
    assert_eq!(bound_ids(&removed), [("f1", true)]);
    assert!(
        tunnel
            .manager
            .add_forward("t1", echo_forward("f2", added_port))
            .await
    );
    let added = next_listening_within(&mut tunnel.chans.status_rx, Duration::from_secs(3))
        .await
        .expect("the add must not wait on the server");
    assert_eq!(bound_ids(&added), [("f1", true), ("f2", true)]);
    tunnel.manager.stop_tunnel("t1").await;
}

/// While the server has yet to answer a remote forward's listen, the forward
/// is left out of `Listening` (still starting) and other changes go ahead.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_change_does_not_wait_behind_a_slow_remote_listen() {
    let (local_port, server_port, added_port) = (
        free_local_port().await,
        free_local_port().await,
        free_local_port().await,
    );
    let port = spawn_remote_test_server(|s| s.stall_listen = true).await;
    let mut tunnel = start_remote_tunnel(
        port,
        tempfile::tempdir().unwrap(),
        vec![echo_forward("f1", local_port)],
    );
    await_listening(&mut tunnel.chans.status_rx).await;

    assert!(
        tunnel
            .manager
            .add_forward("t1", remote_forward("r1", server_port, 9))
            .await
    );
    assert!(
        tunnel
            .manager
            .add_forward("t1", echo_forward("f2", added_port))
            .await
    );
    let mut latest = None;
    while let Some(forwards) =
        next_listening_within(&mut tunnel.chans.status_rx, Duration::from_secs(3)).await
    {
        let done = forwards.iter().any(|f| f.forward_id == "f2");
        latest = Some(forwards);
        if done {
            break;
        }
    }
    let latest = latest.expect("the changes must not wait on the server");
    assert_eq!(bound_ids(&latest), [("f1", true), ("f2", true)]);
    // Still starting, so a reloaded frontend sees it as asked for.
    assert_eq!(tunnel.manager.list()[0].forward_ids, ["f1", "r1", "f2"]);
    tunnel.manager.stop_tunnel("t1").await;
}

/* ------------------------------------------------------------------------- *
 * Keyboard-interactive authentication
 * ------------------------------------------------------------------------- */

async fn spawn_kbd_server(scenario: KbdScenario) -> u16 {
    let server = TestServer {
        kbd: Some(scenario),
        ..TestServer::new(TEST_PASSWORD)
    };
    spawn_server(server, server_config(Duration::from_secs(30))).await
}

/// A trusted kbd server, its manager, and a password session started on it.
async fn start_kbd_session(
    dir: &std::path::Path,
    scenario: KbdScenario,
) -> (Arc<SessionManager>, SinkChannels) {
    let port = spawn_kbd_server(scenario).await;
    seed_trusted(dir, port);
    let manager = manager_with(dir, Duration::from_secs(10));
    let (sink, chans) = new_sink();
    spawn_pw_session(&manager, "k1", port, sink);
    (manager, chans)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_saved_password_answers_a_keyboard_interactive_password_question() {
    let dir = tempfile::tempdir().unwrap();
    let (manager, mut chans) = start_kbd_session(dir.path(), KbdScenario::PasswordThroughKbd).await;

    let (status, message) = await_settled(&mut chans.status_rx).await;

    assert_eq!(status, SessionStatus::Connected, "message={message:?}");
    assert!(
        chans.auth_prompt_rx.try_recv().is_err(),
        "the user was asked nothing"
    );
    manager.disconnect("k1").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_auth_prompt_waits_in_the_queue_until_it_is_shown() {
    let dir = tempfile::tempdir().unwrap();
    let port = spawn_kbd_server(KbdScenario::PasswordThenCode).await;
    seed_trusted(dir.path(), port);
    let manager = manager_with(dir.path(), Duration::from_millis(300));
    let (sink, mut chans) = new_sink();
    spawn_pw_session(&manager, "k1", port, sink);
    let prompt = recv_timeout(&mut chans.auth_prompt_rx, Duration::from_secs(10))
        .await
        .expect("an auth_prompt");

    // Queued behind another prompt for longer than the answer time.
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert!(manager.mark_auth_shown(&prompt.prompt_id));
    let answers = Some(Zeroizing::new(vec![TEST_CODE.to_string()]));
    assert!(manager.respond_auth(&prompt.prompt_id, answers));

    let (status, message) = await_settled(&mut chans.status_rx).await;
    assert_eq!(status, SessionStatus::Connected, "message={message:?}");
    manager.disconnect("k1").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_second_factor_is_asked_of_the_user_and_answered() {
    let dir = tempfile::tempdir().unwrap();
    let (manager, mut chans) = start_kbd_session(dir.path(), KbdScenario::PasswordThenCode).await;

    let prompt = recv_timeout(&mut chans.auth_prompt_rx, Duration::from_secs(10))
        .await
        .expect("an auth_prompt");
    assert_eq!(prompt.username, TEST_USER);
    assert_eq!(prompt.fields.len(), 1);
    assert_eq!(prompt.fields[0].label, CODE_QUESTION);
    assert!(!prompt.fields[0].echo);
    let answers = Some(Zeroizing::new(vec![TEST_CODE.to_string()]));
    assert!(manager.respond_auth(&prompt.prompt_id, answers));

    let (status, message) = await_settled(&mut chans.status_rx).await;
    assert_eq!(status, SessionStatus::Connected, "message={message:?}");
    manager.disconnect("k1").await;
}

/// Answer the session's one auth prompt with `answers`, then return the
/// error code the session ended on.
async fn auth_error_after_answering(answers: Option<Vec<String>>) -> &'static str {
    let dir = tempfile::tempdir().unwrap();
    let (manager, mut chans) = start_kbd_session(dir.path(), KbdScenario::PasswordThenCode).await;
    let prompt = recv_timeout(&mut chans.auth_prompt_rx, Duration::from_secs(10))
        .await
        .expect("an auth_prompt");

    manager.respond_auth(&prompt.prompt_id, answers.map(Zeroizing::new));

    let (status, _) = await_settled(&mut chans.status_rx).await;
    assert_eq!(status, SessionStatus::Error);
    recv_timeout(&mut chans.error_code_rx, Duration::from_secs(5))
        .await
        .expect("an error code")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_wrong_second_factor_fails_as_an_auth_error() {
    let code = auth_error_after_answering(Some(vec!["000000".to_string()])).await;
    assert_eq!(code, AppError::SshAuth(String::new()).code());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cancelled_second_factor_fails_as_an_auth_error() {
    let code = auth_error_after_answering(None).await;
    assert_eq!(code, AppError::SshAuth(String::new()).code());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn time_spent_answering_prompts_does_not_count_toward_the_connect_deadline() {
    let dir = tempfile::tempdir().unwrap();
    let port = spawn_kbd_server(KbdScenario::PasswordThenCode).await;
    let quick = Duration::from_millis(200);
    let known_hosts = Arc::new(KnownHostsStore::load(dir.path().to_path_buf()));
    // Overall budget: 200 ms + 1 s + 200 ms; the two answers below take 1.6 s.
    let manager = Arc::new(SessionManager::new(
        known_hosts,
        quick,
        Duration::from_secs(1),
        quick,
    ));
    let (sink, mut chans) = new_sink();
    spawn_pw_session(&manager, "k1", port, sink);
    let slow_user = Duration::from_millis(800);

    let host_key = recv_timeout(&mut chans.prompt_rx, Duration::from_secs(5))
        .await
        .expect("a host_key_prompt");
    tokio::time::sleep(slow_user).await;
    manager.respond_host_key(&host_key.prompt_id, true);
    let code = recv_timeout(&mut chans.auth_prompt_rx, Duration::from_secs(5))
        .await
        .expect("an auth_prompt");
    tokio::time::sleep(slow_user).await;
    manager.respond_auth(
        &code.prompt_id,
        Some(Zeroizing::new(vec![TEST_CODE.to_string()])),
    );

    let (status, message) = await_settled(&mut chans.status_rx).await;
    assert_eq!(status, SessionStatus::Connected, "message={message:?}");
    manager.disconnect("k1").await;
}
