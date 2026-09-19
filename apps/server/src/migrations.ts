import type Database from "better-sqlite3";
import { SCHEMA_VERSION, schemaProblem } from "./schema.js";

/**
 * The version guard, and the shape the next migration will take — there are no steps today.
 *
 * `schemaProblem` answers the narrow question the module that declares the version should be
 * able to answer on its own: "is this file exactly my version". That is not the question a
 * *reporter* has. A v2 file was not one this build refused, it was one it upgraded — so the
 * administrator CLI asking `schemaProblem` told an operator their data root was unreadable
 * minutes before the server walked it without complaint. `openRefusal` is the same question
 * asked once, with the walk taken into account, and it is what the CLI and the boot path use.
 *
 * **The walk is empty at v4, and that is a decision rather than an omission.** The 大改造
 * splits one table into three and changes what the bytes' locator means; there is no pure
 * function of the rows that produces the new shape honestly — a v3 `sources` row's owner would
 * have to be guessed for every row whose links disagree, and a wrong owner is worse than a file
 * that will not open, because nothing downstream can tell it is wrong. So a v3 data root is
 * refused, and the upgrade is deleting it: the workspaces, the sessions and every file on disk
 * survive that untouched, and only the registry is rebuilt.
 *
 * `canMigrate` keeps its loop over `MIGRATIONS` rather than collapsing to `from ===
 * SCHEMA_VERSION`, so that the next migration is an entry in the array and nothing else. With
 * the list empty the two are the same function.
 */

export interface SchemaStep {
  from: number;
  to: number;
  run: (db: Database.Database) => void;
}

/**
 * No steps. See the note above for why v3 → v4 is a refusal rather than a step.
 *
 * When a step *is* added, three properties are what make a walk safe rather than merely
 * convenient, and all three were learned by the v2 → v3 rebuild this array used to hold:
 *
 * - **Each step is single-hop and total.** `{from: 2, to: 3}` is one upgrade; a file two versions
 *   behind runs two steps, and a version with no step out of it is refused, not guessed at.
 * - **The whole walk is one transaction, stamped after each step.** A failure anywhere leaves the
 *   file at the version it started on — the promise the guard makes, kept.
 * - **Foreign keys are off, and `legacy_alter_table` is on, for the duration.** Not a
 *   preference: `foreign_keys` is ON in this app, and with it on, `ALTER TABLE … RENAME`
 *   rewrites the `REFERENCES` clauses of every table pointing at the renamed one, and dropping
 *   the old table then fires their `ON DELETE CASCADE`. Both pragmas are per-connection and
 *   neither can be set from inside a transaction, so the toggling has to bracket the
 *   transaction rather than live in it.
 */
export const MIGRATIONS: SchemaStep[] = [];

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
