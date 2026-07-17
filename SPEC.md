# DaSSHboard — Specification

A desktop dashboard for connecting to multiple devices over SSH, showing interactive terminals in a customizable grid, with saved devices and saved layout profiles.

**Stack:** Tauri 2 (Rust backend) + Vite + vanilla TypeScript frontend + xterm.js. SSH implemented in Rust with `russh`. Secrets in the OS keychain via the `keyring` crate.

---

## 1. Goals

- Store a list of devices (name, host, port, username, auth method) with credentials kept securely.
- Open interactive SSH terminal sessions to those devices, several at once, each in its own pane.
- Arrange panes in a grid chosen from presets (1x1, 2x1, 1x2, 2x2, 3x1, 3x2), with draggable splitters to adjust pane proportions.
- Save the full workspace (grid shape, pane sizes, device assigned to each pane) as a named **profile**; loading a profile recreates the workspace and auto-connects every assigned device.
- Work fully offline and self-contained: no dependency on an installed `ssh` client.

## 2. Non-goals (v1)

- SFTP / file transfer, port forwarding, jump hosts.
- SSH agent authentication (password and private-key file only).
- Free-form tiling window management (grid presets + splitters only).
- Sync of devices/profiles across machines.
- Session recording, logging, or scripting.

---

## 3. Architecture

