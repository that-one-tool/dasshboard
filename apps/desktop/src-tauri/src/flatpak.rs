//! Running inside the Flatpak sandbox: detection, and the one runtime
//! directory the sandbox shares with the host.

use std::path::{Path, PathBuf};

/// Flatpak mounts this file at the sandbox root; nothing else creates it.
pub fn is_sandboxed() -> bool {
    cfg!(target_os = "linux") && Path::new("/.flatpak-info").exists()
}

/// A directory the host can read files from (the tray icon image the host's
/// panel loads by path), or `None` outside a sandbox. Flatpak gives the app a
/// private `$XDG_RUNTIME_DIR` but bind-mounts its `app/<id>` subdirectory at
/// the same path on the host.
pub fn host_visible_runtime_dir() -> Option<PathBuf> {
    if !is_sandboxed() {
        return None;
    }
    shared_runtime_dir(
        std::env::var("XDG_RUNTIME_DIR").ok(),
        std::env::var("FLATPAK_ID").ok(),
    )
}

fn shared_runtime_dir(runtime_dir: Option<String>, app_id: Option<String>) -> Option<PathBuf> {
    Some(Path::new(&runtime_dir?).join("app").join(app_id?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_shared_runtime_dir_is_the_apps_own_subdirectory() {
        assert_eq!(
            shared_runtime_dir(
                Some("/run/user/1000".into()),
                Some("io.github.that_one_tool.DaSSHboard".into())
            ),
            Some(PathBuf::from(
                "/run/user/1000/app/io.github.that_one_tool.DaSSHboard"
            ))
        );
    }

    #[test]
    fn outside_a_sandbox_there_is_no_shared_runtime_dir() {
        assert_eq!(
            shared_runtime_dir(Some("/run/user/1000".into()), None),
            None
        );
        assert_eq!(shared_runtime_dir(None, Some("x".into())), None);
    }
}
