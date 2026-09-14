//! SFTP integration tests (closes the SPEC §9 / roadmap gap: `SftpManager` was
//! previously covered only by unit + DOM tests).
//!
//! Like `ssh_it.rs`, these run entirely in-process: a minimal `russh` **server**
//! that accepts the `sftp` subsystem and serves it from an in-memory filesystem
//! via `russh_sftp::server`. The real client stack — `SftpManager`, which reuses
//! `session.rs`'s connect + auth + host-key-TOFU path, then `russh_sftp`'s client
//! over the channel — is driven end to end: connect, list, upload, download,
//! mkdir, rename, and remove all round-trip over a real SSH channel with no
//! Docker and no external SFTP daemon.

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use russh::keys::{HashAlg, PrivateKey};
use russh::server::{self, Auth, Msg, Server as _, Session};
use russh::{Channel, ChannelId};
use russh_sftp::protocol::{
    File, FileAttributes, Handle, Name, OpenFlags, Status, StatusCode, Version,
};
use tokio::net::TcpListener;
use tokio::sync::Mutex as TokioMutex;

use dasshboard_lib::known_hosts::{KnownHost, KnownHostsStore};
use dasshboard_lib::session::AuthCredentials;
use dasshboard_lib::sftp::{SftpManager, SftpParams, SftpSink};

const TEST_USER: &str = "tester";
const TEST_PASSWORD: &str = "correct-horse";

/// Throwaway ed25519 host key for the in-process test server (same fixture as
/// `ssh_it.rs`). Guards nothing real; only gives the server an identity so the
/// host-key path runs.
const TEST_HOST_KEY: &str = "-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACBRJ4iDGzJs43jMYshJeoVYmLVyzKFUnuLM0lqnhikkMAAAAJhcQzNPXEMz
TwAAAAtzc2gtZWQyNTUxOQAAACBRJ4iDGzJs43jMYshJeoVYmLVyzKFUnuLM0lqnhikkMA
AAAEBJ+yZPhKmtZJdowQFduvg+YkS2ChSegtIL5qTB3NLAL1EniIMbMmzjeMxiyEl6hViY
tXLMoVSe4szSWqeGKSQwAAAAFGRhc3NoYm9hcmQtdGVzdC1ob3N0AQ==
-----END OPENSSH PRIVATE KEY-----
";

/* ------------------------------------------------------------------------- *
 * In-memory filesystem shared by one connection's SFTP handler
 * ------------------------------------------------------------------------- */

#[derive(Default)]
struct FsState {
    /// Absolute, normalized directory paths (always contains "/").
    dirs: HashSet<String>,
    /// Absolute file path → contents.
    files: HashMap<String, Vec<u8>>,
}

#[derive(Clone)]
struct MemFs(Arc<StdMutex<FsState>>);

