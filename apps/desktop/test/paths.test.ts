import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  databaseIn,
  hasExistingData,
  resolveAppPaths,
  seedFirstRun,
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
let resourcesDir: string;
let template: string;

beforeEach(() => {
  const scratch = mkdtempSync(join(tmpdir(), "gl-desktop-paths-"));
  root = join(scratch, "userData");
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
    const paths = resolveAppPaths({ userDataDir: root, resourcesDir });
    for (const value of [paths.configFile, paths.overlayFile, paths.suggestedDataDir]) {
      expect(value.startsWith(root)).toBe(true);
    }
  });

  it("suggests a data folder outside the app bundle", () => {
    // Dragging the `.app` to the trash does not take `~/Library/Application Support` with it,
    // which is the whole reason the suggestion lives there rather than beside the binary.
    const paths = resolveAppPaths({ userDataDir: root, resourcesDir });
    expect(paths.suggestedDataDir.startsWith(resourcesDir)).toBe(false);
  });

  it("keeps every read-only path under the app's resources", () => {
    const paths = resolveAppPaths({ userDataDir: root, resourcesDir });
    expect(paths.webDir.startsWith(resourcesDir)).toBe(true);
    expect(paths.templateConfig.startsWith(resourcesDir)).toBe(true);
  });
});

describe("seedFirstRun", () => {
  it("creates the tree and plants the config on a first launch", () => {
    const paths = resolveAppPaths({ userDataDir: root, resourcesDir });
    seedFirstRun(paths);

    expect(readFileSync(paths.configFile, "utf8")).toBe(readFileSync(template, "utf8"));
    expect(existsSync(paths.overlayFile)).toBe(true);
  });

  it("does not create a data folder", () => {
    // It used to. Now that the root is the user's to choose, making one for them would leave
    // an empty directory that looks exactly like the data root they were meant to pick — and
    // a second, empty database if they picked it by mistake.
    const paths = resolveAppPaths({ userDataDir: root, resourcesDir });
    seedFirstRun(paths);
    expect(existsSync(paths.suggestedDataDir)).toBe(false);
  });

  it("picks an OS-assigned port, so a busy port cannot stop the app from starting", () => {
    const paths = resolveAppPaths({ userDataDir: root, resourcesDir });
    seedFirstRun(paths);
    expect(readFileSync(paths.overlayFile, "utf8")).toMatch(/^\s*port:\s*0\s*$/m);
  });

  it("never overwrites an existing config", () => {
    const paths = resolveAppPaths({ userDataDir: root, resourcesDir });
    seedFirstRun(paths);
    writeFileSync(paths.configFile, "providers: [edited]\n", "utf8");

    seedFirstRun(paths);

    expect(readFileSync(paths.configFile, "utf8")).toBe("providers: [edited]\n");
  });

  it("never overwrites an overlay the user has edited", () => {
    const paths = resolveAppPaths({ userDataDir: root, resourcesDir });
    seedFirstRun(paths);
    writeFileSync(paths.overlayFile, "server:\n  port: 3720\n", "utf8");

    seedFirstRun(paths);

    expect(readFileSync(paths.overlayFile, "utf8")).toBe("server:\n  port: 3720\n");
  });

  it("names the missing template rather than starting a server with no providers", () => {
    rmSync(template);
    const paths = resolveAppPaths({ userDataDir: root, resourcesDir });

    // A boot with no providers dies in `validateConfig` with "No providers configured",
    // which describes the symptom and not the cause. Failing here says which file is gone.
    expect(() => seedFirstRun(paths)).toThrow(/Seed config missing/);
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
