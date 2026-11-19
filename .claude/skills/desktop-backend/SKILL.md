---
name: desktop-backend
description: Module map and conventions of the DaSSHboard Rust backend (apps/desktop/src-tauri). Use when finding, changing or adding backend code: Tauri commands, stores, SSH connect/auth, host keys, keychain, sessions (SSH, serial, local shell), tunnels, SFTP, agent, X11, import/export, updater, or integration tests.
---

# Desktop backend (`apps/desktop/src-tauri/src/`)

Adding a command and tests: `apps/desktop/README.md` (Adding things,
Testing). Module names differ per side (`commands/host_keys.rs` ↔
`ipc/knownHosts.ts`).

## Modules

- `device.rs`, `profile.rs`, `settings.rs` — domain models. Validation and
  settings clamps are mirrored in the frontend; change both sides together.
- Stores (`store`, `profile_store`, `known_hosts`, `bookmark_store`,
  `command_library`, `workspace_store`, settings in `settings.rs`) — JSON files in the app-config dir, all
  written through `atomic_file.rs` (atomic write, backup, recovery).
  Each keeps its value in a `store_cell::StoreCell`: writes take turns and
  persist outside the value's lock, so reads never wait on a disk write.
  Multi-step device edits (keychain + stores) hold `DeviceStore::hold_edits`.
- `commands/blocking.rs` — a command doing I/O is async and runs it with
  `run_blocking`/`run_with_state`; its test lists the only sync commands
  allowed (they run on the main thread).
  `config_watch.rs` tells the frontend when they change on disk.
- `workspace*.rs` — open tabs, restored at launch, per instance.
- `known_hosts.rs` — host-key TOFU store. Damaged or unreadable file → unknown
  hosts are `Unverifiable` (loud prompt).
- `secret.rs` — OS keychain (service `DaSSHboard`).
- `ssh/` — shared SSH connect: parameters, auth (incl. keyboard-interactive),
  prompts, connect deadline, TCP socket options, host-key handler, jump host,
  `close` (every SSH teardown, each goodbye bounded). `connector` —
  `SshConnector` (`AppState.ssh`): the one trust store, prompt registry and
  timeouts; shells, tunnels and SFTP connect and close only through it.
  Each connect gets its `ConnectPrompter` apart from its sink; in production
  `commands/host_keys.rs` `TauriPrompter`. `commands/device_access.rs`
  `ssh_target_of` resolves a saved device into its `SshTarget` (credentials,
  jump hop, keepalive), which shell, tunnel and SFTP params carry as
  `target`; `test_connection` resolves its own.
  `conn_log` writes its lifecycle lines (connect timing, auth outcome, host-key
  verdict, why a link ended); the handler's `with_purpose` names the use.
- `app_log.rs` — diagnostic log (`info`/`warn`/`error`): last 2000 lines in
  memory plus stderr; use it, not `eprintln!`. It escapes control characters
  (server text). Never secrets, prompt answers or terminal data.
  `commands/logs.rs` reads, clears and takes frontend lines.
- Terminal sessions: `session.rs` (SSH shells: `spawn_shell`,
  `test_connection`), `serial.rs`, `local_shell.rs` (local PTY).
  `session_registry.rs` (`AppState.sessions`) owns every Session: ids,
  lifecycle (cleanup survives a runner panic), write/resize/disconnect; each
  kind gives only its runner, behind a small spawn helper. Input is a bounded
  queue; size and stop are latest-value watches, never stuck behind input.
  All report to the frontend through `session_sink.rs`.
  `output_stream.rs` keeps output until the frontend reads it.
  `session_recording.rs` records raw output to a file.
- Forwards: `tunnel/` — `manager` (registry), `lifecycle` + `serve` (one
  tunnel's task), `forwards`, `local` (`-L`), `dynamic` (`-D`), `remote`
  (`-R` requests), `status`. `remote_forward.rs` (remote routes), `socks.rs`
  (SOCKS server), `relay.rs` (socket ↔ channel).
- `sftp/` — `manager` (connections, cancel flags), `listing`, `file_ops`,
  `transfer` (one file), `tree` (folders), `names` (path safety),
  `whole_file` (in-memory, integration tests only);
  `sftp_edit.rs` edit in place; `editor.rs` opens the file in a text
  editor, never with the default action.
- `agent.rs`, `agent_ident.rs` — agent forwarding and agent auth.
- `x11/` — X11 forwarding: `$DISPLAY` parsing, Xauthority cookie (matched by
  hostname or IP, like Xlib), fake-cookie check and swap on each X11 channel.
  `security.rs` gets an untrusted cookie from the X SECURITY extension.
- `ssh_config/` — import/export `~/.ssh/config`: `parse`, `jump_spec`,
  `mapping` (→ `Device`), `import`, `export`. `transfer.rs` —
  import/export; a devices import shows its risks first.
- `updater.rs` — runs only when the user asks or opts in.
- `tray.rs` (opt-in close to tray), `app_menu.rs` (macOS menu bar),
  `main_window.rs` (clipboard access), `flatpak.rs` and `wayland.rs` (platform
  workarounds).
