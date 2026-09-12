/**
 * @vitest-environment happy-dom
 *
 * DOM-level regression tests for the device editor dialog.
 *
 * Guards the Phase 1 Blocking finding: a secret typed for one device and then
 * cancelled must NOT survive in `#device-secret`/`#device-passphrase` into the
 * next dialog opening, where it could be silently saved against a different
 * device (SPEC §7 "never pre-filled when editing"; SPEC §8 no cross-device
 * secret leak). These tests drive the real `DeviceManagerImpl` through the
 * exact open-A → type → cancel → open-other sequence and assert the secret
 * inputs are empty on every subsequent open.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Device } from "../ipc";

const { invokeMock, saveMock, openMock, homeDirMock, joinMock } = vi.hoisted(
  () => ({
    invokeMock: vi.fn(),
    saveMock: vi.fn(),
    openMock: vi.fn(),
    homeDirMock: vi.fn(),
    joinMock: vi.fn(),
  }),
);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: (...args: unknown[]) => saveMock(...args),
  open: (...args: unknown[]) => openMock(...args),
}));

vi.mock("@tauri-apps/api/path", () => ({
  homeDir: (...args: unknown[]) => homeDirMock(...args),
  join: (...args: unknown[]) => joinMock(...args),
}));

// Imported after the mock is registered so the module graph uses it.
import { DeviceManagerImpl } from "./deviceManager";

const deviceA: Device = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  name: "Alpha",
  kind: "ssh",
  host: "10.0.0.1",
  port: 22,
  username: "alpha",
  auth: { method: "password" },
  forwards: [],
  tunnelAutoStart: false,
  autoReconnect: false,
};

const deviceB: Device = {
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  name: "Bravo",
  kind: "ssh",
  host: "10.0.0.2",
  port: 22,
  username: "bravo",
  auth: { method: "key", keyPath: "C:/keys/id_ed25519" },
  forwards: [],
  tunnelAutoStart: false,
  autoReconnect: true,
};

const serialDevice: Device = {
  id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  name: "Arduino",
  kind: "serial",
  portName: "COM3",
  baudRate: 115200,
  dataBits: 8,
  parity: "none",
  stopBits: 1,
  flowControl: "none",
  autoReconnect: false,
};

function q<T extends Element>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`test: element not found: ${selector}`);
  return el;
}

async function setup(): Promise<HTMLElement> {
  document.body.innerHTML = '<div class="device-list"></div>';
  const el = q<HTMLElement>(document, ".device-list");
  const manager = new DeviceManagerImpl(el, {});
  await manager.init();
  return el;
}

function clickCancel(container: HTMLElement): void {
  const cancel = Array.from(
    container.querySelectorAll<HTMLButtonElement>("[data-close-dialog]"),
  ).find((b) => b.textContent?.trim() === "Cancel");
  if (!cancel) throw new Error("test: Cancel button not found");
  cancel.click();
}

describe("device editor dialog secret hygiene", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(
      async (cmd: string, payload?: Record<string, unknown>) => {
        if (cmd === "list_devices") return [deviceA, deviceB];
        if (cmd === "save_device") return (payload?.device ?? {}) as Device;
        return undefined;
      },
    );
  });

  it("does not carry a cancelled secret from one device's edit into another's", async () => {
    const container = await setup();

    // Edit A, type a password, then Cancel (do not Save).
    q<HTMLButtonElement>(
      container,
      `.btn-edit[data-device-id="${deviceA.id}"]`,
    ).click();
    q<HTMLInputElement>(container, "#device-secret").value = "typed-for-A";
    clickCancel(container);

    // Open B's editor: the secret field must be empty, not still "typed-for-A".
    q<HTMLButtonElement>(
      container,
      `.btn-edit[data-device-id="${deviceB.id}"]`,
    ).click();

    const secret = q<HTMLInputElement>(container, "#device-secret");
    expect(secret.value).toBe("");
    expect(secret.placeholder).toBe("unchanged");
  });

  it("does not carry a cancelled secret into the Add (new device) dialog", async () => {
    const container = await setup();

    q<HTMLButtonElement>(
      container,
      `.btn-edit[data-device-id="${deviceA.id}"]`,
    ).click();
    q<HTMLInputElement>(container, "#device-secret").value = "typed-for-A";
    clickCancel(container);

    // Now open the Add dialog.
    q<HTMLButtonElement>(container, ".device-add-btn").click();

    expect(q<HTMLInputElement>(container, "#device-secret").value).toBe("");
  });

  it("clears the key-auth passphrase field between edits too", async () => {
    const container = await setup();

    // Edit B (key auth) and type into the passphrase field, then cancel.
    q<HTMLButtonElement>(
      container,
      `.btn-edit[data-device-id="${deviceB.id}"]`,
    ).click();
    q<HTMLInputElement>(container, "#device-passphrase").value = "passphrase-for-B";
    clickCancel(container);

    // Re-open B: the passphrase field must be empty again.
    q<HTMLButtonElement>(
      container,
      `.btn-edit[data-device-id="${deviceB.id}"]`,
    ).click();

    expect(q<HTMLInputElement>(container, "#device-passphrase").value).toBe("");
  });
});

/**
 * Serial (COM port) device editor: choosing the Serial connection type swaps the
 * field group, saving a serial device sends the serial fields and NO secret, and
 * editing an existing serial device repopulates it correctly.
 */
