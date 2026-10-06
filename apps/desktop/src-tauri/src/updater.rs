//! In-app updates via `tauri-plugin-updater`, against the CrabNebula endpoints
//! and public key in `tauri.conf.json`. Never runs on its own: the frontend
//! calls `check` only when the user asks (About) or opted in to a launch check,
//! so the app contacts no server unasked.
//!
//! The flow is check → download → install, each step naming the version the
//! user confirmed so a concurrent re-check can't swap the release underneath.
//! The download is kept until the install succeeds, so a failure is
//! retryable. Self-install works for the NSIS/MSI installers, the Linux
//! AppImage and the macOS `.app`; a `.deb`/`.rpm` (or unbundled dev) build is
//! notify-only.

use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::utils::config::BundleType;
use tauri::utils::platform::bundle_type;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_updater::{Update, UpdaterExt};
use tauri_plugin_window_state::AppHandleExt;

use crate::atomic_file;
use crate::error::AppError;
use crate::flatpak;
use crate::local_shell;
use crate::state::AppState;
use crate::wayland;

/// Bounds each update-check request (so two endpoints can take up to twice
/// this); the plugin never applies it to the download. Keeps a captive portal
/// or stalled server from leaving "Checking…" up forever.
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);

/// Aborts a download that stops receiving data for this long, without capping
/// the total time a slow but live link may take.
const DOWNLOAD_READ_TIMEOUT: Duration = Duration::from_secs(60);

/// Windows installers exit the process from `Update::install`, so sessions must
/// be closed before it. Elsewhere (AppImage, `.app`) installing only swaps files,
/// so sessions close after it succeeds and survive a failed install.
const INSTALL_EXITS_APP: bool = cfg!(windows);

/// What the frontend needs to present an available update.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    /// Release notes, when the release carries any.
    pub notes: Option<String>,
    /// When the release was published (RFC 3339, as the server sent it).
    pub pub_date: Option<String>,
    /// Whether this build can download and install the update itself.
    pub can_install: bool,
    /// Whether Flatpak delivers the update (the app can't, and the website's
    /// installers are the wrong place to send the user).
    pub via_flatpak: bool,
}

/// A release that knows its version — the plugin's `Update`, or a test fake
/// (`Update` has private fields, so tests can't build one).
pub trait Versioned {
    fn version(&self) -> &str;
}

impl Versioned for Update {
    fn version(&self) -> &str {
        &self.version
    }
}

/// The release found by the last check and, once fetched, its verified bytes.
pub struct Pending<U> {
    update: Option<U>,
    download: Option<Vec<u8>>,
}

impl<U> Default for Pending<U> {
    fn default() -> Self {
        Pending {
            update: None,
            download: None,
        }
    }
}

impl<U: Versioned + Clone> Pending<U> {
    /// Adopts a new check result, discarding any download of the previous one.
    pub fn replace(&mut self, update: Option<U>) {
        self.update = update;
        self.download = None;
    }

    /// The checked release, provided it is the version the user confirmed.
    pub fn matching(&self, expected: &str) -> Result<U, AppError> {
        let update = self.update.as_ref().ok_or_else(|| {
            AppError::NotFound("No update to install; check for updates first.".into())
        })?;
        if update.version() != expected {
            return Err(AppError::Update(format!(
                "The available update changed to {}; check again.",
                update.version()
            )));
        }
        Ok(update.clone())
    }

    /// Keeps a finished download, unless a re-check replaced the release meanwhile.
    pub fn store_download(&mut self, expected: &str, bytes: Vec<u8>) -> Result<(), AppError> {
        self.matching(expected)?;
        self.download = Some(bytes);
        Ok(())
    }

    /// Hands the release and its bytes to the installer.
    pub fn take_download(&mut self, expected: &str) -> Result<(U, Vec<u8>), AppError> {
        let update = self.matching(expected)?;
        let bytes = self
            .download
            .take()
            .ok_or_else(|| AppError::NotFound("The update hasn't been downloaded yet.".into()))?;
        Ok((update, bytes))
    }

