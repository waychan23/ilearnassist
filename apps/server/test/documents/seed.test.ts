import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withDefaults } from "../../src/config.js";
import {
  createDb,
  readDocumentParsing,
  seedDocumentParsersFromConfig,
  SETTING_DOCUMENT_DEFAULT_PARSER,
  SETTING_DOCUMENT_POLICY,
  type AppDb,
} from "../../src/db.js";

/**
 * Seeding document parsers from `config.yaml`, and the parsing policy.
 *
 * The interesting property is what happens on the *second* boot: parsers cannot use the
 * "table is empty" signal that LLM providers use, because running with zero cloud parsers
 * is a legitimate configuration. Getting this wrong resurrects entries the user deleted.
 */

let dir: string;
let db: AppDb;

const seed = {
  parsers: [
    { id: "docling", name: "Docling", kind: "sync" as const, baseURL: "http://127.0.0.1:5001" },
    { id: "mineru", name: "MinerU", kind: "mineru" as const, baseURL: "https://mineru.net/api/v4" },
  ],
  parsing: { localEnabled: true, policy: "local-first" as const, fallbackEnabled: true },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gl-seed-"));
  db = createDb(join(dir, "test.sqlite"));
});

afterEach(() => {
  db.raw.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("seedDocumentParsersFromConfig", () => {
  it("copies the configured parsers in on first boot", () => {
    expect(seedDocumentParsersFromConfig(db, seed)).toBe(true);

    const parsers = db.listDocumentParsers();
    expect(parsers.map((p) => p.id)).toEqual(["docling", "mineru"]);
    expect(parsers[0]!.enabled).toBe(true);
    expect(parsers[1]!.kind).toBe("mineru");
  });

  it("does not overwrite what the UI saved on a later boot", () => {
    seedDocumentParsersFromConfig(db, seed);
    db.updateDocumentParser("docling", { name: "Renamed in the UI", enabled: false });

    expect(seedDocumentParsersFromConfig(db, seed)).toBe(false);
    const docling = db.getDocumentParser("docling")!;
    expect(docling.name).toBe("Renamed in the UI");
    expect(docling.enabled).toBe(false);
  });

  it("does not resurrect parsers the user deleted", () => {
    // The whole reason for a seeded-marker setting rather than an emptiness check.
    seedDocumentParsersFromConfig(db, seed);
    db.deleteDocumentParser("docling");
    db.deleteDocumentParser("mineru");
    expect(db.listDocumentParsers()).toEqual([]);

    seedDocumentParsersFromConfig(db, seed);
    expect(db.listDocumentParsers()).toEqual([]);
  });

  it("still backfills policy settings a later config file adds", () => {
    // A user who already had parsers seeded, then adds a `documentParsing:` block, should
    // see it take effect without resetting the database.
    seedDocumentParsersFromConfig(db, seed);
    db.raw.prepare("DELETE FROM app_settings WHERE key = ?").run(SETTING_DOCUMENT_POLICY);

    seedDocumentParsersFromConfig(db, {
      parsers: seed.parsers,
      parsing: { ...seed.parsing, policy: "cloud-only" },
    });
    expect(db.getSetting(SETTING_DOCUMENT_POLICY)).toBe("cloud-only");
  });

  it("seeds a defaultParserId only when config names one", () => {
    seedDocumentParsersFromConfig(db, seed);
    expect(db.getSetting(SETTING_DOCUMENT_DEFAULT_PARSER)).toBeUndefined();

    db.raw.prepare("DELETE FROM document_parsers").run();
    db.raw.prepare("DELETE FROM app_settings WHERE key = ?").run("documentParsing.seeded");
    seedDocumentParsersFromConfig(db, {
      parsers: seed.parsers,
      parsing: { ...seed.parsing, defaultParserId: "mineru" },
    });
    expect(db.getSetting(SETTING_DOCUMENT_DEFAULT_PARSER)).toBe("mineru");
  });
});

describe("readDocumentParsing", () => {
  it("falls back to the config file for anything unset", () => {
    expect(readDocumentParsing(db, seed.parsing)).toEqual({
      localEnabled: true,
      policy: "local-first",
      fallbackEnabled: true,
      defaultParserId: null,
    });
  });

  it("prefers stored settings over the config file", () => {
    db.setSetting(SETTING_DOCUMENT_POLICY, "cloud-first");
    db.setSetting("documentParsing.localEnabled", "0");
    db.setSetting("documentParsing.fallbackEnabled", "0");

    const policy = readDocumentParsing(db, seed.parsing);
    expect(policy.policy).toBe("cloud-first");
    expect(policy.localEnabled).toBe(false);
    expect(policy.fallbackEnabled).toBe(false);
  });

  it("normalises a cleared parser pin to null", () => {
    // The DELETE route blanks the setting rather than removing the row.
    db.setSetting(SETTING_DOCUMENT_DEFAULT_PARSER, "");
    expect(readDocumentParsing(db, seed.parsing).defaultParserId).toBeNull();
  });

  it("ignores a stored value that is not a policy", () => {
    db.setSetting(SETTING_DOCUMENT_POLICY, "whenever");
    expect(readDocumentParsing(db, seed.parsing).policy).toBe("local-first");
  });
});

describe("config defaults", () => {
  it("defaults to local-first with document parsing available out of the box", () => {
    const config = withDefaults({ providers: [] });
    expect(config.documentParsers).toEqual([]);
    expect(config.documentParsing.policy).toBe("local-first");
    expect(config.tools.documents.localMaxBytes).toBeGreaterThan(0);
    expect(config.tools.documents.concurrency).toBeGreaterThanOrEqual(1);
  });

  it("reads a documentParsers block, including ${ENV} keys", () => {
    process.env.GL_TEST_PARSER_KEY = "from-env";
    try {
      // `resolveEnv` runs before `withDefaults` in the real loader; asserting the shape
      // here keeps this test independent of the config-file plumbing.
      const config = withDefaults({
        providers: [],
        documentParsers: [
          { id: "mineru", name: "MinerU", kind: "mineru", baseURL: "https://mineru.net/api/v4", apiKey: "from-env" },
          { id: "docling", name: "Docling", kind: "sync", baseURL: "http://127.0.0.1:5001" },
        ],
        documentParsing: { policy: "cloud-first", fallbackEnabled: false },
      });

      expect(config.documentParsers.map((p) => p.id)).toEqual(["mineru", "docling"]);
      expect(config.documentParsers[0]!.apiKey).toBe("from-env");
      expect(config.documentParsers[1]!.apiKey).toBeUndefined();
      expect(config.documentParsing.policy).toBe("cloud-first");
      expect(config.documentParsing.fallbackEnabled).toBe(false);
    } finally {
      delete process.env.GL_TEST_PARSER_KEY;
    }
  });

  it("drops an entry with an unknown kind or no baseURL instead of failing later", () => {
    const config = withDefaults({
      providers: [],
      documentParsers: [
        { id: "bad-kind", name: "X", kind: "carrier-pigeon", baseURL: "http://x" },
        { id: "no-url", name: "Y", kind: "sync" },
        { id: "good", name: "Z", kind: "sync", baseURL: "http://z" },
      ],
    });

    // A broken entry must not take the whole boot down, and must not reach the database
    // where it would only fail at parse time.
    expect(config.documentParsers.map((p) => p.id)).toEqual(["good"]);
  });
});
