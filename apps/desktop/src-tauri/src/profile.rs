//! The `Profile` model (SPEC.md §4) and its validation rules: a saved
//! workspace made of one or more tabs, each a grid shape + per-pane device
//! assignment. Profiles hold only device *ids*, never credentials, so there is
//! no secret-hygiene surface here (unlike `Device`).

use serde::{Deserialize, Serialize};

use crate::error::AppError;

/// The grid shape and the (splitter-adjusted) size fractions for its tracks.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Grid {
    pub rows: u32,
    pub cols: u32,
    /// Fractions, sum ≈ 1, one per row (SPEC.md §4).
    pub row_sizes: Vec<f64>,
    /// Fractions, sum ≈ 1, one per column (SPEC.md §4).
    pub col_sizes: Vec<f64>,
}

/// A single grid cell. `device_id: None` is an empty pane.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pane {
    pub device_id: Option<String>,
}

/// One tab of a profile: its display name, grid layout, and row-major panes
/// (length `rows*cols`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileTab {
    pub name: String,
    pub grid: Grid,
    pub panes: Vec<Pane>,
}

/// A saved workspace: an ordered, non-empty list of tabs (SPEC.md §4).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "ProfileWire", into = "ProfileWire")]
pub struct Profile {
    /// UUIDv4 string. Empty string on input means "not yet assigned" —
    /// `ProfileStore::upsert` generates a fresh id in that case (mirrors
    /// `Device::id`).
    pub id: String,
    pub name: String,
    pub tabs: Vec<ProfileTab>,
}

/// A `Profile` on the wire. Read: the current `tabs` shape, or the single-grid
/// shape written before multi-tab profiles (`grid` + `panes` at the top level),
/// so an old `profiles.json` or export file still loads. Written: both, the
/// legacy pair holding the first tab, so an older app version (another
/// instance not yet updated, or a downgrade) reads the first tab instead of
/// treating the whole file as corrupt.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProfileWire {
    id: String,
    name: String,
    tabs: Option<Vec<ProfileTab>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    grid: Option<Grid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    panes: Option<Vec<Pane>>,
}

impl TryFrom<ProfileWire> for Profile {
    type Error = String;

    /// A legacy single-grid profile becomes one tab named after the profile
    /// (what "open in a new tab" used to name it). An empty `tabs` list falls
    /// back to the legacy pair, else is rejected: a tab-less profile would load
    /// as "close the tabs, open nothing".
    fn try_from(wire: ProfileWire) -> Result<Self, Self::Error> {
        let tabs = match (wire.tabs, wire.grid, wire.panes) {
            (Some(tabs), _, _) if !tabs.is_empty() => tabs,
            (_, Some(grid), Some(panes)) => vec![ProfileTab {
                name: wire.name.clone(),
                grid,
                panes,
            }],
            _ => return Err("a profile needs at least one tab".to_string()),
        };
        Ok(Profile {
            id: wire.id,
            name: wire.name,
            tabs,
        })
    }
}

impl From<Profile> for ProfileWire {
    fn from(profile: Profile) -> Self {
        let first = profile.tabs.first().cloned();
        ProfileWire {
            id: profile.id,
            name: profile.name,
            grid: first.as_ref().map(|tab| tab.grid.clone()),
            panes: first.map(|tab| tab.panes),
            tabs: Some(profile.tabs),
        }
    }
}

impl Profile {
    /// Validation rules (mirrors `Device::validate`, PLAN.md Phase 4 task 1):
    /// non-empty name, at least one tab, and every tab internally consistent
    /// (see [`ProfileTab::validate`]). Keeps `profiles.json` internally
    /// consistent so the frontend never has to defend against a malformed
    /// grid/pane-count mismatch it didn't create itself.
    pub fn validate(&self) -> Result<(), AppError> {
        if self.name.trim().is_empty() {
            return Err(AppError::Validation("name must not be empty".to_string()));
        }
        if self.tabs.is_empty() {
            return Err(AppError::Validation(
                "a profile needs at least one tab".to_string(),
            ));
        }
        self.tabs.iter().try_for_each(ProfileTab::validate)
    }
}

