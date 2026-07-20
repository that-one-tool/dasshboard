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
//! The whole module is gated behind `#[cfg(test)]` at its declaration in
//! `lib.rs`.

use std::sync::Arc;
use std::time::Duration;

use russh::keys::{HashAlg, PrivateKey};
use russh::server::{self, Auth, Msg, Server as _, Session};
use russh::{Channel, ChannelId};
use tokio::net::TcpListener;
use tokio::sync::mpsc;

use crate::error::AppError;
use crate::known_hosts::{KnownHost, KnownHostsStore};
use crate::session::{
    AuthCredentials, HostKeyPromptPayload, SessionManager, SessionSink, SessionStatus,
};

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
}

impl server::Server for TestServer {
    type Handler = TestServerHandler;
    fn new_client(&mut self, _peer: Option<std::net::SocketAddr>) -> TestServerHandler {
        TestServerHandler {
            password: self.password.clone(),
        }
    }
}

struct TestServerHandler {
    password: String,
}

impl server::Handler for TestServerHandler {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        if user == TEST_USER && password == self.password {
            Ok(Auth::Accept)
        } else {
            Ok(Auth::reject())
        }
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
        Ok(())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        // Echo the bytes straight back so the client-side PTY echo test can read
        // what it wrote (a real shell would do this via the tty).
        session.data(channel, data.to_vec())?;
        Ok(())
    }
}

/// Bind an ephemeral local port and run the test server on it forever (until
/// the test process exits). Returns the chosen port.
async fn spawn_test_server(password: &str) -> u16 {
    let host_key = PrivateKey::from_openssh(TEST_HOST_KEY).expect("valid test host key");
    let config = Arc::new(server::Config {
        keys: vec![host_key],
        // Keep wrong-password rejections snappy in tests.
        auth_rejection_time: Duration::from_millis(10),
        auth_rejection_time_initial: Some(Duration::ZERO),
        inactivity_timeout: Some(Duration::from_secs(30)),
        ..Default::default()
    });

    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("bind test server");
    let port = listener.local_addr().expect("local addr").port();

    let password = password.to_string();
    tokio::spawn(async move {
        let mut server = TestServer { password };
        // `run_on_socket` owns the accept loop and drives each session.
        let _ = server.run_on_socket(config, &listener).await;
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
}

impl SessionSink for TestSink {
    fn on_data(&self, bytes: &[u8]) {
        let _ = self.data_tx.send(bytes.to_vec());
    }
    fn on_status(&self, status: SessionStatus, message: Option<String>) {
        let _ = self.status_tx.send((status, message));
    }
    fn on_host_key_prompt(&self, payload: HostKeyPromptPayload) {
        let _ = self.prompt_tx.send(payload);
    }
}

struct SinkChannels {
    data_rx: mpsc::UnboundedReceiver<Vec<u8>>,
    status_rx: mpsc::UnboundedReceiver<(SessionStatus, Option<String>)>,
    prompt_rx: mpsc::UnboundedReceiver<HostKeyPromptPayload>,
}

fn new_sink() -> (Arc<dyn SessionSink>, SinkChannels) {
    let (data_tx, data_rx) = mpsc::unbounded_channel();
    let (status_tx, status_rx) = mpsc::unbounded_channel();
    let (prompt_tx, prompt_rx) = mpsc::unbounded_channel();
    let sink: Arc<dyn SessionSink> = Arc::new(TestSink {
        data_tx,
        status_tx,
        prompt_tx,
    });
    (
        sink,
        SinkChannels {
            data_rx,
            status_rx,
            prompt_rx,
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
    ))
}

fn password_creds() -> AuthCredentials {
    AuthCredentials::Password(TEST_PASSWORD.to_string())
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
    ));

    // Bind then drop a listener to obtain a port that is (almost certainly) closed.
    let port = {
        let l = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        l.local_addr().unwrap().port()
    };

    let (sink, _chans) = new_sink();
    let result = manager
        .test_connection(
            "127.0.0.1".to_string(),
            port,
            TEST_USER.to_string(),
            password_creds(),
            sink,
        )
        .await;

    assert!(
        matches!(result, Err(AppError::SshConnect(_))),
        "expected SshConnect, got {result:?}"
    );
}

