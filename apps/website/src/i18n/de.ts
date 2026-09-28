import type { SiteMessages } from "./en";

export const de: SiteMessages = {
	meta: {
		title: "DaSSHboard — ein Desktop-Dashboard für Ihre SSH-Geräte",
		description:
			"Speichern Sie Ihre Geräte einmal, ordnen Sie Live-Terminals in einem Raster an und laden Sie den ganzen Arbeitsbereich mit einem Klick neu. Kostenlose Desktop-App für Windows, macOS und Linux.",
	},
	nav: {
		features: "Funktionen",
		howItWorks: "So geht's",
		security: "Sicherheit",
		faq: "FAQ",
		download: "Download",
		github: "GitHub",
		language: "Sprache",
		sections: "Seitenabschnitte",
	},
	hero: {
		eyebrow: "v{version} · Windows, macOS & Linux",
		title: "Ihre SSH-Geräte, ein Dashboard.",
		lede: "Speichern Sie Ihre Geräte einmal, ordnen Sie Live-Terminals in einem Raster an und laden Sie den ganzen Arbeitsbereich mit einem Klick neu.",
		localNote:
			"Kein Konto, keine Cloud, keine Telemetrie — die App spricht nur mit den Hosts, zu denen Sie sich verbinden, und sucht nur auf Wunsch nach Updates.",
		download: "v{version} herunterladen",
		github: "Auf GitHub ansehen",
		shotAlt: "DaSSHboard mit vier Live-Terminals in einem Raster",
	},
	features: {
		title: "Alles für einen Tag im Terminal",
		items: [
			{
				title: "Raster aus Live-Terminals",
				body: "Ordnen Sie mehrere Live-Terminals in einem Raster an — Vorlagen von 1×1 bis 3×2 mit verschiebbaren Trennern — und halten Sie unabhängige Arbeitsbereiche als Tabs offen.",
			},
			{
				title: "SSH, seriell & lokale Shells",
				body: "Ein Adressbuch für SSH-Hosts, serielle/COM-Ports und lokale PowerShell-, bash- oder zsh-Sitzungen, mit Tags und Sofortsuche.",
			},
			{
				title: "Lokal aus Prinzip",
				body: "Kein Konto, keine Cloud, keine Telemetrie. Die App verbindet sich nur mit den Hosts, die Sie öffnen; Ihre Geräte, Profile und Einstellungen sind einfache Dateien auf Ihrem Rechner.",
			},
			{
				title: "Geheimnisse & Host-Schlüssel, geschützt",
				body: "Passwörter und Passphrasen liegen nur im Schlüsselbund des Betriebssystems, nie in einer Datei oder einem Export. Host-Schlüssel werden bei der ersten Verbindung gemerkt; ein geänderter Schlüssel braucht Ihre ausdrückliche Zustimmung.",
			},
			{
				title: "Tunnel & Jump-Hosts",
				body: "Lokale Portweiterleitung (ssh -L) mit Start/Stopp aus der Seitenleiste, ProxyJump über einen gespeicherten Bastion-Host und optionale Agent-Weiterleitung.",
			},
			{
				title: "SFTP-Dateibrowser",
				body: "Ein angedocktes Dateien-Panel mit gestreamten Uploads und Downloads, einer Übertragungswarteschlange im Hintergrund, Lesezeichen, Sortierung, Filter und chmod.",
			},
			{
				title: "Arbeitsbereiche per Klick",
				body: "Speichern Sie ein Layout als Profil, legen Sie ein Standardprofil fest und laden Sie den ganzen Arbeitsbereich — jedes Fenster neu verbunden — mit einem einzigen Klick.",
			},
			{
				title: "Für den Alltag gemacht",
				body: "Automatische Wiederverbindung mit Backoff, Keepalives, Befehle beim Verbinden, Eingabe-Broadcast, Dunkel/Hell-Umschalter mit einem Klick und eine Oberfläche in 7 Sprachen.",
			},
		],
	},
	howItWorks: {
		title: "In drei Schritten startklar",
		lede: "Einmal einrichten. Danach ist Ihr ganzer Arbeitsbereich nur einen Klick entfernt.",
		steps: [
			{
				title: "Geräte hinzufügen",
				body: "Tragen Sie SSH-Hosts, serielle Ports oder lokale Shells ein — oder importieren Sie sie direkt aus Ihrer ~/.ssh/config. Mit Tags finden Sie sie sofort wieder.",
			},
			{
				title: "Raster anordnen",
				body: "Wählen Sie ein Layout von 1×1 bis 3×2, wählen Sie in jedem Fenster ein Gerät und verbinden Sie sich. Öffnen Sie weitere Tabs für andere Arbeitsbereiche.",
			},
			{
				title: "Als Profil speichern",
				body: "Speichern Sie den Arbeitsbereich als Profil und machen Sie es zum Standard: Beim nächsten Mal verbindet sich jedes Fenster beim Start oder mit einem Klick neu.",
			},
		],
	},
	tour: {
		title: "Genauer hingesehen",
		lede: "Die Werkzeuge, die Sie den ganzen Tag brauchen, in einem Fenster.",
		items: {
			grid: {
				title: "Ein Raster aus Live-Terminals, in Tabs",
				body: "Teilen Sie jeden Tab in bis zu sechs Fenster und ändern Sie ihre Größe frei. Tabs halten ihre Sitzungen im Hintergrund aktiv und sind nach einem Neustart der App wieder da.",
				points: [
					"Layout-Vorlagen von 1×1 bis 3×2",
					"Verschiebbare Trenner und anpassbares Seitenmenü",
					"Ausgeblendete Tabs bleiben verbunden",
					"Tabs und Layouts werden beim Start wiederhergestellt",
				],
				alt: "Ein Tab, aufgeteilt in sechs Terminalfenster",
			},
			sftp: {
				title: "Das Dateien-Panel, direkt neben Ihrer Shell",
				body: "Durchsuchen Sie die Dateien eines Geräts per SFTP in einem Panel neben Ihren Terminals. Übertragungen laufen im Hintergrund, sodass Sie währenddessen weiterarbeiten.",
				points: [
					"Ganze Ordner hoch- und herunterladen",
					"Übertragungswarteschlange im Hintergrund mit Fortschritt",
					"Massenaktionen, Sortierung und Filter",
					"Lesezeichen pro Gerät und chmod",
				],
				alt: "Das Dateien-Panel zeigt ein entferntes Verzeichnis mit laufender Übertragung",
			},
			tunnels: {
				title: "Tunnel und Jump-Hosts, ohne Kommandozeilenoptionen",
				body: "Definieren Sie die Portweiterleitungen eines Geräts einmal und starten oder stoppen Sie sie dann über die Tunnel-Karte in der Seitenleiste. Erreichen Sie private Hosts über einen gespeicherten Bastion-Host.",
				points: [
					"Lokale Portweiterleitung (ssh -L) mit Autostart",
					"ProxyJump (ssh -J) über ein gespeichertes Gerät",
					"Optionale Agent-Weiterleitung (ssh -A)",
					"Live-Status für jede Weiterleitung",
				],
				alt: "Die Tunnel-Karte mit lokalen Portweiterleitungen und ihrem Status",
			},
			broadcast: {
				title: "Einmal tippen, überall ausführen",
				body: "Senden Sie Ihre Eingabe an alle verbundenen Fenster, um eine ganze Flotte auf einmal zu aktualisieren, und lassen Sie jedes Gerät sein eigenes Snippet ausführen, sobald seine Shell offen ist.",
				points: [
					"Eingabe an alle verbundenen Fenster senden",
					"Befehle beim Verbinden, pro Gerät",
					"Automatische Wiederverbindung mit Backoff und Keepalives",
					"Bestätigung vor dem Einfügen mehrerer Zeilen",
				],
				alt: "Drei Fenster empfangen denselben gesendeten Befehl",
			},
		},
	},
	security: {
		title: "Privat und sicher ab Werk",
		lede: "DaSSHboard ist eine lokale App. Ihre Geräte und Zugangsdaten verlassen nie Ihren Rechner.",
		items: [
			{
				title: "Nur lokal",
				body: "Kein Konto, keine Cloud, keine Telemetrie. Die App verbindet sich nur mit den Hosts, die Sie öffnen, und kontaktiert den Update-Server nur auf Wunsch — oder beim Start, wenn Sie das aktivieren.",
			},
			{
				title: "Geheimnisse im Schlüsselbund",
				body: "Passwörter und Schlüssel-Passphrasen werden im Schlüsselbund Ihres Betriebssystems gespeichert — nie in Konfigurationsdateien und nie in Exporten.",
			},
			{
				title: "Host-Schlüssel: Vertrauen bei der ersten Verbindung",
				body: "Jeder Host-Schlüssel wird bei der ersten Verbindung gemerkt. Ändert er sich, wird die Verbindung blockiert, bis Sie den neuen Schlüssel ausdrücklich akzeptieren.",
			},
			{
				title: "Schlüssel bleiben in Ihrem Agent",
				body: "Mit Authentifizierung über den SSH-Agent — Hardware-Token eingeschlossen — gelangen private Schlüssel nie in die App.",
			},
			{
				title: "Abgeschottete App, signierte Updates",
				body: "Eine strenge Content Security Policy ohne entfernte Inhalte und Update-Pakete, die vor der Installation eine gültige Signatur tragen müssen.",
			},
			{
				title: "Open Source, nichts versteckt",
				body: "MIT-lizenziert, der gesamte Code liegt auf GitHub – jeder kann genau prüfen, was die App tut.",
			},
		],
	},
	download: {
		title: "DaSSHboard {version} herunterladen",
		body: "Kostenlos und Open Source. Installer für Windows, macOS und Linux, mit signierten Updates direkt in der App.",
		installers: "Zu den Installern",
		releaseNotes: "Versionshinweise",
		platformsTitle: "Unterstützte Plattformen",
		columns: {
			platform: "Plattform",
			packages: "Pakete",
			updates: "Updates in der App",
		},
		rows: [
			{ platform: "Windows", packages: "MSI, setup .exe", updates: "Installieren und neu starten" },
			{ platform: "macOS", packages: ".dmg (Intel, Apple Silicon)", updates: "Installieren und neu starten" },
			{ platform: "Linux", packages: "AppImage", updates: "Installieren und neu starten" },
			{ platform: "Linux", packages: ".deb, .rpm", updates: "Hinweis mit Download-Link" },
		],
	},
	faq: {
		title: "Häufige Fragen",
		items: [
			{
				question: "Ist DaSSHboard kostenlos?",
				answer: "Ja. DaSSHboard ist kostenlos und Open Source unter der MIT-Lizenz, ohne Konto und ohne kostenpflichtige Version.",
			},
			{
				question: "Gibt es eine macOS-Version?",
				answer: "Ja, für Macs mit Intel und Apple Silicon. Die App ist nicht von Apple notarisiert, daher blockiert macOS den ersten Start: Öffnen Sie sie einmal und klicken Sie dann unter Systemeinstellungen → Datenschutz & Sicherheit auf „Dennoch öffnen“. Ziehen Sie die App vorher aus der .dmg in den Ordner „Programme“: Solange sie aus dem Disk-Image läuft, können In-App-Updates sie nicht ersetzen.",
			},
			{
				question: "Welche Authentifizierungsmethoden werden unterstützt?",
				answer: "Passwort, private Schlüsseldatei (mit optionaler Passphrase) und SSH-Agent — einschließlich Schlüsseln auf einem Hardware-Token.",
			},
			{
				question: "Kann ich meine vorhandenen Hosts importieren?",
				answer: "Ja. Importieren Sie Geräte aus Ihrer ~/.ssh/config und exportieren Sie sie wieder dorthin, oder übertragen Sie Geräte und Profile als JSON-Dateien zwischen Rechnern. Exporte enthalten nie Geheimnisse.",
			},
			{
				question: "Wo werden meine Daten gespeichert?",
				answer: "In einfachen JSON-Dateien im Konfigurationsordner der App (%APPDATA%\\com.dasshboard.app unter Windows, ~/Library/Application Support/com.dasshboard.app unter macOS, ~/.config/com.dasshboard.app unter Linux). Sie enthalten keine Geheimnisse, Sie können sie also bedenkenlos sichern.",
			},
			{
				question: "Wie funktionieren Updates?",
				answer: "Suchen Sie im Info-Dialog nach Updates oder aktivieren Sie eine Prüfung beim Start. Unter Windows, macOS und mit dem AppImage installiert „Installieren und neu starten“ das signierte Update; .deb- und .rpm-Installationen erhalten einen Link zum neuen Paket.",
			},
		],
	},
	footer: {
		builtWith: "DaSSHboard — gebaut mit Tauri, Rust und xterm.js.",
		license: "MIT-Lizenz",
		source: "Quellcode auf GitHub",
	},
};
