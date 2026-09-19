import Database from "better-sqlite3";
import { existsSync, statSync } from "node:fs";
import type {
  AdminCliErrorBody,
  AdminCliErrorCode,
  AdminCliResult,
  AdminCreateResult,
  AdminResetResult,
  AdminStatusResult,
} from "@ilearnassist/shared";
import { isEnabledSuperadmin, SUPERADMIN_ROLE } from "@ilearnassist/shared";
import { apiError } from "./apiError.js";
import {
  createAccountRow,
  generatePassword,
  hashPassword,
  passwordProblem,
  revokeAllTokens,
  usernameProblem,
} from "./auth.js";
import { createDb, parseStoredRoles, seedBuiltInCopilots, type AppDb } from "./db.js";
import {
  MigrationError,
  appliedMigrations,
  canMigrate,
  currentVersion,
  pendingSteps,
  verifyApplied,
  type MigrationOutcome,
} from "./migrations.js";
import { MigrationBackupError } from "./backup.js";
import { SCHEMA_VERSION } from "./schema.js";
import { dataLayout, ensureUserLayout, userLayout } from "./paths.js";
import { applySchema, SchemaUnreadableError } from "./schema.js";
import { openRefusal } from "./migrations.js";

/**
 * Creating the installation's first administrator, and saying whether there is one.
 *
 * This is the whole of the bootstrap. It is deliberately **not** an HTTP route, because the
 * control panel has to be able to do it with the server stopped — and the server refuses to
 * listen until it has been done, so a route could never be reached in the state it serves.
 *
 * The logic lives here, free of `process`, argv and exit codes, for two reasons: vitest can
 * drive it directly (the `cli.ts` around it is plumbing that only a spawned child can prove),
 * and the panel spawns it rather than reimplementing it, so there is one copy of the schema,
 * the `scrypt` format and the slug rules in the product.
 *
 * Every entry point returns a value rather than throwing. The two callers — a terminal and a
 * control panel — need the same *codes* with different words, exactly as the HTTP routes and
 * their client catalogs do.
 */

/** A result, or the body to put on stderr. Exhaustive: there is no third outcome. */
export type AdminCliOutcome =
  | { ok: true; value: AdminCliResult }
  | { ok: false; body: AdminCliErrorBody };

const fail = (
  code: AdminCliErrorCode,
  message: string,
  params?: Record<string, string | number>
): AdminCliOutcome => ({ ok: false, body: apiError(code, message, params) });

/* ----------------------------- the server's rule ------------------------------ */

/**
 * The server refuses to *listen* without an administrator, and this is that refusal.
 *
 * It exists because removing the in-app bootstrap is what makes the state meaningful: the web
 * app cannot create an account, so a server that started without one would serve a sign-in form
 * that no credential can satisfy. Refusing at the door is the same shape as `resolveDataRoot` —
 * one actionable sentence, a non-zero exit, and never at module scope, because every test
 * imports this package.
 *
 * **It is about listening, not about touching.** By the time this runs, `buildServer` has
 * already created and migrated the database, pruned dead tokens and seeded providers from the
 * config — which is fine, because the CLI would do all of it a moment later anyway. Checking
 * *before* `createDb` instead would duplicate the read-only path above into the server, and two
 * implementations of "is there an administrator" is exactly how the panel comes to say there is
 * none while the server happily starts.
 */
export class NoAdministratorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoAdministratorError";
  }
}

/**
 * The environment variable the control panel sets on the children it spawns.
 *
 * **A flag, not a secret**, and the difference from what used to be here is the point: this
 * only decides which of two sentences to print. The panel's recovery path no longer goes
 * through a guarded HTTP route — it is the `reset-admin` command below, run as a one-shot child
 * on the operator's own machine — so there is no longer a secret for the panel to hold, and
 * nothing here grants anything. Anyone who can set this variable can already read the database.
 *
 * Spelled as a literal on both sides, like `ILA_HOST` and `ILA_PROJECT_ROOT`: the desktop app
 * writes it in `launch.ts` and this package reads it, and neither can import the other's copy.
 */
