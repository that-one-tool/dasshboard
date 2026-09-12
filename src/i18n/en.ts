/**
 * English messages — the SINGLE source of truth for the app's UI copy and, via
 * `keyof typeof en`, for the set of valid message keys. Every other locale
 * (see `fr.ts`) is typed as `Messages`, so adding a key here without translating
 * it there is a compile error: the type system guarantees translation
 * completeness.
 *
 * Keys are flat, dotted, and grouped by UI area. A message may contain
 * `{placeholder}` tokens interpolated by `t(key, params)`. Countable messages
 * come in `.one` / `.other` pairs selected by `tp(base, count, params)` — the
 * count is available inside them as `{count}`.
 *
 * Default locale: English is what `t()` returns until `setLocale` is called, so
 * unit tests (which never switch locale) assert against these strings.
 */

export const en = {
	/* -- header action buttons (index.html, via data-i18n attributes) ------- */
	"header.reload.title": "Reload devices, profiles & settings from disk (picks up changes from another window)",
	"header.reload.aria": "Reload configuration from disk",
	"header.trustedHosts.title": "Manage trusted hosts",
	"header.trustedHosts.aria": "Manage trusted hosts",
	"header.settings.title": "Settings",
	"header.settings.aria": "Settings",
	"header.help.title": "About DaSSHboard",
	"header.help.aria": "About DaSSHboard",
	"header.profileBar.aria": "Current profile",
	"header.paneRoot.aria": "SSH terminal",

	/* -- shared / common ---------------------------------------------------- */
	"common.close": "Close",
	"common.cancel": "Cancel",
	"common.save": "Save",
	"common.delete": "Delete",
	"common.rename": "Rename",
	"common.export": "Export",
	"common.import": "Import",
	"common.ok": "OK",
	"common.continue": "Continue",

	/* -- confirm / prompt modals (ui/confirm.ts) ---------------------------- */
	"confirm.title": "Please confirm",

	/* -- grid (grid.ts, gridModel.ts) --------------------------------------- */
	"grid.toolbar.aria": "Grid layout",
	"grid.layout": "Layout:",
	"grid.closeSessions.title": "Close sessions?",
	"grid.shrink.one": "{count} active session will be closed. Continue?",
	"grid.shrink.other": "{count} active sessions will be closed. Continue?",

	/* -- terminal pane (terminal/pane.ts, terminal/overlay.ts) -------------- */
	"pane.connect": "Connect",
	"pane.disconnect": "Disconnect",
	"pane.retry": "Retry",
	"pane.cancel": "Cancel",
	"pane.deviceSelect.aria": "Device to connect",
	"pane.noDevices": "No devices — add one in the sidebar",
	"pane.overlay.connecting": "Connecting…",
	"pane.overlay.disconnected": "Disconnected",
	"pane.overlay.error": "Connection error",
	"pane.overlay.reconnecting": "Reconnecting…",
	"pane.overlay.attempt": "Attempt {n} of {max}",
	"pane.overlay.deviceGone": "Device is no longer available",
	"pane.overlay.reconnectCancelled": "Auto-reconnect cancelled",
	"pane.paste.title": "Paste multiple lines?",
	"pane.paste.confirm": "Paste",
	"pane.paste.one": "Paste {count} line into the terminal? Each line may run as a command.",
	"pane.paste.other": "Paste {count} lines into the terminal? Each line may run as a command.",

	/* -- settings dialog (settings/settingsController.ts) ------------------- */
	"settings.title": "Settings",
	"settings.fontSize": "Font size",
	"settings.fontFamily": "Font family",
	"settings.theme": "Theme",
	"settings.theme.dark": "Dark",
	"settings.theme.light": "Light",
	"settings.language": "Language",
	"settings.language.system": "System default",

	/* -- about dialog (ui/aboutDialog.ts) ----------------------------------- */
	"about.tagline": "Multi-pane SSH & serial terminal dashboard with SFTP file transfer",
	"about.checking": "Checking version…",
	"about.built": "Built with Tauri, Rust & TypeScript.",
	"about.license": "That One Tool - 2026 - MIT license",
	"about.source": '<a href="https://github.com/that-one-tool/dasshboard" target="_blank">https://github.com/that-one-tool/dasshboard</a>',
	"about.unavailable": "Version unavailable",

	/* -- devices sidebar + dialog (devices/*) ------------------------------- */
	"devices.title": "Devices",
	"devices.add.title": "Add device",
	"devices.export.title": "Export devices to a JSON file",
	"devices.import.title": "Import devices from a JSON file",
	"devices.importSsh": "Import SSH config",
	"devices.importSsh.title": "Import devices from an OpenSSH config (~/.ssh/config)",
	"devices.empty": "No devices yet.<br />Click <strong>+ Add</strong> above to create your first one.",
	"devices.edit.aria": "Edit device",
	"devices.delete.aria": "Delete device",
	"devices.dialog.addTitle": "Add Device",
	"devices.dialog.editTitle": "Edit Device",
	"devices.field.name": "Name",
	"devices.field.name.placeholder": "My Server",
	"devices.field.kind": "Connection type",
	"devices.kind.ssh": "SSH",
	"devices.kind.serial": "Serial (COM port)",
	"devices.field.host": "Host",
	"devices.field.host.placeholder": "192.168.1.10",
	"devices.field.port": "Port",
	"devices.field.username": "Username",
	"devices.field.username.placeholder": "admin",
	"devices.auth.legend": "Authentication",
	"devices.auth.password": "Password",
	"devices.auth.key": "Key",
	"devices.field.secret": "Secret",
	"devices.field.secret.placeholder": "unchanged",
	"devices.field.keyPath": "Key Path",
	"devices.field.passphrase": "Passphrase (optional)",
	"devices.field.portName": "Port name",
	"devices.field.portName.placeholder": "COM3 or /dev/ttyUSB0",
	"devices.field.baudRate": "Baud rate",
	"devices.framing.legend": "Framing (advanced)",
	"devices.field.dataBits": "Data bits",
	"devices.field.parity": "Parity",
	"devices.parity.none": "None",
	"devices.parity.odd": "Odd",
	"devices.parity.even": "Even",
	"devices.field.stopBits": "Stop bits",
	"devices.field.flowControl": "Flow control",
	"devices.flow.none": "None",
	"devices.flow.software": "Software (XON/XOFF)",
	"devices.flow.hardware": "Hardware (RTS/CTS)",
	"devices.tunnelAutostart": "Start tunnel automatically on app launch",
	"devices.autoReconnect": "Auto-reconnect on unexpected disconnect",
	"devices.test": "Test connection",
	"devices.test.testing": "Testing…",
	"devices.test.enabledTitle": "Tests the saved credentials for this device",
	"devices.test.disabledTitle": "Save the device first, then test",
	"devices.saved": "Device saved",
	"devices.deleted": "Device deleted",
	"devices.test.success": "Connection succeeded",
	"devices.delete.title": "Delete device?",
	"devices.delete.message": 'Delete "{name}"? This cannot be undone.',
	"devices.exported.one": "Exported {count} device",
	"devices.exported.other": "Exported {count} devices",
	"devices.imported.one": "Imported {count} device",
	"devices.imported.other": "Imported {count} devices",
	"devices.importedSsh.one": "Imported {count} device from SSH config",
	"devices.importedSsh.other": "Imported {count} devices from SSH config",
	"devices.importedSshSkipped.one": "Imported {count} device from SSH config ({skipped} skipped)",
	"devices.importedSshSkipped.other": "Imported {count} devices from SSH config ({skipped} skipped)",

	/* -- device validation (devices/validation.ts, forwardValidation.ts) ---- */
	"validation.name": "Name is required",
	"validation.host": "Host is required",
	"validation.port": "Port is required",
	"validation.portRange": "Port must be a number between 1 and 65535",
	"validation.username": "Username is required",
	"validation.keyPath": "Key path is required for key-based authentication",
	"validation.portName": "Port name is required",
	"validation.baudRate": "Baud rate is required",
	"validation.baudRatePositive": "Baud rate must be a positive number",
	"validation.remoteHost": "Remote host is required",
	"validation.loopback": "Local address must be a loopback address (e.g. 127.0.0.1)",

	/* -- port-forwards editor (devices/forwardsEditor.ts) ------------------- */
	"forwards.title": "Port forwarding",
	"forwards.add": "Add forward",
	"forwards.name.placeholder": "Name (e.g. Postgres)",
	"forwards.localPort.placeholder": "Local port",
	"forwards.remoteHost.placeholder": "Remote host",
	"forwards.remotePort.placeholder": "Remote port",
	"forwards.remove": "Remove forward",

	/* -- profiles (profiles/profileManager.ts) ------------------------------ */
	"profiles.title": "Profiles",
	"profiles.export.title": "Export profiles to a JSON file",
	"profiles.import.title": "Import profiles from a JSON file",
	"profiles.empty": "No saved profiles yet — Save As to create one.",
	"profiles.bar.label": "Profile:",
	"profiles.bar.dirty": "Unsaved changes",
	"profiles.bar.save": "Save",
	"profiles.bar.saveAs": "Save As…",
	"profiles.bar.unsaved": "Unsaved workspace",
	"profiles.item.load": "Load this profile",
	"profiles.item.setDefault": "Set as default",
	"profiles.item.unsetDefault": "Unset default",
	"profiles.item.rename": "Rename profile",
	"profiles.item.delete": "Delete profile",
	"profiles.saveAs.title": "Save workspace as",
	"profiles.saveAs.placeholder": "Name for this profile",
	"profiles.rename.title": "Rename profile",
	"profiles.rename.placeholder": "New name",
	"profiles.nameEmpty": "Profile name must not be empty",
	"profiles.loaded": 'Loaded profile "{name}"',
	"profiles.savedProfile": 'Saved profile "{name}"',
	"profiles.renamedProfile": 'Renamed profile "{name}"',
	"profiles.deletedProfile": 'Deleted profile "{name}"',
	"profiles.delete.title": "Delete profile?",
	"profiles.delete.message": 'Delete profile "{name}"? This cannot be undone.',
	"profiles.exported.one": "Exported {count} profile",
	"profiles.exported.other": "Exported {count} profiles",
	"profiles.imported.one": "Imported {count} profile",
	"profiles.imported.other": "Imported {count} profiles",

	/* -- tunnels (tunnels/tunnelsPanel.ts) ---------------------------------- */
	"tunnels.title": "Tunnels",
	"tunnels.empty": "No device has port forwards. Add one in a device's editor to tunnel here.",
	"tunnels.status.connecting": "Connecting…",
	"tunnels.status.listening": "Listening",
	"tunnels.status.error": "Error",
	"tunnels.status.stopped": "Stopped",
	"tunnels.start": "Start",
	"tunnels.stop": "Stop",
	"tunnels.copy": "Copy",
	"tunnels.copy.title": "Copy the local address:port",
	"tunnels.copied": "Copied to clipboard",
	"tunnels.portInUse": "port in use",
	"tunnels.error.generic": "the tunnel stopped with an error",

	/* -- files / SFTP (sftp/sftpPanel.ts) ----------------------------------- */
	"sftp.title": "Files",
	"sftp.empty": "No SSH device to browse. Add one under Devices.",
	"sftp.browse": "Browse",
	"sftp.drawer.title": "Files",
	"sftp.drawer.titleFor": "Files — {name}",
	"sftp.path.aria": "Current directory",
	"sftp.nav.back": "Previous folder",
	"sftp.nav.forward": "Next folder",
	"sftp.nav.up": "Parent directory",
	"sftp.nav.refresh": "Refresh",
	"sftp.nav.upload": "Upload a file here",
	"sftp.nav.mkdir": "Create a folder",
	"sftp.cancelTransfer": "Cancel transfer",
	"sftp.connecting": "Connecting…",
	"sftp.emptyDir": "Empty directory.",
	"sftp.count.one": "1 item",
	"sftp.count.other": "{count} items",
	"sftp.entry.openFolder": "Open folder",
	"sftp.entry.downloadFile": "Download file",
	"sftp.entry.download": "Download",
	"sftp.entry.rename": "Rename",
	"sftp.entry.delete": "Delete",
	"sftp.delete.title": "Delete?",
	"sftp.delete.message": 'Delete "{name}"? This cannot be undone.',
	"sftp.delete.messageDir": 'Delete "{name}"? The folder must be empty. This cannot be undone.',
	"sftp.mkdir.title": "New folder",
	"sftp.mkdir.placeholder": "Folder name",
	"sftp.rename.title": "Rename",
	"sftp.rename.placeholder": "New name",
	"sftp.downloading": "Downloading {name}…",
	"sftp.downloaded": "{name} downloaded ({size})",
	"sftp.downloadedToast": "Downloaded {name}",
	"sftp.uploading": "Uploading {name}…",
	"sftp.uploadedToast": "Uploaded {name}",
	"sftp.transferCancelled": "Transfer cancelled",
	"sftp.cancelling": "Cancelling…",
	"sftp.progress.done": "Done",

	/* -- trusted hosts dialog (settings/knownHostsDialog.ts) ---------------- */
	"knownHosts.title": "Trusted hosts",
	"knownHosts.lead":
		"Host keys you have trusted. Forget a host to be prompted again on the next connection — do this if a server was rebuilt or you no longer trust it.",
	"knownHosts.empty": "No trusted hosts yet.",
	"knownHosts.forget": "Forget",
	"knownHosts.forget.title": "Forget host",
	"knownHosts.forget.message": "Forget the trusted host {id}? You will be asked to verify its key again the next time you connect.",

	/* -- host-key trust dialog (terminal/hostKeyDialog.ts, overlay.ts) ------ */
	"hostkey.host": "Host",
	"hostkey.keyType": "Key type",
	"hostkey.fingerprint": "Fingerprint",
	"hostkey.trust": "Trust and continue",
	"hostkey.reject": "Reject",
	"hostkey.changed.heading": "WARNING: host key changed",
	"hostkey.changed.lead":
		"The host key for {host}:{port} is different from the one previously trusted. This can mean the server was reinstalled — or that someone is intercepting the connection. Only continue if you know why the key changed.",
	"hostkey.unknown.heading": "Unknown host key",
	"hostkey.unknown.lead":
		"The authenticity of {host}:{port} can't be established because this is the first connection. Verify the fingerprint below out of band, then choose whether to trust it.",

	/* -- error prefixes (main.ts) ------------------------------------------- */
	"error.prefix": "Error: {message}",
	"error.reloadFailed": "Reload failed: {message}",
	"error.reloaded": "Configuration reloaded",
} as const;

/** The set of valid message keys, derived from the English source. */
export type MessageKey = keyof typeof en;

/** A complete message table for one locale (every key present). */
export type Messages = Record<MessageKey, string>;
