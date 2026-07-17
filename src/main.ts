import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ping } from "./ipc";
import { formatPingMessage } from "./version";

/** Calls the `ping` command and renders the result (proves IPC round trip). */
function initVersionBanner(): void {
  const el = document.querySelector<HTMLElement>("#version-banner");
  if (!el) return;

  ping()
    .then((version) => {
      el.textContent = formatPingMessage(version);
    })
    .catch((error: unknown) => {
      el.textContent = `DaSSHboard: ping failed (${String(error)})`;
    });
}

/**
 * A placeholder xterm.js terminal with local echo only — no SSH/PTY yet
 * (that lands in Phase 2). Proves the xterm bundle + fit addon work end to
 * end inside the Tauri webview.
 */
function initEchoTerminal(): void {
  const container = document.querySelector<HTMLElement>("#terminal");
  if (!container) return;

  const terminal = new Terminal({
    convertEol: true,
    cursorBlink: true,
    fontFamily: '"Cascadia Mono", Consolas, monospace',
    fontSize: 14,
    theme: {
      background: "#1e1e1e",
      foreground: "#d4d4d4",
    },
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(container);
  fitAddon.fit();

  terminal.onData((data) => {
    terminal.write(data);
  });

  terminal.writeln("DaSSHboard placeholder terminal (local echo only)");
  terminal.writeln(
    "Type here — keystrokes are echoed locally, no backend involved yet.",
  );

  const resizeObserver = new ResizeObserver(() => {
    fitAddon.fit();
  });
  resizeObserver.observe(container);
}

window.addEventListener("DOMContentLoaded", () => {
  initVersionBanner();
  initEchoTerminal();
});
