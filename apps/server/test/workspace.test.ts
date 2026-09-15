import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createWorkspaceDir,
  removeWorkspaceDir,
  resolveInWorkspace,
  slugify,
  uniqueSlug,
  uniqueUserSlug,
} from "../src/workspace.js";

/**
 * `resolveInWorkspace` is the security boundary every file tool goes through, so the
 * escape cases below are the point of this file — not the happy path.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gl-ws-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resolveInWorkspace", () => {
  const base = "/tmp/ws";

  it("resolves a simple relative path", () => {
    expect(resolveInWorkspace(base, "a.txt")).toEqual({ ok: true, path: "/tmp/ws/a.txt" });
  });

  it("resolves a nested relative path", () => {
    expect(resolveInWorkspace(base, "a/b/c.txt")).toEqual({ ok: true, path: "/tmp/ws/a/b/c.txt" });
  });

  it("resolves an absolute path that is already inside the workspace", () => {
    expect(resolveInWorkspace(base, "/tmp/ws/a.txt")).toEqual({ ok: true, path: "/tmp/ws/a.txt" });
  });

  it("treats an empty path as the workspace root", () => {
    expect(resolveInWorkspace(base, "")).toEqual({
      ok: false,
      error: expect.stringContaining("root itself is read-only"),
    });
  });

  it("refuses the workspace root unless allowRoot is set", () => {
    expect(resolveInWorkspace(base, ".").ok).toBe(false);
    expect(resolveInWorkspace(base, ".", true)).toEqual({ ok: true, path: "/tmp/ws" });
  });

  it("allows the root for an absolute path when allowRoot is set", () => {
    expect(resolveInWorkspace(base, "/tmp/ws", true)).toEqual({ ok: true, path: "/tmp/ws" });
  });

  describe("escape attempts", () => {
    const escapes = [
      "../secrets.txt",
      "../../etc/passwd",
      "a/../../outside.txt",
      "./../outside.txt",
      "/etc/passwd",
      "/tmp/ws-evil/file.txt", // sibling whose name shares a prefix
      "..",
    ];

    it.each(escapes)("rejects %s", (candidate) => {
      const result = resolveInWorkspace(base, candidate);
      expect(result.ok).toBe(false);
      expect(result.error).toContain("outside the workspace sandbox");
    });
  });

  it("resolves a path that dips out and back in", () => {
    // `a/../b.txt` never leaves the workspace, so it is legitimate.
    expect(resolveInWorkspace(base, "a/../b.txt")).toEqual({ ok: true, path: "/tmp/ws/b.txt" });
  });
});

describe("slugify", () => {
  it("lowercases and dash-separates", () => {
    expect(slugify("My New Workspace", "workspace")).toBe("my-new-workspace");
  });

  it("keeps CJK characters readable instead of dropping them", () => {
    expect(slugify("递归练习", "workspace")).toBe("递归练习");
  });

  it("collapses runs of punctuation and trims the edges", () => {
    expect(slugify("  --hello...world--  ", "workspace")).toBe("hello-world");
  });

  it("falls back to what the caller named, when nothing usable is left", () => {
    /*
     * The fallback has no default, and this is why: a user's directory named "workspace" would
     * be a quiet lie about what is in it, and a diagram's file even more so. Only the caller
     * knows what the slug is *for*, so it is the caller that names the last resort — the
     * parameter used to default to "workspace", which contradicted that and quietly made one
     * caller's answer everybody's.
     */
    expect(slugify("!!!", "workspace")).toBe("workspace");
    expect(slugify("   ", "workspace")).toBe("workspace");
    expect(slugify("!!!", "user")).toBe("user");
    expect(slugify("!!!", "diagram")).toBe("diagram");
  });

  it("caps the length", () => {
    expect(slugify("a".repeat(100), "workspace").length).toBe(48);
  });
});

describe("uniqueSlug", () => {
  it("returns the plain slug when nothing is in the way", () => {
    expect(uniqueSlug(root, "Notes")).toBe("notes");
  });

  it("suffixes until the directory name is free", () => {
    mkdirSync(join(root, "notes"));
    mkdirSync(join(root, "notes-1"));
    expect(uniqueSlug(root, "Notes")).toBe("notes-2");
  });
});

describe("uniqueUserSlug", () => {
  it("returns the plain slug when the name is not taken", () => {
    expect(uniqueUserSlug("Ada", () => false)).toBe("ada");
  });

  it("suffixes until the name is free", () => {
    const taken = new Set(["ada", "ada-1"]);
    expect(uniqueUserSlug("Ada", (slug) => taken.has(slug))).toBe("ada-2");
  });

  it("asks about the name it is considering, not just the first candidate", () => {
    // The predicate is consulted with each candidate in turn, which is what lets the caller
    // check the database *and* the filesystem rather than either alone.
    const asked: string[] = [];
    uniqueUserSlug("Ada", (slug) => {
      asked.push(slug);
      return slug !== "ada-3";
    });
    expect(asked).toEqual(["ada", "ada-1", "ada-2", "ada-3"]);
  });

  it("falls back to 'user' rather than 'workspace'", () => {
    expect(uniqueUserSlug("!!!", () => false)).toBe("user");
  });
});

describe("workspace directories", () => {
  it("creates the workspace directory and both directories inside it", () => {
    // All three at once: `workdir/` is the sandbox the agent works in and `sessions/` holds
    // the conversations' own directories. A workspace missing either is half-made, and
    // nothing downstream would notice until something tried to write into it.
    const dir = createWorkspaceDir(root, "alpha");
    expect(dir).toBe(resolve(root, "alpha"));
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(join(dir, "workdir"))).toBe(true);
    expect(existsSync(join(dir, "sessions"))).toBe(true);
  });

  it("creates a workspace directory under the root, including missing parents", () => {
    const nested = join(root, "deep", "nested");
    const dir = createWorkspaceDir(nested, "alpha");
    expect(existsSync(join(dir, "workdir"))).toBe(true);
  });

  it("removes a direct child of the root", () => {
    const dir = createWorkspaceDir(root, "alpha");
    writeFileSync(join(dir, "file.txt"), "x");
    removeWorkspaceDir(root, dir);
    expect(existsSync(dir)).toBe(false);
  });

  it("refuses to remove the root itself", () => {
    writeFileSync(join(root, "keep.txt"), "x");
    removeWorkspaceDir(root, root);
    expect(existsSync(root)).toBe(true);
  });

  it("refuses to remove a nested directory", () => {
    // Defense in depth: a stray path must not be able to delete a subtree.
    const nested = join(root, "alpha", "nested");
    mkdirSync(nested, { recursive: true });
    removeWorkspaceDir(root, nested);
    expect(existsSync(nested)).toBe(true);
  });

  it("refuses to remove something outside the root", () => {
    const outside = mkdtempSync(join(tmpdir(), "gl-outside-"));
    removeWorkspaceDir(root, outside);
    expect(existsSync(outside)).toBe(true);
    rmSync(outside, { recursive: true, force: true });
  });
});
