import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, readSettings, writeSettings } from "../src/main/settings.js";

/**
 * The panel's preferences, and their failure modes.
 *
 * The bar is that no state of this file can stop the app from opening. It holds one boolean
 * whose worst-case default is "LAN sharing off", which is the safe direction — so every
 * unreadable input resolves there rather than raising into `app.whenReady()`, where it would
 * present as a control panel that never appears.
 */

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gl-desktop-settings-"));
  file = join(dir, "nested", "desktop.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readSettings", () => {
  it("gives the safe default when there is no file", () => {
    expect(readSettings(file)).toEqual(DEFAULT_SETTINGS);
    expect(readSettings(file).sharedOnLan).toBe(false);
  });

  it("round-trips what was written, creating the directory", () => {
    writeSettings(file, { sharedOnLan: true });
    expect(readSettings(file)).toEqual({ sharedOnLan: true });
    // The file is the user's too, so it is written to be read.
    expect(readFileSync(file, "utf8")).toContain('"sharedOnLan": true');
  });

  it("survives a file truncated by a crash mid-write", () => {
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(file, '{"sharedOnLan": tr', "utf8");
    expect(readSettings(file)).toEqual(DEFAULT_SETTINGS);
  });

  it("survives a hand-edit that is valid JSON but not the right shape", () => {
    mkdirSync(join(dir, "nested"), { recursive: true });
    for (const content of ['"a string"', "[]", "null", "42"]) {
      writeFileSync(file, content, "utf8");
      expect(readSettings(file), content).toEqual(DEFAULT_SETTINGS);
    }
  });

  it("ignores a value of the wrong type rather than coercing it", () => {
    // `"false"` is truthy. Coercing it would turn a hand-edit into LAN sharing the user
    // believed they had switched off.
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(file, '{"sharedOnLan": "false"}', "utf8");
    expect(readSettings(file).sharedOnLan).toBe(false);
  });

  it("keeps what it understands when a later key is unknown", () => {
    // A file written by a newer build must not read as "everything off" after a downgrade.
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(file, '{"sharedOnLan": true, "somethingNew": 1}', "utf8");
    expect(readSettings(file).sharedOnLan).toBe(true);
  });
});
