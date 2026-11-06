/**
 * @vitest-environment happy-dom
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SavedCommand } from "../ipc";

const ipc = vi.hoisted(() => ({
  listCommands: vi.fn(),
  saveCommand: vi.fn(),
  deleteCommand: vi.fn(),
  exportCommands: vi.fn(),
  importCommands: vi.fn(),
}));
vi.mock("../ipc", () => ipc);

const confirmMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../ui/confirm", () => ({ confirm: confirmMock }));

const files = vi.hoisted(() => ({
  pickJsonSavePath: vi.fn(async (): Promise<string | null> => "/tmp/out.json"),
  pickJsonOpenPath: vi.fn(async (): Promise<string | null> => "/tmp/in.json"),
}));
vi.mock("../ui/fileDialog", () => files);

const dialogMock = vi.hoisted(() => vi.fn(async (): Promise<SavedCommand | null> => null));
vi.mock("./commandDialog", () => ({ openCommandDialog: dialogMock }));

import { initCommandsPanel, type CommandsPanelOptions, type CommandTarget } from "./commandsPanel";

const uptime: SavedCommand = { id: "c1", name: "uptime", text: "uptime", run: true };
const restart: SavedCommand = { id: "c2", name: "Restart", text: "sudo systemctl restart ", run: false };

function target(name: string) {
  return { name, send: vi.fn((_data: string) => {}) };
}

function makeOptions(targets: CommandTarget[]): CommandsPanelOptions {
  return {
    getTargets: () => targets,
    afterSend: vi.fn(),
    onError: vi.fn(),
    onInfo: vi.fn(),
    onSuccess: vi.fn(),
  };
}

function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(".command-item")];
}

function click(root: ParentNode, selector: string): void {
  const el = root.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  el.click();
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

async function panelWith(options: CommandsPanelOptions, commands = [uptime, restart]) {
  ipc.listCommands.mockResolvedValue(commands);
  const panel = initCommandsPanel(options);
  await panel?.reload();
  return panel;
}

beforeEach(() => {
  document.body.innerHTML = '<div class="command-list"></div>';
  vi.clearAllMocks();
  confirmMock.mockResolvedValue(true);
});

describe("commands panel list", () => {
  it("is absent without its container", () => {
    document.body.innerHTML = "";
    expect(initCommandsPanel(makeOptions([]))).toBeNull();
  });

  it("lists commands by name with their text, marking those sent without Enter", async () => {
    await panelWith(makeOptions([]));
    expect(rows().map((r) => r.querySelector(".command-item-name")?.textContent)).toEqual(["Restart", "uptime"]);
    expect(rows()[0]?.querySelector(".command-item-text")?.textContent).toBe("sudo systemctl restart ");
    expect(rows()[0]?.querySelector(".command-item-no-enter")?.hasAttribute("hidden")).toBe(false);
    expect(rows()[1]?.querySelector(".command-item-no-enter")?.hasAttribute("hidden")).toBe(true);
  });

  it("previews only the first line of a multi-line command", async () => {
    await panelWith(makeOptions([]), [{ ...uptime, text: "cd /tmp\nls" }]);
    expect(rows()[0]?.querySelector(".command-item-text")?.textContent).toBe("cd /tmp …");
  });

  it("says when the library is empty", async () => {
    await panelWith(makeOptions([]), []);
    expect(document.querySelector(".sidebar-empty")?.textContent).toBe("No saved commands yet — + to add one.");
  });

  it("keeps the list it has when reloading fails, and reports it", async () => {
    const options = makeOptions([]);
    const panel = await panelWith(options);
    ipc.listCommands.mockRejectedValueOnce({ code: "Io", message: "busy" });
    await panel?.reload();
    expect(rows()).toHaveLength(2);
    expect(options.onError).toHaveBeenCalledWith("busy");
  });
});

describe("commands panel sending", () => {
  it("sends to the one target without asking, then hands focus back", async () => {
    const pane = target("NAS");
    const options = makeOptions([pane]);
    await panelWith(options);
    click(rows()[1]!, ".command-item-send");
    await flush();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(pane.send).toHaveBeenCalledWith("uptime\r");
    expect(options.afterSend).toHaveBeenCalled();
  });

  it("sends once on a double click", async () => {
    const pane = target("NAS");
    await panelWith(makeOptions([pane]));
    const send = rows()[1]!.querySelector<HTMLElement>(".command-item-send")!;
    send.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
    send.dispatchEvent(new MouseEvent("click", { detail: 2, bubbles: true }));
    await flush();
    expect(pane.send).toHaveBeenCalledTimes(1);
  });

  it("ignores a second click while the first still waits for its confirm", async () => {
    const panes = [target("NAS"), target("Pi")];
    let answer: (yes: boolean) => void = () => {};
    confirmMock.mockImplementationOnce(() => new Promise<boolean>((resolve) => (answer = resolve)));
    await panelWith(makeOptions(panes));
    click(rows()[0]!, ".command-item-send");
    click(rows()[0]!, ".command-item-send");
    answer(true);
    await flush();
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(panes[0]!.send).toHaveBeenCalledTimes(1);
  });

  it("asks before sending to several panes, naming them", async () => {
    const panes = [target("NAS"), target("Pi")];
    await panelWith(makeOptions(panes));
    click(rows()[0]!, ".command-item-send");
    await flush();
    expect(confirmMock).toHaveBeenCalledWith('Send "Restart" to 2 panes (NAS, Pi)?', expect.anything());
    for (const pane of panes) expect(pane.send).toHaveBeenCalledWith("sudo systemctl restart ");
  });

  it("sends nothing when the user declines", async () => {
    const panes = [target("NAS"), target("Pi")];
    confirmMock.mockResolvedValueOnce(false);
    await panelWith(makeOptions(panes));
    click(rows()[0]!, ".command-item-send");
    await flush();
    for (const pane of panes) expect(pane.send).not.toHaveBeenCalled();
  });

  it("sends only to the panes the user confirmed, not to one that connected meanwhile", async () => {
    const nas = target("NAS");
    const pi = target("Pi");
    const late = target("Late");
    let targets: CommandTarget[] = [nas, pi];
    const options = { ...makeOptions([]), getTargets: () => targets };
    confirmMock.mockImplementationOnce(async () => {
      targets = [nas, pi, late];
      return true;
    });
    await panelWith(options);
    click(rows()[0]!, ".command-item-send");
    await flush();
    expect(nas.send).toHaveBeenCalled();
    expect(pi.send).toHaveBeenCalled();
    expect(late.send).not.toHaveBeenCalled();
  });

  it("explains when there is no connected pane to send to", async () => {
    const options = makeOptions([]);
    await panelWith(options);
    click(rows()[0]!, ".command-item-send");
    await flush();
    expect(options.onInfo).toHaveBeenCalledWith(
      "No connected pane to send to: focus a connected pane, or turn on Broadcast",
    );
  });
});

describe("commands panel editing", () => {
  it("saves a new command from the dialog and lists it", async () => {
    const options = makeOptions([]);
    await panelWith(options, []);
    const created = { ...uptime };
    dialogMock.mockResolvedValueOnce({ ...created, id: "" });
    ipc.saveCommand.mockResolvedValueOnce(created);
    ipc.listCommands.mockResolvedValueOnce([created]);
    click(document, ".command-add-btn");
    await flush();
    expect(dialogMock).toHaveBeenCalledWith({ id: "", name: "", text: "", run: true });
    expect(ipc.saveCommand).toHaveBeenCalledWith({ ...created, id: "" });
    expect(options.onSuccess).toHaveBeenCalledWith('Saved command "uptime"');
    expect(rows()).toHaveLength(1);
  });

  it("edits a command in place and saves nothing on cancel", async () => {
    await panelWith(makeOptions([]));
    click(rows()[1]!, ".command-item-edit");
    await flush();
    expect(dialogMock).toHaveBeenCalledWith(uptime);
    expect(ipc.saveCommand).not.toHaveBeenCalled();
  });

  it("opens one editor at a time", async () => {
    await panelWith(makeOptions([]));
    dialogMock.mockImplementationOnce(() => new Promise(() => {}));
    click(document, ".command-add-btn");
    click(document, ".command-add-btn");
    await flush();
    expect(dialogMock).toHaveBeenCalledTimes(1);
  });

  it("reports a failed save", async () => {
    const options = makeOptions([]);
    await panelWith(options);
    dialogMock.mockResolvedValueOnce(uptime);
    ipc.saveCommand.mockRejectedValueOnce({ code: "Validation", message: "bad" });
    click(rows()[1]!, ".command-item-edit");
    await flush();
    expect(options.onError).toHaveBeenCalledWith("bad");
  });

  it("deletes a command once confirmed", async () => {
    const options = makeOptions([]);
    await panelWith(options);
    ipc.listCommands.mockResolvedValueOnce([restart]);
    click(rows()[1]!, ".command-item-delete");
    await flush();
    expect(confirmMock).toHaveBeenCalledWith('Delete command "uptime"? This cannot be undone.', expect.anything());
    expect(ipc.deleteCommand).toHaveBeenCalledWith("c1");
    expect(options.onSuccess).toHaveBeenCalledWith('Deleted command "uptime"');
    expect(rows()).toHaveLength(1);
  });

  it("keeps a command when the delete is declined", async () => {
    await panelWith(makeOptions([]));
    confirmMock.mockResolvedValueOnce(false);
    click(rows()[1]!, ".command-item-delete");
    await flush();
    expect(ipc.deleteCommand).not.toHaveBeenCalled();
  });
});

describe("commands panel import/export", () => {
  it("exports to the chosen file", async () => {
    const options = makeOptions([]);
    await panelWith(options);
    ipc.exportCommands.mockResolvedValueOnce(2);
    click(document, ".command-export-btn");
    await flush();
    expect(files.pickJsonSavePath).toHaveBeenCalledWith("dasshboard-commands.json");
    expect(ipc.exportCommands).toHaveBeenCalledWith("/tmp/out.json");
    expect(options.onSuccess).toHaveBeenCalledWith("Exported 2 commands");
  });

  it("imports from the chosen file and relists", async () => {
    const options = makeOptions([]);
    await panelWith(options, []);
    ipc.importCommands.mockResolvedValueOnce(1);
    ipc.listCommands.mockResolvedValueOnce([uptime]);
    click(document, ".command-import-btn");
    await flush();
    expect(ipc.importCommands).toHaveBeenCalledWith("/tmp/in.json");
    expect(options.onSuccess).toHaveBeenCalledWith("Imported 1 command");
    expect(rows()).toHaveLength(1);
  });

  it("does nothing when the file picker is cancelled, and reports a failed import", async () => {
    const options = makeOptions([]);
    await panelWith(options);
    files.pickJsonOpenPath.mockResolvedValueOnce(null);
    click(document, ".command-import-btn");
    await flush();
    expect(ipc.importCommands).not.toHaveBeenCalled();

    ipc.importCommands.mockRejectedValueOnce({ code: "Validation", message: "bad file" });
    click(document, ".command-import-btn");
    await flush();
    expect(options.onError).toHaveBeenCalledWith("bad file");
  });
});

describe("commands panel language change", () => {
  it("re-renders its copy", async () => {
    const { setLocale } = await import("../i18n");
    const panel = await panelWith(makeOptions([]));
    setLocale("fr");
    panel?.retranslate();
    expect(document.querySelector(".sidebar-section-title-text")?.textContent).toBe("Commandes");
    setLocale("en");
  });
});
