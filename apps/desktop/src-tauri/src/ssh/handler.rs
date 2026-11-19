//! The russh client handler every SSH connection uses: host-key TOFU, agent
//! and X11 forwarding, remote-forward routing, and rejecting channels never asked for.

use std::borrow::Cow;
use std::sync::Arc;
use std::time::Duration;

use russh::client;
use russh::keys::ssh_key::{HashAlg, PublicKey};
use russh::keys::PublicKeyOrCertificate;
use tokio::sync::{watch, OwnedSemaphorePermit, Semaphore};
use tokio::time::timeout;
use uuid::Uuid;

use super::conn_log::{log_disconnect, log_host_key_decision, log_host_key_verdict};
use super::deadline::{ConnectDeadline, DeadlinePause};
use super::interactive_auth::{PromptAsker, AUTH_PROMPT_QUEUE_TIMEOUT};
use super::params::{JumpHop, KeepaliveConfig};
use super::prompts::{ConnectPrompter, ConnectPrompts, HostKeyPromptPayload, PromptClosedNotice};
use crate::known_hosts::{KnownHost, KnownHostsStore, Verdict};
use crate::remote_forward::{serve_forwarded, RemoteRoutes};
use crate::x11::{X11Forward, X11Request};

/// Max forwarded SSH-agent channels served concurrently per session. Agent
/// channels are short-lived (one signing exchange), so a handful is plenty; the
/// cap stops a malicious/compromised target — which agent forwarding inherently
/// trusts — from opening unbounded channels and exhausting tasks / agent
/// connections / file descriptors. Beyond the cap, further agent channels are
/// rejected until an in-flight one finishes.
const MAX_AGENT_CHANNELS: usize = 8;

/// Max forwarded X11 channels served concurrently per session. Each X client
/// (window) holds one for its lifetime, so this is higher than the agent cap;
/// it still bounds what a hostile server can make us open.
const MAX_X11_CHANNELS: usize = 32;

/// russh client handler. The only frontend-facing thing it does is drive the
/// host-key trust prompt; terminal I/O is handled via the `Channel` in the
/// session task, not the handler's data callbacks.
///
/// `pub(crate)` so the tunnel and SFTP layers (`tunnel/`, `sftp/`) can
/// reuse the exact same host-key-TOFU handshake path via
/// [`establish_target`](super::establish::establish_target),
/// rather than duplicating it — the shared-connect-path reuse called out in
/// SPEC §2.
pub(crate) struct SshHandler {
    prompter: Arc<dyn ConnectPrompter>,
    known_hosts: Arc<KnownHostsStore>,
    prompts: Arc<ConnectPrompts>,
    host: String,
    port: u16,
    /// What the connection is for (shell, SFTP…), naming it in the log.
    purpose: Cow<'static, str>,
    prompt_timeout: Duration,
    /// Keepalive applied to this connection's `client::Config` (read in
    /// `establish_over_stream` before the handler is moved into `connect_stream`).
    pub(super) keepalive: KeepaliveConfig,
    /// Accept the server's `auth-agent@openssh.com` forwarding channels and relay
    /// them to the local SSH agent (`ssh -A`). Only the target handler sets this;
    /// the jump-host handler never forwards the agent.
    forward_agent: bool,
    /// Caps concurrently-served forwarded agent channels for this session (see
    /// `MAX_AGENT_CHANNELS`). Shared per handler; a permit is held for the life
    /// of each proxy task.
    agent_channel_limit: Arc<Semaphore>,
    /// X11 forwarding: where the server's `x11` channels go. `None` (tunnels,
    /// SFTP, jump hosts, or forwarding off) rejects every such channel.
    x11: Option<Arc<X11Forward>>,
    x11_channel_limit: Arc<Semaphore>,
    /// Closes when whoever started the handshake gives up on it. russh runs
    /// `check_server_key` on its own task, so dropping the handshake future
    /// alone would leave a host-key prompt waiting out its full timeout.
    owner_gone: watch::Receiver<()>,
    /// The sending half, until taken by `take_owner_token`. Kept here otherwise,
    /// so an untaken token never reads as "gone".
    owner_token: Option<HandshakeOwner>,
    /// A tunnel's remote forwards (`ssh -R`): where the server's
    /// `forwarded-tcpip` channels go. `None` (shells, SFTP, jump hosts) rejects
    /// every such channel.
    remote_routes: Option<Arc<RemoteRoutes>>,
    /// The connect's overall deadline, held still while the user answers a
    /// prompt. Shared with the jump host's handler.
    deadline: Option<Arc<ConnectDeadline>>,
}

