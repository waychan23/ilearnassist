/**
 * The contract between the control panel's processes.
 *
 * Main, the preload bridge and the renderer bundle all import this module, which is the
 * only reason a channel name or a status field cannot drift between the side that sends it
 * and the side that renders it. `contextIsolation` is on, so nothing else crosses: the
 * renderer sees exactly the surface `PanelApi` describes and no `require`.
 */

export const PANEL_CHANNELS = {
  getState: "panel:get-state",
  start: "panel:start",
  stop: "panel:stop",
  openApp: "panel:open-app",
  openInBrowser: "panel:open-in-browser",
  revealDataDir: "panel:reveal-data-dir",
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
  /** Where the database, uploads and workspaces live. Shown so a user can find them. */
  dataDir: string;
  /** Newest last, capped. Diagnostics for a start that never reached `running`. */
  logs: string[];
}

export interface PanelApi {
  getState(): Promise<ServerStatus>;
  start(): Promise<ServerStatus>;
  stop(): Promise<ServerStatus>;
  /** Opens (or focuses) the app window. A no-op unless the server is running. */
  openApp(): Promise<void>;
  /** Opens the same URL in the user's own browser, for bookmarks and devtools. */
  openInBrowser(): Promise<void>;
  revealDataDir(): Promise<void>;
  quit(): Promise<void>;
  onStateChange(listener: (status: ServerStatus) => void): () => void;
}

declare global {
  interface Window {
    panel: PanelApi;
  }
}
