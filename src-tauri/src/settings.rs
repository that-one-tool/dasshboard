//! App settings (`settings.json`, SPEC.md §4, Phase 5): terminal appearance
//! (font size/family, dark/light theme) applied live to all terminals, plus the
//! id of the last-used profile, reloaded on start when no default profile is
//! set. Holds no secrets. Loads/saves with atomic writes and recovers from a
//! missing or corrupt file, like the device/profile stores.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::atomic_file;
use crate::error::AppError;

const SETTINGS_FILE: &str = "settings.json";
const CURRENT_VERSION: u32 = 1;

/// Font size is clamped to this range on save so a bad value can't make every
/// terminal unreadable.
const MIN_FONT_SIZE: u32 = 6;
const MAX_FONT_SIZE: u32 = 40;
const DEFAULT_FONT_SIZE: u32 = 14;
// User-facing default: the text font only. The bundled icon font is NOT stored
// here — the frontend injects it into the live render chain at terminal-creation
// time (see `withIconFont` in terminalSettings.ts), so icons work regardless of
// what font the user has saved or later picks.
const DEFAULT_FONT_FAMILY: &str = "\"Cascadia Mono\", Consolas, monospace";

/// Scrollback is clamped to this range on save so a hand-edited/stale value can't
/// make a terminal drop all history (below 0) or exhaust memory (absurdly high).
/// `0` is a valid setting (no scrollback); the default matches xterm.js's own.
const MIN_SCROLLBACK: u32 = 0;
const MAX_SCROLLBACK: u32 = 100_000;
const DEFAULT_SCROLLBACK: u32 = 1000;

/// SSH keepalive is clamped on save. Interval is seconds between pings; `0`
/// disables keepalive entirely. Count-max is the number of consecutive
/// unanswered pings tolerated before the connection is declared dead (russh
/// drops it, which then feeds auto-reconnect). Defaults preserve the historic
/// hard-coded 30 s cadence.
const MIN_KEEPALIVE_INTERVAL: u32 = 0;
const MAX_KEEPALIVE_INTERVAL: u32 = 3600;
const DEFAULT_KEEPALIVE_INTERVAL: u32 = 30;
const MIN_KEEPALIVE_COUNT_MAX: u32 = 1;
const MAX_KEEPALIVE_COUNT_MAX: u32 = 10;
const DEFAULT_KEEPALIVE_COUNT_MAX: u32 = 3;

/// Which built-in xterm theme to apply.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum TerminalTheme {
    #[default]
    Dark,
    Light,
}

/// Terminal appearance settings, applied live to every terminal (SPEC.md §7).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSettings {
    pub font_size: u32,
    pub font_family: String,
    pub theme: TerminalTheme,
    /// Lines of scrollback xterm.js retains above the viewport. `#[serde(default)]`
    /// so a `settings.json` written before this field existed still loads.
    #[serde(default = "default_scrollback")]
    pub scrollback: u32,
}

fn default_scrollback() -> u32 {
    DEFAULT_SCROLLBACK
}

/// SSH keepalive settings, applied when a shell session or tunnel connects
/// (SPEC.md §6). App-wide, not per-device. Serial and local-shell sessions
/// ignore these.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeepaliveSettings {
    /// Seconds between keepalive pings; `0` disables keepalive.
    pub interval_secs: u32,
    /// Consecutive unanswered pings before the connection is dropped.
    pub count_max: u32,
}

impl Default for KeepaliveSettings {
    fn default() -> Self {
        KeepaliveSettings {
            interval_secs: DEFAULT_KEEPALIVE_INTERVAL,
            count_max: DEFAULT_KEEPALIVE_COUNT_MAX,
        }
    }
}

impl Default for TerminalSettings {
    fn default() -> Self {
        TerminalSettings {
            font_size: DEFAULT_FONT_SIZE,
            font_family: DEFAULT_FONT_FAMILY.to_string(),
            theme: TerminalTheme::default(),
            scrollback: DEFAULT_SCROLLBACK,
        }
    }
}

