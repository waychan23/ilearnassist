import type { DirectoryListing, FileEntry } from "../api/types";

/**
 * The shape of the file tree, as pure functions.
 *
 * The tree is stored flat — one listing per directory, keyed by its workspace-relative path
 * — because that is what the server answers with and what makes a refresh a re-read of the
 * directories the user has open rather than a walk of the whole workspace. Turning that into
 * rows is the only part with any arithmetic in it, and it lives here rather than in the
 * component for one reason: components are not unit tested in this project, and "which row
 * does ArrowLeft go to" is exactly the kind of thing that is wrong in a way nobody notices.
 *
 * Paths are `/`-separated and workspace-relative, `""` being the root.
 */

/** One rendered row: an entry, and how far it is indented. */
export interface FileTreeRow {
  entry: FileEntry;
  depth: number;
}

/**
 * Every visible row, in render order.
 *
 * A depth-first walk from the root that descends only into expanded directories *that have
 * been loaded*. A directory the user has opened but which has not arrived yet contributes a
 * row and no children, which is the honest rendering of "we do not know yet" — and it is
 * why this takes the whole listing map rather than assuming every expanded path has one.
 */
export function flattenTree(
  listings: Record<string, DirectoryListing>,
  expanded: readonly string[]
): FileTreeRow[] {
  const open = new Set(expanded);
  const rows: FileTreeRow[] = [];

  const walk = (path: string, depth: number): void => {
    for (const entry of listings[path]?.entries ?? []) {
      rows.push({ entry, depth });
      if (entry.type === "dir" && open.has(entry.path)) walk(entry.path, depth + 1);
    }
  };

  walk("", 0);
  return rows;
}

/** Move `delta` rows from `index`, stopping at either end rather than wrapping. */
export function moveIndex(rows: readonly FileTreeRow[], index: number, delta: number): number {
  if (rows.length === 0) return -1;
  return Math.min(Math.max(index + delta, 0), rows.length - 1);
}

/**
 * The row that encloses `index` — the nearest row above it one level shallower.
 *
 * Returns `index` for a top-level row, which is what makes ArrowLeft on a root entry do
 * nothing instead of jumping somewhere unrelated.
 */
export function parentRowIndex(rows: readonly FileTreeRow[], index: number): number {
  const row = rows[index];
  if (!row || row.depth === 0) return index;
  for (let i = index - 1; i >= 0; i--) {
    const candidate = rows[i];
    if (candidate && candidate.depth < row.depth) return i;
  }
  return index;
}
