---
name: desktop-frontend
description: Module map and conventions of the DaSSHboard desktop frontend (apps/desktop/src, vanilla TypeScript). Use when finding, changing or adding frontend code: terminal panes, grid, tabs, dialogs, sidebar cards, styles, UI text, or IPC calls.
---

# Desktop frontend (`apps/desktop/src/`)

Vite + vanilla TypeScript (no framework), xterm.js. Vitest + happy-dom.

## Wiring

- `main.ts` bootstraps. Later parts register with earlier parts (listeners),
  not with late-bound callbacks.
- `app/liveViews` lists the long-lived views. Device changes, config reloads
  and language changes go to these views.

## Modules

- `grid.ts`, `gridModel.ts` — the pane grid. DOM parts in `grid/`: toolbar,
  splitters.
- `terminal/` — terminal pane. Its parts live in `pane/`: overlay, reconnect,
  paste, host-key and auth-prompt dialogs, search bar, links, save output,
  output recording. `inputQueue` and `outputReader` keep input and output in
  order.
- `devices/` — device editor, validation, port-forward editor, import risks.
  `deviceManager` only wires its parts in `manager/`; `form/` reads, fills and
  builds the device dialog's form.
- `tunnels/` — Tunnels sidebar card (start/stop forwards, status, reconnect).
- `sftp/` — Files panel (browser, transfer queue, bookmarks, edit in place).
  `sftpPanel` only wires its parts in `sftp/panel/`.
- `tabs/` — each tab keeps its `Grid` and sessions alive. `tabStrip`,
  `tabRename`: strip buttons and inline rename.
- `profiles/` — saved workspaces.
- `commandLibrary/` — Commands card and editor. A command goes to the focused
  pane, or to all connected panes during broadcast.
- `settings/` — settings dialog, theme toggle, known-hosts dialog.
- `tray/` — sends translated tray labels to the backend.
- `updates/` — update check and install, About dialog badge.
- `layout/` — resizable sidebar and its collapsed bar.
- `ui/` — shared dialogs (`modalDialog`: their open/answer/close lifecycle;
  `sessionTeardown`: the close-live-sessions confirm),
  toasts, DOM helpers (`remToPx`), splitter, shortcut keys, dialog stack (only
  the newest dialog gets Escape/Enter).

## Backend mirrors

- `ipc/` — typed `invoke` wrappers, one module per domain. Import them from the
  `ipc/index.ts` barrel. Each payload type equals its Rust `serde` struct
  (camelCase).
- Device validation and settings clamps mirror backend rules. Change both sides
  together.

## UI text

`i18n/` exports `t`/`tp`. Adding text: `apps/desktop/README.md` (Adding
things).
