/**
 * The control panel's own strings.
 *
 * Deliberately not `apps/web`'s catalogs. Those are shaped around the chat UI, guarded by
 * tests that read `apps/web/src`, and pulled in by a `vue-i18n` instance the panel has no
 * use for — the panel is a separate bundle with a dozen strings and no framework. What the
 * two *do* share is the rule: no user-facing text is written where it is rendered, and the
 * detection rule matches `apps/web/src/utils/locale.ts` so both halves of the product
 * switch language together.
 */

import type { ServerFault } from "./panelApi.js";

/** Only the two locales the product ships. Anything else falls back to English. */
export const PANEL_LOCALES = ["zh-CN", "en"] as const;
export type PanelLocale = (typeof PANEL_LOCALES)[number];

/**
 * Map a BCP-47 tag onto a shipped locale.
 *
 * The same rule as `apps/web/src/utils/locale.ts` and the pre-paint script in
 * `apps/web/index.html`: any `zh-*` is Simplified Chinese, any `en*` is English. Kept as a
 * third copy on purpose — these are three separate runtimes (a pre-paint inline script, the
 * web bundle, the Electron main process) and none of them can import the others. The cost of
 * a divergence here is one panel in the wrong language, not a wrong answer.
 */
export function resolvePanelLocale(tag: string | undefined): PanelLocale {
  const normalised = (tag ?? "").toLowerCase().replace(/_/g, "-");
  if (normalised === "zh" || normalised.startsWith("zh-")) return "zh-CN";
  return "en";
}

/**
 * What the language control stores.
 *
 * `""` is "follow the operating system", and it is the default — a desktop app is the one place
 * where the system already has an opinion about the language, and the panel is usually the
 * first screen of the product, so it should agree with the rest of the machine without being
 * asked. The web app has no such value (see `composables/locale.ts`), and the difference is
 * deliberate rather than a drift: there, language is chosen once; here the OS is a real answer
 * worth being able to return to, and without it a stale explicit choice would only be
 * fixable by hand-editing `desktop.json`.
 *
 * Stored as the empty string rather than `"auto"` for the reason `DesktopSettings.dataDir`
 * uses it: in a preferences file, "nobody has said" and "somebody said system" are the same
 * answer, and one spelling of it is one fewer branch.
 */
export type PanelLocaleChoice = "" | PanelLocale;

/** Whether a value off disk or out of the renderer is a language the panel can actually show. */
export function isPanelLocaleChoice(value: unknown): value is PanelLocaleChoice {
  return value === "" || (PANEL_LOCALES as readonly string[]).includes(value as string);
}

/**
 * Which language to render in: the stored choice, or the system's when nobody has chosen.
 *
 * Takes the raw value rather than trusting the caller to have validated it, because the two
 * callers are a JSON file and a `<select>` and neither is a type system.
 */
export function choosePanelLocale(
  choice: unknown,
  systemTag: string | undefined
): PanelLocale {
  return isPanelLocaleChoice(choice) && choice !== ""
    ? choice
    : resolvePanelLocale(systemTag);
}

/**
 * Every string the panel can render.
 *
 * Flat, domain-first keys, matching the web catalogs' convention: a key names what it is
 * about (`status.running`), never which file renders it, because files get split and renamed.
 */
