import type { GridModel } from "../gridModel";
import { invokeChecked, invokeMutation } from "./invoke";

/* ============================================================================
 * Profile types & commands (SPEC §4–5, Phase 4)
 * ============================================================================ */

/** A single grid cell in a saved profile. `deviceId: null` is an empty pane. */
export interface ProfilePane {
  deviceId: string | null;
}

/**
 * One tab of a saved profile (SPEC §4). `grid` reuses the frontend `GridModel`
 * shape (`{ rows, cols, rowSizes, colSizes }`), which matches the backend's
 * `ProfileTab.grid` field exactly. `panes` is row-major, length `rows*cols`.
 */
export interface ProfileTab {
  name: string;
  grid: GridModel;
  panes: ProfilePane[];
}

/** A saved workspace (SPEC §4): its tabs in strip order, at least one. */
export interface Profile {
  id: string;
  name: string;
  tabs: ProfileTab[];
}

/** Return shape of `list_profiles` (SPEC §5). */
export interface ProfileList {
  defaultProfileId: string | null;
  profiles: Profile[];
  /** True on the launch that converted a single-grid (v1) `profiles.json`,
   * until the next write. */
  migratedFromV1: boolean;
}

/** Lists all saved profiles plus the current default id (SPEC §5). */
export async function listProfiles(): Promise<ProfileList> {
  return invokeChecked<ProfileList>("list_profiles");
}

/**
 * Saves or updates a profile (upsert). For a NEW profile pass `profile.id` as
 * `""` and the backend generates a UUIDv4, returning the stored profile.
 */
export async function saveProfile(profile: Profile): Promise<Profile> {
  return invokeMutation<Profile>("save_profile", { profile });
}

/** Deletes a profile; the backend clears the default if it pointed here (SPEC §5). */
export async function deleteProfile(profileId: string): Promise<void> {
  await invokeMutation<void>("delete_profile", { profileId });
}

/** Sets (or clears, with `null`) the default profile loaded on start (SPEC §5). */
export async function setDefaultProfile(profileId: string | null): Promise<void> {
  await invokeMutation<void>("set_default_profile", { profileId });
}