export const PANEL_LAUNCH_ENV = "ILA_LAUNCHED_BY_PANEL";

/**
 * The fix, named for whoever is reading it.
 *
 * A packaged launch has a button three centimetres away; a checkout has a terminal. Telling
 * either one about the other's remedy is a sentence the reader has to translate first, which is
 * why the two are separate rather than one message naming both.
 */
export function noAdministratorMessage(): string {
  if (process.env[PANEL_LAUNCH_ENV]) {
    return (
      "This data folder has no administrator, so there is nobody who could sign in.\n" +
      "Create one in the control panel — its window is open, and the button is on it."
    );
  }
  return (
    "This data folder has no administrator, so there is nobody who could sign in.\n" +
    "Create one first:\n" +
    "  pnpm --filter @ilearnassist/server cli create-admin --username <name> --generate"
  );
}

/**
 * Refuse to serve an installation nobody can administer.
 *
 * The predicate is `hasSuperadmin` rather than `hasPasswordAccounts`, and the difference is the
 * whole point: an account with a credential and no superadmin role can sign in and can manage
 * nothing, so an installation in that state needs the bootstrap as much as an empty one does.
 */
export function assertHasAdministrator(db: AppDb): void {
  if (db.hasSuperadmin()) return;
  throw new NoAdministratorError(noAdministratorMessage());
}

/* ---------------------------------- status ----------------------------------- */

interface AdminRow {
  id: string;
  username: string;
  roles: string;
  disabled: number;
}

/**
 * Whether this data root has an administrator — read-only, and safe on a file it cannot read.
 *
 * **Read-only is the requirement, not an optimisation.** It opens the file `readonly: true` and
 * runs no `applySchema`/`ensureColumn` and no `journal_mode` pragma, all of which write: one of
 * those migrations is an irreversible `DELETE FROM copilots`, and a *question* about a data
 * root must never be the thing that changes it.
 *
 * The taxonomy below is what keeps the answer honest. Answering "no administrator" for a
 * database that merely could not be *read* would make the panel offer to create one — which is
 * either a lie or, on a root that is fine, a second empty database beside the real one.
 */
export function adminStatus(dataRoot: string): AdminCliOutcome {
  const dirProblem = dataRootProblem(dataRoot);
  if (dirProblem) return dirProblem;

  const layout = dataLayout(dataRoot);

  // The ordinary first-run state, and not an error: a folder with no database is a folder
  // whose owner has not made an administrator yet, which is exactly what the panel is asking.
  if (!existsSync(layout.sqliteFile)) {
    return status(dataRoot, "absent", null);
  }

  let db: Database.Database;
  try {
    db = new Database(layout.sqliteFile, { readonly: true, fileMustExist: true });
  } catch (error) {
    return fail("UNREADABLE", messageOf(error));
  }

  try {
    /*
     * `openRefusal`, not `schemaProblem`: a file one version behind is not one this build
     * refuses — it is one the server walks forward on its next start — and reporting it as
     * unreadable would tell an operator to move a data root aside minutes before the thing
     * they are checking reads it happily. This is the same question `applySchema` asks.
     */
    const problem = openRefusal(db);
    if (problem) {
      return fail("SCHEMA_UNREADABLE", "the database is a schema this build cannot read", {
        found: problem.found,
        needed: problem.needed,
      });
    }

    /*
     * And the history, which `openRefusal` cannot see: a file whose version is right but whose
     * recorded step no longer matches this build's code is one the **server will refuse to
     * start** — `runMigrations` verifies before it walks, and `createDb` is where the boot dies.
     * Reporting it as healthy here would send an operator to look at the wrong thing, which is
     * exactly what this command exists to prevent.
     */
    const historyProblem = historyRefusal(db);
    if (historyProblem) return fail("MIGRATION_FAILED", historyProblem);

    // An empty SQLite file — one this build would happily adopt and create tables in — has no
    // `users` table. That is "no administrator", not a read failure, and checking for the table
    // is what tells the two apart without matching on SQLite's error strings.
    const hasUsers =
      (
        db
          .prepare(
            "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users') AS found"
          )
          .get() as { found: number }
      ).found === 1;

    const admin = hasUsers ? findAdministrator(db) : null;
    /*
     * What the file is, and what it would take to open it. Reported by a read-only command, so it
     * decides nothing — the panel uses it to say "this data folder needs upgrading" *before* the
     * user presses Start, rather than letting them find out from a server that will not come up.
     *
     * An empty file has no version to report: it is about to be created, so there is nothing to
     * walk and nothing to warn about.
     */
    const found = currentVersion(db);
    return status(dataRoot, "present", admin?.username ?? null, {
      found,
      needed: SCHEMA_VERSION,
      pending: pendingSteps(found).length,
    });
  } catch (error) {
    // A file that is not a database at all throws here rather than at `new Database`, because
    // SQLite reads lazily and only notices on the first statement.
    return fail(isNotADatabase(error) ? "NOT_A_DATABASE" : "UNREADABLE", messageOf(error));
  } finally {
    db.close();
  }
}

