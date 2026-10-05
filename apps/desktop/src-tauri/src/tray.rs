//! System tray (opt-in "keep running in the tray when closed"). While the
//! setting is on, a tray icon offers a live-connection count (informational,
//! disabled), Show, and Quit; closing the window hides it instead of quitting,
//! so sessions keep running. The icon is built lazily the first time the
//! setting is on, so users who never opt in never see it.
//!
//! The frontend owns every translation (including the count's plural form): it
//! listens for [`LIVE_SESSION_COUNT_EVENT`] and pushes rendered labels back via
//! `set_tray_labels`. All tray mutations run on the main thread (setup, sync
//! commands, window/menu events), so the lock is never held across a
//! main-thread dispatch from another thread.
//!
//! Only Tauri holds the icon itself (looked up by [`TRAY_ID`]): its exit
//! cleanup (`cleanup_before_exit`, also run by restart and the updater) then
//! drops the last reference, which removes the icon — a copy kept here would
//! leave a dead icon in the Windows notification area.

use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use serde::Deserialize;
use tauri::image::Image;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::flatpak;
use crate::state::AppState;

/// Emitted with the new count whenever the number of live sessions changes.
pub const LIVE_SESSION_COUNT_EVENT: &str = "live_session_count";

const MAIN_WINDOW: &str = "main";
const TRAY_ID: &str = "main";
const CONNECTIONS_ID: &str = "tray-connections";
const SHOW_ID: &str = "tray-show";
const QUIT_ID: &str = "tray-quit";
const COUNT_POLL_INTERVAL: Duration = Duration::from_secs(2);

/// Tray menu labels, already translated (and pluralized) by the frontend.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayLabels {
    pub connections: String,
    pub show: String,
    pub quit: String,
}

impl Default for TrayLabels {
    /// English stand-ins until the frontend sends the real labels at startup.
    fn default() -> Self {
        TrayLabels {
            connections: "0 live connections".to_string(),
            show: "Show DaSSHboard".to_string(),
            quit: "Quit".to_string(),
        }
    }
}

/// What a window close request should do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAction {
    /// Hide the window; sessions keep running behind the tray icon.
    HideToTray,
    /// Disconnect live sessions gracefully, then close.
    ShutdownThenClose,
    /// Nothing live: let the close proceed.
    Close,
}

/// Hiding needs a tray icon that was built: without one the window could never
/// be brought back, so it closes instead. A built icon can still be invisible
/// (GNOME without the AppIndicator extension), which the setting's hint warns
/// about — the app has no way to detect it.
pub fn close_action(close_to_tray: bool, tray_ready: bool, has_live: bool) -> CloseAction {
    if close_to_tray && tray_ready {
        return CloseAction::HideToTray;
    }
    if has_live {
        CloseAction::ShutdownThenClose
    } else {
        CloseAction::Close
    }
}

/// Stores `now` in `last` and returns it when it differs.
fn count_change(last: &mut usize, now: usize) -> Option<usize> {
    if *last == now {
        return None;
    }
    *last = now;
    Some(now)
}

struct TrayMenu<R: Runtime> {
    connections: MenuItem<R>,
    show: MenuItem<R>,
    quit: MenuItem<R>,
}

impl<R: Runtime> TrayMenu<R> {
    fn apply_labels(&self, labels: &TrayLabels) -> tauri::Result<()> {
        self.connections.set_text(&labels.connections)?;
        self.show.set_text(&labels.show)?;
        self.quit.set_text(&labels.quit)
    }
}

struct TrayInner<R: Runtime> {
    /// `Some` once the icon has been built (it then lives in Tauri's state).
    menu: Option<TrayMenu<R>>,
    labels: TrayLabels,
}

/// Managed state: the tray menu once built, plus the latest labels (kept so a
/// lazily built icon starts in the UI language).
pub struct Tray<R: Runtime> {
    inner: Mutex<TrayInner<R>>,
}

impl<R: Runtime> Tray<R> {
    fn lock(&self) -> MutexGuard<'_, TrayInner<R>> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn is_ready(&self) -> bool {
        self.lock().menu.is_some()
    }
}

/// Registers the tray state, shows the icon if the setting is on, and starts
/// the live-session count watcher.
pub fn init<R: Runtime>(app: &AppHandle<R>) {
    app.manage(Tray::<R> {
        inner: Mutex::new(TrayInner {
            menu: None,
            labels: TrayLabels::default(),
        }),
    });
    let enabled = app
        .state::<AppState>()
        .settings_store
        .get()
        .tray
        .close_to_tray;
    set_enabled(app, enabled);
    spawn_count_watcher(app.clone());
}

