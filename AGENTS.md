# AGENTS.md

DaSSHboard is a desktop SSH dashboard. The user saves devices, puts live
terminals in a grid, and reloads the workspace with one click.
Stack: Tauri 2 (Rust backend), Vite + vanilla TypeScript frontend, xterm.js.

READMEs:

- `README.md` — for users (features, security, download).
- `apps/desktop/README.md` — for developers (setup, architecture, tests, data
  files, release).
- `apps/website/README.md` — website development and deploy.

## Monorepo

- `apps/desktop/` — the Tauri app. It has its own `package.json` and lockfile.
- `apps/website/` — static Astro site on GitHub Pages
  (`https://that-one-tool.github.io/dasshboard/`, `base: "/dasshboard"`). It has
  its own `package.json` and lockfile.
    - It imports nothing from the desktop app, except the version
      (`src/lib/appVersion.ts` reads `tauri.conf.json`). Tokens, font and icon
      are copies.
    - One page per desktop locale, built by `components/HomePage.astro`.
    - Text is in `src/i18n/`. `en.ts` is the source of truth. `i18n.test.ts`
      makes sure all locales have the same structure.
    - `components/Screenshot.astro` shows `src/assets/screenshots/<slot>.*`.
      If there is no file, it shows the CSS mockup in `components/mocks/`.
- Root `package.json` — scripts only, no dependencies.
- CI (`.github/workflows/`):
    - `ci.yml` — pull requests. Runs `desktop-check.yml` and/or
      `site-check.yml` by path. `ci-ok` is the only required check.
    - `desktop-release.yml` — push to `main` in `apps/desktop/**`.
      `.github/scripts/release-gate.sh` decides the release (tests:
      `release-gate.test.sh`). Also builds the signed Flatpak repo.
    - `site-deploy.yml` — push to `main` in `apps/website/**`, or after a
      desktop release. Deploys the site with the latest Flatpak repo in
      `flatpak/`.
- Commit scopes: `(site)` for the website (no desktop release). All other
  scopes, or no scope, are for the desktop app.

## Desktop layout (`apps/desktop/`)

### Frontend (`src/`, TypeScript, no framework)

- `main.ts` — bootstrap. Later parts register with earlier parts (listeners),
  not with late-bound callbacks.
- `app/liveViews` — the list of long-lived views. Device changes, config
  reloads and language changes go to these views.
- `grid.ts`, `gridModel.ts` — the pane grid.
- `terminal/` — terminal pane and its parts (`pane/`): overlay, reconnect,
  paste, host-key and auth-prompt dialogs, search bar, links, save output,
  output recording.
  `inputQueue` and `outputReader` keep input and output in order.
- `devices/` — device editor, validation, port-forward editor, import risks.
- `tunnels/` — Tunnels sidebar card (start/stop forwards, status, reconnect).
- `sftp/` — Files panel (browser, transfer queue, bookmarks, edit in place).
- `tabs/` — tabs. Each tab keeps its `Grid` and sessions alive.
- `profiles/` — saved workspaces.
- `commandLibrary/` — Commands sidebar card and editor. A command goes to the
  focused pane, or to all connected panes during broadcast.
- `settings/` — settings dialog, theme toggle, known-hosts dialog.
- `tray/` — sends translated tray labels to the backend.
- `updates/` — update check and install, About dialog badge.
- `i18n/` — `t`/`tp` and one table per locale. `en.ts` is the source of truth.
- `layout/` — resizable sidebar and its collapsed bar.
- `ui/` — shared dialogs, toasts, DOM helpers, splitter, shortcut keys,
  dialog stack (only the newest dialog gets Escape/Enter).
- `ipc/` — typed `invoke` wrappers, one module per domain. Import them from
  the `ipc/index.ts` barrel. Each payload type must be the same as its Rust
  `serde` struct (camelCase).

Some frontend rules mirror backend rules (validation, settings clamps). When
you change one side, change the other side too.

### Backend (`src-tauri/src/`, Rust)

- `commands/` — `#[tauri::command]` handlers, one module per domain.
  Register them in `lib.rs`.
- `device.rs`, `profile.rs`, `settings.rs` — domain models.
- Stores (`store`, `profile_store`, `known_hosts`, `bookmark_store`,
  `command_library`, `workspace_store`) — JSON files in the app-config dir.
  All use `atomic_file.rs` for safe write, backup and recovery.
- `known_hosts.rs` — host-key TOFU store. If the file is damaged or
  unreadable, unknown hosts are `Unverifiable` (loud prompt).
