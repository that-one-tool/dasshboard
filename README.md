<h1 style="text-align:center;">DaSSHboard</h1>

<p style="text-align:center;">
<img src="./apps/desktop/app-icon.svg" style="width:128px;height:128px;"/>
</p>

<p style="text-align:center;">
A desktop dashboard for your SSH devices: save your devices once, arrange several
live terminals in a grid, and reload the whole workspace with a click.
</p>

Built with [Tauri 2](https://tauri.app/) (Rust backend) and a Vite + vanilla-TypeScript
frontend rendering terminals with [xterm.js](https://xtermjs.org/).

## Features

- **Device address book** — add/edit/delete devices of three kinds:
    - **SSH** — host, port, username, and one of three auth methods: password,
      key-file (with optional passphrase), or **SSH agent** (authenticate with a
      key held by your local agent — including a hardware token). Password/key
      secrets are stored in the OS keychain, never in a config file; agent auth
      stores no secret at all (the agent holds the key).
    - **Serial / COM port** — a local serial device (e.g. `COM3` on Windows,
      `/dev/ttyUSB0` on Linux) by port name + baud rate, with optional framing
      params (data bits, parity, stop bits, flow control; defaults to 8-N-1, no
      flow control). Serial devices have no host/auth and store **no** secret.
    - **Local shell** — a local terminal (PowerShell/bash/zsh/…) run under a real
      PTY right in the grid, with an optional shell path (blank = OS default) and
      startup directory (blank = home). No host/auth and **no** secret.
    - **Tags & search** — tag devices and filter the address book by name, host or
      tag to find a device fast in a long list. Each device tile shows its tags as
      chips beside its host:port.
    - **Import / export** — the Devices section header holds icon buttons (with
      tooltips) for the four transfers below, next to the add button.
    - **Import / export `~/.ssh/config`** — pull your existing OpenSSH hosts straight
      into the address book (`Host`/`HostName`/`Port`/`User`/`IdentityFile`; a host
      with an identity file becomes key auth, others password auth), and write your
      saved SSH devices back out as an OpenSSH config file (`ProxyJump` and
      `ForwardAgent` included). Best-effort: on import, wildcard/`Match`-only blocks
      and duplicates are skipped, so a re-import never creates duplicates and never
      fails on a messy entry; on export, non-SSH devices are skipped and no secret
      is ever written (a password lives only in the keychain).
    - **Export / import devices & profiles** — back up or migrate your address book
      and layout profiles to another machine via JSON files (secrets stay in the OS
      keychain and are never exported).
- **Jump hosts (ProxyJump / `ssh -J`)** — reach a device through a saved bastion:
  point a device at another saved SSH device as its jump host and shell sessions
  connect through the bastion first. (Wired for shell sessions; tunnels and SFTP
  through a jump host are not supported yet.)
- **SSH agent authentication (hardware tokens)** — authenticate a device with a
  key held by your local SSH agent instead of a key file. In the device editor,
  pick **SSH agent**, hit **Refresh** to list the agent's identities (algorithm +
  SHA256 fingerprint), and select one; the device stores only that fingerprint.
  All signing happens in the agent, so a hardware-backed key (FIDO2/`sk-*`,
  PIV/PKCS#11) works wherever your agent supports it — no key material ever
  enters the app. Agents are reached over their named pipe on Windows (the
  OpenSSH agent, a user-set `$SSH_AUTH_SOCK`, or a running Pageant) and
  `$SSH_AUTH_SOCK` on Unix. The security guarantee is that auth is fail-safe: a
  fake or foreign agent cannot forge a signature the server accepts, so it can
  never log you in — see the security notes.
- **SSH agent forwarding (`ssh -A`)** — opt in per SSH device to let programs on
  the remote host use your local SSH keys (e.g. `git push`, a further `ssh` hop)
  without ever copying a key to the server. The app relays the remote's agent
  requests to your local agent (Unix `$SSH_AUTH_SOCK`; on Windows the OpenSSH
  agent named pipe or `$SSH_AUTH_SOCK`) — no key material passes through the app,
  and forwarding simply no-ops if no local agent is running.
- **Live multi-pane grid** — 1×1 up to 3×2 preset layouts, draggable splitters,
  click-to-focus panes, each an independent SSH shell, serial terminal or local
  shell.
- **Tabbed workspaces** — keep several independent workspaces open as tabs, each
  its own multi-pane grid with its own sessions. Only the active tab is shown; the
  others keep running and buffering in the background. Add a tab (`Ctrl+Shift+T`),
  close it (`Ctrl+Shift+W`), cycle with `Ctrl+Tab` / `Ctrl+Shift+Tab`, or
  double-click a tab to rename it. A tab opened from a profile shows a link badge
  and an unsaved-changes dot. Your open tabs — their layouts, device assignments
  and the active one — are saved and restored on the next launch.
- **SSH tunnels (local port forwarding)** — give an SSH device one or more
  forwards (`ssh -L`): the app binds `127.0.0.1:<localPort>` locally and tunnels
  each connection to `remoteHost:remotePort` as reached from the SSH server, so a
  local client (e.g. a database GUI) can reach a remote service over SSH.
  Start/stop per device from the **Tunnels** sidebar card with a live status icon
  (green wifi when listening, amber while connecting, crossed out when stopped),
  copy the local endpoint with a click, and optionally auto-start a device's tunnel on
  app launch. Forwards bind loopback only.
- **SFTP file browser** — a persistent, resizable **Files** panel docked beside
  the terminal grid (toggle it from the header bar): pick a device from the
  panel's device dropdown to browse remote directories, download files to a local
  path and upload local files, plus make/rename/delete entries (deleting a folder
  removes it and everything inside). Whole **folders** transfer recursively too —
  download a remote folder to a local directory, or use *Upload a folder here* to
  push a local tree up — and when the destination already exists you choose once
  per transfer whether to **overwrite**, **skip** (merge, keeping what's there),
  or **keep both** (write under a fresh name). Select multiple entries with the
  row checkboxes (or select-all, shift-click for a range) and act on them in
  bulk: **Download** the selected files and folders into one destination folder,
  **Move** them with cut/paste into another directory, or **Delete** them all at
  once. Transfers run in a **background queue** — they stream one at a time while
  you keep browsing, each shown in a live list at the bottom of the panel with a
  progress bar and a cancel button (queue up several at once; cancel a queued or
  in-flight one anytime). **Sort** the listing by name, size or modified date
  (click a column header to toggle the direction; folders always stay grouped on
  top) and **filter** the current folder as you type. **Bookmark** folders you
  return to (the star in the toolbar) and jump back from the chip row — bookmarks
  are saved per device across restarts. View and change an entry's Unix
  **permissions** (chmod) from the lock button, ticking read/write/execute for
  owner/group/other with a live octal readout. The toolbar path
  is editable — type a path and press Enter to jump there (a file path opens its
  parent folder) — and a copy button copies the current remote path to the
  clipboard. Drag the divider to resize it, or collapse it to a rail to keep the
  connection alive while you work in a terminal beside it. Reuses the SSH connect
  + host-key path, so a first-contact key prompts exactly like a shell. Fully
  closing the panel (or an explicit Disconnect) drops the connection immediately;
  a collapsed panel auto-disconnects after a configurable idle timeout (Settings
  → *SFTP idle disconnect*, `0` to keep it open). The panel's open/collapsed
  state, width and last-selected device are remembered across restarts (it never
  auto-reconnects — it preselects the device; the header's green connect toggle
  reconnects on demand).
  Transfers **stream chunk-by-chunk straight to/from disk** (constant memory, no
  whole-file buffering), so files of any size transfer without a memory ceiling;
  an interrupted or cancelled transfer removes its partial file.
- **Layout profiles** — save a workspace (grid + device assignments), set a
  default, and have it restore and auto-connect every pane on launch. Load a
  profile into the current tab, or open it in a new tab. Export / Import and
  Save / Save As sit in the Profiles panel header, and the currently-loaded profile is marked in the
  list with a status dot (green, or gold when it has unsaved changes).
- **Host-key TOFU** — trust-on-first-use prompts with a prominent warning when a
  previously-trusted key changes (possible MITM).
- **Connect snippet (commands on connect)** — give any device (SSH, serial or
  local shell) a saved block of commands that is typed into the terminal the
  moment its shell opens, one line at a time as if you pressed Enter — automate a
  repetitive login routine (`cd`, `tail -f`, activating an environment, …).
- **Auto-reconnect** (opt-in per device) — reconnects with backoff (2s/4s/8s,
  up to 5 attempts) after an unexpected drop, with a cancel control.
- **Configurable SSH keepalive** — set the keepalive interval and the number of
  unanswered pings tolerated before a dead connection is dropped (which then
  feeds auto-reconnect); applies to shells, tunnels and SFTP. `0` disables it.
- **Polished dark & light UI** — a clean, flat interface built on a single
  design-token system: neutral surfaces, hairline borders, one royal-blue
  accent, rounded cards, a full-height sidebar and pill-style workspace tabs,
  set in the bundled Inter typeface (SIL OFL) with bold, rounded Lucide icons
  (ISC). Each pane's header shows a colour-coded status chip (Idle /
  Connecting / Connected / Disconnected / Error) that shrinks to a dot in
  narrow panes. The **Appearance** setting switches the whole app — chrome and
  terminals together — between dark and light, live.
- **Terminal settings** — font size/family, appearance (dark/light), and
  scrollback buffer size, applied live to every terminal and persisted.
- **Localized UI** — the interface ships in **English, French, Spanish, German,
  Portuguese, Simplified Chinese and Japanese**. Pick a language in Settings or
  let the app follow your OS locale; the choice applies live without a restart.
- **Quality-of-life** — copy-on-select, `Ctrl+Shift+V` / right-click paste with a
  multi-line paste confirmation, full UTF-8 output with correct wide-character
  (CJK/emoji) width via the Unicode 11 table, per-pane endpoint tooltips,
  window size/position remembered across restarts, a clean SSH disconnect of
  every session on app close, and broadcast input (multi-input).

## Download

App is published through CrabNebula Cloud. You can easily find the latest release for Windows and Linux on the [App's page](https://web.crabnebula.cloud/that-one-tool/dasshboard/releases/),
or from the [website](https://that-one-tool.github.io/dasshboard/).

## Build from source

```sh
npm --prefix apps/desktop ci
npm run tauri build
```

Produces installers under `apps/desktop/src-tauri/target/release/bundle/`, for whichever
platform you build on: on Windows, an NSIS `.exe` and an MSI
(`bundle/nsis/`, `bundle/msi/`); on Linux, a `.deb` and an RPM
(`bundle/deb/`, `bundle/rpm/`). Building requires the Tauri bundling toolchain
for your target (see the prerequisites link above).

## Developping

### Repository layout

This is a monorepo with two independently built and deployed apps:

- `apps/desktop/` — the Tauri desktop app (frontend `src/`, Rust backend
  `src-tauri/`). Released to CrabNebula Cloud by `desktop-release.yml`.
- `apps/website/` — the product website ([Astro](https://astro.build/)), deployed
  to GitHub Pages by `site-deploy.yml`. See [apps/website/README.md](apps/website/README.md).

Each app has its own `package.json` and lockfile. The root `package.json` only
holds convenience scripts that delegate to them (`npm run tauri dev`,
`npm run check`, `npm run site:dev`, `npm run site:check`, `npm run check:all`).

**Commit scopes.** Commits follow Conventional Commits; the scope routes them:
`feat(site): …` / `fix(site): …` are website changes and never cut a desktop
release, while `feat(desktop): …`, unscoped `feat: …`, and any other scope are
desktop changes. On top of that, path filters keep each app's workflows to its
own directory, and on pull requests the always-running `CI / ci-ok` job reports
the combined result.

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
npm --prefix apps/desktop ci
npm run tauri dev
```

This starts the Vite dev server and launches the app with hot-reload.

### Checks

`npm run check` runs the full gate — TypeScript typecheck, the Vitest suite,
`cargo fmt --check`, `cargo test`, and `cargo clippy --all-targets -- -D warnings`:

```sh
npm run check
```

`npm run site:check` runs the website's gate (`astro check`, its Vitest suite,
and a production build); `npm run check:all` runs both.

The Rust SSH integration tests run entirely in-process against a throwaway
`russh` server — no Docker or external SSH daemon needed.

### Where your data lives

All config is stored in the Tauri app-config directory
(`%APPDATA%\com.dasshboard.app\` on Windows):

| File               | Contents                                         |
| ------------------ | ------------------------------------------------ |
| `devices.json`     | Saved devices — SSH, serial or local shell (**never** secrets) |
| `profiles.json`    | Saved layout profiles + the default-profile id   |
| `settings.json`    | Terminal appearance (incl. scrollback), UI language, SSH keepalive, last-used profile |
| `workspace_state.json` | Open tabs restored on launch (per install; not synced between instances) |
| `known_hosts.json` | Trusted host keys (TOFU)                         |

**Secrets** (passwords, key passphrases) live only in the OS keychain — on
Windows, in **Credential Manager** under the service name `DaSSHboard`, keyed by
device id. Deleting a device removes its keychain entry. **Serial and local-shell
devices have no secret**, so nothing is ever written to the keychain for them.

## Security notes

- Secrets are only ever in the OS keychain; `devices.json` (and the other config
  files) are safe to back up or sync.
- A password/passphrase crosses the frontend↔backend boundary only when you save
  a device — the backend never sends secret material back to the frontend.
- Host keys are trusted on first use; a **changed** key raises a loud warning and
  requires an explicit accept before connecting.
- SSH agent auth never handles key material: the agent signs, the app only relays
  the challenge/response, and a device stores just the chosen key's fingerprint.
  This is fail-safe against a hostile or spoofed local agent — it cannot produce a
  signature the server accepts without the private key, so it can never log you in
  as you; the worst a local pipe-squatter could do is cause a failed attempt or
  show a misleading label in the identity picker.
- The Tauri Content-Security-Policy is kept strict; no remote content is loaded.

## Project layout

Desktop app paths below are relative to `apps/desktop/`.

- `src/` — frontend (TypeScript): `grid.ts`/`gridModel.ts` (multi-pane grid),
  `terminal/` (pane, overlay, reconnect, settings), `devices/` (CRUD + the
  port-forward editor), `tunnels/` (the Tunnels sidebar card), `sftp/` (the Files
  card + docked browser panel), `profiles/`, `settings/`, `ipc.ts` (typed command
  wrappers).
- `src-tauri/src/` — backend (Rust): stores (`store`, `profile_store`,
  `settings`, `known_hosts`), `session` (SSH shells via `russh`), `tunnel` (local
  port forwarding, reusing `session`'s connect/host-key path), `sftp` (SFTP
  browse/transfer over `russh-sftp`, reusing the same connect path), `agent`
  (SSH agent forwarding — relays the remote's agent channels to the local agent),
  `agent_ident` (agent identity enumeration + agent-backed auth),
  `ssh_config` (import/export devices ↔ `~/.ssh/config`), `serial` (serial/COM via
  `tokio-serial`), `local_shell` (local PTY shells via `portable-pty`), `commands`,
  `secret` (keyring).
