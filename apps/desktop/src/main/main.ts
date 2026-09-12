import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, nativeTheme, shell } from "electron";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { PANEL_CHANNELS, type PanelState } from "../shared/panelApi.js";
import {
  PANEL_MESSAGES,
  resolvePanelLocale,
  translate,
  type PanelLocale,
} from "../shared/messages.js";
import {
  ANY_INTERFACE_HOST,
  LOOPBACK_HOST,
  buildLaunchSpec,
  serverEntryFor,
} from "./launch.js";
import { findLanAddress, lanUrlFor } from "./lan.js";
import { resolveAppPaths, seedFirstRun, type AppPaths } from "./paths.js";
import { readSettings, writeSettings, type DesktopSettings } from "./settings.js";
import { ServerProcess } from "./serverProcess.js";

/**
 * The control panel's main process.
 *
 * Four jobs, in order of how much they matter: keep the backend alive and tell the truth
 * about it, let a phone on the same network open the app, outlive its own window, and get
 * out of the way. Everything with logic in it lives in a sibling module that does not import
 * `electron`, so it can be tested without a display; what is left here is window, tray and
 * menu plumbing.
 */

// Must happen before the first `getPath("userData")`. Electron derives that path from the
// app name, and the packaged bundle's `productName` is not visible when running unpacked —
// without this, `pnpm desktop:dev` would write to `Application Support/@ilearnassist/desktop`
// while the .dmg writes next to `ilearnassist`, and the two would never share state.
app.setName("ilearnassist");

const appRoot = app.getAppPath();
/**
 * Where the read-only half of the app lives — the built frontend, the seed config and the
 * tray icon.
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
let settingsFile: string;
let settings: DesktopSettings;
let server: ServerProcess;
let panelWindow: BrowserWindow | null = null;
let appWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
/** Set once a real quit is under way, so closing a window stops meaning "hide". */
let quitting = false;
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

// ---- state -----------------------------------------------------------------

/**
 * Everything the panel renders.
 *
 * `sharedOnLan` is read from the setting rather than from the process, because it is what
 * *decides* the bind address rather than something observed from it — and because the two
 * can only disagree during the moment a restart is in flight, which the panel renders as
 * `starting`.
 */
function currentState(): PanelState {
  const status = server.status();
  const lanAddress = findLanAddress(networkInterfaces());
  return {
    server: status,
    sharedOnLan: settings.sharedOnLan,
    // Offered only while sharing is on. The address answers either way once the server is
    // bound to every interface, but showing it while the switch is off would invite someone
    // to open a URL that cannot work — the switch is the promise, so it gates the offer.
    lanUrl: settings.sharedOnLan ? lanUrlFor(status.url, lanAddress) : null,
    lanAddress,
  };
}

function broadcast(): void {
  refreshTrayMenu();
  if (!panelWindow || panelWindow.isDestroyed()) return;
  panelWindow.webContents.send(PANEL_CHANNELS.stateChanged, currentState());
}

/**
 * Turn LAN sharing on or off, restarting the server if it was up.
 *
 * A restart rather than a reload is not a shortcut: a bind address is chosen once, at
 * `listen`, and there is no way to widen a socket that is already accepting connections.
 * The address the panel holds is stale the moment it happens, which is why the restart
 * resolves before this returns — the renderer's next render is then showing a URL that is
 * actually answering.
 */
async function shareOnLan(on: boolean): Promise<PanelState> {
  if (settings.sharedOnLan !== on) {
    settings = { ...settings, sharedOnLan: on };
    try {
      writeSettings(settingsFile, settings);
    } catch (err) {
      // Worth continuing: the switch still applies to this run, and refusing to rebind
      // because a preferences file could not be written would make the button look broken.
      console.error("Could not save the desktop settings:", err);
    }
  }

  const wasUp = ["running", "starting"].includes(server.status().state);
  await server.stop();
  if (wasUp) await server.start();

  broadcast();
  return currentState();
}

// ---- windows ---------------------------------------------------------------

function createPanelWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 480,
    // Every row, plus room for the log view when it is opened — the disclosure takes the
    // leftover height, so the slack when it is collapsed is what the log pane gets when it
    // is not.
    height: 660,
    minWidth: 420,
    // Below this the panel scrolls, which works but is not how it is meant to be read.
    minHeight: 600,
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

  /**
   * Closing the panel is not quitting.
   *
   * This is the tray's whole reason for existing: the server keeps running so a phone that
   * is mid-conversation does not lose it, and the app stays one click away in the menu bar.
   * A real quit — the tray's own item, `Cmd+Q`, the app menu — sets `quitting` first, and
   * only then does closing the window actually close it.
   */
  window.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    window.hide();
  });

  window.on("closed", () => {
    panelWindow = null;
  });

  return window;
}

