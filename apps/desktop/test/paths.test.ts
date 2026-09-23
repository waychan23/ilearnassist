import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  databaseIn,
  dataDirPromptAnswer,
  ensureDataDir,
  hasExistingData,
  resolveAppPaths,
  seedFirstRun,
  trayIconFile,
} from "../src/main/paths.js";

/**
 * The panel's own tree, and the one question it has to ask about the user's.
 *
 * Two properties matter. First-run setup is idempotent, because it runs on every launch and
 * the files it writes are the user's: a second run that overwrote `config.yaml` would
 * silently discard the API key someone typed into the Settings UI yesterday, a data-loss bug
 * no error message would announce. And `hasExistingData` must be able to tell a folder with
 * data in it from one without, because that is what the picker's warning is built on.
 */

let root: string;
let home: string;
let resourcesDir: string;
let template: string;

beforeEach(() => {
  const scratch = mkdtempSync(join(tmpdir(), "gl-desktop-paths-"));
  root = join(scratch, "userData");
  // A stand-in for the user's home directory, so `defaultDataDir` is asserted against a path
  // this test owns rather than against whatever `/Users/<whoever>` the suite happens to run as.
  home = join(scratch, "home");
  resourcesDir = join(scratch, "resources");
  template = join(resourcesDir, "config", "config.yaml");

  // The build script stages these; the test stands in for it.
  mkdirSync(join(resourcesDir, "config"), { recursive: true });
  writeFileSync(template, "providers: []\ndefaultModel: seeded\n", "utf8");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(resourcesDir, { recursive: true, force: true });
});

describe("resolveAppPaths", () => {
  it("keeps the app's own writable paths under the user data directory", () => {
    const paths = resolveAppPaths({ userDataDir: root, homeDir: home, resourcesDir });
    for (const value of [paths.configFile, paths.overlayFile, paths.root]) {
      expect(value.startsWith(root)).toBe(true);
    }
  });

  it("offers a data folder in the user's home, beside nothing of the app's", () => {
    // `~/ilearnassist`. Two properties at once: it is the home directory the caller named, and
    // it is nowhere near the application bundle — dragging the `.app` to the trash does not
    // take it with you, which is the whole reason it is not a path beside the binary.
    const paths = resolveAppPaths({ userDataDir: root, homeDir: home, resourcesDir });
    expect(paths.defaultDataDir).toBe(join(home, "ilearnassist"));
    expect(paths.defaultDataDir.startsWith(resourcesDir)).toBe(false);
    expect(paths.defaultDataDir.startsWith(root)).toBe(false);
  });

  it("keeps every read-only path under the app's resources", () => {
    const paths = resolveAppPaths({ userDataDir: root, homeDir: home, resourcesDir });
    expect(paths.webDir.startsWith(resourcesDir)).toBe(true);
    expect(paths.templateConfig.startsWith(resourcesDir)).toBe(true);
  });
});

