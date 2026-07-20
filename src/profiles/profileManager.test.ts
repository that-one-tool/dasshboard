/**
 * @vitest-environment happy-dom
 *
 * Unit tests for `ProfileManager` (Phase 4) — the sidebar/toolbar orchestration
 * over the profile IPC commands and the `Grid`. Drives the class through its
 * rendered DOM (mirroring `deviceManager.test.ts`), with `../ipc` mocked and a
 * lightweight fake `Grid` (only `snapshot()`/`applyProfile()` are used).
 *
 * Covers the two Phase 4 review focuses that live in this file: that a Save
 * after a device deletion persists exactly the current (nulled) snapshot rather
 * than resurrecting a device id, and that the dirty dot tracks load→edit→save.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Grid } from "../grid";
import type { Profile } from "../ipc";
import type { WorkspaceSnapshot } from "./workspace";

vi.mock("../ipc", () => ({
  listProfiles: vi.fn(),
  saveProfile: vi.fn(),
  deleteProfile: vi.fn(async () => {}),
  setDefaultProfile: vi.fn(async () => {}),
  exportProfiles: vi.fn(),
  importProfiles: vi.fn(),
}));

const { saveMock, openMock } = vi.hoisted(() => ({
  saveMock: vi.fn(),
  openMock: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: (...args: unknown[]) => saveMock(...args),
  open: (...args: unknown[]) => openMock(...args),
}));

import { ProfileManager } from "./profileManager";
import {
  listProfiles,
  saveProfile,
  exportProfiles,
  importProfiles,
} from "../ipc";

/** A minimal stand-in for `Grid`: only `snapshot`/`applyProfile` are exercised. */
function fakeGrid(snapshot: WorkspaceSnapshot): {
  grid: Grid;
  applyProfile: ReturnType<typeof vi.fn>;
  setSnapshot: (s: WorkspaceSnapshot) => void;
} {
  let current = snapshot;
  const applyProfile = vi.fn(async () => true);
  const stub = {
    snapshot: () => current,
    applyProfile,
    liveSessionCount: () => 0,
  };
  return {
    grid: stub as unknown as Grid,
    applyProfile,
    setSnapshot: (s) => {
      current = s;
    },
  };
}

function grid2x2(): WorkspaceSnapshot["grid"] {
  return { rows: 1, cols: 2, rowSizes: [1], colSizes: [0.5, 0.5] };
}

function snapshot(panes: (string | null)[]): WorkspaceSnapshot {
  return { grid: grid2x2(), panes };
}

function profile(panes: (string | null)[]): Profile {
  return {
    id: "p1",
    name: "Homelab",
    grid: grid2x2(),
    panes: panes.map((deviceId) => ({ deviceId })),
  };
}

function dot(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".profile-dirty-dot");
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
  document.body.innerHTML = `
    <div id="profile-bar"></div>
    <div class="profile-list"></div>
  `;
  vi.mocked(listProfiles).mockReset();
  vi.mocked(saveProfile).mockReset();
});

