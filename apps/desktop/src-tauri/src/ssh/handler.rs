//! The russh client handler every SSH connection uses: host-key TOFU, agent
//! forwarding, remote-forward routing, and rejecting channels never asked for.

use std::sync::Arc;
use std::time::Duration;

use russh::client;
use russh::keys::ssh_key::{HashAlg, PublicKey};
use tokio::sync::{watch, Semaphore};
use tokio::time::timeout;
use uuid::Uuid;

use super::params::{JumpHop, KeepaliveConfig};
use super::prompts::{HostKeyPromptPayload, HostKeyPrompter, PromptClosedNotice, PromptRegistry};
use crate::known_hosts::{KnownHost, KnownHostsStore, Verdict};
use crate::remote_forward::{serve_forwarded, RemoteRoutes};

/// Max forwarded SSH-agent channels served concurrently per session. Agent
/// channels are short-lived (one signing exchange), so a handful is plenty; the
/// cap stops a malicious/compromised target — which agent forwarding inherently
/// trusts — from opening unbounded channels and exhausting tasks / agent
/// connections / file descriptors. Beyond the cap, further agent channels are
/// rejected until an in-flight one finishes.
const MAX_AGENT_CHANNELS: usize = 8;

/// russh client handler. The only frontend-facing thing it does is drive the
/// host-key trust prompt; terminal I/O is handled via the `Channel` in the
/// session task, not the handler's data callbacks.
///
/// `pub(crate)` so the tunnel and SFTP layers (`tunnel.rs`, `sftp.rs`) can
/// reuse the exact same host-key-TOFU handshake path via [`establish_target`],
/// rather than duplicating it — the shared-connect-path reuse called out in
/// SPEC §2.
pub(crate) struct SshHandler {
    prompter: Arc<dyn HostKeyPrompter>,
    known_hosts: Arc<KnownHostsStore>,
    prompts: Arc<PromptRegistry>,
    host: String,
    port: u16,
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
}

/// Held by the code that awaits a handshake: dropping it tells the handler to
/// stop waiting on a pending host-key prompt (treated as a reject).
pub(crate) struct HandshakeOwner(#[allow(dead_code)] watch::Sender<()>);

impl SshHandler {
    /// Construct a handler. Used by `SessionManager::build_handler` and, for
    /// tunnels, by `tunnel.rs` (which shares the same known-hosts store + prompt
    /// registry so host-key trust decisions are consistent across shells and
    /// tunnels).
    // A plain field-by-field constructor for `SshHandler`; the parameter count
    // simply mirrors the struct's fields, so the arg-count lint doesn't apply.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        prompter: Arc<dyn HostKeyPrompter>,
        known_hosts: Arc<KnownHostsStore>,
        prompts: Arc<PromptRegistry>,
        host: String,
        port: u16,
        prompt_timeout: Duration,
        keepalive: KeepaliveConfig,
        forward_agent: bool,
    ) -> Self {
        let (owner_tx, owner_gone) = watch::channel(());
        SshHandler {
            prompter,
            known_hosts,
            prompts,
            host,
            port,
            prompt_timeout,
            keepalive,
            forward_agent,
            agent_channel_limit: Arc::new(Semaphore::new(MAX_AGENT_CHANNELS)),
            owner_gone,
            owner_token: Some(HandshakeOwner(owner_tx)),
            remote_routes: None,
        }
    }

    /// Route the server's `forwarded-tcpip` channels through `routes`.
    pub(crate) fn with_remote_routes(mut self, routes: Arc<RemoteRoutes>) -> Self {
        self.remote_routes = Some(routes);
        self
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
        SshHandler::new(
            Arc::clone(&self.prompter),
            Arc::clone(&self.known_hosts),
            Arc::clone(&self.prompts),
            jump.host.clone(),
            jump.port,
            self.prompt_timeout,
            self.keepalive,
            false,
        )
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
        let (rx, _guard) = self.prompts.register(prompt_id.clone());
        let _closed_notice = PromptClosedNotice {
            prompter: Arc::clone(&self.prompter),
            prompt_id: prompt_id.clone(),
        };

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
            Ok(Err(err)) => eprintln!("[DaSSHboard] failed to persist trusted host key: {err}"),
            Err(join_err) => eprintln!("[DaSSHboard] host-key persist task failed: {join_err}"),
        }
    }
}

impl client::Handler for SshHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        let fingerprint = server_public_key.fingerprint(HashAlg::Sha256).to_string();
        let key_type = server_public_key.algorithm().to_string();

        let verdict = self
            .known_hosts
            .verdict(&self.host, self.port, &fingerprint);
        if verdict == Verdict::Known {
            return Ok(true);
        }

        let accepted = self
            .await_host_key_decision(&key_type, &fingerprint, verdict)
            .await;

        if accepted {
            self.persist_trusted_key(key_type, fingerprint).await;
        }

        // Ok(false) makes russh abort the handshake with `Error::UnknownKey`,
        // which `establish` maps to `HostKeyRejected`.
        Ok(accepted)
    }

    /// The server opened an `auth-agent@openssh.com` channel (a program on the
    /// remote wants to use our keys). When agent forwarding is enabled for this
    /// session, accept it and relay it verbatim to the local SSH agent on a
    /// detached task; otherwise reject it. russh only opens these at all when we
    /// requested forwarding on the session channel (see `run_shell`), so the
    /// `else` is a defensive guard.
    async fn server_channel_open_agent_forward(
        &mut self,
        channel: russh::Channel<client::Msg>,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        // Acquire a per-session permit first: with forwarding off there are no
        // permits to give (capacity is only meaningful when we forward), and even
        // with it on the cap bounds concurrent agent channels. `try_acquire`
        // never blocks the handler's event loop. The permit is moved into the
        // proxy task and released when it ends.
        let permit = if self.forward_agent {
            self.agent_channel_limit.clone().try_acquire_owned().ok()
        } else {
            None
        };
        match permit {
            Some(permit) => {
                reply.accept().await;
                let stream = channel.into_stream();
                tokio::spawn(async move {
                    let _permit = permit;
                    crate::agent::proxy_agent_channel(stream).await;
                });
            }
            None => {
                reply
                    .reject(russh::ChannelOpenFailure::AdministrativelyProhibited)
                    .await;
            }
        }
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

    async fn server_channel_open_x11(
        &mut self,
        _channel: russh::Channel<client::Msg>,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        drop(reply);
        Ok(())
    }
}
