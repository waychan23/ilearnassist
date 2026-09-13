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
  "action.showLogs": string;
  "action.hideLogs": string;
  "action.share": string;
  "action.unshare": string;
  "action.cancel": string;
  "action.chooseDataDir": string;
  /**
   * Resetting the administrator's password, and what comes back.
   *
   * `action.resetAdmin` opens it and `reset.confirm` guards it, because it is destructive in
   * the way that matters: the account it replaces a password for is the one that can do
   * everything, and the reset ends its sessions too.
   *
   * The three fault strings are separate because they are three different situations with
   * three different next moves — start the server, set the installation up, or look at the
   * message — and one string covering all of them would be advice for one of them.
   */
  "action.resetAdmin": string;
  "reset.confirmTitle": string;
  "reset.confirmDetail": string;
  "reset.confirm": string;
  "reset.working": string;
  "reset.done": string;
  "reset.username": string;
  "reset.password": string;
  "reset.copy": string;
  "reset.copied": string;
  "reset.dismiss": string;
  "reset.fault.not_running": string;
  "reset.fault.no_admin": string;
  "reset.fault.unreachable": string;
  /**
   * Creating the first administrator.
   *
   * The card is what a fresh data folder gets instead of a Start that would fail, and
   * `create.fault.<code>` is one entry per way the child CLI can refuse — the CLI's own
   * codes (`PASSWORD_TOO_SHORT`, `SCHEMA_UNREADABLE`, …) plus the four boundary faults of
   * running it. They are keyed the same way `ServerFault` is, so a new code is a missing
   * string rather than a raw code on screen.
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
  "create.fault.no_data_dir": string;
  "create.fault.spawn_failed": string;
  "create.fault.timed_out": string;
  "create.fault.bad_response": string;
  "create.fault.USERNAME_REQUIRED": string;
  "create.fault.USERNAME_TOO_LONG": string;
  "create.fault.PASSWORD_REQUIRED": string;
  "create.fault.PASSWORD_TOO_SHORT": string;
  "create.fault.PASSWORD_TOO_LONG": string;
  "create.fault.ADMIN_EXISTS": string;
  "create.fault.DATA_DIR_INVALID": string;
  "create.fault.SCHEMA_UNREADABLE": string;
  "create.fault.NOT_A_DATABASE": string;
  "create.fault.UNREADABLE": string;
  "create.fault.USAGE": string;
  "create.fault.INTERNAL": string;
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
  "window.title": "ilearnassist 控制面板",
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
  "reset.confirmTitle": "重置超级管理员密码",
  "reset.confirmDetail":
    "系统会生成一个新的随机密码，并让超级管理员在所有设备上退出登录。忘记密码时，这是唯一的找回方式。",
  "reset.confirm": "重置",
  "reset.working": "正在重置…",
  "reset.done": "密码已重置。请把下面的新密码交给超级管理员：",
  "reset.username": "用户名",
  "reset.password": "新密码",
  "reset.copy": "复制",
  "reset.copied": "已复制",
  "reset.dismiss": "关闭",
  "reset.fault.not_running": "服务还没有启动，先启动服务再重置密码。",
  "reset.fault.no_admin": "这个数据目录里还没有超级管理员，请先在控制面板里创建。",
  "reset.fault.unreachable": "重置失败，服务没有正常响应。",
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
  "create.fault.no_data_dir": "还没有选择数据文件夹。",
  "create.fault.spawn_failed": "无法启动管理员创建程序。这个版本可能不完整，请重新安装。",
  "create.fault.timed_out": "创建超时，程序没有在规定时间内结束。",
  "create.fault.bad_response": "创建程序没有正常返回。",
  "create.fault.USERNAME_REQUIRED": "请输入用户名。",
  "create.fault.USERNAME_TOO_LONG": "用户名太长（最多 {max} 个字符）。",
  "create.fault.PASSWORD_REQUIRED": "请输入密码。",
  "create.fault.PASSWORD_TOO_SHORT": "密码至少需要 {min} 个字符。",
  "create.fault.PASSWORD_TOO_LONG": "密码不能超过 {max} 个字符。",
  "create.fault.ADMIN_EXISTS": "这个数据目录已经有超级管理员了。",
  "create.fault.DATA_DIR_INVALID": "选择的路径不是一个文件夹。",
  "create.fault.SCHEMA_UNREADABLE": "这个数据库是旧版本（v{found}），当前版本无法读取（需要 v{needed}）。",
  "create.fault.NOT_A_DATABASE": "那个文件不是一个 ilearnassist 数据库。",
  "create.fault.UNREADABLE": "数据库无法读取。",
  "create.fault.USAGE": "创建程序的参数不正确。",
  "create.fault.INTERNAL": "创建时发生了内部错误。",
  "hint.needAdmin": "这个数据文件夹还没有超级管理员，先创建管理员，服务才能启动。",
  "action.quit": "停止服务器并退出",
  "action.showLogs": "查看日志",
  "action.hideLogs": "收起日志",
  "action.share": "在手机/平板打开",
  // Not "关闭": sitting next to the button that opens the QR sheet, that reads as "close
  // this dialog" rather than "stop being reachable from the network".
  "action.unshare": "停止共享",
  "action.cancel": "取消",
  "action.chooseDataDir": "选择文件夹…",
  "dataDir.chooseTitle": "选择数据存放位置",
  "dataDir.chooseButton": "使用这个文件夹",
  "dataDir.confirmTitle": "这个文件夹里没有 ilearnassist 数据",
  "dataDir.confirmDetail": "会在 {dir} 里新建一个空数据库。你现有的数据不会出现在这里。",
  "dataDir.confirmProceed": "仍然使用",
  "hint.chooseDataDir": "先选择数据存放位置，再启动服务。数据库、工作空间和上传的文件都会放在那里，所以建议选一个在应用之外、并且会被备份的位置。",
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
  "tray.tooltip": "ilearnassist",
  "tray.openPanel": "打开控制面板",
  "tray.stopAndQuit": "停止服务器并退出",
  "fault.spawn_failed": "无法启动服务进程：{message}",
  "fault.exited": "服务意外退出（退出码 {exitCode}）。",
  "fault.exitedWithSignal": "服务被信号 {signal} 终止。",
  "fault.exitedUnknown": "服务意外退出，原因未知。",
  "fault.timeout": "{seconds} 秒内没有收到服务就绪的信号，请查看日志。",
  "menu.about": "关于 ilearnassist",
  "menu.app": "ilearnassist",
  "menu.file": "文件",
  "menu.view": "显示",
  "menu.reload": "重新载入",
  "menu.devtools": "开发者工具",
  "menu.close": "关闭窗口",
};

const en: PanelMessages = {
  "window.title": "ilearnassist control panel",
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
  "reset.confirmTitle": "Reset the superadmin password",
  "reset.confirmDetail":
    "A new random password will be generated and the superadmin will be signed out everywhere. For a forgotten password, this is the only way back in.",
  "reset.confirm": "Reset",
  "reset.working": "Resetting…",
  "reset.done": "The password has been reset. Give the superadmin the new one:",
  "reset.username": "Username",
  "reset.password": "New password",
  "reset.copy": "Copy",
  "reset.copied": "Copied",
  "reset.dismiss": "Close",
  "reset.fault.not_running": "The server is not running. Start it, then reset the password.",
  "reset.fault.no_admin": "This data folder has no superadmin yet — create one in the app first.",
  "reset.fault.unreachable": "The reset failed: the server did not answer properly.",
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
  "create.fault.no_data_dir": "No data folder has been chosen.",
  "create.fault.spawn_failed": "Could not start the administrator tool. This build may be incomplete — reinstall it.",
  "create.fault.timed_out": "The tool did not finish in time.",
  "create.fault.bad_response": "The tool did not return a valid response.",
  "create.fault.USERNAME_REQUIRED": "Enter a username.",
  "create.fault.USERNAME_TOO_LONG": "That username is too long (at most {max} characters).",
  "create.fault.PASSWORD_REQUIRED": "Enter a password.",
  "create.fault.PASSWORD_TOO_SHORT": "The password needs at least {min} characters.",
  "create.fault.PASSWORD_TOO_LONG": "The password cannot be longer than {max} characters.",
  "create.fault.ADMIN_EXISTS": "This data folder already has a superadmin.",
  "create.fault.DATA_DIR_INVALID": "That path is not a folder.",
  "create.fault.SCHEMA_UNREADABLE":
    "That database is from an older schema (v{found}); this build needs v{needed}.",
  "create.fault.NOT_A_DATABASE": "That file is not an ilearnassist database.",
  "create.fault.UNREADABLE": "The database could not be read.",
  "create.fault.USAGE": "The administrator tool was called incorrectly.",
  "create.fault.INTERNAL": "An internal error occurred while creating the account.",
  "hint.needAdmin": "This data folder has no superadmin yet — create one before the server can start.",
  "action.quit": "Stop server and quit",
  "action.showLogs": "Show logs",
  "action.hideLogs": "Hide logs",
  "action.share": "Open on your phone",
  "action.unshare": "Turn off",
  "action.cancel": "Cancel",
  "action.chooseDataDir": "Choose folder…",
  "dataDir.chooseTitle": "Choose where to keep your data",
  "dataDir.chooseButton": "Use this folder",
  "dataDir.confirmTitle": "This folder has no ilearnassist data",
  "dataDir.confirmDetail": "A new, empty database will be created in {dir}. Your existing data will not appear here.",
  "dataDir.confirmProceed": "Use it anyway",
  "hint.chooseDataDir": "Choose where to keep your data before starting the server. The database, your workspaces and your uploaded files all live there — so pick somewhere outside the app, somewhere you back up.",
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
  "tray.tooltip": "ilearnassist",
  "tray.openPanel": "Open control panel",
  "tray.stopAndQuit": "Stop server and quit",
  "fault.spawn_failed": "Could not start the server process: {message}",
  "fault.exited": "The server exited unexpectedly (exit code {exitCode}).",
  "fault.exitedWithSignal": "The server was terminated by signal {signal}.",
  "fault.exitedUnknown": "The server exited unexpectedly for an unknown reason.",
  "fault.timeout": "The server did not report itself ready within {seconds}s. Check the output.",
  "menu.about": "About ilearnassist",
  "menu.app": "ilearnassist",
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
