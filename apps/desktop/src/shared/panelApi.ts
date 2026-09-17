/**
 * The contract between the control panel's processes.
 *
 * Main, the preload bridge and the renderer bundle all import this module, which is the
 * only reason a channel name or a status field cannot drift between the side that sends it
 * and the side that renders it. `contextIsolation` is on, so nothing else crosses: the
 * renderer sees exactly the surface `PanelApi` describes and no `require`.
 */

import type { PanelLocale, PanelLocaleChoice } from "./messages.js";

export const PANEL_CHANNELS = {
  getState: "panel:get-state",
  start: "panel:start",
  stop: "panel:stop",
  /**
   * Rebind the server so other devices can reach it, or stop. Restarts it either way —
   * a bind address is chosen at `listen`, so there is nothing to change underneath a
   * running process.
   */
  shareOnLan: "panel:share-on-lan",
  openApp: "panel:open-app",
  openInBrowser: "panel:open-in-browser",
  /**
   * Ask the user where their data should live, and start the server there.
   *
   * A folder picker in main rather than in the renderer: only main can open a native
   * dialog, and the question the picker has to ask — "this folder has no ilearnassist data
   * in it; a new, empty database will be created there" — is one the operating system is
   * better at asking than a page is.
   */
  chooseDataDir: "panel:choose-data-dir",
  /**
   * Take the folder the panel offers, instead of picking one.
   *
   * The other half of `chooseDataDir`, and the reason it exists: a first launch that offers
   * nothing makes the user work out where their data should live before they have used the app
   * once. This creates `~/ilearnassist` and remembers it, so the answer is one click.
   *
   * Which is *not* the same as defaulting, and the difference is the whole design: nothing is
   * created or recorded until this is called, and it is only ever called from a button. The
   * server still receives a path somebody agreed to. It takes no argument — the folder is main's
   * to compute, so there is nothing here for a page to steer.
   */
  useDefaultDataDir: "panel:use-default-data-dir",
  revealDataDir: "panel:reveal-data-dir",
  /**
   * Give the installation's administrator a new password chosen by the operator.
   *
   * The one command here that is not about the server *process*: it is the way back in for an
   * administrator who cannot sign in, which is the one state the app itself can never resolve.
   * The password comes in with the call, on stdin of the one-shot child — see
   * `PanelApi.resetAdminPassword`.
   */
  resetAdminPassword: "panel:reset-admin-password",
  /**
   * Ask the bundled CLI whether this data root has an administrator. The panel needs this
   * with the server deliberately stopped, so it is a one-shot child rather than a request.
   */
  adminStatus: "panel:admin-status",
  /**
   * Create the first administrator through that same child. The password is the operator's
   * own, typed into the panel and handed over stdin, so it never appears in the process
   * list or a log line.
   */
  createAdministrator: "panel:create-administrator",
  /**
   * Choose the panel's language.
   *
   * A round trip to main rather than a renderer-local choice, because the panel's words are not
   * all drawn by the page: the menu bar, the tray menu and every native dialog are rendered by
   * the main process, and a page that switched language on its own would leave the menu above it
   * in the old one. Main writes the choice down and broadcasts the new state, so the page and the
   * chrome change together on the same fact.
   */
  setLocale: "panel:set-locale",
  quit: "panel:quit",
  /** main → renderer, pushed on every change so the panel never has to poll. */
  stateChanged: "panel:state",
} as const;

export type ServerState = "stopped" | "starting" | "running" | "stopping" | "failed";

/**
 * Why the server is not up.
 *
 * A discriminated union rather than a pre-rendered sentence, for the same reason the HTTP
 * API sends `{code, message, params}` instead of prose: the panel is bilingual, so the
 * side that knows *what* went wrong must not be the side that decides how to say it.
 * `message` is the exception and mirrors the API's own fallback rule — it is the
 * operating system's wording for a failure with no code to key on.
 */
export type ServerFault =
  | { code: "spawn_failed"; message: string }
  | { code: "exited"; exitCode: number | null; signal: string | null }
  | { code: "timeout"; seconds: number };

