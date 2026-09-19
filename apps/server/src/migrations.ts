import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { MIGRATION_HISTORY_DDL, SCHEMA_VERSION, schemaProblem } from "./schema.js";

/**
 * The version guard, the walk, and the history of what the walk did.
 *
 * **The model is Flyway's** — ordered, immutable, single-hop steps, a history table, and a
 * checksum that notices when a step that has already run is edited afterwards. The *runner* is
 * this file rather than a library, and that is a decision with three concrete reasons:
 *
 * - **`better-sqlite3` is synchronous and every migration library's API is a promise.** Taking
 *   one would make `createDb` async, and `createDb` is called synchronously from the server's
 *   boot, from the administrator CLI and from every test.
 * - **There is already a version authority, and it is not negotiable.** `PRAGMA user_version`
 *   lives in the file header, which is why the guard can read it *before* anything is created;
 *   `schemaProblem`, `canMigrate` and `openRefusal` are built on that, and the CLI's read-only
 *   `status` command depends on them. A library's own history table would be a second authority
 *   that has to agree with the first forever, and can fail to.
 * - **The server is bundled into one file, so there is no `migrations/` directory to read.**
 *   `esbuild` inlines *imports* — the same reason `builtin.json` must be imported rather than
 *   read — so a runner that globs a directory works in the checkout and finds nothing in the
 *   packaged app.
 *
 * Each of those is a cost a library cannot pay for us, and what a library *would* give us (the
 * walk, the history, the checksum) is about a hundred lines. What a library would not give us,
 * and what this file therefore owns, is the snapshot taken before a walk — see `backup.ts`.
 */

/** How a step is written. A step is **a piece of SQL and nothing else**; see `MIGRATIONS`. */
export interface SchemaStep {
  /**
   * Stable identity, recorded in the history and never changed once shipped.
   *
   * It is the half of the checksum that survives a reindent: the checksum covers `id + sql`, so
   * reformatting a step's SQL still trips it (correctly — the statement changed shape) while a
   * renamed step is caught even if its SQL is untouched.
   */
  id: string;
  from: number;
  to: number;
  /**
   * The whole step, as one SQL script.
   *
   * **Data, not a comment**: the checksum is taken over this string, so it is the record of what
   * a user's database was actually changed by. A step that genuinely needs JavaScript — reading
   * rows, deciding per row, writing back — is the point at which this interface grows a `run`,
   * and the checksum then covers `id` alone. Nothing so far has needed it: the one migration
   * this repository has ever run in anger was `DELETE FROM copilots`.
   */
  sql: string;
}

/**
 * No steps. Every schema change up to v5 reached existing databases through `ensureColumn` and
 * the idempotent DDL, so there is nothing to walk *from* — and a v2/v3/v4 file is still refused,
 * exactly as it was before this module grew a walk.
 *
 * When a step *is* added, three properties are what make a walk safe rather than merely
 * convenient, and all three were learned by the v2 → v3 rebuild this array used to hold:
 *
 * - **Each step is single-hop and total.** `{from: 2, to: 3}` is one upgrade; a file two versions
 *   behind runs two steps, and a version with no step out of it is refused, not guessed at.
 * - **The whole walk is one transaction, stamped after each step.** A failure anywhere leaves the
 *   file at the version it started on — the promise the guard makes, kept. The stamp and the
 *   history row are *in* that transaction, so "the version" and "what ran to get here" cannot
 *   disagree, even across a crash.
 * - **Foreign keys are off, and `legacy_alter_table` is on, for the duration.** Not a
 *   preference: `foreign_keys` is ON in this app, and with it on, `ALTER TABLE … RENAME`
 *   rewrites the `REFERENCES` clauses of every table pointing at the renamed one, and dropping
 *   the old table then fires their `ON DELETE CASCADE`. Both pragmas are per-connection and
 *   neither can be set from inside a transaction, so the toggling brackets the transaction
 *   rather than living in it.
 */
export const MIGRATIONS: SchemaStep[] = [];

/**
 * A walk that could not run, or could not be trusted. Separate from `SchemaUnreadableError`,
 * which is about a file this build must not open at all — this one is about a file it should
 * have been able to walk.
 */
