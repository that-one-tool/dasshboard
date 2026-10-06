// Source of truth for the site's copy: every other locale must match this
// structure exactly (enforced by i18n.test.ts). `{version}` is filled at build.
export const en = {
	meta: {
		title: "DaSSHboard — a desktop dashboard for your SSH devices",
		description:
			"Save your devices once, arrange live terminals in a grid, and reload the whole workspace with a click. Free desktop app for Windows, macOS and Linux.",
	},
	nav: {
		features: "Features",
		howItWorks: "How it works",
		security: "Security",
		faq: "FAQ",
		download: "Download",
		github: "GitHub",
		language: "Language",
		sections: "Page sections",
	},
	hero: {
		eyebrow: "v{version} · Windows, macOS & Linux",
		title: "Your SSH devices, one dashboard.",
		lede: "Save your devices once, arrange live terminals in a grid, and reload the whole workspace with a click.",
		localNote:
			"No account, no cloud, no telemetry — the app only talks to the hosts you connect to, and checks for updates only when you ask.",
		download: "Download v{version}",
		github: "View on GitHub",
		shotAlt: "DaSSHboard with four live terminals arranged in a grid",
	},
	features: {
		title: "Everything a terminal-heavy day needs",
		items: [
			{
				title: "Live terminal grid",
				body: "Arrange several live terminals in a grid — 1×1 up to 3×2 presets with draggable splitters — and keep independent workspaces open as tabs.",
			},
			{
				title: "SSH, serial & local shells",
				body: "One address book for SSH hosts, serial/COM ports and local PowerShell, bash or zsh sessions, with tags and instant search.",
			},
			{
				title: "Local-only by design",
				body: "No account, no cloud, no telemetry. The app only connects to the hosts you open; your devices, profiles and settings are plain files on your machine.",
			},
			{
				title: "Secrets & host keys, guarded",
				body: "Passwords and passphrases live only in the OS keychain, never in a file or export. Host keys are pinned on first connect; a changed key needs your explicit approval.",
			},
			{
				title: "Tunnels & jump hosts",
				body: "Local (ssh -L) and dynamic SOCKS (ssh -D) port forwarding with start/stop from the sidebar, ProxyJump through a saved bastion, and opt-in agent forwarding.",
			},
			{
				title: "SFTP file browser",
				body: "A docked Files panel with streamed uploads and downloads, a background transfer queue, bookmarks, sorting, filtering and chmod — plus remote files you edit in your own editor.",
			},
			{
				title: "One-click workspaces",
				body: "Save a layout as a profile, set a default, and reload the whole workspace — every pane reconnected — with a single click.",
			},
			{
				title: "Made to live in",
				body: "Auto-reconnect with backoff, keepalives, commands on connect, broadcast input, a one-click dark/light theme toggle, and a UI in 7 languages.",
			},
		],
	},
	howItWorks: {
		title: "Up and running in three steps",
		lede: "Set it up once. After that, your whole workspace is one click away.",
		steps: [
			{
				title: "Add your devices",
				body: "Enter SSH hosts, serial ports or local shells — or import them straight from your ~/.ssh/config. Tag them to find them instantly.",
			},
			{
				title: "Arrange your grid",
				body: "Pick a layout from 1×1 to 3×2, choose a device in each pane and connect. Open more tabs for other workspaces.",
			},
			{
				title: "Save it as a profile",
				body: "Save the workspace as a profile and make it the default: next time, every pane reconnects on launch or with one click.",
			},
		],
	},
	tour: {
		title: "A closer look",
		lede: "The tools you reach for all day, one window away.",
		items: {
			grid: {
				title: "A grid of live terminals, in tabs",
				body: "Split each tab into up to six panes and resize them freely. Tabs keep their sessions running in the background and come back when you relaunch the app.",
				points: [
					"Layout presets from 1×1 to 3×2",
					"Draggable splitters and a resizable side menu",
					"Hidden tabs stay connected",
					"Tabs and layouts restored on launch",
				],
				alt: "A tab split into six terminal panes",
			},
			sftp: {
				title: "Files panel, right next to your shell",
				body: "Browse a device's files over SFTP in a panel docked beside your terminals. Transfers stream in the background, so you keep working while they run. Open a remote file in your own editor: every save goes straight back to the server, with a warning if someone changed it meanwhile.",
				points: [
					"Upload and download whole folders",
					"Background transfer queue with progress",
					"Bulk actions, bookmarks, sorting and filtering",
					"Edit remote files in your own editor",
				],
				alt: "The Files panel browsing a remote directory with a transfer in progress",
			},
			tunnels: {
				title: "Tunnels and jump hosts, without the flags",
				body: "Define port forwards on a device once, then start and stop them from the Tunnels card in the sidebar. Reach private hosts through a saved bastion.",
				points: [
					"Local (ssh -L) and dynamic SOCKS (ssh -D) forwards with auto-start",
					"ProxyJump (ssh -J) through a saved device",
					"Opt-in agent forwarding (ssh -A)",
					"Live status for every forward",
				],
				alt: "The Tunnels card listing local port forwards and their status",
			},
			broadcast: {
				title: "Type once, run everywhere",
				body: "Broadcast your keystrokes to every connected pane to update a fleet in one go, and let each device run its own snippet as soon as its shell opens.",
				points: [
					"Broadcast input to all connected panes",
					"Commands on connect, per device",
					"Auto-reconnect with backoff, and keepalives",
					"Confirmation before pasting multiple lines",
				],
				alt: "Three panes receiving the same broadcast command",
			},
		},
	},
	security: {
		title: "Private and secure by default",
		lede: "DaSSHboard is a local app. Your devices and credentials never leave your machine.",
		items: [
			{
				title: "Local-only",
				body: "No account, no cloud, no telemetry. The app connects only to the hosts you open and contacts the update server only when you ask — or at startup if you opt in.",
			},
			{
				title: "Secrets in the OS keychain",
				body: "Passwords and key passphrases are stored in your operating system's keychain — never in config files, and never in exports.",
			},
			{
				title: "Host keys, trusted on first use",
				body: "Each host key is pinned the first time you connect. If it ever changes, the connection is blocked until you explicitly accept the new key.",
			},
			{
				title: "Keys stay in your agent",
				body: "With SSH agent authentication — hardware tokens included — private keys never enter the app.",
			},
			{
				title: "Locked-down app, signed updates",
				body: "A strict content security policy with no remote content, and update packages that must carry a valid signature before they install.",
			},
			{
				title: "Open source, nothing hidden",
				body: "MIT-licensed, with every line of code on GitHub — anyone can audit exactly what the app does.",
			},
		],
	},
	download: {
		title: "Download DaSSHboard {version}",
		body: "Free and open source. Installers for Windows, macOS and Linux, with signed in-app updates.",
		installers: "Get the installers",
		releaseNotes: "Release notes",
		platformsTitle: "Supported platforms",
		columns: {
			platform: "Platform",
			packages: "Packages",
			updates: "In-app updates",
		},
		rows: [
			{ platform: "Windows", packages: "MSI, setup .exe", updates: "Install & restart" },
			{ platform: "macOS", packages: ".dmg (Intel, Apple Silicon)", updates: "Install & restart" },
			{ platform: "Linux", packages: "AppImage", updates: "Install & restart" },
			{ platform: "Linux", packages: ".deb, .rpm", updates: "Notification with a download link" },
			{ platform: "Linux", packages: "Flatpak", updates: "Through flatpak update or your software center" },
		],
		flatpak: {
			title: "Install the Flatpak",
			body: "On any Linux distribution, run this command, or open the .flatpakref file with your software center. Updates then come through Flatpak.",
			ref: "Download the .flatpakref",
		},
	},
	faq: {
		title: "Frequently asked questions",
		items: [
			{
				question: "Is DaSSHboard free?",
				answer: "Yes. DaSSHboard is free and open source under the MIT license, with no account and no paid tier. Forever.",
			},
			{
				question: "Is there a macOS version?",
				answer: "Yes, for Intel and Apple Silicon Macs. The app isn't notarized by Apple, so macOS blocks its first launch: try to open it once, then click Open Anyway in System Settings → Privacy & Security. Drag the app from the .dmg into Applications first: in-app updates can't replace it while it runs from the disk image.",
			},
			{
				question: "Which authentication methods are supported?",
				answer: "Password, private key file (with an optional passphrase), and SSH agent — including keys held on a hardware token.",
			},
			{
				question: "Can I import the hosts I already have?",
				answer: "Yes. Import devices from your ~/.ssh/config and export them back to it, or move devices and profiles between machines as JSON files. Exports never contain secrets.",
			},
			{
				question: "Where is my data stored?",
				answer: "In plain JSON files in the app's config folder (%APPDATA%\\com.dasshboard.app on Windows, ~/Library/Application Support/com.dasshboard.app on macOS, ~/.config/com.dasshboard.app on Linux). They hold no secrets, so you can back them up safely.",
			},
			{
				question: "How do updates work?",
				answer: "Check for updates from the About dialog, or opt in to a check at startup. On Windows, macOS and with the AppImage, Install & restart applies the signed update; .deb and .rpm installs get a link to the new package.",
			},
		],
	},
	lightbox: {
		close: "Close",
	},
	footer: {
		builtWith: "DaSSHboard — built with Tauri, Rust and xterm.js.",
		license: "MIT license",
		source: "Source on GitHub",
	},
};

export type SiteMessages = typeof en;
