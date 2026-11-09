//! SSH port-forwarding (`ssh -L` / `ssh -D` / `ssh -R`) — the tunnel analogue of `session.rs`
//! (SPEC tunnels §2). A [`TunnelManager`] owns a `HashMap<TunnelId, TunnelHandle>`,
//! one `tokio` task per live tunnel, and reuses `ssh`'s connect + auth +
//! host-key-TOFU path verbatim, jump host included (`establish_target`). It
//! diverges only *after* authentication: instead of requesting a PTY + shell,
//! it binds a local `TcpListener` for each configured forward and pumps every
//! accepted connection
//! over a `direct-tcpip` channel to `remoteHost:remotePort` (resolved from the
//! SSH server) — or, for a dynamic forward (`ssh -D`), to whatever target the
//! connection's SOCKS request names (see `socks.rs`). A remote forward
//! (`ssh -R`) binds nothing here: it asks the server to listen, and the
//! connections the server sends back are dialed to its local target (see
//! `remote_forward.rs`).
//!
//! **Like `session.rs`, this module is deliberately Tauri-free.** All
//! frontend-facing effects go through the [`TunnelSink`] trait, whose production
//! implementor lives in `commands/tunnels.rs` (emitting `tunnel_status` events) and whose
//! test implementor records into channels.
//!
//! ## Concurrency & cleanup (mirrors `session.rs`)
//!
//! - One tunnel = **one SSH connection** carrying **one local listener per
//!   forward** (`ssh -L a -L b host`). Forwards can be added to and removed from
//!   a live tunnel one at a time over its control channel; releasing the last
//!   bound one ends the tunnel. The `client::Handle` is shared into each
//!   listener via an `Arc` (it is not `Clone`), which is enough because every
//!   method the listeners call — `channel_open_direct_tcpip`, `send_keepalive`,
//!   `disconnect` — takes `&self`.
//! - Each listener task is owned by its `ActiveForwards` entry and owns a
//!   nested `JoinSet` of per-connection copy tasks. Removing a forward (or
//!   stopping the tunnel) aborts and awaits its listener, which cascades: the
//!   per-connection `JoinSet` drops → in-flight copies abort. No handle is held
//!   across teardown that could leak a socket.
//! - A remote forward's listen and cancel requests go through one
//!   `ServerRequests` task, in order, so a slow server never holds up the
//!   serve loop; the answers come back to it.
//! - Every forwarded connection drains its channel into its own backlog (see
//!   `relay.rs`), so a local client that pauses reading doesn't stop the whole
//!   SSH connection; one far behind that stops reading altogether is closed.
//! - Each tunnel task removes its own map entry on **every** terminal reason
//!   (auth failure, all binds failing, stop, transport drop). Cleanup has a
//!   single owner, exactly as `SessionManager` does.

mod dynamic;
mod forwards;
mod lifecycle;
mod local;
mod manager;
mod remote;
mod serve;
mod status;

use serde::Serialize;

use crate::device::Forward;
use crate::error::AppError;
use crate::ssh::params::{AuthCredentials, JumpHop, KeepaliveConfig};
use crate::ssh::prompts::ConnectPrompter;

pub use manager::TunnelManager;

/// Lifecycle status mirrored to the frontend `tunnel_status` event. Distinct
/// from [`SessionStatus`](crate::session_sink::SessionStatus) because a
/// tunnel is `Listening` (bound, awaiting connections) rather than
/// `Connected`, and has no terminal-data phase.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TunnelStatus {
    Connecting,
    Listening,
    Disconnected,
    Error,
}

impl TunnelStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            TunnelStatus::Connecting => "connecting",
            TunnelStatus::Listening => "listening",
            TunnelStatus::Disconnected => "disconnected",
            TunnelStatus::Error => "error",
        }
    }
}

/// Per-forward bind outcome carried in a `Listening` status. Non-secret.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardStatus {
    pub forward_id: String,
    pub local_addr: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    /// Whether the local listener bound successfully. A `false` here means this
    /// one forward's local port was unavailable; the rest of the tunnel still
    /// runs (SPEC tunnels §2).
    pub bound: bool,
}

/// A live tunnel as reported by `list_tunnels`. Non-secret.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelInfo {
    pub tunnel_id: String,
    pub device_id: String,
    /// The forwards it serves or, while still connecting, will bind.
    pub forward_ids: Vec<String>,
    /// Per-forward bind state as last reported on `Listening` (empty while it
    /// is still connecting).
    pub forwards: Vec<ForwardStatus>,
}

