import type { Diagram, Table } from "../api/types";

/**
 * The 图表 panel's rows: a conversation's diagrams and its tables, as one list.
 *
 * Two arrays in, one list out, because that is what the two sources are: `session_diagrams` rows
 * name a file that has to be opened separately, and `session_tables` rows *are* the content. The
 * differences are carried on the row (`fileName` / `content`, `fileMissing` or not) rather than
 * flattened away, so a caller that has to treat them differently can — and the arithmetic here
 * stays the kind of thing a unit test can hold, which a `.vue` file is not.
 */

/** The two things a 图表 panel shows. 图 is a drawing; 表 is a table. */
export type FigureKind = "diagram" | "table";

/**
 * The filter's values, `""` included because it is a `<select>`'s empty option.
 *
 * A string union rather than a `null`, so `v-model` on the select needs no conversion and the
 * value in the template is the value in the arithmetic.
 */
export const FIGURE_FILTERS = ["", "diagram", "table"] as const;
export type FigureFilter = (typeof FIGURE_FILTERS)[number];

export interface FigureRow {
  /**
   * The list key.
   *
   * Prefixed by the kind even though both ids are UUIDs from the server: the prefix costs nothing
   * and says what the key is, which is worth more in a `v-for` than a saved byte.
   */
  key: string;
  kind: FigureKind;
  /** What the row shows: a diagram's file name without its extension, a table's name as it is. */
  name: string;
  summary: string;
  threadTitle: string | null;
  updatedAt: string;
  toolCallId: string | null;
  /** A diagram's canonical file name, for the ordinary preview. Null for a table. */
  fileName: string | null;
  /** A table's markdown, for the viewer. Null for a diagram. */
  content: string | null;
  /** Whether a diagram's file is gone. Always false for a table — there is no file to lose. */
  fileMissing: boolean;
}

/** `flow.mmd` → `flow`, for a diagram's row label. */
export function figureStem(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * Both kinds, newest first.
 *
 * One chronological list rather than diagrams-then-tables, because the panel answers "what has
 * this conversation made" and the filter is what narrows it to a kind — grouping *and* filtering
 * would be two answers to one question. The comparison is on the ISO strings themselves: they sort
 * lexicographically in the same order they sort chronologically, so no parse is needed and no
 * invalid date can produce a `NaN` that quietly unsorts the list.
 */
export function figureRows(
  diagrams: readonly Diagram[],
  tables: readonly Table[]
): FigureRow[] {
  const rows: FigureRow[] = [
    ...diagrams.map(
      (d): FigureRow => ({
        key: `diagram:${d.id}`,
        kind: "diagram",
        name: figureStem(d.name),
        summary: d.summary,
        threadTitle: d.threadTitle,
        updatedAt: d.updatedAt,
        toolCallId: d.toolCallId,
        fileName: d.name,
        content: null,
        fileMissing: d.fileMissing,
      })
    ),
    ...tables.map(
      (t): FigureRow => ({
        key: `table:${t.id}`,
        kind: "table",
        name: t.name,
        summary: t.summary,
        threadTitle: t.threadTitle,
        updatedAt: t.updatedAt,
        toolCallId: t.toolCallId,
        fileName: null,
        content: t.content,
        fileMissing: false,
      })
    ),
  ];
  return rows.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

/** The rows the filter lets through. The empty value is "all of them". */
export function filterFigures(rows: readonly FigureRow[], filter: FigureFilter): FigureRow[] {
  return filter === "" ? [...rows] : rows.filter((r) => r.kind === filter);
}

/**
 * The kinds actually present, in the panel's own order.
 *
 * Derived rather than fixed, which is `SourcesWidget`'s rule for its category filter: an option
 * that can only ever produce the empty state is a control that does nothing, and a conversation
 * with no tables should not offer 表 in a menu.
 */
export function presentKinds(rows: readonly FigureRow[]): FigureKind[] {
  const kinds: FigureKind[] = [];
  if (rows.some((r) => r.kind === "diagram")) kinds.push("diagram");
  if (rows.some((r) => r.kind === "table")) kinds.push("table");
  return kinds;
}
