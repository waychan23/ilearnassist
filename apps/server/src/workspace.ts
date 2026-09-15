import { mkdirSync, existsSync, rmSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { workspaceSessionsDir, workspaceWorkdir } from "./paths.js";

/**
 * Workspace directory management and — critically — the path sandbox that all
 * file tools are forced through. Every file operation is resolved against the
 * active workspace directory and rejected if it tries to escape it, mirroring
 * the constrained working-directory model of the DeepSeek harness.
 */

/**
 * Create a workspace's own directory, and the two directories inside it.
 *
 * All three at once, because they are one unit: `workdir/` is the sandbox and `sessions/`
 * is where a conversation's own files go. The caller passes the *workspace* root, so a
 * `sessions/` left behind by a later delete is not something the layout can produce.
 */
export function createWorkspaceDir(rootDir: string, slug: string): string {
  const dirPath = resolve(rootDir, slug);
  mkdirSync(workspaceWorkdir(dirPath), { recursive: true });
  mkdirSync(workspaceSessionsDir(dirPath), { recursive: true });
  return dirPath;
}

/**
 * Recursively remove a workspace directory. Only directories that sit directly
 * under the configured workspaces root are ever removed (defense-in-depth so a
 * stray `..` could never delete a path outside the workspaces tree).
 */
export function removeWorkspaceDir(rootDir: string, dirPath: string): void {
  const base = resolve(rootDir);
  const target = resolve(dirPath);
  const rel = relative(base, target);
  const isDirectChild =
    rel !== "" &&
    !rel.startsWith(`..${sep}`) &&
    rel !== ".." &&
    !isAbsolute(rel) &&
    !rel.includes(sep);
  if (!isDirectChild) return; // refuse to remove anything not a direct child of root
  rmSync(target, { recursive: true, force: true });
}

export interface SandboxResult {
  ok: boolean;
  path?: string;
  error?: string;
}

/**
 * Resolve a user-supplied (possibly relative, possibly absolute) path into an
 * absolute path that is guaranteed to live inside `workspaceDir`.
 *
 * @param allowRoot when true, resolving to the workspace root itself is allowed
 *                  (used by directory listing for the "." case).
 */
export function resolveInWorkspace(
  workspaceDir: string,
  userPath: string,
  allowRoot = false
): SandboxResult {
  const base = resolve(workspaceDir);
  const candidate = isAbsolute(userPath) ? resolve(userPath) : resolve(base, userPath ?? ".");
  const rel = relative(base, candidate);

  const escaped = rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (escaped) {
    return { ok: false, error: `Path "${userPath}" is outside the workspace sandbox.` };
  }
  if (!allowRoot && rel === "") {
    return { ok: false, error: "A target path is required; the workspace root itself is read-only." };
  }
  return { ok: true, path: candidate };
}

/**
 * A filesystem-safe slug from a name.
 *
 * Letters and digits survive — Han included, deliberately, so `架构图` stays readable rather
 * than becoming a row of hyphens — and everything else collapses to `-`. `fallback` is what a
 * name made entirely of characters that do not survive becomes; it is required because the
 * caller is the only one who knows what the slug is *for*, and any default would be a quiet
 * lie about one of them.
 *
 * Server-side: it names directories and the diagram files, and the client no longer derives
 * either (the diagram row carries the canonical file name), so it does not need to cross the
 * wire.
 */
export function slugify(name: string, fallback: string): string {
  const base = name
    .toLowerCase()
    .trim()
    // Keep CJK characters (and common scripts) so non-Latin names stay readable.
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || fallback;
}

/**
 * A slug for a new workspace's directory, unique within its user's workspaces root.
 *
 * Checks the filesystem rather than the database because the filesystem is what a collision
 * would actually break — two workspaces resolving to one directory.
 */
export function uniqueSlug(rootDir: string, name: string): string {
  const candidate = slugify(name, "workspace");
  let slug = candidate;
  let i = 1;
  while (existsSync(resolve(rootDir, slug))) {
    slug = `${candidate}-${i++}`;
  }
  return slug;
}

/**
 * A slug for a new user's directory, unique among `users/`.
 *
 * `isTaken` rather than a root directory, because for a user the *database* is the
 * authority and the filesystem is only the backstop: the slug is a column with a `UNIQUE`
 * constraint, and a check that looked only at the directory would let two sign-ins arriving
 * at the same instant both pick the same name — one of them then failing on the constraint,
 * or worse, sharing a tree.
 */
export function uniqueUserSlug(username: string, isTaken: (slug: string) => boolean): string {
  const candidate = slugify(username, "user");
  let slug = candidate;
  let i = 1;
  while (isTaken(slug)) {
    slug = `${candidate}-${i++}`;
  }
  return slug;
}