impl MemFs {
    fn new() -> Self {
        let mut state = FsState::default();
        state.dirs.insert("/".to_string());
        MemFs(Arc::new(StdMutex::new(state)))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, FsState> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// Normalize an absolute-ish path: ensure a leading '/', drop any trailing '/'
/// (except the root itself), and collapse an empty string to "/".
fn norm(path: &str) -> String {
    let p = path.trim();
    if p.is_empty() || p == "." {
        return "/".to_string();
    }
    let with_root = if p.starts_with('/') {
        p.to_string()
    } else {
        format!("/{p}")
    };
    let trimmed = with_root.trim_end_matches('/');
    if trimmed.is_empty() {
        "/".to_string()
    } else {
        trimmed.to_string()
    }
}

/// The parent directory of an absolute path ("/a/b" → "/a", "/a" → "/").
fn parent_of(path: &str) -> String {
    match path.rfind('/') {
        Some(0) | None => "/".to_string(),
        Some(idx) => path[..idx].to_string(),
    }
}

/// The base name of an absolute path ("/a/b" → "b").
fn base_name(path: &str) -> String {
    match path.rfind('/') {
        Some(idx) => path[idx + 1..].to_string(),
        None => path.to_string(),
    }
}

fn file_attrs(size: u64) -> FileAttributes {
    let mut a = FileAttributes {
        size: Some(size),
        ..Default::default()
    };
    a.set_regular(true);
    a
}

fn dir_attrs() -> FileAttributes {
    let mut a = FileAttributes::default();
    a.set_dir(true);
    a
}

/* ------------------------------------------------------------------------- *
 * SFTP subsystem handler (russh_sftp server) over the in-memory FS
 * ------------------------------------------------------------------------- */

struct DirCursor {
    files: Vec<File>,
    sent: bool,
}

struct SftpFsHandler {
    fs: MemFs,
    version_seen: bool,
    next_handle: u64,
    dir_handles: HashMap<String, DirCursor>,
    file_handles: HashMap<String, String>,
}

impl SftpFsHandler {
    fn new(fs: MemFs) -> Self {
        Self {
            fs,
            version_seen: false,
            next_handle: 0,
            dir_handles: HashMap::new(),
            file_handles: HashMap::new(),
        }
    }

    fn fresh_handle(&mut self) -> String {
        let h = format!("h{}", self.next_handle);
        self.next_handle += 1;
        h
    }

    fn ok(id: u32) -> Status {
        Status {
            id,
            status_code: StatusCode::Ok,
            error_message: "Ok".to_string(),
            language_tag: "en-US".to_string(),
        }
    }
}

impl russh_sftp::server::Handler for SftpFsHandler {
    type Error = StatusCode;

    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }

    async fn init(
        &mut self,
        _version: u32,
        _extensions: HashMap<String, String>,
    ) -> Result<Version, Self::Error> {
        if self.version_seen {
            return Err(StatusCode::ConnectionLost);
        }
        self.version_seen = true;
        Ok(Version::new())
    }

    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
        // The client canonicalizes "." to the home dir at connect; everything
        // else is echoed back normalized.
        Ok(Name {
            id,
            files: vec![File::dummy(norm(&path))],
        })
    }

    async fn stat(
        &mut self,
        id: u32,
        path: String,
    ) -> Result<russh_sftp::protocol::Attrs, Self::Error> {
        self.lstat(id, path).await
    }

    async fn lstat(
        &mut self,
        id: u32,
        path: String,
    ) -> Result<russh_sftp::protocol::Attrs, Self::Error> {
        let path = norm(&path);
        let fs = self.fs.lock();
        if fs.dirs.contains(&path) {
            Ok(russh_sftp::protocol::Attrs {
                id,
                attrs: dir_attrs(),
            })
        } else if let Some(bytes) = fs.files.get(&path) {
            Ok(russh_sftp::protocol::Attrs {
                id,
                attrs: file_attrs(bytes.len() as u64),
            })
        } else {
            Err(StatusCode::NoSuchFile)
        }
    }

    async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, Self::Error> {
        let path = norm(&path);
        let files = {
            let fs = self.fs.lock();
            if !fs.dirs.contains(&path) {
                return Err(StatusCode::NoSuchFile);
            }
            let mut files = Vec::new();
            for dir in &fs.dirs {
                if dir != &path && parent_of(dir) == path {
                    files.push(File::new(base_name(dir), dir_attrs()));
                }
            }
            for (file, bytes) in &fs.files {
                if parent_of(file) == path {
                    files.push(File::new(base_name(file), file_attrs(bytes.len() as u64)));
                }
            }
            files
        };
        let handle = self.fresh_handle();
        self.dir_handles
            .insert(handle.clone(), DirCursor { files, sent: false });
        Ok(Handle { id, handle })
    }

    async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, Self::Error> {
        let cursor = self
            .dir_handles
            .get_mut(&handle)
            .ok_or(StatusCode::Failure)?;
        if cursor.sent {
            return Err(StatusCode::Eof);
        }
        cursor.sent = true;
        Ok(Name {
            id,
            files: cursor.files.clone(),
        })
    }