function status(
  dataRoot: string,
  database: "absent" | "present",
  adminUsername: string | null,
  schema: AdminStatusResult["schema"] = null
): AdminCliOutcome {
  const value: AdminStatusResult = {
    ok: true,
    command: "status",
    dataRoot,
    database,
    hasAdmin: adminUsername !== null,
    schema,
    adminUsername,
  };
  return { ok: true, value };
}

/** The first enabled superadmin, or undefined. The predicate `hasSuperadmin` asks over SQL. */
function findAdministrator(db: Database.Database): AdminRow | undefined {
  const rows = db
    .prepare("SELECT id, username, roles, disabled FROM users ORDER BY username COLLATE NOCASE ASC")
    .all() as AdminRow[];
  return rows.find((row) =>
    isEnabledSuperadmin({
      roles: parseStoredRoles(row.roles),
      disabled: row.disabled !== 0,
    })
  );
}

/* -------------------------------- create-admin -------------------------------- */

export interface CreateAdminInput {
  dataRoot: string;
  username: string;
  /**
   * The plaintext password, or undefined to invent one.
   *
   * An invented one comes back on the result and is shown exactly once — only a hash is
   * stored, so there is no reading it again. That is the terminal's path; the control panel
   * takes a typed one, because the operator is choosing their own credential and has nobody to
   * transmit it to.
   */
  password?: string;
  /** Do nothing if an administrator already exists, rather than refusing. */
  ensureOnly?: boolean;
}

/**
 * Create the installation's first administrator, or adopt the account that owns its work.
 *
 * Three things here are load-bearing, and the first two are the ones a route got away with not
 * having:
 *
 * - **The check and the write are one transaction, taken with `BEGIN IMMEDIATE`.** An earlier
 *   HTTP route re-checked the predicate after its ~100ms `scrypt` and argued the pair was
 *   atomic "because there is no `await` between them". That argument does not survive a process
 *   boundary: two CLIs, or a CLI and a `pnpm dev`, each hash, each re-check, each write. The
 *   lock is what makes exactly one win.
 * - **The row and the directory tree are separate.** A transaction must not contain a `mkdir`,
 *   and it does not need to: `ensureUserLayout` is `mkdirSync(recursive)`, so a tree that was
 *   never created appears the first time anything touches it.
 * - **It adopts a passwordless account of the same name.** A data root carried over from the
 *   build where a username *was* the credential has accounts and no passwords, and the one
 *   sharing this name is the one whose workspaces are on disk — creating a second account
 *   beside it would strand them.
 */
