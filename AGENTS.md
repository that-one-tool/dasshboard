# AGENTS.md

DaSSHboard is a desktop SSH dashboard: save devices once, arrange live terminals
in a grid, reload the whole workspace with a click. Tauri 2 (Rust backend) +
Vite/vanilla-TypeScript frontend, terminals rendered with xterm.js.

See `README.md` for features, prerequisites, and data-file layout.

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
  - `profiles/` — workspace/profile persistence
  - `settings/` — app settings controller
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
    that every store (`store`, `profile_store`, `settings`, `known_hosts`)
    delegates to; each store keeps only its own wrapper type + domain logic
  - `known_hosts.rs` — host-key TOFU store
  - `secret.rs` — OS keychain access; secrets never touch the JSON stores
  - `session.rs` — SSH shell sessions via `russh`
  - `tunnel.rs` — SSH local port forwarding (`ssh -L`); reuses `session.rs`'s
    connect + auth + host-key-TOFU path, then binds a local `TcpListener` per
    forward and pumps each connection over a `direct-tcpip` channel
  - `serial.rs` — serial/COM sessions via `tokio-serial`, reusing
    `session.rs`'s `SessionSink`/`SessionStatus`; the byte pump is
    stream-generic so it unit-tests against an in-memory pipe (no COM port)
  - `local_shell.rs` — local PTY shells (PowerShell/bash/zsh) via `portable-pty`,
    reusing the same `SessionSink`/`SessionStatus` seam; bridges the crate's
    blocking reader/writer to the async sink with reader/writer threads + a
    control task
  - `transfer.rs` — devices/profiles import-export
  - `state.rs` — `AppState` (managed Tauri state), `error.rs` — `AppError`
  - `ssh_it.rs` (test-only) — integration tests against an in-process throwaway
    `russh` server, no Docker/external daemon needed

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
- Let names carry meaning; add comments only when the *why* isn't obvious from
  the code (a constraint, a workaround, a non-obvious invariant).
- Every `.ts` module has a colocated `*.test.ts` — keep that pairing when
  adding new modules.
- Update `README.md` (and this file, if structure/workflow changes) whenever a
  change affects what they document.

## Security invariants

- Secrets (passwords, key passphrases) live only in the OS keychain (service
  `DaSSHboard`), never in `devices.json` or any other config file.
- A secret crosses the frontend↔backend boundary only when saving a device;
  the backend never sends secret material back to the frontend.
- Host keys are trust-on-first-use; a changed key must raise a loud warning
  and require explicit accept before connecting.
- Keep the Tauri CSP strict; load no remote content.
- The website also loads no remote content (fonts and images are bundled).
