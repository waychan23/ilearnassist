import type { WorkResource } from "../api/types";
import { resourceName, resourceSandboxPath } from "./resourceView";

/**
 * The source browser's tree view, as arithmetic rather than as a component.
 *
 * A tree of references is not a tree of files, and the difference is the whole reason this is
 * worth its own module. A file tree has one root per listing and paths that are unique within
 * it; a reference list spans **every** workspace and conversation the account has, and two
 * conversations may each hold a file called `notes/a.md`. So a path is only meaningful *under
 * its owner* — grouping by path alone would merge two different files into one line — and the
 * group a row hangs under is the answer to "where did this come from", which is the question
 * the flat view cannot answer at all.
 *
 * Three levels, then the path:
 *
 * ```
 * 工作区 Study
 *   会话 递归练习          ← only for rows a conversation owns
 *     notes/a.md
 *   lecture.pdf          ← an upload has no sandbox path, so it sits under the workspace itself
 * ```
 *
 * The functions are pure and take `expanded`, exactly like `utils/fileTree.ts`: which rows are
 * *visible* is a function of the grouping and the open set, and that is the part worth testing
 * rather than the part worth looking at.
 */

/** A node in the tree, before flattening. */
export interface SourceGroup {
  /** Stable identity, and the key `expanded` holds. */
  key: string;
  label: string;
  /** Rows that belong directly to this group, in list order. */
  sources: WorkResource[];
  children: SourceGroup[];
}

export interface SourceTreeLine {
  kind: "group" | "source";
  /** Unique across the tree: a group's key, or a reference's id prefixed by its group. */
  key: string;
  label: string;
  depth: number;
  /** The group this line toggles, or the row it opens. */
  group?: SourceGroup;
  source?: WorkResource;
}

/** A row that is not in any workspace — a reference whose owner is gone, say. */
const LOOSE = "—";

/**
 * Group a flat list into workspaces → conversations → paths.
 *
 * The two grouping decisions worth stating:
 *
 * - **A conversation-owned row is grouped under its conversation**, even when it has no path:
 *   a file written into `sessions/<id>/` belongs to that conversation, and filing it under the
 *   workspace would be the claim the two-sandbox split exists to avoid.
 * - **A path is split into segments**, so `notes/2026/a.md` nests. Intermediate groups are
 *   created on demand, which is what lets one workspace hold paths from several owners without
 *   the clients agreeing on a shape first.
 */
export function groupSources(sources: readonly WorkResource[]): SourceGroup[] {
  const roots = new Map<string, SourceGroup>();

  const workspaceGroup = (source: WorkResource): SourceGroup => {
    const key = source.workspaceId ? `ws:${source.workspaceId}` : "ws:?";
    const label = source.workspaceName ?? LOOSE;
    let group = roots.get(key);
    if (!group) {
      group = { key, label, sources: [], children: [] };
      roots.set(key, group);
    }
    return group;
  };

  const ownerGroup = (parent: SourceGroup, source: WorkResource): SourceGroup => {
    // A workspace-owned row hangs directly under the workspace: the workspace *is* its owner,
    // and repeating its name one level down would be a group with nothing to distinguish it.
    if (source.ownerType === "workspace") return parent;
    const key = `${parent.key}/owner:${source.ownerId}`;
    let group = parent.children.find((c) => c.key === key);
    if (!group) {
      group = { key, label: source.ownerName ?? LOOSE, sources: [], children: [] };
      parent.children.push(group);
    }
    return group;
  };

  /** Walk or create the chain of directories a path names. */
  const pathGroup = (parent: SourceGroup, relPath: string): SourceGroup => {
    const segments = relPath.split("/").slice(0, -1);
    let group = parent;
    for (const segment of segments) {
      const key = `${group.key}/${segment}`;
      let child = group.children.find((c) => c.key === key);
      if (!child) {
        child = { key, label: segment, sources: [], children: [] };
        group.children.push(child);
      }
      group = child;
    }
    return group;
  };

  for (const source of sources) {
    const workspace = workspaceGroup(source);
    const owner = ownerGroup(workspace, source);
    // A row with no *sandbox* path sits at its owner: an upload is named rather than located, a
    // page has no path at all, and a path outside a sandbox says nothing about where the material
    // came from. See `resourceSandboxPath`.
    const path = resourceSandboxPath(source);
    const target = path ? pathGroup(owner, path) : owner;
    target.sources.push(source);
  }

  return sortGroups([...roots.values()]);
}

/** Groups by label, rows by name — the order a reader expects, and stable across reloads. */
function sortGroups(groups: SourceGroup[]): SourceGroup[] {
  groups.sort((a, b) => a.label.localeCompare(b.label));
  for (const group of groups) {
    group.sources.sort((a, b) => resourceName(a).localeCompare(resourceName(b)));
    sortGroups(group.children);
  }
  return groups;
}

/**
 * The visible lines, given which groups are open.
 *
 * A group is a line of its own whether or not it is open, and its contents are emitted only
 * when it is — the same shape `flattenTree` gives the file tree, and for the same reason: the
 * renderer draws a flat list and indentation is the depth it carries.
 */
export function flattenSourceTree(
  groups: readonly SourceGroup[],
  expanded: readonly string[],
  depth = 0
): SourceTreeLine[] {
  const open = new Set(expanded);
  const lines: SourceTreeLine[] = [];

  for (const group of groups) {
    lines.push({ kind: "group", key: group.key, label: group.label, depth, group });
    if (!open.has(group.key)) continue;

    // Sources first, then subdirectories: a directory at the top of a group pushes the rows
    // that are the group's *own* content below a header, which reads as if they were inside it.
    for (const source of group.sources) {
      lines.push({
        kind: "source",
        key: `${group.key}/${source.id}`,
        label: resourceName(source),
        depth: depth + 1,
        source,
      });
    }
    lines.push(...flattenSourceTree(group.children, expanded, depth + 1));
  }

  return lines;
}

/** Every group key, so "expand all" and a first render have somewhere to start. */
export function allGroupKeys(groups: readonly SourceGroup[]): string[] {
  const keys: string[] = [];
  for (const group of groups) {
    keys.push(group.key);
    keys.push(...allGroupKeys(group.children));
  }
  return keys;
}
