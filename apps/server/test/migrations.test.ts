import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../src/db.js";
import { canMigrate, MIGRATIONS, migrateIfNeeded, openRefusal, pendingUpgrade } from "../src/migrations.js";
import { SCHEMA_VERSION, schemaProblem } from "../src/schema.js";

/**
 * The first migration this project has ever had, tested against a frozen copy of the schema it
 * migrates from.
 *
 * Three things are worth testing and they are different claims: that the walk *happens* (rows,
 * links and snapshots all survive it), that it happens *once*, and that it *refuses* — leaving
 * a file it cannot walk exactly as it found it. The last is the one the guard has always made
 * and the one a migration could most easily break.
 *
 * This is the only destructive step in the change, so the assertions are deliberately about
 * counts and identities rather than about a shape: a row that arrived under a new id, or a
 * link that quietly disappeared, would pass a "does it look right" test and fail these.
 */

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "schema-v2.sql");

let root: string;
let dbFile: string;

/** Write the fixture out as a database file, with the optional extras a case needs. */
function writeV2Database(options: { extraSql?: string } = {}): void {
  const db = new Database(dbFile);
  db.exec(readFileSync(FIXTURE, "utf8"));
  if (options.extraSql) db.exec(options.extraSql);
  db.close();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gl-migrate-"));
  dbFile = join(root, "ilearnassist.sqlite");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function rows(db: Database.Database, sql: string): Record<string, unknown>[] {
  return db.prepare(sql).all() as Record<string, unknown>[];
}

describe("migrateV2ToV3", () => {
  it("walks the file to the current version", () => {
    writeV2Database();
    const db = createDb(dbFile);
    expect(db.raw.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    db.raw.close();
  });

  it("keeps every row, under the id it already had", () => {
    // The ids are load-bearing rather than incidental: a message's `attachments` snapshot is a
    // persisted source id, so a row that came back renamed would be an attachment nothing can
    // resolve.
    writeV2Database();
    const db = createDb(dbFile);

    const ids = rows(db.raw, "SELECT id FROM sources ORDER BY id").map((r) => r["id"]);
    expect(ids).toEqual(["srcA", "srcB", "srcC"]);
    expect(db.getSourceForUser("srcA", "u1")?.name).toBe("paper.pdf");
    db.raw.close();
  });

  it("carries the parse state across", () => {
    writeV2Database();
    const db = createDb(dbFile);

    const paper = db.getSourceForUser("srcA", "u1")!;
    expect(paper.parseStatus).toBe("ready");
    expect(paper.parserId).toBe("local");
    expect(paper.parsedChars).toBe(12345);
    expect(paper.pageCount).toBe(7);
    db.raw.close();
  });

  it("gives every source an owner, a storage and an origin", () => {
    writeV2Database();
    const db = createDb(dbFile);

    const paper = db.getSourceForUser("srcA", "u1")!;
    expect(paper.ownerKind).toBe("session");
    expect(paper.ownerId).toBe("s1");
    expect(paper.origin).toBe("session_attachment");
    expect(paper.storage).toBe("upload");
    // No stored path for a blob: the filename is the id plus an extension the MIME table
    // already knows, which is exactly what the retired `raw_path` was a cache of.
    expect(paper.relPath).toBeUndefined();
    db.raw.close();
  });

  it("derives the category and the old `kind` from the MIME type", () => {
    writeV2Database();
    const db = createDb(dbFile);

    // `kind` is gone as a column; the two rows that had one must still answer the same way.
    expect(db.getSourceForUser("srcA", "u1")!.category).toBe("document");
    expect(db.getSourceForUser("srcB", "u1")!.category).toBe("image");
    expect(db.getSourceForUser("srcB", "u1")!.kind).toBe("image");
    expect(db.getSourceForUser("srcA", "u1")!.kind).toBe("file");
    db.raw.close();
  });

  it("keeps the deleted marker instead of resurrecting the row", () => {
    writeV2Database();
    const db = createDb(dbFile);

    expect(db.getSourceForUser("srcC", "u1")).toBeUndefined();
    expect(db.findDeletedSourceByHash("u1", "c".repeat(64))?.id).toBe("srcC");
    db.raw.close();
  });

  it("leaves both link tables alone", () => {
    // The reason `session_sources`/`workspace_sources` are not touched: they answer "who may
    // read it", and the read whitelist is built from them.
    writeV2Database();
    const db = createDb(dbFile);

    expect(rows(db.raw, "SELECT * FROM session_sources").length).toBe(3);
    expect(rows(db.raw, "SELECT * FROM workspace_sources").length).toBe(3);
    // `srcC` is absent because it is soft-deleted, which is the whitelist doing its job —
    // a link survives a delete, and every read filters the marker.
    expect(db.listReadableSources("u1", "s1", "w1").map((s) => s.id).sort()).toEqual([
      "srcA",
      "srcB",
    ]);
    db.raw.close();
  });

  it("leaves a message's attachment snapshot resolvable", () => {
    writeV2Database();
    const db = createDb(dbFile);

    const message = db.listMessagesForUser("s1", "u1")[0]!;
    const attachment = message.attachments![0]!;
    expect(attachment.id).toBe("srcA");
    expect(db.getSourceForUser(attachment.id, "u1")?.name).toBe("paper.pdf");
    db.raw.close();
  });

  it("keeps the hash dedupe working after the rebuild", () => {
    // The partial unique index is the new half of the identity rule; this is the old half,
    // which the rebuild had to preserve along with the revive-on-reupload behaviour that
    // depends on it.
    writeV2Database();
    const db = createDb(dbFile);

    const hash = "a".repeat(64);
    expect(db.findSourceByHash("u1", hash)?.id).toBe("srcA");
    db.raw.close();
  });

  it("does not walk a file a second time", () => {
    writeV2Database();
    const first = createDb(dbFile);
    first.raw.close();

    // Reopening is the case a real install meets on every launch after the upgrade.
    const second = new Database(dbFile);
    expect(migrateIfNeeded(second)).toBe(0);
    second.close();
  });

  it("adds the workspace settings column on the way past", () => {
    // `ensureColumn`, not the migration — which is why it has to work on the file the
    // migration just rebuilt as well as on a current one.
    writeV2Database();
    const db = createDb(dbFile);
    const columns = rows(db.raw, "PRAGMA table_info(workspaces)").map((c) => c["name"]);
    expect(columns).toContain("settings");
    db.raw.close();
  });
});

describe("refusals", () => {
  it("refuses a version with no path forward, without touching the file", () => {
    writeV2Database({ extraSql: "PRAGMA user_version = 99" });
    expect(() => createDb(dbFile)).toThrow(/created by schema v99/);

    const db = new Database(dbFile);
    expect(db.pragma("user_version", { simple: true })).toBe(99);
    // And the table is still the v2 one — a refusal is not a half-migration.
    expect(rows(db, "PRAGMA table_info(sources)").map((c) => c["name"])).toContain("raw_path");
    db.close();
  });

  it("refuses a file that predates versioning", () => {
    writeV2Database({ extraSql: "PRAGMA user_version = 0" });
    expect(() => createDb(dbFile)).toThrow(/created by schema v0/);
  });

  it("refuses a source with no owner, and leaves the file on the old version", () => {
    /*
     * The one row the migration cannot place: a source linked to neither a conversation nor a
     * workspace. An owner that is wrong is worse than a file that will not open, because
     * nothing downstream can tell it is wrong — so the walk aborts, the transaction rolls back,
     * and the file is exactly what it was.
     */
    writeV2Database({
      extraSql: `
        INSERT INTO sources (id, user_id, sha256, name, mime_type, size, kind, raw_path,
                             parse_status, created_at)
        VALUES ('srcD', 'u1', '${"d".repeat(64)}', 'orphan.txt', 'text/plain', 3, 'file',
                '/data/users/ada/sources/raw/srcD.txt', 'none', '2025-01-07T00:00:00.000Z');
      `,
    });

    expect(() => createDb(dbFile)).toThrow(/Cannot upgrade source srcD/);

    const db = new Database(dbFile);
    expect(db.pragma("user_version", { simple: true })).toBe(2);
    expect(rows(db, "PRAGMA table_info(sources)").map((c) => c["name"])).toContain("raw_path");
    expect(rows(db, "SELECT id FROM sources").length).toBe(4);
    db.close();
  });
});

describe("the schema guard stays read-only about it", () => {
  it("reports a migratable file as fine to open", () => {
    /*
     * Two questions, deliberately different. `schemaProblem` is the narrow one — "is this
     * exactly my version" — and it says no, which is why the schema module needs no knowledge
     * of the steps. `openRefusal` is the one that decides anything, and it says the file is
     * fine because it can be walked. The administrator CLI's `status` asks the second, or it
     * would tell an operator to move aside a data root the server is about to upgrade.
     */
    writeV2Database();
    const db = new Database(dbFile, { readonly: true });
    expect(schemaProblem(db)).toEqual({ found: 2, needed: SCHEMA_VERSION });
    expect(openRefusal(db)).toBeUndefined();
    expect(pendingUpgrade(db)).toBe(2);
    db.close();
  });

  it("still reports an unmigratable one as a problem", () => {
    writeV2Database({ extraSql: "PRAGMA user_version = 99" });
    const db = new Database(dbFile, { readonly: true });
    expect(schemaProblem(db)).toEqual({ found: 99, needed: SCHEMA_VERSION });
    expect(canMigrate(99)).toBe(false);
    db.close();
  });

  it("does not migrate a file it was only asked about", () => {
    // The sharp edge of a read-only check: `status` must not walk the database it is
    // reporting on. `schemaProblem` reads two things and writes nothing.
    writeV2Database();
    const db = new Database(dbFile, { readonly: true });
    schemaProblem(db);
    expect(db.pragma("user_version", { simple: true })).toBe(2);
    db.close();
  });
});

describe("canMigrate", () => {
  it("is true for the current version and for every step below it", () => {
    expect(canMigrate(SCHEMA_VERSION)).toBe(true);
    expect(canMigrate(SCHEMA_VERSION - 1)).toBe(true);
  });

  it("is false for a version in the future and for one with no step", () => {
    expect(canMigrate(SCHEMA_VERSION + 1)).toBe(false);
    expect(canMigrate(0)).toBe(false);
    expect(canMigrate(-1)).toBe(false);
  });

  it("covers every version between the oldest step and the current one", () => {
    // A guard for the next person: a version with no step out of it is a refusal, so a gap
    // between `MIGRATIONS[0].from` and `SCHEMA_VERSION` is a range of installs that cannot
    // upgrade — which should be a decision, not an accident.
    const oldest = Math.min(...MIGRATIONS.map((m) => m.from));
    for (let version = oldest; version < SCHEMA_VERSION; version += 1) {
      expect(canMigrate(version), `v${version} has no path forward`).toBe(true);
    }
  });
});