/* ------------------------------------------------------------------------- *
 * Live session — PTY echo + cleanup
 * ------------------------------------------------------------------------- */

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn echo_through_pty_and_clean_disconnect() {
    let dir = tempfile::tempdir().unwrap();
    let port = spawn_test_server(TEST_PASSWORD).await;
    seed_trusted(dir.path(), port);
    let manager = manager_with(dir.path(), Duration::from_secs(60));

    let (sink, mut chans) = new_sink();
    manager.spawn_session(
        "s1".to_string(),
        "127.0.0.1".to_string(),
        port,
        TEST_USER.to_string(),
        password_creds(),
        80,
        24,
        sink,
    );

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
    manager.spawn_session(
        "s1".to_string(),
        "127.0.0.1".to_string(),
        port,
        TEST_USER.to_string(),
        password_creds(),
        80,
        24,
        sink,
    );

    // First contact ⇒ prompt with changed:false.
    let prompt = recv_timeout(&mut chans.prompt_rx, Duration::from_secs(10))
        .await
        .expect("a host_key_prompt");
    assert!(!prompt.changed, "first contact must be changed:false");
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
    manager.spawn_session(
        "s1".to_string(),
        "127.0.0.1".to_string(),
        port,
        TEST_USER.to_string(),
        password_creds(),
        80,
        24,
        sink,
    );

    let prompt = recv_timeout(&mut chans.prompt_rx, Duration::from_secs(10))
        .await
        .expect("a host_key_prompt");
    manager.respond_host_key(&prompt.prompt_id, false);

    let (status, _message) = await_settled(&mut chans.status_rx).await;
    assert_eq!(status, SessionStatus::Error);
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
    manager.spawn_session(
        "s1".to_string(),
        "127.0.0.1".to_string(),
        port,
        TEST_USER.to_string(),
        password_creds(),
        80,
        24,
        sink,
    );

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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn host_key_prompt_timeout_rejects() {
    let dir = tempfile::tempdir().unwrap();
    // Inject a very short prompt timeout so we don't wait 60s.
    let manager = manager_with(dir.path(), Duration::from_millis(200));
    let port = spawn_test_server(TEST_PASSWORD).await;

    let (sink, mut chans) = new_sink();
    manager.spawn_session(
        "s1".to_string(),
        "127.0.0.1".to_string(),
        port,
        TEST_USER.to_string(),
        password_creds(),
        80,
        24,
        sink,
    );

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
        manager.spawn_session(
            format!("s{i}"),
            "127.0.0.1".to_string(),
            port,
            TEST_USER.to_string(),
            password_creds(),
            80,
            24,
            sink,
        );
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

/// Finding 4 (regression): disconnect while a host-key prompt is still pending —
/// the most deadlock-prone path. With a long (60 s) prompt timeout so a hang
/// would be unmistakable, we spawn a session, wait for the prompt, then
/// `disconnect()` WITHOUT ever responding. The biased `select!` in `run_session`
/// must abort the handshake promptly (dropping the `establish` future, whose
/// `PromptGuard` cleans the registry) and the task must remove its own map
/// entry — i.e. the session settles well under the prompt timeout and
/// `session_count()` returns to 0.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn disconnect_while_host_key_prompt_pending_cleans_up() {
    let dir = tempfile::tempdir().unwrap();
    let manager = manager_with(dir.path(), Duration::from_secs(60));
    let port = spawn_test_server(TEST_PASSWORD).await;

    let (sink, mut chans) = new_sink();
    manager.spawn_session(
        "s1".to_string(),
        "127.0.0.1".to_string(),
        port,
        TEST_USER.to_string(),
        password_creds(),
        80,
        24,
        sink,
    );

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
        manager.spawn_session(
            format!("s{i}"),
            "127.0.0.1".to_string(),
            port,
            TEST_USER.to_string(),
            password_creds(),
            80,
            24,
            sink,
        );
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
        manager.spawn_session(
            sid.clone(),
            "127.0.0.1".to_string(),
            port,
            TEST_USER.to_string(),
            password_creds(),
            80,
            24,
            sink,
        );
        manager.disconnect(&sid).await;
    }

    // Round B — out-of-order churn: spawn a batch all at once, keep the sinks
    // alive, then disconnect them in reverse order (not spawn order).
    let mut batch = Vec::new();
    for _ in 0..12 {
        let (sink, chans) = new_sink();
        let sid = next_id();
        manager.spawn_session(
            sid.clone(),
            "127.0.0.1".to_string(),
            port,
            TEST_USER.to_string(),
            password_creds(),
            80,
            24,
            sink,
        );
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
        manager.spawn_session(
            sid.clone(),
            "127.0.0.1".to_string(),
            port,
            TEST_USER.to_string(),
            password_creds(),
            80,
            24,
            sink,
        );
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