export interface PanelMessages {
  "window.title": string;
  /** The product's displayed name — the panel's wordmark, and the app window's initial title. */
  "app.name": string;
  /** The line under the wordmark. Says what the window is, since the name does not. */
  "app.tagline": string;
  "status.stopped": string;
  "status.starting": string;
  "status.running": string;
  "status.stopping": string;
  "status.failed": string;
  "action.open": string;
  "action.start": string;
  "action.stop": string;
  "action.openInBrowser": string;
  "action.copyUrl": string;
  "action.copied": string;
  "action.reveal": string;
  "action.quit": string;
  "action.checkUpdates": string;
  /**
   * The version row, and the notice that appears when a newer release exists.
   *
   * The version is always shown rather than only when there is news: it is the number a user is
   * asked for when they report a problem, and until this row existed the only place to read it was
   * the operating system's About box. `checking` replaces it for the two seconds a check takes, so
   * a manual check is visibly doing something.
   */
  "update.version": string;
  /** The label on the version row — "Version", with the number drawn beside it. */
  "label.version": string;
  "update.checking": string;
  "update.available": string;
  "update.download": string;
  /**
   * The line shown after a boot that upgraded the database.
   *
   * Both halves matter: that it happened (an upgrade of the user's only copy of their data should
   * not be silent) and where the copy taken first is, because that is the file they would need if
   * the upgrade turns out to have been wrong.
   */
  "migrated.note": string;
  "migrated.backup": string;
  "action.showLogs": string;
  "action.hideLogs": string;
  "action.share": string;
  "action.unshare": string;
  "action.cancel": string;
  "action.chooseDataDir": string;
  /** Takes `~/ilearnassist` instead of picking one. Sits beside `chooseDataDir`. */
  "action.useDefaultDataDir": string;
  /**
   * Resetting the superadmin's password.
   *
   * `action.resetAdmin` opens a sheet that collects the new password and a confirmation, the
   * same shape as the create-administrator form — the operator is assumed to *be* the
   * superadmin, so they choose the replacement rather than receiving a generated one. The
   * destructive half (sessions end everywhere) is stated in `reset.detail`.
   *
   * The failure wording is **not** here. It used to be three strings of its own, because the
   * reset was a request to a running server and its failures were about the server — nothing
   * listening, nobody to reset, the request itself failing. It is a one-shot child now, so the
   * same refusals the create form renders are the ones it renders, from `cli.fault.<code>`.
   */
  "action.resetAdmin": string;
  "reset.title": string;
  "reset.detail": string;
  "reset.newPassword": string;
  "reset.submit": string;
  "reset.working": string;
  "reset.done": string;
  /**
   * The administrator CLI, in every way it can refuse.
   *
   * One catalog for both commands that spawn it — creating the first administrator and resetting
   * a forgotten password — because they are conversations with the same child and a code means
   * one thing: `PASSWORD_TOO_SHORT` is the same refusal whichever form asked. `cli.fault.<code>`
   * is one entry per code the CLI can produce (`PASSWORD_TOO_SHORT`, `SCHEMA_UNREADABLE`, …)
   * plus the four boundary faults of running a child at all. They are keyed the same way
   * `ServerFault` is, so a new code is a missing string rather than a raw code on screen.
   */
  "action.createAdmin": string;
  "create.title": string;
  "create.detail": string;
  "create.username": string;
  "create.password": string;
  "create.confirm": string;
  "create.submit": string;
  "create.working": string;
  "create.done": string;
  "create.dismiss": string;
  "create.mismatch": string;
  "create.needFolder": string;
  "cli.fault.no_data_dir": string;
  "cli.fault.spawn_failed": string;
  "cli.fault.timed_out": string;
  "cli.fault.bad_response": string;
  "cli.fault.USERNAME_REQUIRED": string;
  "cli.fault.USERNAME_TOO_LONG": string;
  "cli.fault.PASSWORD_REQUIRED": string;
  "cli.fault.PASSWORD_TOO_SHORT": string;
  "cli.fault.PASSWORD_TOO_LONG": string;
  "cli.fault.ADMIN_EXISTS": string;
  "cli.fault.ADMIN_NOT_FOUND": string;
  "cli.fault.DATA_DIR_INVALID": string;
  "cli.fault.SCHEMA_UNREADABLE": string;
  "cli.fault.NOT_A_DATABASE": string;
  "cli.fault.UNREADABLE": string;
  /**
   * The two codes only `migrate-up` can return, and the panel does not call it yet.
   *
   * Here anyway, because this interface enumerates every code the CLI can produce — an exception
   * would be the first, and the next person to add a command would have to work out whether the
   * gap was a decision. The fallback in `panel.ts` means a missing key renders the child's own
   * sentence rather than a raw code, so nothing breaks either way; this is about the list staying
   * a list.
   */
  "cli.fault.MIGRATION_FAILED": string;
  "cli.fault.MIGRATION_BACKUP_FAILED": string;
  "cli.fault.USAGE": string;
  "cli.fault.INTERNAL": string;
  "hint.needAdmin": string;
  /**
   * The folder picker's own strings, plus the confirm that follows it.
   *
   * The confirm exists because an empty folder and a *wrong* folder look identical from
   * here, and choosing the wrong one starts a second, empty database that is
   * indistinguishable from having lost everything. `confirmDetail` carries the path so the
   * question names the folder it is asking about.
   */
  "dataDir.chooseTitle": string;
  "dataDir.chooseButton": string;
  "dataDir.confirmTitle": string;
  "dataDir.confirmDetail": string;
  "dataDir.confirmProceed": string;
  /**
   * The folder this app offers, named in the sentence that offers it.
   *
   * `createFailedDetail` is the one failure here that has no server to report it. Making the
   * folder is the whole job of the button, so a refusal that said nothing would be a button
   * that appears to do nothing — which is the failure the panel's own docblocks argue against.
   */
  "dataDir.createFailedTitle": string;
  "dataDir.createFailedDetail": string;
  /**
   * The prompt a Start with no data root raises.
   *
   * Its two buttons are `action.useDefaultDataDir` and `action.chooseDataDir` rather than keys of
   * their own: they are the same two answers the panel's own row offers, and a second spelling of
   * each is a second thing to keep in step. Only the question is new.
   */
  "dataDir.promptTitle": string;
  "dataDir.promptDetail": string;
  /** Names the folder that will be created if the offered one is taken. */
  "hint.chooseDataDir": string;
  /**
   * The language control.
   *
   * `language.system` is translated; the two autonyms are not, and must not be — a picker that
   * renders the option for Chinese in a language the reader may not have is unusable to exactly
   * the people it is for. `apps/desktop/test/messages.test.ts` allows the CJK in the English
   * catalog for `language.zh-CN` alone, the same exemption `apps/web` makes for `locale.zhCN`.
   */
  "label.language": string;
  "language.system": string;
  "language.zh-CN": string;
  "language.en": string;
  "label.dataDir": string;
  "label.lanAccess": string;
  "label.logs": string;
  "label.logsEmpty": string;
  "hint.notRunning": string;
  "hint.closeToTray": string;
  "qr.title": string;
  "qr.steps": string;
  "qr.address": string;
  "qr.close": string;
  "qr.preparing": string;
  "qr.notRunning": string;
  "qr.noNetwork": string;
  "tray.tooltip": string;
  "tray.openPanel": string;
  "tray.stopAndQuit": string;
  "fault.spawn_failed": string;
  "fault.exited": string;
  "fault.exitedWithSignal": string;
  "fault.exitedUnknown": string;
  "fault.timeout": string;
  "menu.about": string;
  "menu.app": string;
  "menu.file": string;
  "menu.view": string;
  "menu.reload": string;
  "menu.devtools": string;
  "menu.close": string;
}

