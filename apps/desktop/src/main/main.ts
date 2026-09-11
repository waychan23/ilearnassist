import { app, BrowserWindow, Menu, ipcMain, nativeTheme, shell } from "electron";
import { join } from "node:path";
import { PANEL_CHANNELS, type ServerStatus } from "../shared/panelApi.js";
import {
  PANEL_MESSAGES,
  resolvePanelLocale,
  translate,
  type PanelLocale,
} from "../shared/messages.js";
import { buildLaunchSpec, serverEntryFor } from "./launch.js";
import { resolveAppPaths, seedFirstRun, type AppPaths } from "./paths.js";
import { ServerProcess } from "./serverProcess.js";

/**
 * The control panel's main process.
 *
 * Three jobs, in order of how much they matter: keep the backend alive and tell the truth
 * about it, give the user a way to open the app, and get out of the way. Everything with
 * logic in it lives in a sibling module that does not import `electron`, so it can be
 * tested without a display; what is left here is window and menu plumbing.
 */

// Must happen before the first `getPath("userData")`. Electron derives that path from the
// app name, and the packaged bundle's `productName` is not visible when running unpacked —
// without this, `pnpm desktop:dev` would write to `Application Support/@guided-learning/desktop`
// while the .dmg writes next to `guided-learning`, and the two would never share state.
app.setName("guided-learning");

const appRoot = app.getAppPath();
/**
 * Where the read-only half of the app lives — the built frontend and the seed config.
 *
 * Packed, these are `Contents/Resources/*`, courtesy of electron-builder's
 * `extraResources`. Unpacked, `process.resourcesPath` is Electron's own Resources folder
 * and has nothing of ours in it, so the build script stages the same layout under
 * `apps/desktop/dist/resources` and both cases resolve identically from here.
 */
const resourcesDir = app.isPackaged ? process.resourcesPath : join(appRoot, "dist", "resources");
const rendererEntry = join(appRoot, "dist", "renderer", "index.html");
const preloadEntry = join(appRoot, "dist", "main", "preload.cjs");

const locale: PanelLocale = resolvePanelLocale(app.getLocale());
const messages = PANEL_MESSAGES[locale];
const t = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>): string =>
  translate(messages, key, values);

let paths: AppPaths;
let server: ServerProcess;
let panelWindow: BrowserWindow | null = null;
let appWindow: BrowserWindow | null = null;
/** Guards the async shutdown in `before-quit` against re-entering itself. */
let shuttingDown = false;

/**
 * Window chrome colour, so the frame does not flash white before the page paints.
 *
 * Literal hex rather than a shared token: this is handed to the OS before any CSS exists,
 * and `apps/desktop` is not wired to `apps/web`'s stylesheet. The two values are the `--bg`
 * of each theme there; they are allowed to drift, and the cost of drift is one frame.
 */
const chromeColour = (): string => (nativeTheme.shouldUseDarkColors ? "#16181c" : "#ffffff");

function createPanelWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 480,
    height: 640,
    minWidth: 420,
    minHeight: 560,
    show: false,
    title: t("window.title"),
    backgroundColor: chromeColour(),
    // Inset traffic lights on macOS, so the panel's own header can sit at the top of the
    // window rather than below a strip of chrome. The CSS pads for them.
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: preloadEntry,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.loadFile(rendererEntry).catch((err: unknown) => {
    console.error("Failed to load the control panel:", err);
  });
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    panelWindow = null;
  });

  return window;
}

/**
 * Open the app itself, in a window rather than the user's browser.
 *
 * A browser tab would work, but it makes the product feel like a local website: a URL bar,
 * a back button that leaves, and a second window the panel no longer tracks. A
 * `BrowserWindow` on the same URL is the same app with the chrome of a desktop one.
 * `openInBrowser` is still there for anyone who wants a bookmark.
 */
async function openAppWindow(): Promise<void> {
  const url = server.status().url;
  if (!url) return;

  if (appWindow && !appWindow.isDestroyed()) {
    appWindow.show();
    appWindow.focus();
    return;
  }

  const window = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 720,
    minHeight: 520,
    title: "guided-learning",
    backgroundColor: chromeColour(),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  appWindow = window;
  window.on("closed", () => {
    appWindow = null;
  });

  // The chat UI links to documentation and to provider consoles. Those belong in the
  // user's browser, not in a window with no URL bar and no way back.
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    void shell.openExternal(target);
    return { action: "deny" };
  });

  await window.loadURL(url);
}

