//! The `Profile` model (SPEC.md §4) and its validation rules: a saved
//! workspace layout (grid shape + per-pane device assignment). Profiles hold
//! only device *ids*, never credentials, so there is no secret-hygiene
//! surface here (unlike `Device`).

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

/// A saved workspace layout. `panes` is row-major, length `rows*cols`
/// (SPEC.md §4).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    /// UUIDv4 string. Empty string on input means "not yet assigned" —
    /// `ProfileStore::upsert` generates a fresh id in that case (mirrors
    /// `Device::id`).
    pub id: String,
    pub name: String,
    pub grid: Grid,
    pub panes: Vec<Pane>,
}

impl Profile {
    /// Validation rules (mirrors `Device::validate`, PLAN.md Phase 4 task 1):
    /// non-empty name, at least one row/col, `panes.len() == rows*cols`, and
    /// `rowSizes`/`colSizes` each have one fraction per row/col. Keeps
    /// `profiles.json` internally consistent so the frontend never has to
    /// defend against a malformed grid/pane-count mismatch it didn't create
    /// itself.
    pub fn validate(&self) -> Result<(), AppError> {
        if self.name.trim().is_empty() {
            return Err(AppError::Validation("name must not be empty".to_string()));
        }
        if self.grid.rows == 0 || self.grid.cols == 0 {
            return Err(AppError::Validation(
                "grid rows and cols must be at least 1".to_string(),
            ));
        }
        let expected_panes = self.grid.rows as usize * self.grid.cols as usize;
        if self.panes.len() != expected_panes {
            return Err(AppError::Validation(format!(
                "expected {expected_panes} panes for a {}x{} grid, got {}",
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

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_profile() -> Profile {
        Profile {
            id: "11111111-1111-4111-8111-111111111111".to_string(),
            name: "Homelab 2x2".to_string(),
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

    /// Asserts the exact JSON shape against SPEC.md §4's literal example.
    #[test]
    fn wire_format_matches_spec_example() {
        let profile = Profile {
            id: "uuid".to_string(),
            ..valid_profile()
        };
        let value = serde_json::to_value(&profile).expect("serialize");
        assert_eq!(
            value,
            serde_json::json!({
                "id": "uuid",
                "name": "Homelab 2x2",
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

    #[test]
    fn round_trips_through_json() {
        let profile = valid_profile();
        let json = serde_json::to_string(&profile).expect("serialize");
        let back: Profile = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(profile, back);
    }

    #[test]
    fn accepts_a_fully_populated_valid_profile() {
        assert!(valid_profile().validate().is_ok());
    }

    #[test]
    fn accepts_an_empty_1x1_profile() {
        let profile = Profile {
            grid: Grid {
                rows: 1,
                cols: 1,
                row_sizes: vec![1.0],
                col_sizes: vec![1.0],
            },
            panes: vec![Pane { device_id: None }],
            ..valid_profile()
        };
        assert!(profile.validate().is_ok());
    }

    #[test]
    fn rejects_empty_name() {
        let profile = Profile {
            name: "   ".to_string(),
            ..valid_profile()
        };
        assert!(matches!(
            profile.validate().unwrap_err(),
            AppError::Validation(_)
        ));
    }

    #[test]
    fn rejects_zero_rows_or_cols() {
        let mut profile = valid_profile();
        profile.grid.rows = 0;
        assert!(matches!(
            profile.validate().unwrap_err(),
            AppError::Validation(_)
        ));

        let mut profile = valid_profile();
        profile.grid.cols = 0;
        assert!(matches!(
            profile.validate().unwrap_err(),
            AppError::Validation(_)
        ));
    }

    #[test]
    fn rejects_pane_count_mismatch() {
        let mut profile = valid_profile();
        profile.panes.pop();
        assert!(matches!(
            profile.validate().unwrap_err(),
            AppError::Validation(_)
        ));
    }

    #[test]
    fn rejects_row_sizes_length_mismatch() {
        let mut profile = valid_profile();
        profile.grid.row_sizes = vec![1.0];
        assert!(matches!(
            profile.validate().unwrap_err(),
            AppError::Validation(_)
        ));
    }

    #[test]
    fn rejects_col_sizes_length_mismatch() {
        let mut profile = valid_profile();
        profile.grid.col_sizes = vec![1.0];
        assert!(matches!(
            profile.validate().unwrap_err(),
            AppError::Validation(_)
        ));
    }
}
