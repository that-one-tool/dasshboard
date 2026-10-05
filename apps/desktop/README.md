# DaSSHboard desktop

This is the desktop app: [Tauri 2](https://tauri.app/) with a Rust backend, and a
vanilla TypeScript + Vite frontend (no framework) that renders terminals with
[xterm.js](https://xtermjs.org/). It targets Windows, macOS and Linux.

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
npm run tauri build   # installers in src-tauri/target/release/bundle/ (NSIS + MSI, .app + dmg, or deb + rpm)
```

From the repo root, `npm run tauri dev` and `npm run check` delegate here.

## Architecture

```
src/  (TypeScript UI)  ──invoke──▶  src-tauri/src/commands.rs  ──▶  domain modules
                       ◀──events──  session_status, host_key_prompt,
                                    host_key_prompt_closed, tunnel_status,
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
      connect, auth and host-key path; `tunnel`'s dynamic forwards speak SOCKS
      via `socks`.
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
(`%APPDATA%\com.dasshboard.app\` on Windows,
`~/Library/Application Support/com.dasshboard.app/` on macOS,
`~/.config/com.dasshboard.app/` on Linux,
`~/.var/app/io.github.that_one_tool.DaSSHboard/config/com.dasshboard.app/` in
the Flatpak):

| File                   | Contents                                                                  |
| ---------------------- | ------------------------------------------------------------------------- |
| `devices.json`         | Saved devices (never secrets)                                             |
| `profiles.json`        | Profiles (one or more tabs each) and the default profile id               |
| `settings.json`        | Terminal appearance, language, keepalive, SFTP idle timeout, last profile, update check on launch, close to tray |
| `known_hosts.json`     | Trusted host keys (TOFU)                                                  |
| `sftp_bookmarks.json`  | SFTP bookmarks for each device                                            |
| `workspace_state.json` | Open tabs, Files panel and side-menu widths, tunnels left running/stopped, collapsed device sections, per instance (not synced) |

When another running instance changes `devices.json`, `profiles.json`,
`settings.json` or `known_hosts.json`, a file watcher reloads them. Passwords and passphrases are stored only in the OS keychain, under the
service `DaSSHboard` and keyed by device id. The backend never sends them back
to the frontend.

## Releasing

A push to `main` that touches `apps/desktop/**` runs `desktop-release.yml`. It
builds on Windows, Linux and macOS (separate Intel and Apple Silicon builds)
and publishes to CrabNebula Cloud when the commit
is a `feat`, `fix` or `perf`, a breaking change, or a `Release vX.Y.Z` commit.
`.github/scripts/release-gate.sh` makes that decision. Before a release, bump
the version in `package.json`, `src-tauri/tauri.conf.json` and
`src-tauri/Cargo.toml`. CI fails if the three don't match.

CI signs the updater artifacts with `TAURI_SIGNING_PRIVATE_KEY`, and
CrabNebula serves them at the `plugins.updater` endpoints in `tauri.conf.json`.
The first endpoint asks for the installed bundle type (so an MSI install gets
the MSI); the second is the fallback for bundles CrabNebula has no entry for.
`requireSignedVersion` makes the app reject a signature that doesn't carry the
release version, which `@tauri-apps/cli` writes from 2.11.5 on, so keep the CLI
at 2.11.5 or later. The app checks for updates only on demand (About) or at
startup when the user opts in. The NSIS/MSI installers, the macOS `.app` and
the Linux AppImage install updates in place; `.deb`/`.rpm` installs only get a
link to the download page, and the Flatpak points to `flatpak update`.

## Flatpak

`flatpak/` holds the manifest, `.desktop` file and metainfo of the Flatpak
(app id `io.github.that_one_tool.DaSSHboard`). It differs from the Tauri
identifier (`com.dasshboard.app`) on purpose: Flatpak forbids hyphens in
`that-one-tool` and Tauri forbids underscores, and changing the Tauri identifier
would move every existing install's config folder. `flatpak/build-repo.sh` repackages
a release `.deb` on the GNOME runtime into a signed OSTree repo plus the
`dasshboard.flatpakref`/`.flatpakrepo` files. In `desktop-release.yml` the
`flatpak` job runs it with the `FLATPAK_GPG_PRIVATE_KEY` secret (a dedicated,
passphrase-less key), and `flatpak-upload` attaches the result to the GitHub
release as `dasshboard-flatpak.tar.gz`. `site-deploy` unpacks the newest one into
the website, which serves it at `https://that-one-tool.github.io/dasshboard/flatpak/`.
There is one commit per release; the repo keeps no history.

To try a local build (needs `flatpak-builder` or the `org.flatpak.Builder`
Flatpak; no GPG key means an unsigned repo):

```sh
npm run tauri build -- --bundles deb --no-sign   # the updater key lives only in CI
flatpak/build-repo.sh src-tauri/target/release/bundle/deb/*.deb ~/.cache/dasshboard-flatpak/out
flatpak --user remote-add --no-gpg-verify dasshboard-local ~/.cache/dasshboard-flatpak/out/repo
flatpak --user install dasshboard-local io.github.that_one_tool.DaSSHboard
```

Inside the sandbox, local shells run on the host through `flatpak-spawn --host`.
The PTY must not become the sandbox side's controlling terminal, so the host
shell can claim it (`set_controlling_tty(false)`); otherwise it gets no job
control or resize signals. The tray icon image goes to `$XDG_RUNTIME_DIR/app/<id>`,
the only runtime directory the host's panel can read.

On Linux (all bundles, not just the Flatpak) the app sets
`__NV_DISABLE_EXPLICIT_SYNC=1` at startup, unless already set: without it
WebKitGTK on NVIDIA under Wayland dies with "Error 71 (Protocol error)". Under
Wayland it also doesn't save or restore the window size and position
(`wayland.rs`). The
window-state plugin restores a physical size before the window is on a screen,
so on a scaled screen the window doubled every launch, until GDK's buffer size
overflowed and the app segfaulted. Maximized and fullscreen are still remembered.

macOS builds are ad-hoc signed (`bundle.macOS.signingIdentity: "-"`), not
Developer ID signed or notarized, so Gatekeeper blocks the first launch of a
downloaded copy; the root README tells users how to clear it. An ad-hoc
signature changes with every build, so after an update macOS asks again for
Keychain access to saved secrets.

On macOS the app replaces Tauri's default menu bar (`app_menu.rs`) to drop
Close Window, so Cmd+W closes a tab instead; quitting (Cmd+Q) closes sessions
from the `RunEvent::Exit` handler, since it skips `CloseRequested`. The default
local shell runs as a login shell (`-l`) with a UTF-8 `LANG` fallback, like
Terminal.app, because a Finder-launched app gets launchd's bare environment.