describe("ProfileManager app-start", () => {
  it("loads the default profile on init and clears the dirty dot", async () => {
    const g = fakeGrid(snapshot(["dev-1", null]));
    vi.mocked(listProfiles).mockResolvedValue({
      defaultProfileId: "p1",
      profiles: [profile(["dev-1", null])],
    });

    const mgr = new ProfileManager({ grid: g.grid, onError: vi.fn(), onSuccess: vi.fn() });
    await mgr.init(null);
    await flush();

    // Default is applied WITHOUT a teardown confirm (nothing live at start).
    expect(g.applyProfile).toHaveBeenCalledTimes(1);
    expect(g.applyProfile).toHaveBeenCalledWith(
      expect.objectContaining({ id: "p1" }),
      { confirmTeardown: false },
    );
    // Workspace matches the loaded profile → not dirty.
    expect(dot()?.hidden).toBe(true);
  });

  it("loads the last-used profile when there is no default", async () => {
    const g = fakeGrid(snapshot(["dev-1", null]));
    vi.mocked(listProfiles).mockResolvedValue({
      defaultProfileId: null,
      profiles: [profile(["dev-1", null])],
    });

    const onProfileChange = vi.fn();
    const mgr = new ProfileManager({
      grid: g.grid,
      onError: vi.fn(),
      onSuccess: vi.fn(),
      onProfileChange,
    });
    // No default, but the last-used id points at an existing profile → load it.
    await mgr.init("p1");
    await flush();

    expect(g.applyProfile).toHaveBeenCalledTimes(1);
    expect(g.applyProfile).toHaveBeenCalledWith(
      expect.objectContaining({ id: "p1" }),
      { confirmTeardown: false },
    );
    expect(onProfileChange).toHaveBeenLastCalledWith("p1");
    expect(dot()?.hidden).toBe(true);
  });

  it("prefers the default profile over the last-used profile", async () => {
    const g = fakeGrid(snapshot([null, null]));
    const def = { ...profile([null, null]), id: "def" };
    const last = { ...profile(["dev-1", null]), id: "last" };
    vi.mocked(listProfiles).mockResolvedValue({
      defaultProfileId: "def",
      profiles: [def, last],
    });

    const mgr = new ProfileManager({ grid: g.grid, onError: vi.fn(), onSuccess: vi.fn() });
    await mgr.init("last"); // last-used points elsewhere, but default wins
    await flush();

    expect(g.applyProfile).toHaveBeenCalledTimes(1);
    expect(g.applyProfile).toHaveBeenCalledWith(
      expect.objectContaining({ id: "def" }),
      { confirmTeardown: false },
    );
  });

  it("loads nothing (1x1 empty) when the last-used profile no longer exists", async () => {
    const g = fakeGrid(snapshot([null, null]));
    vi.mocked(listProfiles).mockResolvedValue({
      defaultProfileId: null,
      profiles: [profile(["dev-1", null])], // id "p1"
    });

    const onProfileChange = vi.fn();
    const mgr = new ProfileManager({
      grid: g.grid,
      onError: vi.fn(),
      onSuccess: vi.fn(),
      onProfileChange,
    });
    // Stale id: the profile was deleted in a previous session.
    await mgr.init("gone");
    await flush();

    expect(g.applyProfile).not.toHaveBeenCalled();
    // The stale id is cleared so it stops being the restore target.
    expect(onProfileChange).toHaveBeenLastCalledWith(null);
    expect(dot()?.hidden).toBe(true);
  });

  it("does not load anything and stays clean when there is no default or last profile", async () => {
    const g = fakeGrid(snapshot([null, null]));
    vi.mocked(listProfiles).mockResolvedValue({ defaultProfileId: null, profiles: [] });

    const mgr = new ProfileManager({ grid: g.grid, onError: vi.fn(), onSuccess: vi.fn() });
    await mgr.init(null);
    await flush();

    expect(g.applyProfile).not.toHaveBeenCalled();
    expect(dot()?.hidden).toBe(true);
  });
});

describe("ProfileManager dirty state + save", () => {
  /**
   * Wire the two profile commands to a shared mutable backing store so that a
   * Save is visible to the following `reload()` (as the real backend would be).
   */
  function wireStore(initial: Profile[], defaultId: string | null): void {
    let backing = initial.map((p) => structuredClone(p));
    vi.mocked(listProfiles).mockImplementation(async () => ({
      defaultProfileId: defaultId,
      profiles: backing.map((p) => structuredClone(p)),
    }));
    vi.mocked(saveProfile).mockImplementation(async (p: Profile) => {
      const saved = { ...structuredClone(p), id: p.id || "new-id" };
      const i = backing.findIndex((x) => x.id === saved.id);
      if (i >= 0) backing[i] = saved;
      else backing = [...backing, saved];
      return saved;
    });
  }

  it("shows the dot after an edit and clears it after Save persists the snapshot", async () => {
    const g = fakeGrid(snapshot(["dev-1", null]));
    wireStore([profile(["dev-1", null])], "p1");

    const mgr = new ProfileManager({ grid: g.grid, onError: vi.fn(), onSuccess: vi.fn() });
    await mgr.init(null);
    await flush();
    expect(dot()?.hidden).toBe(true);

    // Simulate a workspace edit: the second pane now has a device.
    g.setSnapshot(snapshot(["dev-1", "dev-2"]));
    mgr.refreshDirty();
    expect(dot()?.hidden).toBe(false);

    // Save persists exactly the current snapshot; then the dot clears.
    document.querySelector<HTMLButtonElement>('[data-action="save"]')?.click();
    await flush();

    expect(vi.mocked(saveProfile)).toHaveBeenCalledTimes(1);
    const saved = vi.mocked(saveProfile).mock.calls[0]?.[0];
    expect(saved?.panes).toEqual([{ deviceId: "dev-1" }, { deviceId: "dev-2" }]);
    expect(dot()?.hidden).toBe(true);
  });

  it("Save after a device deletion persists the nulled pane, not the stale id", async () => {
    // The pane already dropped the deleted device from the snapshot (see
    // pane.ts refreshDevices); the manager must persist that null, never
    // resurrect the id.
    const g = fakeGrid(snapshot(["dev-1", "dev-2"]));
    wireStore([profile(["dev-1", "dev-2"])], "p1");

    const mgr = new ProfileManager({ grid: g.grid, onError: vi.fn(), onSuccess: vi.fn() });
    await mgr.init(null);
    await flush();

    // dev-2 was deleted → its pane is now null in the snapshot.
    g.setSnapshot(snapshot(["dev-1", null]));
    document.querySelector<HTMLButtonElement>('[data-action="save"]')?.click();
    await flush();

    const saved = vi.mocked(saveProfile).mock.calls[0]?.[0];
    expect(saved?.panes).toEqual([{ deviceId: "dev-1" }, { deviceId: null }]);
  });
});