const zhCN: PanelMessages = {
  "window.title": "交互式学习助理 控制面板",
  "app.name": "交互式学习助理",
  "app.tagline": "本地服务控制面板",
  "status.stopped": "已停止",
  "status.starting": "启动中…",
  "status.running": "运行中",
  "status.stopping": "正在停止…",
  "status.failed": "启动失败",
  "action.open": "打开界面",
  "action.start": "启动服务",
  "action.stop": "停止服务",
  "action.openInBrowser": "在浏览器中打开",
  "action.copyUrl": "复制地址",
  "action.copied": "已复制",
  "action.reveal": "在访达中显示",
  "action.resetAdmin": "重置超级管理员密码",
  "reset.title": "重置超级管理员密码",
  "reset.detail":
    "为超级管理员设置一个新密码。重置后，该账号会在所有设备上退出登录。正在操作这台电脑的就是超级管理员本人，所以新密码由你直接设置，而不是由系统随机生成。",
  "reset.newPassword": "新密码",
  "reset.submit": "重置密码",
  "reset.working": "正在重置…",
  "reset.done": "超级管理员「{name}」的密码已重置，并已在所有设备上退出登录。",
  "action.createAdmin": "创建超级管理员",
  "create.title": "创建超级管理员",
  "create.detail":
    "这是这个数据目录里的第一位管理员，负责创建和管理其他账号。请输入你自己的登录信息：密码只显示这一次，创建后请用它登录。",
  "create.username": "用户名",
  "create.password": "密码",
  "create.confirm": "确认密码",
  "create.submit": "创建",
  "create.working": "正在创建…",
  "create.done": "已创建超级管理员「{name}」。现在可以启动服务并登录了。",
  "create.dismiss": "知道了",
  "create.mismatch": "两次输入的密码不一致。",
  "create.needFolder": "先选择数据文件夹，再创建管理员。",
  "cli.fault.no_data_dir": "还没有选择数据文件夹。",
  "cli.fault.spawn_failed": "无法启动管理员创建程序。这个版本可能不完整，请重新安装。",
  "cli.fault.timed_out": "创建超时，程序没有在规定时间内结束。",
  "cli.fault.bad_response": "创建程序没有正常返回。",
  "cli.fault.USERNAME_REQUIRED": "请输入用户名。",
  "cli.fault.USERNAME_TOO_LONG": "用户名太长（最多 {max} 个字符）。",
  "cli.fault.PASSWORD_REQUIRED": "请输入密码。",
  "cli.fault.PASSWORD_TOO_SHORT": "密码至少需要 {min} 个字符。",
  "cli.fault.PASSWORD_TOO_LONG": "密码不能超过 {max} 个字符。",
  "cli.fault.ADMIN_EXISTS": "这个数据目录已经有超级管理员了。",
  "cli.fault.ADMIN_NOT_FOUND": "这个数据目录里还没有超级管理员，请先创建。",
  "cli.fault.DATA_DIR_INVALID": "选择的路径不是一个文件夹。",
  "cli.fault.SCHEMA_UNREADABLE": "这个数据库是旧版本（v{found}），当前版本无法读取（需要 v{needed}）。",
  "cli.fault.NOT_A_DATABASE": "那个文件不是交互式学习助理的数据库。",
  "cli.fault.UNREADABLE": "数据库无法读取。",
  "cli.fault.MIGRATION_FAILED": "数据库升级失败，已保持原样。服务器日志里写明了是哪一步失败。",
  "cli.fault.MIGRATION_BACKUP_FAILED":
    "升级前没能备份数据库，所以没有进行升级。请先清理磁盘空间后重试。",
  "cli.fault.USAGE": "创建程序的参数不正确。",
  "cli.fault.INTERNAL": "创建时发生了内部错误。",
  "hint.needAdmin": "这个数据文件夹还没有超级管理员，先创建管理员，服务才能启动。",
  "action.quit": "停止服务器并退出",
  "action.checkUpdates": "检查更新",
  "label.version": "版本",
  "update.version": "v{version}",
  "update.checking": "正在检查更新…",
  "update.available": "有新版本 v{version}",
  "update.download": "下载新版本",
  "migrated.note": "数据库已从 v{from} 升级到 v{to}。",
  "migrated.backup": "升级前的副本：{path}",
  "action.showLogs": "查看日志",
  "action.hideLogs": "收起日志",
  "action.share": "在手机/平板打开",
  // Not "关闭": sitting next to the button that opens the QR sheet, that reads as "close
  // this dialog" rather than "stop being reachable from the network".
  "action.unshare": "停止共享",
  "action.cancel": "取消",
  "action.chooseDataDir": "选择文件夹…",
  "action.useDefaultDataDir": "使用默认目录",
  "dataDir.chooseTitle": "选择数据存放位置",
  "dataDir.chooseButton": "使用这个文件夹",
  "dataDir.confirmTitle": "这个文件夹里没有交互式学习助理的数据",
  "dataDir.confirmDetail": "会在 {dir} 里新建一个空数据库。你现有的数据不会出现在这里。",
  "dataDir.confirmProceed": "仍然使用",
  "dataDir.createFailedTitle": "无法创建默认目录",
  "dataDir.promptTitle": "还没有设置数据存放位置",
  "dataDir.promptDetail": "不设置位置，服务就无法启动。可以直接使用默认位置 {dir}（会为你创建），也可以自己选一个。",
  "dataDir.createFailedDetail": "在 {dir} 新建文件夹失败。可以改用手动选择一个文件夹，或者检查一下这个位置的权限。",
  "hint.chooseDataDir": "还没选择数据存放位置，所以服务无法启动。可以直接使用默认目录 {dir}（会为你创建），也可以自己选一个。数据库、工作空间和上传的文件都会放在那里。",
  "label.language": "语言",
  "language.system": "跟随系统",
  "language.zh-CN": "简体中文",
  "language.en": "English",
  "label.dataDir": "数据目录",
  "label.lanAccess": "手机 / 平板访问",
  "label.logs": "运行日志",
  "label.logsEmpty": "暂无输出",
  "hint.notRunning": "服务未运行，先启动服务再打开界面。",
  "hint.closeToTray": "关闭这个窗口不会停止服务，它会继续在菜单栏运行。",
  "qr.title": "在手机或平板上打开",
  "qr.steps": "让手机连接与本机相同的 Wi-Fi，然后用相机扫描下面的二维码。",
  "qr.address": "也可以手动输入这个地址",
  "qr.close": "关闭",
  "qr.preparing": "正在开启局域网访问…",
  "qr.notRunning": "服务还没有运行，暂时无法访问。请先启动服务。",
  "qr.noNetwork": "没有找到可用的局域网地址。请先让这台电脑连上 Wi-Fi 或网线。",
  "tray.tooltip": "交互式学习助理",
  "tray.openPanel": "打开控制面板",
  "tray.stopAndQuit": "停止服务器并退出",
  "fault.spawn_failed": "无法启动服务进程：{message}",
  "fault.exited": "服务意外退出（退出码 {exitCode}）。",
  "fault.exitedWithSignal": "服务被信号 {signal} 终止。",
  "fault.exitedUnknown": "服务意外退出，原因未知。",
  "fault.timeout": "{seconds} 秒内没有收到服务就绪的信号，请查看日志。",
  "menu.about": "关于交互式学习助理",
  "menu.app": "交互式学习助理",
  "menu.file": "文件",
  "menu.view": "显示",
  "menu.reload": "重新载入",
  "menu.devtools": "开发者工具",
  "menu.close": "关闭窗口",
};