/// The whole `settings.json` payload (SPEC.md §4).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub terminal: TerminalSettings,
    /// The id of the most recently loaded profile, reloaded on start when no
    /// default profile is set (SPEC.md §7). `None` until a profile has been
    /// loaded at least once (a referenced profile that no longer exists is
    /// simply ignored on start).
    #[serde(default)]
    pub last_profile_id: Option<String>,
    /// UI language as a locale code (e.g. `"en"`, `"fr"`). `None` means "follow
    /// the operating system", which the frontend resolves at startup. The
    /// backend stores it verbatim and does not validate the code — the frontend
    /// owns the list of shipped locales and falls back to English for any it
    /// doesn't recognize.
    #[serde(default)]
    pub language: Option<String>,
    /// SSH keepalive cadence + dead-peer threshold. `#[serde(default)]` so a
    /// `settings.json` written before this group existed still loads.
    #[serde(default)]
    pub keepalive: KeepaliveSettings,
}

fn default_version() -> u32 {
    CURRENT_VERSION
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            version: CURRENT_VERSION,
            terminal: TerminalSettings::default(),
            last_profile_id: None,
            language: None,
            keepalive: KeepaliveSettings::default(),
        }
    }
}

impl Settings {
    /// Clamp/sanitize incoming settings so a bad value can't be persisted:
    /// font size into `[MIN_FONT_SIZE, MAX_FONT_SIZE]`, empty font family back to
    /// the default. Called on every save.
    fn sanitized(mut self) -> Self {
        self.version = CURRENT_VERSION;
        self.terminal.font_size = self.terminal.font_size.clamp(MIN_FONT_SIZE, MAX_FONT_SIZE);
        self.terminal.scrollback = self
            .terminal
            .scrollback
            .clamp(MIN_SCROLLBACK, MAX_SCROLLBACK);
        if self.terminal.font_family.trim().is_empty() {
            self.terminal.font_family = DEFAULT_FONT_FAMILY.to_string();
        }
        self.keepalive.interval_secs = self
            .keepalive
            .interval_secs
            .clamp(MIN_KEEPALIVE_INTERVAL, MAX_KEEPALIVE_INTERVAL);
        self.keepalive.count_max = self
            .keepalive
            .count_max
            .clamp(MIN_KEEPALIVE_COUNT_MAX, MAX_KEEPALIVE_COUNT_MAX);
        self
    }
}

pub struct SettingsStore {
    dir: PathBuf,
    settings: Mutex<Settings>,
}

impl SettingsStore {
    /// Loads `dir/settings.json`. Never panics or errors: a missing file yields
    /// defaults (created on first save); a corrupt file is backed up to
    /// `settings.json.corrupt-<unix-seconds>` and defaults are used.
    pub fn load(dir: PathBuf) -> Self {
        let settings = Self::read_from_disk(&dir);
        SettingsStore {
            dir,
            settings: Mutex::new(settings),
        }
    }

    /// Re-reads `settings.json` from disk, replacing the in-memory settings.
    /// Lets a second running app instance pick up terminal appearance another
    /// instance changed (see `reload_config`). Same recovery semantics as
    /// [`load`](Self::load): a missing file yields defaults and a corrupt file
    /// is backed up and defaults are used.
    pub fn reload(&self) {
        let settings = Self::read_from_disk(&self.dir);
        *self.lock() = settings;
    }

    /// Reads, parses, and sanitizes `dir/settings.json`, applying the
    /// missing-file and corrupt-file recovery shared by `load` and `reload`
    /// (see [`atomic_file::read_recovering`]). The `map` sanitizes loaded
    /// settings so a hand-edited or stale file can't persist a bad value.
    fn read_from_disk(dir: &Path) -> Settings {
        atomic_file::read_recovering::<Settings, _>(
            dir,
            SETTINGS_FILE,
            Settings::sanitized,
            Settings::default,
        )
    }

    /// The current settings (SPEC.md §5 `get_settings`).
    pub fn get(&self) -> Settings {
        self.lock().clone()
    }

