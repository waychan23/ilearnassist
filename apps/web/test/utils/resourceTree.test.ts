import { describe, expect, it } from "vitest";
import type { StoredFile, WorkResource } from "../../src/api/types";
import {
  allGroupKeys,
  flattenResourceTree,
  groupResources,
} from "../../src/utils/resourceTree";

/**
 * The source browser's tree.
 *
 * Two claims are worth pinning and neither is visible from the rendered result: a **path is
 * only meaningful under its owner** — two conversations may each hold `notes/a.md`, and a tree
 * that grouped by path alone would show one line for two different files — and a row's group is
 * the answer to "where did this come from", which is the whole reason the view exists.
 */

/**
 * A reference to a file, as the library lists one.
 *
 * `path` is the *account-relative* path a `StoredFile` carries — `workspaces/<slug>/workdir/…` —
 * and the tree strips the sandbox prefix back off it, so every case below can spell the path the
 * reader sees.
 */
function source(
  overrides: Partial<WorkResource> & Pick<WorkResource, "id">,
  file: Partial<StoredFile> = {}
): WorkResource {
  return {
    resourceType: "file",
    resourceId: overrides.id,
    ownerType: "workspace",
    ownerId: "w1",
    title: "untitled",
    parseStatus: "none",
    createdAt: "2026-01-01T00:00:00.000Z",
    workspaceId: "w1",
    workspaceName: "Study",
    resource: {
      id: `f-${overrides.id}`,
      sourceType: "agent_create",
      title: "untitled",
      path: "workspaces/w1/workdir/untitled",
      mimeType: "text/plain",
      category: "text",
      size: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      ...file,
    },
    ...overrides,
  };
}

/** The same, with the file's stored path and the reference's title given together. */
function fileAt(
  id: string,
  name: string,
  path: string,
  overrides: Partial<WorkResource> = {}
): WorkResource {
  return source({ id, title: name, ...overrides }, { path, title: name });
}

/** The stored path of a conversation-owned file. */
function sessionPath(ownerId: string, rel: string): string {
  return `workspaces/w1/sessions/${ownerId}/${rel}`;
}