export interface ServerStatus {
  state: ServerState;
  /** Set once `state` is `running`: the origin the web UI is served from. */
  url: string | null;
  /** Set when `state` is `failed`; null otherwise. */
  fault: ServerFault | null;
  /** The chosen data root: the database, every account's workspaces, and their uploads. */
  dataDir: string;
  /** Newest last, capped. Diagnostics for a start that never reached `running`. */
  logs: string[];
}

/**
 * Everything the panel renders, in one object.
 *
 * The panel shows more than the server's state — whether it is reachable from another
 * device, and at what address — and those facts belong to the *app*, not to the child
 * process. Wrapping rather than widening `ServerStatus` keeps `ServerProcess` ignorant of
 * networks and settings, which is what lets it be tested against a bare `node` script.
 */
export interface PanelState {
  server: ServerStatus;
  /** Whether the server is bound so other devices on the network can reach it. */
  sharedOnLan: boolean;
  /**
   * The URL to open from a phone or tablet. Null when there is nothing to open — sharing is
   * off, the server is not up, or this machine has no address another device could use.
   */
  lanUrl: string | null;
  /** This machine's network address, so it can be typed by hand if scanning is awkward. */
  lanAddress: string | null;
  /**
   * Nobody has said where the data should live, so there is nowhere to put it.
   *
   * The server has not been started and cannot be: it refuses to run without a data root,
   * by design, because the alternative is a path it invented. The panel's whole job in this
   * state is to ask — every control that needs a running server is inert until it does.
   */
  needsDataDir: boolean;
  /**
   * The folder `useDefaultDataDir` would create and use.
   *
   * On the state rather than in a catalog string, because the sentence the panel shows has to
   * name the actual path — "one will be created at `~/ilearnassist`" is only honest if the user
   * can see which folder is about to appear, and their home directory is not a constant.
   */
  defaultDataDir: string;
  /**
   * Whether this data root still needs its first administrator.
   *
   * A cached hint, not a fact the panel acts on without asking: `start` re-checks through
   * the CLI before spawning the server, because the server itself refuses to listen without
   * one, and a Start that produced "failed: exited 1" is the failure this state exists to
   * prevent. Undefined while the check has not run.
   */
  needsAdmin: boolean | undefined;
  /**
   * What the language control shows: `""` for "follow the operating system", else a locale tag.
   *
   * The *choice*, not the language being rendered — the two differ exactly when the choice is
   * "system", and a select bound to the rendered value would silently turn "follow the system"
   * into an explicit choice the first time a state broadcast arrived.
   */
  localeChoice: PanelLocaleChoice;
  /**
   * The language the panel is rendering in right now, on both sides of the IPC boundary.
   *
   * Carried in the state rather than computed in the page from `navigator.language`, because
   * main is the side that resolved it — from the stored choice and `app.getLocale()` — and the
   * page and the native dialogs have to agree. The page switching on its own would be a second
   * answer to a question only one process can answer.
   */
  locale: PanelLocale;
}

/**
 * Why the administrator command failed.
 *
 * Two kinds, on one field. A code from the CLI's own closed set (`PASSWORD_TOO_SHORT`,
 * `ADMIN_EXISTS`, `SCHEMA_UNREADABLE`, …) means the child ran and its rules refused; the
 * four boundary codes below mean the child itself could not be run or did not answer. The
 * renderer maps both with one catalog, keyed on the string, so a new CLI code is a missing
 * translation rather than a silent untyped string.
 */
export interface AdminFault {
  code: import("@ilearnassist/shared").AdminCliErrorCode | "no_data_dir" | "spawn_failed" | "timed_out" | "bad_response";
  /** The CLI's own sentence, for the cases where it ran and refused. */
  message?: string;
  params?: Record<string, string | number>;
}

/** The parsed answer to "does this data root have an administrator". */
export interface AdminStatus {
  hasAdmin: boolean;
  /** Who, when known — so the panel can say which account it found. */
  adminUsername: string | null;
}

export type AdminStatusResult =
  | { ok: true; status: AdminStatus }
  | { ok: false; fault: AdminFault };

