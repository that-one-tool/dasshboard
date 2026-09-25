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
- Root `package.json` holds convenience scripts only (no dependencies).
- CI (`.github/workflows/`):
    - `ci.yml` — pull requests; path-filters to `desktop-check.yml` and/or
      `site-check.yml`; `ci-ok` always runs and is the single required check.
    - `desktop-release.yml` — push to `main` under `apps/desktop/**`; release
      decision in `.github/scripts/release-gate.sh` (tested by
      `release-gate.test.sh`).
    - `site-deploy.yml` — push to `main` under `apps/website/**`, or after a
      successful desktop `release` run; deploys to GitHub Pages.
- Commit scopes: `(site)` for website changes — it never cuts a desktop
  release; `(desktop)`, unscoped, or any other scope for the desktop app.

## Stack & layout (`apps/desktop/`)

- `src/` — frontend (TypeScript, no framework):
    - `grid.ts` / `gridModel.ts` — multi-pane grid layout
    - `terminal/` — pane, overlay, reconnect, paste, host-key dialog, terminal settings
    - `devices/` — device CRUD, validation, save payloads, the port-forward
      editor; the dialog is split into `deviceManager` (controller: events +
      backend calls + list), `deviceDialogTemplate` (markup), and `deviceForm`
      (form DOM read/populate/toggle helpers)
    - `tunnels/` — the Tunnels sidebar card (start/stop/status for local forwards)
    - `sftp/` — the docked Files panel (browser + transfer queue)
    - `tabs/` — tab strip + per-tab workspaces (every tab's `Grid` stays alive;
      hidden tabs keep their sessions running and refit on activation)
    - `profiles/` — workspace/profile persistence
    - `settings/` — app settings controller, known-hosts dialog
    - `i18n/` — dependency-free `t`/`tp` runtime + one message table per locale;
      `en.ts` is the source of truth and types the keys
    - `ui/` — confirm dialogs, file dialog, icons, toast notifications (`toast.ts`),
      shared DOM helpers (`dom.ts`)
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
    - `tunnel.rs` — SSH local port forwarding (`ssh -L`); reuses `session.rs`'s
      connect + auth + host-key-TOFU path, then binds a local `TcpListener` per
      forward and pumps each connection over a `direct-tcpip` channel
    - `sftp.rs` — SFTP browse/transfer over `russh-sftp`, reusing the same
      connect path
    - `agent.rs` — SSH agent forwarding (relays the remote's agent channels to
      the local agent); `agent_ident.rs` — agent identity listing + agent-backed auth
    - `ssh_config.rs` — import/export devices ↔ `~/.ssh/config`
    - `serial.rs` — serial/COM sessions via `tokio-serial`, reusing
      `session.rs`'s `SessionSink`/`SessionStatus`; the byte pump is
      stream-generic so it unit-tests against an in-memory pipe (no COM port)
    - `local_shell.rs` — local PTY shells (PowerShell/bash/zsh) via `portable-pty`,
      reusing the same `SessionSink`/`SessionStatus` seam; bridges the crate's
      blocking reader/writer to the async sink with reader/writer threads + a
      control task
    - `transfer.rs` — devices/profiles import-export
    - `state.rs` — `AppState` (managed Tauri state), `error.rs` — `AppError`
- `src-tauri/tests/` — `ssh_it.rs`, `sftp_it.rs`: integration tests against an
  in-process throwaway `russh` server, no Docker/external daemon needed

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
