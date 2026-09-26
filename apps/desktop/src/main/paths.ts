import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
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
   * The folder the panel offers when nobody has chosen one yet, and where the picker opens.
   *
   * `~/ilearnassist`, in the user's home directory. It is offered rather than assumed: the
   * data root is still the *user's* to choose and is recorded in `desktop.json` — see
   * `DesktopSettings.dataDir` — and this is the answer that one click takes instead of
   * navigating a file dialog.
   *
   * It is deliberately **outside the application bundle**, which is the whole reason it is not
   * a path beside the binary: dragging the `.app` to the trash does not take it with you.
   */
  defaultDataDir: string;
  /** The built frontend shipped inside the app bundle. Read-only. */
  webDir: string;
  /** The `config.yaml` template shipped inside the app bundle. Read-only. */
  templateConfig: string;
}

/**
 * Which of the two staged tray icons this platform wants.
 *
 * **Two files, because the same asset cannot work on all three.** macOS gets a *template*
 * image — black with alpha, and the `Template` filename suffix is what tells the system to
 * recolour it for a dark menu bar. Windows and Linux have no such convention, so that file
 * there is a black glyph on a dark taskbar: present, drawn, and invisible in use. They get the
 * coloured one.
 *
 * It lives here rather than in `main.ts` because `main.ts` needs a display to run at all and
 * this is a pure question with a wrong answer that only shows up on Windows — the file the
 * packaged bundle must contain, asserted by `paths.test.ts` against the files that are
 * actually committed.
 */
export function trayIconFile(platform: NodeJS.Platform): string {
  return platform === "darwin" ? "trayTemplate.png" : "tray.png";
}

export interface ResolveAppPathsInput {
  /** `app.getPath("userData")` — `~/Library/Application Support/ilearnassist` on macOS. */
  userDataDir: string;
  /** `app.getPath("home")` — where `defaultDataDir` goes. */
  homeDir: string;
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
    defaultDataDir: join(input.homeDir, "ilearnassist"),
    webDir: join(input.resourcesDir, "web"),
    templateConfig: join(input.resourcesDir, "config", "config.yaml"),
  };
}

/**
 * Make the folder the panel offered, so a data root exists to hand the server.
 *
 * The one place this app creates a data directory, and it is a *user's click* rather than a
 * launch side effect — which is why `seedFirstRun` still creates none (see its comment) and why
 * the requirement is still "chosen, never defaulted": the server is handed a path a human said
 * yes to, and it goes on refusing without one.
 *
 * The caller passes `paths.defaultDataDir` and nothing else, so there is no argument here for a
 * renderer to steer — the shape of the call is the guard. Only the root is made; the server's own
 * boot builds the rest (`createDb` makes the database's directory, `ensureUserLayout` the
 * running user's), both recursively.
 */
export function ensureDataDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/**
 * What the first-run prompt came back with, from the button index a native dialog answers with.
 *
 * Here rather than in `main.ts` for this module's reason: main has no tests — it is Electron
 * plumbing, kept thin enough to read — while this is a decision with three outcomes and an
 * `else` that has to be right. The index order it decodes is the order `main.ts` passes its
 * buttons in, and the two live side by side for that reason.
 *
 * **Anything unrecognised is a cancel**, which is the safe direction: the alternatives would be
 * treating a dismissed or unexpected answer as consent to create a folder, or as consent to open
 * another dialog on top of the one that just closed.
 */
export type DataDirPromptAnswer = "default" | "choose" | "cancel";

export function dataDirPromptAnswer(response: number): DataDirPromptAnswer {
  if (response === 0) return "default";
  if (response === 1) return "choose";
  return "cancel";
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
 * The port is **fixed** at 10471, matching `config.yaml`: the address the app is reached at
 * must not move between launches, or the browser's bookmarks and saved passwords stop
 * working. If that port is taken the server refuses and says so — it never picks another.
 *
 * This is a `config.local.yaml`, i.e. exactly the file `ILA_CONFIG_PATH` exists to relocate,
 * so it composes with the base config rather than forking it. It is written once: a user who
 * edits it keeps the edit. The control panel also passes its own port (`ILA_PORT`), which
 * overrides this one.
 */
const OVERLAY = `# Written by the ilearnassist desktop app.
#
# Everything here overrides config.yaml. Delete this file to fall back to the defaults.
#
# The port is fixed at 10471 so the address stays the same on every launch. Change it in
# the control panel, or edit it here; the panel never overwrites a change you make.
server:
  port: 10471
`;

/**
 * The overlay older builds wrote, with an OS-assigned port.
 *
 * Kept so an install that still holds exactly that file is upgraded to the fixed-port
 * overlay. Anything the user changed — even a comment — means it is left alone: the exact
 * match is the whole of the migration's safety.
 */
const OLD_OVERLAY = `# Written by the ilearnassist desktop app.
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
 * to pick — and a second, empty database if they picked it by mistake. The one place this app
 * *does* create one is `ensureDataDir`, and it runs because somebody pressed a button.
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
    return;
  }

  // Upgrade an overlay that is still exactly the old OS-assigned-port template.
  if (readFileSync(paths.overlayFile, "utf8") === OLD_OVERLAY) {
    writeFileSync(paths.overlayFile, OVERLAY, "utf8");
  }
}

/** The directory a `config.local.yaml` sits in, for the "show in Finder" action. */
export function parentOf(path: string): string {
  return dirname(path);
}