    async fn open(
        &mut self,
        id: u32,
        filename: String,
        pflags: OpenFlags,
        _attrs: FileAttributes,
    ) -> Result<Handle, Self::Error> {
        let path = norm(&filename);
        let creating = pflags.contains(OpenFlags::CREATE) || pflags.contains(OpenFlags::WRITE);
        {
            let mut fs = self.fs.lock();
            if creating {
                // create/truncate
                fs.files.insert(path.clone(), Vec::new());
            } else if !fs.files.contains_key(&path) {
                return Err(StatusCode::NoSuchFile);
            }
        }
        let handle = self.fresh_handle();
        self.file_handles.insert(handle.clone(), path);
        Ok(Handle { id, handle })
    }

    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<russh_sftp::protocol::Data, Self::Error> {
        let path = self.file_handles.get(&handle).ok_or(StatusCode::Failure)?;
        let fs = self.fs.lock();
        let bytes = fs.files.get(path).ok_or(StatusCode::NoSuchFile)?;
        let start = offset as usize;
        if start >= bytes.len() {
            return Err(StatusCode::Eof);
        }
        let end = (start + len as usize).min(bytes.len());
        Ok(russh_sftp::protocol::Data {
            id,
            data: bytes[start..end].to_vec(),
        })
    }

    async fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<Status, Self::Error> {
        let path = self
            .file_handles
            .get(&handle)
            .ok_or(StatusCode::Failure)?
            .clone();
        let mut fs = self.fs.lock();
        let bytes = fs.files.entry(path).or_default();
        let start = offset as usize;
        if bytes.len() < start + data.len() {
            bytes.resize(start + data.len(), 0);
        }
        bytes[start..start + data.len()].copy_from_slice(&data);
        Ok(Self::ok(id))
    }

    async fn close(&mut self, id: u32, handle: String) -> Result<Status, Self::Error> {
        self.dir_handles.remove(&handle);
        self.file_handles.remove(&handle);
        Ok(Self::ok(id))
    }

    async fn mkdir(
        &mut self,
        id: u32,
        path: String,
        _attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        self.fs.lock().dirs.insert(norm(&path));
        Ok(Self::ok(id))
    }

    async fn rmdir(&mut self, id: u32, path: String) -> Result<Status, Self::Error> {
        let path = norm(&path);
        let mut fs = self.fs.lock();
        // Refuse to remove a non-empty directory (mirrors a real server).
        let has_child = fs.dirs.iter().any(|d| d != &path && parent_of(d) == path)
            || fs.files.keys().any(|f| parent_of(f) == path);
        if has_child {
            return Err(StatusCode::Failure);
        }
        fs.dirs.remove(&path);
        Ok(Self::ok(id))
    }

    async fn remove(&mut self, id: u32, filename: String) -> Result<Status, Self::Error> {
        let path = norm(&filename);
        if self.fs.lock().files.remove(&path).is_none() {
            return Err(StatusCode::NoSuchFile);
        }
        Ok(Self::ok(id))
    }

    async fn rename(
        &mut self,
        id: u32,
        oldpath: String,
        newpath: String,
    ) -> Result<Status, Self::Error> {
        let (from, to) = (norm(&oldpath), norm(&newpath));
        let mut fs = self.fs.lock();
        if let Some(bytes) = fs.files.remove(&from) {
            fs.files.insert(to, bytes);
            Ok(Self::ok(id))
        } else if fs.dirs.remove(&from) {
            fs.dirs.insert(to);
            Ok(Self::ok(id))
        } else {
            Err(StatusCode::NoSuchFile)
        }
    }
}

/* ------------------------------------------------------------------------- *
 * In-process SSH server that serves the sftp subsystem from a MemFs
 * ------------------------------------------------------------------------- */

#[derive(Clone)]
struct SftpTestServer {
    fs: MemFs,
}

impl server::Server for SftpTestServer {
    type Handler = SftpServerHandler;
    fn new_client(&mut self, _peer: Option<SocketAddr>) -> SftpServerHandler {
        SftpServerHandler {
            fs: self.fs.clone(),
            channels: Arc::new(TokioMutex::new(HashMap::new())),
        }
    }
}

struct SftpServerHandler {
    fs: MemFs,
    channels: Arc<TokioMutex<HashMap<ChannelId, Channel<Msg>>>>,
}

