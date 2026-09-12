import { describe, expect, it } from "vitest";
import type { DirectoryListing, FileEntry } from "@guided-learning/shared";
import { flattenTree, moveIndex, parentRowIndex } from "../../src/utils/fileTree";

/**
 * The tree's arithmetic. This is why it is not in the component: the rows a press of
 * ArrowLeft should land on is a rule, and a rule buried in a `.vue` file is covered by
 * Playwright or by nothing.
 */

function dir(path: string): FileEntry {
  return { name: path.slice(path.lastIndexOf("/") + 1), path, type: "dir", size: null, modifiedAt: null };
}

function file(path: string): FileEntry {
  return { name: path.slice(path.lastIndexOf("/") + 1), path, type: "file", size: 10, modifiedAt: null };
}

function listing(path: string, entries: FileEntry[]): DirectoryListing {
  return { path, entries, truncated: false };
}

const TREE: Record<string, DirectoryListing> = {
  "": listing("", [dir("src"), file("README.md")]),
  src: listing("src", [dir("src/utils"), file("src/index.ts")]),
  "src/utils": listing("src/utils", [file("src/utils/format.ts")]),
};

describe("flattenTree", () => {
  it("renders the root's children when nothing is expanded", () => {
    const rows = flattenTree(TREE, []);
    expect(rows.map((r) => r.entry.path)).toEqual(["src", "README.md"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 0]);
  });

  it("descends into an expanded directory, keeping render order", () => {
    const rows = flattenTree(TREE, ["src"]);
    expect(rows.map((r) => r.entry.path)).toEqual([
      "src",
      "src/utils",
      "src/index.ts",
      "README.md",
    ]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 1, 0]);
  });

  it("nests depth two levels down", () => {
    const rows = flattenTree(TREE, ["src", "src/utils"]);
    expect(rows.map((r) => `${r.entry.path}@${r.depth}`)).toEqual([
      "src@0",
      "src/utils@1",
      "src/utils/format.ts@2",
      "src/index.ts@1",
      "README.md@0",
    ]);
  });

  /**
   * An expanded directory whose listing has not arrived contributes a row and no children.
   * Rendering it as empty would be claiming to know something we do not.
   */
  it("contributes a row but no children for an expanded directory with no listing", () => {
    const rows = flattenTree(TREE, ["src", "src/utils"]);
    expect(rows.filter((r) => r.depth === 3)).toEqual([]);

    const unloaded = flattenTree({ "": listing("", [dir("a")]) }, ["a"]);
    expect(unloaded.map((r) => r.entry.path)).toEqual(["a"]);
  });

  it("is empty before the root has been read", () => {
    expect(flattenTree({}, [])).toEqual([]);
  });

  it("does not descend into a file that shares a directory's path", () => {
    const listings = {
      "": listing("", [file("src")]),
      src: listing("src", [file("src/index.ts")]),
    };
    expect(flattenTree(listings, ["src"]).map((r) => r.entry.path)).toEqual(["src"]);
  });
});

describe("moveIndex", () => {
  const rows = flattenTree(TREE, ["src"]);

  it("stops at the ends rather than wrapping", () => {
    expect(moveIndex(rows, 0, -1)).toBe(0);
    expect(moveIndex(rows, rows.length - 1, 1)).toBe(rows.length - 1);
  });

  it("moves one row at a time", () => {
    expect(moveIndex(rows, 1, 1)).toBe(2);
  });

  it("has nowhere to go in an empty tree", () => {
    expect(moveIndex([], 0, 1)).toBe(-1);
  });
});

describe("parentRowIndex", () => {
  const rows = flattenTree(TREE, ["src", "src/utils"]);

  it("finds the row that encloses a nested one", () => {
    // "src/utils/format.ts" sits under "src/utils", which sits under "src".
    expect(parentRowIndex(rows, 2)).toBe(1);
    expect(parentRowIndex(rows, 1)).toBe(0);
  });

  it("stays put at the top level", () => {
    expect(parentRowIndex(rows, 0)).toBe(0);
    expect(parentRowIndex(rows, 4)).toBe(4);
  });

  it("skips sibling subtrees rather than stopping at the previous row", () => {
    // Expanding `src` puts its children between `src` and `README.md`, so the parent of
    // `README.md` is the root — not the last child of `src`.
    expect(parentRowIndex(rows, 4)).toBe(4);
    expect(rows[4]?.entry.path).toBe("README.md");
    expect(rows[4]?.depth).toBe(0);
  });

  it("survives an index past the end", () => {
    expect(parentRowIndex(rows, 99)).toBe(99);
  });
});
