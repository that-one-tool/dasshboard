//! Linux Wayland quirks the app works around: which window state survives a
//! restart, NVIDIA's explicit sync, and the window's app_id.

use tauri_plugin_window_state::StateFlags;

/// The window state saved on close and restored on launch. Wayland drops size
/// and position: the window-state plugin restores the saved physical size
/// before the window is on a screen (scale factor still 1), so on a scaled
/// screen the window doubles every launch, and it also creeps up by the GTK
/// decoration margins; once GDK's buffer size overflows, the app segfaults.
/// Wayland never reports a position anyway (always 0,0).
pub fn window_state_flags() -> StateFlags {
    flags_for(is_wayland_session(
        std::env::var("WAYLAND_DISPLAY").ok().as_deref(),
        std::env::var("GDK_BACKEND").ok().as_deref(),
    ))
}

fn flags_for(wayland: bool) -> StateFlags {
    if wayland {
        StateFlags::all().difference(StateFlags::SIZE | StateFlags::POSITION)
    } else {
        StateFlags::all()
    }
}

/// Whether GTK will open the window on Wayland: `GDK_BACKEND` (a
/// comma-separated preference list) wins when set, else a Wayland display.
fn is_wayland_session(wayland_display: Option<&str>, gdk_backend: Option<&str>) -> bool {
    if !cfg!(target_os = "linux") {
        return false;
    }
    match gdk_backend.map(str::trim).filter(|b| !b.is_empty()) {
        Some(backends) => backends.split(',').next().map(str::trim) == Some("wayland"),
        None => wayland_display.is_some_and(|d| !d.is_empty()),
    }
}

const NVIDIA_EXPLICIT_SYNC: &str = "__NV_DISABLE_EXPLICIT_SYNC";

/// On NVIDIA + Wayland, WebKitGTK dies at startup with "Error 71 (Protocol
/// error)" unless NVIDIA's explicit sync is off. Only NVIDIA's driver reads
/// the variable; a value the user set wins. Must run before GTK starts, while
/// the process is still single-threaded.
pub fn disable_nvidia_explicit_sync() {
    if cfg!(target_os = "linux") && std::env::var_os(NVIDIA_EXPLICIT_SYNC).is_none() {
        std::env::set_var(NVIDIA_EXPLICIT_SYNC, "1");
    }
}

/// The tauri bundler names the .deb/.rpm desktop file after `productName`.
#[cfg(any(target_os = "linux", test))]
const BUNDLED_DESKTOP_ENTRY_ID: &str = "DaSSHboard";

/// Wayland compositors (KWin) find the window icon through the desktop file
/// named after the window's app_id, which GTK takes from the program name
/// (else the binary name, `dasshboard`, which matches no desktop file). Must
/// run before GTK starts. Also sets the X11 WM_CLASS.
pub fn set_app_id() {
    #[cfg(target_os = "linux")]
    gio::glib::set_prgname(Some(desktop_entry_id(
        crate::flatpak::is_sandboxed(),
        std::env::var("FLATPAK_ID").ok(),
    )));
}

#[cfg(any(target_os = "linux", test))]
fn desktop_entry_id(sandboxed: bool, flatpak_id: Option<String>) -> String {
    flatpak_id
        .filter(|id| sandboxed && !id.is_empty())
        .unwrap_or_else(|| BUNDLED_DESKTOP_ENTRY_ID.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wayland_keeps_every_state_but_size_and_position() {
        let flags = flags_for(true);
        assert!(!flags.contains(StateFlags::SIZE));
        assert!(!flags.contains(StateFlags::POSITION));
        assert!(flags.contains(StateFlags::MAXIMIZED));
        assert!(flags.contains(StateFlags::FULLSCREEN));
    }

    #[test]
    fn elsewhere_the_whole_state_is_restored() {
        assert_eq!(flags_for(false).bits(), StateFlags::all().bits());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_wayland_display_means_wayland_unless_gdk_backend_says_otherwise() {
        assert!(is_wayland_session(Some("wayland-0"), None));
        assert!(is_wayland_session(Some("wayland-0"), Some("")));
        assert!(!is_wayland_session(Some("wayland-0"), Some("x11")));
        assert!(!is_wayland_session(Some("wayland-0"), Some("x11,wayland")));
        assert!(is_wayland_session(None, Some("wayland,x11")));
    }

    #[test]
    fn inside_flatpak_the_app_id_is_the_flatpak_id() {
        assert_eq!(
            desktop_entry_id(true, Some("io.github.that_one_tool.DaSSHboard".into())),
            "io.github.that_one_tool.DaSSHboard"
        );
    }

    #[test]
    fn elsewhere_the_app_id_is_the_bundled_desktop_file_name() {
        assert_eq!(desktop_entry_id(true, None), "DaSSHboard");
        assert_eq!(desktop_entry_id(true, Some(String::new())), "DaSSHboard");
    }

    #[test]
    fn a_flatpak_id_leaked_outside_the_sandbox_is_ignored() {
        assert_eq!(
            desktop_entry_id(false, Some("leaked.App".into())),
            "DaSSHboard"
        );
    }

    #[test]
    fn the_bundled_desktop_file_is_named_after_the_product_name() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["productName"], BUNDLED_DESKTOP_ENTRY_ID);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn without_a_wayland_display_it_is_not_wayland() {
        assert!(!is_wayland_session(None, None));
        assert!(!is_wayland_session(Some(""), None));
    }
}
