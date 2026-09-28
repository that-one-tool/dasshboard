import type { SiteMessages } from "./en";

export const zh: SiteMessages = {
	meta: {
		title: "DaSSHboard — 管理 SSH 设备的桌面仪表板",
		description: "设备只需保存一次，在网格中排列实时终端，一键重新加载整个工作区。适用于 Windows、macOS 和 Linux 的免费桌面应用。",
	},
	nav: {
		features: "功能",
		howItWorks: "使用方法",
		security: "安全",
		faq: "常见问题",
		download: "下载",
		github: "GitHub",
		language: "语言",
		sections: "页面章节",
	},
	hero: {
		eyebrow: "v{version} · Windows、macOS 和 Linux",
		title: "所有 SSH 设备，尽在一个仪表板。",
		lede: "设备只需保存一次，在网格中排列实时终端，一键重新加载整个工作区。",
		localNote: "无需账号，不用云端，没有遥测——应用只与你连接的主机通信，并且只在你要求时检查更新。",
		download: "下载 v{version}",
		github: "在 GitHub 上查看",
		shotAlt: "DaSSHboard 在网格中显示四个实时终端",
	},
	features: {
		title: "终端密集型工作所需的一切",
		items: [
			{
				title: "实时终端网格",
				body: "在网格中排列多个实时终端——从 1×1 到 3×2 的预设布局，分隔条可拖动——并以标签页形式保持多个独立工作区。",
			},
			{
				title: "SSH、串口和本地 Shell",
				body: "一个通讯录管理 SSH 主机、串口/COM 端口以及本地 PowerShell、bash 或 zsh 会话，支持标签和即时搜索。",
			},
			{
				title: "天生本地",
				body: "无需账号，不用云端，没有遥测。应用只连接你打开的主机；你的设备、配置文件和设置都是你电脑上的普通文件。",
			},
			{
				title: "密钥与主机密钥，严密保护",
				body: "密码和密钥口令只保存在操作系统的钥匙串中，绝不写入文件或导出。主机密钥在首次连接时固定；密钥一旦变化，必须经你明确确认。",
			},
			{
				title: "隧道与跳板机",
				body: "本地端口转发（ssh -L），可在侧边栏启动/停止；通过已保存的堡垒机进行 ProxyJump；可选的代理转发。",
			},
			{
				title: "SFTP 文件浏览器",
				body: "停靠式“文件”面板，支持流式上传和下载、后台传输队列、书签、排序、筛选和 chmod。",
			},
			{
				title: "一键恢复工作区",
				body: "将布局保存为配置文件，设为默认，只需一次点击即可重新加载整个工作区——每个窗格都会重新连接。",
			},
			{
				title: "为日常使用而生",
				body: "带退避的自动重连、keepalive、连接时执行命令、广播输入、一键切换深色/浅色主题，界面支持 7 种语言。",
			},
		],
	},
	howItWorks: {
		title: "三步即可上手",
		lede: "只需设置一次，之后整个工作区一键即达。",
		steps: [
			{
				title: "添加设备",
				body: "输入 SSH 主机、串口或本地 Shell——或直接从 ~/.ssh/config 导入。添加标签，随时快速找到。",
			},
			{
				title: "排列网格",
				body: "选择 1×1 到 3×2 的布局，在每个窗格中选择设备并连接。为其他工作区打开更多标签页。",
			},
			{
				title: "保存为配置文件",
				body: "将工作区保存为配置文件并设为默认：下次启动时或只需一次点击，所有窗格都会重新连接。",
			},
		],
	},
	tour: {
		title: "深入了解",
		lede: "你每天都要用到的工具，尽在一个窗口。",
		items: {
			grid: {
				title: "标签页中的实时终端网格",
				body: "每个标签页最多可拆分为六个窗格，大小随意调整。标签页在后台保持会话运行，重新启动应用后依然恢复。",
				points: ["从 1×1 到 3×2 的布局预设", "可拖动的分隔条和可调宽度的侧边菜单", "隐藏的标签页保持连接", "启动时恢复标签页和布局"],
				alt: "一个标签页被拆分为六个终端窗格",
			},
			sftp: {
				title: "“文件”面板，就在 Shell 旁边",
				body: "在终端旁的停靠面板中通过 SFTP 浏览设备上的文件。传输在后台进行，你可以同时继续工作。",
				points: ["上传和下载整个文件夹", "带进度显示的后台传输队列", "批量操作、排序和筛选", "按设备保存书签，支持 chmod"],
				alt: "“文件”面板正在浏览远程目录，并有一个传输正在进行",
			},
			tunnels: {
				title: "隧道和跳板机，无需记参数",
				body: "为设备定义一次端口转发，然后在侧边栏的“隧道”卡片中启动和停止。通过已保存的堡垒机访问私有主机。",
				points: ["本地端口转发（ssh -L），支持自动启动", "通过已保存的设备进行 ProxyJump（ssh -J）", "可选的代理转发（ssh -A）", "每个转发的实时状态"],
				alt: "“隧道”卡片列出本地端口转发及其状态",
			},
			broadcast: {
				title: "输入一次，处处执行",
				body: "将键入内容广播到所有已连接的窗格，一次更新整批服务器；并让每台设备在 Shell 打开后立即运行自己的命令片段。",
				points: ["向所有已连接窗格广播输入", "按设备配置连接时执行的命令", "带退避的自动重连和 keepalive", "粘贴多行前先确认"],
				alt: "三个窗格同时接收同一条广播命令",
			},
		},
	},
	security: {
		title: "默认即私密、安全",
		lede: "DaSSHboard 是本地应用。你的设备和凭据永远不会离开你的电脑。",
		items: [
			{
				title: "纯本地",
				body: "无需账号，不用云端，没有遥测。应用只连接你打开的主机，只在你要求时（或你选择启用的启动检查时）联系更新服务器。",
			},
			{
				title: "密钥存于系统钥匙串",
				body: "密码和密钥口令保存在操作系统的钥匙串中——绝不写入配置文件，也绝不包含在导出中。",
			},
			{
				title: "主机密钥首次使用即信任",
				body: "每个主机密钥在首次连接时固定。一旦发生变化，连接将被阻止，直到你明确接受新密钥。",
			},
			{
				title: "私钥留在你的代理中",
				body: "使用 SSH 代理认证（包括硬件令牌）时，私钥永远不会进入应用。",
			},
			{
				title: "严格锁定的应用，签名的更新",
				body: "严格的内容安全策略，不加载任何远程内容；更新包必须带有有效签名才能安装。",
			},
			{
				title: "开源，毫无隐藏",
				body: "采用 MIT 许可证，全部代码公开在 GitHub 上，任何人都能审查应用究竟做了什么。",
			},
		],
	},
	download: {
		title: "下载 DaSSHboard {version}",
		body: "免费且开源。提供 Windows、macOS 和 Linux 安装包，支持应用内签名更新。",
		installers: "获取安装包",
		releaseNotes: "发行说明",
		platformsTitle: "支持的平台",
		columns: {
			platform: "平台",
			packages: "安装包",
			updates: "应用内更新",
		},
		rows: [
			{ platform: "Windows", packages: "MSI、setup .exe", updates: "安装并重启" },
			{ platform: "macOS", packages: ".dmg（Intel、Apple 芯片）", updates: "安装并重启" },
			{ platform: "Linux", packages: "AppImage", updates: "安装并重启" },
			{ platform: "Linux", packages: ".deb、.rpm", updates: "通知并提供下载链接" },
		],
	},
	faq: {
		title: "常见问题",
		items: [
			{
				question: "DaSSHboard 免费吗？",
				answer: "是的。DaSSHboard 基于 MIT 许可证免费开源，无需账号，也没有付费版本。永远如此。",
			},
			{
				question: "有 macOS 版本吗？",
				answer: "有，支持 Intel 和 Apple 芯片的 Mac。应用未经 Apple 公证，因此 macOS 会阻止首次启动：先尝试打开一次，然后在“系统设置 → 隐私与安全性”中点击“仍要打开”。请先将应用从 .dmg 拖到“应用程序”文件夹：从磁盘映像中运行时，应用内更新无法替换它。",
			},
			{
				question: "支持哪些认证方式？",
				answer: "密码、私钥文件（可设置口令）以及 SSH 代理——包括存放在硬件令牌上的密钥。",
			},
			{
				question: "可以导入我现有的主机吗？",
				answer: "可以。从 ~/.ssh/config 导入设备并可导出回去，或以 JSON 文件在电脑之间迁移设备和配置文件。导出内容绝不包含密钥。",
			},
			{
				question: "我的数据保存在哪里？",
				answer: "以普通 JSON 文件保存在应用的配置文件夹中（Windows 上为 %APPDATA%\\com.dasshboard.app，macOS 上为 ~/Library/Application Support/com.dasshboard.app，Linux 上为 ~/.config/com.dasshboard.app）。这些文件不含任何密钥，可以放心备份。",
			},
			{
				question: "更新如何进行？",
				answer: "在“关于”对话框中检查更新，或选择在启动时检查。在 Windows、macOS 和 AppImage 上，“安装并重启”会应用已签名的更新；.deb 和 .rpm 安装会收到新安装包的链接。",
			},
		],
	},
	lightbox: {
		close: "关闭",
	},
	footer: {
		builtWith: "DaSSHboard — 基于 Tauri、Rust 和 xterm.js 构建。",
		license: "MIT 许可证",
		source: "GitHub 上的源代码",
	},
};
