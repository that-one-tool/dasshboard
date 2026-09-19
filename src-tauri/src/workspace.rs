//! The `WorkspaceState` model (Tabs milestone, Phase 3): the set of open tabs
//! and the active one, persisted per-instance to `workspace_state.json` so the
//! app reopens the same tabs on restart. Each tab reuses the profile `Grid` /
//! `Pane` shapes (grid layout + row-major device assignment) plus a display
//! name and an optional linked-profile id (for the strip badge/dirty dot).
//!
//! This is per-instance UI state, deliberately separate from `profiles.json`
//! and NOT watched by the multi-instance config watcher — one window's tab
//! layout must never clobber another's.

use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::profile::{Grid, Pane};

/// One open tab: its display name, grid layout, row-major pane assignments, and
/// the profile it is linked to (or `None`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabState {
    pub name: String,
    pub grid: Grid,
    pub panes: Vec<Pane>,
    pub linked_profile_id: Option<String>,
}

impl TabState {
    /// Same grid/pane consistency rules as `Profile::validate` (minus the
    /// non-empty-name rule — a tab name is cosmetic and may be blank): rows/cols
    /// ≥ 1, one size fraction per row/col, and `panes.len() == rows*cols`.
    fn validate(&self) -> Result<(), AppError> {
        if self.grid.rows == 0 || self.grid.cols == 0 {
            return Err(AppError::Validation(
                "grid rows and cols must be at least 1".to_string(),
            ));
        }
        let expected = (self.grid.rows as usize)
            .checked_mul(self.grid.cols as usize)
            .ok_or_else(|| AppError::Validation("grid dimensions overflow".to_string()))?;
        if self.panes.len() != expected {
            return Err(AppError::Validation(format!(
                "expected {expected} panes for a {}x{} grid, got {}",
                self.grid.rows,
                self.grid.cols,
                self.panes.len()
            )));
        }
        if self.grid.row_sizes.len() != self.grid.rows as usize {
            return Err(AppError::Validation(
                "rowSizes must have one entry per row".to_string(),
            ));
        }
        if self.grid.col_sizes.len() != self.grid.cols as usize {
            return Err(AppError::Validation(
                "colSizes must have one entry per col".to_string(),
            ));
        }
        Ok(())
    }
}

/// The docked Files (SFTP) panel's per-instance UI state: whether it is open,
/// collapsed to the rail, its width in px, and the device last selected in its
/// picker (preselected on restore, but never auto-reconnected). Entirely
/// cosmetic — a bad value can only mis-size a panel — so it carries no
/// validation beyond the width clamp the frontend applies on read.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpPanelState {
    pub open: bool,
    pub collapsed: bool,
    pub width: u32,
    #[serde(default)]
    pub device_id: Option<String>,
}

/// The full saved workspace: the ordered open tabs plus the active tab index,
/// and the optional SFTP panel state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceState {
    pub tabs: Vec<TabState>,
    pub active_index: u32,
    /// The Files panel's UI state. `#[serde(default)]` so a `workspace_state.json`
    /// written before this field existed still loads (as `None`); skipped on
    /// serialize when absent so the file stays clean until the panel is used.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sftp: Option<SftpPanelState>,
}

impl WorkspaceState {
    /// The empty state (no tabs): what a first launch / corrupt file yields, and
    /// the signal the frontend reads as "restore nothing, fall back to the
    /// default/last profile".
    pub fn empty() -> Self {
        WorkspaceState {
            tabs: Vec::new(),
            active_index: 0,
            sftp: None,
        }
    }

    /// Every tab must be internally consistent, and `activeIndex` must point at
    /// a real tab when any exist. Keeps `workspace_state.json` from persisting a
    /// shape the frontend would have to defend against on restore.
    pub fn validate(&self) -> Result<(), AppError> {
        if !self.tabs.is_empty() && (self.active_index as usize) >= self.tabs.len() {
            return Err(AppError::Validation(format!(
                "activeIndex {} out of range for {} tab(s)",
                self.active_index,
                self.tabs.len()
            )));
        }
        for tab in &self.tabs {
            tab.validate()?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tab() -> TabState {
        TabState {
            name: "Tab 1".to_string(),
            grid: Grid {
                rows: 1,
                cols: 2,
                row_sizes: vec![1.0],
                col_sizes: vec![0.5, 0.5],
            },
            panes: vec![
                Pane {
                    device_id: Some("dev-1".to_string()),
                },
                Pane { device_id: None },
            ],
            linked_profile_id: Some("p1".to_string()),
        }
    }

    fn state() -> WorkspaceState {
        WorkspaceState {
            tabs: vec![tab()],
            active_index: 0,
            sftp: None,
        }
    }

    #[test]
    fn accepts_a_valid_state() {
        assert!(state().validate().is_ok());
    }

    #[test]
    fn empty_state_is_valid() {
        assert!(WorkspaceState::empty().validate().is_ok());
    }

    #[test]
    fn rejects_active_index_out_of_range() {
        let mut s = state();
        s.active_index = 5;
        assert!(matches!(s.validate().unwrap_err(), AppError::Validation(_)));
    }

    #[test]
    fn rejects_pane_count_mismatch() {
        let mut s = state();
        s.tabs[0].panes.pop();
        assert!(matches!(s.validate().unwrap_err(), AppError::Validation(_)));
    }

    #[test]
    fn allows_a_blank_tab_name() {
        let mut s = state();
        s.tabs[0].name = String::new();
        assert!(s.validate().is_ok());
    }

    #[test]
    fn wire_format_is_camel_case() {
        let value = serde_json::to_value(state()).expect("serialize");
        assert!(value["tabs"].is_array());
        assert_eq!(value["activeIndex"], 0);
        assert_eq!(value["tabs"][0]["linkedProfileId"], "p1");
        assert_eq!(value["tabs"][0]["panes"][0]["deviceId"], "dev-1");
    }

    #[test]
    fn round_trips_through_json() {
        let s = state();
        let json = serde_json::to_string(&s).expect("serialize");
        let back: WorkspaceState = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(s, back);
    }

    #[test]
    fn sftp_panel_state_round_trips_and_is_camel_case() {
        let mut s = state();
        s.sftp = Some(SftpPanelState {
            open: true,
            collapsed: false,
            width: 420,
            device_id: Some("dev-1".to_string()),
        });
        let value = serde_json::to_value(&s).expect("serialize");
        assert_eq!(value["sftp"]["open"], true);
        assert_eq!(value["sftp"]["width"], 420);
        assert_eq!(value["sftp"]["deviceId"], "dev-1");

        let json = serde_json::to_string(&s).expect("serialize");
        let back: WorkspaceState = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(s, back);
    }

    #[test]
    fn omits_sftp_field_when_absent() {
        // A clean file until the panel is used: `None` is skipped on serialize.
        let value = serde_json::to_value(state()).expect("serialize");
        assert!(value.get("sftp").is_none());
    }

    #[test]
    fn deserializes_older_file_missing_sftp_field() {
        // A workspace_state.json written before `sftp` existed loads as `None`.
        let json = r#"{ "tabs": [], "activeIndex": 0 }"#;
        let back: WorkspaceState = serde_json::from_str(json).expect("deserialize");
        assert_eq!(back.sftp, None);
    }
}
