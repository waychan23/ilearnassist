import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";

/**
 * The snapshot taken before a migration walk.
 *
 * **This is the only thing in the codebase that protects a user's data from a migration**, and it
 * is worth stating why it is here rather than in the user's hands. Everything else about a walk is
 * recoverable: a failed step rolls back, a bad step is fixed in the next release. What is not
 * recoverable is a walk that *succeeds* and turns out to have been wrong — a dropped column whose
 * data nobody needed until they did, a rewrite that lost a distinction. `user_version` cannot go
 * backwards and the old code is gone, so the only copy of the old shape is a file taken before
 * the walk.
 *
 * The rules that follow from that, and each one is a decision:
 *
 * - **`VACUUM INTO`, never a file copy.** The database runs in WAL mode (`db.ts`), so the bytes
 *   of `<name>.sqlite` are not the database — anything committed since the last checkpoint lives
 *   in `-wal`. Measured on this app's own engine, with WAL and without a checkpoint: a
 *   `copyFileSync` of the `.sqlite` produced a **4096-byte file containing no tables at all**,
 *   because the schema itself was still in the WAL. After `wal_checkpoint(TRUNCATE)` the identical
 *   copy contained everything. So the failure is not "loses the last few minutes" — it is
 *   *intermittent and total*, and intermittent is worse: it produces a green test on the machine
 *   that happened to checkpoint and an empty database on the user's. `VACUUM INTO` goes through
 *   SQLite, is WAL-safe, and writes one compact file. (The path is bound as a parameter, so a
 *   folder name containing a quote is handled rather than interpolated.)
 * - **A snapshot that cannot be taken stops the walk.** Failing here is refusing to migrate, and
 *   that is the right trade: a disk with no room for a copy has no room for the migration either,
 *   and a server that will not start is a problem the user can see, while a migration that ate
 *   their work is one they cannot.
 * - **`ILA_SKIP_MIGRATION_BACKUP=1` is the escape hatch**, and it exists for a deployment that
 *   already takes its own volume-level snapshots — a Docker host, a managed disk. It is off by
 *   default and named in `.env.example`, because the failure it prevents (a second copy of a
 *   multi-gigabyte file) is much smaller than the failure it can cause.
 * - **The directory is inside the data root.** "Back up your work" is already "copy this folder",
 *   and a snapshot kept somewhere else would quietly break that sentence.
 */

/**
 * How many snapshots to keep.
 *
 * Small on purpose: each one is a full copy of the database, and the ones that matter are the
 * most recent few — the walk that just ran and the one before it. A user who wants history keeps
 * their own copies.
 */
export const MAX_SNAPSHOTS = 5;

/** Set to `1` to migrate without taking a snapshot. See the docblock for who that is for. */
export const SKIP_BACKUP_ENV = "ILA_SKIP_MIGRATION_BACKUP";

/** Raised when a snapshot was needed and could not be taken. The walk must not proceed. */
export class MigrationBackupError extends Error {
  constructor(
    message: string,
    readonly path: string
  ) {
    super(message);
    this.name = "MigrationBackupError";
  }
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** Whether the operator has said this deployment has its own backups. */
export function backupSkipped(env: NodeJS.ProcessEnv = process.env): boolean {
  return TRUTHY.has((env[SKIP_BACKUP_ENV] ?? "").trim().toLowerCase());
}

/**
 * The snapshot's name: the version being left behind, then the moment.
 *
 * The version is in the name rather than only in the timestamp because it is what someone
 * restoring from it needs to know — "this is the file as it was at v5" answers the question the
 * filename should answer, and a bare timestamp makes them open it to find out.
 */
export function snapshotName(from: number, at: Date): string {
  const stamp = at.toISOString().replace(/\.\d+Z$/, "").replace("T", "-").replace(/:/g, "");
  return `ilearnassist-v${from}-${stamp}.sqlite`;
}

/** `base`, or `base-2`, `base-3`… — `VACUUM INTO` refuses to overwrite an existing file. */
function uniquePath(path: string): string {
  if (!existsSync(path)) return path;
  const stem = path.replace(/\.sqlite$/, "");
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${stem}-${n}.sqlite`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`could not find a free snapshot name beside ${path}`);
}

/** The snapshots in this directory, oldest first. Only this app's own naming is considered. */
export function listSnapshots(backupsDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(backupsDir);
  } catch {
    // No directory means no snapshots, which is the state before the first walk.
    return [];
  }
  return names
    .filter((name) => /^ilearnassist-v\d+-.*\.sqlite$/.test(name))
    .map((name) => join(backupsDir, name))
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
}

/**
 * Delete the oldest snapshots beyond the cap. Exported because "it keeps five" is a claim that
 * needs a test — a retention rule nobody checks is a directory that grows until the disk fills.
 *
 * Oldest-first by **mtime**, not by the name: the name sorts correctly only while the naming
 * scheme does not change, and a file's own timestamp is the fact that survives a rename.
 */
export function pruneSnapshots(backupsDir: string, keep: number = MAX_SNAPSHOTS): string[] {
  const snapshots = listSnapshots(backupsDir);
  const doomed = keep <= 0 ? snapshots : snapshots.slice(0, Math.max(0, snapshots.length - keep));
  for (const path of doomed) rmSync(path, { force: true });
  return doomed;
}

export interface SnapshotOptions {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  keep?: number;
}

/**
 * Copy the database aside before it is migrated, or explain why it was not.
 *
 * Returns the snapshot's path, or `null` when the operator has opted out — the walk reports that
 * as "no snapshot" rather than pretending one exists.
 */
export function snapshotForMigration(
  db: Database.Database,
  backupsDir: string,
  from: number,
  options: SnapshotOptions = {}
): string | null {
  if (backupSkipped(options.env)) return null;

  const at = options.now?.() ?? new Date();
  let path: string;
  try {
    mkdirSync(backupsDir, { recursive: true });
    path = uniquePath(join(backupsDir, snapshotName(from, at)));
  } catch (error) {
    throw new MigrationBackupError(
      `Cannot create the backup directory ${backupsDir}: ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        `The database was not migrated.`,
      backupsDir
    );
  }

  try {
    // A parameter, not string interpolation: a data root can contain a quote, and the path comes
    // from the user's own folder choice.
    db.prepare("VACUUM INTO ?").run(path);
  } catch (error) {
    rmSync(path, { force: true });
    throw new MigrationBackupError(
      `Could not take a backup before migrating: ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        `The database was not migrated, and is unchanged at v${from}. ` +
        `Free some space, or set ${SKIP_BACKUP_ENV}=1 if this deployment takes its own backups.`,
      path
    );
  }

  pruneSnapshots(backupsDir, options.keep ?? MAX_SNAPSHOTS);
  return path;
}
