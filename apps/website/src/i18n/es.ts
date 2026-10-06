import type { SiteMessages } from "./en";

export const es: SiteMessages = {
	meta: {
		title: "DaSSHboard — un panel de escritorio para tus dispositivos SSH",
		description:
			"Guarda tus dispositivos una vez, organiza terminales en vivo en una cuadrícula y recarga todo el espacio de trabajo con un clic. Aplicación de escritorio gratuita para Windows, macOS y Linux.",
	},
	nav: {
		features: "Funciones",
		howItWorks: "Cómo funciona",
		security: "Seguridad",
		faq: "Preguntas",
		download: "Descargar",
		github: "GitHub",
		language: "Idioma",
		sections: "Secciones de la página",
	},
	hero: {
		eyebrow: "v{version} · Windows, macOS y Linux",
		title: "Tus dispositivos SSH, un solo panel.",
		lede: "Guarda tus dispositivos una vez, organiza terminales en vivo en una cuadrícula y recarga todo el espacio de trabajo con un clic.",
		localNote:
			"Sin cuenta, sin nube, sin telemetría: la aplicación solo se comunica con los hosts a los que te conectas y solo busca actualizaciones cuando lo pides.",
		download: "Descargar v{version}",
		github: "Ver en GitHub",
		shotAlt: "DaSSHboard con cuatro terminales en vivo organizados en una cuadrícula",
	},
	features: {
		title: "Todo lo que necesita un día entre terminales",
		items: [
			{
				title: "Cuadrícula de terminales en vivo",
				body: "Organiza varios terminales en vivo en una cuadrícula —preajustes de 1×1 a 3×2 con divisores arrastrables— y mantén espacios de trabajo independientes abiertos en pestañas.",
			},
			{
				title: "SSH, serie y shells locales",
				body: "Una sola libreta de direcciones para hosts SSH, puertos serie/COM y sesiones locales de PowerShell, bash o zsh, con etiquetas y búsqueda instantánea.",
			},
			{
				title: "Local por diseño",
				body: "Sin cuenta, sin nube, sin telemetría. La aplicación solo se conecta a los hosts que abres; tus dispositivos, perfiles y ajustes son archivos normales en tu equipo.",
			},
			{
				title: "Secretos y claves de host, protegidos",
				body: "Las contraseñas y frases de contraseña viven solo en el llavero del sistema, nunca en un archivo ni en una exportación. Las claves de host se fijan en la primera conexión; una clave cambiada requiere tu aprobación explícita.",
			},
			{
				title: "Túneles y hosts de salto",
				body: "Reenvío de puertos local (ssh -L) y dinámico SOCKS (ssh -D) que se inicia y detiene desde la barra lateral, ProxyJump a través de un bastión guardado y reenvío del agente opcional.",
			},
			{
				title: "Explorador de archivos SFTP",
				body: "Un panel de Archivos acoplado con subidas y descargas en streaming, una cola de transferencias en segundo plano, marcadores, ordenación, filtrado y chmod, y archivos remotos que editas en tu propio editor.",
			},
			{
				title: "Espacios de trabajo en un clic",
				body: "Guarda una distribución como perfil, define uno predeterminado y recarga todo el espacio de trabajo —cada panel reconectado— con un solo clic.",
			},
			{
				title: "Hecho para el día a día",
				body: "Reconexión automática con espera progresiva, keepalives, comandos al conectar, difusión de la escritura, cambio de tema oscuro/claro en un clic y una interfaz en 7 idiomas.",
			},
		],
	},
	howItWorks: {
		title: "En marcha en tres pasos",
		lede: "Configúralo una vez. Después, todo tu espacio de trabajo está a un clic.",
		steps: [
			{
				title: "Añade tus dispositivos",
				body: "Introduce hosts SSH, puertos serie o shells locales, o impórtalos directamente desde tu ~/.ssh/config. Etiquétalos para encontrarlos al instante.",
			},
			{
				title: "Organiza tu cuadrícula",
				body: "Elige una distribución de 1×1 a 3×2, selecciona un dispositivo en cada panel y conéctate. Abre más pestañas para otros espacios de trabajo.",
			},
			{
				title: "Guárdala como perfil",
				body: "Guarda el espacio de trabajo como perfil y hazlo predeterminado: la próxima vez, cada panel se reconecta al iniciar o con un clic.",
			},
		],
	},
	tour: {
		title: "Más de cerca",
		lede: "Las herramientas que usas todo el día, en una sola ventana.",
		items: {
			grid: {
				title: "Una cuadrícula de terminales en vivo, en pestañas",
				body: "Divide cada pestaña en hasta seis paneles y cambia su tamaño libremente. Las pestañas mantienen sus sesiones activas en segundo plano y vuelven cuando reinicias la aplicación.",
				points: [
					"Preajustes de distribución de 1×1 a 3×2",
					"Divisores arrastrables y menú lateral redimensionable",
					"Las pestañas ocultas siguen conectadas",
					"Pestañas y distribuciones restauradas al iniciar",
				],
				alt: "Una pestaña dividida en seis paneles de terminal",
			},
			sftp: {
				title: "El panel de Archivos, junto a tu shell",
				body: "Explora los archivos de un dispositivo por SFTP en un panel acoplado junto a tus terminales. Las transferencias se ejecutan en segundo plano, así que sigues trabajando mientras tanto. Abre un archivo remoto en tu editor: cada vez que guardas, vuelve directo al servidor, con un aviso si alguien lo cambió mientras tanto.",
				points: [
					"Sube y descarga carpetas completas",
					"Cola de transferencias en segundo plano con progreso",
					"Acciones en bloque, marcadores, ordenación y filtrado",
					"Edita archivos remotos en tu propio editor",
				],
				alt: "El panel de Archivos mostrando un directorio remoto con una transferencia en curso",
			},
			tunnels: {
				title: "Túneles y hosts de salto, sin las opciones",
				body: "Define una vez los reenvíos de puertos de un dispositivo y luego inícialos y detenlos desde la tarjeta Túneles de la barra lateral. Llega a hosts privados a través de un bastión guardado.",
				points: [
					"Reenvíos locales (ssh -L) y dinámicos SOCKS (ssh -D) con inicio automático",
					"ProxyJump (ssh -J) a través de un dispositivo guardado",
					"Reenvío del agente opcional (ssh -A)",
					"Estado en vivo de cada reenvío",
				],
				alt: "La tarjeta Túneles con los reenvíos de puertos locales y su estado",
			},
			broadcast: {
				title: "Escribe una vez, ejecuta en todas partes",
				body: "Difunde lo que escribes a todos los paneles conectados para actualizar una flota de una vez, y deja que cada dispositivo ejecute su propio fragmento en cuanto se abre su shell.",
				points: [
					"Difusión de la escritura a todos los paneles conectados",
					"Comandos al conectar, por dispositivo",
					"Reconexión automática con espera progresiva y keepalives",
					"Confirmación antes de pegar varias líneas",
				],
				alt: "Tres paneles recibiendo el mismo comando difundido",
			},
		},
	},
	security: {
		title: "Privado y seguro por defecto",
		lede: "DaSSHboard es una aplicación local. Tus dispositivos y credenciales nunca salen de tu equipo.",
		items: [
			{
				title: "Solo local",
				body: "Sin cuenta, sin nube, sin telemetría. La aplicación solo se conecta a los hosts que abres y solo contacta con el servidor de actualizaciones cuando lo pides, o al iniciar si lo activas.",
			},
			{
				title: "Secretos en el llavero del sistema",
				body: "Las contraseñas y frases de contraseña de las claves se guardan en el llavero de tu sistema operativo: nunca en archivos de configuración ni en exportaciones.",
			},
			{
				title: "Claves de host de confianza en el primer uso",
				body: "Cada clave de host se fija la primera vez que te conectas. Si alguna vez cambia, la conexión se bloquea hasta que aceptes explícitamente la nueva clave.",
			},
			{
				title: "Las claves se quedan en tu agente",
				body: "Con la autenticación por agente SSH —llaves de hardware incluidas— las claves privadas nunca entran en la aplicación.",
			},
			{
				title: "Aplicación blindada, actualizaciones firmadas",
				body: "Una política de seguridad de contenido estricta sin contenido remoto, y paquetes de actualización que deben llevar una firma válida antes de instalarse.",
			},
			{
				title: "Código abierto, nada oculto",
				body: "Con licencia MIT y todo el código en GitHub: cualquiera puede auditar exactamente lo que hace la aplicación.",
			},
		],
	},
	download: {
		title: "Descargar DaSSHboard {version}",
		body: "Gratuito y de código abierto. Instaladores para Windows, macOS y Linux, con actualizaciones firmadas desde la aplicación.",
		installers: "Obtener los instaladores",
		releaseNotes: "Notas de la versión",
		platformsTitle: "Plataformas compatibles",
		columns: {
			platform: "Plataforma",
			packages: "Paquetes",
			updates: "Actualizaciones integradas",
		},
		rows: [
			{ platform: "Windows", packages: "MSI, setup .exe", updates: "Instalar y reiniciar" },
			{ platform: "macOS", packages: ".dmg (Intel, Apple Silicon)", updates: "Instalar y reiniciar" },
			{ platform: "Linux", packages: "AppImage", updates: "Instalar y reiniciar" },
			{ platform: "Linux", packages: ".deb, .rpm", updates: "Aviso con un enlace de descarga" },
			{ platform: "Linux", packages: "Flatpak", updates: "Con flatpak update o tu centro de software" },
		],
		flatpak: {
			title: "Instalar el Flatpak",
			body: "En cualquier distribución Linux, ejecuta este comando o abre el archivo .flatpakref con tu centro de software. Las actualizaciones llegan después a través de Flatpak.",
			ref: "Descargar el .flatpakref",
		},
	},
	faq: {
		title: "Preguntas frecuentes",
		items: [
			{
				question: "¿DaSSHboard es gratuito?",
				answer: "Sí. DaSSHboard es gratuito y de código abierto bajo la licencia MIT, sin cuenta ni planes de pago. Para siempre.",
			},
			{
				question: "¿Hay una versión para macOS?",
				answer: "Sí, para Mac con Intel y Apple Silicon. La aplicación no está notarizada por Apple, así que macOS bloquea su primer arranque: intenta abrirla una vez y luego pulsa «Abrir igualmente» en Ajustes del Sistema → Privacidad y seguridad. Antes, arrastra la aplicación del .dmg a Aplicaciones: las actualizaciones integradas no pueden reemplazarla mientras se ejecuta desde la imagen de disco.",
			},
			{
				question: "¿Qué métodos de autenticación admite?",
				answer: "Contraseña, archivo de clave privada (con frase de contraseña opcional) y agente SSH, incluidas las claves guardadas en una llave de hardware.",
			},
			{
				question: "¿Puedo importar los hosts que ya tengo?",
				answer: "Sí. Importa dispositivos desde tu ~/.ssh/config y vuelve a exportarlos a él, o mueve dispositivos y perfiles entre equipos como archivos JSON. Las exportaciones nunca contienen secretos.",
			},
			{
				question: "¿Dónde se guardan mis datos?",
				answer: "En archivos JSON normales en la carpeta de configuración de la aplicación (%APPDATA%\\com.dasshboard.app en Windows, ~/Library/Application Support/com.dasshboard.app en macOS, ~/.config/com.dasshboard.app en Linux). No contienen secretos, así que puedes hacer copias de seguridad sin riesgo.",
			},
			{
				question: "¿Cómo funcionan las actualizaciones?",
				answer: "Busca actualizaciones desde el cuadro Acerca de, o activa una comprobación al iniciar. En Windows, macOS y con la AppImage, «Instalar y reiniciar» aplica la actualización firmada; las instalaciones .deb y .rpm reciben un enlace al nuevo paquete.",
			},
		],
	},
	lightbox: {
		close: "Cerrar",
	},
	footer: {
		builtWith: "DaSSHboard — creado con Tauri, Rust y xterm.js.",
		license: "Licencia MIT",
		source: "Código fuente en GitHub",
	},
};
