import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Where everything lives on disk, and the single place that decides it.
 *
 * The tree has two levels because it has two owners. The **data root** belongs to whoever
 * installed the app: it is chosen at launch, it sits wherever they want it (outside the
 * application bundle, so uninstalling the app leaves the data behind), and nothing else in
 * the codebase is allowed to guess it. Underneath, **one directory per user** holds
 * everything that person made.
 *
 * ```
 * <dataRoot>/
 *   users/<userSlug>/
 *     workspaces/<wsSlug>/
 *       workdir/                 the agent's file-tool sandbox and the file browser's root
 *       sessions/<sessionId>/    a conversation's own files — the diagrams it draws
 *     sources/
 *       raw/<fileId>.<ext>       an uploaded file
 *       web/<fileId>.<ext>       a page's fetched body
 *       parsed/<fileId>.txt      extracted text, a file of its own
 *   db/sqlite/ilearnassist.sqlite
 *   backups/ilearnassist-v5-<stamp>.sqlite
 * ```
 *
 * The session directory is deliberately a *sibling* of `workdir/` rather than a corner of it:
 * the workdir is the sandbox `write_file` and the file tree share, and a conversation's own
 * files are not the same kind of thing. Putting them inside it would also make them
 * indistinguishable from files the model wrote — and would put them where `list_files` reaches
 * them, which is not what a diagram's file is for.
 *
 * Every path here is *derived* from the two slugs and an id — never stored as a fact in its
 * own right. That is what keeps a rename from having to move files: the username changes,
 * `users.slug` and the directory do not, exactly as a workspace's display name and its
 * directory already relate. `db/sqlite/` is a directory rather than a bare file name so the
 * next database is a sibling, not a naming convention.
 *
 * `backups/` holds the snapshot taken before a migration walk (`backup.ts`). It is inside the
 * data root on purpose: "back up my work" is already "copy this folder", and a snapshot kept
 * somewhere else would quietly make that sentence false at the one moment it matters.
 */

/** The data root and the database's home. Both are fixed for the life of a process. */
export interface DataLayout {
  dataRoot: string;
  /** Holds one directory per user, named by `users.slug`. */
  usersRoot: string;
  sqliteDir: string;
  sqliteFile: string;
  /** Snapshots taken before a migration walk. See `backup.ts`. */
  backupsDir: string;
}

export function dataLayout(dataRoot: string): DataLayout {
  const sqliteDir = join(dataRoot, "db", "sqlite");
  return {
    dataRoot,
    usersRoot: join(dataRoot, "users"),
    sqliteDir,
    sqliteFile: join(sqliteDir, "ilearnassist.sqlite"),
    backupsDir: join(dataRoot, "backups"),
  };
}

/**
 * The thread widget's observation log: one append-only, human-readable file for watching how
 * the classifier splits a conversation into topic chains. Process-level (not per user), and
 * created lazily on the first write, so an installation that never installs the widget has no
 * `logs/` directory at all.
 */
export function threadLogPath(dataRoot: string): string {
  return join(dataRoot, "logs", "threads.log");
}

/**
 * The insight pass's log, the same shape for the same reason.
 *
 * Its own file rather than a section of `threads.log`: the two calls are unrelated, run at
 * different times (one per turn, one per button press), and a reader watching one should not
 * have to skip past the other. The `洞察` prefix on each block is what makes a tail of both
 * still readable, but they are not meant to be read together.
 */
export function insightLogPath(dataRoot: string): string {
  return join(dataRoot, "logs", "insights.log");
}

/**
 * The deployment's own configuration overlay: `<dataRoot>/config.patch.json`.
 *
 * At the data root rather than beside `config.yaml`, and the distinction is the whole point of it.
 * `config/config.yaml` is the *install's* bootstrap — inside the application bundle for a packed
 * build, and replaced wholesale on every update. This file is the *deployment's*, next to the
 * database and the workspaces, and it survives an update for the reason those do.
 *
 * Named `config.patch.json` rather than anything prompt-shaped because it is not a prompt
 * feature: it is merged over the whole configuration by key, and the prompt catalog
 * (`prompts.json`) is simply one of the trees it can reach. Read once per process, so a change
 * takes effect on the next restart.
 */
export function configPatchPath(dataRoot: string): string {
  return join(dataRoot, "config.patch.json");
}

/** One user's tree. `userSlug` is `users.slug`, which a rename does not change. */
export interface UserLayout {
  userRoot: string;
  /** Passed to `uniqueSlug`/`createWorkspaceDir`, and to `removeWorkspaceDir`'s guard. */
  workspacesRoot: string;
  sourcesRoot: string;
  rawDir: string;
  /** Captured web pages. A sibling of `raw/` because its bytes come from somewhere else. */
  webDir: string;
  parsedDir: string;
}

export function userLayout(layout: DataLayout, userSlug: string): UserLayout {
  const userRoot = join(layout.usersRoot, userSlug);
  const sourcesRoot = join(userRoot, "sources");
  return {
    userRoot,
    workspacesRoot: join(userRoot, "workspaces"),
    sourcesRoot,
    rawDir: join(sourcesRoot, "raw"),
    webDir: join(sourcesRoot, "web"),
    parsedDir: join(sourcesRoot, "parsed"),
  };
}

/**
 * Create a user's whole tree. Idempotent, and deliberately eager: every directory in
 * `UserLayout` exists from the moment the user does, so "the layout" is a thing you can
 * look at rather than a thing that materialises the first time something is written.
 */
export function ensureUserLayout(user: UserLayout): void {
  for (const dir of [user.workspacesRoot, user.rawDir, user.webDir, user.parsedDir]) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * The agent's sandbox root for a workspace, and the file browser's root.
 *
 * `Workspace.dirPath` stores the workspace's **own** directory, not this one, because that
 * is what deleting a workspace has to remove — removing only `workdir/` would strand
 * `sessions/` beside it, and `removeWorkspaceDir`'s "direct child of the workspaces root"
 * guard is written against the workspace root. Everything that wants the sandbox asks here
 * instead of appending the segment itself, so the two can never drift.
 */
export function workspaceWorkdir(workspaceRoot: string): string {
  return join(workspaceRoot, "workdir");
}

/** The directory holding a workspace's conversations. Holds nothing but session dirs. */
export function workspaceSessionsDir(workspaceRoot: string): string {
  return join(workspaceRoot, "sessions");
}

/**
 * Where a workspace's deleted files go: a sibling of `workdir/` and `sessions/`, deliberately.
 *
 * A soft delete keeps the bytes, and the sandbox must not be able to reach them — a file the
 * user deleted from the file manager that the agent could still `read_file` would make the
 * delete a lie in the one place it matters. Namespacing by source id is what lets a restored
 * file keep its original path without two deletions colliding on one.
 */
export function workspaceTrashDir(workspaceRoot: string): string {
  return join(workspaceRoot, "trash");
}

/**
 * One conversation's own directory. Named by session id, which is never user-supplied.
 *
 * Where a conversation keeps the files it makes for itself — today, the `.mmd` sources
 * `ila_diagram` writes. Its one writer is that tool; `sessions/<id>/` is outside `workdir/`, so
 * no file tool can reach it and a diagram's file is not something the model can edit by path.
 */
export function sessionDir(workspaceRoot: string, sessionId: string): string {
  return join(workspaceSessionsDir(workspaceRoot), sessionId);
}
