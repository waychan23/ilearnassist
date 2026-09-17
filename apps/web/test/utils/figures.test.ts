import { describe, expect, it } from "vitest";
import type { Diagram, Table } from "../../src/api/types";
import {
  FIGURE_FILTERS,
  filterFigures,
  figureRows,
  figureStem,
  presentKinds,
} from "../../src/utils/figures";

/**
 * The 图表 panel's arithmetic: two lists from the server, one list on screen.
 *
 * Here rather than in the component because the repo does not unit-test `.vue` files and this is
 * the part that can be wrong in a way a screenshot would not show — an order that puts an old
 * table above a new diagram, or a filter that hides the wrong kind.
 */

function diagram(over: Partial<Diagram> = {}): Diagram {
  return {
    id: "d1",
    sessionId: "s1",
    threadId: null,
    threadTitle: null,
    name: "auth-flow.mmd",
    summary: "登录流程",
    toolCallId: "c1",
    fileMissing: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function table(over: Partial<Table> = {}): Table {
  return {
    id: "t1",
    sessionId: "s1",
    threadId: null,
    threadTitle: null,
    name: "季度对比",
    summary: "三项指标",
    content: "| a |\n| --- |\n| 1 |",
    toolCallId: "c2",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("figureStem", () => {
  it("drops a diagram's extension and nothing else", () => {
    expect(figureStem("auth-flow.mmd")).toBe("auth-flow");
    // A dotted name keeps its dots: only the last segment is the extension.
    expect(figureStem("v1.2 flow.mmd")).toBe("v1.2 flow");
  });

  it("leaves a name with no extension alone", () => {
    // A table's name has no extension to strip, and a leading dot is not one either.
    expect(figureStem("季度对比")).toBe("季度对比");
    expect(figureStem(".hidden")).toBe(".hidden");
  });
});

describe("figureRows", () => {
  it("maps each kind onto one row shape, keeping what only that kind has", () => {
    const rows = figureRows([diagram()], [table()]);
    const [, t] = rows.sort((a, b) => (a.kind < b.kind ? -1 : 1));

    const d = rows.find((r) => r.kind === "diagram")!;
    expect(d).toMatchObject({
      key: "diagram:d1",
      // The label, not the file name — the panel shows what a person called it.
      name: "auth-flow",
      fileName: "auth-flow.mmd",
      content: null,
      fileMissing: false,
    });

    expect(t).toMatchObject({
      key: "table:t1",
      name: "季度对比",
      // No file name, and content where the diagram has one: the two differences the viewer and
      // the open control both branch on.
      fileName: null,
      content: "| a |\n| --- |\n| 1 |",
      fileMissing: false,
    });
  });

  it("interleaves the kinds by time, newest first", () => {
    // One chronological list rather than diagrams-then-tables: the panel answers "what has this
    // conversation made", and the filter is what narrows it to a kind.
    const rows = figureRows(
      [diagram({ id: "d1", updatedAt: "2026-01-01T00:00:00.000Z" })],
      [table({ id: "t1", updatedAt: "2026-02-01T00:00:00.000Z" })]
    );
    expect(rows.map((r) => r.kind)).toEqual(["table", "diagram"]);
  });

  it("does not sort an invalid timestamp into the middle", () => {
    // The comparison is on the ISO strings themselves — they sort lexicographically in the same
    // order they sort chronologically — so a malformed one cannot become a `NaN` comparator that
    // leaves the list in whatever order the engine felt like.
    const rows = figureRows(
      [diagram({ id: "d1", updatedAt: "not a date" })],
      [table({ id: "t1", updatedAt: "2026-02-01T00:00:00.000Z" })]
    );
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.kind === "diagram")).toBe(true);
  });

  it("answers an empty list for a conversation that has made nothing", () => {
    expect(figureRows([], [])).toEqual([]);
  });
});

describe("filterFigures", () => {
  const rows = figureRows([diagram()], [table()]);

  it("lets everything through on the empty value, which is the select's own", () => {
    expect(filterFigures(rows, "")).toHaveLength(2);
    expect(FIGURE_FILTERS[0]).toBe("");
  });

  it("narrows to one kind", () => {
    expect(filterFigures(rows, "diagram").map((r) => r.kind)).toEqual(["diagram"]);
    expect(filterFigures(rows, "table").map((r) => r.kind)).toEqual(["table"]);
  });

  it("hands back a copy, so a caller cannot reorder the panel's own list", () => {
    const only = filterFigures(rows, "");
    only.reverse();
    expect(rows[0]?.kind).toBe("diagram");
  });
});

describe("presentKinds", () => {
  it("offers only the kinds that are there", () => {
    // `SourcesWidget`'s rule for its category filter: an option that can only ever produce the
    // empty state is a control that does nothing.
    expect(presentKinds(figureRows([diagram()], []))).toEqual(["diagram"]);
    expect(presentKinds(figureRows([], [table()]))).toEqual(["table"]);
    // In the panel's own order, which is the order the two halves of 图表 are said in.
    expect(presentKinds(figureRows([diagram()], [table()]))).toEqual(["diagram", "table"]);
    expect(presentKinds([])).toEqual([]);
  });
});