impl ProfileTab {
    /// At least one row/col, `panes.len() == rows*cols`, and
    /// `rowSizes`/`colSizes` each have one fraction per row/col. A tab name is
    /// cosmetic and may be blank (same as an open tab's).
    fn validate(&self) -> Result<(), AppError> {
        self.validate_grid_dims()?;
        self.validate_pane_count()?;
        self.validate_size_arrays()
    }

    fn validate_grid_dims(&self) -> Result<(), AppError> {
        if self.grid.rows == 0 || self.grid.cols == 0 {
            return Err(AppError::Validation(
                "grid rows and cols must be at least 1".to_string(),
            ));
        }
        Ok(())
    }

    fn validate_pane_count(&self) -> Result<(), AppError> {
        let expected = self.expected_pane_count()?;
        if self.panes.len() != expected {
            return Err(AppError::Validation(format!(
                "expected {expected} panes for a {}x{} grid, got {}",
                self.grid.rows,
                self.grid.cols,
                self.panes.len()
            )));
        }
        Ok(())
    }

    /// `rows * cols`. `checked_mul` guards a 32-bit build where the product
    /// could wrap `usize`; on 64-bit desktop targets it can't overflow, but the
    /// check costs nothing and removes the assumption.
    fn expected_pane_count(&self) -> Result<usize, AppError> {
        (self.grid.rows as usize)
            .checked_mul(self.grid.cols as usize)
            .ok_or_else(|| AppError::Validation("grid dimensions overflow".to_string()))
    }

