import { mkdirSync, existsSync, rmSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Workspace directory management and — critically — the path sandbox that all
 * file tools are forced through. Every file operation is resolved against the
 * active workspace directory and rejected if it tries to escape it, mirroring
 * the constrained working-directory model of the DeepSeek harness.
 */

export function ensureWorkspacesRoot(rootDir: string): void {
  mkdirSync(rootDir, { recursive: true });
}

export function createWorkspaceDir(rootDir: string, slug: string): string {
  const dirPath = resolve(rootDir, slug);
  mkdirSync(dirPath, { recursive: true });
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

/** Generate a filesystem-safe slug from a workspace name. */
export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    // Keep CJK characters (and common scripts) so non-Latin names stay readable.
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return base || "workspace";
}

export function uniqueSlug(rootDir: string, name: string): string {
  const candidate = slugify(name);
  let slug = candidate;
  let i = 1;
  while (existsSync(resolve(rootDir, slug))) {
    slug = `${candidate}-${i++}`;
  }
  return slug;
}