/// Shows or hides the icon (building it the first time it is needed) and
/// returns whether close-to-tray is now in effect: `false` when the icon can't
/// be built, so the caller can store the setting as off. Disabling first
/// reveals a window hidden to the tray, which would otherwise be unreachable.
pub fn set_enabled<R: Runtime>(app: &AppHandle<R>, enabled: bool) -> bool {
    if !enabled {
        reveal_hidden_window(app);
    }
    let tray = app.state::<Tray<R>>();
    let mut inner = tray.lock();
    match set_visible(app, &mut inner, enabled) {
        Ok(()) => enabled,
        Err(err) => {
            eprintln!("[DaSSHboard] tray icon unavailable: {err}");
            false
        }
    }
}

fn set_visible<R: Runtime>(
    app: &AppHandle<R>,
    inner: &mut TrayInner<R>,
    visible: bool,
) -> Result<(), String> {
    if visible {
        ensure_built(app, inner)?;
    }
    if let Some(icon) = app.tray_by_id(TRAY_ID) {
        icon.set_visible(visible).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn ensure_built<R: Runtime>(app: &AppHandle<R>, inner: &mut TrayInner<R>) -> Result<(), String> {
    if inner.menu.is_some() {
        return Ok(());
    }
    tray_library_available()?;
    inner.menu = Some(build(app, &inner.labels).map_err(|e| e.to_string())?);
    Ok(())
}

/// tray-icon's Linux backend `panic!`s (rather than erroring) when it can't
/// load an AppIndicator library, which would abort the app — and again on every
/// launch once the setting is saved. Probe the same library names first
/// (libappindicator-sys 0.9, `backcompat` feature on).
#[cfg(target_os = "linux")]
fn tray_library_available() -> Result<(), String> {
    const LIBRARIES: [&str; 4] = [
        "libayatana-appindicator3.so.1",
        "libappindicator3.so.1",
        "libayatana-appindicator3.so",
        "libappindicator3.so",
    ];
    // SAFETY: loading these system libraries runs no initialisers beyond
    // GTK's, which tray-icon would load right after anyway.
    let found = LIBRARIES
        .iter()
        .any(|name| unsafe { libloading::Library::new(name) }.is_ok());
    if found {
        Ok(())
    } else {
        Err("no AppIndicator library (install libayatana-appindicator3)".to_string())
    }
}

#[cfg(not(target_os = "linux"))]
fn tray_library_available() -> Result<(), String> {
    Ok(())
}

/// Adopts new labels (locale or count changed) and applies them to the menu.
pub fn set_labels<R: Runtime>(app: &AppHandle<R>, labels: TrayLabels) {
    let tray = app.state::<Tray<R>>();
    let mut inner = tray.lock();
    if let Some(menu) = &inner.menu {
        if let Err(err) = menu.apply_labels(&labels) {
            eprintln!("[DaSSHboard] failed to update tray labels: {err}");
        }
    }
    inner.labels = labels;
}

/// The action for a close request on the main window, from the current setting,
/// tray availability and live sessions.
pub fn close_action_for<R: Runtime>(app: &AppHandle<R>) -> CloseAction {
    let state = app.state::<AppState>();
    let tray_ready = app.try_state::<Tray<R>>().is_some_and(|t| t.is_ready());
    close_action(
        state.settings_store.get().tray.close_to_tray,
        tray_ready,
        state.has_live_sessions(),
    )
}

/// Brings the (possibly hidden or minimized) main window back to the front.
pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn reveal_hidden_window<R: Runtime>(app: &AppHandle<R>) {
    let hidden = app
        .get_webview_window(MAIN_WINDOW)
        .is_some_and(|w| !w.is_visible().unwrap_or(true));
    if hidden {
        show_main_window(app);
    }
}

fn build<R: Runtime>(app: &AppHandle<R>, labels: &TrayLabels) -> tauri::Result<TrayMenu<R>> {
    let connections = MenuItem::with_id(
        app,
        CONNECTIONS_ID,
        &labels.connections,
        false,
        None::<&str>,
    )?;
    let show = MenuItem::with_id(app, SHOW_ID, &labels.show, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, QUIT_ID, &labels.quit, true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&connections, &separator, &show, &quit])?;
    // macOS convention: a menu-bar extra opens its menu on left click. Elsewhere
    // left click shows the window and the menu is on right click (Linux only
    // ever shows the menu).
    let builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("DaSSHboard")
        .menu(&menu)
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(on_menu_event)
        .on_tray_icon_event(on_icon_event);
    // Registered in Tauri's state (see the module doc); nothing is kept here.
    with_icon(app, with_host_visible_icon_dir(builder)).build(app)?;
    Ok(TrayMenu {
        connections,
        show,
        quit,
    })
}

/// The host's panel loads the icon image by path, so from inside the Flatpak
/// sandbox it must be written where the host can see it.
fn with_host_visible_icon_dir<R: Runtime>(builder: TrayIconBuilder<R>) -> TrayIconBuilder<R> {
    match flatpak::host_visible_runtime_dir() {
        Some(dir) => builder.temp_dir_path(dir),
        None => builder,
    }
}

/// macOS: a monochrome template image the menu bar tints for light/dark.
#[cfg(target_os = "macos")]
fn with_icon<R: Runtime>(_app: &AppHandle<R>, builder: TrayIconBuilder<R>) -> TrayIconBuilder<R> {
    let template: Image<'static> = tauri::include_image!("icons/tray-template.png");
    builder.icon(template).icon_as_template(true)
}

/// Windows/Linux: the full-colour app icon.
#[cfg(not(target_os = "macos"))]
fn with_icon<R: Runtime>(app: &AppHandle<R>, builder: TrayIconBuilder<R>) -> TrayIconBuilder<R> {
    match app.default_window_icon() {
        Some(icon) => builder.icon(Image::clone(icon)),
        None => builder,
    }
}

fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    match event.id().as_ref() {
        SHOW_ID => show_main_window(app),
        // Ends the event loop; `RunEvent::Exit` then disconnects live sessions.
        QUIT_ID => app.exit(0),
        _ => {}
    }
}