    /// Puts the bytes back after a failed install so the user can retry.
    pub fn restore_download(&mut self, expected: &str, bytes: Vec<u8>) {
        if self.matching(expected).is_ok() {
            self.download = Some(bytes);
        }
    }
}

/// Managed state shared by the update commands.
#[derive(Default)]
pub struct PendingUpdate(Mutex<Pending<Update>>);

impl PendingUpdate {
    fn lock(&self) -> std::sync::MutexGuard<'_, Pending<Update>> {
        atomic_file::lock(&self.0)
    }
}

/// Whether this build can replace itself. Keyed on the bundle marker the
/// bundler patches into the binary — the same one the plugin uses to pick an
/// installer — never on inheritable env like `APPIMAGE`. macOS reports `App`
/// even for an unpatched `tauri dev` binary, so there the executable must also
/// sit inside a real `.app` (the plugin would otherwise replace `target/debug`).
pub(crate) fn can_self_install(bundle: Option<BundleType>, exe: &Path) -> bool {
    match bundle {
        Some(BundleType::Nsis | BundleType::Msi | BundleType::AppImage) => true,
        Some(BundleType::App) => is_inside_app_bundle(exe),
        _ => false,
    }
}

/// `…/Name.app/Contents/MacOS/<exe>`.
fn is_inside_app_bundle(exe: &Path) -> bool {
    let mut dirs = exe.ancestors().skip(1);
    let mut next_name = || dirs.next().and_then(Path::file_name);
    let (macos, contents, bundle) = (next_name(), next_name(), next_name());
    macos == Some("MacOS".as_ref())
        && contents == Some("Contents".as_ref())
        && bundle.is_some_and(|name| Path::new(name).extension() == Some("app".as_ref()))
}

fn this_build_can_self_install() -> bool {
    let exe = std::env::current_exe().unwrap_or_default();
    can_self_install(bundle_type(), &exe)
}

/// CrabNebula sends `""` when a release has no notes.
pub(crate) fn notes_or_none(notes: Option<String>) -> Option<String> {
    notes.filter(|n| !n.trim().is_empty())
}

/// The manifest's `pub_date`, passed through verbatim for the frontend to
/// format in the user's locale.
pub(crate) fn pub_date_of(manifest: &serde_json::Value) -> Option<String> {
    manifest["pub_date"]
        .as_str()
        .filter(|d| !d.trim().is_empty())
        .map(str::to_owned)
}

fn update_error(err: tauri_plugin_updater::Error) -> AppError {
    AppError::Update(err.to_string())
}

/// Asks the update server for a newer release. `None` when up to date.
pub async fn check<R: Runtime>(
    app: &AppHandle<R>,
    pending: &PendingUpdate,
) -> Result<Option<UpdateInfo>, AppError> {
    let result = app
        .updater_builder()
        .timeout(CHECK_TIMEOUT)
        .configure_client(|client| client.read_timeout(DOWNLOAD_READ_TIMEOUT))
        .build()
        .map_err(update_error)?
        .check()
        .await;
    // On Linux the check sets SSL_CERT_FILE/DIR process-wide where none could be
    // preset; drop them again so nothing spawned later (the restart after an
    // update, the opener) inherits Debian's paths.
    local_shell::drop_updater_tls_env();
    let found = result.map_err(update_error)?;
    let info = found.as_ref().map(|update| UpdateInfo {
        version: update.version.clone(),
        notes: notes_or_none(update.body.clone()),
        pub_date: pub_date_of(&update.raw_json),
        can_install: this_build_can_self_install(),
        via_flatpak: flatpak::is_sandboxed(),
    });
    pending.lock().replace(found);
    Ok(info)
}

/// Downloads and signature-verifies the confirmed release, keeping the bytes
/// for `install`. Touches nothing else, so a failure leaves sessions running.
pub async fn download(pending: &PendingUpdate, expected: &str) -> Result<(), AppError> {
    ensure_self_install()?;
    let update = pending.lock().matching(expected)?;
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(update_error)?;
    pending.lock().store_download(expected, bytes)
}

