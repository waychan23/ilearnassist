import type { Diagram, Plot, Table } from "../api/types";

/**
 * The 图表 panel's rows: a conversation's diagrams, tables and plotted figures, as one list.
 *
 * Three arrays in, one list out, because that is what the three sources are: `session_diagrams`
 * rows name a file that has to be opened separately, `session_tables` rows *are* the markdown,
 * and `session_plots` rows *are* a JSON spec. The differences are carried on the row (`fileName`
 * / `content` / `spec`, `fileMissing` or not) rather than flattened away, so a caller that has to
 * treat them differently can — and the arithmetic here stays the kind of thing a unit test can
 * hold, which a `.vue` file is not.
 */

/** The three things a 图表 panel shows. 图 is a drawing, 表 is a table, 坐标图 is a plotted figure. */
export type FigureKind = "diagram" | "table" | "plot";

/**
 * The filter's values, `""` included because it is a `<select>`'s empty option.
 *
 * A string union rather than a `null`, so `v-model` on the select needs no conversion and the
 * value in the template is the value in the arithmetic.
 */
export const FIGURE_FILTERS = ["", "diagram", "table", "plot"] as const;
export type FigureFilter = (typeof FIGURE_FILTERS)[number];

export interface FigureRow {
  /**
   * The list key.
   *
   * Prefixed by the kind even though all three ids are UUIDs from the server: the prefix costs
   * nothing and says what the key is, which is worth more in a `v-for` than a saved byte.
   */
  key: string;
  kind: FigureKind;
  /** What the row shows: a diagram's file name without its extension, a row's name as it is. */
  name: string;
  summary: string;
  threadTitle: string | null;
  updatedAt: string;
  toolCallId: string | null;
  /** A diagram's canonical file name, for the ordinary preview. Null for the other two. */
  fileName: string | null;
  /** A table's markdown, for the viewer. Null for a diagram and a plot. */
  content: string | null;
  /** A plot's JSON spec, for the viewer. Null for a diagram and a table. */
  spec: string | null;
  /** Whether a diagram's file is gone. Always false for the other two — there is no file. */
  fileMissing: boolean;
}

/** `flow.mmd` → `flow`, for a diagram's row label. */
export function figureStem(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * All three kinds, newest first.
 *
 * One chronological list rather than grouped by kind, because the panel answers "what has this
 * conversation made" and the filter is what narrows it — grouping *and* filtering would be two
 * answers to one question. The comparison is on the ISO strings themselves: they sort
 * lexicographically in the same order they sort chronologically, so no parse is needed and no
 * invalid date can produce a `NaN` that quietly unsorts the list.
 */
export function figureRows(
  diagrams: readonly Diagram[],
  tables: readonly Table[],
  plots: readonly Plot[]
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
        spec: null,
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
        spec: null,
        fileMissing: false,
      })
    ),
    ...plots.map(
      (p): FigureRow => ({
        key: `plot:${p.id}`,
        kind: "plot",
        name: p.name,
        summary: p.summary,
        threadTitle: p.threadTitle,
        updatedAt: p.updatedAt,
        toolCallId: p.toolCallId,
        fileName: null,
        content: null,
        spec: p.spec,
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
 * Derived rather than fixed, which is `ResourcesWidget`'s rule for its category filter: an option
 * that can only ever produce the empty state is a control that does nothing, and a conversation
 * with no tables should not offer 表 in a menu.
 */
export function presentKinds(rows: readonly FigureRow[]): FigureKind[] {
  const kinds: FigureKind[] = [];
  if (rows.some((r) => r.kind === "diagram")) kinds.push("diagram");
  if (rows.some((r) => r.kind === "table")) kinds.push("table");
  if (rows.some((r) => r.kind === "plot")) kinds.push("plot");
  return kinds;
}
