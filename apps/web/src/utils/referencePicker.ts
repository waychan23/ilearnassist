import type { FileCategory, WorkResource, Workspace } from "../api/types";
import { resourceCategory, resourceName } from "./resourceView";

/**
 * The `@` picker's arithmetic: what the list holds, in what order, and which row the arrow keys
 * land on.
 *
 * It lives here rather than in `SourceMentionPicker.vue` for the project's usual reason —
 * components are covered by Playwright and nothing else — and here it matters more than usual,
 * because the list holds two kinds of thing at once. A model that answers "what is in here" from
 * the template would be wrong in the ways nobody screenshots: a filter that keeps the workspace
 * group alive after you asked for images, a keyboard index that walks past the divider, a cap
 * that hides the row you were looking for.
 */

/** The three tabs. `all` is what the picker opens on: a bare `@` narrows by nothing. */
export const REFERENCE_TABS = ["all", "workspace", "source"] as const;
export type ReferenceTab = (typeof REFERENCE_TABS)[number];

/**
 * The four type filters, and the categories each stands for.
 *
 * A **coarse grouping over the closed `FileCategory` union**, not a category list: the pills do
 * not line up with the seven categories a file can have (`文本` is text *and* markdown, `代码` is
 * code *and* a diagram), and inventing a category per pill would mean the library's own filter
 * and this one describing the same files differently.
 *
 * Typed as a `Record` over the union, so a category added to `FILE_CATEGORIES` with no pill to
 * hold it is a compile error here rather than a file that can never be filtered to.
 *
 * There used to be a fifth pill, `page`. It went with the v4 split rather than by taste: a page
 * is a `resourceType`, not a `FileCategory` — v3 had to hand-set `category: "page"` because a
 * page's name cannot say what it is — so "web pages" is no longer a *content type* this list can
 * filter by. Re-adding it means a pill that filters on `resourceType`, which is a control the
 * picker does not have.
 */
export const SOURCE_PILLS = ["image", "text", "code", "other"] as const;
export type SourcePill = (typeof SOURCE_PILLS)[number];

export const PILL_CATEGORIES: Record<SourcePill, readonly FileCategory[]> = {
  image: ["image"],
  text: ["text", "markdown"],
  code: ["code", "diagram"],
  other: ["document", "other"],
};

/** Every category the given pills admit, or `null` when no pill is on (meaning "any"). */
export function pillCategories(pill: SourcePill | null): readonly FileCategory[] | null {
  return pill === null ? null : PILL_CATEGORIES[pill];
}

/*
 * There is deliberately no `pillLabelKey` here returning a key string, and no label table.
 *
 * `catalog.test.ts` finds a key by scanning the source for `t("…")` literals — a key reached
 * through an object property or a helper is invisible to it, and its dead-key scan then reports
 * the message as unused and fails the build. That is the same trap the platform console's nav
 * documents, and the same fix applies: the component holds a `switch` over the closed union with
 * a literal `t()` call per case, which is both visible to the scanner and a `vue-tsc` error when
 * a pill is added and nothing names it.
 */

/** One row of the list: a workspace, the all-workspaces row, or a reference. */
export interface ReferenceOption {
  /** Stable across refetches — a reference id, or `ws:<id>` / `all-workspaces`. */
  key: string;
  kind: "all-workspaces" | "workspace" | "source";
  name: string;
  /** A reference's workspace name, shown on the right. Empty for a workspace row. */
  where: string;
  /** Already readable under the current grant, so the row can say so rather than look unpicked. */
  granted: boolean;
}

export interface ReferenceGroup {
  kind: "workspace" | "source";
  options: ReferenceOption[];
  /** How many matched but did not fit the cap, so the component can say "还有 N 项". */
  hidden: number;
}

/** How many rows one group shows, and how many the whole list shows. */
export const GROUP_LIMIT = 8;
export const TOTAL_LIMIT = 12;

export interface BuildOptionsInput {
  query: string;
  tab: ReferenceTab;
  /** The active type pill, or `null` for no type filter. */
  pill: SourcePill | null;
  /** The account's workspaces, current one already excluded by the caller. */
  workspaces: readonly Workspace[];
  /** The references the server returned for this query. */
  sources: readonly WorkResource[];
  /** The workspaces already in the grant, so a row can show it is. */
  grantedIds: readonly string[];
  isAllGranted: boolean;
  /** The label for the all-workspaces row, which is translated and therefore passed in. */
  allLabel: string;
}

const matches = (haystack: string, needle: string): boolean =>
  needle === "" || haystack.toLowerCase().includes(needle);