fn on_icon_event<R: Runtime>(icon: &TrayIcon<R>, event: TrayIconEvent) {
    if !cfg!(target_os = "macos") && is_left_click(&event) {
        show_main_window(icon.app_handle());
    }
}

fn is_left_click(event: &TrayIconEvent) -> bool {
    matches!(
        event,
        TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        }
    )
}

/// Polls the live-session count (sessions start and end in five managers, some
/// on their own when a remote drops) and emits it on change. The frontend also
/// asks for the current count once it listens (`live_session_count` command),
/// so a change emitted before its listener existed is not lost.
fn spawn_count_watcher<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        let mut last = 0;
        loop {
            tokio::time::sleep(COUNT_POLL_INTERVAL).await;
            let now = app.state::<AppState>().live_session_count();
            if let Some(count) = count_change(&mut last, now) {
                let _ = app.emit(LIVE_SESSION_COUNT_EVENT, count);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn close_hides_to_tray_when_enabled_and_tray_ready() {
        assert_eq!(close_action(true, true, true), CloseAction::HideToTray);
        assert_eq!(close_action(true, true, false), CloseAction::HideToTray);
    }

    #[test]
    fn close_never_hides_without_a_built_tray() {
        assert_eq!(
            close_action(true, false, true),
            CloseAction::ShutdownThenClose
        );
        assert_eq!(close_action(true, false, false), CloseAction::Close);
    }

    #[test]
    fn close_quits_as_before_when_setting_off() {
        assert_eq!(
            close_action(false, true, true),
            CloseAction::ShutdownThenClose
        );
        assert_eq!(close_action(false, true, false), CloseAction::Close);
    }

    #[test]
    fn count_change_reports_only_new_values() {
        let mut last = 0;
        assert_eq!(count_change(&mut last, 0), None);
        assert_eq!(count_change(&mut last, 2), Some(2));
        assert_eq!(count_change(&mut last, 2), None);
        assert_eq!(count_change(&mut last, 0), Some(0));
        assert_eq!(last, 0);
    }

    #[test]
    fn left_click_release_counts_as_a_click() {
        let click = |button, button_state| TrayIconEvent::Click {
            id: TRAY_ID.into(),
            position: tauri::PhysicalPosition::new(0.0, 0.0),
            rect: tauri::Rect::default(),
            button,
            button_state,
        };
        assert!(is_left_click(&click(
            MouseButton::Left,
            MouseButtonState::Up
        )));
        assert!(!is_left_click(&click(
            MouseButton::Left,
            MouseButtonState::Down
        )));
        assert!(!is_left_click(&click(
            MouseButton::Right,
            MouseButtonState::Up
        )));
    }

    #[test]
    fn labels_deserialize_from_camel_case() {
        let labels: TrayLabels = serde_json::from_value(serde_json::json!({
            "connections": "2 connexions actives",
            "show": "Afficher",
            "quit": "Quitter",
        }))
        .unwrap();
        assert_eq!(labels.show, "Afficher");
        assert_eq!(labels.connections, "2 connexions actives");
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn tray_library_needs_no_probe_off_linux() {
        assert_eq!(tray_library_available(), Ok(()));
    }

    #[test]
    fn macos_template_icon_embeds() {
        // Compiled on every platform so the macOS-only asset path is checked.
        let icon = tauri::include_image!("icons/tray-template.png");
        assert_eq!((icon.width(), icon.height()), (44, 44));
    }
}