describe("seedFirstRun", () => {
  it("creates the tree and plants the config on a first launch", () => {
    const paths = resolveAppPaths({ userDataDir: root, homeDir: home, resourcesDir });
    seedFirstRun(paths);

    expect(readFileSync(paths.configFile, "utf8")).toBe(readFileSync(template, "utf8"));
    expect(existsSync(paths.overlayFile)).toBe(true);
  });

  it("does not create a data folder", () => {
    // It used to. Making one at launch would leave an empty directory that looks exactly like
    // the data root the user was meant to pick — and a second, empty database if they picked it
    // by mistake. The offered folder is *proposed* until somebody presses the button, which is
    // the whole difference between a default and defaulting.
    const paths = resolveAppPaths({ userDataDir: root, homeDir: home, resourcesDir });
    seedFirstRun(paths);
    expect(existsSync(paths.defaultDataDir)).toBe(false);
  });

  it("seeds a fixed port, so the address stays the same on every launch", () => {
    const paths = resolveAppPaths({ userDataDir: root, homeDir: home, resourcesDir });
    seedFirstRun(paths);
    expect(readFileSync(paths.overlayFile, "utf8")).toMatch(/^\s*port:\s*10471\s*$/m);
  });

  it("upgrades an overlay that is still exactly the old OS-assigned-port template", () => {
    const paths = resolveAppPaths({ userDataDir: root, homeDir: home, resourcesDir });
    seedFirstRun(paths);
    // Put the old template back, byte for byte — the state an older build left behind.
    const oldTemplate = `# Written by the ilearnassist desktop app.
#
# Everything here overrides config.yaml. Delete this file to fall back to the defaults.
#
# port: 0 lets the operating system choose a free port on every launch, so the app can
# never fail to start because something else is already using the configured one. Set a
# fixed port here if you would rather always reach the app at the same address.
server:
  port: 0
`;
    writeFileSync(paths.overlayFile, oldTemplate, "utf8");

    seedFirstRun(paths);

    expect(readFileSync(paths.overlayFile, "utf8")).toMatch(/^\s*port:\s*10471\s*$/m);
  });

  it("does not upgrade an old overlay the user has changed at all", () => {
    // Even an added comment: anything other than the exact template is the user's decision.
    const paths = resolveAppPaths({ userDataDir: root, homeDir: home, resourcesDir });
    seedFirstRun(paths);
    const edited = readFileSync(paths.overlayFile, "utf8").replace("port: 10471", "port: 4567");

    writeFileSync(paths.overlayFile, edited, "utf8");
    seedFirstRun(paths);

    expect(readFileSync(paths.overlayFile, "utf8")).toBe(edited);
  });

  it("never overwrites an existing config", () => {
    const paths = resolveAppPaths({ userDataDir: root, homeDir: home, resourcesDir });
    seedFirstRun(paths);
    writeFileSync(paths.configFile, "providers: [edited]\n", "utf8");

    seedFirstRun(paths);

    expect(readFileSync(paths.configFile, "utf8")).toBe("providers: [edited]\n");
  });

  it("never overwrites an overlay the user has edited", () => {
    const paths = resolveAppPaths({ userDataDir: root, homeDir: home, resourcesDir });
    seedFirstRun(paths);
    writeFileSync(paths.overlayFile, "server:\n  port: 10471\n", "utf8");

    seedFirstRun(paths);

    expect(readFileSync(paths.overlayFile, "utf8")).toBe("server:\n  port: 10471\n");
  });

  it("names the missing template rather than starting a server with no providers", () => {
    rmSync(template);
    const paths = resolveAppPaths({ userDataDir: root, homeDir: home, resourcesDir });

    // A boot with no providers dies in `validateConfig` with "No providers configured",
    // which describes the symptom and not the cause. Failing here says which file is gone.
    expect(() => seedFirstRun(paths)).toThrow(/Seed config missing/);
  });
});

describe("ensureDataDir", () => {
  it("creates the folder, and is not an error the second time", () => {
    // Pressing the button twice, or on a folder that already exists, is ordinary — an existing
    // data folder is somebody coming back to it, not a conflict.
    const paths = resolveAppPaths({ userDataDir: root, homeDir: home, resourcesDir });
    ensureDataDir(paths.defaultDataDir);
    expect(existsSync(paths.defaultDataDir)).toBe(true);

    expect(() => ensureDataDir(paths.defaultDataDir)).not.toThrow();
  });

  it("makes the parents it needs", () => {
    // The folder is directly in the user's home, so there is normally nothing above it to make.
    // This pins the recursive flag anyway, because the alternative is an ENOENT on a machine
    // whose home was removed or renamed underneath a running app.
    ensureDataDir(join(home, "deep", "ilearnassist"));
    expect(existsSync(join(home, "deep", "ilearnassist"))).toBe(true);
  });

  it("leaves the folder empty, so the server's own boot fills it", () => {
    // The panel makes the root and nothing under it: `createDb` makes the database's directory
    // and `ensureUserLayout` the running user's, both recursively. A second copy of that layout
    // here is how the two would drift.
    const paths = resolveAppPaths({ userDataDir: root, homeDir: home, resourcesDir });
    ensureDataDir(paths.defaultDataDir);
    expect(hasExistingData(paths.defaultDataDir)).toBe(false);
  });
});