export class MigrationError extends Error {
  constructor(
    message: string,
    readonly reason: "checksum" | "unknown_step" | "failed",
    /** The step's id, when the failure is about one. Named so an operator can find it. */
    readonly stepId?: string
  ) {
    super(message);
    this.name = "MigrationError";
  }
}

/**
 * The checksum recorded for a step, so that editing one *after* it has run is detectable.
 *
 * This is Flyway's most useful half and it is worth being clear about what it does **not** do:
 * it cannot notice an edit before the step ever ran (there is nothing to compare against), and
 * it does not police the SQL — a step whose SQL is wrong is still applied, once, and then
 * reported as changed if anyone fixes it in place. The rule it enforces is one sentence: **a
 * step that has run is never edited again; the next version is the next step.**
 */
export function checksumOf(step: Pick<SchemaStep, "id" | "sql">): string {
  return createHash("sha256").update(step.id).update("\n").update(step.sql).digest("hex");
}

/** The version the file says it is. Read from the header, so it costs nothing and needs no tables. */
export function currentVersion(db: Database.Database): number {
  return db.pragma("user_version", { simple: true }) as number;
}

export interface AppliedMigration {
  version: number;
  id: string;
  checksum: string;
  appliedAt: string;
  durationMs: number;
}

/**
 * Every step applied to this file, oldest first. Reads the table directly — no registry walk.
 *
 * **A missing table is an empty history, not an error**, and that is a bootstrap case rather than
 * a tolerance: the walk runs *before* `applySchema` (it has to — see `createDb`), so on the first
 * start of this build against a database created by an earlier one, `schema_migrations` does not
 * exist yet. The file's version is still `user_version`, which is in the header and needs no
 * table, so "no history table" and "this file has never had a step applied" are the same
 * statement — and they are, for every database that exists today.
 */
export function appliedMigrations(db: Database.Database): AppliedMigration[] {
  const present = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (!present) return [];

  return db
    .prepare(
      `SELECT version, id, checksum, applied_at AS appliedAt, duration_ms AS durationMs
         FROM schema_migrations ORDER BY version ASC`
    )
    .all() as AppliedMigration[];
}

/**
 * The steps between this file's version and this build's, in order. Empty for a current file.
 *
 * Pure in the sense that matters: it reads the version and consults `MIGRATIONS`, so a caller
 * can ask "what would a walk do" without doing one.
 */
export function pendingSteps(from: number): SchemaStep[] {
  const steps: SchemaStep[] = [];
  let version = from;
  for (let guard = 0; guard <= MIGRATIONS.length; guard += 1) {
    if (version === SCHEMA_VERSION) return steps;
    const next = MIGRATIONS.find((m) => m.from === version);
    if (!next) return steps;
    steps.push(next);
    version = next.to;
  }
  return steps;
}

/**
 * Refuse if a step that has already run is not what it was.
 *
 * Two failures, and the second is the one people forget: a checksum that no longer matches means
 * the step was **edited in place**, and a row with **no step at all** means a shipped step was
 * **deleted** — a build whose history claims a version it can no longer produce. Both are
 * developer errors, both are invisible without this check, and both are far worse to meet as
 * "the data is subtly wrong three releases later" than as a server that will not start.
 */
export function verifyApplied(db: Database.Database): void {
  for (const applied of appliedMigrations(db)) {
    const step = MIGRATIONS.find((m) => m.to === applied.version);
    if (!step) {
      throw new MigrationError(
        `This database was migrated to v${applied.version} by a step ("${applied.id}") that this ` +
          `build no longer has. A shipped migration must not be removed.`,
        "unknown_step",
        applied.id
      );
    }
    if (checksumOf(step) !== applied.checksum) {
      throw new MigrationError(
        `The migration step "${step.id}" (v${step.from} → v${step.to}) has changed since it ran ` +
          `on this database. A migration that has been applied is never edited — add a new step ` +
          `for the next change instead.`,
        "checksum",
        step.id
      );
    }
  }
}

export interface MigrationOutcome {
  from: number;
  to: number;
  /** The steps this call ran, in order. Empty when the file was already current. */
  applied: SchemaStep[];
  /** Where the pre-walk snapshot went, or null when none was taken. See `backup.ts`. */
  backup: string | null;
}

