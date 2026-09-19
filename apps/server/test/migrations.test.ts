import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../src/db.js";
import { canMigrate, MIGRATIONS, openRefusal } from "../src/migrations.js";
import { SCHEMA_VERSION, schemaProblem } from "../src/schema.js";

/**
 * The version guard, now that there is nothing to walk.
 *
 * Until v4 this file tested a migration: rows surviving a rebuild, links kept, a walk that
 * happens once. The 大改造 has no step — one table became three and the bytes' locator changed
 * meaning, which is not a pure function of the rows — so the only behaviour left is the one the
 * guard has always had: **anything that is not exactly this version is refused, and the file is
 * left byte-for-byte as it was found.**
 *
 * That is why the tests below are mostly about *refusal*. The interesting case is v3, which is
 * the version this build's own predecessor wrote: it must be refused loudly rather than opened
 * and read wrong, because a v3 `sources` row and a v4 `work_resources` row are both "the
 * material an account holds" and nothing in either file would say which one was being read.
 */

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "schema-v2.sql");

let root: string;
let dbFile: string;

/**
 * Write the frozen old schema out as a database file.
 *
 * A real historical schema rather than an empty file with a version pragma, because the claim
 * being tested is that the *version* decides and nothing reads the body: a genuine v2 database
 * is the strongest form of that, and it makes "left exactly as it was" checkable.
 */
function writeOldDatabase(options: { version?: number } = {}): void {
  const db = new Database(dbFile);
  db.exec(readFileSync(FIXTURE, "utf8"));
  if (options.version !== undefined) db.pragma(`user_version = ${options.version}`);
  db.close();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gl-schema-"));
  dbFile = join(root, "ilearnassist.sqlite");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function rows(db: Database.Database, sql: string): Record<string, unknown>[] {
  return db.prepare(sql).all() as Record<string, unknown>[];
}

describe("the version guard", () => {
  it("refuses a v3 file — the version its own predecessor wrote", () => {
    /*
     * The case the whole clean break turns on. v3's `sources` and v4's `work_resources` are both
     * "the material this account holds", so an old file opened by this build would be read as the
     * wrong kind of thing everywhere, with no error to explain it — a file's path resolved
     * through columns that no longer mean the same thing.
     */
    writeOldDatabase({ version: 3 });
    expect(() => createDb(dbFile)).toThrow(/created by schema v3/);
  });

  it("refuses a version with no path forward, without touching the file", () => {
    writeOldDatabase({ version: 99 });
    expect(() => createDb(dbFile)).toThrow(/created by schema v99/);

    const db = new Database(dbFile);
    expect(db.pragma("user_version", { simple: true })).toBe(99);
    // And the body is still the old schema — a refusal is not a half-upgrade.
    expect(rows(db, "PRAGMA table_info(sources)").map((c) => c["name"])).toContain("raw_path");
    db.close();
  });

  it("refuses a file that predates versioning", () => {
    writeOldDatabase({ version: 0 });
    expect(() => createDb(dbFile)).toThrow(/created by schema v0/);
  });

  it("opens a file at exactly this version", () => {
    // The other direction, and the one that keeps the guard from being vacuous: the current
    // version must actually open, with its tables built. `createDb` hands back the app's own
    // façade rather than the connection, so the assertions read through a second handle.
    createDb(dbFile);

    const db = new Database(dbFile, { readonly: true });
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(rows(db, "PRAGMA table_info(work_resources)").length).toBeGreaterThan(0);
    expect(rows(db, "PRAGMA table_info(files)").length).toBeGreaterThan(0);
    expect(rows(db, "PRAGMA table_info(web_pages)").length).toBeGreaterThan(0);
    db.close();
  });
});

describe("the schema guard stays read-only about it", () => {
  it("reports a current file as fine to open", () => {
    // Two questions, deliberately different. `schemaProblem` is the narrow one — "is this
    // exactly my version" — and `openRefusal` is the one that decides anything, by also
    // accounting for what can be walked. With no steps the two agree on every input, and this
    // pins that they agree on the one that matters: a file this build can open.
    createDb(dbFile);

    const db = new Database(dbFile, { readonly: true });
    expect(schemaProblem(db)).toBeUndefined();
    expect(openRefusal(db)).toBeUndefined();
    db.close();
  });

  it("still reports an unmigratable one as a problem", () => {
    writeOldDatabase({ version: 99 });
    const db = new Database(dbFile, { readonly: true });
    expect(schemaProblem(db)).toEqual({ found: 99, needed: SCHEMA_VERSION });
    expect(openRefusal(db)).toEqual({ found: 99, needed: SCHEMA_VERSION });
    expect(canMigrate(99)).toBe(false);
    db.close();
  });

  it("does not touch a file it was only asked about", () => {
    // The sharp edge of a read-only check: `status` must not write to the database it is
    // reporting on. `schemaProblem` reads one pragma and writes nothing.
    writeOldDatabase({ version: 2 });
    const db = new Database(dbFile, { readonly: true });
    schemaProblem(db);
    expect(db.pragma("user_version", { simple: true })).toBe(2);
    db.close();
  });
});

describe("canMigrate", () => {
  it("is true for the current version and nothing below it", () => {
    expect(canMigrate(SCHEMA_VERSION)).toBe(true);
    // The break, stated as a test: `SCHEMA_VERSION - 1` used to be true, because a step out of
    // it existed. It is now a refusal.
    expect(canMigrate(SCHEMA_VERSION - 1)).toBe(false);
  });

  it("is false for a version in the future and for anything unversioned", () => {
    expect(canMigrate(SCHEMA_VERSION + 1)).toBe(false);
    expect(canMigrate(0)).toBe(false);
    expect(canMigrate(-1)).toBe(false);
  });

  it("has no steps, which is what makes the line above a refusal", () => {
    /*
     * The guard on the guard, and the one assertion that makes the empty list a *decision*
     * rather than an omission. If somebody adds a step, this fails and the two cases above must
     * be rewritten — which is exactly right, because adding a step is what turns a refusal back
     * into an upgrade.
     */
    expect(MIGRATIONS).toEqual([]);
  });
});
