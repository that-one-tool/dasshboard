<h1 style="text-align:center;">DaSSHboard</h1>

<p style="text-align:center;">
<img src="./app-icon.svg" style="width:128px;height:128px;"/>
</p>

<p style="text-align:center;">
A desktop dashboard for your SSH devices: save your devices once, arrange several
live terminals in a grid, and reload the whole workspace with a click.
</p>

Built with [Tauri 2](https://tauri.app/) (Rust backend) and a Vite + vanilla-TypeScript
frontend rendering terminals with [xterm.js](https://xtermjs.org/).

## Features

- **Device address book** — add/edit/delete devices of two kinds:
  - **SSH** — host, port, username, password **or** key-file auth with optional
    passphrase. Secrets are stored in the OS keychain, never in a config file.
  - **Serial / COM port** — a local serial device (e.g. `COM3` on Windows,
    `/dev/ttyUSB0` on Linux) by port name + baud rate, with optional framing
    params (data bits, parity, stop bits, flow control; defaults to 8-N-1, no
    flow control). Serial devices have no host/auth and store **no** secret.
- **Live multi-pane grid** — 1×1 up to 3×2 preset layouts, draggable splitters,
  click-to-focus panes, each an independent SSH shell or serial terminal.
- **Layout profiles** — save a workspace (grid + device assignments), set a
  default, and have it restore and auto-connect every pane on launch.
- **Host-key TOFU** — trust-on-first-use prompts with a prominent warning when a
  previously-trusted key changes (possible MITM).
- **Auto-reconnect** (opt-in per device) — reconnects with backoff (2s/4s/8s,
  up to 5 attempts) after an unexpected drop, with a cancel control.
- **Terminal settings** — font size/family and dark/light theme, applied live to
  every terminal and persisted.
- **Quality-of-life** — copy-on-select, `Ctrl+Shift+V` / right-click paste with a
  multi-line paste confirmation, full UTF-8 output with correct wide-character
  (CJK/emoji) width via the Unicode 11 table, per-pane `host:port` tooltips,
  window size/position remembered across restarts, and a clean SSH disconnect of
  every session on app close.

## Download

App is published through CrabNebula Cloud. You can easily find the latest release for Windows and Linux on the [App's page](https://web.crabnebula.cloud/that-one-tool/dasshboard/releases/).

## Build from source

```sh
npm run tauri build
```

Produces installers under `src-tauri/target/release/bundle/`, for whichever
platform you build on: on Windows, an NSIS `.exe` and an MSI
(`bundle/nsis/`, `bundle/msi/`); on Linux, a `.deb` and an RPM
(`bundle/deb/`, `bundle/rpm/`). Building requires the Tauri bundling toolchain
for your target (see the prerequisites link above) and the same `npm install`
step from "Run (development)".

## Developping

### Prerequisites

- [Node.js](https://nodejs.org/) 24+ and npm
- [Rust](https://rustup.rs/) (stable) with the MSVC toolchain on Windows
- The Tauri prerequisites for your OS — see
  [tauri.app/start/prerequisites](https://tauri.app/start/prerequisites/)
  (on Windows: the WebView2 runtime, which ships with Windows 11, and the MSVC
  build tools)

No system NASM install is required: the crypto backend (`aws-lc-rs`) is configured
with the `prebuilt-nasm` feature.

### Run (development)

```sh
npm install
npm run tauri dev
```

This starts the Vite dev server and launches the app with hot-reload.

### Checks

`npm run check` runs the full gate — TypeScript typecheck, the Vitest suite,
`cargo fmt --check`, `cargo test`, and `cargo clippy --all-targets -- -D warnings`:

```sh
npm run check
```

The Rust SSH integration tests run entirely in-process against a throwaway
`russh` server — no Docker or external SSH daemon needed.

### Where your data lives

All config is stored in the Tauri app-config directory
(`%APPDATA%\com.dasshboard.app\` on Windows):

| File               | Contents                                       |
| ------------------ | ---------------------------------------------- |
| `devices.json`     | Saved devices, SSH or serial (**never** secrets) |
| `profiles.json`    | Saved layout profiles + the default-profile id |
| `settings.json`    | Terminal appearance + last-used grid shape     |
| `known_hosts.json` | Trusted host keys (TOFU)                       |

**Secrets** (passwords, key passphrases) live only in the OS keychain — on
Windows, in **Credential Manager** under the service name `DaSSHboard`, keyed by
device id. Deleting a device removes its keychain entry. **Serial devices have
no secret**, so nothing is ever written to the keychain for them.

## Security notes

- Secrets are only ever in the OS keychain; `devices.json` (and the other config
  files) are safe to back up or sync.
- A password/passphrase crosses the frontend↔backend boundary only when you save
  a device — the backend never sends secret material back to the frontend.
- Host keys are trusted on first use; a **changed** key raises a loud warning and
  requires an explicit accept before connecting.
- The Tauri Content-Security-Policy is kept strict; no remote content is loaded.

## Project layout

- `src/` — frontend (TypeScript): `grid.ts`/`gridModel.ts` (multi-pane grid),
  `terminal/` (pane, overlay, reconnect, settings), `devices/`, `profiles/`,
  `settings/`, `ipc.ts` (typed command wrappers).
- `src-tauri/src/` — backend (Rust): stores (`store`, `profile_store`,
  `settings`, `known_hosts`), `session` (SSH via `russh`), `serial` (serial/COM
  via `tokio-serial`), `commands`, `secret` (keyring).
