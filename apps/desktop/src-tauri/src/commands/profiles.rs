//! Saved layouts. Profiles hold only device ids, never secrets.

use tauri::State;

use crate::error::AppError;
use crate::profile::Profile;
use crate::profile_store::ProfileList;
use crate::state::AppState;

pub(super) fn list_profiles_impl(state: &AppState) -> ProfileList {
    state.profile_store.list()
}

pub(super) fn save_profile_impl(state: &AppState, profile: Profile) -> Result<Profile, AppError> {
    state.profile_store.upsert(profile)
}

fn delete_profile_impl(state: &AppState, profile_id: &str) -> Result<(), AppError> {
    state.profile_store.delete(profile_id)
}

fn set_default_profile_impl(state: &AppState, profile_id: Option<String>) -> Result<(), AppError> {
    state.profile_store.set_default(profile_id)
}

/// All saved layouts plus the current default id (SPEC.md §5). Profiles hold
/// only device ids, never secrets.
#[tauri::command]
pub fn list_profiles(state: State<'_, AppState>) -> Result<ProfileList, AppError> {
    Ok(list_profiles_impl(&state))
}

/// Upserts a profile by `profile.id` (empty id ⇒ create with a new UUID).
#[tauri::command]
pub fn save_profile(state: State<'_, AppState>, profile: Profile) -> Result<Profile, AppError> {
    save_profile_impl(&state, profile)
}

/// Deletes a profile; clears `defaultProfileId` if it pointed at it (SPEC.md §5).
#[tauri::command]
pub fn delete_profile(state: State<'_, AppState>, profile_id: String) -> Result<(), AppError> {
    delete_profile_impl(&state, &profile_id)
}

/// Sets or clears (`null`) the default profile loaded on app start (SPEC.md §5).
#[tauri::command]
pub fn set_default_profile(
    state: State<'_, AppState>,
    profile_id: Option<String>,
) -> Result<(), AppError> {
    set_default_profile_impl(&state, profile_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::*;
    use tempfile::tempdir;

    #[test]
    fn profile_command_impls_round_trip_and_handle_default() {
        let dir = tempdir().unwrap();
        let state = test_state(dir.path());
        assert!(list_profiles_impl(&state).profiles.is_empty());

        let saved = save_profile_impl(&state, profile_referencing("dev-1")).unwrap();
        set_default_profile_impl(&state, Some(saved.id.clone())).unwrap();
        let listed = list_profiles_impl(&state);
        assert_eq!(listed.profiles.len(), 1);
        assert_eq!(listed.default_profile_id, Some(saved.id.clone()));

        // Deleting the default profile clears the default (SPEC §5).
        delete_profile_impl(&state, &saved.id).unwrap();
        let after = list_profiles_impl(&state);
        assert!(after.profiles.is_empty());
        assert_eq!(after.default_profile_id, None);
    }
}
