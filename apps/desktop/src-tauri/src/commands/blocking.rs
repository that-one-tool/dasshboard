//! Runs a command's blocking work (file writes with fsync, keychain calls over
//! D-Bus, spawning an editor) on a blocking worker. A sync command runs on the
//! main thread, which on Linux also delivers every IPC reply: one slow write
//! there froze all terminals and the Files panel at once.

use tauri::{AppHandle, Manager};

use crate::error::AppError;

/// Runs `task` on a blocking worker and waits for it.
pub(super) async fn run_blocking<T, F>(task: F) -> Result<T, AppError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, AppError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|e| AppError::Io(format!("background task failed: {e}")))?
}

/// [`run_blocking`] with the managed state `S`.
pub(super) async fn run_with_state<S, T, F>(app: AppHandle, task: F) -> Result<T, AppError>
where
    S: Send + Sync + 'static,
    T: Send + 'static,
    F: FnOnce(&S) -> Result<T, AppError> + Send + 'static,
{
    run_blocking(move || task(app.state::<S>().inner())).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn returns_what_the_task_returns() {
        assert_eq!(run_blocking(|| Ok(7)).await.unwrap(), 7);
        let failed: Result<(), AppError> =
            run_blocking(|| Err(AppError::Io("disk full".to_string()))).await;
        assert!(matches!(failed, Err(AppError::Io(m)) if m == "disk full"));
    }

    #[tokio::test]
    async fn runs_the_task_off_the_calling_thread() {
        let caller = std::thread::current().id();
        let worker = run_blocking(|| Ok(std::thread::current().id())).await;
        assert_ne!(worker.unwrap(), caller);
    }

    /// Sync commands run on the main thread, which on Linux also delivers
    /// every IPC reply. Each of these only copies memory under a brief lock
    /// (store reads never wait on a write: see `store_cell`); anything doing
    /// I/O must be async and use [`run_blocking`].
    const SYNC_COMMANDS: &[&str] = &[
        "auth_prompt_shown",
        "clear_logs",
        "get_logs",
        "get_settings",
        "get_workspace_state",
        "known_hosts_reset",
        "list_commands",
        "list_devices",
        "list_known_hosts",
        "list_profiles",
        "list_tunnels",
        "live_session_count",
        "ping",
        "respond_auth_prompt",
        "respond_host_key",
        "set_tray_labels",
        "sftp_bookmarks",
        "sftp_cancel_transfer",
        "sftp_connected_devices",
        "ssh_agent_available",
    ];

    /// Every source that could declare a command: `src/commands/*.rs` and
    /// `lib.rs`, read from disk so a new file can't slip past the check.
    fn command_sources() -> Vec<String> {
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut paths: Vec<_> = std::fs::read_dir(src.join("commands"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "rs"))
            .collect();
        paths.push(src.join("lib.rs"));
        paths
            .iter()
            .map(|path| std::fs::read_to_string(path).unwrap())
            .collect()
    }

    enum Declaration<'a> {
        SyncFn(&'a str),
        AsyncFn,
        Other,
    }

    impl<'a> Declaration<'a> {
        fn sync_name(&self) -> Option<&'a str> {
            match self {
                Declaration::SyncFn(name) => Some(name),
                _ => None,
            }
        }
    }

    fn without_visibility(line: &str) -> &str {
        let Some(rest) = line.strip_prefix("pub") else {
            return line;
        };
        let rest = rest.trim_start();
        let Some(scoped) = rest.strip_prefix('(') else {
            return rest;
        };
        scoped
            .split_once(')')
            .map_or(rest, |(_, item)| item.trim_start())
    }

    fn declaration(line: &str) -> Declaration<'_> {
        let item = without_visibility(line);
        if item.starts_with("async fn ") {
            return Declaration::AsyncFn;
        }
        item.strip_prefix("fn ")
            .and_then(|rest| rest.split(['(', '<']).next())
            .map_or(Declaration::Other, |name| Declaration::SyncFn(name.trim()))
    }

    /// The sync commands in `source`: each `#[tauri::command…]` line marks
    /// the next fn declaration, past doc, attribute or argument lines.
    fn sync_commands_in(source: &str) -> Vec<&str> {
        source
            .lines()
            .map(str::trim)
            .scan(false, |awaiting_fn, line| {
                Some(command_step(awaiting_fn, line))
            })
            .flatten()
            .collect()
    }

    fn command_step<'a>(awaiting_fn: &mut bool, line: &'a str) -> Option<&'a str> {
        if !*awaiting_fn {
            *awaiting_fn = line.starts_with("#[tauri::command");
            return None;
        }
        let declared = declaration(line);
        *awaiting_fn = matches!(declared, Declaration::Other);
        declared.sync_name()
    }

    #[test]
    fn only_listed_cheap_commands_run_on_the_main_thread() {
        let sources = command_sources();
        let mut found: Vec<&str> = sources
            .iter()
            .flat_map(|source| sync_commands_in(source))
            .collect();
        found.sort_unstable();
        assert_eq!(found, SYNC_COMMANDS);
    }

    #[test]
    fn spots_a_sync_command_in_a_source() {
        let source = [
            "#[tauri::command]",
            "pub fn plain(x: u8) {}",
            "#[tauri::command]",
            "pub async fn skipped() {}",
            "#[tauri::command(rename_all = \"snake_case\")]",
            "/// Docs.",
            "#[allow(clippy::needless_pass_by_value)]",
            "pub(crate) fn with_args<R>() {}",
            "#[tauri::command(",
            "    rename_all = \"snake_case\"",
            ")]",
            "fn private_multiline() {}",
            "#[tauri::command]",
            "async fn private_async() {}",
            "fn not_a_command() {}",
        ]
        .join("\n");
        assert_eq!(
            sync_commands_in(&source),
            ["plain", "with_args", "private_multiline"]
        );
    }

    #[tokio::test]
    async fn a_panicking_task_is_an_error() {
        let result: Result<(), AppError> = run_blocking(|| panic!("boom")).await;
        assert!(matches!(result, Err(AppError::Io(_))));
    }
}
