import type Database from "better-sqlite3";
import { classifySource } from "./sourceCategory.js";
import { DDL, SCHEMA_VERSION, schemaProblem } from "./schema.js";

/**
 * Walking a database forward, and the first time this project has ever needed to.
 *
 * Until v3 the policy was *refuse*: `schemaProblem` rejects any file whose `user_version` is
 * not this build's, because a database can be read wrong in ways no missing column reveals.
 * That policy is still in force for every case it can be — a file from the future, a file from
 * before versioning existed, a file at a version with no path forward. What changed is that
 * exactly one upgrade is now expressible as a pure function of the rows, so it is a migration
 * instead of a refusal.
 *
 * Three properties make that safe rather than merely convenient, and all three are load-bearing:
 *
 * - **Each step is single-hop and total.** `{from: 2, to: 3}` is one upgrade; a v2 file reaching
 *   a v5 build runs two steps, and a version with no step out of it is refused, not guessed at.
 * - **The whole walk is one transaction, stamped after each step.** A failure anywhere leaves
 *   the file at the version it started on — the promise the guard's own docblock makes, kept.
 * - **Foreign keys are off, and `legacy_alter_table` is on, for the duration.** Not a
 *   preference: `foreign_keys` is ON in this app, and with it on, `ALTER TABLE … RENAME` would
 *   rewrite the `REFERENCES sources` clauses in `session_sources` and `workspace_sources` to
 *   point at the temporary name, and dropping the old table would fire their `ON DELETE CASCADE`
 *   and take every link row with it. Both pragmas are per-connection and neither can be changed
 *   from inside a transaction, which is why this runs *before* the transaction `createDb` opens.
 */

export interface SchemaStep {
  from: number;
  to: number;
  run: (db: Database.Database) => void;
}

/**
 * Would this build *refuse* this file — as opposed to walking it forward?
 *
 * `schemaProblem` answers the narrow question it always did ("is this exactly my version"), and
 * that is the right shape for the module that declares the version: it needs no knowledge of
 * the steps, and the version history stays a fact rather than a policy. But a v2 file is not a
 * file this build refuses — it is one it upgrades — so anything *reporting* on a file has to
 * ask this instead, or the administrator CLI tells an operator their data root is unreadable
 * minutes before the server walks it without complaint.
 *
 * Read-only, like the check it wraps, so it is safe on a handle opened `{ readonly: true }`.
 */
export function openRefusal(db: Database.Database): { found: number; needed: number } | undefined {
  const problem = schemaProblem(db);
  if (!problem) return undefined;
  return canMigrate(problem.found) ? undefined : problem;
}

/**
 * Whether the file would be walked on the next open. The other half of the question above, for
 * a caller that wants to *say* an upgrade is coming rather than merely to proceed.
 */