describe("groupResources", () => {
  it("hangs a workspace file under its workspace", () => {
    const groups = groupResources([fileAt("s1", "a.md", "workspaces/w1/workdir/a.md")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.label).toBe("Study");
    expect(groups[0]!.sources.map((s) => s.title)).toEqual(["a.md"]);
  });

  it("nests a path by segment", () => {
    const groups = groupResources([
      fileAt("s1", "a.md", "workspaces/w1/workdir/notes/2026/a.md"),
    ]);
    const notes = groups[0]!.children[0]!;
    expect(notes.label).toBe("notes");
    expect(notes.children[0]!.label).toBe("2026");
    expect(notes.children[0]!.sources[0]!.title).toBe("a.md");
  });

  it("keeps one conversation's files out of another's, even at the same path", () => {
    // The claim the whole grouping exists for. Both rows are `notes/a.md`; they are two files.
    const groups = groupResources([
      fileAt("s1", "a.md", sessionPath("sess1", "notes/a.md"), {
        ownerType: "session",
        ownerId: "sess1",
        ownerName: "递归练习",
      }),
      fileAt("s2", "a.md", sessionPath("sess2", "notes/a.md"), {
        ownerType: "session",
        ownerId: "sess2",
        ownerName: "排序练习",
      }),
    ]);

    const [conversations] = [groups[0]!.children];
    expect(conversations.map((c) => c.label)).toEqual(["排序练习", "递归练习"]);
    for (const conversation of conversations) {
      expect(conversation.children[0]!.sources.map((s) => s.id)).toHaveLength(1);
    }
  });

  it("puts a row with no path at its owner rather than in a directory", () => {
    // An upload is named, not located: its bytes are under `sources/raw/`, which is not a sandbox.
    const groups = groupResources([
      fileAt("s1", "lecture.pdf", "sources/raw/f-s1.pdf", {
        ownerType: "session",
        ownerId: "sess1",
        ownerName: "递归练习",
      }),
    ]);
    const conversation = groups[0]!.children[0]!;
    expect(conversation.sources.map((s) => s.title)).toEqual(["lecture.pdf"]);
    expect(conversation.children).toEqual([]);
  });

  it("groups a workspace's own rows and its conversations' rows together", () => {
    const groups = groupResources([
      fileAt("s1", "shared.md", "workspaces/w1/workdir/shared.md"),
      fileAt("s2", "mine.md", sessionPath("sess1", "mine.md"), {
        ownerType: "session",
        ownerId: "sess1",
        ownerName: "递归练习",
      }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.sources.map((s) => s.title)).toEqual(["shared.md"]);
    expect(groups[0]!.children.map((c) => c.label)).toEqual(["递归练习"]);
  });

  it("separates two workspaces", () => {
    const groups = groupResources([
      fileAt("s1", "a.md", "workspaces/w1/workdir/a.md"),
      fileAt("s2", "b.md", "workspaces/w1/workdir/b.md", {
        workspaceId: "w2",
        workspaceName: "Research",
      }),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["Research", "Study"]);
  });

  it("files an ownerless row under a placeholder rather than dropping it", () => {
    // A row whose owner cannot be resolved is still material the user has; hiding it would be
    // the listing quietly losing something it was asked to show.
    const groups = groupResources([
      fileAt("s1", "orphan.md", "workspaces/w1/workdir/orphan.md", {
        workspaceId: undefined,
        workspaceName: undefined,
      }),
    ]);
    expect(groups[0]!.label).toBe("—");
    expect(groups[0]!.sources).toHaveLength(1);
  });
});

describe("flattenResourceTree", () => {
  const sources = [
    fileAt("s1", "shared.md", "workspaces/w1/workdir/shared.md"),
    fileAt("s2", "x.md", "workspaces/w1/workdir/notes/x.md"),
  ];

  it("emits a group as a line whether or not it is open", () => {
    const lines = flattenResourceTree(groupResources(sources), []);
    expect(lines.map((l) => l.kind)).toEqual(["group"]);
    expect(lines[0]!.label).toBe("Study");
  });

  it("emits a group's own rows before its subdirectories", () => {
    // Otherwise a directory header pushes the rows that are the group's own content below it,
    // which reads as if they were inside it.
    const lines = flattenResourceTree(groupResources(sources), ["ws:w1"]);
    expect(lines.map((l) => l.label)).toEqual(["Study", "shared.md", "notes"]);
  });

  it("increases the depth with each level", () => {
    const lines = flattenResourceTree(groupResources(sources), ["ws:w1", "ws:w1/notes"]);
    expect(lines.map((l) => l.depth)).toEqual([0, 1, 1, 2]);
  });

  it("gives every line a key that is unique across the tree", () => {
    // Two sources can share a name — that is the case the grouping exists for — so a key of
    // the name alone would collide and Vue would reuse the wrong row.
    const lines = flattenResourceTree(
      groupResources([
        fileAt("s1", "a.md", "workspaces/w1/workdir/a.md"),
        fileAt("s2", "a.md", "workspaces/w1/workdir/nested/a.md"),
      ]),
      ["ws:w1", "ws:w1/nested"]
    );
    expect(new Set(lines.map((l) => l.key)).size).toBe(lines.length);
  });
});

describe("allGroupKeys", () => {
  it("lists every group, so a caller can expand the whole tree", () => {
    const groups = groupResources([
      fileAt("s1", "a.md", "workspaces/w1/workdir/notes/2026/a.md"),
      fileAt("s2", "b.md", "workspaces/w1/workdir/b.md", { workspaceId: "w2", workspaceName: "R" }),
    ]);
    expect(allGroupKeys(groups).sort()).toEqual([
      "ws:w1",
      "ws:w1/notes",
      "ws:w1/notes/2026",
      "ws:w2",
    ]);
  });
});
