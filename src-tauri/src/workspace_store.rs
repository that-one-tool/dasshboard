//! `WorkspaceStore` (Tabs milestone, Phase 3): loads/saves the per-instance
//! `workspace_state.json` (the open tabs + active index) with atomic writes,
//! recovering rather than crashing on a missing or corrupt file. A simpler
//! sibling of `ProfileStore` — the whole state is replaced on each save (no
//! upsert/default bookkeeping), and it is NOT reloaded by the multi-instance
//! config sync, since tab layout is per-window UI state.
//!
//! Takes a directory path injected by the caller (like the other stores) so
//! tests can point it at a temp dir.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::atomic_file;
use crate::error::AppError;
use crate::workspace::WorkspaceState;

const WORKSPACE_FILE: &str = "workspace_state.json";
const CURRENT_VERSION: u32 = 1;

/// On-disk shape of `workspace_state.json`.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceFile {
    version: u32,
    #[serde(flatten)]
    state: WorkspaceState,
}

pub struct WorkspaceStore {
    dir: PathBuf,
    state: Mutex<WorkspaceState>,
}

impl WorkspaceStore {
    /// Loads `dir/workspace_state.json`. Never panics and never errors to the
    /// caller: a missing file yields the empty state (no tabs → the frontend
    /// falls back to the default/last profile), and a corrupt file is backed up
    /// to `workspace_state.json.corrupt-<unix-seconds>` before starting empty.
    pub fn load(dir: PathBuf) -> Self {
        let state = Self::read_from_disk(&dir);
        WorkspaceStore {
            dir,
            state: Mutex::new(state),
        }
    }

    fn read_from_disk(dir: &Path) -> WorkspaceState {
        atomic_file::read_recovering::<WorkspaceFile, _>(
            dir,
            WORKSPACE_FILE,
            |file| file.state,
            WorkspaceState::empty,
        )
    }

    /// The current saved workspace (empty when nothing has been persisted).
    pub fn get(&self) -> WorkspaceState {
        atomic_file::lock(&self.state).clone()
    }

    /// Replaces the whole saved workspace. Validates before touching disk, then
    /// persists-then-commits (mirrors `ProfileStore`): the in-memory copy is
    /// only swapped once the atomic write succeeds, so a failed write never
    /// diverges memory from disk.
    pub fn save(&self, state: WorkspaceState) -> Result<(), AppError> {
        state.validate()?;
        let mut guard = atomic_file::lock(&self.state);
        self.persist(&state)?;
        *guard = state;
        Ok(())
    }

    fn persist(&self, state: &WorkspaceState) -> Result<(), AppError> {
        let file = WorkspaceFile {
            version: CURRENT_VERSION,
            state: state.clone(),
        };
        atomic_file::write_json(&self.dir, WORKSPACE_FILE, &file)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profile::{Grid, Pane};
    use crate::workspace::TabState;
    use std::fs;
    use tempfile::tempdir;

    fn sample() -> WorkspaceState {
        WorkspaceState {
            tabs: vec![TabState {
                name: "Homelab".to_string(),
                grid: Grid {
                    rows: 1,
                    cols: 1,
                    row_sizes: vec![1.0],
                    col_sizes: vec![1.0],
                },
                panes: vec![Pane {
                    device_id: Some("dev-1".to_string()),
                }],
                linked_profile_id: Some("p1".to_string()),
            }],
            active_index: 0,
        }
    }

    #[test]
    fn missing_file_yields_empty_state() {
        let dir = tempdir().unwrap();
        let store = WorkspaceStore::load(dir.path().to_path_buf());
        assert_eq!(store.get(), WorkspaceState::empty());
        // Loading must not create the file.
        assert!(!dir.path().join(WORKSPACE_FILE).exists());
    }

    #[test]
    fn save_round_trips_across_loads() {
        let dir = tempdir().unwrap();
        let store = WorkspaceStore::load(dir.path().to_path_buf());
        store.save(sample()).unwrap();
        assert_eq!(store.get(), sample());

        let reloaded = WorkspaceStore::load(dir.path().to_path_buf());
        assert_eq!(reloaded.get(), sample());
    }

    #[test]
    fn save_rejects_an_invalid_state_without_touching_disk() {
        let dir = tempdir().unwrap();
        let store = WorkspaceStore::load(dir.path().to_path_buf());
        let mut bad = sample();
        bad.active_index = 9; // out of range
        assert!(matches!(
            store.save(bad).unwrap_err(),
            AppError::Validation(_)
        ));
        assert!(!dir.path().join(WORKSPACE_FILE).exists());
    }

    #[test]
    fn corrupt_file_is_backed_up_and_state_starts_empty() {
        let dir = tempdir().unwrap();
        fs::write(dir.path().join(WORKSPACE_FILE), "{ not json ").unwrap();

        let store = WorkspaceStore::load(dir.path().to_path_buf());
        assert_eq!(store.get(), WorkspaceState::empty());
        assert!(!dir.path().join(WORKSPACE_FILE).exists());
        let backups: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with("workspace_state.json.corrupt-"))
            .collect();
        assert_eq!(backups.len(), 1);
    }

    #[test]
    fn wire_format_carries_version_and_camel_case() {
        let dir = tempdir().unwrap();
        let store = WorkspaceStore::load(dir.path().to_path_buf());
        store.save(sample()).unwrap();

        let raw = fs::read_to_string(dir.path().join(WORKSPACE_FILE)).unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["version"], 1);
        assert_eq!(value["activeIndex"], 0);
        assert_eq!(value["tabs"][0]["name"], "Homelab");
        assert_eq!(value["tabs"][0]["linkedProfileId"], "p1");
    }
}