export async function createAdmin(input: CreateAdminInput): Promise<AdminCliOutcome> {
  const dirProblem = dataRootProblem(input.dataRoot);
  if (dirProblem) return dirProblem;

  const username = input.username.trim();
  const named = usernameProblem(username);
  if (named) return { ok: false, body: named };

  // Both of these are the *shared* policy — the same two functions the HTTP routes enforce —
  // so a password is too short on either channel for the same reason and by the same rule.
  let password: string;
  let generated = false;
  if (input.password === undefined) {
    password = generatePassword();
    generated = true;
  } else {
    const weak = passwordProblem(input.password);
    if (weak) return { ok: false, body: weak };
    password = input.password;
  }

  // Hashed *before* the lock is taken. `scrypt` is ~100ms and no transaction should be held
  // open across it — the whole point of the immediate lock is that it is held for the write.
  const passwordHash = await hashPassword(password);

  const layout = dataLayout(input.dataRoot);
  let db;
  try {
    // Unlike `status`, this one is allowed to write: `createDb` applies the schema and the
    // migrations, which is right here — the command's whole purpose is to make the database
    // usable — and it is why the read-only path above exists separately.
    db = createDb(layout.sqliteFile);
  } catch (error) {
    if (error instanceof SchemaUnreadableError) {
      return fail("SCHEMA_UNREADABLE", error.message, {
        found: error.found,
        needed: error.needed,
      });
    }
    return fail(isNotADatabase(error) ? "NOT_A_DATABASE" : "UNREADABLE", messageOf(error));
  }

  try {
    let outcome: AdminCliOutcome | undefined;
    let newSlug: string | null = null;

    db.raw
      .transaction(() => {
        const existingAdmin = db.listUsers().find(isEnabledSuperadmin);
        if (existingAdmin) {
          if (input.ensureOnly) {
            outcome = {
              ok: true,
              value: made("ensure-admin", input.dataRoot, existingAdmin, {
                created: false,
                adopted: false,
                generated: false,
              }),
            };
            return;
          }
          outcome = fail(
            "ADMIN_EXISTS",
            "this installation already has an administrator",
            { username: existingAdmin.username }
          );
          return;
        }

        const adoptable = db.findUserByUsername(username);
        let user;
        if (adoptable) {
          // Re-enabled as well as given a password: this command only runs when nobody can
          // administer the installation, so an account left disabled here is a lock with no
          // key rather than a policy. One statement each, inside the transaction, so no reader
          // sees a passwordless superadmin in between — the state the predicate above exists
          // to tell apart from a finished bootstrap.
          db.setUserDisabled(adoptable.id, false);
          db.setUserRoles(adoptable.id, [SUPERADMIN_ROLE]);
          user = db.setUserPassword(adoptable.id, passwordHash, false)!;
          revokeAllTokens(db, adoptable.id);
        } else {
          user = createAccountRow(db, layout, {
            username,
            roles: [SUPERADMIN_ROLE],
            passwordHash,
            // They chose it, so there is nothing to change it to.
            mustChangePassword: false,
          });
          newSlug = user.slug;
        }

        /*
         * Inside the transaction, and after the account exists — the built-in assistants need
         * an owner, and "an administrator exists" and "the assistants a new installation ships"
         * should land together or not at all. A half-bootstrap whose Copilots are missing is a
         * state no later boot repairs, because the marker is written here.
         */
        seedBuiltInCopilots(db, user.id);

        outcome = {
          ok: true,
          value: {
            ...made(input.ensureOnly ? "ensure-admin" : "create-admin", input.dataRoot, user, {
              created: true,
              // Whether the row was already there. A root carried over from the build where a
              // username was the credential has accounts and no passwords, and the one sharing
              // this name owns the workspaces — so "adopted" is the honest word for it, and the
              // panel says so rather than claiming to have made something.
              adopted: Boolean(adoptable),
              generated,
            }),
            password: generated ? password : undefined,
          },
        };
      })
      .immediate();

    // Outside the transaction on purpose — see the note on `createAccount`.
    if (newSlug) ensureUserLayout(userLayout(layout, newSlug));

    return outcome ?? fail("INTERNAL", "the transaction produced no result");
  } catch (error) {
    return fail("INTERNAL", messageOf(error));
  } finally {
    db.raw.close();
  }
}

