import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  shell,
} from "electron";
import { randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
import { PANEL_CHANNELS, type PanelState, type ResetResult } from "../shared/panelApi.js";
import {
  choosePanelLocale,
  isPanelLocaleChoice,
  PANEL_MESSAGES,
  resolvePanelLocale,
  translate,
  type PanelLocale,
  type PanelLocaleChoice,
} from "../shared/messages.js";
import {
  ANY_INTERFACE_HOST,
  LOOPBACK_HOST,
  buildLaunchSpec,
  serverEntryFor,
} from "./launch.js";
import { createFirstAdministrator, queryAdministrator } from "./admin.js";
import { findLanAddress, lanUrlFor } from "./lan.js";
import { hasExistingData, resolveAppPaths, seedFirstRun, type AppPaths } from "./paths.js";
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

/**
 * Which language the panel is in, and the words for it.
 *
 * Resolved once at startup from the *settings*, which are not read until `whenReady` — so this
 * is a placeholder for the few milliseconds before that, and `applyLocale` is what makes it true.
 * `let` rather than `const` because the panel has a language control: everything that renders a
 * string reads it through `t` below, so a change is one assignment plus a repaint of the chrome,
 * rather than a restart.
 */
let locale: PanelLocale = resolvePanelLocale(app.getLocale());
let messages = PANEL_MESSAGES[locale];
/** The stored choice, `""` meaning "follow the system". Distinct from `locale`; see `PanelState`. */
let localeChoice: PanelLocaleChoice = "";

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
 * Where the user's data lives: the environment first, then the choice they made.
 *
 * Environment first for the same reason `ILA_HOST` is: `pnpm desktop:dev` and the e2e
 * harness have to run without a human at a folder picker, and an environment variable is the
 * only channel that can differ per launch without rewriting a file the user owns. An empty
 * answer means nobody has said yet, and the panel asks.
 *
 * Resolved rather than returned verbatim because the child's working directory is not
 * something to build a data path on — a relative `ILA_DATA_DIR` in a hand-edited
 * `desktop.json` would land somewhere different on every launch.
 */
function resolveDataDir(): string {
  const fromEnv = process.env.ILA_DATA_DIR?.trim();
  if (fromEnv) return resolve(fromEnv);
  return settings.dataDir ? resolve(settings.dataDir) : "";
}

/**
 * Whether this data root still needs its first administrator.
 *
 * Cached and broadcast as a *hint*; `currentState` stays synchronous and the authoritative
 * answer is asked fresh before a Start and after a create. Undefined until the first check,
 * so the panel neither claims "ready" nor "create one" before it has looked.
 */
let needsAdmin: boolean | undefined;
let checkingAdmin = false;

function adminContext() {
  return {
    electronExecPath: process.execPath,
    appRoot,
    paths,
    dataDir: resolveDataDir(),
  };
}

async function refreshAdminState(): Promise<boolean | undefined> {
  if (checkingAdmin) return needsAdmin;
  const dataDir = resolveDataDir();
  if (!dataDir) {
    needsAdmin = undefined;
    broadcast();
    return needsAdmin;
  }
  checkingAdmin = true;
  try {
    const result = await queryAdministrator(adminContext());
    if (result.ok) needsAdmin = !result.status.hasAdmin;
  } catch {
    // A check failing leaves the hint unset rather than wrong: the server's own refusal is
    // the backstop, and an unreadable database is reported when the user tries to create one.
    needsAdmin = undefined;
  } finally {
    checkingAdmin = false;
  }
  broadcast();
  return needsAdmin;
}

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
    needsDataDir: !resolveDataDir(),
    needsAdmin,
    localeChoice,
    locale,
  };
}

/**
 * Adopt a language, and repaint every part of the panel that is not the page.
 *
 * There are four of them and they are easy to forget one at a time: the window title, the
 * application menu, the tray menu and its tooltip, and — through `broadcast` — the page itself.
 * They are all rendered from `t` and the mutable `locale`/`messages` pair above, so this is one
 * assignment followed by a rebuild of each.
 *
 * Idempotent, and called on every startup as well as on every change: the panel must end up in
 * the stored language whichever route got here.
 */
