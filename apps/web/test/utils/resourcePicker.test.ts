import { describe, expect, it } from "vitest";
import type {
  FileCategory,
  Note,
  StoredFile,
  WebPage,
  WorkResource,
  Workspace,
} from "../../src/api/types";
import type { FigureRow } from "../../src/utils/figures";
import { figureReference } from "../../src/utils/turnRefs";
import {
  LIST_PAGE,
  RESOURCE_PILLS,
  buildReferenceOptions,
  flatten,
  pillCategories,
  stepActive,
  type BuildOptionsInput,
} from "../../src/utils/resourcePicker";

/**
 * The `@` picker's list arithmetic.
 *
 * What is being pinned is the part a screenshot cannot show: which group a row is in, what a
 * filter does to the *other* group, and which row the arrow keys land on after the list is
 * rebuilt. Each of the rules below is a way this list goes wrong in normal use.
 */

const ALL_LABEL = "@所有工作区";

function workspace(id: string, name: string): Workspace {
  return {
    id,
    name,
    slug: id,
    dirPath: `/tmp/${id}`,
    workdirPath: `/tmp/${id}/workdir`,
    description: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    sessionCount: 0,
    lastActivityAt: null,
  };
}

function source(id: string, name: string, category: FileCategory): WorkResource {
  return reference(id, name, {
    id: `f-${id}`,
    sourceType: "attachment",
    title: name,
    path: `sources/raw/f-${id}`,
    mimeType: "text/plain",
    category,
    size: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}

/**
 * A kept web page. A page is a `resourceType` rather than a `FileCategory`, so it has no
 * category to filter by at all — which is what the pill cases below have to say out loud.
 */
function page(id: string, name: string): WorkResource {
  return reference(id, name, {
    id: `p-${id}`,
    sourceType: "agent_fetch",
    url: `https://example.com/${id}`,
    title: name,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}

function reference(
  id: string,
  title: string,
  resource: StoredFile | WebPage
): WorkResource {
  return {
    id,
    resourceType: "url" in resource ? "web_page" : "file",
    resourceId: resource.id,
    ownerType: "session",
    ownerId: "s1",
    title,
    parseStatus: "none",
    createdAt: "2026-01-01T00:00:00.000Z",
    workspaceName: "W",
    resource,
  };
}

const workspaces = [workspace("w1", "笔记"), workspace("w2", "代码库")];
const sources = [
  source("s1", "report.md", "markdown"),
  source("s2", "photo.png", "image"),
  source("s3", "main.ts", "code"),
  source("s4", "lecture.pdf", "document"),
  page("s5", "kept.html"),
  source("s6", "flow.mmd", "diagram"),
];

function build(overrides: Partial<BuildOptionsInput> = {}) {
  return buildReferenceOptions({
    query: "",
    tab: "all",
    pill: null,
    workspaces,
    sources,
    figures: [],
    notes: [],
    grantedIds: [],
    isAllGranted: false,
    allLabel: ALL_LABEL,
    limit: LIST_PAGE,
    ...overrides,
  });
}

const namesOf = (input: Partial<BuildOptionsInput> = {}): string[] =>
  flatten(build(input).groups).map((row) => row.name);

const groupKinds = (input: Partial<BuildOptionsInput> = {}): string[] =>
  build(input).groups.map((group) => group.kind);

describe("the tabs", () => {
  it("shows both kinds on 全部, workspaces first", () => {
    expect(groupKinds()).toEqual(["workspace", "resource"]);
    expect(namesOf()[0]).toBe(ALL_LABEL);
  });

  it("shows only workspaces on 工作区", () => {
    expect(groupKinds({ tab: "workspace" })).toEqual(["workspace"]);
    expect(namesOf({ tab: "workspace" })).toEqual([ALL_LABEL, "笔记", "代码库"]);
  });

  it("shows only sources on 资料", () => {
    expect(groupKinds({ tab: "resource" })).toEqual(["resource"]);
    expect(namesOf({ tab: "resource" })).not.toContain(ALL_LABEL);
  });
});

describe("the type pills", () => {
  it("maps each pill onto the categories it stands for", () => {
    expect(pillCategories("image")).toEqual(["image"]);
    // Two categories each, which is why a pill is not simply a category with a nicer name.
    expect(pillCategories("text")).toEqual(["text", "markdown"]);
    expect(pillCategories("code")).toEqual(["code", "diagram"]);
    expect(pillCategories("other")).toEqual(["document", "other"]);
  });

  it("has no pill for a page, because a page has no category", () => {
    // The v3 pill set had five. `page` was a category there — hand-set on a source whose name
    // could not say what it was — and in v4 that distinction is the `resourceType`, so a
    // category pill has nothing to name. Pinned here so re-adding one is a decision.
    expect(RESOURCE_PILLS).not.toContain("page");
  });

  it("keeps a page out of a pill's matches rather than guessing a category for it", () => {
    // A page is not an image, and a filter that admitted it would be saying it is.
    expect(namesOf({ pill: "image" })).toEqual(["photo.png"]);
  });

  it("narrows the source rows to the pill's categories", () => {
    expect(namesOf({ pill: "image" })).toEqual(["photo.png"]);
    expect(namesOf({ pill: "text" })).toEqual(["report.md"]);
    expect(namesOf({ pill: "code" }).sort()).toEqual(["flow.mmd", "main.ts"]);
    expect(namesOf({ pill: "other" })).toEqual(["lecture.pdf"]);
  });

  it("drops the workspace group entirely", () => {
    // A workspace has no source type, so a list still showing workspaces after you asked for
    // images reads as a filter that did not work.
    expect(groupKinds({ pill: "image" })).toEqual(["resource"]);
    expect(namesOf({ pill: "image" })).not.toContain(ALL_LABEL);
  });

  it("does not fight the 工作区 tab — a pill hides sources there anyway", () => {
    expect(groupKinds({ tab: "workspace", pill: "image" })).toEqual([]);
  });
});

describe("two references to one file", () => {
  /**
   * The same file, held twice: the registry's identity rules make identical user-supplied bytes
   * one *file* whatever uploaded them, so an image uploaded into a workspace and then from a
   * conversation is one entity with two references, and the account's listing draws both rows.
   */
  function heldTwice(): [WorkResource, WorkResource] {
    const first = source("s1", "photo.png", "image");
    const second: WorkResource = {
      ...source("s2", "photo.png", "image"),
      resourceId: first.resource.id,
      resource: first.resource,
    };
    return [first, second];
  }

  it("is two options, because a link names the reference rather than the file", () => {
    /*
     * **Both rows, deliberately.** They used to be collapsed into one — right while pointing at
     * either linked the same *entity*, since a link is what makes material readable later. A link
     * names a reference now, so this is a real choice: the conversation will read through the row
     * that was picked, with its own owner, title and parse state, and its chip names that row.
     * Collapsing them would be the picker deciding which reference the reader meant.
     *
     * The rows are told apart by their keys rather than their names, which are identical — the
     * `where` column is what a reader uses, and both sit in the same workspace here.
     */
    const [first, second] = heldTwice();
    const rows = flatten(build({ sources: heldTwice() }).groups).filter(
      (row) => row.name === "photo.png"
    );
    expect(rows.map((row) => row.key)).toEqual([`src:${first.id}`, `src:${second.id}`]);
  });
});

describe("matching", () => {
  it("matches everything on a bare `@`", () => {
    // Workspaces, the all-workspaces row, and every source — the picker is opened to browse as
    // much as to search.
    expect(namesOf()).toHaveLength(1 + workspaces.length + sources.length);
  });

  it("matches a name case-insensitively and as a substring", () => {
    expect(namesOf({ query: "REPORT" })).toContain("report.md");
    expect(namesOf({ query: "报告" })).toEqual([]);
  });

  it("matches workspaces by name too", () => {
    expect(namesOf({ tab: "workspace", query: "代码" })).toEqual(["代码库"]);
  });

  it("lets the all-workspaces row answer to the literal `all`", () => {
    // Its label is translated, so somebody who saw `@所有工作区` in Chinese has no stable word to
    // type on an English screen. The English word is the one that survives both.
    expect(namesOf({ tab: "workspace", query: "all" })).toContain(ALL_LABEL);
    expect(namesOf({ tab: "workspace", query: "所有" })).toContain(ALL_LABEL);
    expect(namesOf({ tab: "workspace", query: "zzz" })).toEqual([]);
  });
});

/**
 * The window, and the pager that grows it.
 *
 * One window over the whole list rather than a cap per group, because "还有 N 项" is only a
 * useful sentence if N is how many more a press will produce. The rows are all already in hand —
 * the account's match set is one request — so the window is display arithmetic and nothing else.
 */
describe("the window", () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => source(`x${i}`, `file-${i}.md`, "markdown"));

  it("shows a page, and says how much is past it", () => {
    const options = build({ sources: many(LIST_PAGE + 5), tab: "resource" });
    expect(flatten(options.groups)).toHaveLength(LIST_PAGE);
    expect(options.hidden).toBe(5);
  });

  it("says nothing is hidden when the list fits", () => {
    // The pager's own off state: a control that renders on a complete list would be one that
    // does nothing.
    expect(build({ tab: "resource" }).hidden).toBe(0);
  });

  it("shows everything once the window is opened past it", () => {
    const sources = many(LIST_PAGE + 5);
    const opened = build({ sources, tab: "resource", limit: LIST_PAGE * 2 });
    expect(flatten(opened.groups)).toHaveLength(LIST_PAGE + 5);
    expect(opened.hidden).toBe(0);
  });

  it("fills the window in draw order, so the coarser rows come first", () => {
    // Workspaces are the first group, and a window that ran out inside it must not skip ahead to
    // the material — the list would show a later group's rows above an earlier group's absence.
    const withSources = build({ sources: many(LIST_PAGE + 5), limit: 3 });
    expect(groupKinds({ sources: many(LIST_PAGE + 5), limit: 3 })).toEqual(["workspace"]);
    expect(withSources.hidden).toBe(workspaces.length + 1 + LIST_PAGE + 5 - 3);
  });

  it("never leaves a heading with nothing under it", () => {
    // What a window that runs out during the second group produces.
    const groups = build({ sources: many(20), limit: 4 }).groups;
    expect(groups.every((group) => group.options.length > 0)).toBe(true);
  });
});

describe("marking what is already granted", () => {
  it("marks a named workspace, so a picked row does not look unpicked", () => {
    const rows = flatten(build({ grantedIds: ["w1"] }).groups);
    expect(rows.find((row) => row.name === "笔记")?.granted).toBe(true);
    expect(rows.find((row) => row.name === "代码库")?.granted).toBe(false);
  });

  it("marks everything when the grant is `all`", () => {
    const rows = flatten(build({ isAllGranted: true }).groups);
    expect(rows.filter((row) => row.kind !== "resource").every((row) => row.granted)).toBe(true);
  });
});

/**
 * The conversation's own objects — a 图, a 表 and a 笔记 — which is what makes 资料 mean
 * "material" rather than "files".
 *
 * The two rules worth pinning are the ones a screenshot cannot show: that the three are drawn
 * under their own headings (a 图 and a 表 can share a name, so a flat list would show two
 * identical rows), and that a filter which cannot apply to them silences them rather than leaving
 * them in place looking unfiltered.
 */
describe("the conversation's own objects", () => {
  function figure(kind: "diagram" | "table", name: string, summary = ""): FigureRow {
    return {
      key: `${kind}:${name}`,
      kind,
      name,
      summary,
      threadTitle: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
      toolCallId: null,
      fileName: kind === "diagram" ? `${name}.mmd` : null,
      content: kind === "table" ? "| a |" : null,
      fileMissing: false,
    };
  }

  function note(id: string, content: string, quote = ""): Note {
    return {
      id,
      sessionId: "s1",
      messageId: null,
      type: "annotation",
      quote,
      occurrence: 0,
      content,
      targetKind: "text",
      targetRef: null,
      messageMissing: false,
      targetMissing: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
  }

  const objects = {
    figures: [figure("diagram", "flow", "登录时序"), figure("table", "scores", "成绩对比")],
    notes: [note("n1", "再看一遍第二章"), note("n2", "", "这一段没懂")],
  };

  it("draws one group per kind, after the material", () => {
    // Group headings are the dividers the reader sees, so one group per kind is the feature rather
    // than a layout choice.
    expect(groupKinds(objects)).toEqual(["workspace", "resource", "diagram", "table", "note"]);
  });

  it("keeps a 图 and a 表 of the same name apart", () => {
    const same = {
      figures: [figure("diagram", "scores", "图上的"), figure("table", "scores", "表里的")],
    };
    const rows = flatten(build(same).groups);
    const named = rows.filter((row) => row.name === "scores");
    expect(named.map((row) => row.kind)).toEqual(["diagram", "table"]);
    // And the two stage different references, which is the point of separating them.
    expect(named[0]!.ref).toMatchObject({ kind: "diagram", ref: "scores.mmd" });
    expect(named[1]!.ref).toMatchObject({ kind: "table", ref: "scores" });
  });

  it("stages the same reference 追问 does", () => {
    // `@` and 追问 are one mechanism, so the object a row carries is the one the figure panel's
    // ask button builds — not a second shape that agrees until a name is awkward.
    const rows = flatten(build(objects).groups);
    const diagram = rows.find((row) => row.kind === "diagram")!;
    expect(diagram.ref).toEqual(figureReference(figure("diagram", "flow", "登录时序")));
    const noteRow = rows.find((row) => row.kind === "note")!;
    expect(noteRow.ref).toMatchObject({ kind: "note", ref: "n1" });
  });

  it("shows a bare 标注 by its quote, the way the panel's own rows do", () => {
    // Narrowed to the notes alone, because the whole-list cap would cut the second one — which is
    // the cap doing its job, and is the case below.
    const rows = flatten(build({ ...objects, query: "没懂" }).groups);
    expect(rows.find((row) => row.key === "note:n2")?.name).toBe("这一段没懂");
  });

  it("counts the objects against the window like every other row", () => {
    /*
     * The note group is the last one drawn, so a window that runs out before it says so rather
     * than dropping the rows quietly — and the rows that did not fit are what the pager's count
     * is made of.
     */
    const options = build({ ...objects, limit: 9 });
    expect(options.groups.some((group) => group.kind === "note")).toBe(false);
    // Nine shown: the all-workspaces row, both named workspaces, and the six sources.
    expect(flatten(options.groups)).toHaveLength(9);
    expect(options.hidden).toBe(2 + 2);
  });

  it("matches a figure by its summary as well as its name", () => {
    expect(namesOf({ ...objects, query: "登录" })).toContain("flow");
    expect(namesOf({ ...objects, query: "成绩" })).toContain("scores");
  });

  it("drops all three when a pill is on, since a figure has no file category", () => {
    // A pill is a claim about a *file's* type. Leaving the objects in would be the filter
    // appearing not to have taken — and the workspaces go with them, which is the rule that was
    // already here for the same reason.
    expect(groupKinds({ ...objects, pill: "image" })).toEqual(["resource"]);
  });

  it("drops all three on the 工作区 tab", () => {
    expect(groupKinds({ ...objects, tab: "workspace" })).toEqual(["workspace"]);
  });

  it("draws none of them with no conversation's objects to offer", () => {
    expect(groupKinds()).toEqual(["workspace", "resource"]);
  });
});

describe("flatten and stepActive", () => {
  it("flattens across a group boundary in draw order", () => {
    const rows = flatten(build().groups);
    expect(rows[0]!.kind).toBe("all-workspaces");
    expect(rows[1]!.kind).toBe("workspace");
    expect(rows.some((row) => row.kind === "resource")).toBe(true);
  });

  it("wraps in both directions", () => {
    expect(stepActive(0, -1, 3)).toBe(2);
    expect(stepActive(2, 1, 3)).toBe(0);
    expect(stepActive(1, 1, 3)).toBe(2);
  });

  it("returns 0 for an empty list rather than NaN", () => {
    // A call site that indexes with this is then merely wrong rather than indexing `undefined`.
    expect(stepActive(3, 1, 0)).toBe(0);
    expect(stepActive(0, -1, 0)).toBe(0);
  });

  it("stays at 0 for a single row", () => {
    expect(stepActive(0, 1, 1)).toBe(0);
    expect(stepActive(0, -1, 1)).toBe(0);
  });
});
