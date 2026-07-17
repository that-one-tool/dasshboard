// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// Returns the application's semantic version, as recorded in `Cargo.toml`.
///
/// Kept as a small pure function (rather than inlined in the `ping` command)
/// so it has a unit test independent of the Tauri runtime.
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Walking-skeleton IPC command (Phase 0): proves the frontend <-> backend
/// round trip works end to end. Later phases add the real commands from
/// SPEC.md section 5.
#[tauri::command]
fn ping() -> String {
    app_version()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![ping])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_version_matches_cargo_toml() {
        assert_eq!(app_version(), env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn app_version_looks_like_semver() {
        let version = app_version();
        let parts: Vec<&str> = version.split('.').collect();
        assert_eq!(
            parts.len(),
            3,
            "expected MAJOR.MINOR.PATCH, got {version:?}"
        );
        for part in parts {
            assert!(
                !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()),
                "non-numeric version segment: {part:?}"
            );
        }
    }
}
