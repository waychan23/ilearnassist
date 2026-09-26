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
  isUserPort,
  serverEntryFor,
} from "./launch.js";
import {
  createFirstAdministrator,
  mayStartServer,
  queryAdministrator,
  resetAdministratorPassword,
} from "./admin.js";
import { findLanAddress, lanUrlFor } from "./lan.js";
import {
  dataDirPromptAnswer,
  ensureDataDir,
  hasExistingData,
  resolveAppPaths,
  seedFirstRun,
  trayIconFile,
  type AppPaths,
} from "./paths.js";
import { readSettings, writeSettings, type DesktopSettings } from "./settings.js";
import { RELEASES_PAGE, checkForUpdate, isNewer } from "./update.js";
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
/** True while a version check is in flight, so the manual item can say so and cannot be doubled. */
let checking = false;
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
 * Whether this data root has an administrator.
 *
 * Held in the **positive** sense, and that is not a style preference — it is the fix for a bug
 * that made Start do nothing at all. The field used to store `needsAdmin` (the negation) while
 * both callers read it as "has one" and started only when it was true, so the button worked
 * exactly once, on an empty data root where the server would then refuse to listen, and never
 * again. One name for one fact, and the negation happens where it is rendered, in `currentState`.
 *
 * Cached and broadcast as a *hint*; `currentState` stays synchronous and the authoritative
 * answer is asked fresh before a Start and after a create. Undefined until the first check,
 * so the panel neither claims "ready" nor "create one" before it has looked.
 */
let hasAdmin: boolean | undefined;
let checkingAdmin = false;

function adminContext() {
  return {
    electronExecPath: process.execPath,
    appRoot,
    paths,
    dataDir: resolveDataDir(),
  };
}

/**
 * Ask the bundled CLI, and answer with what it said.
 *
 * The return value is the *answer*, not the cached hint — the callers decide whether to spawn a
 * server on it, and a stale or absent hint is not an answer. `undefined` means the question
 * could not be answered at all (no data root, an unreadable database, a CLI that would not run),
 * which is a third state and not the same as "no administrator".
 */
async function refreshAdminState(): Promise<boolean | undefined> {
  if (checkingAdmin) return hasAdmin;
  const dataDir = resolveDataDir();
  if (!dataDir) {
    hasAdmin = undefined;
    broadcast();
    return hasAdmin;
  }
  checkingAdmin = true;
  try {
    const result = await queryAdministrator(adminContext());
    if (result.ok) hasAdmin = result.status.hasAdmin;
  } catch {
    // A check failing leaves the hint unset rather than wrong: the server's own refusal is
    // the backstop, and an unreadable database is reported when the user tries to create one.
    hasAdmin = undefined;
  } finally {
    checkingAdmin = false;
  }
  broadcast();
  return hasAdmin;
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
    port: settings.port,
    // Offered only while sharing is on. The address answers either way once the server is
    // bound to every interface, but showing it while the switch is off would invite someone
    // to open a URL that cannot work — the switch is the promise, so it gates the offer.
    lanUrl: settings.sharedOnLan ? lanUrlFor(status.url, lanAddress) : null,
    lanAddress,
    needsDataDir: !resolveDataDir(),
    defaultDataDir: paths.defaultDataDir,
    // The negation lives here and only here, so the field the panel renders and the field the
    // Start gate reads can be one fact under one name.
    needsAdmin: hasAdmin === undefined ? undefined : !hasAdmin,
    localeChoice,
    locale,
    // Read from the bundle, which is what electron-builder stamped from package.json. The panel
    // is the only place a packaged user can find out which version they are running.
    appVersion: app.getVersion(),
    update: {
      // The cached answer, so a launch with no network still shows what the last check found.
      latestVersion: settings.updateCheck?.latestVersion ?? null,
      url: settings.updateCheck?.url ?? null,
      available: isNewer(settings.updateCheck?.latestVersion ?? null, app.getVersion()),
      checking,
    },
  };
}

/**
 * Ask GitHub whether there is a newer release, remember the answer, and repaint.
 *
 * Fire-and-forget from `whenReady`, never awaited by anything the user waits for: the panel draws
 * immediately and adopts the answer when it arrives. A **failed** check leaves the cache alone
 * rather than writing "nothing found" into it — a flaky network must not look like a confirmed
 * up-to-date app, and the cached notice from last week is more useful than an empty answer.
 *
 * `checking` is on the state because the manual menu item needs it: a control that looks live and
 * does nothing is the failure this panel's own docblock names, and "checking…" is the honest thing
 * to show for the two seconds it takes.
 */
