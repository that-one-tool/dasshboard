# AGENTS.md

DaSSHboard is a desktop SSH dashboard: save devices once, arrange live terminals
in a grid, reload the whole workspace with a click. Tauri 2 (Rust backend) +
Vite/vanilla-TypeScript frontend, terminals rendered with xterm.js.

READMEs: root `README.md` (user-facing: features, security, download),
`apps/desktop/README.md` (developer guide: setup, architecture, testing, data
files, releasing),
`apps/website/README.md` (site dev + deploy).

## Monorepo

- `apps/desktop/` — the Tauri desktop app (everything under "Stack & layout"
  below is relative to it). Own `package.json` + lockfile.
- `apps/website/` — the product website: Astro, fully static, deployed to GitHub
  Pages at `https://that-one-tool.github.io/dasshboard/` (`base: "/dasshboard"`).
  Own `package.json` + lockfile. `src/lib/appVersion.ts` reads the desktop
  version from `../desktop/src-tauri/tauri.conf.json` at build time; the site
  otherwise imports nothing from the desktop app (tokens/font/icon are copies).
  One page per desktop locale (`pages/index.astro` = en, `pages/[locale]/` =
  the rest) rendered by `components/HomePage.astro` from one component per
  section; copy lives in `src/i18n/` (`en.ts` is the source of truth,
  `i18n.test.ts` enforces identical structure). `components/Screenshot.astro`
  shows `src/assets/screenshots/<slot>.*` when present, else the slot's CSS
  mockup from `components/mocks/`.
- Root `package.json` holds convenience scripts only (no dependencies).
- CI (`.github/workflows/`):
    - `ci.yml` — pull requests; path-filters to `desktop-check.yml` and/or
      `site-check.yml`; `ci-ok` always runs and is the single required check.
    - `desktop-release.yml` — push to `main` under `apps/desktop/**`; release
      decision in `.github/scripts/release-gate.sh` (tested by
      `release-gate.test.sh`); its `flatpak` job turns the Linux `.deb` into a
      signed Flatpak repo, attached to the GitHub release by `flatpak-upload`.
    - `site-deploy.yml` — push to `main` under `apps/website/**`, or after a
      successful desktop `release` run; deploys to GitHub Pages, with the
      newest release's Flatpak repo unpacked under `flatpak/` (`site-check.yml`).
- Commit scopes: `(site)` for website changes — it never cuts a desktop
  release; `(desktop)`, unscoped, or any other scope for the desktop app.

## Stack & layout (`apps/desktop/`)

