/** @vitest-environment happy-dom */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PanelShell } from "./panelShell";

function setup(withSplitter = true) {
  document.body.innerHTML = `
    <button id="sftp-btn" aria-pressed="false"></button>
    <div class="workspace-row"><div class="sftp-splitter" hidden></div><aside class="sftp-panel" hidden></aside></div>`;
  const root = document.querySelector<HTMLElement>(".sftp-panel") as HTMLElement;
  const splitter = withSplitter ? document.querySelector<HTMLElement>(".sftp-splitter") : null;
  const hooks = { onResize: vi.fn(), onCommit: vi.fn() };
  return { root, splitter, hooks, shell: new PanelShell(root, splitter, hooks) };
}

const pressed = (): string | null | undefined => document.querySelector("#sftp-btn")?.getAttribute("aria-pressed");

describe("PanelShell", () => {
  beforeEach(() => {
    document.documentElement.style.fontSize = "";
  });

  it("starts hidden at the default width (22.5rem)", () => {
    const { root, shell } = setup();
    shell.apply();
    expect(root.hidden).toBe(true);
    expect(pressed()).toBe("false");
    expect(shell.layout.width()).toBe(360);
  });

  it("shows an open panel with its width, splitter and pressed toggle", () => {
    const { root, splitter, shell } = setup();
    shell.layout.show();
    shell.apply();
    expect(root.hidden).toBe(false);
    expect(root.style.width).toBe("360px");
    expect(splitter?.hidden).toBe(false);
    expect(pressed()).toBe("true");
  });

  it("collapses to the rail: no inline width, no splitter", () => {
    const { root, splitter, shell } = setup();
    shell.layout.show();
    shell.layout.setCollapsed(true);
    shell.apply();
    expect(root.classList.contains("sftp-collapsed")).toBe(true);
    expect(root.style.width).toBe("");
    expect(splitter?.hidden).toBe(true);
  });

  it("restores a saved width clamped to 22rem..125rem", () => {
    const { shell } = setup();
    expect(shell.restore({ open: true, collapsed: false, width: 10, deviceId: null })).toBe(true);
    expect(shell.layout.width()).toBe(352);
    shell.restore({ open: false, collapsed: false, width: 99_999, deviceId: null });
    expect(shell.layout.width()).toBe(2000);
  });

  it("wires the splitter once; a reset resizes the panel and commits", () => {
    const { root, splitter, hooks, shell } = setup();
    shell.wireSplitter();
    shell.wireSplitter();
    splitter?.dispatchEvent(new MouseEvent("dblclick"));
    // The workspace has no width here, so the reset clamps to the minimum.
    expect(hooks.onResize).toHaveBeenCalledOnce();
    expect(hooks.onCommit).toHaveBeenCalledOnce();
    expect(root.style.width).toBe("352px");
    expect(shell.layout.width()).toBe(352);
  });

  it("works without a splitter", () => {
    const { root, shell } = setup(false);
    shell.wireSplitter();
    shell.layout.show();
    shell.apply();
    expect(root.hidden).toBe(false);
  });
});