/**
 * Whether this file's recorded history matches the code, or the sentence saying why not.
 *
 * One place, because two commands ask it and the answer has to be the same one the server will
 * give. `verifyApplied` throws; this turns that into a message for a caller that reports rather
 * than refuses.
 */
function historyRefusal(db: Database.Database): string | null {
  try {
    verifyApplied(db);
    return null;
  } catch (error) {
    return error instanceof MigrationError ? error.message : messageOf(error);
  }
}

/* ----------------------------------- migrate ---------------------------------- */

/**
 * What the database is, and what a walk would do to it. **Read-only**, like `status`.
 *
 * The history is reported rather than summarised, because the question an operator has when they
 * run this is "which migrations has this database been through", and a count is not an answer to
 * it. `pending` is the other half: what a `migrate-up` would run.
 */
export function migrationStatus(dataRoot: string): AdminCliOutcome {
  const dirProblem = dataRootProblem(dataRoot);
  if (dirProblem) return dirProblem;

  const layout = dataLayout(dataRoot);
  if (!existsSync(layout.sqliteFile)) {
    return fail("DATA_DIR_INVALID", "there is no database in this data root yet", {
      path: layout.sqliteFile,
    });
  }

  let db: Database.Database;
  try {
    db = new Database(layout.sqliteFile, { readonly: true, fileMustExist: true });
  } catch (error) {
    return fail("UNREADABLE", messageOf(error));
  }

  try {
    const found = currentVersion(db);
    const blocked = openRefusal(db);
    // The other thing that makes a file unopenable, and the one a version number cannot show.
    const historyProblem = historyRefusal(db);
    return {
      ok: true,
      value: {
        ok: true,
        command: "migrate-status",
        dataRoot,
        found,
        needed: SCHEMA_VERSION,
        // Reported even when the file is refused: "there is no way to carry this" and "there is
        // nothing to carry" are different answers, and the caller renders them differently.
        walkable: canMigrate(found) && historyProblem === null,
        pending:
          blocked || historyProblem
            ? []
            : pendingSteps(found).map((s) => ({ id: s.id, from: s.from, to: s.to })),
        applied: appliedMigrations(db),
        blocker: blocked ?? null,
        historyProblem,
      },
    };
  } catch (error) {
    return fail(isNotADatabase(error) ? "NOT_A_DATABASE" : "UNREADABLE", messageOf(error));
  } finally {
    db.close();
  }
}

/**
 * Walk the database up to this build's schema — deliberately, with the snapshot `createDb` takes.
 *
 * `createDb` already migrates whenever it opens a file, so why does this exist? Because a walk is
 * the one operation that rewrites a user's only copy of their data, and some operators want to run
 * it with the server stopped, on purpose, and see what happened — rather than discovering it in
 * the logs of a boot they did not watch. It is the same code path, so there is no second
 * implementation to drift; this is the explicit door.
 */
export function migrateUp(dataRoot: string): AdminCliOutcome {
  const dirProblem = dataRootProblem(dataRoot);
  if (dirProblem) return dirProblem;

  const layout = dataLayout(dataRoot);
  if (!existsSync(layout.sqliteFile)) {
    return fail("DATA_DIR_INVALID", "there is no database in this data root yet", {
      path: layout.sqliteFile,
    });
  }

  let outcome: MigrationOutcome | undefined;
  try {
    const db = createDb(layout.sqliteFile, { onMigrated: (result) => (outcome = result) });
    db.raw.close();
  } catch (error) {
    if (error instanceof SchemaUnreadableError) {
      return fail("SCHEMA_UNREADABLE", error.message, {
        found: error.found,
        needed: error.needed,
      });
    }
    if (error instanceof MigrationBackupError) {
      return fail("MIGRATION_BACKUP_FAILED", error.message);
    }
    if (error instanceof MigrationError) {
      return fail("MIGRATION_FAILED", error.message);
    }
    return fail(isNotADatabase(error) ? "NOT_A_DATABASE" : "UNREADABLE", messageOf(error));
  }

  // No `onMigrated` means the file was already current: nothing to report but the truth.
  const result = outcome;
  return {
    ok: true,
    value: {
      ok: true,
      command: "migrate-up",
      dataRoot,
      from: result?.from ?? currentVersionOf(layout.sqliteFile),
      to: currentVersionOf(layout.sqliteFile),
      applied: result?.applied.map((s) => s.id) ?? [],
      backup: result?.backup ?? null,
    },
  };
}

