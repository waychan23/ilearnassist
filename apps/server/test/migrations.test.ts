import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../src/db.js";
import {
  MAX_SNAPSHOTS,
  MigrationBackupError,
  SKIP_BACKUP_ENV,
  listSnapshots,
  snapshotForMigration,
} from "../src/backup.js";
import {
  MIGRATIONS,
  MigrationError,
  appliedMigrations,
  canMigrate,
  checksumOf,
  currentVersion,
  openRefusal,
  pendingSteps,
  runMigrations,
  verifyApplied,
  type SchemaStep,
} from "../src/migrations.js";
import { dataLayout } from "../src/paths.js";
import { SCHEMA_VERSION, schemaProblem } from "../src/schema.js";

/**
 * The version guard, the walk, and the history.
 *
 * Three subjects, and it is worth being clear about which one is load-bearing:
 *
 * 1. **The guard**, which is unchanged. Anything not exactly this version is refused, and the
 *    file is left byte-for-byte as it was found. `MIGRATIONS` is empty, so a v2/v3/v4 file is
 *    still refused rather than walked — the framework landing did not quietly start upgrading
 *    databases that no step was ever written for.
 * 2. **The walk**, exercised by registering steps for the duration of a test. This is the part
 *    that was never tested before because it never ran; a walk that has never run is exactly the
 *    code that needs tests, and `canMigrate`'s "no steps" case was the only thing standing in
 *    for it.
 * 3. **The snapshot**, which is the only thing protecting a user's data from a walk that
 *    succeeds and turns out to have been wrong. It gets its own describe.
 */

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "schema-v2.sql");

let root: string;
let dbFile: string;
let backupsDir: string;

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

/**
 * Register steps for one test, then take them away again.
 *
 * `MIGRATIONS` is a module constant with no setter, deliberately — there is no production reason
 * to swap the step list at runtime. A test is the one caller that does, and pushing on to it is
 * the same move the store tests make against `WIDGET_MODULES`. The restore is by length so a
 * test that throws still leaves the module as it found it.
 */
function withSteps<T>(steps: SchemaStep[], body: () => T): T {
  const original = MIGRATIONS.length;
  MIGRATIONS.push(...steps);
  try {
    return body();
  } finally {
    MIGRATIONS.length = original;
  }
}

/** A step that leaves a mark, so "did it run, and in what order" is checkable. */
function probeStep(from: number, to = from + 1): SchemaStep {
  return {
    id: `probe-${from}-to-${to}`,
    from,
    to,
    sql: `CREATE TABLE probe_v${to} (note TEXT); INSERT INTO probe_v${to} (note) VALUES ('ran v${to}');`,
  };
}