```
┌────────────────────────── Tauri window ──────────────────────────┐
│  Frontend (Vite + vanilla TS)                                    │
│  ┌──────────┐ ┌───────────────────────────┐ ┌─────────────────┐  │
│  │ Sidebar  │ │ Grid of panes             │ │ Dialogs         │  │
│  │ devices, │ │ each pane = xterm.js      │ │ device editor,  │  │
│  │ profiles │ │ Terminal + status overlay │ │ host-key trust  │  │
│  └──────────┘ └───────────────────────────┘ └─────────────────┘  │
│        │  invoke() commands      ▲  Channel: terminal output     │
│        ▼                         │  Events: session status       │
│  Rust backend                                                    │
│  ┌────────────┐ ┌──────────────┐ ┌───────────────────────────┐   │
│  │ DeviceStore│ │ ProfileStore │ │ SessionManager            │   │
│  │ devices.   │ │ profiles.    │ │ HashMap<SessionId,        │   │
│  │ json +     │ │ json         │ │   SessionHandle>          │   │
│  │ keyring    │ │              │ │ one tokio task per session│   │
│  └────────────┘ └──────────────┘ │ russh client              │   │
│                                  └───────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

- **Frontend** owns all layout/UI state and renders terminals with `@xterm/xterm` (+ `@xterm/addon-fit`). It never sees passwords except transiently in the device editor form.
- **Backend** owns persistence and all SSH. Terminal byte streams go over a Tauri **IPC `Channel`** (one per session, passed in the `connect` command) — not broadcast events — for throughput. Low-frequency status changes go over Tauri **events**.
- **Concurrency:** `SessionManager` lives in Tauri managed state behind a `Mutex`/`RwLock`; each SSH session runs in its own `tokio` task and is controlled through an mpsc handle (`SessionHandle`).

## 4. Data models

All persisted JSON lives in the Tauri app-config dir (`app_config_dir()`, e.g. `%APPDATA%/com.dasshboard.app/` on Windows). IDs are UUIDv4 strings. Files are written atomically (write temp file, then rename).

### Device — `devices.json`

```jsonc
{
	"version": 1,
	"devices": [
		{
			"id": "uuid",
			"name": "NAS",
			"host": "192.168.1.10",
			"port": 22,
			"username": "admin",
			"auth": { "method": "password" },
			// or: "auth": { "method": "key", "keyPath": "C:/Users/x/.ssh/id_ed25519" }
		},
	],
}
```

**Secrets are never in this file.** The keyring entry is service `DaSSHboard`, account = device `id`. For `password` auth it holds the password; for `key` auth it holds the key passphrase (absent = unencrypted key). Deleting a device deletes its keyring entry.

### Profile — `profiles.json`

```jsonc
{
	"version": 1,
	"defaultProfileId": "uuid-or-null", // loaded on app start
	"profiles": [
		{
			"id": "uuid",
			"name": "Homelab 2x2",
			"grid": {
				"rows": 2,
				"cols": 2,
				"rowSizes": [0.5, 0.5], // fractions, sum ≈ 1, adjusted by splitters
				"colSizes": [0.6, 0.4],
			},
			"panes": [
				// row-major order, length = rows*cols
				{ "deviceId": "uuid" },
				{ "deviceId": null }, // empty pane
				{ "deviceId": "uuid" },
				{ "deviceId": "uuid" },
			],
		},
	],
}
```

### Known hosts — `known_hosts.json`

```jsonc
{ "version": 1, "hosts": { "192.168.1.10:22": { "keyType": "ssh-ed25519", "fingerprint": "SHA256:..." } } }
```

## 5. IPC surface

### Commands (frontend → backend, `invoke`)

| Command               | Args                                                      | Returns                          | Notes                                        |
| --------------------- | --------------------------------------------------------- | -------------------------------- | -------------------------------------------- |
| `list_devices`        | —                                                         | `Device[]`                       | never includes secrets                       |
| `save_device`         | `device`, `secret?: string`                               | `Device`                         | upsert; `secret` present ⇒ write keyring     |
| `delete_device`       | `deviceId`                                                | —                                | also removes keyring entry                   |
| `test_connection`     | `deviceId`                                                | `Result<(), SshError>`           | connect + auth + close, no shell             |
| `connect`             | `deviceId`, `cols`, `rows`, `onData: Channel<Uint8Array>` | `sessionId`                      | opens session, spawns shell with PTY         |
| `write_stdin`         | `sessionId`, `data: string`                               | —                                | keystrokes from xterm.js `onData`            |
| `resize_pty`          | `sessionId`, `cols`, `rows`                               | —                                | called from fit-addon resize                 |
| `disconnect`          | `sessionId`                                               | —                                | graceful close; idempotent                   |
| `respond_host_key`    | `promptId`, `accept: boolean`                             | —                                | resolves a pending trust prompt              |
| `list_profiles`       | —                                                         | `{ defaultProfileId, profiles }` |                                              |
| `save_profile`        | `profile`                                                 | `Profile`                        | upsert                                       |
| `delete_profile`      | `profileId`                                               | —                                | clears `defaultProfileId` if it pointed here |
| `set_default_profile` | `profileId \| null`                                       | —                                |                                              |

### Events (backend → frontend, `emit`)

| Event             | Payload                                                                                     | When                                    |
| ----------------- | ------------------------------------------------------------------------------------------- | --------------------------------------- |
| `session_status`  | `{ sessionId, status: "connecting" \| "connected" \| "disconnected" \| "error", message? }` | every lifecycle change                  |
| `host_key_prompt` | `{ promptId, host, port, keyType, fingerprint, changed: boolean }`                          | unknown or **changed** host key (see 6) |

### Error shape

All commands return `Result<T, AppError>` where `AppError` serializes as `{ code, message }`. Codes: `NotFound`, `Io`, `Keyring`, `SshAuth`, `SshConnect`, `SshChannel`, `HostKeyRejected`, `Validation`.

## 6. SSH behavior

- **Library:** `russh` (client only) with `russh-keys` for key file loading.
- **Handshake:** in `client::Handler::check_server_key`, look up `known_hosts.json`.
    - Known and matching → proceed.
    - Unknown → emit `host_key_prompt` (`changed: false`), await user's `respond_host_key` via a oneshot channel (timeout 60 s ⇒ reject). Accept ⇒ persist and proceed (TOFU).
    - **Mismatch** → emit `host_key_prompt` with `changed: true`; the dialog must warn loudly (possible MITM). Accepting overwrites the stored fingerprint.
- **Auth order:** for `password` devices, password auth with the keyring secret; for `key` devices, load the key file (with keyring passphrase if present) and use publickey auth. No secret found in keyring ⇒ `SshAuth` error telling the user to re-enter it in the device editor.
- **Session:** open `channel_open_session`, `request_pty` (term `xterm-256color`, initial cols/rows from the pane), `request_shell`. Server output bytes → IPC channel verbatim (xterm.js parses escape sequences). Keepalive every 30 s; connect timeout 10 s.
- **Teardown:** server-side close or error ⇒ `session_status: disconnected`/`error` and cleanup of the tokio task and map entry. `disconnect` on an unknown `sessionId` is a no-op.

## 7. UI specification

Single window, three regions:

1. **Sidebar** (collapsible): device list (add/edit/delete/test buttons) and profile list (load, save-current-as, rename, delete, set-default marker).
2. **Toolbar:** grid-preset picker (1x1, 2x1, 1x2, 2x2, 3x1, 3x2), current profile name with a dirty-state dot ( • ) when the workspace differs from the saved profile, Save / Save As buttons.
3. **Grid area:** CSS Grid whose track sizes come from `rowSizes`/`colSizes`. Splitter bars (6 px hit area) between tracks; dragging updates the fractions live and re-fits terminals. Each cell is a **pane**:
    - Empty pane → centered device picker dropdown + Connect button.
    - Assigned pane → header strip (device name, colored status dot, disconnect ✕) above the xterm.js terminal.
    - Status overlays: _connecting_ spinner; _error/disconnected_ → message + **Retry** button on top of the (frozen) terminal.
    - Click focuses the pane (highlight border + keyboard focus into the terminal).

**Flows:**

- **Add device:** dialog with name/host/port/username, auth method radio (password ⇄ key file + optional passphrase), secret field (`type=password`, never pre-filled when editing — placeholder "unchanged"), Test connection button, Save.
- **Load profile:** tear down current sessions (confirm if any are connected), apply grid, then connect all assigned panes in parallel. Per-pane failures show that pane's error overlay; they don't block the others.
- **Grid shrink** (e.g. 2x2 → 1x2): panes beyond the new cell count are dropped; if any of them has a live session, confirm first ("2 active sessions will be closed").
- **App start:** load default profile if set, else last used grid with empty panes (1x1 fallback).
- **App close:** all sessions closed cleanly; no session state persists.

**Terminal specifics:** xterm.js `onData` → `write_stdin`; `Channel` data → `terminal.write()`; ResizeObserver on the pane → fit addon → `resize_pty`. Copy on select, paste on Ctrl+Shift+V (and right-click paste).

## 8. Security notes

- Secrets only in OS keychain; `devices.json` is safe to back up.
- Passwords cross IPC only inside `save_device` (form → backend) — never backend → frontend.
- Tauri CSP kept default-strict; no remote content loaded.
- Host key TOFU as in §6; changed-key warnings are prominent and require explicit accept.

## 9. Testing strategy

- **Rust:** unit tests for stores (temp-dir fixtures, atomic-write behavior, keyring mocked behind a trait) and known-hosts logic; integration tests for `SessionManager` against a throwaway SSH server (Docker `linuxserver/openssh-server` when available, else a `russh`-based in-process test server — the test util must provide one of the two).
- **Frontend:** Vitest for pure logic (grid math, splitter fraction updates, profile dirty-state diffing, state reducers). Terminal/IPC glue is covered by the manual checklists.
- **Per-phase manual checklist:** each phase in PLAN.md ends with a short human-runnable script; a phase is done only when tests pass **and** the checklist passes.

## 10. Conventions for implementing agents

- TypeScript `strict: true`; no frontend framework — small modules with explicit exports (`src/state.ts`, `src/grid.ts`, `src/ipc.ts`, `src/ui/*.ts`).
- Rust: `cargo fmt` + `clippy -D warnings` clean; stores and keyring behind traits so tests can inject fakes.
- All IPC payloads defined once in `src/ipc.ts` (TS types) mirroring the Rust `serde` structs; field names `camelCase` on the wire (`#[serde(rename_all = "camelCase")]`).
- Never log secrets. Never write secrets to any file.
