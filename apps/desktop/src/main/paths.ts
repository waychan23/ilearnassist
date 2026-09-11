import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Where the packaged app keeps everything, and how it gets there on first launch.
 *
 * A checkout keeps `config/`, `data/` and `workspaces/` next to the source, which is fine
 * for a developer and impossible for a `.dmg`: the app bundle is read-only, and it is
 * replaced wholesale on every update. So the packed build keeps the code in the bundle and
 * all mutable state under the OS's per-user data directory, and tells the server where to
 * look with `GL_PROJECT_ROOT`.
 *
 * Keeping the split in one module (rather than inlining `join(userData, …)` at each use
 * site) is what makes it testable without an Electron runtime: every path below is derived
 * from two strings the caller supplies.
 */

export interface AppPaths {
  /** `GL_PROJECT_ROOT` — holds `config/`, `data/` and `workspaces/`. Per-user, writable. */
  root: string;
  configDir: string;
  /** The seeded `config.yaml`. Written once, then the user's. */
  configFile: string;
  /** `GL_CONFIG_PATH` — the app's own overlay, merged over `configFile` on every boot. */
  overlayFile: string;
  dataDir: string;
  /** The built frontend shipped inside the app bundle. Read-only. */
  webDir: string;
  /** The `config.yaml` template shipped inside the app bundle. Read-only. */
  templateConfig: string;
}

export interface ResolveAppPathsInput {
  /** `app.getPath("userData")` — `~/Library/Application Support/guided-learning` on macOS. */
  userDataDir: string;
  /** `process.resourcesPath` packed; a directory under `apps/desktop` when running unpacked. */
  resourcesDir: string;
}

export function resolveAppPaths(input: ResolveAppPathsInput): AppPaths {
  const configDir = join(input.userDataDir, "config");
  return {
    root: input.userDataDir,
    configDir,
    configFile: join(configDir, "config.yaml"),
    overlayFile: join(configDir, "config.local.yaml"),
    dataDir: join(input.userDataDir, "data"),
    webDir: join(input.resourcesDir, "web"),
    templateConfig: join(input.resourcesDir, "config", "config.yaml"),
  };
}

/**
 * The overlay the app writes for itself.
 *
 * `port: 0` asks the operating system for a free port instead of claiming 3720. A fixed
 * port is the wrong default for a desktop app: it turns "another copy is already running"
 * or "something else likes 3720" into a failed launch with a bind error a non-technical
 * user cannot act on. With an OS-assigned port that cannot happen — and the server prints
 * the address it actually bound, which is what the panel opens.
 *
 * This is a `config.local.yaml`, i.e. exactly the file `GL_CONFIG_PATH` exists to relocate,
 * so it composes with the base config rather than forking it. It is written once: a user who
 * wants a stable port edits it (or deletes the line) and the app never overwrites it again.
 */
const OVERLAY = `# Written by the guided-learning desktop app.
#
# Everything here overrides config.yaml. Delete this file to fall back to the defaults.
#
# port: 0 lets the operating system choose a free port on every launch, so the app can
# never fail to start because something else is already using the configured one. Set a
# fixed port here if you would rather always reach the app at the same address.
server:
  port: 0
`;

/**
 * Create the per-user tree and plant the seed config, once.
 *
 * Idempotent, and deliberately non-destructive: an existing `config.yaml` or overlay is
 * never rewritten. That is the same contract `config.yaml` already has in a checkout — it
 * is bootstrap and seed data, and the Settings UI owns the database afterwards — so a user
 * who edits either file keeps their edit across updates.
 *
 * Throws if the template is missing, because the alternative is a server that boots with no
 * providers and dies with "No providers configured", which names the symptom and not the
 * cause.
 */
export function seedFirstRun(paths: AppPaths): void {
  mkdirSync(paths.configDir, { recursive: true });
  mkdirSync(paths.dataDir, { recursive: true });

  if (!existsSync(paths.configFile)) {
    if (!existsSync(paths.templateConfig)) {
      throw new Error(`Seed config missing from the app bundle: ${paths.templateConfig}`);
    }
    copyFileSync(paths.templateConfig, paths.configFile);
  }

  if (!existsSync(paths.overlayFile)) {
    writeFileSync(paths.overlayFile, OVERLAY, "utf8");
  }
}

/** The directory a `config.local.yaml` sits in, for the "show in Finder" action. */
export function parentOf(path: string): string {
  return dirname(path);
}