describe("ProfileManager import/export", () => {
  const JSON_FILTER = { name: "JSON", extensions: ["json"] };

  beforeEach(() => {
    saveMock.mockReset();
    openMock.mockReset();
    vi.mocked(exportProfiles).mockReset();
    vi.mocked(importProfiles).mockReset();
    vi.mocked(listProfiles).mockResolvedValue({
      defaultProfileId: null,
      profiles: [profile(["dev-1", null])],
    });
  });

  async function initManager(): Promise<ProfileManager> {
    const g = fakeGrid(snapshot(["dev-1", null]));
    const mgr = new ProfileManager({
      grid: g.grid,
      onError: vi.fn(),
      onSuccess: vi.fn(),
    });
    await mgr.init(null);
    await flush();
    return mgr;
  }

  it("Export click picks a save path then calls exportProfiles with it", async () => {
    saveMock.mockResolvedValue("C:/out/dasshboard-profiles.json");
    vi.mocked(exportProfiles).mockResolvedValue(1);
    await initManager();

    document
      .querySelector<HTMLButtonElement>(".profile-export-btn")
      ?.click();
    await flush();

    expect(saveMock).toHaveBeenCalledWith({
      defaultPath: "dasshboard-profiles.json",
      filters: [JSON_FILTER],
    });
    expect(vi.mocked(exportProfiles)).toHaveBeenCalledWith(
      "C:/out/dasshboard-profiles.json",
    );
  });

  it("a cancelled save dialog does not call exportProfiles", async () => {
    saveMock.mockResolvedValue(null);
    await initManager();

    document
      .querySelector<HTMLButtonElement>(".profile-export-btn")
      ?.click();
    await flush();

    expect(vi.mocked(exportProfiles)).not.toHaveBeenCalled();
  });

  it("Import click opens a file then calls importProfiles and reloads", async () => {
    openMock.mockResolvedValue("C:/in/dasshboard-profiles.json");
    vi.mocked(importProfiles).mockResolvedValue(2);
    await initManager();
    // One listProfiles from init(); the reload after import makes it two.
    expect(vi.mocked(listProfiles)).toHaveBeenCalledTimes(1);

    document
      .querySelector<HTMLButtonElement>(".profile-import-btn")
      ?.click();
    await flush();

    expect(openMock).toHaveBeenCalledWith({
      multiple: false,
      filters: [JSON_FILTER],
    });
    expect(vi.mocked(importProfiles)).toHaveBeenCalledWith(
      "C:/in/dasshboard-profiles.json",
    );
    expect(vi.mocked(listProfiles)).toHaveBeenCalledTimes(2);
  });

  it("a cancelled open dialog does not call importProfiles or reload", async () => {
    openMock.mockResolvedValue(null);
    await initManager();

    document
      .querySelector<HTMLButtonElement>(".profile-import-btn")
      ?.click();
    await flush();

    expect(vi.mocked(importProfiles)).not.toHaveBeenCalled();
    expect(vi.mocked(listProfiles)).toHaveBeenCalledTimes(1);
  });
});