const en: PanelMessages = {
  "window.title": "Interactive Learning Assistant control panel",
  "app.name": "Interactive Learning Assistant",
  "app.tagline": "Local server control panel",
  "status.stopped": "Stopped",
  "status.starting": "Starting…",
  "status.running": "Running",
  "status.stopping": "Stopping…",
  "status.failed": "Failed to start",
  "action.open": "Open app",
  "action.start": "Start server",
  "action.stop": "Stop server",
  "action.openInBrowser": "Open in browser",
  "action.copyUrl": "Copy address",
  "action.copied": "Copied",
  "action.reveal": "Show in Finder",
  "action.resetAdmin": "Reset superadmin password",
  "reset.title": "Reset the superadmin password",
  "reset.detail":
    "Choose a new password for the superadmin. The account is signed out everywhere when this runs. The person at this machine is taken to be the superadmin, so the password is chosen here rather than generated.",
  "reset.newPassword": "New password",
  "reset.submit": "Reset password",
  "reset.working": "Resetting…",
  "reset.done": "Superadmin “{name}” has a new password and is signed out everywhere.",
  "action.createAdmin": "Create superadmin",
  "create.title": "Create the superadmin",
  "create.detail":
    "This is the first administrator of this data folder — it creates and manages every other account. Enter your own sign-in: the password is shown once, and you sign in with it afterwards.",
  "create.username": "Username",
  "create.password": "Password",
  "create.confirm": "Confirm password",
  "create.submit": "Create",
  "create.working": "Creating…",
  "create.done": "Superadmin “{name}” created. Start the server and sign in.",
  "create.dismiss": "Done",
  "create.mismatch": "The two passwords do not match.",
  "create.needFolder": "Choose a data folder before creating an administrator.",
  "cli.fault.no_data_dir": "No data folder has been chosen.",
  "cli.fault.spawn_failed": "Could not start the administrator tool. This build may be incomplete — reinstall it.",
  "cli.fault.timed_out": "The tool did not finish in time.",
  "cli.fault.bad_response": "The tool did not return a valid response.",
  "cli.fault.USERNAME_REQUIRED": "Enter a username.",
  "cli.fault.USERNAME_TOO_LONG": "That username is too long (at most {max} characters).",
  "cli.fault.PASSWORD_REQUIRED": "Enter a password.",
  "cli.fault.PASSWORD_TOO_SHORT": "The password needs at least {min} characters.",
  "cli.fault.PASSWORD_TOO_LONG": "The password cannot be longer than {max} characters.",
  "cli.fault.ADMIN_EXISTS": "This data folder already has a superadmin.",
  "cli.fault.ADMIN_NOT_FOUND": "This data folder has no superadmin yet — create one first.",
  "cli.fault.DATA_DIR_INVALID": "That path is not a folder.",
  "cli.fault.SCHEMA_UNREADABLE":
    "That database is from an older schema (v{found}); this build needs v{needed}.",
  "cli.fault.NOT_A_DATABASE": "That file is not an Interactive Learning Assistant database.",
  "cli.fault.UNREADABLE": "The database could not be read.",
  "cli.fault.MIGRATION_FAILED":
    "The database could not be upgraded, and was left as it was. The server's log names the step that failed.",
  "cli.fault.MIGRATION_BACKUP_FAILED":
    "A copy of the database could not be saved before upgrading, so nothing was upgraded. Free some disk space and try again.",
  "cli.fault.USAGE": "The administrator tool was called incorrectly.",
  "cli.fault.INTERNAL": "An internal error occurred while creating the account.",
  "hint.needAdmin": "This data folder has no superadmin yet — create one before the server can start.",
  "action.quit": "Stop server and quit",
  "action.checkUpdates": "Check for updates",
  "label.version": "Version",
  "update.version": "v{version}",
  "update.checking": "Checking for updates…",
  "update.available": "Version v{version} is available",
  "update.download": "Download it",
  "migrated.note": "The database was upgraded from v{from} to v{to}.",
  "migrated.backup": "A copy from before the upgrade: {path}",
  "action.showLogs": "Show logs",
  "action.hideLogs": "Hide logs",
  "action.share": "Open on your phone",
  "action.unshare": "Turn off",
  "action.cancel": "Cancel",
  "action.chooseDataDir": "Choose folder…",
  "action.useDefaultDataDir": "Use the default folder",
  "dataDir.chooseTitle": "Choose where to keep your data",
  "dataDir.chooseButton": "Use this folder",
  "dataDir.confirmTitle": "This folder has no Interactive Learning Assistant data",
  "dataDir.confirmDetail": "A new, empty database will be created in {dir}. Your existing data will not appear here.",
  "dataDir.confirmProceed": "Use it anyway",
  "dataDir.createFailedTitle": "Could not create the default folder",
  "dataDir.promptTitle": "No data folder has been set",
  "dataDir.promptDetail": "The server cannot start without one. Take the default, {dir} — it will be created for you — or choose a folder of your own.",
  "dataDir.createFailedDetail": "Creating {dir} failed. Choose a folder by hand instead, or check whether you can write to that location.",
  "hint.chooseDataDir": "No data folder has been chosen yet, so the server cannot start. Take the default, {dir} — it will be created for you — or pick one yourself. The database, your workspaces and your uploaded files all live there.",
  "label.language": "Language",
  "language.system": "System",
  "language.zh-CN": "简体中文",
  "language.en": "English",
  "label.dataDir": "Data folder",
  "label.lanAccess": "Phone or tablet",
  "label.logs": "Server output",
  "label.logsEmpty": "Nothing yet",
  "hint.notRunning": "The server is not running. Start it before opening the app.",
  "hint.closeToTray": "Closing this window keeps the server running in the menu bar.",
  "qr.title": "Open on your phone or tablet",
  "qr.steps": "Connect your phone to the same Wi-Fi as this Mac, then scan the code below.",
  "qr.address": "Or type this address by hand",
  "qr.close": "Close",
  "qr.preparing": "Turning on network access…",
  "qr.notRunning": "The server is not running yet, so there is nothing to open. Start it first.",
  "qr.noNetwork": "No network address available. Connect this Mac to Wi-Fi or Ethernet first.",
  "tray.tooltip": "Interactive Learning Assistant",
  "tray.openPanel": "Open control panel",
  "tray.stopAndQuit": "Stop server and quit",
  "fault.spawn_failed": "Could not start the server process: {message}",
  "fault.exited": "The server exited unexpectedly (exit code {exitCode}).",
  "fault.exitedWithSignal": "The server was terminated by signal {signal}.",
  "fault.exitedUnknown": "The server exited unexpectedly for an unknown reason.",
  "fault.timeout": "The server did not report itself ready within {seconds}s. Check the output.",
  "menu.about": "About Interactive Learning Assistant",
  "menu.app": "Interactive Learning Assistant",
  "menu.file": "File",
  "menu.view": "View",
  "menu.reload": "Reload",
  "menu.devtools": "Developer Tools",
  "menu.close": "Close Window",
};