/// Installs the downloaded update and restarts, closing every live session the
/// way quitting does — before the install on Windows (whose installer exits the
/// app), after it elsewhere. A failed install keeps the download for a retry.
pub async fn install<R: Runtime>(
    app: &AppHandle<R>,
    pending: &PendingUpdate,
    expected: &str,
) -> Result<(), AppError> {
    ensure_self_install()?;
    let (update, bytes) = pending.lock().take_download(expected)?;
    if INSTALL_EXITS_APP {
        prepare_to_exit(app).await;
    }
    if let Err(err) = update.install(&bytes) {
        pending.lock().restore_download(expected, bytes);
        return Err(update_error(err));
    }
    prepare_to_exit(app).await;
    app.restart()
}

/// Gracefully closes every session and saves the window state, since the
/// installer's exit / the restart skip the normal close path.
async fn prepare_to_exit<R: Runtime>(app: &AppHandle<R>) {
    app.state::<AppState>().shutdown_live_sessions().await;
    let _ = app.save_window_state(wayland::window_state_flags()); // best-effort
}

fn ensure_self_install() -> Result<(), AppError> {
    if this_build_can_self_install() {
        return Ok(());
    }
    Err(AppError::Update(
        "This installation can't update itself; download the new version instead.".into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone, Debug, PartialEq)]
    struct FakeUpdate(&'static str);

    impl Versioned for FakeUpdate {
        fn version(&self) -> &str {
            self.0
        }
    }

    fn pending_with(version: &'static str) -> Pending<FakeUpdate> {
        let mut pending = Pending::default();
        pending.replace(Some(FakeUpdate(version)));
        pending
    }

    const INSTALLED_EXE: &str = "/opt/DaSSHboard/dasshboard";
    const MAC_APP_EXE: &str = "/Applications/DaSSHboard.app/Contents/MacOS/dasshboard";
    const DEV_EXE: &str = "/Users/me/dasshboard/src-tauri/target/debug/dasshboard";

    fn can_install(bundle: Option<BundleType>, exe: &str) -> bool {
        can_self_install(bundle, Path::new(exe))
    }

    #[test]
    fn windows_installers_and_the_appimage_self_install() {
        assert!(can_install(Some(BundleType::Nsis), INSTALLED_EXE));
        assert!(can_install(Some(BundleType::Msi), INSTALLED_EXE));
        assert!(can_install(Some(BundleType::AppImage), INSTALLED_EXE));
    }

    #[test]
    fn the_macos_app_bundle_self_installs() {
        assert!(can_install(Some(BundleType::App), MAC_APP_EXE));
    }

    #[test]
    fn an_unbundled_macos_build_is_notify_only() {
        // Tauri reports every unpatched macOS binary (`tauri dev`) as `App`.
        assert!(!can_install(Some(BundleType::App), DEV_EXE));
        assert!(!can_install(
            Some(BundleType::App),
            "/Users/me/Contents/MacOS/dasshboard"
        ));
    }

    #[test]
    fn deb_rpm_and_unbundled_builds_are_notify_only() {
        assert!(!can_install(Some(BundleType::Deb), INSTALLED_EXE));
        assert!(!can_install(Some(BundleType::Rpm), INSTALLED_EXE));
        assert!(!can_install(None, DEV_EXE), "tauri dev / unbundled binary");
    }

    #[test]
    fn blank_release_notes_become_none() {
        assert_eq!(notes_or_none(Some(String::new())), None);
        assert_eq!(notes_or_none(Some("  \n".into())), None);
        assert_eq!(notes_or_none(None), None);
        assert_eq!(notes_or_none(Some("Fixes".into())), Some("Fixes".into()));
    }

    #[test]
    fn pub_date_is_read_from_the_release_manifest() {
        let manifest =
            serde_json::json!({ "version": "1.24.0", "pub_date": "2026-09-29T00:26:49.821Z" });
        assert_eq!(
            pub_date_of(&manifest),
            Some("2026-09-29T00:26:49.821Z".into())
        );
    }

    #[test]
    fn a_missing_or_blank_pub_date_is_none() {
        assert_eq!(
            pub_date_of(&serde_json::json!({ "version": "1.24.0" })),
            None
        );
        assert_eq!(pub_date_of(&serde_json::json!({ "pub_date": " " })), None);
        assert_eq!(pub_date_of(&serde_json::json!({ "pub_date": 42 })), None);
    }

    #[test]
    fn update_info_wire_format_is_camel_case() {
        let info = UpdateInfo {
            version: "1.21.0".into(),
            notes: Some("Fixes".into()),
            pub_date: Some("2026-09-29T00:26:49.821Z".into()),
            can_install: true,
            via_flatpak: false,
        };
        let value = serde_json::to_value(&info).unwrap();
        assert_eq!(value["version"], "1.21.0");
        assert_eq!(value["notes"], "Fixes");
        assert_eq!(value["pubDate"], "2026-09-29T00:26:49.821Z");
        assert_eq!(value["canInstall"], true);
        assert_eq!(value["viaFlatpak"], false);
    }

    #[test]
    fn matching_requires_a_checked_update() {
        let pending = Pending::<FakeUpdate>::default();
        assert!(matches!(
            pending.matching("1.2.0"),
            Err(AppError::NotFound(_))
        ));
    }

    #[test]
    fn matching_refuses_a_version_other_than_the_one_confirmed() {
        let pending = pending_with("1.3.0");
        assert!(matches!(
            pending.matching("1.2.0"),
            Err(AppError::Update(_))
        ));
        assert_eq!(pending.matching("1.3.0").unwrap(), FakeUpdate("1.3.0"));
    }

    #[test]
    fn a_download_is_installable_until_taken() {
        let mut pending = pending_with("1.3.0");
        assert!(
            pending.take_download("1.3.0").is_err(),
            "nothing downloaded yet"
        );
        pending.store_download("1.3.0", vec![1, 2, 3]).unwrap();

        let (update, bytes) = pending.take_download("1.3.0").unwrap();
        assert_eq!(update, FakeUpdate("1.3.0"));
        assert_eq!(bytes, vec![1, 2, 3]);
        assert!(pending.take_download("1.3.0").is_err(), "taken");
    }

    #[test]
    fn a_failed_install_can_be_retried_with_the_restored_download() {
        let mut pending = pending_with("1.3.0");
        pending.store_download("1.3.0", vec![9]).unwrap();
        let (_, bytes) = pending.take_download("1.3.0").unwrap();

        pending.restore_download("1.3.0", bytes);

        assert_eq!(pending.take_download("1.3.0").unwrap().1, vec![9]);
    }

    #[test]
    fn a_new_check_discards_a_stale_download() {
        let mut pending = pending_with("1.3.0");
        pending.store_download("1.3.0", vec![1]).unwrap();

        pending.replace(Some(FakeUpdate("1.4.0")));

        assert!(pending.take_download("1.4.0").is_err());
        assert!(
            pending.store_download("1.3.0", vec![1]).is_err(),
            "a download for the replaced release is refused"
        );
    }

    #[test]
    fn tauri_conf_asks_for_the_installed_bundle_first_then_falls_back() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let updater = &conf["plugins"]["updater"];
        let endpoints: Vec<&str> = updater["endpoints"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e.as_str().unwrap())
            .collect();
        assert_eq!(endpoints.len(), 2);
        assert!(endpoints[0].contains("{{target}}-{{arch}}-{{bundle_type}}/"));
        assert!(endpoints[1].contains("{{target}}-{{arch}}/"));
        assert_eq!(updater["requireSignedVersion"], true);
        // Interactive NSIS/MSI: the installer asks before closing other
        // running DaSSHboard windows instead of force-killing them.
        assert_eq!(updater["windows"]["installMode"], "basicUi");
    }
}
