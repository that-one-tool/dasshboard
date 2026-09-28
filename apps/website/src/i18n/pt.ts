import type { SiteMessages } from "./en";

// European Portuguese, matching the desktop app's pt table.
export const pt: SiteMessages = {
	meta: {
		title: "DaSSHboard — um painel de ambiente de trabalho para os seus dispositivos SSH",
		description:
			"Guarde os seus dispositivos uma vez, organize terminais em direto numa grelha e recarregue todo o espaço de trabalho com um clique. Aplicação gratuita para Windows, macOS e Linux.",
	},
	nav: {
		features: "Funcionalidades",
		howItWorks: "Como funciona",
		security: "Segurança",
		faq: "Perguntas",
		download: "Transferir",
		github: "GitHub",
		language: "Idioma",
		sections: "Secções da página",
	},
	hero: {
		eyebrow: "v{version} · Windows, macOS e Linux",
		title: "Os seus dispositivos SSH, um só painel.",
		lede: "Guarde os seus dispositivos uma vez, organize terminais em direto numa grelha e recarregue todo o espaço de trabalho com um clique.",
		localNote:
			"Sem conta, sem nuvem, sem telemetria — a aplicação só comunica com os anfitriões a que se liga e só procura atualizações quando pede.",
		download: "Transferir v{version}",
		github: "Ver no GitHub",
		shotAlt: "DaSSHboard com quatro terminais em direto organizados numa grelha",
	},
	features: {
		title: "Tudo o que um dia passado no terminal precisa",
		items: [
			{
				title: "Grelha de terminais em direto",
				body: "Organize vários terminais em direto numa grelha — predefinições de 1×1 a 3×2 com divisores arrastáveis — e mantenha espaços de trabalho independentes abertos em separadores.",
			},
			{
				title: "SSH, série e shells locais",
				body: "Um só livro de endereços para anfitriões SSH, portas série/COM e sessões locais de PowerShell, bash ou zsh, com etiquetas e pesquisa instantânea.",
			},
			{
				title: "Local por conceção",
				body: "Sem conta, sem nuvem, sem telemetria. A aplicação só se liga aos anfitriões que abre; os seus dispositivos, perfis e definições são ficheiros simples no seu computador.",
			},
			{
				title: "Segredos e chaves de anfitrião protegidos",
				body: "As palavras-passe e frases-passe ficam apenas no porta-chaves do sistema, nunca num ficheiro ou exportação. As chaves de anfitrião são fixadas na primeira ligação; uma chave alterada exige a sua aprovação explícita.",
			},
			{
				title: "Túneis e anfitriões de salto",
				body: "Reencaminhamento de portas local (ssh -L) iniciado e parado a partir da barra lateral, ProxyJump através de um bastião guardado e reencaminhamento do agente opcional.",
			},
			{
				title: "Explorador de ficheiros SFTP",
				body: "Um painel Ficheiros ancorado com envios e transferências em streaming, uma fila de transferências em segundo plano, marcadores, ordenação, filtragem e chmod.",
			},
			{
				title: "Espaços de trabalho num clique",
				body: "Guarde uma disposição como perfil, defina uma predefinição e recarregue todo o espaço de trabalho — cada painel religado — com um único clique.",
			},
			{
				title: "Feito para o dia a dia",
				body: "Religação automática com espera progressiva, keepalives, comandos ao ligar, difusão da escrita, alternância de tema escuro/claro num clique e uma interface em 7 idiomas.",
			},
		],
	},
	howItWorks: {
		title: "A funcionar em três passos",
		lede: "Configure uma vez. Depois, todo o seu espaço de trabalho fica à distância de um clique.",
		steps: [
			{
				title: "Adicione os seus dispositivos",
				body: "Introduza anfitriões SSH, portas série ou shells locais — ou importe-os diretamente do seu ~/.ssh/config. Use etiquetas para os encontrar num instante.",
			},
			{
				title: "Organize a sua grelha",
				body: "Escolha uma disposição de 1×1 a 3×2, selecione um dispositivo em cada painel e ligue-se. Abra mais separadores para outros espaços de trabalho.",
			},
			{
				title: "Guarde-a como perfil",
				body: "Guarde o espaço de trabalho como perfil e torne-o predefinido: da próxima vez, cada painel volta a ligar-se ao iniciar ou com um clique.",
			},
		],
	},
	tour: {
		title: "Em pormenor",
		lede: "As ferramentas que usa todo o dia, numa só janela.",
		items: {
			grid: {
				title: "Uma grelha de terminais em direto, em separadores",
				body: "Divida cada separador em até seis painéis e redimensione-os livremente. Os separadores mantêm as sessões ativas em segundo plano e regressam quando reinicia a aplicação.",
				points: [
					"Predefinições de disposição de 1×1 a 3×2",
					"Divisores arrastáveis e menu lateral redimensionável",
					"Os separadores ocultos continuam ligados",
					"Separadores e disposições restaurados ao iniciar",
				],
				alt: "Um separador dividido em seis painéis de terminal",
			},
			sftp: {
				title: "O painel Ficheiros, mesmo ao lado da sua shell",
				body: "Explore os ficheiros de um dispositivo por SFTP num painel ancorado junto aos seus terminais. As transferências decorrem em segundo plano, por isso continua a trabalhar entretanto.",
				points: [
					"Envie e transfira pastas inteiras",
					"Fila de transferências em segundo plano com progresso",
					"Ações em massa, ordenação e filtragem",
					"Marcadores por dispositivo e chmod",
				],
				alt: "O painel Ficheiros a mostrar uma pasta remota com uma transferência em curso",
			},
			tunnels: {
				title: "Túneis e anfitriões de salto, sem as opções",
				body: "Defina uma vez os reencaminhamentos de portas de um dispositivo e depois inicie-os e pare-os a partir do cartão Túneis na barra lateral. Chegue a anfitriões privados através de um bastião guardado.",
				points: [
					"Reencaminhamento de portas local (ssh -L) com início automático",
					"ProxyJump (ssh -J) através de um dispositivo guardado",
					"Reencaminhamento do agente opcional (ssh -A)",
					"Estado em direto de cada reencaminhamento",
				],
				alt: "O cartão Túneis com os reencaminhamentos de portas locais e o seu estado",
			},
			broadcast: {
				title: "Escreva uma vez, execute em todo o lado",
				body: "Difunda o que escreve para todos os painéis ligados para atualizar uma frota de uma só vez, e deixe cada dispositivo executar o seu próprio excerto assim que a shell abre.",
				points: [
					"Difusão da escrita para todos os painéis ligados",
					"Comandos ao ligar, por dispositivo",
					"Religação automática com espera progressiva e keepalives",
					"Confirmação antes de colar várias linhas",
				],
				alt: "Três painéis a receber o mesmo comando difundido",
			},
		},
	},
	security: {
		title: "Privado e seguro por predefinição",
		lede: "O DaSSHboard é uma aplicação local. Os seus dispositivos e credenciais nunca saem do seu computador.",
		items: [
			{
				title: "Apenas local",
				body: "Sem conta, sem nuvem, sem telemetria. A aplicação só se liga aos anfitriões que abre e só contacta o servidor de atualizações quando pede — ou ao iniciar, se o ativar.",
			},
			{
				title: "Segredos no porta-chaves do sistema",
				body: "As palavras-passe e frases-passe das chaves são guardadas no porta-chaves do seu sistema operativo — nunca em ficheiros de configuração, nem em exportações.",
			},
			{
				title: "Chaves de anfitrião fidedignas na primeira utilização",
				body: "Cada chave de anfitrião é fixada na primeira ligação. Se alguma vez mudar, a ligação fica bloqueada até aceitar explicitamente a nova chave.",
			},
			{
				title: "As chaves ficam no seu agente",
				body: "Com a autenticação por agente SSH — tokens de hardware incluídos — as chaves privadas nunca entram na aplicação.",
			},
			{
				title: "Aplicação blindada, atualizações assinadas",
				body: "Uma política de segurança de conteúdo rigorosa sem conteúdo remoto, e pacotes de atualização que têm de ter uma assinatura válida antes de serem instalados.",
			},
		],
	},
	download: {
		title: "Transferir o DaSSHboard {version}",
		body: "Gratuito e de código aberto. Instaladores para Windows, macOS e Linux, com atualizações assinadas na aplicação.",
		installers: "Obter os instaladores",
		releaseNotes: "Notas de versão",
		platformsTitle: "Plataformas suportadas",
		columns: {
			platform: "Plataforma",
			packages: "Pacotes",
			updates: "Atualizações na aplicação",
		},
		rows: [
			{ platform: "Windows", packages: "MSI, setup .exe", updates: "Instalar e reiniciar" },
			{ platform: "macOS", packages: ".dmg (Intel, Apple Silicon)", updates: "Instalar e reiniciar" },
			{ platform: "Linux", packages: "AppImage", updates: "Instalar e reiniciar" },
			{ platform: "Linux", packages: ".deb, .rpm", updates: "Aviso com uma ligação de transferência" },
		],
	},
	faq: {
		title: "Perguntas frequentes",
		items: [
			{
				question: "O DaSSHboard é gratuito?",
				answer: "Sim. O DaSSHboard é gratuito e de código aberto sob a licença MIT, sem conta nem planos pagos.",
			},
			{
				question: "Existe uma versão para macOS?",
				answer: "Sim, para Macs Intel e Apple Silicon. A aplicação não é notarizada pela Apple, por isso o macOS bloqueia a primeira abertura: tente abri-la uma vez e depois clique em «Abrir mesmo assim» em Definições do Sistema → Privacidade e segurança. Antes, arraste a aplicação do .dmg para Aplicações: as atualizações na aplicação não a conseguem substituir enquanto é executada a partir da imagem de disco.",
			},
			{
				question: "Que métodos de autenticação são suportados?",
				answer: "Palavra-passe, ficheiro de chave privada (com frase-passe opcional) e agente SSH — incluindo chaves guardadas num token de hardware.",
			},
			{
				question: "Posso importar os anfitriões que já tenho?",
				answer: "Sim. Importe dispositivos do seu ~/.ssh/config e volte a exportá-los para lá, ou mova dispositivos e perfis entre computadores como ficheiros JSON. As exportações nunca contêm segredos.",
			},
			{
				question: "Onde são guardados os meus dados?",
				answer: "Em ficheiros JSON simples na pasta de configuração da aplicação (%APPDATA%\\com.dasshboard.app no Windows, ~/Library/Application Support/com.dasshboard.app no macOS, ~/.config/com.dasshboard.app no Linux). Não contêm segredos, por isso pode fazer cópias de segurança sem risco.",
			},
			{
				question: "Como funcionam as atualizações?",
				answer: "Procure atualizações na caixa Acerca de, ou ative uma verificação ao iniciar. No Windows, no macOS e com a AppImage, «Instalar e reiniciar» aplica a atualização assinada; as instalações .deb e .rpm recebem uma ligação para o novo pacote.",
			},
		],
	},
	footer: {
		builtWith: "DaSSHboard — feito com Tauri, Rust e xterm.js.",
		license: "Licença MIT",
		source: "Código-fonte no GitHub",
	},
};