describe("serial device editor", () => {
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(
      async (cmd: string, payload?: Record<string, unknown>) => {
        if (cmd === "list_devices") return [deviceA, serialDevice];
        if (cmd === "save_device") return (payload?.device ?? {}) as Device;
        return undefined;
      },
    );
  });

  function isHidden(container: HTMLElement, selector: string): boolean {
    return q<HTMLElement>(container, selector).classList.contains(
      "device-kind-hidden",
    );
  }

  it("swaps to serial fields and saves a serial device with no secret", async () => {
    const container = await setup();
    q<HTMLButtonElement>(container, ".device-add-btn").click();

    const kind = q<HTMLSelectElement>(container, "#device-kind");
    kind.value = "serial";
    kind.dispatchEvent(new Event("change", { bubbles: true }));

    expect(isHidden(container, "#ssh-fields")).toBe(true);
    expect(isHidden(container, "#serial-fields")).toBe(false);

    q<HTMLInputElement>(container, "#device-name").value = "New Serial";
    q<HTMLInputElement>(container, "#device-port-name").value = "COM7";
    q<HTMLInputElement>(container, "#device-baud-rate").value = "9600";

    q<HTMLFormElement>(container, "#device-form").dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await flush();

    const call = invokeMock.mock.calls.find((c) => c[0] === "save_device");
    expect(call).toBeTruthy();
    const payload = call?.[1] as { device: Device; secret?: string };
    expect(payload.device.kind).toBe("serial");
    expect(payload.device).toMatchObject({ portName: "COM7", baudRate: 9600 });
    // A serial device never carries a secret across the boundary.
    expect("secret" in payload).toBe(false);
  });

  it("populates serial fields and hides SSH fields when editing a serial device", async () => {
    const container = await setup();
    q<HTMLButtonElement>(
      container,
      `.btn-edit[data-device-id="${serialDevice.id}"]`,
    ).click();

    expect(q<HTMLSelectElement>(container, "#device-kind").value).toBe("serial");
    expect(q<HTMLInputElement>(container, "#device-port-name").value).toBe("COM3");
    expect(q<HTMLInputElement>(container, "#device-baud-rate").value).toBe("115200");
    expect(isHidden(container, "#ssh-fields")).toBe(true);
    expect(isHidden(container, "#serial-fields")).toBe(false);
  });
});

/**
 * Phase 6: device delete now goes through the shared in-app modal
 * (`src/ui/confirm.ts`) instead of the native blocking `window.confirm()`.
 * These guard that the modal is used, that it shows the raw device name (no
 * literal HTML entities the way a native confirm rendered `escapeHtml` output),
 * and that delete only fires on an explicit confirm.
 */
