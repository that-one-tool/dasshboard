<h1 align="center">DaSSHboard</h1>

<p align="center">
  <img src="./apps/desktop/app-icon.svg" width="128" height="128" alt="DaSSHboard icon"/>
</p>

<p align="center">
  A desktop dashboard for your SSH devices: save them once, arrange live terminals
  in a grid, and reload the whole workspace with a click.
</p>

## Features

- **Devices** — SSH (password, key file or SSH agent / hardware token), serial/COM
  ports, and local shells. Tags, search, and import/export (JSON or `~/.ssh/config`).
- **Grid & tabs** — split each tab into up to 3×2 resizable panes, and resize the
  side menu and Files panel; tabs and layouts are restored on launch.
- **Profiles** — save a workspace and set a default that reconnects every pane
  on launch.
- **SSH extras** — jump hosts (`-J`), agent forwarding (`-A`), named local port
  forwards (`-L`) that resume as you left them (or auto-start), keepalive and
  auto-reconnect.
- **SFTP browser** — docked file panel with folder transfers, a background queue,
  bulk actions, bookmarks and chmod.
- **Commands on connect** — a per-device snippet typed in as soon as the shell opens.
- **Broadcast input** — type into several panes at once.
- **System tray** — opt in to keep running in the tray when the window is closed,
  with connections still live.
- **Dark & light themes** with a one-click toggle in the top bar, configurable
  terminal font and scrollback.
- **7 languages** — English, French, Spanish, German, Portuguese, Chinese, Japanese.
- **Signed updates** — check from About (or opt in to a check at startup), then
  Install & restart on Windows, macOS and the Linux AppImage.

## Security

- Local-only: no account, no cloud, no telemetry. The app connects only to the
  hosts you open, and all your data stays on your machine. It contacts the
  update server only when you check for updates, or at startup if you opt in.
- Passwords and passphrases live only in the OS keychain, never in config files
  or exports.
- Host keys are trusted on first use; a changed key blocks the connection until
  you explicitly accept it.
- With SSH agent auth, private keys never enter the app.
- Strict CSP, no remote content.

## Download

Windows, macOS (Intel and Apple Silicon) and Linux builds are on
[CrabNebula Cloud](https://web.crabnebula.cloud/that-one-tool/dasshboard/releases/)
and the [website](https://that-one-tool.github.io/dasshboard/).

The macOS app isn't notarized by Apple, so the first launch is blocked. Move
DaSSHboard to Applications, then either open it once and click **Open Anyway**
in System Settings → Privacy & Security, or run:

```sh
xattr -dr com.apple.quarantine /Applications/DaSSHboard.app
```

Because the app isn't signed with an Apple Developer ID, macOS asks again for
Keychain access to your saved passwords after each update. Serial ports are
the `/dev/cu.*` devices.

Your devices, profiles and settings are saved as JSON files in the app-config
directory (`%APPDATA%\com.dasshboard.app\` on Windows,
`~/Library/Application Support/com.dasshboard.app/` on macOS). These files
contain no secrets, so you can back them up safely.

## Development

Requires [Node.js](https://nodejs.org/) 24+, stable [Rust](https://rustup.rs/),
and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```sh
npm --prefix apps/desktop ci
npm run tauri dev     # run with hot-reload
npm run check         # typecheck, tests, fmt, clippy
npm run tauri build   # installers in apps/desktop/src-tauri/target/release/bundle/
```

The repo holds the [desktop app](apps/desktop/README.md) (Tauri 2 + TypeScript +
xterm.js) and the [website](apps/website/README.md).
Commits scoped `(site)` touch only the website and never cut a desktop release.

## License

[MIT](LICENSE)