export function pendingUpgrade(db: Database.Database): number | undefined {
  const problem = schemaProblem(db);
  return problem && canMigrate(problem.found) ? problem.found : undefined;
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

/** The v2 shape, only as much of it as the copy reads. */
interface V2SourceRow {
  id: string;
  user_id: string;
  sha256: string | null;
  name: string;
  mime_type: string;
  size: number;
  parse_status: string;
  parse_error: string | null;
  parse_error_code: string | null;
  parser_id: string | null;
  parsed_chars: number | null;
  page_count: number | null;
  parse_updated_at: string | null;
  created_at: string;
  deleted_at: string | null;
}

/**
 * 2 → 3: every uploaded file becomes a source with an owner, a place and a category.
 *
 * The rebuild the identity change needs. An uploaded file's owner is recoverable and nothing
 * else is: `session_sources` names the conversation it arrived in, and the workspace link is
 * the fallback for a row whose session link somehow went. **A source with neither is a refusal,
 * not a guess** — an owner that is wrong is worse than a file that will not open, because
 * nothing downstream can tell it is wrong.
 *
 * `raw_path` and `kind` are simply not carried over. The first was always a cache of
 * `sources/raw/<id>.<ext>` computed from the id and the MIME type — `paths.ts` says so in its
 * own words — so the new build finds the same file by deriving what the old one stored. The
 * second is `category === "image"` or not. Carrying either forward would be carrying forward a
 * second source of truth for something already known.
 *
 * The order matters: the old table is renamed out of the way **and its index dropped** before
 * the DDL runs, because an index keeps its name when its table is renamed, and a
 * `CREATE INDEX IF NOT EXISTS` that silently did nothing would leave the new table with the
 * index it needs dropped along with the old table.
 */
function migrateV2ToV3(db: Database.Database): void {
  db.exec("ALTER TABLE sources RENAME TO sources_v2");
  db.exec("DROP INDEX IF EXISTS idx_sources_user");

  // Creates `sources` with its new shape and its two partial unique indexes. Idempotent, and
  // the same statement a fresh database gets — one description of the table, not two.
  db.exec(DDL);

  const rows = db.prepare("SELECT * FROM sources_v2").all() as V2SourceRow[];

  const sessionOwner = db.prepare(
    `SELECT ss.session_id AS id FROM session_sources ss
       JOIN sessions s ON s.id = ss.session_id
       JOIN workspaces w ON w.id = s.workspace_id
      WHERE ss.source_id = ? AND w.user_id = ?
      ORDER BY ss.created_at ASC, ss.session_id ASC LIMIT 1`
  );
  const workspaceOwner = db.prepare(
    `SELECT ws.workspace_id AS id FROM workspace_sources ws
       JOIN workspaces w ON w.id = ws.workspace_id
      WHERE ws.source_id = ? AND w.user_id = ?
      ORDER BY ws.created_at ASC, ws.workspace_id ASC LIMIT 1`
  );

  const insert = db.prepare(
    `INSERT INTO sources
       (id, user_id, owner_kind, owner_id, origin, storage, rel_path, name, mime_type, category,
        size, source_url, summary, sha256, parse_status, parse_error, parse_error_code,
        parser_id, parsed_chars, page_count, parse_updated_at, created_at, updated_at, deleted_at)
     VALUES
       (@id, @userId, @ownerKind, @ownerId, 'session_attachment', 'upload', NULL, @name,
        @mimeType, @category, @size, NULL, NULL, @sha256, @parseStatus, @parseError,
        @parseErrorCode, @parserId, @parsedChars, @pageCount, @parseUpdatedAt, @createdAt,
        NULL, @deletedAt)`
  );

  for (const row of rows) {
    const session = sessionOwner.get(row.id, row.user_id) as { id: string } | undefined;
    const workspace = session ? undefined : (workspaceOwner.get(row.id, row.user_id) as { id: string } | undefined);
    if (!session && !workspace) {
      throw new Error(
        `Cannot upgrade source ${row.id}: it is linked to no live session or workspace, so ` +
          `there is no owner to record for it.`
      );
    }

    insert.run({
      id: row.id,
      userId: row.user_id,
      ownerKind: session ? "session" : "workspace",
      ownerId: session?.id ?? workspace?.id,
      name: row.name,
      mimeType: row.mime_type,
      // The classifier, not a `CASE` in SQL: one place decides what a file is, and the
      // migration is a caller of it like any other.
      category: classifySource(row.name, row.mime_type).category,
      size: row.size,
      sha256: row.sha256,
      parseStatus: row.parse_status,
      parseError: row.parse_error,
      parseErrorCode: row.parse_error_code,
      parserId: row.parser_id,
      parsedChars: row.parsed_chars,
      pageCount: row.page_count,
      parseUpdatedAt: row.parse_updated_at,
      createdAt: row.created_at,
      deletedAt: row.deleted_at,
    });
  }

  db.exec("DROP TABLE sources_v2");
}

export const MIGRATIONS: SchemaStep[] = [{ from: 2, to: 3, run: migrateV2ToV3 }];

/**
 * Walk the file forward if it can be walked, and do nothing at all if it cannot.
 *
 * "Cannot" is not this function's problem to report: an unreadable file is `applySchema`'s
 * refusal to make, with the message it already has. This only ever moves a file that has a
 * path, and returns how many steps it took so a test — or a log reader — can tell a migration
 * from a no-op.
 */
export function migrateIfNeeded(db: Database.Database): number {
  const problem = schemaProblem(db);
  if (!problem || !canMigrate(problem.found)) return 0;

  let applied = 0;
  db.pragma("foreign_keys = OFF");
  db.pragma("legacy_alter_table = ON");
  try {
    db.transaction(() => {
      // Re-read inside the transaction: two processes open the same data root, and the loser
      // must find nothing to do rather than run the rebuild over an already-rebuilt table.
      let version = db.pragma("user_version", { simple: true }) as number;
      for (const step of MIGRATIONS) {
        if (step.from !== version) continue;
        step.run(db);
        version = step.to;
        db.pragma(`user_version = ${version}`);
        applied += 1;
      }
    }).immediate();
  } finally {
    db.pragma("legacy_alter_table = OFF");
    db.pragma("foreign_keys = ON");
  }

  return applied;
}
