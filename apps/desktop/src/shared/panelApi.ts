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
  revealDataDir: "panel:reveal-data-dir",
  /**
   * Give the installation's administrator a new password.
   *
   * The one command here that is not about the server *process*: it is the way back in for an
   * administrator who cannot sign in, which is the one state the app itself can never resolve.
   * See `PanelApi.resetAdminPassword`.
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
 * Why the administrator's password could not be reset.
 *
 * A union rather than a sentence, for the reason `ServerFault` is: the panel is bilingual and
 * this is the side that knows *what* happened. `message` is the fallback for the case with no
 * code to key on — the server's own wording, or the network's.
 */
export type ResetFault =
  /** Nothing is listening: the server is not up, so there is nobody to ask. */
  | { code: "not_running" }
  /** Reachable, and it has no administrator to reset — a data root nobody has set up yet. */
  | { code: "no_admin" }
  /** The request itself failed: refused, timed out, or the server said something unexpected. */
  | { code: "unreachable"; message: string };

/**
 * The password the reset produced, or why there is not one.
 *
 * The password is in the successful arm only, and it is **not** stored anywhere on the way
 * through — the panel holds it long enough to render it once, exactly as the console does.
 * Only a hash reaches the database, so a panel that forgot to show it could not fetch it back.
 */
export type ResetResult =
  | { ok: true; username: string; password: string }
  | { ok: false; fault: ResetFault };

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
  /** Opens (or focuses) the app window. A no-op unless the server is running. */
  openApp(): Promise<void>;
  /** Opens the same URL in the user's own browser, for bookmarks and devtools. */
  openInBrowser(): Promise<void>;
  revealDataDir(): Promise<void>;
  /**
   * Replace the administrator's password with a generated one, and hand it back.
   *
   * The way back in when the password is forgotten: every other route needs somebody already
   * signed in, which is exactly what a forgotten password prevents. Local access to the
   * machine is the proof of identity here, and turning this panel on is what "local access"
   * means — the secret it sends was generated for this launch and never leaves the process
   * tree, so reaching the server over the network does not get anyone one.
   *
   * It also ends the administrator's sessions, so a password replaced while the old one is
   * still live has really been replaced.
   *
   * Resolves `null` when the confirmation was dismissed — an outcome rather than a failure,
   * and a different one from any of `ResetFault`'s.
   */
  resetAdminPassword(): Promise<ResetResult | null>;
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
