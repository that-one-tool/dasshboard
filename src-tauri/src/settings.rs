//! App settings (`settings.json`, SPEC.md §4, Phase 5): terminal appearance
//! (font size/family, dark/light theme) applied live to all terminals, plus the
//! id of the last-used profile, reloaded on start when no default profile is
//! set. Holds no secrets. Loads/saves with atomic writes and recovers from a
//! missing or corrupt file, like the device/profile stores.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::AppError;

const SETTINGS_FILE: &str = "settings.json";
const CURRENT_VERSION: u32 = 1;

/// Font size is clamped to this range on save so a bad value can't make every
/// terminal unreadable.
const MIN_FONT_SIZE: u32 = 6;
const MAX_FONT_SIZE: u32 = 40;
const DEFAULT_FONT_SIZE: u32 = 14;
// `Symbols Nerd Font Mono` is listed FIRST on purpose: it carries only Nerd /
// Powerline icon glyphs (no ASCII, box-drawing, or CJK), so it wins per-glyph
// for those codepoints while every text character falls through to Cascadia
// Mono. Listing it after Cascadia does NOT work — Cascadia claims the PUA
// codepoints with its own `.notdef` box and the browser never reaches the
// icon font.
const DEFAULT_FONT_FAMILY: &str =
    "\"Symbols Nerd Font Mono\", \"Cascadia Mono\", Consolas, monospace";

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
}

impl Default for TerminalSettings {
    fn default() -> Self {
        TerminalSettings {
            font_size: DEFAULT_FONT_SIZE,
            font_family: DEFAULT_FONT_FAMILY.to_string(),
            theme: TerminalTheme::default(),
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
        if self.terminal.font_family.trim().is_empty() {
            self.terminal.font_family = DEFAULT_FONT_FAMILY.to_string();
        }
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
        let path = dir.join(SETTINGS_FILE);
        let settings = match fs::read_to_string(&path) {
            Ok(contents) => match serde_json::from_str::<Settings>(&contents) {
                Ok(parsed) => parsed.sanitized(),
                Err(err) => {
                    eprintln!(
                        "[DaSSHboard] settings.json is corrupt ({err}); backing it up and using defaults"
                    );
                    Self::backup_corrupt(&path);
                    Settings::default()
                }
            },
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Settings::default(),
            Err(err) => {
                eprintln!(
                    "[DaSSHboard] could not read settings.json ({err}); backing it up and using defaults"
                );
                Self::backup_corrupt(&path);
                Settings::default()
            }
        };
        SettingsStore {
            dir,
            settings: Mutex::new(settings),
        }
    }

    fn backup_corrupt(path: &Path) {
        if !path.exists() {
            return;
        }
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let backup_path = path.with_file_name(format!("settings.json.corrupt-{timestamp}"));
        if let Err(err) = fs::rename(path, &backup_path) {
            eprintln!("[DaSSHboard] failed to back up corrupt settings.json: {err}");
        }
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
        self.settings
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Atomic write: serialize to a temp file in the same directory, then rename.
    fn persist(&self, settings: &Settings) -> Result<(), AppError> {
        fs::create_dir_all(&self.dir)?;
        let json = serde_json::to_string_pretty(settings)?;
        let tmp_path = self
            .dir
            .join(format!("{SETTINGS_FILE}.tmp-{}", Uuid::new_v4()));
        fs::write(&tmp_path, json)?;
        fs::rename(&tmp_path, self.dir.join(SETTINGS_FILE))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
        store.save(s.clone()).unwrap();

        let reloaded = SettingsStore::load(dir.path().to_path_buf());
        let back = reloaded.get();
        assert_eq!(back.terminal.font_size, 18);
        assert_eq!(back.terminal.theme, TerminalTheme::Light);
        assert_eq!(back.last_profile_id, Some("profile-123".to_string()));
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
    fn wire_format_is_camel_case() {
        let s = Settings::default();
        let value = serde_json::to_value(&s).unwrap();
        assert_eq!(value["terminal"]["fontSize"], DEFAULT_FONT_SIZE);
        assert_eq!(value["terminal"]["theme"], "dark");
        assert!(value.get("lastProfileId").is_some()); // present as null
    }
}
