import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildFileTools } from "../../src/tools/fileTools.js";

let workspace: string;
let tools: ReturnType<typeof buildFileTools>;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "gl-files-"));
  tools = buildFileTools(workspace);
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("write_file", () => {
  it("writes a file and reports the size", async () => {
    await expect(tools.writeFile.invoke({ path: "a.txt", content: "hello" })).resolves.toBe(
      "Wrote 5 characters to a.txt."
    );
    expect(readFileSync(join(workspace, "a.txt"), "utf8")).toBe("hello");
  });

  it("creates missing parent directories", async () => {
    await tools.writeFile.invoke({ path: "deep/nested/a.txt", content: "x" });
    expect(existsSync(join(workspace, "deep/nested/a.txt"))).toBe(true);
  });

  it("overwrites an existing file", async () => {
    await tools.writeFile.invoke({ path: "a.txt", content: "first" });
    await tools.writeFile.invoke({ path: "a.txt", content: "second" });
    expect(readFileSync(join(workspace, "a.txt"), "utf8")).toBe("second");
  });
});

describe("read_file", () => {
  it("reads a file back", async () => {
    writeFileSync(join(workspace, "a.txt"), "contents");
    await expect(tools.readFile.invoke({ path: "a.txt" })).resolves.toBe("contents");
  });

  it("truncates a long file and flags it", async () => {
    writeFileSync(join(workspace, "big.txt"), "x".repeat(45_000));
    const result = (await tools.readFile.invoke({ path: "big.txt" })) as string;
    expect(result).toContain("truncated at 40000 characters");
    expect(result.length).toBeLessThan(41_000);
  });
});

describe("list_files", () => {
  it("lists the workspace root", async () => {
    writeFileSync(join(workspace, "a.txt"), "x");
    const parsed = JSON.parse((await tools.listFiles.invoke({ path: "." })) as string) as {
      entries: { name: string; type: string }[];
    };
    expect(parsed.entries).toEqual([{ name: "a.txt", type: "file" }]);
  });

  it("puts directories before files, each alphabetically", async () => {
    writeFileSync(join(workspace, "b.txt"), "x");
    writeFileSync(join(workspace, "a.txt"), "x");
    await tools.createDirectory.invoke({ path: "zeta" });
    await tools.createDirectory.invoke({ path: "alpha" });

    const parsed = JSON.parse((await tools.listFiles.invoke({ path: "." })) as string) as {
      entries: { name: string }[];
    };
    expect(parsed.entries.map((e) => e.name)).toEqual(["alpha", "zeta", "a.txt", "b.txt"]);
  });

  it("prefixes entries with the relative directory being listed", async () => {
    await tools.createDirectory.invoke({ path: "sub" });
    writeFileSync(join(workspace, "sub/inner.txt"), "x");
    const parsed = JSON.parse((await tools.listFiles.invoke({ path: "sub" })) as string) as {
      entries: { name: string }[];
    };
    expect(parsed.entries[0]!.name).toBe("sub/inner.txt");
  });

  it("defaults to the root when no path is given", async () => {
    // The schema declares `.default(".")`, so an omitted path must not blow up.
    await expect(tools.listFiles.invoke({})).resolves.toBeTypeOf("string");
  });

  it("caps the listing and says how many were hidden", async () => {
    for (let i = 0; i < 205; i++) writeFileSync(join(workspace, `f${i}.txt`), "x");
    const result = (await tools.listFiles.invoke({ path: "." })) as string;
    expect(result).toContain("truncated from 205 entries");
  });
});

describe("create_directory and delete_file", () => {
  it("creates a directory with parents", async () => {
    await expect(tools.createDirectory.invoke({ path: "a/b" })).resolves.toBe("Created directory a/b.");
    expect(existsSync(join(workspace, "a/b"))).toBe(true);
  });

  it("deletes a file", async () => {
    writeFileSync(join(workspace, "a.txt"), "x");
    await expect(tools.deleteFile.invoke({ path: "a.txt" })).resolves.toBe("Deleted a.txt.");
    expect(existsSync(join(workspace, "a.txt"))).toBe(false);
  });

  it("deletes an empty directory", async () => {
    await tools.createDirectory.invoke({ path: "empty" });
    await tools.deleteFile.invoke({ path: "empty" });
    expect(existsSync(join(workspace, "empty"))).toBe(false);
  });

  it("refuses to delete a non-empty directory", async () => {
    // `delete_file` is deliberately not gated behind a confirm dialog, so it must not be
    // able to take a populated tree with it.
    mkdirSync(join(workspace, "full"), { recursive: true });
    writeFileSync(join(workspace, "full/a.txt"), "x");
    await expect(tools.deleteFile.invoke({ path: "full" })).rejects.toThrow();
    expect(existsSync(join(workspace, "full/a.txt"))).toBe(true);
  });
});

describe("workspace sandbox", () => {
  const escapes = ["../outside.txt", "../../etc/passwd", "/etc/passwd", "a/../../outside.txt"];

  it.each(escapes)("refuses to write to %s", async (path) => {
    await expect(tools.writeFile.invoke({ path, content: "x" })).rejects.toThrow(
      /outside the workspace sandbox/
    );
  });

  it.each(escapes)("refuses to read %s", async (path) => {
    await expect(tools.readFile.invoke({ path })).rejects.toThrow(/outside the workspace sandbox/);
  });

  it.each(escapes)("refuses to delete %s", async (path) => {
    await expect(tools.deleteFile.invoke({ path })).rejects.toThrow(/outside the workspace sandbox/);
  });

  it.each(escapes)("refuses to create a directory at %s", async (path) => {
    await expect(tools.createDirectory.invoke({ path })).rejects.toThrow(
      /outside the workspace sandbox/
    );
  });

  it("still allows a path that dips out and back in", async () => {
    await expect(tools.writeFile.invoke({ path: "a/../b.txt", content: "x" })).resolves.toContain("b.txt");
  });
});
