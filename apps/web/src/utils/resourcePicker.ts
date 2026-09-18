import type { FileCategory, Note, TurnReference, WorkResource, Workspace } from "../api/types";
import type { FigureRow } from "./figures";
import { resourceCategory, resourceName } from "./resourceView";
import { figureReference, noteReference } from "./turnRefs";

/**
 * The `@` picker's arithmetic: what the list holds, in what order, and which row the arrow keys
 * land on.
 *
 * It lives here rather than in `ResourceMentionPicker.vue` for the project's usual reason —
 * components are covered by Playwright and nothing else — and here it matters more than usual,
 * because the list holds two kinds of thing at once. A model that answers "what is in here" from
 * the template would be wrong in the ways nobody screenshots: a filter that keeps the workspace
 * group alive after you asked for images, a keyboard index that walks past the divider, a cap
 * that hides the row you were looking for.
 */

/** The three tabs. `all` is what the picker opens on: a bare `@` narrows by nothing. */
export const REFERENCE_TABS = ["all", "workspace", "resource"] as const;
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
export const RESOURCE_PILLS = ["image", "text", "code", "other"] as const;
export type ResourcePill = (typeof RESOURCE_PILLS)[number];

export const PILL_RULES: Record<ResourcePill, readonly FileCategory[]> = {
  image: ["image"],
  text: ["text", "markdown"],
  code: ["code", "diagram"],
  other: ["document", "other"],
};