function applyLocale(choice: PanelLocaleChoice): void {
  localeChoice = choice;
  locale = choosePanelLocale(choice, app.getLocale());
  messages = PANEL_MESSAGES[locale];

  if (panelWindow && !panelWindow.isDestroyed()) panelWindow.setTitle(t("window.title"));
  // The tray's tooltip is its own string rather than the window's, so it does not follow the
  // title; and the menu is rebuilt rather than mutated because `Menu` items are immutable.
  if (tray) tray.setToolTip(t("tray.tooltip"));
  buildMenu();
  refreshTrayMenu();
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

/**
 * Ask where the data should live, remember it, and start the server there.
 *
 * Two questions, not one. The folder picker collects a path; the confirm that follows — shown
 * only when that path holds no database — exists because an empty folder and a *wrong* folder
 * are indistinguishable from here, and picking the wrong one creates a second, empty database
 * that looks exactly like having lost everything. It warns and permits, because starting in a
 * new folder is the normal first-run case.
 *
 * Dismissing either one changes nothing. A cancelled dialog is not a failure, and the panel
 * is still in the state it was.
 */
async function chooseDataDir(): Promise<PanelState> {
  const properties: Array<"openDirectory" | "createDirectory"> = ["openDirectory", "createDirectory"];
  const options = {
    title: t("dataDir.chooseTitle"),
    // The last choice as the starting point, so changing one's mind about a sibling folder is
    // two clicks rather than a walk back down the filesystem.
    defaultPath: resolveDataDir() || paths.suggestedDataDir,
    buttonLabel: t("dataDir.chooseButton"),
    properties,
  };
  const picked = panelWindow
    ? await dialog.showOpenDialog(panelWindow, options)
    : await dialog.showOpenDialog(options);
  const dir = picked.canceled ? "" : picked.filePaths[0] ?? "";
  if (!dir) return currentState();

  if (!hasExistingData(dir)) {
    const { response } = await dialog.showMessageBox({
      type: "warning",
      message: t("dataDir.confirmTitle"),
      detail: t("dataDir.confirmDetail", { dir }),
      buttons: [t("dataDir.confirmProceed"), t("action.cancel")],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) return currentState();
  }

  settings = { ...settings, dataDir: dir };
  try {
    writeSettings(settingsFile, settings);
  } catch (err) {
    // Worth continuing, exactly as in `shareOnLan`: the choice still applies to this run, and
    // refusing to start because a preferences file could not be written would make the picker
    // look broken.
    console.error("Could not save the desktop settings:", err);
  }

  // Stopped unconditionally rather than only when it was up, since the data root changed.
  // The server is **not** auto-started on the way through: a freshly chosen folder usually
  // has no administrator yet, and the server refuses to listen without one. Checking first
  // lets the panel show the create control instead of reporting a start failure.
  await server.stop();
  await refreshAdminState();

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

/**
 * The secret this launch shares with the server it spawns.
 *
 * Generated once per launch of the panel and never written anywhere — not to `desktop.json`,
 * not to the config overlay, not to a log line. It exists so the server can tell a request
 * that came from this process from one that came from the network, and a fresh panel is a
 * fresh secret with nothing to revoke. See `ILA_PANEL_TOKEN` in `apps/server/src/auth.ts`.
 */
let panelToken = "";

function registerIpc(): void {
  ipcMain.handle(PANEL_CHANNELS.getState, () => currentState());
  ipcMain.handle(PANEL_CHANNELS.start, async () => {
    // With nowhere to put the data there is nothing to start, so this button means "choose a
    // folder". The alternative — letting it through — is a start that fails with the
    // server's own sentence about an unset environment variable, which names the cause and
    // offers the user nothing.
    if (!resolveDataDir()) return chooseDataDir();
    // Asked fresh rather than trusted from the cache. The server itself refuses to listen
    // without an administrator, so a stale "ready" hint here would turn this button into the
    // exact failure ("exited 1", no cause) the create flow exists to prevent. Two layers:
    // the panel refuses before spawning, the server refuses after, and they agree.
    const has = await refreshAdminState();
    if (has) {
      await server.start();
    }
    return currentState();
  });
  ipcMain.handle(PANEL_CHANNELS.stop, async () => {
    await server.stop();
    return currentState();
  });
  ipcMain.handle(PANEL_CHANNELS.chooseDataDir, () => chooseDataDir());
  ipcMain.handle(PANEL_CHANNELS.shareOnLan, (_event, on: unknown) => shareOnLan(on === true));
  ipcMain.handle(PANEL_CHANNELS.openApp, () => openAppWindow());
  ipcMain.handle(PANEL_CHANNELS.openInBrowser, async () => {
    const url = server.status().url;
    if (url) await shell.openExternal(url);
  });
  ipcMain.handle(PANEL_CHANNELS.revealDataDir, async () => {
    // The *user's* data, not the app's own directory: this is the folder they might want to
    // look inside or back up. Falls back to the app's tree when nothing has been chosen —
    // there is no data folder to show yet, and the config the app owns is the nearest thing.
    // `openPath` resolves to an error string rather than rejecting, so the failure is logged
    // rather than thrown into an unhandled rejection.
    const failure = await shell.openPath(resolveDataDir() || paths.root);
    if (failure) console.error("Could not open the data folder:", failure);
  });
  ipcMain.handle(PANEL_CHANNELS.resetAdminPassword, () => resetAdminPassword());
  ipcMain.handle(PANEL_CHANNELS.adminStatus, () => refreshAdminState());
  ipcMain.handle(PANEL_CHANNELS.createAdministrator, async (_event, input: unknown) => {
    const username =
      typeof input === "object" && input !== null && "username" in input
        ? String((input as { username: unknown }).username ?? "")
        : "";
    const password =
      typeof input === "object" && input !== null && "password" in input
        ? String((input as { password: unknown }).password ?? "")
        : "";
    const result = await createFirstAdministrator(adminContext(), { username, password });
    if (result.ok) await refreshAdminState();
    return result;
  });
  /**
   * Switch the panel's language.
   *
   * Anything the renderer sends that is not a language this build ships is read as "follow the
   * system" rather than refused, and the broadcast is what tells the caller: the panel's `<select>`
   * cannot produce a bad value, so a bad one is a request assembled by hand, and the answer to a
   * request about a *preference* is to store the fallback the user is actually going to see.
   */
  ipcMain.handle(PANEL_CHANNELS.setLocale, (_event, choice: unknown) => {
    const next: PanelLocaleChoice = isPanelLocaleChoice(choice) ? choice : "";
    settings = { ...settings, locale: next };
    try {
      writeSettings(settingsFile, settings);
    } catch (err) {
      // Worth continuing, exactly as in `shareOnLan`: the choice still applies to this run, and
      // refusing to switch language because a preferences file could not be written would make
      // the control look broken.
      console.error("Could not save the desktop settings:", err);
    }
    applyLocale(next);
    broadcast();
    return currentState();
  });

  ipcMain.handle(PANEL_CHANNELS.quit, () => {
    quitting = true;
    app.quit();
  });
}

/**
 * Ask the server to replace the administrator's password, and report what came back.
 *
 * A conversation with the *child process* rather than a write to the database, and that is
 * deliberate: the server owns the schema, the hashing and the token table, and a second
 * implementation of any of them in the panel is a second thing to keep in step. The secret
 * makes the route reachable only from here; everything else about it is the server's business.
 *
 * Every failure is described rather than thrown: this is a button on a page, and a rejection
 * crossing the IPC boundary would reach the renderer as an unhandled promise with nothing to
 * render.
 */
async function resetAdminPassword(): Promise<ResetResult | null> {
  const url = server.status().url;
  if (!url) return { ok: false, fault: { code: "not_running" } };

  // Confirmed first, and for the same reason choosing a data folder is: this is destructive in
  // a way the button's four words cannot convey — it replaces the credential of the one
  // account that can do everything, and signs it out wherever it is.
  const { response } = await dialog.showMessageBox({
    type: "warning",
    message: t("reset.confirmTitle"),
    detail: t("reset.confirmDetail"),
    buttons: [t("reset.confirm"), t("action.cancel")],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return null;

  try {
    const res = await fetch(new URL("/api/auth/panel-reset", url), {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-ila-panel-token": panelToken },
      body: "{}",
    });

    if (res.ok) {
      const body = (await res.json()) as { user: { username: string }; password: string };
      return { ok: true, username: body.user.username, password: body.password };
    }
    // 404 is the server's "there is no account to reset" — either nobody has been created on
    // this data root yet, or the build predates the route. The first is the ordinary case and
    // the one the panel has wording for, so it gets its own answer.
    if (res.status === 404) return { ok: false, fault: { code: "no_admin" } };
    return { ok: false, fault: { code: "unreachable", message: `HTTP ${res.status}` } };
  } catch (error) {
    return {
      ok: false,
      fault: { code: "unreachable", message: error instanceof Error ? error.message : String(error) },
    };
  }
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

    // Before anything is drawn or built: the stored language is what the menu bar, the tray and
    // the window title are rendered from, and building them first would show one language for a
    // frame and then swap it.
    applyLocale(settings.locale);

    panelToken = randomUUID();

    server = new ServerProcess(
      // Read at every start, so flipping the switch — or choosing a different data folder —
      // takes effect on the restart that follows it without replacing this object, which
      // would drop the subscription the panel's state arrives through.
      () =>
        buildLaunchSpec({
          electronExecPath: process.execPath,
          serverEntry: serverEntryFor(appRoot),
          paths,
          dataDir: resolveDataDir(),
          host: settings.sharedOnLan ? ANY_INTERFACE_HOST : LOOPBACK_HOST,
          panelToken,
        }),
      { dataDir: resolveDataDir() }
    );
    server.subscribe(broadcast);

    registerIpc();
    buildMenu();
    createTray();

    panelWindow = createPanelWindow();

    // Auto-start, because the panel's whole purpose is to be the thing that has the server
    // running. A user who wants it stopped has a button; a user who has to remember to press
    // "start" before anything works has a puzzle.
    //
    // Two exceptions, both states with nothing the server can serve:
    // - nobody has said where the data goes, so the panel asks for a folder;
    // - the folder has no administrator, so the server would refuse to listen and the panel's
    //   job is the create control. The check broadcasts `needsAdmin` either way, so the panel
    //   shows the right thing; starting is what the user does once they have made one.
    if (resolveDataDir()) {
      const has = await refreshAdminState();
      if (has) await server.start();
    }

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
