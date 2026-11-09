//! Import SSH devices from an OpenSSH client config (`~/.ssh/config`).
//!
//! This is a *one-way, best-effort* importer: it reads a user's existing
//! `ssh` config and turns each concrete `Host` block into a DaSSHboard SSH
//! device, so someone who already keeps their servers in `~/.ssh/config`
//! doesn't have to re-enter them by hand. It is deliberately lenient — an
//! external, hand-edited file is messy — so unlike the strict JSON importer in
//! [`crate::transfer`], a host that can't be turned into a valid device is
//! *skipped and counted*, never a hard failure that aborts the whole import.
//!
//! Scope: the keywords that map onto our `Device` model —
//! `Host` / `HostName` / `Port` / `User` / `IdentityFile` / `ForwardAgent` /
//! `ProxyJump` (and `ProxyCommand`, only to refuse it). Everything else
//! (`Include`, …) is ignored, and `Include` directives are not followed.
//! Wildcard host patterns (`Host *`, `Host foo?`) describe defaults, not a
//! concrete server, so they never produce a device, and neither their keywords
//! nor a `Match` block's attach to one — except the proxy setting below.
//!
//! Jumps: a host's `ProxyJump`/`ProxyCommand` is the first one set by any
//! section that applies to it (its own block, a matching wildcard `Host`, the
//! lines before the first `Host`), as OpenSSH reads it. A device has at most
//! one jump host, itself direct. A single hop is linked to the device it names
//! — a `Host` alias in the file (case-insensitively), or an already-saved
//! device by its exported alias — otherwise to a saved device with the same
//! host/port/user, otherwise to a new device created for it. A host whose jump
//! can't be represented that way (a chain, a `ProxyCommand`, a `Match` block
//! that may set one, a jump host that itself jumps, itself, a malformed hop) is
//! skipped rather than imported as a direct connection.
//!
//! Secrets: an `ssh` config never contains a password, so a host with an
//! `IdentityFile` becomes **key** auth (that path, `~` expanded) and a host
//! without one becomes **password** auth with *no* stored secret — the user
//! fills it in later by editing the device. Nothing is ever written to the
//! keyring by an import.

mod export;
mod import;
mod jump_spec;
mod mapping;
mod parse;
#[cfg(test)]
mod test_support;

use serde::Serialize;

pub(crate) use export::export_ssh_config_impl;
pub(crate) use import::import_ssh_config_impl;
pub(crate) use mapping::{expand_tilde, home_dir};

/// Outcome of an SSH-config import, returned to the frontend so it can report
/// how many devices were added versus skipped (a wildcard/`Match`-only block,
/// an entry that produced no valid device, or a duplicate of one already saved).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshImportSummary {
    /// Devices actually upserted into the store.
    pub imported: u32,
    /// Hosts parsed but not imported: invalid (e.g. no resolvable username) or
    /// a duplicate of an existing / already-imported device.
    pub skipped: u32,
}

/// Outcome of an SSH-config *export*, returned to the frontend so it can report
/// how many devices were written versus skipped (a non-SSH device — serial or
/// local shell — has no `ssh` config representation and is left out).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshExportSummary {
    /// SSH devices written as `Host` blocks.
    pub exported: u32,
    /// Non-SSH devices (serial / local shell) skipped — they have no `ssh`
    /// config equivalent.
    pub skipped: u32,
}