/** Every category the given pills admit, or `null` when no pill is on (meaning "any"). */
export function pillCategories(pill: ResourcePill | null): readonly FileCategory[] | null {
  return pill === null ? null : PILL_RULES[pill];
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

/** Everything a row can be. Five of the six are things to *point at*; the sixth is a workspace. */
export type ReferenceOptionKind =
  | "all-workspaces"
  | "workspace"
  | "resource"
  | "diagram"
  | "table"
  | "note";

/** Every group a heading can name — the option kinds minus the all-workspaces row, which has none. */
export type ReferenceGroupKind = Exclude<ReferenceOptionKind, "all-workspaces">;

/**
 * One row of the list: a workspace, the all-workspaces row, a reference — or one of the objects
 * this conversation made.
 *
 * The last three are rows the `@` list did not always have, and they are what makes 资料 mean
 * "material" rather than "files": a 图, a 表 and a 笔记 are things a conversation works from
 * exactly as a PDF is.
 *
 * **`ref` carries the object, and it is a `TurnReference` rather than a name.** That is the whole
 * reason 追问 and `@` are one mechanism: pointing at a diagram from the panel and typing `@` for it
 * produce the same object, which the composer stages through the same call and the server resolves
 * through the same code. A second shape here would be a second answer to "what is this thing
 * called", and the two would disagree on exactly the awkward names.
 */
export interface ReferenceOption {
  /** Stable across refetches — a reference id, `ws:<id>`, `all-workspaces`, or `kind:ref`. */
  key: string;
  kind: ReferenceOptionKind;
  name: string;
  /** A reference's workspace name, shown on the right. Empty for every other row. */
  where: string;
  /** Already readable under the current grant, so the row can say so rather than look unpicked. */
  granted: boolean;
  /**
   * What the row stages, for the three object kinds.
   *
   * Optional rather than a fourth arm of a discriminated union, and the shape is the honest one
   * here: a workspace stages a scope setting and a material row stages a `WorkResource`, so *no*
   * row stages a reference except these three — and the component reads this only inside the
   * branches that already narrowed on `kind`. What makes it safe is `objectRefs` below, which is
   * the single place a `ref` is ever attached.
   */
  ref?: TurnReference;
}

export interface ReferenceGroup {
  kind: ReferenceGroupKind;
  options: ReferenceOption[];
}

/**
 * The rows the list draws at once, and how many more each press of the pager adds.
 *
 * One window over the whole list rather than a cap per group, and the difference is what the
 * pager needs to say: "还有 N 项" is only a useful sentence if N is how many more you will get.
 * It replaced an 8-per-group / 12-total pair that existed to keep a menu from being a wall —
 * which it is not, because the list scrolls — and that capped the material a reader could reach
 * at a dozen rows with no way to ask for the rest.
 *
 * The window is applied **client-side over rows already fetched**, so loading more costs nothing:
 * the account's match set is one request, and this only decides how much of it is on screen.
 */
export const LIST_PAGE = 100;

export interface BuildOptionsInput {
  query: string;
  tab: ReferenceTab;
  /** The active type pill, or `null` for no type filter. */
  pill: ResourcePill | null;
  /** The account's workspaces, current one already excluded by the caller. */
  workspaces: readonly Workspace[];
  /** The references the server returned for this query. */
  sources: readonly WorkResource[];
  /** The conversation's own 图 and 表, in one list — `figureRows`'s shape, already merged. */
  figures: readonly FigureRow[];
  /** The conversation's own notes. */
  notes: readonly Note[];
  /** The workspaces already in the grant, so a row can show it is. */
  grantedIds: readonly string[];
  isAllGranted: boolean;
  /** The label for the all-workspaces row, which is translated and therefore passed in. */
  allLabel: string;
  /** How many rows the window currently holds. Grows by `LIST_PAGE` per press of the pager. */
  limit: number;
}

/** The window, and what is past it. */
export interface ReferenceOptions {
  groups: ReferenceGroup[];
  /** How many rows matched but are outside the window — what the pager says. */
  hidden: number;
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
 * - **A pill drops every group it cannot filter.** A workspace has no source type and neither does
 *   a 图, so a list still showing them after you asked for images reads as a filter that did not
 *   work.
 * - **Workspaces come first**, because they are the coarser thing and picking one is the decision
 *   the other rows are refinements of. The conversation's own objects follow the material, because
 *   that is the order of the question: what this is working from, then what it has made.
 */
export function buildReferenceOptions(input: BuildOptionsInput): ReferenceOptions {
  const needle = input.query.trim().toLowerCase();
  const groups: ReferenceGroup[] = [];

  // The workspace group needs both the tab and the absence of a pill to be worth drawing.
  const wantsWorkspaces = input.tab !== "resource" && input.pill === null;
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

  const categories = pillCategories(input.pill);
  // A pill is a claim about a *file's* type, so it silences the three object groups rather than
  // filtering them: neither a drawing nor a note has a category to be matched against, and
  // leaving them in would be the filter appearing not to have taken.
  const objects = input.tab !== "workspace" && input.pill === null;

  if (input.tab !== "workspace") {
    const rows: ReferenceOption[] = input.sources
      // A page has no category at all, so a pill that names categories excludes it — which is the
      // honest answer for "show me the images": a page is not one, and there is no pill that names
      // it (see `RESOURCE_PILLS`).
      .filter((source) => {
        if (categories === null) return true;
        const category = resourceCategory(source);
        return category !== null && categories.includes(category);
      })
      .filter((source) => matches(resourceName(source), needle))
      .map((source) => ({
        key: `src:${source.id}`,
        kind: "resource" as const,
        name: resourceName(source),
        where: source.workspaceName ?? "",
        granted: false,
      }));
    push(groups, "resource", rows);
  }

  if (objects) {
    /*
     * One group per kind rather than one grouped list, and the group headings *are* the dividers
     * the reader sees: a 图 and a 表 can share a name, so a flat list would show two identical
     * rows with nothing to tell them apart but the icon.
     */
    push(
      groups,
      "diagram",
      objectRows(input.figures.filter((row) => row.kind === "diagram"), needle)
    );
    push(
      groups,
      "table",
      objectRows(input.figures.filter((row) => row.kind === "table"), needle)
    );
    push(
      groups,
      "note",
      input.notes
        .filter((note) => matches(noteTargetText(note), needle))
        .map((note) => ({
          key: `note:${note.id}`,
          kind: "note" as const,
          name: noteTargetText(note),
          where: "",
          granted: false,
          ref: noteReference(note),
        }))
    );
  }

  return cap(groups, input.limit);
}

/**
 * The figures of one kind, as rows ready to stage.
 *
 * `where` is left empty on purpose: a figure belongs to *this* conversation, which the reader is
 * already looking at, so naming the workspace it happens to live in would be answering a question
 * nobody asked — the one place the material rows' second column would be noise.
 */
function objectRows(figures: readonly FigureRow[], needle: string): ReferenceOption[] {
  return figures
    .filter((row) => matches(row.name, needle) || matches(row.summary, needle))
    .map((row) => ({
      key: `${row.kind}:${row.fileName ?? row.name}`,
      kind: row.kind,
      name: row.name,
      where: "",
      granted: false,
      ref: figureReference(row),
    }));
}

/**
 * What a note row says.
 *
 * The same fallback `NotesWidget.rowText` and `noteReference` make, and it is not tidiness that
 * it is made the same way three times: a bare 标注 has no words of its own, so a row showing the
 * note's empty body would be a blank line in a list of them.
 */
function noteTargetText(note: Note): string {
  return note.content.trim() || note.quote;
}

function push(
  groups: ReferenceGroup[],
  kind: ReferenceGroupKind,
  rows: ReferenceOption[]
): void {
  if (rows.length === 0) return;
  groups.push({ kind, options: rows });
}

/**
 * Cut the whole list to the window, and say how much fell past it.
 *
 * Groups are filled in draw order, so the window is spent on the coarser rows first — the
 * workspaces, then the material, then what the conversation made. That order is the same one the
 * reader sees, so "load more" reveals the list from the top down rather than in patches.
 *
 * A group the window emptied entirely is dropped: a heading with nothing under it is not a
 * group, and it would say the list holds something it does not.
 */
function cap(groups: ReferenceGroup[], limit: number): ReferenceOptions {
  let left = Math.max(0, limit);
  let hidden = 0;
  const out: ReferenceGroup[] = [];

  for (const group of groups) {
    const kept = group.options.slice(0, left);
    hidden += group.options.length - kept.length;
    left -= kept.length;
    if (kept.length > 0) out.push({ kind: group.kind, options: kept });
  }

  return { groups: out, hidden };
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
 *
 * `turnRef` is the arm 追问 already sends, and the reason the three object rows need nothing new
 * on the far side: the composer stages it through the same `store.stageReference` a figure panel's
 * ask button calls.
 */
export type ReferenceChoice =
  | { kind: "resource"; resource: WorkResource }
  | { kind: "turnRef"; ref: TurnReference; name: string }
  | { kind: "scope"; all: true; name: string }
  | { kind: "scope"; all: false; workspaceId: string; name: string };
