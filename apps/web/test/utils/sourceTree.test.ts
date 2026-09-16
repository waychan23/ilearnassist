import { describe, expect, it } from "vitest";
import type { Source } from "../../src/api/types";
import {
  allGroupKeys,
  flattenSourceTree,
  groupSources,
} from "../../src/utils/sourceTree";

/**
 * The source browser's tree.
 *
 * Two claims are worth pinning and neither is visible from the rendered result: a **path is
 * only meaningful under its owner** — two conversations may each hold `notes/a.md`, and a tree
 * that grouped by path alone would show one line for two different files — and a row's group is
 * the answer to "where did this come from", which is the whole reason the view exists.
 */

function source(overrides: Partial<Source> & Pick<Source, "id" | "name">): Source {
  return {
    mimeType: "text/plain",
    size: 1,
    kind: "file",
    ownerKind: "workspace",
    ownerId: "w1",
    origin: "agent_workspace",
    storage: "workspace",
    category: "text",
    createdAt: "2026-01-01T00:00:00.000Z",
    workspaceId: "w1",
    workspaceName: "Study",
    ...overrides,
  };
}

describe("groupSources", () => {
  it("hangs a workspace file under its workspace", () => {
    const groups = groupSources([source({ id: "s1", name: "a.md", relPath: "a.md" })]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.label).toBe("Study");
    expect(groups[0]!.sources.map((s) => s.name)).toEqual(["a.md"]);
  });

  it("nests a path by segment", () => {
    const groups = groupSources([
      source({ id: "s1", name: "a.md", relPath: "notes/2026/a.md" }),
    ]);
    const notes = groups[0]!.children[0]!;
    expect(notes.label).toBe("notes");
    expect(notes.children[0]!.label).toBe("2026");
    expect(notes.children[0]!.sources[0]!.name).toBe("a.md");
  });

  it("keeps one conversation's files out of another's, even at the same path", () => {
    // The claim the whole grouping exists for. Both rows are `notes/a.md`; they are two files.
    const groups = groupSources([
      source({
        id: "s1",
        name: "a.md",
        relPath: "notes/a.md",
        ownerKind: "session",
        ownerId: "sess1",
        ownerName: "递归练习",
        storage: "session",
        origin: "agent_session",
      }),
      source({
        id: "s2",
        name: "a.md",
        relPath: "notes/a.md",
        ownerKind: "session",
        ownerId: "sess2",
        ownerName: "排序练习",
        storage: "session",
        origin: "agent_session",
      }),
    ]);

    const [conversations] = [groups[0]!.children];
    expect(conversations.map((c) => c.label)).toEqual(["排序练习", "递归练习"]);
    for (const conversation of conversations) {
      expect(conversation.children[0]!.sources.map((s) => s.id)).toHaveLength(1);
    }
  });

  it("puts a row with no path at its owner rather than in a directory", () => {
    // An upload is named, not located: it has no `relPath` at all.
    const groups = groupSources([
      source({
        id: "s1",
        name: "lecture.pdf",
        ownerKind: "session",
        ownerId: "sess1",
        ownerName: "递归练习",
        origin: "session_attachment",
        storage: "upload",
      }),
    ]);
    const conversation = groups[0]!.children[0]!;
    expect(conversation.sources.map((s) => s.name)).toEqual(["lecture.pdf"]);
    expect(conversation.children).toEqual([]);
  });

  it("groups a workspace's own rows and its conversations' rows together", () => {
    const groups = groupSources([
      source({ id: "s1", name: "shared.md", relPath: "shared.md" }),
      source({
        id: "s2",
        name: "mine.md",
        relPath: "mine.md",
        ownerKind: "session",
        ownerId: "sess1",
        ownerName: "递归练习",
        storage: "session",
        origin: "agent_session",
      }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.sources.map((s) => s.name)).toEqual(["shared.md"]);
    expect(groups[0]!.children.map((c) => c.label)).toEqual(["递归练习"]);
  });

  it("separates two workspaces", () => {
    const groups = groupSources([
      source({ id: "s1", name: "a.md", relPath: "a.md" }),
      source({
        id: "s2",
        name: "b.md",
        relPath: "b.md",
        workspaceId: "w2",
        workspaceName: "Research",
      }),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["Research", "Study"]);
  });

  it("files an ownerless row under a placeholder rather than dropping it", () => {
    // A row whose owner cannot be resolved is still material the user has; hiding it would be
    // the listing quietly losing something it was asked to show.
    const groups = groupSources([
      source({ id: "s1", name: "orphan.md", relPath: "orphan.md", workspaceId: undefined, workspaceName: undefined }),
    ]);
    expect(groups[0]!.label).toBe("—");
    expect(groups[0]!.sources).toHaveLength(1);
  });
});

describe("flattenSourceTree", () => {
  const sources = [
    source({ id: "s1", name: "shared.md", relPath: "shared.md" }),
    source({ id: "s2", name: "notes/x.md", relPath: "notes/x.md" }),
  ];

  it("emits a group as a line whether or not it is open", () => {
    const lines = flattenSourceTree(groupSources(sources), []);
    expect(lines.map((l) => l.kind)).toEqual(["group"]);
    expect(lines[0]!.label).toBe("Study");
  });

  it("emits a group's own rows before its subdirectories", () => {
    // Otherwise a directory header pushes the rows that are the group's own content below it,
    // which reads as if they were inside it.
    const lines = flattenSourceTree(groupSources(sources), ["ws:w1"]);
    expect(lines.map((l) => l.label)).toEqual(["Study", "shared.md", "notes"]);
  });

  it("increases the depth with each level", () => {
    const lines = flattenSourceTree(groupSources(sources), ["ws:w1", "ws:w1/notes"]);
    expect(lines.map((l) => l.depth)).toEqual([0, 1, 1, 2]);
  });

  it("gives every line a key that is unique across the tree", () => {
    // Two sources can share a name — that is the case the grouping exists for — so a key of
    // the name alone would collide and Vue would reuse the wrong row.
    const lines = flattenSourceTree(
      groupSources([
        source({ id: "s1", name: "a.md", relPath: "a.md" }),
        source({ id: "s2", name: "a.md", relPath: "nested/a.md" }),
      ]),
      ["ws:w1", "ws:w1/nested"]
    );
    expect(new Set(lines.map((l) => l.key)).size).toBe(lines.length);
  });
});

describe("allGroupKeys", () => {
  it("lists every group, so a caller can expand the whole tree", () => {
    const groups = groupSources([
      source({ id: "s1", name: "a.md", relPath: "notes/2026/a.md" }),
      source({ id: "s2", name: "b.md", relPath: "b.md", workspaceId: "w2", workspaceName: "R" }),
    ]);
    expect(allGroupKeys(groups).sort()).toEqual([
      "ws:w1",
      "ws:w1/notes",
      "ws:w1/notes/2026",
      "ws:w2",
    ]);
  });
});
