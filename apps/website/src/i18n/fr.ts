import type { SiteMessages } from "./en";

export const fr: SiteMessages = {
	meta: {
		title: "DaSSHboard — un tableau de bord de bureau pour vos appareils SSH",
		description:
			"Enregistrez vos appareils une fois, disposez des terminaux en direct dans une grille et rechargez tout l'espace de travail en un clic. Application de bureau gratuite pour Windows, macOS et Linux.",
	},
	nav: {
		features: "Fonctionnalités",
		howItWorks: "Fonctionnement",
		security: "Sécurité",
		faq: "FAQ",
		download: "Télécharger",
		github: "GitHub",
		language: "Langue",
		sections: "Sections de la page",
	},
	hero: {
		eyebrow: "v{version} · Windows, macOS et Linux",
		title: "Vos appareils SSH, un seul tableau de bord.",
		lede: "Enregistrez vos appareils une fois, disposez des terminaux en direct dans une grille et rechargez tout l'espace de travail en un clic.",
		localNote:
			"Ni compte, ni cloud, ni télémétrie — l'application ne communique qu'avec les hôtes auxquels vous vous connectez, et ne vérifie les mises à jour que si vous le demandez.",
		download: "Télécharger la v{version}",
		github: "Voir sur GitHub",
		shotAlt: "DaSSHboard avec quatre terminaux en direct disposés en grille",
	},
	features: {
		title: "Tout ce qu'il faut pour une journée passée dans le terminal",
		items: [
			{
				title: "Grille de terminaux en direct",
				body: "Disposez plusieurs terminaux en direct dans une grille — préréglages de 1×1 à 3×2 avec séparateurs déplaçables — et gardez des espaces de travail indépendants ouverts dans des onglets.",
			},
			{
				title: "SSH, série et shells locaux",
				body: "Un seul carnet d'adresses pour les hôtes SSH, les ports série/COM et les sessions locales PowerShell, bash ou zsh, avec étiquettes et recherche instantanée.",
			},
			{
				title: "Local par conception",
				body: "Ni compte, ni cloud, ni télémétrie. L'application se connecte uniquement aux hôtes que vous ouvrez ; vos appareils, profils et réglages sont de simples fichiers sur votre machine.",
			},
			{
				title: "Secrets et clés d'hôte protégés",
				body: "Les mots de passe et phrases secrètes restent uniquement dans le trousseau du système, jamais dans un fichier ou un export. Les clés d'hôte sont épinglées à la première connexion ; une clé modifiée exige votre accord explicite.",
			},
			{
				title: "Tunnels et hôtes de rebond",
				body: "Redirection de ports locale (ssh -L) démarrée et arrêtée depuis la barre latérale, ProxyJump via un bastion enregistré et transfert d'agent sur demande.",
			},
			{
				title: "Navigateur de fichiers SFTP",
				body: "Un panneau Fichiers ancré avec envois et téléchargements en flux, une file de transferts en arrière-plan, des favoris, le tri, le filtrage et chmod.",
			},
			{
				title: "Espaces de travail en un clic",
				body: "Enregistrez une disposition comme profil, définissez-en un par défaut et rechargez tout l'espace de travail — chaque panneau reconnecté — d'un seul clic.",
			},
			{
				title: "Pensé pour le quotidien",
				body: "Reconnexion automatique progressive, keepalives, commandes à la connexion, diffusion de la saisie, bascule sombre/clair en un clic et une interface en 7 langues.",
			},
		],
	},
	howItWorks: {
		title: "Opérationnel en trois étapes",
		lede: "Configurez une fois. Ensuite, tout votre espace de travail est à un clic.",
		steps: [
			{
				title: "Ajoutez vos appareils",
				body: "Saisissez des hôtes SSH, des ports série ou des shells locaux — ou importez-les directement depuis votre ~/.ssh/config. Étiquetez-les pour les retrouver instantanément.",
			},
			{
				title: "Organisez votre grille",
				body: "Choisissez une disposition de 1×1 à 3×2, sélectionnez un appareil dans chaque panneau et connectez-vous. Ouvrez d'autres onglets pour d'autres espaces de travail.",
			},
			{
				title: "Enregistrez-la comme profil",
				body: "Enregistrez l'espace de travail comme profil et définissez-le par défaut : la prochaine fois, chaque panneau se reconnecte au lancement ou en un clic.",
			},
		],
	},
	tour: {
		title: "En détail",
		lede: "Les outils que vous utilisez toute la journée, dans une seule fenêtre.",
		items: {
			grid: {
				title: "Une grille de terminaux en direct, dans des onglets",
				body: "Divisez chaque onglet en six panneaux maximum et redimensionnez-les librement. Les onglets gardent leurs sessions actives en arrière-plan et reviennent au relancement de l'application.",
				points: [
					"Préréglages de disposition de 1×1 à 3×2",
					"Séparateurs déplaçables et menu latéral redimensionnable",
					"Les onglets masqués restent connectés",
					"Onglets et dispositions restaurés au lancement",
				],
				alt: "Un onglet divisé en six panneaux de terminal",
			},
			sftp: {
				title: "Le panneau Fichiers, juste à côté de votre shell",
				body: "Parcourez les fichiers d'un appareil en SFTP dans un panneau ancré à côté de vos terminaux. Les transferts se font en arrière-plan : vous continuez à travailler pendant ce temps.",
				points: [
					"Envoi et téléchargement de dossiers entiers",
					"File de transferts en arrière-plan avec progression",
					"Actions groupées, tri et filtrage",
					"Favoris par appareil et chmod",
				],
				alt: "Le panneau Fichiers affichant un dossier distant avec un transfert en cours",
			},
			tunnels: {
				title: "Tunnels et hôtes de rebond, sans les options",
				body: "Définissez une fois les redirections de ports d'un appareil, puis démarrez-les et arrêtez-les depuis la carte Tunnels de la barre latérale. Atteignez les hôtes privés via un bastion enregistré.",
				points: [
					"Redirection de ports locale (ssh -L) avec démarrage automatique",
					"ProxyJump (ssh -J) via un appareil enregistré",
					"Transfert d'agent sur demande (ssh -A)",
					"État en direct de chaque redirection",
				],
				alt: "La carte Tunnels listant les redirections de ports locales et leur état",
			},
			broadcast: {
				title: "Tapez une fois, exécutez partout",
				body: "Diffusez votre saisie à tous les panneaux connectés pour mettre à jour un parc d'un coup, et laissez chaque appareil exécuter son propre extrait dès l'ouverture de son shell.",
				points: [
					"Diffusion de la saisie à tous les panneaux connectés",
					"Commandes à la connexion, par appareil",
					"Reconnexion automatique progressive et keepalives",
					"Confirmation avant de coller plusieurs lignes",
				],
				alt: "Trois panneaux recevant la même commande diffusée",
			},
		},
	},
	security: {
		title: "Privé et sécurisé par défaut",
		lede: "DaSSHboard est une application locale. Vos appareils et identifiants ne quittent jamais votre machine.",
		items: [
			{
				title: "Uniquement en local",
				body: "Ni compte, ni cloud, ni télémétrie. L'application se connecte uniquement aux hôtes que vous ouvrez et ne contacte le serveur de mises à jour que si vous le demandez — ou au démarrage si vous l'activez.",
			},
			{
				title: "Secrets dans le trousseau du système",
				body: "Les mots de passe et phrases secrètes des clés sont stockés dans le trousseau de votre système d'exploitation — jamais dans les fichiers de configuration, ni dans les exports.",
			},
			{
				title: "Clés d'hôte approuvées à la première utilisation",
				body: "Chaque clé d'hôte est épinglée lors de la première connexion. Si elle change, la connexion est bloquée jusqu'à ce que vous acceptiez explicitement la nouvelle clé.",
			},
			{
				title: "Les clés restent dans votre agent",
				body: "Avec l'authentification par agent SSH — clés matérielles comprises — les clés privées n'entrent jamais dans l'application.",
			},
			{
				title: "Application verrouillée, mises à jour signées",
				body: "Une politique de sécurité du contenu stricte sans contenu distant, et des paquets de mise à jour qui doivent porter une signature valide avant d'être installés.",
			},
			{
				title: "Open source, rien de caché",
				body: "Sous licence MIT, avec tout le code sur GitHub : chacun peut vérifier exactement ce que fait l'application.",
			},
		],
	},
	download: {
		title: "Télécharger DaSSHboard {version}",
		body: "Gratuit et open source. Installeurs pour Windows, macOS et Linux, avec mises à jour signées dans l'application.",
		installers: "Obtenir les installeurs",
		releaseNotes: "Notes de version",
		platformsTitle: "Plateformes prises en charge",
		columns: {
			platform: "Plateforme",
			packages: "Paquets",
			updates: "Mises à jour intégrées",
		},
		rows: [
			{ platform: "Windows", packages: "MSI, setup .exe", updates: "Installer et redémarrer" },
			{ platform: "macOS", packages: ".dmg (Intel, Apple Silicon)", updates: "Installer et redémarrer" },
			{ platform: "Linux", packages: "AppImage", updates: "Installer et redémarrer" },
			{ platform: "Linux", packages: ".deb, .rpm", updates: "Notification avec un lien de téléchargement" },
		],
	},
	faq: {
		title: "Questions fréquentes",
		items: [
			{
				question: "DaSSHboard est-il gratuit ?",
				answer: "Oui. DaSSHboard est gratuit et open source sous licence MIT, sans compte ni offre payante.",
			},
			{
				question: "Existe-t-il une version macOS ?",
				answer: "Oui, pour les Mac Intel et Apple Silicon. L'application n'est pas notarisée par Apple : macOS bloque donc son premier lancement. Essayez de l'ouvrir une fois, puis cliquez sur « Ouvrir quand même » dans Réglages Système → Confidentialité et sécurité. Glissez d'abord l'application du .dmg vers Applications : les mises à jour intégrées ne peuvent pas la remplacer tant qu'elle s'exécute depuis l'image disque.",
			},
			{
				question: "Quelles méthodes d'authentification sont prises en charge ?",
				answer: "Mot de passe, fichier de clé privée (avec phrase secrète facultative) et agent SSH — y compris les clés stockées sur une clé matérielle.",
			},
			{
				question: "Puis-je importer les hôtes que j'ai déjà ?",
				answer: "Oui. Importez des appareils depuis votre ~/.ssh/config et réexportez-les vers celui-ci, ou déplacez appareils et profils entre machines sous forme de fichiers JSON. Les exports ne contiennent jamais de secrets.",
			},
			{
				question: "Où mes données sont-elles stockées ?",
				answer: "Dans de simples fichiers JSON du dossier de configuration de l'application (%APPDATA%\\com.dasshboard.app sous Windows, ~/Library/Application Support/com.dasshboard.app sous macOS, ~/.config/com.dasshboard.app sous Linux). Ils ne contiennent aucun secret : vous pouvez les sauvegarder sans risque.",
			},
			{
				question: "Comment fonctionnent les mises à jour ?",
				answer: "Recherchez les mises à jour depuis la boîte À propos, ou activez une vérification au démarrage. Sous Windows, macOS et avec l'AppImage, « Installer et redémarrer » applique la mise à jour signée ; les installations .deb et .rpm reçoivent un lien vers le nouveau paquet.",
			},
		],
	},
	footer: {
		builtWith: "DaSSHboard — conçu avec Tauri, Rust et xterm.js.",
		license: "Licence MIT",
		source: "Code source sur GitHub",
	},
};