/** The new administrator, or why there is not one. */
export type CreateAdministratorResult =
  | { ok: true; username: string }
  | { ok: false; fault: AdminFault };

/**
 * The username whose password was replaced, or why it was not.
 *
 * The operator chooses the password, so there is nothing to hand back: the chosen value never
 * crosses the IPC boundary in the reply and is not rendered — only the name confirms what
 * happened. (The CLI still supports `--generate` for a terminal, and that path returns a
 * password, but the panel never asks for it.)
 *
 * The fault is an `AdminFault` — the same union the two commands beside it answer with — rather
 * than a fourth shape of its own. Both are conversations with the same child, so a code that
 * means "the CLI could not run" means it here too, and the panel renders the two with one
 * catalog. `ADMIN_NOT_FOUND` is the one that is specific to this command: a data root nobody
 * has set up yet, which the panel says in the same breath as offering to create one.
 */
export type ResetResult =
  | { ok: true; username: string }
  | { ok: false; fault: AdminFault };

export interface PanelApi {
  getState(): Promise<PanelState>;
  start(): Promise<PanelState>;
  stop(): Promise<PanelState>;
  /** Turn LAN sharing on or off. Restarts the server, so it resolves when that settles. */
  shareOnLan(on: boolean): Promise<PanelState>;
  /**
   * Open a folder picker, record the choice, and start the server there.
   *
   * Resolves with the state *after* the start, or with an unchanged state if the picker was
   * dismissed — cancelling is not an error and needs no reply.
   */
  chooseDataDir(): Promise<PanelState>;
  /**
   * Create the offered folder, record it, and leave the server stopped.
   *
   * Stops short of starting, exactly as the picker does: a folder that did not exist a moment
   * ago holds no administrator either, and the server refuses to listen without one — so the
   * next thing the user should see is the create-administrator card, not a failed start.
   */
  useDefaultDataDir(): Promise<PanelState>;
  /** Opens (or focuses) the app window. A no-op unless the server is running. */
  openApp(): Promise<void>;
  /** Opens the same URL in the user's own browser, for bookmarks and devtools. */
  openInBrowser(): Promise<void>;
  revealDataDir(): Promise<void>;
  /**
   * Replace the superadmin's password with the one the operator chose.
   *
   * The way back in when the password is forgotten: every other path needs somebody already
   * signed in, which is exactly what a forgotten password prevents. Local access to the machine
   * is the proof of identity here — the panel assumes the person at this machine *is* the
   * superadmin, which is why the new password is typed here (the same flow as creating the
   * first administrator) rather than generated and shown once. It reaches the one-shot child
   * on stdin, never an argv string the process table would show.
   *
   * It is also the only place a superadmin's own password can be replaced: the web console
   * refuses it (`PANEL_RESET_REQUIRED`), because a console reached with a credential the caller
   * already holds is a weaker second way to the one credential that can undo the installation.
   *
   * **It does not need the server to be running.** The work is a one-shot child of the same
   * bundle the server comes from, so the button means the same thing whether the server is up,
   * stopped, or refusing to start — and the last of those is exactly when somebody reaches for
   * it.
   *
   * It ends the account's sessions as well, so a password replaced while the old one is still
   * live has really been replaced.
   */
  resetAdminPassword(input: { password: string }): Promise<ResetResult>;
  /** Ask the bundled CLI whether this data root has an administrator. */
  adminStatus(): Promise<AdminStatusResult>;
  /**
   * Create the first administrator. The password is typed into the panel and handed over on
   * stdin, so it never appears in a process argument or a log line.
   */
  createAdministrator(input: { username: string; password: string }): Promise<CreateAdministratorResult>;
  /**
   * Switch the panel's language, and resolve when the chrome around it has switched too.
   *
   * Returns the state rather than nothing, like every other command here: the renderer's next
   * paint is then showing a `locale` that is already true, instead of one it guessed while the
   * menu bar was still catching up.
   */
  setLocale(choice: PanelLocaleChoice): Promise<PanelState>;
  quit(): Promise<void>;
  onStateChange(listener: (state: PanelState) => void): () => void;
}

declare global {
  interface Window {
    panel: PanelApi;
  }
}