- `workspace*.rs` — open tabs, restored at launch. Per instance.
- `config_watch.rs` — tells the frontend when config files change on disk.
- `secret.rs` — OS keychain.
- `ssh/` — shared SSH connect: parameters, auth (incl. keyboard-interactive),
  prompts, connect deadline, host-key handler, jump host.
- `session_sink.rs` — how a terminal session (SSH, serial, local) reports to
  the frontend.
- `session.rs` — SSH shells. `serial.rs` — serial ports. `local_shell.rs` —
  local PTY shells.
- `output_stream.rs` — terminal output, kept until the frontend reads it.
- `session_recording.rs` — records a session's raw output to a file.
- `tunnel.rs` — local, dynamic and remote port forwards.
  `remote_forward.rs` — remote forward routes. `socks.rs` — SOCKS server.
  `relay.rs` — moves data between a socket and a channel.
- `sftp.rs` — SFTP. `sftp_edit.rs` — edit in place. `editor.rs` — opens the
  file in a text editor (never with the default action).
- `agent.rs`, `agent_ident.rs` — SSH agent forwarding and agent auth.
- `ssh_config.rs` — import/export `~/.ssh/config`.
- `transfer.rs` — import/export. A devices import shows its risks first.
- `updater.rs` — in-app updates. Runs only when the user asks or opts in.
- `tray.rs` — opt-in close to tray. `app_menu.rs` — macOS menu bar.
- `main_window.rs` — main window (clipboard access). `flatpak.rs`,
  `wayland.rs` — platform workarounds.
- `state.rs` — `AppState`. `error.rs` — `AppError`.

### Other

- `src-tauri/tests/` — SSH and SFTP integration tests with an in-process
  `russh` server. No Docker.
- `flatpak/` — Flatpak manifest (repackages the `.deb`), desktop file,
  metainfo, `build-repo.sh`. App id `io.github.that_one_tool.DaSSHboard`.

## Commands

Run from the repo root, or with the same names in `apps/desktop/` or
`apps/website/`:

```sh
npm run dev          # vite dev server
npm run tauri dev    # full app, hot reload
npm run check        # desktop gate: tsc, eslint, vitest + coverage,
                     # cargo fmt --check, cargo test, cargo clippy -D warnings
npm test             # vitest
npm run coverage     # vitest + coverage (floor in vite.config.ts)
npm run site:dev     # website (http://localhost:4321/dasshboard/)
npm run site:check   # website gate: astro check, vitest, astro build
npm run check:all    # both gates
```

## Rules

- Use TDD. Write the failing test first. Then make it pass.
- After each change, run the gate: `npm run check` (desktop),
  `npm run site:check` (website), or `npm run check:all` (both). Fix all
  failures before you continue.
- Do not commit or push. The user does this.
- Make minimal changes. Ask before you change files outside the task.
- Do not guess. If a requirement or design choice is not clear, ask. If two
  approaches are good, show both and let the user choose.
- Keep functions small, with one purpose. Cyclomatic complexity must be < 4.
- Quality limits only get stricter:
    - Do not add to `eslint-suppressions.json`. After a fix, prune it with
      `npx eslint . --prune-suppressions`.
    - Do not increase the limits in `src-tauri/clippy.toml`.
    - Do not decrease the coverage floor in `vite.config.ts`. Increase it
      when coverage increases.
    - Suppressions are counts per file and rule. Keep new code inside the
      limits, also in files with suppressions.
- Do not use px for sizes (width, height, min/max, flex-basis, grid tracks,
  `<img>`/SVG size). Use rem for components, em in media queries, and
  %/vw/vh with `min()`/`clamp()` for layout. In the desktop app, use the
  `.icon` / `.icon-lg` classes for icons. If script needs px, use `remToPx`
  (`ui/dom.ts`).
- Use clear names. Write a comment only to explain a non-obvious why.
- Give each new `.ts` module a `*.test.ts` in the same folder. Exceptions:
  `main.ts`, and `i18n/` (one `i18n.test.ts`).
- When a change affects a README or this file, update it. Keep READMEs short.
  The root README is for users (one line per feature). Code structure goes
  in this file, not in a README.

## Security

- Keep secrets (passwords, key passphrases) only in the OS keychain (service
  `DaSSHboard`). Never write them to a config file.
- A secret goes from frontend to backend only when the user saves a device.
  The backend never sends a secret to the frontend.
- Host keys are trust-on-first-use. A changed key must show a loud warning.
  The user must accept it before the connection continues.
- Keep the Tauri CSP strict. Load no remote content.
- The website also loads no remote content. Bundle all fonts and images.