/// Held by the code that awaits a handshake: dropping it tells the handler to
/// stop waiting on a pending host-key prompt (treated as a reject).
pub(crate) struct HandshakeOwner(#[allow(dead_code)] watch::Sender<()>);

impl SshHandler {
    /// Construct a handler; built only by `SshConnector::handler`. Agent
    /// forwarding is off unless [`Self::with_agent_forwarding`] turns it on.
    pub(crate) fn new(
        prompter: Arc<dyn ConnectPrompter>,
        known_hosts: Arc<KnownHostsStore>,
        prompts: Arc<ConnectPrompts>,
        host: String,
        port: u16,
        prompt_timeout: Duration,
        keepalive: KeepaliveConfig,
    ) -> Self {
        let (owner_tx, owner_gone) = watch::channel(());
        SshHandler {
            prompter,
            known_hosts,
            prompts,
            host,
            port,
            purpose: Cow::Borrowed("SSH"),
            prompt_timeout,
            keepalive,
            forward_agent: false,
            agent_channel_limit: Arc::new(Semaphore::new(MAX_AGENT_CHANNELS)),
            x11: None,
            x11_channel_limit: Arc::new(Semaphore::new(MAX_X11_CHANNELS)),
            owner_gone,
            owner_token: Some(HandshakeOwner(owner_tx)),
            remote_routes: None,
            deadline: None,
        }
    }

    /// Relay the server's agent channels to the local SSH agent (`ssh -A`).
    pub(crate) fn with_agent_forwarding(mut self, forward_agent: bool) -> Self {
        self.forward_agent = forward_agent;
        self
    }

    /// Name the connection's use in the log.
    pub(crate) fn with_purpose(mut self, purpose: &'static str) -> Self {
        self.purpose = Cow::Borrowed(purpose);
        self
    }

    /// How log lines name this connection, e.g. `SFTP example.com:22`.
    pub(super) fn log_label(&self) -> String {
        format!("{} {}:{}", self.purpose, self.host, self.port)
    }

    /// Hold `deadline` still while this connection waits on the user.
    pub(super) fn with_deadline(mut self, deadline: Arc<ConnectDeadline>) -> Self {
        self.deadline = Some(deadline);
        self
    }

    fn pause_deadline(&self) -> Option<DeadlinePause> {
        self.deadline.as_ref().map(ConnectDeadline::pause)
    }

    /// Route the server's `forwarded-tcpip` channels through `routes`.
    pub(crate) fn with_remote_routes(mut self, routes: Arc<RemoteRoutes>) -> Self {
        self.remote_routes = Some(routes);
        self
    }

    /// Relay the server's `x11` channels through `x11`.
    pub(crate) fn with_x11(mut self, x11: Arc<X11Forward>) -> Self {
        self.x11 = Some(x11);
        self
    }

    /// The `x11-req` to send on the shell channel, when forwarding X11.
    pub(crate) fn x11_request(&self) -> Option<X11Request> {
        self.x11.as_ref().map(|x11| x11.request())
    }

    /// With forwarding off there are no permits to give; with it on, the cap
    /// bounds concurrent agent channels. `try_acquire` never blocks the
    /// session loop.
    fn agent_permit(&self) -> Option<OwnedSemaphorePermit> {
        if !self.forward_agent {
            return None;
        }
        Arc::clone(&self.agent_channel_limit)
            .try_acquire_owned()
            .ok()
    }

    /// A slot for one more X11 channel; when all are taken, the user is
    /// told (once) why the new window won't open.
    fn x11_permit(&self) -> Option<(Arc<X11Forward>, OwnedSemaphorePermit)> {
        let x11 = Arc::clone(self.x11.as_ref()?);
        let permit = Arc::clone(&self.x11_channel_limit).try_acquire_owned();
        let Ok(permit) = permit else {
            x11.warn_channel_limit(MAX_X11_CHANNELS);
            return None;
        };
        Some((x11, permit))
    }

    /// Take the token whose drop abandons this handler's pending host-key
    /// prompt. Hold it for as long as the handshake is wanted.
    pub(crate) fn take_owner_token(&mut self) -> Option<HandshakeOwner> {
        self.owner_token.take()
    }

    /// A handler for the jump host this connection goes through: same prompter,
    /// trust store, prompt registry and keepalive, but the jump host's own
    /// address (its host-key prompt is keyed by it) and never agent forwarding.
    pub(super) fn for_jump_host(&self, jump: &JumpHop) -> SshHandler {
        let handler = SshHandler::new(
            Arc::clone(&self.prompter),
            Arc::clone(&self.known_hosts),
            Arc::clone(&self.prompts),
            jump.host.clone(),
            jump.port,
            self.prompt_timeout,
            self.keepalive,
        );
        SshHandler {
            deadline: self.deadline.clone(),
            purpose: Cow::Owned(format!("{} jump host", self.purpose)),
            ..handler
        }
    }

    /// Who answers this connection's keyboard-interactive questions for
    /// `username`: the user, through the same prompter as host keys.
    pub(super) fn auth_asker(&self, username: &str) -> PromptAsker {
        PromptAsker {
            prompter: Arc::clone(&self.prompter),
            registry: Arc::clone(&self.prompts.auth),
            on_screen: Arc::clone(&self.prompts.auth_on_screen),
            timeout: self.prompt_timeout,
            queue_timeout: AUTH_PROMPT_QUEUE_TIMEOUT.max(self.prompt_timeout),
            host: self.host.clone(),
            port: self.port,
            username: username.to_string(),
            deadline: self.deadline.clone(),
        }
    }

    /// Emit the host-key prompt event and await the user's decision, bounded
    /// by `prompt_timeout`, holding no lock while waiting. The prompt is
    /// registered BEFORE the event is emitted, so a very fast user reply can
    /// never race ahead of the receiver existing. Returns `false` on timeout
    /// or a dropped sender (session torn down mid-prompt) — the registry
    /// entry is removed on every exit path via the `PromptGuard`.
    async fn await_host_key_decision(
        &self,
        key_type: &str,
        fingerprint: &str,
        verdict: Verdict,
    ) -> bool {
        let prompt_id = Uuid::new_v4().to_string();
        let (rx, _guard) = self.prompts.host_keys.register(prompt_id.clone());
        let _paused = self.pause_deadline();
        let _closed_notice =
            PromptClosedNotice::host_key(Arc::clone(&self.prompter), prompt_id.clone());

        self.prompter.on_host_key_prompt(HostKeyPromptPayload {
            prompt_id,
            host: self.host.clone(),
            port: self.port,
            key_type: key_type.to_string(),
            fingerprint: fingerprint.to_string(),
            changed: verdict == Verdict::Changed,
            trust_reset: verdict == Verdict::Unverifiable,
        });

        let mut owner_gone = self.owner_gone.clone();
        tokio::select! {
            decision = timeout(self.prompt_timeout, rx) => match decision {
                Ok(Ok(accept)) => accept,
                Ok(Err(_)) => false, // sender dropped => treat as reject
                Err(_) => false,     // timed out => reject (SPEC §6)
            },
            // The session was abandoned mid-prompt => reject.
            _ = owner_gone.changed() => false,
        }
    }

    /// Persist an accepted host key (TOFU) / overwrite on accepted change.
    /// The write is a blocking `create_dir_all`+`write`+`rename` syscall
    /// sequence, so it runs on `spawn_blocking` rather than directly on this
    /// async handler task (which is driving the SSH transport). A persistence
    /// failure is non-fatal (the user is simply re-prompted next time) and is
    /// only logged — the message never contains secret material.
    async fn persist_trusted_key(&self, key_type: String, fingerprint: String) {
        let known_hosts = Arc::clone(&self.known_hosts);
        let host = self.host.clone();
        let port = self.port;
        let entry = KnownHost {
            key_type,
            fingerprint,
        };
        match tokio::task::spawn_blocking(move || known_hosts.trust(&host, port, entry)).await {
            Ok(Ok(())) => {}
            Ok(Err(err)) => {
                crate::app_log::error(format!("failed to persist trusted host key: {err}"))
            }
            Err(join_err) => {
                crate::app_log::error(format!("host-key persist task failed: {join_err}"))
            }
        }
    }
}

/// The bare host key, which TOFU trusts. A certificate has none to trust: we
/// never advertise certificate algorithms, so one is a misbehaving server.
fn plain_host_key(server_key: &PublicKeyOrCertificate) -> Option<&PublicKey> {
    match server_key {
        PublicKeyOrCertificate::PublicKey { key, .. } => Some(key),
        PublicKeyOrCertificate::Certificate(_) => None,
    }
}

impl client::Handler for SshHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let Some(server_public_key) = plain_host_key(server_key) else {
            return Ok(false);
        };
        let fingerprint = server_public_key.fingerprint(HashAlg::Sha256).to_string();
        let key_type = server_public_key.algorithm().to_string();

        let verdict = self
            .known_hosts
            .verdict(&self.host, self.port, &fingerprint);
        log_host_key_verdict(&self.log_label(), &key_type, &verdict);
        if verdict == Verdict::Known {
            return Ok(true);
        }

        let accepted = self
            .await_host_key_decision(&key_type, &fingerprint, verdict)
            .await;
        log_host_key_decision(&self.log_label(), accepted);

        if accepted {
            self.persist_trusted_key(key_type, fingerprint).await;
        }

        // Ok(false) makes russh abort the handshake with `Error::UnknownKey`,
        // which `establish` maps to `HostKeyRejected`.
        Ok(accepted)
    }

    /// Logs why the connection ended, then keeps russh's default outcome.
    async fn disconnected(
        &mut self,
        reason: client::DisconnectReason<Self::Error>,
    ) -> Result<(), Self::Error> {
        log_disconnect(&self.log_label(), &reason);
        match reason {
            client::DisconnectReason::ReceivedDisconnect(_) => Ok(()),
            client::DisconnectReason::Error(err) => Err(err),
        }
    }

    /// The server opened an `auth-agent@openssh.com` channel (a program on the
    /// remote wants to use our keys). When agent forwarding is enabled for this
    /// session, accept it and relay it verbatim to the local SSH agent on a
    /// detached task; otherwise reject it (dropping `reply`). russh only opens
    /// these at all when we requested forwarding on the session channel (see
    /// `run_shell`), so the reject is a defensive guard.
    async fn server_channel_open_agent_forward(
        &mut self,
        channel: russh::Channel<client::Msg>,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let Some(permit) = self.agent_permit() else {
            drop(reply);
            return Ok(());
        };
        tokio::spawn(async move {
            let _permit = permit;
            reply.accept().await;
            crate::agent::proxy_agent_channel(channel.into_stream()).await;
        });
        Ok(())
    }

    /// A connection to one of a tunnel's remote forwards (`ssh -R`); one for a
    /// port no forward asked for is rejected.
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<client::Msg>,
        _connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        match &self.remote_routes {
            Some(routes) => serve_forwarded(routes, channel, connected_port, reply),
            None => drop(reply),
        }
        Ok(())
    }

    /// A remote X client connecting back (X11 forwarding on): relayed to the
    /// local X server once it shows the fake cookie. Rejected when forwarding
    /// is off or the channel cap is reached.
    async fn server_channel_open_x11(
        &mut self,
        channel: russh::Channel<client::Msg>,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let Some((x11, permit)) = self.x11_permit() else {
            drop(reply);
            return Ok(());
        };
        tokio::spawn(async move {
            let _permit = permit;
            reply.accept().await;
            x11.serve(channel.into_stream()).await;
        });
        Ok(())
    }

    // The channel types below are ones we never ask a server for; russh
    // accepts them by default, which would let a server park channels (and
    // their buffers) on us. Dropping `reply` rejects.

    async fn server_channel_open_session(
        &mut self,
        _channel: russh::Channel<client::Msg>,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        drop(reply);
        Ok(())
    }

    async fn server_channel_open_direct_tcpip(
        &mut self,
        _channel: russh::Channel<client::Msg>,
        _host_to_connect: &str,
        _port_to_connect: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        drop(reply);
        Ok(())
    }

    async fn server_channel_open_direct_streamlocal(
        &mut self,
        _channel: russh::Channel<client::Msg>,
        _socket_path: &str,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        drop(reply);
        Ok(())
    }

    async fn server_channel_open_forwarded_streamlocal(
        &mut self,
        _channel: russh::Channel<client::Msg>,
        _socket_path: &str,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        drop(reply);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssh::prompts::{AuthPromptPayload, HostKeyPromptPayload};

    struct SilentPrompter;

    impl ConnectPrompter for SilentPrompter {
        fn on_host_key_prompt(&self, _payload: HostKeyPromptPayload) {}
        fn on_auth_prompt(&self, _payload: AuthPromptPayload) {}
    }

    fn handler() -> SshHandler {
        let dir = tempfile::tempdir().unwrap();
        SshHandler::new(
            Arc::new(SilentPrompter),
            Arc::new(KnownHostsStore::load(dir.path().to_path_buf())),
            Arc::new(ConnectPrompts::default()),
            "host".to_string(),
            22,
            Duration::from_secs(1),
            KeepaliveConfig::disabled(),
        )
    }

    #[test]
    fn the_log_label_names_the_purpose_and_address() {
        assert_eq!(handler().log_label(), "SSH host:22");
        assert_eq!(handler().with_purpose("SFTP").log_label(), "SFTP host:22");
    }

    #[test]
    fn a_jump_host_is_named_as_such_in_the_log() {
        let jump = JumpHop {
            host: "bastion".to_string(),
            port: 2222,
            username: "u".to_string(),
            creds: crate::ssh::params::AuthCredentials::Agent {
                fingerprint: "SHA256:x".to_string(),
            },
        };
        let label = handler()
            .with_purpose("shell")
            .for_jump_host(&jump)
            .log_label();
        assert_eq!(label, "shell jump host bastion:2222");
    }

    #[test]
    fn a_new_handler_never_forwards_the_agent() {
        assert!(!handler().forward_agent);
    }

    #[test]
    fn agent_forwarding_is_on_only_when_asked() {
        assert!(handler().with_agent_forwarding(true).forward_agent);
        assert!(!handler().with_agent_forwarding(false).forward_agent);
    }

    #[test]
    fn no_agent_channel_is_served_with_forwarding_off() {
        assert!(handler().agent_permit().is_none());
    }

    #[test]
    fn agent_channels_are_served_up_to_the_cap() {
        let handler = handler().with_agent_forwarding(true);
        let held: Vec<_> = (0..MAX_AGENT_CHANNELS)
            .filter_map(|_| handler.agent_permit())
            .collect();
        assert_eq!(held.len(), MAX_AGENT_CHANNELS);
        assert!(handler.agent_permit().is_none());
    }

    const HOST_KEY: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";

    #[test]
    fn a_bare_host_key_is_checked_by_tofu() {
        let key = PublicKey::from_openssh(HOST_KEY).unwrap();
        let offered = PublicKeyOrCertificate::from(key.clone());
        assert_eq!(plain_host_key(&offered), Some(&key));
    }

    const HOST_CERT: &str = "ssh-ed25519-cert-v01@openssh.com AAAAIHNzaC1lZDI1NTE5LWNlcnQtdjAxQG9wZW5zc2guY29tAAAAICDhrqWGy8coDgHxuqZuv42bUrabG8mL9f+NcFBblxV9AAAAIOxLWoPHpcV5MO+sU2Se8UV1rW9XHTi7dR/YemcPPK8aAAAAAAAAAAAAAAACAAAABHRlc3QAAAAIAAAABGhvc3QAAAAAAAAAAP//////////AAAAAAAAAAAAAAAAAAAAMwAAAAtzc2gtZWQyNTUxOQAAACBTKm8iWhy3N5wFcMp/eI+wacwkgGzqNwMS6mA9hoK6XwAAAFMAAAALc3NoLWVkMjU1MTkAAABAGRp2L2eT+L8l2wfrnEx2yYBabHXTtdnxmneeCuIM7uwdW6yhcUbv8cSHYsP4nph2NYPDQJuP20kAk0AISAWuBA==";

    #[test]
    fn a_host_certificate_is_never_trusted() {
        let cert = russh::keys::Certificate::from_openssh(HOST_CERT).unwrap();
        assert!(plain_host_key(&PublicKeyOrCertificate::from(cert)).is_none());
    }
}