    /// Replace the settings wholesale, sanitizing first, and persist atomically
    /// (SPEC.md §5 `save_settings`). Returns the stored (sanitized) settings.
    pub fn save(&self, settings: Settings) -> Result<Settings, AppError> {
        // Persist-then-commit (mirrors `DeviceStore::upsert`): hold the guard
        // across `persist` and only swap the value in once the write succeeds,
        // so a failed write never diverges memory from disk AND two concurrent
        // saves can't commit to memory in the opposite order they hit the disk.
        let sanitized = settings.sanitized();
        let mut guard = self.lock();
        self.persist(&sanitized)?;
        *guard = sanitized.clone();
        Ok(sanitized)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Settings> {
        atomic_file::lock(&self.settings)
    }

    /// Atomically persists the settings (see [`atomic_file::write_json`]).
    /// `Settings` carries its own `version` field, so it is written directly
    /// rather than inside a separate on-disk envelope.
    fn persist(&self, settings: &Settings) -> Result<(), AppError> {
        atomic_file::write_json(&self.dir, SETTINGS_FILE, settings)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn missing_file_yields_defaults_without_creating_it() {
        let dir = tempdir().unwrap();
        let store = SettingsStore::load(dir.path().to_path_buf());
        let s = store.get();
        assert_eq!(s.terminal.font_size, DEFAULT_FONT_SIZE);
        assert_eq!(s.terminal.theme, TerminalTheme::Dark);
        assert_eq!(s.last_profile_id, None);
        assert!(!dir.path().join(SETTINGS_FILE).exists());
    }

    #[test]
    fn save_round_trips_across_loads() {
        let dir = tempdir().unwrap();
        let store = SettingsStore::load(dir.path().to_path_buf());
        let mut s = store.get();
        s.terminal.font_size = 18;
        s.terminal.theme = TerminalTheme::Light;
        s.last_profile_id = Some("profile-123".to_string());
        s.language = Some("fr".to_string());
        store.save(s.clone()).unwrap();

        let reloaded = SettingsStore::load(dir.path().to_path_buf());
        let back = reloaded.get();
        assert_eq!(back.terminal.font_size, 18);
        assert_eq!(back.terminal.theme, TerminalTheme::Light);
        assert_eq!(back.last_profile_id, Some("profile-123".to_string()));
        assert_eq!(back.language, Some("fr".to_string()));
    }

    #[test]
    fn save_clamps_font_size_and_defaults_empty_family() {
        let dir = tempdir().unwrap();
        let store = SettingsStore::load(dir.path().to_path_buf());
        let mut s = store.get();
        s.terminal.font_size = 9999;
        s.terminal.font_family = "   ".to_string();
        let saved = store.save(s).unwrap();
        assert_eq!(saved.terminal.font_size, MAX_FONT_SIZE);
        assert_eq!(saved.terminal.font_family, DEFAULT_FONT_FAMILY);

        let mut s2 = store.get();
        s2.terminal.font_size = 1;
        let saved2 = store.save(s2).unwrap();
        assert_eq!(saved2.terminal.font_size, MIN_FONT_SIZE);
    }

    #[test]
    fn atomic_write_leaves_no_temp_files() {
        let dir = tempdir().unwrap();
        let store = SettingsStore::load(dir.path().to_path_buf());
        store.save(store.get()).unwrap();
        let entries: Vec<String> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(entries, vec![SETTINGS_FILE.to_string()]);
    }

    #[test]
    fn corrupt_file_is_backed_up_and_defaults_used() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join(SETTINGS_FILE), "{ not json").unwrap();
        let store = SettingsStore::load(dir.path().to_path_buf());
        assert_eq!(store.get().terminal.font_size, DEFAULT_FONT_SIZE);
        assert!(!dir.path().join(SETTINGS_FILE).exists());
        let backups: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("settings.json.corrupt-"))
            .collect();
        assert_eq!(backups.len(), 1);
    }

    #[test]
    fn deserializes_older_file_missing_new_fields_via_defaults() {
        // A settings.json written before `lastProfileId` existed must still load.
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join(SETTINGS_FILE),
            r#"{ "version": 1, "terminal": { "fontSize": 16, "fontFamily": "Consolas", "theme": "light" } }"#,
        )
        .unwrap();
        let store = SettingsStore::load(dir.path().to_path_buf());
        let s = store.get();
        assert_eq!(s.terminal.font_size, 16);
        assert_eq!(s.last_profile_id, None);
    }

    #[test]
    fn ignores_legacy_last_grid_field_from_older_files() {
        // A settings.json written when the retired `lastGrid` field still
        // existed must load cleanly (the now-unknown key is ignored) with
        // `last_profile_id` defaulting to None.
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join(SETTINGS_FILE),
            r#"{ "version": 1, "terminal": { "fontSize": 14, "fontFamily": "Consolas", "theme": "dark" }, "lastGrid": { "rows": 2, "cols": 2, "rowSizes": [0.5, 0.5], "colSizes": [0.5, 0.5] } }"#,
        )
        .unwrap();
        let store = SettingsStore::load(dir.path().to_path_buf());
        let s = store.get();
        assert_eq!(s.terminal.font_size, 14);
        assert_eq!(s.last_profile_id, None);
    }

    // -- B1: persist failure must not diverge memory from disk ------------

    #[test]
    fn save_leaves_memory_unchanged_when_persist_fails() {
        let root = tempdir().unwrap();
        let store_dir = root.path().join("store");
        // Block the store's target directory with a plain file so
        // `persist`'s `create_dir_all` fails deterministically (see the
        // identical technique in `store.rs`/`profile_store.rs`).
        fs::write(&store_dir, "blocking file").unwrap();
        let store = SettingsStore::load(store_dir);

        let mut s = store.get();
        s.terminal.font_size = 20;
        let err = store.save(s).unwrap_err();
        assert!(matches!(err, AppError::Io(_)));
        assert_eq!(
            store.get().terminal.font_size,
            DEFAULT_FONT_SIZE,
            "a failed persist must not leave the save applied in memory"
        );
    }

    #[test]
    fn save_clamps_scrollback_and_defaults_when_field_absent() {
        let dir = tempdir().unwrap();
        let store = SettingsStore::load(dir.path().to_path_buf());
        // Default is applied when nothing is set.
        assert_eq!(store.get().terminal.scrollback, DEFAULT_SCROLLBACK);

        // Clamp an absurdly high value down to the cap.
        let mut s = store.get();
        s.terminal.scrollback = 10_000_000;
        let saved = store.save(s).unwrap();
        assert_eq!(saved.terminal.scrollback, MAX_SCROLLBACK);

        // 0 (no scrollback) is valid and preserved.
        let mut s2 = store.get();
        s2.terminal.scrollback = 0;
        let saved2 = store.save(s2).unwrap();
        assert_eq!(saved2.terminal.scrollback, 0);
    }

    #[test]
    fn deserializes_older_file_missing_scrollback_field() {
        // A settings.json written before `scrollback` existed must still load,
        // defaulting to DEFAULT_SCROLLBACK.
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join(SETTINGS_FILE),
            r#"{ "version": 1, "terminal": { "fontSize": 14, "fontFamily": "Consolas", "theme": "dark" } }"#,
        )
        .unwrap();
        let store = SettingsStore::load(dir.path().to_path_buf());
        assert_eq!(store.get().terminal.scrollback, DEFAULT_SCROLLBACK);
    }

    #[test]
    fn save_clamps_keepalive_and_defaults_when_group_absent() {
        let dir = tempdir().unwrap();
        let store = SettingsStore::load(dir.path().to_path_buf());
        // Defaults applied when nothing is set.
        assert_eq!(
            store.get().keepalive.interval_secs,
            DEFAULT_KEEPALIVE_INTERVAL
        );
        assert_eq!(store.get().keepalive.count_max, DEFAULT_KEEPALIVE_COUNT_MAX);

        // Interval clamps to the cap; 0 (disabled) is valid and preserved.
        let mut s = store.get();
        s.keepalive.interval_secs = 999_999;
        s.keepalive.count_max = 0; // below min → clamps up to 1
        let saved = store.save(s).unwrap();
        assert_eq!(saved.keepalive.interval_secs, MAX_KEEPALIVE_INTERVAL);
        assert_eq!(saved.keepalive.count_max, MIN_KEEPALIVE_COUNT_MAX);

        let mut s2 = store.get();
        s2.keepalive.interval_secs = 0;
        s2.keepalive.count_max = 100; // above max → clamps down
        let saved2 = store.save(s2).unwrap();
        assert_eq!(saved2.keepalive.interval_secs, 0);
        assert_eq!(saved2.keepalive.count_max, MAX_KEEPALIVE_COUNT_MAX);
    }

    #[test]
    fn deserializes_older_file_missing_keepalive_group() {
        // A settings.json written before `keepalive` existed must still load,
        // defaulting the whole group.
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join(SETTINGS_FILE),
            r#"{ "version": 1, "terminal": { "fontSize": 14, "fontFamily": "Consolas", "theme": "dark" } }"#,
        )
        .unwrap();
        let store = SettingsStore::load(dir.path().to_path_buf());
        assert_eq!(store.get().keepalive, KeepaliveSettings::default());
    }

    #[test]
    fn wire_format_is_camel_case() {
        let s = Settings::default();
        let value = serde_json::to_value(&s).unwrap();
        assert_eq!(value["terminal"]["fontSize"], DEFAULT_FONT_SIZE);
        assert_eq!(value["terminal"]["scrollback"], DEFAULT_SCROLLBACK);
        assert_eq!(value["terminal"]["theme"], "dark");
        assert_eq!(
            value["keepalive"]["intervalSecs"],
            DEFAULT_KEEPALIVE_INTERVAL
        );
        assert_eq!(value["keepalive"]["countMax"], DEFAULT_KEEPALIVE_COUNT_MAX);
        assert!(value.get("lastProfileId").is_some()); // present as null
        assert!(value.get("language").is_some()); // present as null
        assert!(value["language"].is_null());
    }

    #[test]
    fn deserializes_older_file_missing_language_field() {
        // A settings.json written before `language` existed must still load,
        // defaulting the language to None ("follow the OS").
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join(SETTINGS_FILE),
            r#"{ "version": 1, "terminal": { "fontSize": 14, "fontFamily": "Consolas", "theme": "dark" }, "lastProfileId": null }"#,
        )
        .unwrap();
        let store = SettingsStore::load(dir.path().to_path_buf());
        assert_eq!(store.get().language, None);
    }

    // -- reload: multi-instance sync ---------------------------------------

    #[test]
    fn reload_picks_up_settings_written_by_another_instance() {
        let dir = tempdir().unwrap();
        let store = SettingsStore::load(dir.path().to_path_buf());
        assert_eq!(store.get().terminal.font_size, DEFAULT_FONT_SIZE);

        // A second instance changes the terminal appearance.
        let other = SettingsStore::load(dir.path().to_path_buf());
        let mut s = other.get();
        s.terminal.font_size = 22;
        s.terminal.theme = TerminalTheme::Light;
        other.save(s).unwrap();

        assert_eq!(
            store.get().terminal.font_size,
            DEFAULT_FONT_SIZE,
            "stale until reloaded"
        );

        store.reload();

        assert_eq!(store.get().terminal.font_size, 22);
        assert_eq!(store.get().terminal.theme, TerminalTheme::Light);
    }

    #[test]
    fn reload_recovers_to_defaults_when_the_file_disappears() {
        let dir = tempdir().unwrap();
        let store = SettingsStore::load(dir.path().to_path_buf());
        let mut s = store.get();
        s.terminal.font_size = 20;
        store.save(s).unwrap();

        fs::remove_file(dir.path().join(SETTINGS_FILE)).unwrap();
        store.reload();

        assert_eq!(store.get().terminal.font_size, DEFAULT_FONT_SIZE);
    }
}