/** The version, through a fresh read-only handle — for reporting after `createDb` has closed its own. */
function currentVersionOf(sqliteFile: string): number {
  const db = new Database(sqliteFile, { readonly: true, fileMustExist: true });
  try {
    return currentVersion(db);
  } finally {
    db.close();
  }
}

/* --------------------------------- reset-admin --------------------------------- */

export interface ResetAdminInput {
  dataRoot: string;
  /** Who to reset. Absent means the first enabled superadmin — the panel's case. */
  username?: string;
  /**
   * The new password the operator chose, or undefined to invent one.
   *
   * The control panel always hands one in: the person at that machine is assumed to *be* the
   * superadmin, the same assumption `create-admin` makes for the first one, so they choose the
   * replacement rather than being given a random one to read and change. A chosen password is
   * never echoed back on the result. `--generate` remains the terminal's path, and only that
   * path returns the password.
   */
  password?: string;
}

/**
 * Replace a superadmin's password — chosen by the operator, or invented and handed back.
 *
 * The way back in for a forgotten password, and it runs **with the server stopped or running**
 * — which is what the panel needs, because the state a forgotten password creates is often
 * also a state where starting a server is not the first thing on the agenda. It is a write, so
 * unlike `adminStatus` this command cannot be read-only; what it deliberately does *not* do is
 * migrate: it opens the file, refuses one this build cannot read, and runs plain `UPDATE`s. DDL
 * from a second process while the server is up would be a schema change racing the one the
 * server already applied.
 *
 * **Only a superadmin.** The panel is the one place the physical machine is the proof of
 * identity, and the account it recovers is the one that can undo everything — so an ordinary
 * administrator's password is not this command's business. It is also the *only* way a
 * superadmin's own password is replaced: the web console refuses it, because a console reached
 * with a credential the caller already holds is a weaker second way in.
 *
 * `mustChangePassword` is left clear. Whoever ran this is holding the machine: a generated
 * password is one they just produced for themselves, and a chosen one is theirs already.
 */