/**
 * The rows to draw, grouped, filtered, and capped.
 *
 * The rules, each of which is a way this list goes wrong:
 *
 * - **A bare `@` matches everything** — the picker is opened to browse as much as to search.
 * - **The all-workspaces row also answers to the literal `all`.** Its label is translated, so a
 *   user who read `@所有工作区` once and is now typing on an English screen has no stable word to
 *   type; the English word is the one that is stable across both.
 * - **A pill drops the workspace group.** A workspace has no source type, so a list still showing
 *   workspaces after you asked for images reads as a filter that did not work.
 * - **Workspaces come first**, because they are the coarser thing and picking one is the decision
 *   the other rows are refinements of.
 */
export function buildOptions(input: BuildOptionsInput): ReferenceGroup[] {
  const needle = input.query.trim().toLowerCase();
  const groups: ReferenceGroup[] = [];

  // The workspace group needs both the tab and the absence of a pill to be worth drawing.
  const wantsWorkspaces = input.tab !== "source" && input.pill === null;
  if (wantsWorkspaces) {
    const rows: ReferenceOption[] = [];
    if (matches(input.allLabel, needle) || matches("all", needle)) {
      rows.push({
        key: "all-workspaces",
        kind: "all-workspaces",
        name: input.allLabel,
        where: "",
        granted: input.isAllGranted,
      });
    }
    for (const workspace of input.workspaces) {
      if (!matches(workspace.name, needle)) continue;
      rows.push({
        key: `ws:${workspace.id}`,
        kind: "workspace",
        name: workspace.name,
        where: "",
        granted: input.isAllGranted || input.grantedIds.includes(workspace.id),
      });
    }
    push(groups, "workspace", rows);
  }

  if (input.tab !== "workspace") {
    const categories = pillCategories(input.pill);
    const rows: ReferenceOption[] = input.sources
      // A page has no category at all, so a pill that names categories excludes it — which is the
      // honest answer for "show me the images": a page is not one, and there is no pill that names
      // it (see `SOURCE_PILLS`).
      .filter((source) => {
        if (categories === null) return true;
        const category = resourceCategory(source);
        return category !== null && categories.includes(category);
      })
      .filter((source) => matches(resourceName(source), needle))
      .map((source) => ({
        key: `src:${source.id}`,
        kind: "source" as const,
        name: resourceName(source),
        where: source.workspaceName ?? "",
        granted: false,
      }));
    push(groups, "source", rows);
  }

  return cap(groups);
}

function push(groups: ReferenceGroup[], kind: "workspace" | "source", rows: ReferenceOption[]): void {
  if (rows.length === 0) return;
  groups.push({ kind, options: rows.slice(0, GROUP_LIMIT), hidden: Math.max(0, rows.length - GROUP_LIMIT) });
}

/** Cut the whole list to `TOTAL_LIMIT` rows, counting what fell off into each group's `hidden`. */
function cap(groups: ReferenceGroup[]): ReferenceGroup[] {
  let left = TOTAL_LIMIT;
  const out: ReferenceGroup[] = [];
  for (const group of groups) {
    if (left <= 0) {
      out.push({ ...group, options: [], hidden: group.hidden + group.options.length });
      continue;
    }
    const kept = group.options.slice(0, left);
    left -= kept.length;
    out.push({ ...group, options: kept, hidden: group.hidden + (group.options.length - kept.length) });
  }
  // A group the cap emptied entirely is a heading with nothing under it.
  return out.filter((group) => group.options.length > 0);
}

/** The rows in draw order — what the arrow keys walk and what a click indexes into. */
export function flatten(groups: readonly ReferenceGroup[]): ReferenceOption[] {
  return groups.flatMap((group) => group.options);
}

/**
 * Where the arrow keys land.
 *
 * Wraps in both directions, and returns `0` for an empty list rather than `NaN` — a call site
 * that indexes with it is then merely wrong rather than indexing `undefined`.
 */
export function stepActive(index: number, delta: -1 | 1, length: number): number {
  if (length <= 0) return 0;
  return (index + delta + length) % length;
}

/**
 * What the Composer is told when a row is picked.
 *
 * A discriminated union rather than an id plus a kind, so the handler is an exhaustive `switch`:
 * a fourth kind of reference is then a `vue-tsc` error at the one place that has to know what to
 * do with it, rather than a row that inserts a name and does nothing else.
 */
export type ReferenceChoice =
  | { kind: "resource"; resource: WorkResource }
  | { kind: "scope"; all: true; name: string }
  | { kind: "scope"; all: false; workspaceId: string; name: string };