impl server::Handler for SftpServerHandler {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        if user == TEST_USER && password == TEST_PASSWORD {
            Ok(Auth::Accept)
        } else {
            Ok(Auth::reject())
        }
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        reply: server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.channels.lock().await.insert(channel.id(), channel);
        reply.accept().await;
        Ok(())
    }

    async fn subsystem_request(
        &mut self,
        channel_id: ChannelId,
        name: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if name == "sftp" {
            let channel = self.channels.lock().await.remove(&channel_id);
            if let Some(channel) = channel {
                session.channel_success(channel_id)?;
                russh_sftp::server::run(channel.into_stream(), SftpFsHandler::new(self.fs.clone()))
                    .await;
            } else {
                session.channel_failure(channel_id)?;
            }
        } else {
            session.channel_failure(channel_id)?;
        }
        Ok(())
    }
}

/// Bind an ephemeral port, run the SFTP-capable server on it, and return the
/// port plus the server host key's SHA256 fingerprint (to pre-trust it).
async fn spawn_sftp_server() -> (u16, String) {
    let host_key = PrivateKey::from_openssh(TEST_HOST_KEY).expect("valid test host key");
    let fingerprint = host_key
        .public_key()
        .fingerprint(HashAlg::Sha256)
        .to_string();

    let config = Arc::new(server::Config {
        keys: vec![host_key],
        auth_rejection_time: Duration::from_millis(10),
        auth_rejection_time_initial: Some(Duration::ZERO),
        inactivity_timeout: Some(Duration::from_secs(30)),
        ..Default::default()
    });

    let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
    let port = listener.local_addr().expect("addr").port();

    tokio::spawn(async move {
        let mut server = SftpTestServer { fs: MemFs::new() };
        let _ = server.run_on_socket(config, &listener).await;
    });

    (port, fingerprint)
}

/* ------------------------------------------------------------------------- *
 * Test scaffolding: a no-op sink + a pre-trusted manager
 * ------------------------------------------------------------------------- */

struct NoopSftpSink;
impl SftpSink for NoopSftpSink {
    fn on_host_key_prompt(&self, _payload: HostKeyPromptPayload) {}
}

// Bring the payload type into scope for the sink impl above.
use dasshboard_lib::session::HostKeyPromptPayload;

fn manager_with_trust(dir: &std::path::Path, port: u16, fingerprint: &str) -> SftpManager {
    let known_hosts = KnownHostsStore::load(dir.to_path_buf());
    known_hosts
        .trust(
            "127.0.0.1",
            port,
            KnownHost {
                key_type: "ssh-ed25519".to_string(),
                fingerprint: fingerprint.to_string(),
            },
        )
        .expect("seed trusted host key");
    SftpManager::new(
        Arc::new(known_hosts),
        Duration::from_secs(10),
        Duration::from_secs(60),
        Duration::from_secs(10),
    )
}

async fn connect(manager: &SftpManager, device_id: &str, port: u16) -> String {
    manager
        .connect(
            SftpParams {
                device_id: device_id.to_string(),
                host: "127.0.0.1".to_string(),
                port,
                username: TEST_USER.to_string(),
                creds: AuthCredentials::Password(TEST_PASSWORD.to_string()),
            },
            Arc::new(NoopSftpSink),
        )
        .await
        .expect("SFTP connect")
}

fn noop_progress() -> Box<dyn Fn(u64, u64) + Send + Sync> {
    Box::new(|_, _| {})
}

