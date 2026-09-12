import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Where the packaged app keeps its own state, and how it gets there on first launch.
 *
 * A checkout keeps `config/` next to the source, which is fine for a developer and
 * impossible for a `.dmg`: the app bundle is read-only, and it is replaced wholesale on every
 * update. So the packed build keeps the code in the bundle and the config under the OS's
 * per-user data directory, and tells the server where to look with `ILA_PROJECT_ROOT`.
 *
 * The *user's* data — the database, their workspaces, their uploads — is not here at all.
 * It lives wherever they chose, recorded in `desktop.json` and handed to the server as
 * `ILA_DATA_DIR`. Splitting the two is what makes "back up my work" a copy of one directory
 * and "reinstall the app" a replacement of another.
 *
 * Keeping the paths in one module (rather than inlining `join(userData, …)` at each use
 * site) is what makes it testable without an Electron runtime: every path below is derived
 * from two strings the caller supplies.
 */

export interface AppPaths {
  /** `ILA_PROJECT_ROOT` — holds `config/` and `.env`. Per-user, writable. */
  root: string;
  configDir: string;
  /** The seeded `config.yaml`. Written once, then the user's. */
  configFile: string;
  /** `ILA_CONFIG_PATH` — the app's own overlay, merged over `configFile` on every boot. */
  overlayFile: string;
  /**
   * Where the file picker opens, and nothing more.
   *
   * The data root itself is the *user's* to choose and lives in `desktop.json` — see
   * `DesktopSettings.dataDir`. This is only the sensible place to start looking, and it is
   * under the app's own per-user directory because that is out of the application bundle:
   * dragging the `.app` to the trash does not take `~/Library/Application Support` with it.
   */
  suggestedDataDir: string;
  /** The built frontend shipped inside the app bundle. Read-only. */
  webDir: string;
  /** The `config.yaml` template shipped inside the app bundle. Read-only. */
  templateConfig: string;
}

export interface ResolveAppPathsInput {
  /** `app.getPath("userData")` — `~/Library/Application Support/ilearnassist` on macOS. */
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
    suggestedDataDir: join(input.userDataDir, "data"),
    webDir: join(input.resourcesDir, "web"),
    templateConfig: join(input.resourcesDir, "config", "config.yaml"),
  };
}

/** The database file a chosen data root would hold. The one marker of "there is data here". */
export function databaseIn(dataRoot: string): string {
  return join(dataRoot, "db", "sqlite", "ilearnassist.sqlite");
}

/**
 * Whether a directory already holds this app's data.
 *
 * The question the file picker has to answer before it accepts a path, because an empty
 * directory and a corrupted one look identical from the outside and one of them silently
 * starts a second, empty database. The panel asks this to decide whether it needs to say so
 * out loud; it never refuses.
 */
export function hasExistingData(dataRoot: string): boolean {
  return existsSync(databaseIn(dataRoot));
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
 * This is a `config.local.yaml`, i.e. exactly the file `ILA_CONFIG_PATH` exists to relocate,
 * so it composes with the base config rather than forking it. It is written once: a user who
 * wants a stable port edits it (or deletes the line) and the app never overwrites it again.
 */
const OVERLAY = `# Written by the ilearnassist desktop app.
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
 * Create the app's own tree and plant the seed config, once.
 *
 * Idempotent, and deliberately non-destructive: an existing `config.yaml` or overlay is
 * never rewritten. That is the same contract `config.yaml` already has in a checkout — it
 * is bootstrap and seed data, and the Settings UI owns the database afterwards — so a user
 * who edits either file keeps their edit across updates.
 *
 * **Nothing here creates a data directory.** It used to create `<userData>/data` as the
 * server's default; now that the root is the user's to choose, making a folder for them
 * would produce an empty directory that looks exactly like the data root they were supposed
 * to pick — and a second, empty database if they picked it by mistake.
 *
 * Throws if the template is missing, because the alternative is a server that boots with no
 * providers and dies with "No providers configured", which names the symptom and not the
 * cause.
 */
export function seedFirstRun(paths: AppPaths): void {
  mkdirSync(paths.configDir, { recursive: true });

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
