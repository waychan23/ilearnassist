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
const LISTENING_LINE = /^\[guided-learning\] listening on (\S+)$/;

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

export interface BuildLaunchSpecInput {
  /** `process.execPath` — the Electron binary, run as Node. */
  electronExecPath: string;
  /** Absolute path of the bundled server entry point inside the app. */
  serverEntry: string;
  paths: AppPaths;
  /** Defaults to `process.env`; injectable so tests can spawn a plain `node`. */
  baseEnv?: Record<string, string | undefined>;
}

export function buildLaunchSpec(input: BuildLaunchSpecInput): LaunchSpec {
  return {
    command: input.electronExecPath,
    args: [input.serverEntry],
    env: {
      ...(input.baseEnv ?? process.env),
      ELECTRON_RUN_AS_NODE: "1",
      // The server resolves config/, data/ and workspaces/ against this, which is how the
      // packed app ends up writing to the user's Application Support directory instead of
      // into its own read-only bundle.
      GL_PROJECT_ROOT: input.paths.root,
      // Points at the overlay the app seeds, not at whatever a checkout might have.
      GL_CONFIG_PATH: input.paths.overlayFile,
      // The built frontend, shipped in the bundle. The server serves it from the same
      // origin as the API, so the panel opens one URL and the app just works.
      GL_WEB_DIR: input.paths.webDir,
    },
  };
}

/** Where the bundled server entry lives, relative to a packed app's root. */
export function serverEntryFor(appRoot: string): string {
  return join(appRoot, "dist", "server", "index.mjs");
}
