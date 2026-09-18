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
  GROUP_LIMIT,
  RESOURCE_PILLS,
  TOTAL_LIMIT,
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
    ...overrides,
  });
}

const namesOf = (input: Partial<BuildOptionsInput> = {}): string[] =>
  flatten(build(input)).map((row) => row.name);

const groupKinds = (input: Partial<BuildOptionsInput> = {}): string[] =>
  build(input).map((group) => group.kind);

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

describe("matching", () => {
  it("matches everything on a bare `@`", () => {
    expect(namesOf()).toHaveLength(
      Math.min(TOTAL_LIMIT, 1 + workspaces.length + sources.length)
    );
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

describe("caps", () => {
  it("caps a group and reports what did not fit", () => {
    const many = Array.from({ length: GROUP_LIMIT + 5 }, (_, i) => source(`x${i}`, `file-${i}.md`, "markdown"));
    const [group] = build({ sources: many, tab: "resource" });
    expect(group!.options).toHaveLength(GROUP_LIMIT);
    expect(group!.hidden).toBe(5);
  });

  it("caps the whole list, so the menu is never taller than the composer", () => {
    const many = Array.from({ length: 40 }, (_, i) => source(`x${i}`, `file-${i}.md`, "markdown"));
    expect(flatten(build({ sources: many })).length).toBeLessThanOrEqual(TOTAL_LIMIT);
  });

  it("never leaves a heading with nothing under it", () => {
    // What the total cap produces when it runs out during the second group.
    const many = Array.from({ length: 20 }, (_, i) => source(`x${i}`, `file-${i}.md`, "markdown"));
    const groups = build({ sources: many });
    expect(groups.every((group) => group.options.length > 0)).toBe(true);
  });
});

describe("marking what is already granted", () => {
  it("marks a named workspace, so a picked row does not look unpicked", () => {
    const rows = flatten(build({ grantedIds: ["w1"] }));
    expect(rows.find((row) => row.name === "笔记")?.granted).toBe(true);
    expect(rows.find((row) => row.name === "代码库")?.granted).toBe(false);
  });

  it("marks everything when the grant is `all`", () => {
    const rows = flatten(build({ isAllGranted: true }));
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
    const rows = flatten(build(same));
    const named = rows.filter((row) => row.name === "scores");
    expect(named.map((row) => row.kind)).toEqual(["diagram", "table"]);
    // And the two stage different references, which is the point of separating them.
    expect(named[0]!.ref).toMatchObject({ kind: "diagram", ref: "scores.mmd" });
    expect(named[1]!.ref).toMatchObject({ kind: "table", ref: "scores" });
  });

  it("stages the same reference 追问 does", () => {
    // `@` and 追问 are one mechanism, so the object a row carries is the one the figure panel's
    // ask button builds — not a second shape that agrees until a name is awkward.
    const rows = flatten(build(objects));
    const diagram = rows.find((row) => row.kind === "diagram")!;
    expect(diagram.ref).toEqual(figureReference(figure("diagram", "flow", "登录时序")));
    const noteRow = rows.find((row) => row.kind === "note")!;
    expect(noteRow.ref).toMatchObject({ kind: "note", ref: "n1" });
  });

  it("shows a bare 标注 by its quote, the way the panel's own rows do", () => {
    // Narrowed to the notes alone, because the whole-list cap would cut the second one — which is
    // the cap doing its job, and is the case below.
    const rows = flatten(build({ ...objects, query: "没懂" }));
    expect(rows.find((row) => row.key === "note:n2")?.name).toBe("这一段没懂");
  });

  it("counts the objects against the whole-list cap like every other row", () => {
    // Three workspaces' worth of rows above them leave the note group one slot, and the overflow
    // is reported rather than silently dropped.
    const groups = build(objects);
    const notes = groups.find((group) => group.kind === "note")!;
    expect(notes.options).toHaveLength(1);
    expect(notes.hidden).toBe(1);
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
    const rows = flatten(build());
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
