import Database from "better-sqlite3";
import { existsSync, statSync } from "node:fs";
import type {
  AdminCliErrorBody,
  AdminCliErrorCode,
  AdminCliResult,
  AdminCreateResult,
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
import { panelToken } from "./auth.js";
import { createDb, parseStoredRoles, type AppDb } from "./db.js";
import { dataLayout, ensureUserLayout, userLayout } from "./paths.js";
import { applySchema, schemaProblem, SchemaUnreadableError } from "./schema.js";

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
 * The fix, named for whoever is reading it.
 *
 * `ILA_PANEL_TOKEN` is set only by the control panel — it is the launch-scoped secret the
 * recovery route is guarded by — so its presence is a reliable way to tell a packaged launch
 * from a checkout, and the two need different words: one has a button, the other has a command.
 */
export function noAdministratorMessage(): string {
  if (panelToken()) {
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
    const problem = schemaProblem(db);
    if (problem) {
      return fail("SCHEMA_UNREADABLE", "the database is a schema this build cannot read", {
        found: problem.found,
        needed: problem.needed,
      });
    }

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
    return status(dataRoot, "present", admin?.username ?? null);
  } catch (error) {
    // A file that is not a database at all throws here rather than at `new Database`, because
    // SQLite reads lazily and only notices on the first statement.
    return fail(isNotADatabase(error) ? "NOT_A_DATABASE" : "UNREADABLE", messageOf(error));
  } finally {
    db.close();
  }
}

function status(dataRoot: string, database: "absent" | "present", adminUsername: string | null): AdminCliOutcome {
  const value: AdminStatusResult = {
    ok: true,
    command: "status",
    dataRoot,
    database,
    hasAdmin: adminUsername !== null,
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