export async function resetAdmin(input: ResetAdminInput): Promise<AdminCliOutcome> {
  const dirProblem = dataRootProblem(input.dataRoot);
  if (dirProblem) return dirProblem;

  // The same shared policy create-admin enforces, so "too short" is refused by the same rule
  // and with the same code whichever channel the password arrived on.
  const chosen = input.password;
  if (chosen !== undefined) {
    const weak = passwordProblem(chosen);
    if (weak) return { ok: false, body: weak };
  }

  const layout = dataLayout(input.dataRoot);
  if (!existsSync(layout.sqliteFile)) {
    return fail("ADMIN_NOT_FOUND", "this data folder has no administrator to reset");
  }

  let db: Database.Database;
  try {
    // Read-write, because this is a write. `fileMustExist` keeps a typo'd data root from
    // creating an empty database whose only administrator is the one it does not have.
    db = new Database(layout.sqliteFile, { fileMustExist: true });
  } catch (error) {
    return fail("UNREADABLE", messageOf(error));
  }

  try {
    /*
     * `openRefusal`, not `schemaProblem`: a file one version behind is not one this build
     * refuses — it is one the server walks forward on its next start — and reporting it as
     * unreadable would tell an operator to move a data root aside minutes before the thing
     * they are checking reads it happily. This is the same question `applySchema` asks.
     */
    const problem = openRefusal(db);
    if (problem) {
      return fail("SCHEMA_UNREADABLE", "the database is a schema this build cannot read", {
        found: problem.found,
        needed: problem.needed,
      });
    }

    /*
     * And the history, which `openRefusal` cannot see: a file whose version is right but whose
     * recorded step no longer matches this build's code is one the **server will refuse to
     * start** — `runMigrations` verifies before it walks, and `createDb` is where the boot dies.
     * Reporting it as healthy here would send an operator to look at the wrong thing, which is
     * exactly what this command exists to prevent.
     */
    const historyProblem = historyRefusal(db);
    if (historyProblem) return fail("MIGRATION_FAILED", historyProblem);

    const target = input.username?.trim()
      ? findSuperadminByName(db, input.username.trim())
      : findAdministrator(db);
    if (!target) {
      return fail("ADMIN_NOT_FOUND", "this data folder has no administrator to reset");
    }

    const generated = chosen === undefined;
    const password = generated ? generatePassword() : chosen;
    // Hashed outside any transaction, exactly as `createAdmin` does: `scrypt` is ~100ms and no
    // lock should be held across it.
    const passwordHash = await hashPassword(password);

    // Both statements in one transaction, so no reader sees a password replaced while the
    // sessions issued under the old one are still live.
    db.transaction(() => {
      db.prepare("UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?").run(
        passwordHash,
        target.id
      );
      // The reset is also the kick: a forgotten password that is replaced while the old session
      // is still live has not really been replaced.
      db.prepare("UPDATE auth_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(
        new Date().toISOString(),
        target.id
      );
    }).immediate();

    const value: AdminResetResult = {
      ok: true,
      command: "reset-admin",
      dataRoot: input.dataRoot,
      username: target.username,
      // Only an invented password is handed back: the caller already knows one they chose, and
      // echoing it over the IPC boundary would be a leak with no upside.
      ...(generated ? { password } : {}),
    };
    return { ok: true, value };
  } catch (error) {
    return fail("INTERNAL", messageOf(error));
  } finally {
    db.close();
  }
}

/** One superadmin by name, enabled or not — a lock with no key is what this command undoes. */
function findSuperadminByName(db: Database.Database, username: string): AdminRow | undefined {
  const row = db
    .prepare(
      "SELECT id, username, roles, disabled FROM users WHERE username = ? COLLATE NOCASE LIMIT 1"
    )
    .get(username) as AdminRow | undefined;
  if (!row) return undefined;
  return parseStoredRoles(row.roles).includes(SUPERADMIN_ROLE) ? row : undefined;
}

/** The parts of a success that do not depend on whether a password was invented. */
function made(
  command: "create-admin" | "ensure-admin",
  dataRoot: string,
  user: { username: string; slug: string },
  facts: { created: boolean; adopted: boolean; generated: boolean }
): AdminCreateResult {
  return {
    ok: true,
    command,
    dataRoot,
    created: facts.created,
    username: user.username,
    slug: user.slug,
    adopted: facts.adopted,
    generated: facts.generated,
  };
}

/* ---------------------------------- the root ---------------------------------- */

/**
 * Why the data root itself cannot be used, or undefined.
 *
 * A *nonexistent* folder is not a problem — it is where the database is about to be created,
 * and it is the ordinary first-run case. A path that is a **file**, or one that cannot be read
 * as a directory, is, and saying so is more useful than the `ENOTDIR` sqlite would raise three
 * frames down.
 */
function dataRootProblem(dataRoot: string): AdminCliOutcome | undefined {
  if (!existsSync(dataRoot)) return undefined;
  try {
    if (!statSync(dataRoot).isDirectory()) {
      return fail("DATA_DIR_INVALID", "that path is a file, not a folder", { path: dataRoot });
    }
  } catch (error) {
    return fail("DATA_DIR_INVALID", messageOf(error), { path: dataRoot });
  }
  return undefined;
}

/* ------------------------------------ misc ------------------------------------ */

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Whether SQLite is telling us this file is not a database.
 *
 * Matched on the message because that is all `better-sqlite3` gives — the code lives in
 * `error.code`, which is `SQLITE_NOTADB`, and that is checked first for exactly that reason.
 */
function isNotADatabase(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  if (code === "SQLITE_NOTADB") return true;
  return /file is not a database|file is encrypted/i.test(messageOf(error));
}
