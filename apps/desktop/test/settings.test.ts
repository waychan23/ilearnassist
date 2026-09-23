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
    writeSettings(file, {
      sharedOnLan: true,
      port: 4567,
      dataDir: "/Users/someone/My Notes",
      locale: "",
      updateCheck: null,
    });
    expect(readSettings(file)).toEqual({
      sharedOnLan: true,
      port: 4567,
      dataDir: "/Users/someone/My Notes",
      locale: "",
      updateCheck: null,
    });
    // The file is the user's too, so it is written to be read.
    expect(readFileSync(file, "utf8")).toContain('"sharedOnLan": true');
  });

  it("keeps a chosen data folder verbatim, spaces and all", () => {
    // Not trimmed on the way out: a path may legitimately end in a space, and resolving it is
    // the launcher's job rather than this file's.
    writeSettings(file, {
      sharedOnLan: false,
      port: DEFAULT_SETTINGS.port,
      dataDir: "/Users/someone/My Notes",
      locale: "",
      updateCheck: null,
    });
    expect(readSettings(file).dataDir).toBe("/Users/someone/My Notes");
  });

  it("treats a missing, blank or non-string data folder as not chosen yet", () => {
    // Never a fallback to some other directory. Everywhere else in this file a bad value
    // becomes the safe default; here the safe default is to *ask*, because silently pointing
    // the app at a folder that is not the user's is the one failure this setting can cause
    // that loses work.
    mkdirSync(join(dir, "nested"), { recursive: true });
    for (const content of [
      '{"sharedOnLan":false}',
      '{"dataDir":""}',
      '{"dataDir":"   "}',
      '{"dataDir":42}',
      '{"dataDir":null}',
    ]) {
      writeFileSync(file, content, "utf8");
      expect(readSettings(file).dataDir).toBe("");
    }
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

  it("keeps a chosen port verbatim", () => {
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(file, '{"port": 4567}', "utf8");
    expect(readSettings(file).port).toBe(4567);
  });

  it("falls back to the fixed default for a missing, bad or out-of-range port", () => {
    // Never coerced, and never 0: an unusable stored port becomes the fixed default rather
    // than an OS-assigned port on the next launch.
    mkdirSync(join(dir, "nested"), { recursive: true });
    for (const content of [
      '{"sharedOnLan":false}',
      '{"port":"4567"}',
      '{"port":3.5}',
      '{"port":0}',
      '{"port":70000}',
      '{"port":null}',
    ]) {
      writeFileSync(file, content, "utf8");
      expect(readSettings(file).port, content).toBe(DEFAULT_SETTINGS.port);
    }
  });

  it("keeps what it understands when a later key is unknown", () => {
    // A file written by a newer build must not read as "everything off" after a downgrade.
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(file, '{"sharedOnLan": true, "somethingNew": 1}', "utf8");
    expect(readSettings(file).sharedOnLan).toBe(true);
  });
});

describe("the cached update check", () => {
  /*
   * One cached fact, and the rule that matters is which failures *replace* it: a check that could
   * not answer must leave the previous answer alone, or a flaky network would look like a
   * confirmed up-to-date app and the notice would vanish without a release having happened.
   */
  it("keeps a complete one", () => {
    const cache = {
      latestVersion: "0.2.0",
      url: "https://example.invalid/r",
      checkedAt: "2026-09-19T00:00:00.000Z",
    };
    writeSettings(file, { ...DEFAULT_SETTINGS, updateCheck: cache });
    expect(readSettings(file).updateCheck).toEqual(cache);
  });

  it("throws away a partial one rather than half-reading it", () => {
    // A cache with no version is not half-usable: the panel would show a notice with nothing to
    // name. Field-by-field narrowing would keep `url` and lose `latestVersion`, which is the state
    // that renders as a broken row.
    writeSettings(file, DEFAULT_SETTINGS);
    writeFileSync(file, JSON.stringify({ updateCheck: { latestVersion: "0.2.0", url: "x" } }), "utf8");
    expect(readSettings(file).updateCheck).toBeNull();
  });

  it("reads anything that is not an object as never checked", () => {
    // Through `writeSettings` once, so the directory exists: the writes below are hand-edited
    // JSON, which is the thing being tested, and a missing directory would be a different failure.
    writeSettings(file, DEFAULT_SETTINGS);
    for (const junk of ["nope", 42, [], true]) {
      writeFileSync(file, JSON.stringify({ updateCheck: junk }), "utf8");
      expect(readSettings(file).updateCheck, JSON.stringify(junk)).toBeNull();
    }
  });
});