- `src/` — frontend (TypeScript, no framework):
    - `grid.ts` / `gridModel.ts` — multi-pane grid layout
    - `terminal/` — pane, overlay, reconnect, paste, host-key dialog, terminal
      settings, `terminalReplies` (keeps xterm's own query replies / mouse
      reports out of broadcast input), `searchBar` (find bar over the
      scrollback, Ctrl+Shift+F / Cmd+F), `links` (Ctrl/Cmd+click opens an
      http(s) URL or OSC 8 link via the opener plugin), `scrollbackText`
      ("save output": buffer → plain text + suggested file name)
    - `devices/` — device CRUD, validation, save payloads, the port-forward
      editor; the dialog is split into `deviceManager` (controller: events +
      backend calls + list), `deviceDialogTemplate` (markup), and `deviceForm`
      (form DOM read/populate/toggle helpers)
    - `tunnels/` — the Tunnels sidebar card (start/stop all or one forward,
      device status icon + per-forward status dots; backend calls serialized per
      device; a connection-settings edit restarts the running tunnel)
    - `sftp/` — the docked Files panel (browser + transfer queue); edit in
      place: `editSessions` (DOM-free: open/sync/conflict/stop per edit,
      transfers through the queue; uploads are not cancellable) and
      `editList` (the "Synced with the server" list; it says an edit lasts
      until ×, since closing the editor can't be detected)
    - `tabs/` — tab strip + per-tab workspaces (every tab's `Grid` stays alive;
      hidden tabs keep their sessions running and refit on activation);
      `tabShortcuts` maps the tab keys (incl. Cmd+W on macOS)
    - `profiles/` — workspace/profile persistence
    - `settings/` — app settings controller (dialog with General / Connections
      tabs via `settingsTabs`; numeric fields clamped by `settingsBounds`,
      mirroring the backend clamps), the header dark/light toggle (`themeToggle`),
      known-hosts dialog
    - `tray/` — pushes the translated tray menu labels (incl. the pluralized
      live-connection count) to the backend on count/locale change
    - `updates/` — update controller (check/confirm/install), the update
      block in the About dialog, and the About-button badge
    - `i18n/` — dependency-free `t`/`tp` runtime + one message table per locale;
      `en.ts` is the source of truth and types the keys
    - `layout/` — the resizable left menu (`sidebarResize`; width persisted per
      window in `workspace_state.json`) and its collapsed thin bar
      (`sidebarRail`: », connected-device and running-forward count chips,
      Ctrl+Shift+B / Cmd+B; collapsed state persisted alongside the width)
    - `ui/` — confirm dialogs, file dialog, icons, toast notifications (`toast.ts`),
      shared DOM helpers (`dom.ts`), the resize handle shared by the left menu and
      the Files panel (`splitter.ts`: drag, arrow keys, double-click reset),
      shortcut modifiers (`keyboard.ts`: Ctrl, or Cmd on macOS)
    - `ipc.ts` — typed `invoke` wrappers; every payload type here must mirror the
      matching Rust `serde` struct (camelCase on the wire)
- `src-tauri/src/` — backend (Rust):
    - `commands.rs` — `#[tauri::command]` handlers, registered in `lib.rs`
    - `device.rs`, `profile.rs`, `settings.rs` — domain models
    - `store.rs`, `profile_store.rs` — JSON persistence in the Tauri app-config dir
    - `atomic_file.rs` — shared JSON-store plumbing (atomic write-then-rename,
      corrupt-file backup, missing/corrupt read-recovery, poison-recovering lock)
      that every store (`store`, `profile_store`, `settings`, `known_hosts`,
      `bookmark_store`, `workspace_store`) delegates to; each store keeps only
      its own wrapper type + domain logic
    - `known_hosts.rs` — host-key TOFU store
    - `bookmark_store.rs` — per-device SFTP bookmarks (`sftp_bookmarks.json`)
    - `workspace.rs`, `workspace_store.rs` — open tabs restored on launch
      (`workspace_state.json`); per-instance, not reloaded by the config watcher
    - `config_watch.rs` — watches the app-config dir and emits `config_changed`
      so a second running instance picks up on-disk changes
    - `secret.rs` — OS keychain access; secrets never touch the JSON stores
    - `session.rs` — SSH shell sessions via `russh`
    - `tunnel.rs` — SSH local (`ssh -L`), dynamic (`ssh -D`) and remote
      (`ssh -R`) port forwarding; reuses `session.rs`'s connect + auth +
      host-key-TOFU path, then binds a local `TcpListener` per forward (added/removed one at a time
      on the live connection; the last one removed ends it) and pumps each connection
      over a `direct-tcpip` channel (to the fixed target, or the one a dynamic
      forward's SOCKS client names); a remote forward instead asks the server
      to listen (`tcpip-forward`)
    - `remote_forward.rs` — the remote forwards' routes (server port → local
      target, shared with the tunnel's `SshHandler`): each `forwarded-tcpip`
      channel is accepted only once its local target answers, and a port no
      forward asked for is rejected; each route belongs to one forward and is
      released with it (also on a refused or timed-out listen), which closes
      its connections
    - `socks.rs` — server side of the SOCKS4/4a/5 handshake (no-auth,
      `CONNECT` only) for dynamic forwards; stream-generic, unit-tested
      against an in-memory pipe
    - `sftp.rs` — SFTP browse/transfer over `russh-sftp`, reusing the same
      connect path
    - `sftp_edit.rs` — edit in place: per-edit `0700` dir in the app cache dir
      (`<id>/copy/<remote name, made portable>` plus scratch files every
      transfer goes through, so digests match the bytes moved), a debounced
      `notify` watch on `copy/` (editors save by rename), and the sync
      baseline (remote size+mtime, local content digest) behind check / upload
      / discard. Uploads truncate in place, never delete the remote, and after
      a failure stop comparing the remote (our own partial write is no
      conflict); an edit registers only while its connection exists; a
      startup sweep deletes copies untouched for 24 h (crash leftovers)
    - `editor.rs` — opens an edit's copy: the settings editor command (split
      without a shell, `{file}` placeholder; `flatpak-spawn --host` in
      Flatpak), else a text editor — never the file's default action, which
      on Windows would run a `.bat`/`.exe` (Notepad; `open -t` on macOS;
      `xdg-open` on Linux)
    - `agent.rs` — SSH agent forwarding (relays the remote's agent channels to
      the local agent); `agent_ident.rs` — agent identity listing + agent-backed auth
    - `ssh_config.rs` — import/export devices ↔ `~/.ssh/config`
    - `serial.rs` — serial/COM sessions via `tokio-serial`, reusing
      `session.rs`'s `SessionSink`/`SessionStatus`; the byte pump is
      stream-generic so it unit-tests against an in-memory pipe (no COM port)
    - `local_shell.rs` — local PTY shells (PowerShell/bash/zsh) via `portable-pty`,
      reusing the same `SessionSink`/`SessionStatus` seam; bridges the crate's
      blocking reader/writer to the async sink with reader/writer threads + a
      control task; on macOS the default shell runs as a login shell with a
      UTF-8 `LANG` fallback; inside Flatpak the shell runs on the host via
      `flatpak-spawn --host`, the PTY left free to be its controlling tty
    - `flatpak.rs` — Flatpak sandbox detection and the host-visible runtime dir
      (where the tray icon image goes)
    - `wayland.rs` — Linux Wayland workarounds: the window-state flags (no
      size/position on Wayland, where the plugin's restore made the window
      grow every launch until GDK crashed) and `__NV_DISABLE_EXPLICIT_SYNC`
      (NVIDIA + WebKitGTK "Error 71"), set first thing in `run()`
    - `transfer.rs` — devices/profiles import-export
    - `updater.rs` — in-app updates via `tauri-plugin-updater` (CrabNebula
      endpoints): check → download → install, each naming the confirmed
      version; runs only on user request or opt-in launch check; self-install
      for NSIS/MSI + AppImage + a real macOS `.app` (keyed on the bundle type;
      an unbundled macOS dev binary is notify-only), notify-only for
      `.deb`/`.rpm` (and Flatpak, which says `flatpak update`); the install
      closes live sessions first
      (`AppState::shutdown_live_sessions`, shared with app close and quit)
    - `tray.rs` — opt-in close-to-tray: a lazily built tray icon (disabled
      live-connection count, Show, Quit; a monochrome template image on macOS,
      `icons/tray-template.png`), the window-close decision (hide vs.
      disconnect-then-close; never hides without a built tray), and a poller
      emitting `live_session_count`; labels come translated from the frontend.
      Tauri alone holds the icon so its exit cleanup removes it; on Linux the
      AppIndicator library is probed first (tray-icon panics without it)
    - `app_menu.rs` — the macOS menu bar (Tauri's default minus Close Window,
      so Cmd+W closes a tab)
    - `state.rs` — `AppState` (managed Tauri state), `error.rs` — `AppError`
- `src-tauri/tests/` — `ssh_it.rs`, `sftp_it.rs`: integration tests against an
  in-process throwaway `russh` server, no Docker/external daemon needed
- `flatpak/` — Flatpak manifest (repackages the release `.deb` on the GNOME
  runtime, plus libayatana-appindicator from Flathub's shared-modules), the
  `.desktop` file, metainfo, and `build-repo.sh` (signed OSTree repo +
  `.flatpakref`/`.flatpakrepo`); app id `io.github.that_one_tool.DaSSHboard`

## Commands

From the repo root (each delegates to the app's own `package.json`; inside
`apps/desktop/` or `apps/website/` the same script names work directly):

```sh
npm run dev          # vite dev server only
npm run tauri dev    # full app, hot-reload
npm run check        # the full gate — run before considering any task done:
                      # tsc --noEmit && vitest run && cargo fmt --check &&
                      # cargo test && cargo clippy --all-targets -- -D warnings
npm test             # vitest only
npm run site:dev     # website dev server (http://localhost:4321/dasshboard/)
npm run site:check   # website gate: astro check && vitest run && astro build
npm run check:all    # both gates
```

## Working rules

- **TDD**: write/adjust the failing test first, then make it pass.
- Run `npm run check` after every desktop change (`npm run site:check` after
  every website change, `npm run check:all` when both are touched); fix failures before moving on or
  calling a task complete.
- Never commit or push — the user reviews and commits all code themselves.
- Make minimal, scoped changes. Don't refactor or touch files outside the
  task's scope without asking first.
- Never assume: when a requirement, edge case, or design choice is unclear,
  ask rather than guess. If two approaches are both reasonable, present both
  and let the user pick.
- Keep functions small, single-purpose, cyclomatic complexity < 4.
- Keep the UI responsive (desktop app and website): never hardcode a px
  width/height (CSS `width`, `height`, `min-*`/`max-*`, `flex-basis`, grid
  tracks, `<img>`/SVG size attributes). Use rem for component sizes, em in media
  queries, and %/vw/vh with `min()`/`clamp()` for layout; in the desktop app size
  icons with the `.icon` / `.icon-lg` classes, and when script must work in px,
  derive it with `remToPx` (`ui/dom.ts`).
- Let names carry meaning; add comments only when the _why_ isn't obvious from
  the code (a constraint, a workaround, a non-obvious invariant).
- Give each new `.ts` module a colocated `*.test.ts`. Existing exceptions:
  `main.ts` (bootstrap wiring, no test) and `i18n/`, where the locale tables
  and `index.ts` share one `i18n.test.ts`.
- Update the relevant README (and this file, if structure/workflow changes)
  whenever a change affects what they document. Keep READMEs short: the root one
  is for users (one line per feature, no implementation detail), the app ones
  are for developers; code structure belongs here, not in a README.

## Security invariants

- Secrets (passwords, key passphrases) live only in the OS keychain (service
  `DaSSHboard`), never in `devices.json` or any other config file.
- A secret crosses the frontend↔backend boundary only when saving a device;
  the backend never sends secret material back to the frontend.
- Host keys are trust-on-first-use; a changed key must raise a loud warning
  and require explicit accept before connecting.
- Keep the Tauri CSP strict; load no remote content.
- The website also loads no remote content (fonts and images are bundled).
