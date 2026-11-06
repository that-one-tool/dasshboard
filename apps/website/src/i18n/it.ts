import type { SiteMessages } from "./en";

export const it: SiteMessages = {
	meta: {
		title: "DaSSHboard — una dashboard desktop per i tuoi dispositivi SSH",
		description:
			"Salva i tuoi dispositivi una volta, disponi terminali live in una griglia e ricarica l'intera area di lavoro con un clic. App desktop gratuita per Windows, macOS e Linux.",
	},
	nav: {
		features: "Funzionalità",
		howItWorks: "Come funziona",
		security: "Sicurezza",
		faq: "FAQ",
		download: "Download",
		github: "GitHub",
		language: "Lingua",
		sections: "Sezioni della pagina",
	},
	hero: {
		eyebrow: "v{version} · Windows, macOS e Linux",
		title: "I tuoi dispositivi SSH, una sola dashboard.",
		lede: "Salva i tuoi dispositivi una volta, disponi terminali live in una griglia e ricarica l'intera area di lavoro con un clic.",
		localNote:
			"Nessun account, nessun cloud, nessuna telemetria — l'app comunica solo con gli host a cui ti connetti e cerca aggiornamenti solo quando lo chiedi.",
		download: "Scarica v{version}",
		github: "Vedi su GitHub",
		shotAlt: "DaSSHboard con quattro terminali live disposti in una griglia",
	},
	features: {
		title: "Tutto ciò che serve a una giornata passata nel terminale",
		items: [
			{
				title: "Griglia di terminali live",
				body: "Disponi più terminali live in una griglia — da 1×1 a 3×2 con divisori trascinabili — e tieni aperte aree di lavoro indipendenti come schede.",
			},
			{
				title: "SSH, seriale e shell locali",
				body: "Un'unica rubrica per host SSH, porte seriali/COM e sessioni locali PowerShell, bash o zsh, con tag e ricerca istantanea.",
			},
			{
				title: "Solo locale, per scelta",
				body: "Nessun account, nessun cloud, nessuna telemetria. L'app si connette solo agli host che apri; dispositivi, profili e impostazioni sono semplici file sul tuo computer.",
			},
			{
				title: "Segreti e chiavi host al sicuro",
				body: "Password e passphrase risiedono solo nel portachiavi del sistema operativo, mai in un file o in un'esportazione. Le chiavi host vengono fissate alla prima connessione; una chiave cambiata richiede la tua approvazione esplicita.",
			},
			{
				title: "Tunnel e host di salto",
				body: "Inoltro di porte locale (ssh -L), remoto (ssh -R) e SOCKS dinamico (ssh -D) avviabile e arrestabile dalla barra laterale, ProxyJump tramite un bastion salvato e inoltro dell'agente su richiesta.",
			},
			{
				title: "Browser di file SFTP",
				body: "Un pannello File agganciato con upload e download in streaming, una coda di trasferimenti in background, segnalibri, ordinamento, filtri e chmod — e in più file remoti da modificare nel tuo editor.",
			},
			{
				title: "Aree di lavoro in un clic",
				body: "Salva una disposizione come profilo, impostane uno predefinito e ricarica l'intera area di lavoro — con ogni riquadro riconnesso — in un solo clic.",
			},
			{
				title: "Fatta per viverci dentro",
				body: "Riconnessione automatica con backoff, keepalive, comandi alla connessione, trasmissione dell'input, ricerca e salvataggio della cronologia del terminale, registrazione di una sessione in un file di log, link cliccabili, tema scuro/chiaro in un clic e un'interfaccia in {languageCount} lingue.",
			},
		],
	},
	howItWorks: {
		title: "Operativo in tre passi",
		lede: "Configuralo una volta. Dopo, l'intera area di lavoro è a un clic di distanza.",
		steps: [
			{
				title: "Aggiungi i tuoi dispositivi",
				body: "Inserisci host SSH, porte seriali o shell locali — oppure importali direttamente dal tuo ~/.ssh/config. Assegna dei tag per ritrovarli all'istante.",
			},
			{
				title: "Disponi la griglia",
				body: "Scegli una disposizione da 1×1 a 3×2, seleziona un dispositivo in ogni riquadro e connettiti. Apri altre schede per altre aree di lavoro.",
			},
			{
				title: "Salvala come profilo",
				body: "Salva l'area di lavoro come profilo e rendila predefinita: la prossima volta ogni riquadro si riconnette all'avvio o con un clic.",
			},
		],
	},
	tour: {
		title: "Uno sguardo più da vicino",
		lede: "Gli strumenti che usi tutto il giorno, in un'unica finestra.",
		items: {
			grid: {
				title: "Una griglia di terminali live, in schede",
				body: "Dividi ogni scheda in un massimo di sei riquadri e ridimensionali liberamente. Le schede mantengono attive le sessioni in background e tornano quando riavvii l'app.",
				points: [
					"Disposizioni predefinite da 1×1 a 3×2",
					"Divisori trascinabili e menu laterale ridimensionabile",
					"Le schede nascoste restano connesse",
					"Schede e disposizioni ripristinate all'avvio",
				],
				alt: "Una scheda divisa in sei riquadri di terminale",
			},
			sftp: {
				title: "Il pannello File, proprio accanto alla shell",
				body: "Sfoglia i file di un dispositivo via SFTP in un pannello agganciato accanto ai terminali. I trasferimenti avvengono in background, così continui a lavorare mentre sono in corso. Apri un file remoto nel tuo editor: ogni salvataggio torna subito sul server, con un avviso se nel frattempo qualcuno lo ha modificato.",
				points: [
					"Upload e download di intere cartelle",
					"Coda di trasferimenti in background con avanzamento",
					"Azioni multiple, segnalibri, ordinamento e filtri",
					"Modifica i file remoti nel tuo editor",
				],
				alt: "Il pannello File che sfoglia una cartella remota con un trasferimento in corso",
			},
			tunnels: {
				title: "Tunnel e host di salto, senza flag",
				body: "Definisci una volta gli inoltri di porta di un dispositivo, poi avviali e fermali dal pannello Tunnel nella barra laterale. Raggiungi host privati tramite un bastion salvato.",
				points: [
					"Inoltri locali (ssh -L), remoti (ssh -R) e SOCKS dinamici (ssh -D) con avvio automatico",
					"ProxyJump (ssh -J) tramite un dispositivo salvato",
					"Inoltro dell'agente (ssh -A) e di X11 (ssh -X / -Y) su richiesta",
					"Stato in tempo reale per ogni inoltro",
				],
				alt: "Il pannello Tunnel con l'elenco degli inoltri di porta locali e il loro stato",
			},
			broadcast: {
				title: "Digita una volta, esegui ovunque",
				body: "Trasmetti i tasti premuti a tutti i riquadri connessi per aggiornare un intero parco macchine in un colpo solo, e lascia che ogni dispositivo esegua il proprio snippet appena si apre la sua shell.",
				points: [
					"Trasmissione dell'input a tutti i riquadri connessi",
					"Comandi alla connessione, per dispositivo",
					"Una libreria di comandi salvati, inviati a un riquadro o a tutti",
					"Riconnessione automatica con backoff e keepalive",
					"Conferma prima di incollare più righe",
				],
				alt: "Tre riquadri che ricevono lo stesso comando trasmesso",
			},
		},
	},
	security: {
		title: "Privato e sicuro per impostazione predefinita",
		lede: "DaSSHboard è un'app locale. I tuoi dispositivi e le tue credenziali non lasciano mai il tuo computer.",
		items: [
			{
				title: "Solo locale",
				body: "Nessun account, nessun cloud, nessuna telemetria. L'app si connette solo agli host che apri e contatta il server degli aggiornamenti solo quando lo chiedi — o all'avvio, se lo attivi.",
			},
			{
				title: "Segreti nel portachiavi del sistema",
				body: "Password e passphrase delle chiavi sono conservate nel portachiavi del sistema operativo — mai nei file di configurazione e mai nelle esportazioni.",
			},
			{
				title: "Chiavi host, attendibili al primo utilizzo",
				body: "Ogni chiave host viene fissata la prima volta che ti connetti. Se dovesse cambiare, la connessione viene bloccata finché non accetti esplicitamente la nuova chiave.",
			},
			{
				title: "Le chiavi restano nel tuo agente",
				body: "Con l'autenticazione tramite agente SSH — token hardware inclusi — le chiavi private non entrano mai nell'app.",
			},
			{
				title: "App blindata, aggiornamenti firmati",
				body: "Una content security policy rigorosa senza contenuti remoti e pacchetti di aggiornamento che devono avere una firma valida prima di essere installati.",
			},
			{
				title: "Open source, niente di nascosto",
				body: "Con licenza MIT e ogni riga di codice su GitHub — chiunque può verificare esattamente cosa fa l'app.",
			},
		],
	},
	download: {
		title: "Scarica DaSSHboard {version}",
		body: "Gratuito e open source. Installer per Windows, macOS e Linux, con aggiornamenti in-app firmati.",
		installers: "Scarica gli installer",
		releaseNotes: "Note di rilascio",
		platformsTitle: "Piattaforme supportate",
		columns: {
			platform: "Piattaforma",
			packages: "Pacchetti",
			updates: "Aggiornamenti in-app",
		},
		rows: [
			{ platform: "Windows", packages: "MSI, setup .exe", updates: "Installa e riavvia" },
			{ platform: "macOS", packages: ".dmg (Intel, Apple Silicon)", updates: "Installa e riavvia" },
			{ platform: "Linux", packages: "AppImage", updates: "Installa e riavvia" },
			{ platform: "Linux", packages: ".deb, .rpm", updates: "Notifica con un link per il download" },
			{ platform: "Linux", packages: "Flatpak", updates: "Tramite flatpak update o il tuo gestore software" },
		],
		flatpak: {
			title: "Installa il Flatpak",
			body: "Su qualsiasi distribuzione Linux, esegui questo comando oppure apri il file .flatpakref con il tuo gestore software. Gli aggiornamenti arriveranno poi tramite Flatpak.",
			ref: "Scarica il .flatpakref",
		},
	},
	faq: {
		title: "Domande frequenti",
		items: [
			{
				question: "DaSSHboard è gratuito?",
				answer: "Sì. DaSSHboard è gratuito e open source con licenza MIT, senza account e senza piani a pagamento. Per sempre.",
			},
			{
				question: "Esiste una versione per macOS?",
				answer: "Sì, per Mac Intel e Apple Silicon. L'app non è notarizzata da Apple, quindi macOS ne blocca il primo avvio: prova ad aprirla una volta, poi fai clic su Apri comunque in Impostazioni di Sistema → Privacy e sicurezza. Prima trascina l'app dal .dmg in Applicazioni: gli aggiornamenti in-app non possono sostituirla mentre viene eseguita dall'immagine disco.",
			},
			{
				question: "Quali metodi di autenticazione sono supportati?",
				answer: "Password, file di chiave privata (con passphrase facoltativa) e agente SSH — incluse le chiavi conservate su un token hardware. Se un server chiede di più, come un codice monouso (2FA) o altre domande PAM, si risponde in una finestra di dialogo.",
			},
			{
				question: "Posso importare gli host che ho già?",
				answer: "Sì. Importa i dispositivi dal tuo ~/.ssh/config ed esportali di nuovo lì, oppure sposta dispositivi e profili tra computer come file JSON. Le esportazioni non contengono mai segreti.",
			},
			{
				question: "Dove vengono salvati i miei dati?",
				answer: "In semplici file JSON nella cartella di configurazione dell'app (%APPDATA%\\com.dasshboard.app su Windows, ~/Library/Application Support/com.dasshboard.app su macOS, ~/.config/com.dasshboard.app su Linux). Non contengono segreti, quindi puoi farne il backup in sicurezza.",
			},
			{
				question: "Come funzionano gli aggiornamenti?",
				answer: "Cerca gli aggiornamenti dalla finestra Informazioni, oppure attiva il controllo all'avvio. Su Windows, macOS e con l'AppImage, Installa e riavvia applica l'aggiornamento firmato; le installazioni .deb e .rpm ricevono un link al nuovo pacchetto.",
			},
		],
	},
	lightbox: {
		close: "Chiudi",
	},
	footer: {
		builtWith: "DaSSHboard — realizzato con Tauri, Rust e xterm.js.",
		license: "Licenza MIT",
		source: "Codice sorgente su GitHub",
	},
};
