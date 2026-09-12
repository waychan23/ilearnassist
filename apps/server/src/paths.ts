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
 *       sessions/<sessionId>/    reserved for per-conversation files; nothing writes here yet
 *     sources/
 *       raw/<sourceId>.<ext>     an uploaded file
 *       parsed/<sourceId>.txt    its extracted text
 *   db/sqlite/ilearnassist.sqlite
 * ```
 *
 * Every path here is *derived* from the two slugs and an id — never stored as a fact in its
 * own right. That is what keeps a rename from having to move files: the username changes,
 * `users.slug` and the directory do not, exactly as a workspace's display name and its
 * directory already relate. `db/sqlite/` is a directory rather than a bare file name so the
 * next database is a sibling, not a naming convention.
 */

/** The data root and the database's home. Both are fixed for the life of a process. */
export interface DataLayout {
  dataRoot: string;
  /** Holds one directory per user, named by `users.slug`. */
  usersRoot: string;
  sqliteDir: string;
  sqliteFile: string;
}

export function dataLayout(dataRoot: string): DataLayout {
  const sqliteDir = join(dataRoot, "db", "sqlite");
  return {
    dataRoot,
    usersRoot: join(dataRoot, "users"),
    sqliteDir,
    sqliteFile: join(sqliteDir, "ilearnassist.sqlite"),
  };
}

/** One user's tree. `userSlug` is `users.slug`, which a rename does not change. */
export interface UserLayout {
  userRoot: string;
  /** Passed to `uniqueSlug`/`createWorkspaceDir`, and to `removeWorkspaceDir`'s guard. */
  workspacesRoot: string;
  sourcesRoot: string;
  rawDir: string;
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
    parsedDir: join(sourcesRoot, "parsed"),
  };
}

/**
 * Create a user's whole tree. Idempotent, and deliberately eager: every directory in
 * `UserLayout` exists from the moment the user does, so "the layout" is a thing you can
 * look at rather than a thing that materialises the first time something is written.
 */
export function ensureUserLayout(user: UserLayout): void {
  for (const dir of [user.workspacesRoot, user.rawDir, user.parsedDir]) {
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

/** One conversation's own directory. Named by session id, which is never user-supplied. */
export function sessionDir(workspaceRoot: string, sessionId: string): string {
  return join(workspaceSessionsDir(workspaceRoot), sessionId);
}