/** Raise the panel, recreating it if it was destroyed rather than hidden. */
function showPanel(): void {
  if (!panelWindow || panelWindow.isDestroyed()) {
    panelWindow = createPanelWindow();
    return;
  }
  if (panelWindow.isMinimized()) panelWindow.restore();
  panelWindow.show();
  panelWindow.focus();
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
    title: "ilearnassist",
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

// ---- tray ------------------------------------------------------------------

/**
 * The menu-bar icon, which is what keeps the app reachable once its window is gone.
 *
 * A template image — black with alpha, filename ending in `Template` — so macOS inverts it
 * for a dark menu bar and it needs no light and dark variants of its own. `createFromPath`
 * picks up the `@2x` sibling automatically, so the icon is drawn once at two sizes rather
 * than scaled and blurred on a Retina display.
 */
function createTray(): void {
  const icon = nativeImage.createFromPath(join(resourcesDir, "tray", "trayTemplate.png"));
  if (icon.isEmpty()) {
    // A missing icon would otherwise appear as an invisible tray item that still swallows
    // clicks — worse than no tray, because the app would look like it had quit. The panel
    // still works; only the menu-bar half does not.
    console.error("Tray icon missing from the app bundle; running without a menu-bar item");
    return;
  }

  tray = new Tray(icon);
  tray.setToolTip(t("tray.tooltip"));
  refreshTrayMenu();
}

/**
 * Rebuild the tray menu from the current state.
 *
 * Rebuilt rather than mutated because "open the app" is only meaningful while the server is
 * up, and a menu-bar item that does nothing when clicked is indistinguishable from a broken
 * app. The state changes for reasons the tray never hears about — a crash, a slow start — so
 * this is called from the same place the panel is told.
 */
function refreshTrayMenu(): void {
  if (!tray) return;
  const running = server.status().state === "running";

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: t("tray.openPanel"), click: () => showPanel() },
      {
        label: t("action.open"),
        enabled: running,
        click: () => void openAppWindow(),
      },
      { type: "separator" },
      {
        // The only path that stops the server. Everything else — the red button, the app
        // window, hiding the dock icon — leaves it running on purpose.
        label: t("tray.stopAndQuit"),
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
}

// ---- wiring ----------------------------------------------------------------

function registerIpc(): void {
  ipcMain.handle(PANEL_CHANNELS.getState, () => currentState());
  ipcMain.handle(PANEL_CHANNELS.start, async () => {
    await server.start();
    return currentState();
  });
  ipcMain.handle(PANEL_CHANNELS.stop, async () => {
    await server.stop();
    return currentState();
  });
  ipcMain.handle(PANEL_CHANNELS.shareOnLan, (_event, on: unknown) => shareOnLan(on === true));
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
    quitting = true;
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
                // Quitting from here stops the server too: `before-quit` is what does it,
                // and it does not care what asked.
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
 * a second time, and the server would be stopped twice.
 */
function installShutdown(): void {
  app.on("before-quit", (event) => {
    // Before anything else, so the panel's close handler stops hiding the window and lets
    // the quit actually happen.
    quitting = true;
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
  app.on("second-instance", () => showPanel());

  app.whenReady().then(async () => {
    paths = resolveAppPaths({ userDataDir: app.getPath("userData"), resourcesDir });
    settingsFile = join(paths.root, "desktop.json");
    seedFirstRun(paths);
    settings = readSettings(settingsFile);

    server = new ServerProcess(
      // Read at every start, so flipping the switch takes effect on the restart that
      // follows it without replacing this object — which would drop the subscription the
      // panel's state arrives through.
      () =>
        buildLaunchSpec({
          electronExecPath: process.execPath,
          serverEntry: serverEntryFor(appRoot),
          paths,
          host: settings.sharedOnLan ? ANY_INTERFACE_HOST : LOOPBACK_HOST,
        }),
      { dataDir: paths.root }
    );
    server.subscribe(broadcast);

    registerIpc();
    buildMenu();
    createTray();

    panelWindow = createPanelWindow();

    // Auto-start, because the panel's whole purpose is to be the thing that has the server
    // running. A user who wants it stopped has a button; a user who has to remember to
    // press "start" before anything works has a puzzle.
    await server.start();

    app.on("activate", () => showPanel());
  });

  /**
   * Deliberately empty, and deliberately present.
   *
   * Electron quits by default when every window has closed *unless* something subscribes —
   * and quitting here would defeat the tray, which exists so that closing the last window
   * does not stop the server. The panel hides rather than closes, so in practice this only
   * fires if a window is destroyed some other way.
   */
  app.on("window-all-closed", () => undefined);
}