    fn validate_size_arrays(&self) -> Result<(), AppError> {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn tab_2x2() -> ProfileTab {
        ProfileTab {
            name: "Web".to_string(),
            grid: Grid {
                rows: 2,
                cols: 2,
                row_sizes: vec![0.5, 0.5],
                col_sizes: vec![0.6, 0.4],
            },
            panes: vec![
                Pane {
                    device_id: Some("uuid".to_string()),
                },
                Pane { device_id: None },
                Pane {
                    device_id: Some("uuid".to_string()),
                },
                Pane {
                    device_id: Some("uuid".to_string()),
                },
            ],
        }
    }

    fn tab_1x1() -> ProfileTab {
        ProfileTab {
            name: "DB".to_string(),
            grid: Grid {
                rows: 1,
                cols: 1,
                row_sizes: vec![1.0],
                col_sizes: vec![1.0],
            },
            panes: vec![Pane { device_id: None }],
        }
    }

    fn valid_profile() -> Profile {
        Profile {
            id: "11111111-1111-4111-8111-111111111111".to_string(),
            name: "Homelab".to_string(),
            tabs: vec![tab_2x2(), tab_1x1()],
        }
    }

    fn assert_invalid(profile: &Profile) {
        assert!(matches!(
            profile.validate().unwrap_err(),
            AppError::Validation(_)
        ));
    }

    /// Asserts the exact JSON shape against SPEC.md §4's literal example, plus
    /// the first tab repeated as the legacy top-level `grid` + `panes`.
    #[test]
    fn wire_format_matches_spec_example() {
        let profile = Profile {
            id: "uuid".to_string(),
            tabs: vec![tab_2x2()],
            ..valid_profile()
        };
        let value = serde_json::to_value(&profile).expect("serialize");
        assert_eq!(
            value,
            serde_json::json!({
                "id": "uuid",
                "name": "Homelab",
                "tabs": [{
                    "name": "Web",
                    "grid": {
                        "rows": 2,
                        "cols": 2,
                        "rowSizes": [0.5, 0.5],
                        "colSizes": [0.6, 0.4],
                    },
                    "panes": [
                        { "deviceId": "uuid" },
                        { "deviceId": null },
                        { "deviceId": "uuid" },
                        { "deviceId": "uuid" },
                    ],
                }],
                "grid": {
                    "rows": 2,
                    "cols": 2,
                    "rowSizes": [0.5, 0.5],
                    "colSizes": [0.6, 0.4],
                },
                "panes": [
                    { "deviceId": "uuid" },
                    { "deviceId": null },
                    { "deviceId": "uuid" },
                    { "deviceId": "uuid" },
                ],
            })
        );
    }

    /// The single-grid `Profile` of app versions before multi-tab profiles
    /// (no `deny_unknown_fields`, so it ignores `tabs`).
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SingleGridProfile {
        name: String,
        grid: Grid,
        panes: Vec<Pane>,
    }

    #[test]
    fn an_older_app_version_reads_the_first_tab() {
        let json = serde_json::to_string(&valid_profile()).expect("serialize");
        let old: SingleGridProfile = serde_json::from_str(&json).expect("old shape");
        assert_eq!(old.name, "Homelab");
        assert_eq!(old.grid, tab_2x2().grid);
        assert_eq!(old.panes, tab_2x2().panes);
    }

    #[test]
    fn round_trips_through_json() {
        let profile = valid_profile();
        let json = serde_json::to_string(&profile).expect("serialize");
        let back: Profile = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(profile, back);
    }

    #[test]
    fn a_legacy_single_grid_profile_becomes_one_tab_named_after_it() {
        let legacy = serde_json::json!({
            "id": "uuid",
            "name": "Homelab",
            "grid": { "rows": 1, "cols": 1, "rowSizes": [1.0], "colSizes": [1.0] },
            "panes": [{ "deviceId": null }],
        });
        let profile: Profile = serde_json::from_value(legacy).expect("deserialize");
        assert_eq!(
            profile.tabs,
            vec![ProfileTab {
                name: "Homelab".to_string(),
                ..tab_1x1()
            }]
        );
        assert!(profile.validate().is_ok());
    }

    #[test]
    fn rejects_a_profile_with_neither_tabs_nor_a_legacy_grid() {
        let json = r#"{ "id": "uuid", "name": "Homelab" }"#;
        assert!(serde_json::from_str::<Profile>(json).is_err());
    }

    #[test]
    fn rejects_an_empty_tab_list_without_a_legacy_grid() {
        let json = r#"{ "id": "uuid", "name": "Homelab", "tabs": [] }"#;
        assert!(serde_json::from_str::<Profile>(json).is_err());
    }

    #[test]
    fn an_empty_tab_list_falls_back_to_the_legacy_grid() {
        let mut value = serde_json::to_value(valid_profile()).expect("serialize");
        value["tabs"] = serde_json::json!([]);
        let profile: Profile = serde_json::from_value(value).expect("deserialize");
        assert_eq!(profile.tabs.len(), 1);
        assert_eq!(profile.tabs[0].grid, tab_2x2().grid);
    }

    #[test]
    fn accepts_a_fully_populated_valid_profile() {
        assert!(valid_profile().validate().is_ok());
    }

    #[test]
    fn accepts_an_empty_1x1_profile() {
        let profile = Profile {
            tabs: vec![tab_1x1()],
            ..valid_profile()
        };
        assert!(profile.validate().is_ok());
    }

    #[test]
    fn allows_a_blank_tab_name() {
        let mut profile = valid_profile();
        profile.tabs[0].name = String::new();
        assert!(profile.validate().is_ok());
    }

    #[test]
    fn rejects_empty_name() {
        let profile = Profile {
            name: "   ".to_string(),
            ..valid_profile()
        };
        assert_invalid(&profile);
    }

    #[test]
    fn rejects_a_profile_without_tabs() {
        let profile = Profile {
            tabs: Vec::new(),
            ..valid_profile()
        };
        assert_invalid(&profile);
    }

    #[test]
    fn rejects_zero_rows_or_cols() {
        let mut profile = valid_profile();
        profile.tabs[0].grid.rows = 0;
        assert_invalid(&profile);

        let mut profile = valid_profile();
        profile.tabs[0].grid.cols = 0;
        assert_invalid(&profile);
    }

    #[test]
    fn rejects_pane_count_mismatch_in_any_tab() {
        let mut profile = valid_profile();
        profile.tabs[1].panes.push(Pane { device_id: None });
        assert_invalid(&profile);
    }

    #[test]
    fn rejects_row_sizes_length_mismatch() {
        let mut profile = valid_profile();
        profile.tabs[0].grid.row_sizes = vec![1.0];
        assert_invalid(&profile);
    }

    #[test]
    fn rejects_col_sizes_length_mismatch() {
        let mut profile = valid_profile();
        profile.tabs[0].grid.col_sizes = vec![1.0];
        assert_invalid(&profile);
    }
}
