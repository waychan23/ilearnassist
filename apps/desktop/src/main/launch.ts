import { join } from "node:path";
import type { AppPaths } from "./paths.js";

/**
 * How the control panel starts the backend, and how it knows the backend came up.
 *
 * Two decisions live here, and both exist to remove a way for the packaged app to fail that
 * a checkout does not have.
 *
 * **The child is the Electron binary, not `node`.** There is no Node runtime to rely on on
 * a user's machine, and shipping one would mean shipping a second ~100MB interpreter. With
 * `ELECTRON_RUN_AS_NODE=1` the binary we are already running executes a script as plain
 * Node — same version, same native-module ABI, nothing extra to install. That ABI point is
 * load-bearing: `better-sqlite3` is a compiled addon, and the prebuilt binary has to match
 * the runtime loading it, so the server must run on Electron's Node rather than any other.
 *
 * **A child process at all, rather than the server in `main`.** In-process would mean a
 * crash in a route, or a blocking parse, takes the window with it, and stopping the server
 * would have no clean boundary to stop at. Out-of-process, "stop" is a signal that Fastify
 * turns into an orderly shutdown, and a server that dies leaves a control panel that can
 * say so and offer to start it again.
 */

export interface LaunchSpec {
  command: string;
  args: string[];
  env: Record<string, string | undefined>;
}

/** The line the server prints once it is actually accepting connections. */
const LISTENING_LINE = /^\[ilearnassist\] listening on (\S+)$/;

/**
 * Read a bound address out of a server log line.
 *
 * Driving the handshake off a printed line rather than off `config.server.port` is what
 * makes `port: 0` work end to end: the OS picks the port, the server reports the one it
 * got, and the panel has nothing to guess and nothing to race. Any other line — including
 * Fastify's own "Server listening at …", which is logged before we are ready to trust it —
 * returns null.
 */
export function parseListeningLine(line: string): string | null {
  const match = LISTENING_LINE.exec(line.trim());
  return match?.[1] ?? null;
}

/** Loopback: reachable only from this machine. The default, and the safe one. */
export const LOOPBACK_HOST = "127.0.0.1";
/** Every interface: reachable from anything on the same network. */
export const ANY_INTERFACE_HOST = "0.0.0.0";

export interface BuildLaunchSpecInput {
  /** `process.execPath` — the Electron binary, run as Node. */
  electronExecPath: string;
  /** Absolute path of the bundled server entry point inside the app. */
  serverEntry: string;
  paths: AppPaths;
  /**
   * Bind address. Always set, including when it equals the config file's own default.
   *
   * That is deliberate, and it is the difference between a switch that is truthful and one
   * that is merely suggestive. If the loopback case were left to the config file, a user
   * who had hand-edited `server.host` there would have the panel report "not shared" while
   * the port was open to the network they are sitting on — a control whose stated state and
   * actual state can disagree is worse than no control. So the switch owns the bind address,
   * and the file it was seeded from describes everything else.
   */
  host: string;
  /**
   * The chosen data root — `ILA_DATA_DIR`, and required by the server.
   *
   * Passed on every launch rather than written into a config file, because it is the one
   * setting a user can change while the app is installed: the picker changes it, the server
   * restarts, and nothing on disk has to be rewritten for the change to take.
   *
   * Empty means nobody has chosen one yet, and the server will refuse to start with a
   * message naming the variable. The panel does not let it get that far — it asks first.
   */
  dataDir: string;
  /**
   * The secret the control panel shares with the server it spawned.
   *
   * Passed on every launch and never written anywhere, which is what makes the recovery route
   * it guards a path *this* process can take and nothing else can. See `ILA_PANEL_TOKEN` in
   * `apps/server/src/auth.ts` for why the panel is the only thing that may reset an
   * administrator's password.
   */
  panelToken: string;
  /** Defaults to `process.env`; injectable so tests can spawn a plain `node`. */
  baseEnv?: Record<string, string | undefined>;
}

export function buildLaunchSpec(input: BuildLaunchSpecInput): LaunchSpec {
  return {
    command: input.electronExecPath,
    args: [input.serverEntry],
    env: {
      ...serverChildEnv(input.paths, input.dataDir, input.baseEnv),
      // The built frontend, shipped in the bundle. The server serves it from the same
      // origin as the API, so the panel opens one URL and the app just works. The CLI does
      // not get it — it never serves a page.
      ILA_WEB_DIR: input.paths.webDir,
      ILA_HOST: input.host,
      ILA_PANEL_TOKEN: input.panelToken,
    },
  };
}

/**
 * The environment every child that runs as this panel's server runtime shares.
 *
 * Split out so the **administrator CLI** gets the same three things — Node mode, the project
 * root, the data root — without getting the two it does not need: `ILA_HOST`, which is a
 * listen decision the CLI never makes, and `ILA_PANEL_TOKEN`, whose whole argument is that it
 * is handed to *one* child, the long-lived server. Widening it to a second process would buy
 * nothing and widen the secret for no benefit.
 *
 * It deliberately carries `ILA_CONFIG_PATH`: the CLI resolves the data root through the same
 * `resolveDataRoot()` the server uses, and the overlay is where the packed app's config lives.
 */
export function serverChildEnv(
  paths: AppPaths,
  dataDir: string,
  baseEnv: Record<string, string | undefined> = process.env
): Record<string, string | undefined> {
  return {
    ...baseEnv,
    ELECTRON_RUN_AS_NODE: "1",
    // The server resolves `config/` against this, which is how the packed app ends up
    // reading the user's Application Support directory instead of its own read-only bundle.
    ILA_PROJECT_ROOT: paths.root,
    // ...and the user's data against this, which is a different directory on purpose. One
    // is the app's to replace, the other is the user's to keep.
    ILA_DATA_DIR: dataDir,
    // Points at the overlay the app seeds, not at whatever a checkout might have.
    ILA_CONFIG_PATH: paths.overlayFile,
  };
}

export interface BuildAdminSpecInput {
  electronExecPath: string;
  adminEntry: string;
  paths: AppPaths;
  dataDir: string;
  /** The CLI's own arguments, after the entry — `["status", "--json"]` and the like. */
  args?: string[];
  baseEnv?: Record<string, string | undefined>;
}

/**
 * A one-shot child that creates the first administrator or reports whether one exists.
 *
 * Same binary, same Node mode, same data root as the server; different lifetime and a smaller
 * environment (see `serverChildEnv`). It runs and exits, so the caller gets a result rather
 * than a process to supervise.
 */
export function buildAdminSpec(input: BuildAdminSpecInput): LaunchSpec {
  return {
    command: input.electronExecPath,
    args: [input.adminEntry, ...(input.args ?? [])],
    env: serverChildEnv(input.paths, input.dataDir, input.baseEnv),
  };
}

/** Where the bundled server entry lives, relative to a packed app's root. */
export function serverEntryFor(appRoot: string): string {
  return join(appRoot, "dist", "server", "index.mjs");
}

/** Where the bundled administrator CLI lives, beside the server entry. */
export function adminEntryFor(appRoot: string): string {
  return join(appRoot, "dist", "server", "cli.mjs");
}
