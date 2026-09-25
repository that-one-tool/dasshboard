# DaSSHboard desktop

This is the desktop app: [Tauri 2](https://tauri.app/) with a Rust backend, and a
vanilla TypeScript + Vite frontend (no framework) that renders terminals with
[xterm.js](https://xtermjs.org/). It targets Windows and Linux.

## Getting started

Prerequisites:

- [Node.js](https://nodejs.org/) 24+
- Stable [Rust](https://rustup.rs/) (MSVC toolchain on Windows)
- The [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS
  (WebView2 and MSVC build tools on Windows; webkit2gtk and related packages on
  Linux)

You don't need a system NASM install: `aws-lc-rs` uses its `prebuilt-nasm` feature.

```sh
npm ci
npm run tauri dev     # full app with hot-reload
npm run dev           # Vite frontend only, without the backend
npm run check         # the gate: tsc, Vitest, cargo fmt --check, cargo test, clippy -D warnings
npm run tauri build   # installers in src-tauri/target/release/bundle/ (NSIS + MSI, or deb + rpm)
```

From the repo root, `npm run tauri dev` and `npm run check` delegate here.

## Architecture

```
src/  (TypeScript UI)  ──invoke──▶  src-tauri/src/commands.rs  ──▶  domain modules
                       ◀──events──  session_status, host_key_prompt, tunnel_status,
                                    sftp_progress, config_changed
```

- **Frontend (`src/`)**: one folder per feature: `terminal/`, `devices/`, `tabs/`,
  `tunnels/`, `sftp/`, `profiles/`, `settings/`, `i18n/`, plus `ui/` for shared
  widgets. `grid.ts` holds the pane grid and `main.ts` wires everything together.
- **IPC (`src/ipc.ts`)**: typed wrappers for every command and event. Payload
  types mirror the Rust `serde` structs and are camelCase on the wire.
- **Backend (`src-tauri/src/`)**: `commands.rs` holds the handlers (registered in
  `lib.rs`), and each concern has its own module:
    - `session`: SSH shells over `russh`. `tunnel`, `sftp` and `agent` reuse its
      connect, auth and host-key path.
    - `serial` and `local_shell`: plug into the same `SessionSink`/`SessionStatus`
      seam as SSH shells.
    - `*_store`: JSON stores built on `atomic_file` (atomic writes, recovery from
      corrupt files).
    - `secret`: the OS keychain.

[AGENTS.md](../../AGENTS.md) describes the layout module by module.

## Testing

- **Frontend**: Vitest, with happy-dom for the DOM tests. Tests sit next to
  the code as `*.test.ts`.
- **Backend**: unit tests inside each module. `src-tauri/tests/ssh_it.rs` and
  `sftp_it.rs` run integration tests against an in-process `russh` server, so
  you don't need Docker or an SSH daemon.
- The serial byte pump is tested against an in-memory pipe, so you don't need a
  COM port. Local-shell tests spawn a real `cmd.exe` or `/bin/sh`.

## Adding things

- **A backend command**: add the handler in `commands.rs`, register it in
  `lib.rs`, add a typed wrapper in `ipc.ts`, and keep the payload types in sync
  on both sides.
- **UI text**: add the key to `i18n/en.ts` (the source of truth, which also types
  the keys), then translate it in the other six locale files.

## Data

The app stores its data in the Tauri app-config directory
(`%APPDATA%\com.dasshboard.app\` on Windows):

| File                   | Contents                                                                  |
| ---------------------- | ------------------------------------------------------------------------- |
| `devices.json`         | Saved devices (never secrets)                                             |
| `profiles.json`        | Layout profiles and the default profile id                                |
| `settings.json`        | Terminal appearance, language, keepalive, SFTP idle timeout, last profile |
| `known_hosts.json`     | Trusted host keys (TOFU)                                                  |
| `sftp_bookmarks.json`  | SFTP bookmarks for each device                                            |
| `workspace_state.json` | Open tabs, per instance (not synced between running instances)            |

When another running instance changes `devices.json`, `profiles.json`,
`settings.json` or `known_hosts.json`, a file watcher reloads them. Passwords and passphrases are stored only in the OS keychain, under the
service `DaSSHboard` and keyed by device id. The backend never sends them back
to the frontend.

## Releasing

A push to `main` that touches `apps/desktop/**` runs `desktop-release.yml`. It
builds on Windows and Linux and publishes to CrabNebula Cloud when the commit
is a `feat`, `fix` or `perf`, a breaking change, or a `Release vX.Y.Z` commit.
`.github/scripts/release-gate.sh` makes that decision. Before a release, bump
the version in `package.json`, `src-tauri/tauri.conf.json` and
`src-tauri/Cargo.toml`. CI fails if the three don't match.