/* ------------------------------------------------------------------------- *
 * Tests
 * ------------------------------------------------------------------------- */

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn connect_resolves_home_and_lists_empty_root() {
    let dir = tempfile::tempdir().unwrap();
    let (port, fp) = spawn_sftp_server().await;
    let manager = manager_with_trust(dir.path(), port, &fp);

    let start = connect(&manager, "dev-1", port).await;
    assert_eq!(
        start, "/",
        "connect resolves the home directory via realpath(\".\")"
    );
    assert_eq!(manager.connection_count(), 1);

    let entries = manager.list("dev-1", "/").await.unwrap();
    assert!(entries.is_empty(), "a fresh in-memory root is empty");

    manager.disconnect("dev-1").await;
    assert_eq!(manager.connection_count(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn upload_list_download_round_trips_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let (port, fp) = spawn_sftp_server().await;
    let manager = manager_with_trust(dir.path(), port, &fp);
    connect(&manager, "dev-1", port).await;

    // Upload a file into a new subdirectory, then see it in a listing.
    manager.mkdir("dev-1", "/data").await.unwrap();
    let payload = b"hello sftp integration \xE2\x9C\x93".to_vec(); // includes a multibyte char
    manager
        .write_file("dev-1", "/data/hello.txt", &payload, &noop_progress())
        .await
        .unwrap();

    let entries = manager.list("dev-1", "/data").await.unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].name, "hello.txt");
    assert_eq!(entries[0].kind, "file");
    assert_eq!(entries[0].size, payload.len() as u64);

    // Download it back and verify the bytes survived the round trip.
    let got = manager
        .read_file("dev-1", "/data/hello.txt", &noop_progress())
        .await
        .unwrap();
    assert_eq!(got, payload);

    manager.disconnect("dev-1").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn list_sorts_dirs_first_then_case_insensitive() {
    let dir = tempfile::tempdir().unwrap();
    let (port, fp) = spawn_sftp_server().await;
    let manager = manager_with_trust(dir.path(), port, &fp);
    connect(&manager, "dev-1", port).await;

    manager.mkdir("dev-1", "/Zeta").await.unwrap();
    manager.mkdir("dev-1", "/alpha").await.unwrap();
    manager
        .write_file("dev-1", "/Banana.txt", b"x", &noop_progress())
        .await
        .unwrap();
    manager
        .write_file("dev-1", "/apple.txt", b"y", &noop_progress())
        .await
        .unwrap();

    let names: Vec<String> = manager
        .list("dev-1", "/")
        .await
        .unwrap()
        .into_iter()
        .map(|e| e.name)
        .collect();
    // Directories first (case-insensitive), then files (case-insensitive).
    assert_eq!(names, vec!["alpha", "Zeta", "apple.txt", "Banana.txt"]);

    manager.disconnect("dev-1").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mkdir_rename_and_remove_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let (port, fp) = spawn_sftp_server().await;
    let manager = manager_with_trust(dir.path(), port, &fp);
    connect(&manager, "dev-1", port).await;

    // Create a file, rename it, then remove it.
    manager
        .write_file("dev-1", "/note.txt", b"data", &noop_progress())
        .await
        .unwrap();
    manager
        .rename("dev-1", "/note.txt", "/renamed.txt")
        .await
        .unwrap();

    let names: Vec<String> = manager
        .list("dev-1", "/")
        .await
        .unwrap()
        .into_iter()
        .map(|e| e.name)
        .collect();
    assert_eq!(names, vec!["renamed.txt"]);

    manager.remove_file("dev-1", "/renamed.txt").await.unwrap();
    assert!(manager.list("dev-1", "/").await.unwrap().is_empty());

    // Directory create + remove.
    manager.mkdir("dev-1", "/tmpdir").await.unwrap();
    assert_eq!(manager.list("dev-1", "/").await.unwrap().len(), 1);
    manager.remove_dir("dev-1", "/tmpdir").await.unwrap();
    assert!(manager.list("dev-1", "/").await.unwrap().is_empty());

    manager.disconnect("dev-1").await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reading_a_missing_file_is_an_sftp_error() {
    let dir = tempfile::tempdir().unwrap();
    let (port, fp) = spawn_sftp_server().await;
    let manager = manager_with_trust(dir.path(), port, &fp);
    connect(&manager, "dev-1", port).await;

    let err = manager
        .read_file("dev-1", "/nope.txt", &noop_progress())
        .await
        .unwrap_err();
    assert!(
        matches!(err, AppError::Sftp(_)),
        "expected an Sftp error, got {err:?}"
    );

    manager.disconnect("dev-1").await;
}

use dasshboard_lib::error::AppError;
