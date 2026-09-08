# AGENTS.md

DaSSHboard is a desktop SSH dashboard: save devices once, arrange live terminals
in a grid, reload the whole workspace with a click. Tauri 2 (Rust backend) +
Vite/vanilla-TypeScript frontend, terminals rendered with xterm.js.

See `README.md` for features, prerequisites, and data-file layout.

## Stack & layout

- `src/` — frontend (TypeScript, no framework):
  - `grid.ts` / `gridModel.ts` — multi-pane grid layout
  - `terminal/` — pane, overlay, reconnect, paste, host-key dialog, terminal settings
  - `devices/` — device CRUD, validation, save payloads
  - `profiles/` — workspace/profile persistence
  - `settings/` — app settings controller
  - `ui/` — confirm dialogs, file dialog, icons
  - `ipc.ts` — typed `invoke` wrappers; every payload type here must mirror the
    matching Rust `serde` struct (camelCase on the wire)
- `src-tauri/src/` — backend (Rust):
  - `commands.rs` — `#[tauri::command]` handlers, registered in `lib.rs`
  - `device.rs`, `profile.rs`, `settings.rs` — domain models
  - `store.rs`, `profile_store.rs` — JSON persistence in the Tauri app-config dir
  - `known_hosts.rs` — host-key TOFU store
  - `secret.rs` — OS keychain access; secrets never touch the JSON stores
  - `session.rs` — SSH sessions via `russh`
  - `serial.rs` — serial/COM sessions via `tokio-serial`, reusing
    `session.rs`'s `SessionSink`/`SessionStatus`; the byte pump is
    stream-generic so it unit-tests against an in-memory pipe (no COM port)
  - `transfer.rs` — devices/profiles import-export
  - `state.rs` — `AppState` (managed Tauri state), `error.rs` — `AppError`
  - `ssh_it.rs` (test-only) — integration tests against an in-process throwaway
    `russh` server, no Docker/external daemon needed

## Commands

```sh
npm run dev          # vite dev server only
npm run tauri dev    # full app, hot-reload
npm run check        # the full gate — run before considering any task done:
                      # tsc --noEmit && vitest run && cargo fmt --check &&
                      # cargo test && cargo clippy --all-targets -- -D warnings
npm test             # vitest only
```

## Working rules

- **TDD**: write/adjust the failing test first, then make it pass.
- Run `npm run check` after every change; fix failures before moving on or
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
