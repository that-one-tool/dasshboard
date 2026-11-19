//! Opening and closing an SSH connection, shared by shells, tunnels and SFTP:
//! one host-key trust store, one prompt registry, one set of deadlines.

use std::sync::Arc;
use std::time::Duration;

use russh::client;

use super::close::close_connection;
use super::establish::{establish_target, JumpConnection};
use super::handler::SshHandler;
use super::params::{Endpoint, JumpHop, KeepaliveConfig};
use super::prompts::{ConnectPrompter, ConnectPrompts};
use crate::error::AppError;
use crate::known_hosts::KnownHostsStore;

/// How long a connect may take, per stage — SPEC.md §6.
#[derive(Debug, Clone, Copy)]
pub struct ConnectTimeouts {
    /// Reaching the host (TCP connect).
    pub connect: Duration,
    /// The user answering a prompt (rejected on elapse).
    pub prompt: Duration,
    /// Slack for the version exchange, key exchange and authentication.
    pub handshake: Duration,
}

impl Default for ConnectTimeouts {
    fn default() -> Self {
        ConnectTimeouts {
            connect: Duration::from_secs(10),
            prompt: Duration::from_secs(60),
            handshake: Duration::from_secs(30),
        }
    }
}

impl ConnectTimeouts {
    /// Deadline for one whole connect, both hops of a jumped one included.
    /// Time spent on a prompt doesn't count (see `ConnectDeadline`); the
    /// prompt allowance is kept as slack for slow links.
    fn overall(&self) -> Duration {
        self.connect + self.prompt + self.handshake
    }
}

/// Opens every SSH connection of the app. Prompt ids are unique, so one
/// registry answers the prompts of shells, tunnels and SFTP alike.
pub struct SshConnector {
    known_hosts: Arc<KnownHostsStore>,
    prompts: Arc<ConnectPrompts>,
    timeouts: ConnectTimeouts,
}

impl SshConnector {
    pub fn new(known_hosts: Arc<KnownHostsStore>, timeouts: ConnectTimeouts) -> Self {
        SshConnector {
            known_hosts,
            prompts: Arc::default(),
            timeouts,
        }
    }

    /// The host-key trust store every connection consults.
    pub fn known_hosts(&self) -> Arc<KnownHostsStore> {
        Arc::clone(&self.known_hosts)
    }

    /// The prompts awaiting the user's answer, from any connection.
    pub fn prompts(&self) -> &ConnectPrompts {
        &self.prompts
    }

    pub(crate) fn timeouts(&self) -> ConnectTimeouts {
        self.timeouts
    }

    /// A handler for `host:port` raising its prompts on `prompter`.
    pub(crate) fn handler(
        &self,
        host: String,
        port: u16,
        keepalive: KeepaliveConfig,
        prompter: Arc<dyn ConnectPrompter>,
    ) -> SshHandler {
        SshHandler::new(
            prompter,
            Arc::clone(&self.known_hosts),
            Arc::clone(&self.prompts),
            host,
            port,
            self.timeouts.prompt,
            keepalive,
        )
    }

    /// Connect and authenticate to `target`, through `jump` if any, within
    /// the overall deadline.
    pub(crate) async fn connect(
        &self,
        target: Endpoint<'_>,
        jump: Option<&JumpHop>,
        handler: SshHandler,
    ) -> Result<SshConnection, AppError> {
        let timeouts = self.timeouts;
        let (handle, jump) =
            establish_target(target, jump, handler, timeouts.connect, timeouts.overall()).await?;
        Ok(SshConnection {
            handle: Arc::new(handle),
            jump,
        })
    }
}

/// An authenticated SSH connection, with the jump host's connection it rides
/// on, if any.
pub(crate) struct SshConnection {
    handle: Arc<client::Handle<SshHandler>>,
    jump: Option<JumpConnection>,
}

impl SshConnection {
    pub(crate) fn handle(&self) -> &Arc<client::Handle<SshHandler>> {
        &self.handle
    }

    /// Say goodbye to the target, then to the jump host; never waits long on
    /// a stuck server.
    pub(crate) async fn close(&self) {
        close_connection(&self.handle, self.jump.as_ref()).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_timeouts_are_the_specs() {
        let second = Duration::from_secs(1);
        let timeouts = ConnectTimeouts::default();
        assert_eq!(timeouts.connect, 10 * second);
        assert_eq!(timeouts.prompt, 60 * second);
        assert_eq!(timeouts.handshake, 30 * second);
    }

    #[test]
    fn the_overall_deadline_adds_up_connect_prompt_and_handshake() {
        let second = Duration::from_secs(1);
        let timeouts = ConnectTimeouts {
            connect: second,
            prompt: 10 * second,
            handshake: 100 * second,
        };
        assert_eq!(timeouts.overall(), 111 * second);
    }
}