describe("dataDirPromptAnswer", () => {
  it("reads the three buttons in the order main passes them", () => {
    // The order is a contract between `main.ts` and this function, and the two live apart — the
    // dialog is Electron plumbing with no tests, the decode is here because it has an `else` that
    // has to be right.
    expect(dataDirPromptAnswer(0)).toBe("default");
    expect(dataDirPromptAnswer(1)).toBe("choose");
    expect(dataDirPromptAnswer(2)).toBe("cancel");
  });

  it("treats anything unrecognised as a cancel", () => {
    // The safe direction, and the only defensible one: the alternatives are reading a dismissed or
    // unexpected answer as consent to create a folder in the user's home, or as consent to open a
    // second dialog on top of the one that just closed.
    for (const response of [-1, 3, 99, Number.NaN]) {
      expect(dataDirPromptAnswer(response)).toBe("cancel");
    }
  });
});

describe("hasExistingData", () => {
  it("is false for a directory that is not there, and for one that is empty", () => {
    // The two cases the folder picker cannot tell apart, and the reason it asks out loud:
    // both mean "a new, empty database will be created here".
    expect(hasExistingData(join(root, "nowhere"))).toBe(false);
    mkdirSync(join(root, "empty"), { recursive: true });
    expect(hasExistingData(join(root, "empty"))).toBe(false);
  });

  it("is false for a directory with unrelated things in it", () => {
    mkdirSync(join(root, "documents"), { recursive: true });
    writeFileSync(join(root, "documents", "notes.md"), "hi");
    expect(hasExistingData(join(root, "documents"))).toBe(false);
  });

  it("is true once the database is where the server would put it", () => {
    const dataRoot = join(root, "data");
    mkdirSync(join(dataRoot, "db", "sqlite"), { recursive: true });
    writeFileSync(databaseIn(dataRoot), "");
    expect(hasExistingData(dataRoot)).toBe(true);
  });

  it("looks for the database exactly where the server keeps it", () => {
    // Not "some file that looks like data": the marker has to be the same path the server
    // opens, or the picker would warn about a folder the server reads happily, or stay quiet
    // about one it does not.
    expect(databaseIn("/data")).toBe(join("/data", "db", "sqlite", "ilearnassist.sqlite"));
  });
});

describe("the tray icon", () => {
  it("gives macOS the template image, and everyone else the coloured one", () => {
    // macOS recolours a template image for a dark menu bar; Windows and Linux have no such
    // convention, so that file there is a black glyph on a dark taskbar. Two files, and the
    // wrong one is invisible rather than broken — which is why it is a tested function.
    expect(trayIconFile("darwin")).toBe("trayTemplate.png");
    for (const platform of ["win32", "linux"] as const) {
      expect(trayIconFile(platform), platform).toBe("tray.png");
    }
  });

  it("names files that are actually committed, with their @2x siblings", () => {
    // The assertion that matters, and the reason this is not just a switch: `main.ts` reads
    // the file out of the *packaged bundle*, where a name that does not exist is an empty
    // `nativeImage` and no tray item at all. `build.mjs` stages whatever is in `assets/`, so
    // checking the source assets is checking what ships.
    const assets = new URL("../assets/", import.meta.url);
    for (const platform of ["darwin", "win32", "linux"] as const) {
      const file = trayIconFile(platform);
      for (const name of [file, file.replace(/\.png$/, "@2x.png")]) {
        expect(existsSync(new URL(name, assets)), `${name} (${platform})`).toBe(true);
      }
    }
  });
});