/** The three steps that would carry the frozen v2 fixture to this build's version. */
const CARRY_V2 = [probeStep(2), probeStep(3), probeStep(4)].slice(
  0,
  SCHEMA_VERSION - 2
);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gl-schema-"));
  // The *conventional* layout, so `createDb` can derive `<root>/backups` and a walk has
  // somewhere to put its snapshot without the test passing anything. The one test that needs the
  // unconventional path builds it itself.
  const layout = dataLayout(root);
  dbFile = layout.sqliteFile;
  backupsDir = layout.backupsDir;
  // `createDb` makes this itself; the tests below open the file directly first, to write a
  // historical database before there is anything to open it with.
  mkdirSync(dirname(dbFile), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function rows(db: Database.Database, sql: string): Record<string, unknown>[] {
  return db.prepare(sql).all() as Record<string, unknown>[];
}

function read<T>(sql: string): T[] {
  const db = new Database(dbFile, { readonly: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}

function version(): number {
  const db = new Database(dbFile, { readonly: true });
  try {
    return db.pragma("user_version", { simple: true }) as number;
  } finally {
    db.close();
  }
}

function tableNames(): string[] {
  return read<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).map((r) => r.name);
}

describe("the version guard", () => {
  it("refuses a v3 file — the version its own predecessor wrote", () => {
    /*
     * The case the clean break turns on, and it is still a refusal after the walk arrived. v3's
     * `sources` and v4's `work_resources` are both "the material this account holds", so an old
     * file opened by this build would be read as the wrong kind of thing everywhere, with no
     * error to explain it. No step was written for v3 → v4 and none is going to be: the owner a
     * link belonged to is not recoverable from the rows.
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

  it("takes no snapshot for a file it does not have to walk", () => {
    // The cost only exists where the risk does. A fresh install and a current install both walk
    // nothing, so neither pays for a copy of the database.
    createDb(dbFile);
    expect(listSnapshots(backupsDir)).toEqual([]);
  });
});

describe("the schema guard stays read-only about it", () => {
  it("reports a current file as fine to open", () => {
    // Two questions, deliberately different. `schemaProblem` is the narrow one — "is this
    // exactly my version" — and `openRefusal` is the one that decides anything, by also
    // accounting for what can be walked.
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

  it("reports an old file as walkable rather than refused once a step exists", () => {
    // What `openRefusal` is for, and the one place it and `schemaProblem` must disagree: the
    // narrow question still says "not my version", while the question that decides says "fine,
    // this build can walk it".
    writeOldDatabase({ version: 2 });
    withSteps(CARRY_V2, () => {
      const db = new Database(dbFile, { readonly: true });
      expect(schemaProblem(db)).toEqual({ found: 2, needed: SCHEMA_VERSION });
      expect(openRefusal(db)).toBeUndefined();
      db.close();
    });
  });
});

describe("canMigrate", () => {
  it("is true for the current version and nothing below it", () => {
    expect(canMigrate(SCHEMA_VERSION)).toBe(true);
    // The break, stated as a test: with no steps out of v4, it is a refusal.
    expect(canMigrate(SCHEMA_VERSION - 1)).toBe(false);
  });

  it("is false for a version in the future and for anything unversioned", () => {
    expect(canMigrate(SCHEMA_VERSION + 1)).toBe(false);
    expect(canMigrate(0)).toBe(false);
    expect(canMigrate(-1)).toBe(false);
  });

  it("is true all the way down the chain once steps exist", () => {
    withSteps(CARRY_V2, () => {
      for (const step of CARRY_V2) expect(canMigrate(step.from), `from v${step.from}`).toBe(true);
      expect(canMigrate(1)).toBe(false);
    });
  });

  it("has steps that are single-hop, uniquely sourced, and non-empty", () => {
    /*
     * The guard on the guard, and the successor to "MIGRATIONS is empty". That assertion made the
     * empty list a decision rather than an omission; this one makes the *shape* of any future
     * step a decision, which is the property that actually matters once there is a step to get
     * wrong. A step that skipped a version would make `canMigrate` a lie; two steps out of the
     * same version make which one runs depend on array order.
     *
     * It passes for an empty array, so it constrains the future rather than the present.
     */
    const sources = new Set<number>();
    for (const step of MIGRATIONS) {
      expect(step.to, `${step.id} is not single-hop`).toBe(step.from + 1);
      expect(sources.has(step.from), `two steps out of v${step.from}`).toBe(false);
      sources.add(step.from);
      expect(step.id.length, "a step needs an id — the history records it").toBeGreaterThan(0);
      expect(step.sql.trim().length, `${step.id} has no SQL`).toBeGreaterThan(0);
    }
    // And every version a step claims to leave is a version this build can actually walk from.
    for (const step of MIGRATIONS) expect(canMigrate(step.from), `from v${step.from}`).toBe(true);
  });

  it("checksums both halves of a step, so a rename is caught as well as an edit", () => {
    const step = probeStep(2);
    expect(checksumOf(step)).toBe(checksumOf({ ...step }));
    expect(checksumOf(step)).not.toBe(checksumOf({ ...step, id: "renamed" }));
    expect(checksumOf(step)).not.toBe(checksumOf({ ...step, sql: `${step.sql} ` }));
  });
});

describe("the walk", () => {
  it("carries the frozen v2 database to this build's version", () => {
    /*
     * The whole point of the framework, on a database this build's own predecessor wrote. Before
     * the walk existed this file was *refused* — the assertion above still pins that for v3,
     * which has no step — and here the same kind of file is upgraded instead.
     */
    writeOldDatabase({ version: 2 });
    expect(version()).toBe(2);

    const outcomes: unknown[] = [];
    withSteps(CARRY_V2, () =>
      createDb(dbFile, { onMigrated: (outcome) => outcomes.push(outcome) })
    );

    expect(version()).toBe(SCHEMA_VERSION);
    expect(outcomes).toHaveLength(1);
    // Every step ran, in order, and left its mark.
    const probes = tableNames().filter((name) => name.startsWith("probe_v"));
    expect(probes).toEqual(CARRY_V2.map((s) => `probe_v${s.to}`));
    // And the DDL afterwards built the tables the walk did not.
    expect(tableNames()).toContain("schema_migrations");
    expect(tableNames()).toContain("usage_events");
  });

  it("records one history row per step, with the checksum of what ran", () => {
    writeOldDatabase({ version: 2 });
    withSteps(CARRY_V2, () => createDb(dbFile));

    const history = read<{ version: number; id: string; checksum: string; duration_ms: number }>(
      "SELECT version, id, checksum, duration_ms FROM schema_migrations ORDER BY version ASC"
    );
    expect(history.map((h) => h.version)).toEqual(CARRY_V2.map((s) => s.to));
    expect(history.map((h) => h.id)).toEqual(CARRY_V2.map((s) => s.id));
    for (const [index, row] of history.entries()) {
      expect(row.checksum).toBe(checksumOf(CARRY_V2[index]!));
    }
  });

  it("does nothing at all to a file that is already current", () => {
    createDb(dbFile);
    const before = currentVersion(new Database(dbFile, { readonly: true }));

    withSteps(CARRY_V2, () => createDb(dbFile));

    expect(before).toBe(SCHEMA_VERSION);
    expect(listSnapshots(backupsDir)).toEqual([]);
    expect(read("SELECT * FROM schema_migrations")).toEqual([]);
  });

  it("leaves the file at the version it started on when a step fails", () => {
    /*
     * The promise the guard makes: a half-migrated database is not a state this file can be in.
     * The first step is valid and the second is not, so "did the transaction really roll back the
     * first one" is the question — a walk that committed per step would leave `probe_v3` behind
     * and `user_version` at 3.
     */
    writeOldDatabase({ version: 2 });
    const broken: SchemaStep[] = [
      probeStep(2),
      { id: "broken", from: 3, to: 4, sql: "CREATE TABLE probe_v4 (x TEXT); THIS IS NOT SQL;" },
    ];

    withSteps(broken, () => {
      expect(() => createDb(dbFile)).toThrow(MigrationError);
      expect(() => createDb(dbFile)).toThrow(/the database is unchanged at v2/);
    });

    expect(version()).toBe(2);
    // Neither step's mark is there, and the history is empty — the stamp and the history row
    // were in the same transaction as the SQL, which is the point.
    expect(tableNames()).not.toContain("probe_v3");
    expect(tableNames()).not.toContain("probe_v4");
    expect(appliedMigrations(new Database(dbFile))).toEqual([]);
  });

  it("refuses to migrate when a step that already ran has been edited", () => {
    writeOldDatabase({ version: 2 });
    withSteps(CARRY_V2, () => createDb(dbFile));
    expect(version()).toBe(SCHEMA_VERSION);

    // The same steps as they were, which by definition still verify.
    withSteps(CARRY_V2, () => {
      const db = new Database(dbFile);
      expect(() => verifyApplied(db)).not.toThrow();
      db.close();
    });

    // And now one of them quietly changed — what a "small fix" to a shipped migration looks like
    // in a diff. Nothing about the file changed; the *code* did, which is why only a checksum can
    // see it.
    const edited = CARRY_V2.map((step) =>
      step.to === 3 ? { ...step, sql: `${step.sql} -- a helpful clarification` } : step
    );
    withSteps(edited, () => {
      const db = new Database(dbFile);
      expect(() => verifyApplied(db)).toThrow(MigrationError);
      expect(() => verifyApplied(db)).toThrow(/has changed since it ran/);
      // Named, so an operator can find the step without guessing which one.
      expect(() => verifyApplied(db)).toThrow(/probe-2-to-3/);
      db.close();
    });
  });

  it("refuses when a step that already ran no longer exists", () => {
    /*
     * The other half of the checksum's job: a build whose history claims a version it can no
     * longer produce. This is what deleting a shipped migration looks like, and without the check
     * the file would simply load with no memory of what shaped it.
     */
    writeOldDatabase({ version: 2 });
    withSteps(CARRY_V2, () => createDb(dbFile));

    withSteps([], () => {
      expect(() => verifyApplied(new Database(dbFile))).toThrow(/no longer has/);
    });
  });

  it("reaches the same schema whether the file was built fresh or walked", () => {
    /*
     * The claim that keeps the two mechanisms from drifting: the idempotent DDL and `ensureColumn`
     * are how a *new* column arrives, and a step is how a *breaking* change does — and all three
     * are supposed to land on the same shape. A fresh file and a walked one must be the same
     * database.
     *
     * **Compared as sets, and the order genuinely differs** — this test found that. A fresh file
     * gets its columns in `DDL` order; a walked one has the v2 order with everything `ensureColumn`
     * added appended after it. Nothing depends on the order: there is no `INSERT INTO t VALUES`
     * without a column list anywhere in the server, and every row is mapped by name, so the only
     * thing a differing order could break is a positional read that does not exist. The test says
     * the difference out loud rather than sorting silently, because the next person to see it in a
     * diff should find out here that it is expected.
     *
     * Per table rather than as a whole list, because a walked v2 file legitimately still carries
     * `sources` and the other tables nothing drops.
     */
    createDb(dbFile);
    const fresh = columnsByTable();

    rmSync(root, { recursive: true, force: true });
    const second = mkdtempSync(join(tmpdir(), "gl-schema-"));
    const secondLayout = dataLayout(second);
    dbFile = secondLayout.sqliteFile;
    backupsDir = secondLayout.backupsDir;
    mkdirSync(dirname(dbFile), { recursive: true });
    writeOldDatabase({ version: 2 });
    withSteps(CARRY_V2, () => createDb(dbFile));
    const walked = columnsByTable();

    for (const [table, columns] of Object.entries(fresh)) {
      const walkedColumns = walked[table];
      expect(walkedColumns, `${table} is missing from the walked file`).toBeDefined();
      expect([...walkedColumns!].sort(), `${table} differs between fresh and walked`).toEqual(
        [...columns].sort()
      );
    }
    rmSync(second, { recursive: true, force: true });
  });

  it("refuses to walk a database whose path gives no backups directory", () => {
    /*
     * Fail closed, and the reason the hook has no default: a walk with nowhere to put its
     * snapshot is a walk with no way back. `createDb` derives the directory from the conventional
     * layout, so a path that is not that shape has to say where to put it rather than proceeding
     * without one.
     */
    writeOldDatabase({ version: 2 });
    const oddPath = join(root, "elsewhere.sqlite");
    writeFileSync(oddPath, readFileSync(dbFile));

    withSteps(CARRY_V2, () => {
      expect(() => createDb(oddPath)).toThrow(MigrationBackupError);
      expect(() => createDb(oddPath)).toThrow(/No backup directory was given/);
    });
  });

  it("walks without a snapshot when the deployment says it has its own", () => {
    writeOldDatabase({ version: 2 });
    const previous = process.env[SKIP_BACKUP_ENV];
    process.env[SKIP_BACKUP_ENV] = "1";
    try {
      withSteps(CARRY_V2, () => createDb(dbFile));
      expect(version()).toBe(SCHEMA_VERSION);
      expect(listSnapshots(backupsDir)).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env[SKIP_BACKUP_ENV];
      else process.env[SKIP_BACKUP_ENV] = previous;
    }
  });

  it("reports what it would do without doing it", () => {
    writeOldDatabase({ version: 2 });
    withSteps(CARRY_V2, () => {
      expect(pendingSteps(2).map((s) => s.id)).toEqual(CARRY_V2.map((s) => s.id));
      expect(pendingSteps(SCHEMA_VERSION)).toEqual([]);
    });
    // And the file is untouched by the question.
    expect(version()).toBe(2);
  });
});

describe("the snapshot taken before a walk", () => {
  it("holds the database as it was, and opens as a real one", () => {
    /*
     * What the snapshot is *for*. The walk adds `probe_v3`; the snapshot must not have it, and
     * must have the pre-walk `sources` table. A file that merely exists would satisfy a weaker
     * test and be useless on the day somebody needed it.
     */
    writeOldDatabase({ version: 2 });
    const outcome = withSteps(CARRY_V2, () => {
      let captured: { backup: string | null } = { backup: null };
      createDb(dbFile, { onMigrated: (o) => (captured = o) });
      return captured;
    });

    expect(outcome.backup).toBeTruthy();
    const snapshot = new Database(outcome.backup!, { readonly: true });
    try {
      expect(snapshot.pragma("user_version", { simple: true })).toBe(2);
      expect(rows(snapshot, "SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name))
        .toContain("sources");
      // The mark the walk left is absent, which is what "as it was" means.
      expect(rows(snapshot, "SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name))
        .not.toContain("probe_v3");
      // And the data that was in it is still in it — the point of a backup.
      expect(rows(snapshot, "SELECT id FROM users").length).toBeGreaterThan(0);
    } finally {
      snapshot.close();
    }
  });

  it("is named after the version it was taken at, so a restore needs no guessing", () => {
    writeOldDatabase({ version: 2 });
    const outcome = withSteps(CARRY_V2, () => {
      let captured: { backup: string | null } = { backup: null };
      createDb(dbFile, { onMigrated: (o) => (captured = o) });
      return captured;
    });
    // The version it was taken *at*, then the moment — `v2` is what someone restoring needs to
    // know without opening the file, and the timestamp sorts.
    expect(outcome.backup!.split("/").pop()).toMatch(
      /^ilearnassist-v2-\d{4}-\d{2}-\d{2}-\d{6}\.sqlite$/
    );
  });

  it("keeps the newest few and deletes the rest", () => {
    /*
     * A retention rule nobody checks is a directory that grows until the disk fills — and each
     * one of these is a full copy of the database, so the cost is real rather than theoretical.
     */
    const db = new Database(dbFile);
    try {
      db.exec(readFileSync(FIXTURE, "utf8"));
      db.pragma(`user_version = 2`);
      const made: string[] = [];
      for (let n = 1; n <= MAX_SNAPSHOTS + 2; n += 1) {
        made.push(
          snapshotForMigration(db, backupsDir, n, {
            // A distinct instant per call, so "oldest" is a fact about the files rather than
            // about how fast the loop ran.
            now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, n)),
            env: {},
          })!
        );
      }
      const kept = listSnapshots(backupsDir);
      expect(kept).toHaveLength(MAX_SNAPSHOTS);
      // The two oldest are gone and the newest is here — not just the right count.
      expect(kept).not.toContain(made[0]);
      expect(kept).not.toContain(made[1]);
      expect(kept).toContain(made[made.length - 1]);
    } finally {
      db.close();
    }
  });

  it("refuses to migrate when it cannot write the snapshot", () => {
    // A read-only data root is the case: the walk must not proceed, because a failed snapshot is
    // the one warning that has to be an error. `VACUUM INTO` into a directory that does not
    // exist and cannot be created is the cheapest way to produce that here.
    const db = new Database(dbFile);
    try {
      db.exec(readFileSync(FIXTURE, "utf8"));
      db.pragma(`user_version = 2`);
      const blocked = join(root, "blocked", " nope");
      expect(() => snapshotForMigration(db, blocked, 2, { env: {} })).toThrow(
        MigrationBackupError
      );
    } finally {
      db.close();
    }
  });

  it("is skipped only when the environment says so", () => {
    const db = new Database(dbFile);
    try {
      db.exec(readFileSync(FIXTURE, "utf8"));
      db.pragma(`user_version = 2`);
      expect(snapshotForMigration(db, backupsDir, 2, { env: {} })).toBeTruthy();
      expect(snapshotForMigration(db, backupsDir, 2, { env: { [SKIP_BACKUP_ENV]: "1" } })).toBeNull();
      expect(snapshotForMigration(db, backupsDir, 2, { env: { [SKIP_BACKUP_ENV]: "false" } })).toBeTruthy();
    } finally {
      db.close();
    }
  });
});

describe("runMigrations", () => {
  it("needs a snapshot hook and will not be called without one", () => {
    // The signature is the guard: `hooks` has no default and `snapshot` is required, so the only
    // way to migrate without a snapshot is to write `() => null` at the call site, where a
    // reviewer sees it. This is checked at compile time, and this test is here so that the
    // requirement has a name in the suite rather than only in the type.
    const db = new Database(dbFile);
    try {
      db.exec(readFileSync(FIXTURE, "utf8"));
      db.pragma(`user_version = 2`);
      const calls: number[] = [];
      withSteps(CARRY_V2, () => {
        runMigrations(db, { snapshot: (from) => (calls.push(from), null) });
      });
      expect(calls).toEqual([2]);
      expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });
});

/**
 * Every table the DDL declares, with its columns in order.
 *
 * Only the tables a *fresh* install has: a walked v2 file legitimately keeps `sources` and the
 * other tables nothing drops, and comparing whole lists would fail for a reason that is not a
 * defect.
 */
function columnsByTable(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const db = new Database(dbFile, { readonly: true });
  try {
    for (const { name } of read<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )) {
      out[name] = (db.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]).map(
        (c) => c.name
      );
    }
  } finally {
    db.close();
  }
  return out;
}