/// Sink for everything the tunnel core surfaces to the frontend (its host-key
/// prompts — the same event a shell raises — through [`ConnectPrompter`]).
/// The production impl emits `tunnel_status` events; the test impl records
/// into channels. Kept object-safe (`Arc<dyn TunnelSink>`).
pub trait TunnelSink: ConnectPrompter {
    /// A lifecycle change → `tunnel_status` event. `forwards` carries per-forward
    /// bind state on a `Listening` status and is empty otherwise.
    fn on_status(
        &self,
        status: TunnelStatus,
        message: Option<String>,
        forwards: Vec<ForwardStatus>,
    );
    /// The tunnel ended on `err` → an `error` `tunnel_status` event. The
    /// production sink adds the error's code, so the frontend can tell a drop
    /// worth reconnecting from a failure a retry would only repeat.
    fn on_error(&self, err: &AppError) {
        self.on_status(TunnelStatus::Error, Some(err.to_string()), Vec::new());
    }
}

/// The connection-shaped parameters for a tunnel, constructed by the
/// `start_tunnel` command in `commands/tunnels.rs`.
///
/// `pub` + `#[doc(hidden)]` only so the `tests/` integration tests (a separate
/// crate) can build one — see the note on `session::ConnectParams`.
#[doc(hidden)]
pub struct TunnelParams {
    pub device_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub creds: AuthCredentials,
    /// The forwards to bind. Non-empty (the command rejects a device with none).
    pub forwards: Vec<Forward>,
    /// SSH keepalive resolved from user settings, applied to the tunnel's
    /// connection (same semantics as a shell session).
    pub keepalive: KeepaliveConfig,
    /// Optional jump host (`ProxyJump`): the tunnel's connection to `host:port`
    /// rides a direct-tcpip channel over it. `None` ⇒ direct.
    pub jump: Option<JumpHop>,
}

/// Control messages sent to a tunnel task via its mpsc handle. A stop goes
/// out of band (see [`Controls`](manager::Controls)).
pub(super) enum TunnelControl {
    /// Bind one more forward on the live connection (re-binding it if it is
    /// already there, e.g. to retry a port that was in use).
    AddForward(Forward),
    /// Release one forward's listener, by forward id.
    RemoveForward(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device::ForwardKind;

    #[test]
    fn tunnel_status_serializes_to_expected_strings() {
        assert_eq!(TunnelStatus::Connecting.as_str(), "connecting");
        assert_eq!(TunnelStatus::Listening.as_str(), "listening");
        assert_eq!(TunnelStatus::Disconnected.as_str(), "disconnected");
        assert_eq!(TunnelStatus::Error.as_str(), "error");
    }

    #[test]
    fn forward_status_is_camel_case() {
        let value = serde_json::to_value(ForwardStatus {
            forward_id: "f1".into(),
            local_addr: "127.0.0.1".into(),
            local_port: 5432,
            remote_host: "db".into(),
            remote_port: 5432,
            bound: true,
        })
        .unwrap();
        assert_eq!(value["forwardId"], "f1");
        assert_eq!(value["localAddr"], "127.0.0.1");
        assert_eq!(value["localPort"], 5432);
        assert_eq!(value["remoteHost"], "db");
        assert_eq!(value["remotePort"], 5432);
        assert_eq!(value["bound"], true);
    }

    pub(super) fn forward_of(kind: ForwardKind, local_addr: &str) -> Forward {
        Forward {
            id: "f1".into(),
            name: "f".into(),
            kind,
            local_addr: local_addr.into(),
            local_port: 0, // any free port
            remote_host: "db".into(),
            remote_port: 5432,
        }
    }

    #[test]
    fn tunnel_info_is_camel_case() {
        let value = serde_json::to_value(TunnelInfo {
            tunnel_id: "t1".into(),
            device_id: "d1".into(),
            forward_ids: vec!["f1".into()],
            forwards: Vec::new(),
        })
        .unwrap();
        assert_eq!(value["tunnelId"], "t1");
        assert_eq!(value["deviceId"], "d1");
        assert_eq!(value["forwardIds"], serde_json::json!(["f1"]));
        assert_eq!(value["forwards"], serde_json::json!([]));
    }
}