async function runUpdateCheck(): Promise<void> {
  if (checking) return;
  checking = true;
  broadcast();
  try {
    const result = await checkForUpdate({ current: app.getVersion() });
    if (result.latest) {
      settings = {
        ...settings,
        updateCheck: { latestVersion: result.latest, url: result.url ?? RELEASES_PAGE, checkedAt: new Date().toISOString() },
      };
      writeSettings(settingsFile, settings);
    }
  } finally {
    checking = false;
    broadcast();
  }
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
 * Change the fixed listen port, restarting the server if it was up.
 *
 * The same restart contract as `shareOnLan`: a port is chosen at `listen`, so nothing can
 * change under a running process, and the restart settles before this returns. An unusable
 * value is refused and changes nothing — it is never coerced.
 */
async function setPort(port: number): Promise<PanelState> {
  if (!isUserPort(port)) return currentState();
  if (settings.port !== port) {
    settings = { ...settings, port };
    try {
      writeSettings(settingsFile, settings);
    } catch (err) {
      // Same continuation as the LAN switch: the new port applies to this run regardless.
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
    defaultPath: resolveDataDir() || paths.defaultDataDir,
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
  await resetAppWindow();

  broadcast();
  return currentState();
}

/**
 * Ask where the data should go, when a Start arrives with nowhere to put it.
 *
 * The native counterpart to the panel's own first-run row, and the answer to a press that cannot
 * proceed: the server will not run without a data root, so this is the one moment the question has
 * to be answered before the button can mean anything. Naming the folder it would create is the
 * whole point — "a default exists" is not actionable, and `~/ilearnassist` is.
 *
 * The two answers are the *same* two functions the panel's row calls, so there is one
 * implementation of each and the dialog is only a second door to them. `choose` chains a second
 * native dialog (the picker, with its own warning about a folder that holds no data); `cancel`
 * returns nothing changed, and the panel is exactly as it was.
 *
 * A cancelled picker is a cancel of the whole thing rather than a fall back to the default —
 * someone who picked "choose another location" and then dismissed the picker has not agreed to
 * the folder they just declined.
 */
async function promptForDataDir(): Promise<"ok" | "cancel"> {
  const { response } = await dialog.showMessageBox({
    type: "question",
    message: t("dataDir.promptTitle"),
    detail: t("dataDir.promptDetail", { dir: paths.defaultDataDir }),
    buttons: [t("action.useDefaultDataDir"), t("action.chooseDataDir"), t("action.cancel")],
    defaultId: 0,
    cancelId: 2,
  });

  switch (dataDirPromptAnswer(response)) {
    case "default":
      await useDefaultDataDir();
      return resolveDataDir() ? "ok" : "cancel";
    case "choose":
      await chooseDataDir();
      return resolveDataDir() ? "ok" : "cancel";
    default:
      return "cancel";
  }
}

/**
 * Take the folder the panel offers: create it, remember it, and stop there.
 *
 * The one-click answer to the question `chooseDataDir` opens a dialog for. It creates
 * `~/ilearnassist` — which is the point of the button, since a folder that does not exist yet
 * cannot be picked — and then does what the picker does, in the same order and for the same
 * reasons: write the choice, stop the server unconditionally because the data root changed, and
 * re-check the administrator rather than auto-starting.
 *
 * `hasExistingData` is not asked about, unlike in the picker. There, an empty folder and a wrong
 * one are indistinguishable from the outside; here the folder is this app's own suggestion in the
 * user's home, so a warning about it would be a warning about the default — and a folder that
 * already holds data is a *good* outcome, because it means the user is coming back to it.
 */
async function useDefaultDataDir(): Promise<PanelState> {
  try {
    ensureDataDir(paths.defaultDataDir);
  } catch (err) {
    // The button's whole job is to make the folder, so this one cannot be swallowed the way a
    // settings-write failure is: carrying on would record a data root the server then cannot
    // open, and the failure would surface later as a start error about a path nobody chose.
    // A native dialog because that is the only voice main has here — the panel's own error
    // surface is the server's fault field, and no server is involved in this.
    console.error("Could not create the default data folder:", err);
    dialog.showErrorBox(
      t("dataDir.createFailedTitle"),
      t("dataDir.createFailedDetail", { dir: paths.defaultDataDir })
    );
    return currentState();
  }

  // Absolute, and read off the resolved paths rather than rebuilt here: `resolveDataDir()` runs
  // `resolve()` on whatever is stored, and a relative value would then mean something different
  // from one launcher to the next.
  settings = { ...settings, dataDir: paths.defaultDataDir };
  try {
    writeSettings(settingsFile, settings);
  } catch (err) {
    console.error("Could not save the desktop settings:", err);
  }

  await server.stop();
  await refreshAdminState();
  await resetAppWindow();

  broadcast();
  return currentState();
}

// ---- windows ---------------------------------------------------------------

function createPanelWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 480,
    // Every row, plus room for the log view when it is opened — the disclosure takes the
    // leftover height, so the slack when it is collapsed is what the log pane gets when it
    // is not. The port row the panel gained is why this is 720 rather than 660.
    height: 720,
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

    /*
     * One check per launch, fire-and-forget. Not awaited, and deliberately after the window is
     * up: nothing the user is waiting for depends on GitHub answering, and a slow network must not
     * delay the panel. See `runUpdateCheck` for what a failure does (nothing).
     */
    void runUpdateCheck();
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
    // The window is reused, but not when it is on a *different* address — which is what a
    // restart on another port leaves behind: a page from a server that is no longer running.
    // Compared rather than reloaded unconditionally, so re-opening the app does not throw away
    // whatever the page has in hand.
    if (appWindow.webContents.getURL() !== url) await appWindow.loadURL(url);
    appWindow.show();
    appWindow.focus();
    return;
  }

  const window = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 720,
    minHeight: 520,
    // The product name, from the catalog rather than the literal `app.setName` holds: this is the
    // title bar for the milliseconds before the web app's own `<title>` arrives, and it should
    // read as the product rather than as the identifier.
    title: t("app.name"),
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

/**
 * Throw the app window away when the data root changes, and its storage with it.
 *
 * The app surface is **not** what this feature is for — it is a browser window on the server's own
 * address, and a data-root switch leaves it holding a bearer token and a `/w/<id>/s/<id>` that
 * belong to the database that is no longer there. The client now settles that for itself, by
 * comparing the installation id before it uses the token (see
 * `apps/web/src/composables/instance.ts`), and this is deliberately **not** a second
 * implementation of it: what the window cannot do for itself is survive at all, because the
 * server it is pointed at has just been stopped and may come back on another port.
 *
 * So the window is closed rather than reloaded. The next Start opens a fresh one against the
 * address that exists, which is the same path a user who had closed the window takes. Closing it
 * would look like a rude interruption if it were not for where this is called from: the data-root
 * picker is a deliberate, confirmed act, and the app window is the thing it makes stale.
 *
 * `clearStorageData` covers the origin the window was on, and is defence in depth rather than the
 * mechanism: the token in it is already dead, and the client's own check would drop it. It is here
 * because a session that ends by comparison leaves the dead credential *read* first, and not
 * writing one at all is better than reading one.
 */
async function resetAppWindow(): Promise<void> {
  if (!appWindow || appWindow.isDestroyed()) return;

  const window = appWindow;
  appWindow = null;
  try {
    const origin = new URL(window.webContents.getURL()).origin;
    await window.webContents.session.clearStorageData({
      origin,
      storages: ["localstorage", "indexdb", "cachestorage"],
    });
  } catch (err) {
    // A window with no URL yet, or a storage layer that refuses — neither is a reason to leave
    // the window standing on a server that is gone, which is what the close below is for.
    console.error("Could not clear the app window's storage:", err);
  }
  if (!window.isDestroyed()) window.destroy();
}

// ---- tray ------------------------------------------------------------------

function createTray(): void {
  // Which file is `paths.ts`'s answer, not this one's: it is a platform question with a
  // wrong answer that only shows up on Windows, so it is asserted against the committed
  // assets in a test rather than here where nothing can reach it.
  const file = trayIconFile(process.platform);
  // `createFromPath` picks up the `@2x` sibling automatically, so the mark is drawn at two
  // sizes rather than scaled and blurred.
  const icon = nativeImage.createFromPath(join(resourcesDir, "tray", file));
  if (icon.isEmpty()) {
    // A missing icon would otherwise appear as an invisible tray item that still swallows
    // clicks — worse than no tray, because the app would look like it had quit. The panel
    // still works; only the tray half does not. Naming the file, because on Windows this is
    // the difference between "the tray is broken" and "one asset was not staged".
    console.error(`Tray icon ${file} missing from the app bundle; running without a tray item`);
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
    // With nowhere to put the data there is nothing to start — the server refuses to run without
    // a data root, and letting this through would be a start that fails with the server's own
    // sentence about an unset environment variable. So the press asks, natively, and then carries
    // on with the same start it was going to do: the question is a detour to get the missing
    // input, not a substitute for the press.
    //
    // It used to return the unchanged state and let the page point at its own default button.
    // That is invisible — a programmatic focus draws no ring and moves nothing — so Start read as
    // a button that did nothing at all, which is the failure this panel's docblocks argue against
    // everywhere else.
    if (!resolveDataDir() && (await promptForDataDir()) === "cancel") return currentState();
    // Asked fresh rather than trusted from the cache. The server itself refuses to listen
    // without an administrator, so a stale "ready" hint here would turn this button into the
    // exact failure ("exited 1", no cause) the create flow exists to prevent. Two layers:
    // the panel refuses before spawning, the server refuses after, and they agree.
    if (mayStartServer(await refreshAdminState())) {
      await server.start();
    }
    return currentState();
  });
  ipcMain.handle(PANEL_CHANNELS.stop, async () => {
    await server.stop();
    return currentState();
  });
  ipcMain.handle(PANEL_CHANNELS.chooseDataDir, () => chooseDataDir());
  ipcMain.handle(PANEL_CHANNELS.useDefaultDataDir, () => useDefaultDataDir());
  ipcMain.handle(PANEL_CHANNELS.shareOnLan, (_event, on: unknown) => shareOnLan(on === true));
  ipcMain.handle(PANEL_CHANNELS.setPort, (_event, port: unknown) =>
    setPort(typeof port === "number" ? port : NaN)
  );
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
  ipcMain.handle(PANEL_CHANNELS.resetAdminPassword, (_event, input: unknown) => {
    // The password is read the same defensive way the create handler reads its two fields:
    // the renderer is trusted but typed, IPC is not. It rides the child's stdin.
    const password =
      typeof input === "object" && input !== null && "password" in input
        ? String((input as { password: unknown }).password ?? "")
        : "";
    return resetAdminPassword(password);
  });
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
  /*
   * The version check, on demand and on request.
   *
   * `checkForUpdates` resolves when the check has finished rather than returning immediately, so
   * the manual menu item can await it and the renderer's spinner is honest. It cannot fail: an
   * unreachable GitHub resolves with the state unchanged, which is the same thing the panel shows
   * for "no newer release".
   */
  ipcMain.handle(PANEL_CHANNELS.checkForUpdates, async () => {
    await runUpdateCheck();
    return currentState();
  });

  /*
   * Open the release page. No argument from the renderer — the address is this process's own,
   * because a `shell.openExternal` a page can aim is a phishing primitive.
   */
  ipcMain.handle(PANEL_CHANNELS.openUpdatePage, async () => {
    const url = settings.updateCheck?.url;
    if (url) await shell.openExternal(url);
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
 * Replace the superadmin's password with the one the operator chose, and report what came back.
 *
 * A conversation with a **one-shot child**, not a request to the server, and the difference is
 * what makes the button work in every state rather than only while the server happens to be up.
 * It used to be an HTTP route guarded by a per-launch secret, which meant the one control that
 * exists for "I cannot sign in" also required a healthy running server — and a forgotten
 * password tends to be discovered in the same moment as something else being wrong.
 *
 * No native confirmation here: the sheet that collects the password and its confirmation field
 * *is* the deliberate act, the same shape as the create-administrator form. Every failure is
 * described rather than thrown: this is a button on a page, and a rejection crossing the IPC
 * boundary would reach the renderer as an unhandled promise with nothing to render.
 */
async function resetAdminPassword(password: string): Promise<ResetResult> {
  return resetAdministratorPassword(adminContext(), { password });
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
          /*
           * Manual, and next to the automatic one: the check runs once a launch, so a user who
           * has just installed a release from this menu item's notice can ask again without
           * restarting the app.
           */
          {
            label: t("action.checkUpdates"),
            click: () => void runUpdateCheck(),
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
    paths = resolveAppPaths({
      userDataDir: app.getPath("userData"),
      // The default data folder is `~/ilearnassist`, so the home directory is an input like the
      // other two rather than something `paths.ts` reaches for itself — which is what keeps that
      // module testable with no Electron runtime.
      homeDir: app.getPath("home"),
      resourcesDir,
    });
    settingsFile = join(paths.root, "desktop.json");
    seedFirstRun(paths);
    settings = readSettings(settingsFile);

    // Before anything is drawn or built: the stored language is what the menu bar, the tray and
    // the window title are rendered from, and building them first would show one language for a
    // frame and then swap it.
    applyLocale(settings.locale);

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
          port: settings.port,
        }),
      // A function, like the spec above and for the same reason: the user can choose a different
      // folder while this object is alive, and the panel must show the one they chose rather
      // than the one it was constructed with. See `ServerProcessOptions.dataDir`.
      { dataDir: resolveDataDir }
    );
    server.subscribe(broadcast);

    registerIpc();
    buildMenu();
    createTray();

    panelWindow = createPanelWindow();

    /*
     * One check per launch, fire-and-forget. Not awaited, and deliberately after the window is
     * up: nothing the user is waiting for depends on GitHub answering, and a slow network must not
     * delay the panel. See `runUpdateCheck` for what a failure does (nothing).
     */
    void runUpdateCheck();

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
      if (mayStartServer(await refreshAdminState())) await server.start();
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