/**
 * What `runMigrations` needs. Injected rather than reached for, so the walk can be tested without
 * a data root.
 *
 * `snapshot` is **required and has no default.** Making it optional would mean a caller that
 * forgot it migrated a user's only copy of their data with no way back, and the forgetting would
 * be invisible — the walk would succeed. Required, the only way to run without a snapshot is to
 * write `() => null` at the call site, which a reviewer can see. The deployment-level opt-out
 * (`ILA_SKIP_MIGRATION_BACKUP`) lives inside `snapshotForMigration` instead, so it is one env
 * check in one place rather than a decision each caller makes.
 */
export interface MigrationHooks {
  /**
   * Called once, before any step runs, with the version being walked from. Returns the path of
   * the snapshot it took, or `null` when the operator has opted out. **Throwing aborts the walk
   * before anything is written** — which is the point: a snapshot that cannot be taken is a
   * reason not to touch the file, not a warning.
   */
  snapshot: (from: number) => string | null;
}

/**
 * Walk the file from its version to this build's, or do nothing.
 *
 * Returns what happened rather than logging it: the server prints the outcome as its own line so
 * the panel can tell the user their data was upgraded, and the CLI reports it in its envelope.
 * The walk itself never writes to stdout.
 */
export function runMigrations(db: Database.Database, hooks: MigrationHooks): MigrationOutcome {
  const from = currentVersion(db);

  // Before anything else: a file whose history cannot be trusted is not walked further.
  verifyApplied(db);

  const pending = pendingSteps(from);
  if (pending.length === 0) return { from, to: from, applied: [], backup: null };

  // Outside the transaction, and before it: `VACUUM INTO` cannot run inside one, and a snapshot
  // taken afterwards would be a snapshot of the damage.
  const backup = hooks.snapshot(from);

  db.pragma("foreign_keys = OFF");
  db.pragma("legacy_alter_table = ON");
  try {
    db.transaction(() => {
      // The history table first, and inside the transaction: a walk that fails must not leave a
      // table behind on a file it did not migrate. On a database from before this table existed
      // — which is every database today — the walk is the only thing that can create it, because
      // the DDL that also declares it has not run yet.
      db.exec(MIGRATION_HISTORY_DDL);

      for (const step of pending) {
        const started = Date.now();
        db.exec(step.sql);
        db.prepare(
          `INSERT INTO schema_migrations (version, id, checksum, applied_at, duration_ms)
           VALUES (@version, @id, @checksum, @appliedAt, @durationMs)`
        ).run({
          version: step.to,
          id: step.id,
          checksum: checksumOf(step),
          appliedAt: new Date().toISOString(),
          durationMs: Date.now() - started,
        });
        // Stamped inside the transaction, so the version and the history commit together — a
        // crash between them is not a state this file can be in.
        db.pragma(`user_version = ${step.to}`);
      }
    }).immediate();
  } catch (error) {
    throw new MigrationError(
      `Migrating ${pending.map((s) => s.id).join(", ")} failed; the database is unchanged at ` +
        `v${from}. ${error instanceof Error ? error.message : String(error)}`,
      "failed"
    );
  } finally {
    db.pragma("legacy_alter_table = OFF");
    db.pragma("foreign_keys = ON");
  }

  return { from, to: currentVersion(db), applied: pending, backup };
}

/**
 * Would this build *refuse* this file — as opposed to walking it forward?
 *
 * Read-only, like the check it wraps, so it is safe on a handle opened `{ readonly: true }`.
 */
export function openRefusal(db: Database.Database): { found: number; needed: number } | undefined {
  const problem = schemaProblem(db);
  if (!problem) return undefined;
  return canMigrate(problem.found) ? undefined : problem;
}

/**
 * Whether a version has a path to this build's schema. Pure, and read-only by construction, so
 * the administrator CLI can ask it about a file it must not write to.
 */
export function canMigrate(from: number): boolean {
  let version = from;
  // Bounded rather than `while (true)`: a step whose `to` points backwards would otherwise
  // spin forever, and the bound is the number of steps there could possibly be.
  for (let step = 0; step <= MIGRATIONS.length; step += 1) {
    if (version === SCHEMA_VERSION) return true;
    const next = MIGRATIONS.find((m) => m.from === version);
    if (!next) return false;
    version = next.to;
  }
  return false;
}
