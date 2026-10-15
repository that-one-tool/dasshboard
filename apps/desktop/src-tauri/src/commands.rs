//! Tauri commands, one module per domain (SPEC.md §5). A command with logic of
//! its own wraps an `*_impl` function taking `&AppState` directly, which is
//! what the tests exercise, since constructing a real `tauri::State` outside a
//! running app isn't possible.
//!
//! Argument names are `snake_case` in Rust; Tauri's command macro converts
//! them to `camelCase` on the wire by default (e.g. `device_id` here is
//! invoked from the frontend as `{ deviceId: ... }`).

pub mod app;
mod client_ids;
pub mod config;
mod device_access;
pub mod devices;
pub mod host_keys;
pub mod profiles;
pub mod sessions;
pub mod sftp;
pub mod sftp_edit;
#[cfg(test)]
mod test_support;
pub mod transfer;
pub mod tunnels;