export const PANEL_MESSAGES: Record<PanelLocale, PanelMessages> = {
  "zh-CN": zhCN,
  en,
};

/**
 * Look a key up and substitute `{name}` placeholders.
 *
 * Interpolation is by named token rather than by position so a translation can reorder the
 * sentence — which Chinese and English routinely need — without the call site changing.
 * An unknown key renders as the key itself: a visible `menu.missing` in the UI is a bug
 * report, where an empty string is a mystery.
 */
export function translate(
  messages: PanelMessages,
  key: keyof PanelMessages,
  values: Record<string, string | number> = {}
): string {
  const template = messages[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in values ? String(values[name]) : whole
  );
}

/** Render a `ServerFault` in the user's language. Mirrors `utils/apiError.ts` on the web side. */
export function describeFault(messages: PanelMessages, fault: ServerFault): string {
  switch (fault.code) {
    case "spawn_failed":
      return translate(messages, "fault.spawn_failed", { message: fault.message });
    case "timeout":
      return translate(messages, "fault.timeout", { seconds: fault.seconds });
    case "exited":
      if (fault.signal) return translate(messages, "fault.exitedWithSignal", { signal: fault.signal });
      if (fault.exitCode === null) return translate(messages, "fault.exitedUnknown");
      return translate(messages, "fault.exited", { exitCode: fault.exitCode });
  }
}
