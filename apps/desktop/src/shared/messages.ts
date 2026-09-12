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
