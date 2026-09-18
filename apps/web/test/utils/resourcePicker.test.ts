import { describe, expect, it } from "vitest";
import type { FileCategory, StoredFile, WebPage, WorkResource, Workspace } from "../../src/api/types";
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
