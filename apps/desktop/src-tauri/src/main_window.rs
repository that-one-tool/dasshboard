//! The main window, built here rather than from `tauri.conf.json` (where it is
//! declared with `"create": false`) because only the builder can grant the page
//! clipboard access: without it WebKitGTK and WebView2 refuse
//! `navigator.clipboard.readText()`, so pasting into a terminal (Ctrl+Shift+V,
//! right-click) silently pastes nothing. Copy works either way.

use tauri::{App, WebviewWindowBuilder};

/// The label of the window declared in `tauri.conf.json`.
pub(crate) const MAIN_WINDOW: &str = "main";

/// Create the main window from its config entry, with clipboard access.
pub(crate) fn create(app: &App) -> tauri::Result<()> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == MAIN_WINDOW)
        .cloned()
        .expect("tauri.conf.json declares the main window");
    WebviewWindowBuilder::from_config(app, &config)?
        .enable_clipboard_access()
        .build()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tauri_conf_leaves_the_main_window_to_create() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let windows = conf["app"]["windows"].as_array().unwrap();
        assert_eq!(windows.len(), 1);
        // No label means Tauri's default, "main".
        let label = windows[0]["label"].as_str().unwrap_or("main");
        assert_eq!(label, MAIN_WINDOW);
        // Created by Tauri too, it would clash with ours (same label).
        assert_eq!(windows[0]["create"], false);
    }
}
