import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAppPaths, seedFirstRun } from "../src/main/paths.js";

/**
 * First-run setup, exercised against a real temp directory.
 *
 * The property that matters is idempotence: this runs on every launch, and the files it
 * writes are the user's. A second run that overwrote `config.yaml` would silently discard
 * the API key someone typed into the Settings UI on yesterday's launch — a data-loss bug
 * that no error message would announce.
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
  it("keeps every writable path under the user data directory", () => {
    const paths = resolveAppPaths({ userDataDir: root, resourcesDir });
    for (const value of [paths.configFile, paths.overlayFile, paths.dataDir]) {
      expect(value.startsWith(root)).toBe(true);
    }
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
    expect(existsSync(paths.dataDir)).toBe(true);
    expect(existsSync(paths.overlayFile)).toBe(true);
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