function broadcast(status: ServerStatus): void {
  if (!panelWindow || panelWindow.isDestroyed()) return;
  panelWindow.webContents.send(PANEL_CHANNELS.stateChanged, status);
}

function registerIpc(): void {
  ipcMain.handle(PANEL_CHANNELS.getState, () => server.status());
  ipcMain.handle(PANEL_CHANNELS.start, () => server.start());
  ipcMain.handle(PANEL_CHANNELS.stop, () => server.stop());
  ipcMain.handle(PANEL_CHANNELS.openApp, () => openAppWindow());
  ipcMain.handle(PANEL_CHANNELS.openInBrowser, async () => {
    const url = server.status().url;
    if (url) await shell.openExternal(url);
  });
  ipcMain.handle(PANEL_CHANNELS.revealDataDir, async () => {
    // `openPath` resolves to an error string rather than rejecting, so the failure is
    // logged rather than thrown into an unhandled rejection.
    const failure = await shell.openPath(paths.root);
    if (failure) console.error("Could not open the data folder:", failure);
  });
  ipcMain.handle(PANEL_CHANNELS.quit, () => {
    app.quit();
  });
}

function buildMenu(): void {
  const isMac = process.platform === "darwin";
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac
        ? [
            {
              label: t("menu.app"),
              submenu: [
                { role: "about" as const, label: t("menu.about") },
                { type: "separator" as const },
                { role: "hide" as const },
                { role: "hideOthers" as const },
                { type: "separator" as const },
                { role: "quit" as const, label: t("action.quit") },
              ],
            },
          ]
        : []),
      {
        label: t("menu.file"),
        submenu: [
          {
            label: t("action.open"),
            accelerator: "CmdOrCtrl+O",
            click: () => void openAppWindow(),
          },
          { type: "separator" as const },
          ...(isMac ? [] : [{ role: "quit" as const, label: t("action.quit") }]),
        ],
      },
      {
        label: t("menu.view"),
        submenu: [
          { role: "reload" as const, label: t("menu.reload") },
          { role: "toggleDevTools" as const, label: t("menu.devtools") },
          { type: "separator" as const },
          { role: "close" as const, label: t("menu.close") },
        ],
      },
      { role: "windowMenu" },
    ])
  );
}

/**
 * Quit once, cleanly.
 *
 * `before-quit` is the only hook early enough to await anything, so the shutdown lives
 * there: stop the server (which drains requests and closes sqlite), then let the quit
 * proceed. The re-entrancy guard matters because `app.quit()` at the end fires this event
 * a second time.
 */
function installShutdown(): void {
  app.on("before-quit", (event) => {
    if (shuttingDown) return;
    event.preventDefault();
    shuttingDown = true;
    void server.stop().finally(() => app.quit());
  });

  // Nothing can be awaited here. If the process is going down some other way — a signal, a
  // crash — the child must not be left holding the port and looking like a running app.
  process.on("exit", () => server.killSync());
}

/** A second launch should raise the panel that is already open, not start a rival server. */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!panelWindow || panelWindow.isDestroyed()) return;
    if (panelWindow.isMinimized()) panelWindow.restore();
    panelWindow.show();
    panelWindow.focus();
  });

  app.whenReady().then(async () => {
    paths = resolveAppPaths({ userDataDir: app.getPath("userData"), resourcesDir });
    seedFirstRun(paths);

    server = new ServerProcess(
      buildLaunchSpec({
        electronExecPath: process.execPath,
        serverEntry: serverEntryFor(appRoot),
        paths,
      }),
      { dataDir: paths.root }
    );
    server.subscribe(broadcast);

    registerIpc();
    buildMenu();

    panelWindow = createPanelWindow();

    // Auto-start, because the panel's whole purpose is to be the thing that has the server
    // running. A user who wants it stopped has a button; a user who has to remember to
    // press "start" before anything works has a puzzle.
    await server.start();

    app.on("activate", () => {
      if (!panelWindow || panelWindow.isDestroyed()) panelWindow = createPanelWindow();
      else panelWindow.focus();
    });
  });

  // The panel is the app. Closing it means quitting — leaving a headless server running
  // with no window to stop it would be indistinguishable from a bug.
  app.on("window-all-closed", () => app.quit());
}