describe("device delete confirmation (Phase 6)", () => {
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  const withAmp: Device = {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    name: "A & B",
    kind: "ssh",
    host: "10.0.0.3",
    port: 22,
    username: "amp",
    auth: { method: "password" },
    forwards: [],
    tunnelAutoStart: false,
    autoReconnect: false,
  };

  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_devices") return [deviceA, withAmp];
      return undefined;
    });
  });

  function clickDelete(container: HTMLElement, id: string): void {
    q<HTMLButtonElement>(container, `.btn-delete[data-device-id="${id}"]`).click();
  }

  it("opens the shared modal (not native confirm) and deletes on confirm", async () => {
    const container = await setup();
    clickDelete(container, deviceA.id);

    const dialog = document.querySelector(".confirm-dialog");
    expect(dialog).not.toBeNull();
    q<HTMLButtonElement>(document.body, '.confirm-dialog [data-action="confirm"]').click();
    await flush();

    expect(invokeMock).toHaveBeenCalledWith("delete_device", {
      deviceId: deviceA.id,
    });
  });

  it("does not delete when the modal is cancelled", async () => {
    const container = await setup();
    clickDelete(container, deviceA.id);
    q<HTMLButtonElement>(document.body, '.confirm-dialog [data-action="cancel"]').click();
    await flush();

    expect(
      invokeMock.mock.calls.filter((c) => c[0] === "delete_device").length,
    ).toBe(0);
  });

  it("shows the raw device name, not HTML-escaped entities", async () => {
    const container = await setup();
    clickDelete(container, withAmp.id);

    const msg = q<HTMLElement>(document.body, ".confirm-dialog .confirm-message");
    // textContent gives the decoded text; it must contain the literal name.
    expect(msg.textContent).toContain('Delete "A & B"?');
    // And the raw markup must not contain the double-escaped `&amp;amp;`.
    expect(document.querySelector(".confirm-dialog")?.innerHTML).not.toContain(
      "&amp;amp;",
    );
  });
});

/**
 * Import/export wiring (JSON transfer): the Devices section's Export/Import
 * buttons drive the native file pickers (`save`/`open`, mocked) and then the
 * `export_devices`/`import_devices` commands with the chosen path. A cancelled
 * picker must be a silent no-op, and a successful import must reload the list.
 */
describe("device import/export", () => {
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    invokeMock.mockReset();
    saveMock.mockReset();
    openMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_devices") return [deviceA, deviceB];
      if (cmd === "export_devices") return 2;
      if (cmd === "import_devices") return 5;
      return undefined;
    });
  });

  function callsTo(command: string): unknown[][] {
    return invokeMock.mock.calls.filter((c) => c[0] === command);
  }

  it("Export click picks a save path then calls export_devices with it", async () => {
    saveMock.mockResolvedValue("C:/out/dasshboard-devices.json");
    const container = await setup();

    q<HTMLButtonElement>(container, ".device-export-btn").click();
    await flush();

    expect(saveMock).toHaveBeenCalledWith({
      defaultPath: "dasshboard-devices.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    expect(invokeMock).toHaveBeenCalledWith("export_devices", {
      path: "C:/out/dasshboard-devices.json",
    });
  });

  it("a cancelled save dialog does not call export_devices", async () => {
    saveMock.mockResolvedValue(null);
    const container = await setup();

    q<HTMLButtonElement>(container, ".device-export-btn").click();
    await flush();

    expect(saveMock).toHaveBeenCalledTimes(1);
    expect(callsTo("export_devices").length).toBe(0);
  });

  it("Import click opens a file then calls import_devices and reloads the list", async () => {
    openMock.mockResolvedValue("C:/in/dasshboard-devices.json");
    const container = await setup();
    // One list_devices from init(); the reload after import makes it two.
    expect(callsTo("list_devices").length).toBe(1);

    q<HTMLButtonElement>(container, ".device-import-btn").click();
    await flush();

    expect(openMock).toHaveBeenCalledWith({
      multiple: false,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    expect(invokeMock).toHaveBeenCalledWith("import_devices", {
      path: "C:/in/dasshboard-devices.json",
    });
    expect(callsTo("list_devices").length).toBe(2);
  });

  it("a cancelled open dialog does not call import_devices or reload", async () => {
    openMock.mockResolvedValue(null);
    const container = await setup();

    q<HTMLButtonElement>(container, ".device-import-btn").click();
    await flush();

    expect(callsTo("import_devices").length).toBe(0);
    expect(callsTo("list_devices").length).toBe(1); // only the initial load
  });
});

/**
 * SSH-config import wiring: the "Import SSH config" button opens a file picker
 * seeded at `~/.ssh/config` (built from `homeDir()` + `join()`), then calls the
 * `import_ssh_config` command and reloads the list. A cancelled picker is a
 * silent no-op.
 */
describe("SSH config import", () => {
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    invokeMock.mockReset();
    openMock.mockReset();
    homeDirMock.mockReset();
    joinMock.mockReset();
    homeDirMock.mockResolvedValue("/home/j");
    joinMock.mockResolvedValue("/home/j/.ssh/config");
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_devices") return [deviceA, deviceB];
      if (cmd === "import_ssh_config") return { imported: 3, skipped: 1 };
      return undefined;
    });
  });

  function callsTo(command: string): unknown[][] {
    return invokeMock.mock.calls.filter((c) => c[0] === command);
  }

  it("opens the picker seeded at ~/.ssh/config then imports and reloads", async () => {
    openMock.mockResolvedValue("/home/j/.ssh/config");
    const container = await setup();
    expect(callsTo("list_devices").length).toBe(1); // initial load

    q<HTMLButtonElement>(container, ".device-import-ssh-btn").click();
    await flush();

    expect(joinMock).toHaveBeenCalledWith("/home/j", ".ssh", "config");
    expect(openMock).toHaveBeenCalledWith({
      multiple: false,
      defaultPath: "/home/j/.ssh/config",
    });
    expect(invokeMock).toHaveBeenCalledWith("import_ssh_config", {
      path: "/home/j/.ssh/config",
    });
    expect(callsTo("list_devices").length).toBe(2); // reloaded after import
  });

  it("a cancelled picker does not call import_ssh_config or reload", async () => {
    openMock.mockResolvedValue(null);
    const container = await setup();

    q<HTMLButtonElement>(container, ".device-import-ssh-btn").click();
    await flush();

    expect(callsTo("import_ssh_config").length).toBe(0);
    expect(callsTo("list_devices").length).toBe(1); // only the initial load
  });
});

/**
 * F10 regression: a save failure used to route through `displayFieldErrors`
 * with `field: "general"`, which maps to a `#device-general` selector that
 * does not exist anywhere in the dialog markup — a silent no-op. The fix
 * drops that dead call; the error must still reach the user, but only via
 * `onError` (the toast), never via a field error node.
 */
describe("device save failure (F10)", () => {
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_devices") return [deviceA, deviceB];
      if (cmd === "save_device") {
        throw { code: "Io", message: "disk is full" };
      }
      return undefined;
    });
  });

  it("surfaces a save failure via onError and never via a dead field-error node", async () => {
    const onError = vi.fn();
    document.body.innerHTML = '<div class="device-list"></div>';
    const el = q<HTMLElement>(document, ".device-list");
    const manager = new DeviceManagerImpl(el, { onError });
    await manager.init();

    q<HTMLButtonElement>(el, `.btn-edit[data-device-id="${deviceA.id}"]`).click();
    const form = q<HTMLFormElement>(el, "#device-form");
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await flush();

    expect(onError).toHaveBeenCalledWith({ code: "Io", message: "disk is full" });
    // No `.error-text` in the form ever received the failure message — there
    // is no element the old `field: "general"` mapping could have targeted.
    const errorTexts = Array.from(form.querySelectorAll(".error-text"));
    expect(errorTexts.every((n) => n.textContent === "")).toBe(true);
    // The dialog stays open on failure (only a successful save closes it).
    expect(q<HTMLElement>(el, "#device-dialog").classList.contains("dialog-hidden")).toBe(
      false,
    );
  });
});
