import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileToolsFor, type FileToolHarness } from "../helpers/fileTools.js";

/**
 * The file tools, and the two-sandbox rule they now enforce.
 *
 * A workspace's `workdir/` is shared by every conversation in it; a conversation's own
 * `sessions/<id>/` is not. Which one a call means is `location`, and when it is absent the rule
 * differs by operation on purpose — a write follows the configured default, a read falls back
 * so a model can still find what it wrote under a different default, and a delete refuses when
 * the same path exists in both.
 */
let root: string;
let h: FileToolHarness;
const tools = () => h.tools;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gl-files-"));
  h = fileToolsFor(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("write_file", () => {
  it("writes into the conversation folder when no location is given", async () => {
    await tools().writeFile.invoke({ path: "notes.md", content: "hello" });
    expect(readFileSync(join(h.sessionDir, "notes.md"), "utf8")).toBe("hello");
    expect(existsSync(join(h.workdir, "notes.md"))).toBe(false);
  });

  it("writes into the shared workspace folder when asked", async () => {
    await tools().writeFile.invoke({ path: "notes.md", content: "hello", location: "workspace" });
    expect(readFileSync(join(h.workdir, "notes.md"), "utf8")).toBe("hello");
    expect(existsSync(join(h.sessionDir, "notes.md"))).toBe(false);
  });

  it("follows a session whose default is the workspace", async () => {
    const shared = fileToolsFor(root, { defaultLocation: "workspace" });
    await shared.tools.writeFile.invoke({ path: "a.txt", content: "x" });
    expect(existsSync(join(shared.workdir, "a.txt"))).toBe(true);
  });

  it("creates missing parent directories", async () => {
    await tools().writeFile.invoke({ path: "deep/nested/a.txt", content: "x" });
    expect(existsSync(join(h.sessionDir, "deep/nested/a.txt"))).toBe(true);
  });

  it("says which folder it wrote into, and which reference it became", async () => {
    /*
     * The id in the sentence is the `ila_collect_page` shape, and both of its readers are why:
     * the model gets a handle it can hand to `read_document` without listing a directory first,
     * and the message list's file card reads it to offer 标注/笔记 — a note is anchored to a
     * *reference*, and a card has only a path. `FileCard.vue` parses this sentence, so the
     * wording is a contract rather than a message.
     */
    await expect(
      tools().writeFile.invoke({ path: "a.txt", content: "hello" })
    ).resolves.toBe("Wrote 5 characters to a.txt in the session folder (id wr-1).");
  });

  it("omits the id when the registry made no row", async () => {
    // A caller whose `register` returns nothing still gets a sentence that reads as a sentence.
    // `ctx` is the harness's own object, so this reaches the one callback the tools use.
    h.ctx.register = () => undefined;
    await expect(
      h.tools.writeFile.invoke({ path: "b.txt", content: "hi" })
    ).resolves.toBe("Wrote 2 characters to b.txt in the session folder.");
  });

  /*
   * Registration is the half of this change that a file's bytes cannot show. Every write has to
   * leave a row, because the registry is what the source browser, `@`-reference and the file
   * manager address a file by — and a writer that forgot would be invisible rather than wrong.
   */
  it("registers the write with its location, its path inside that root and its size", async () => {
    await tools().writeFile.invoke({ path: "deep/a.txt", content: "hello", location: "workspace" });
    expect(h.written).toEqual([{ location: "workspace", relPath: "deep/a.txt", size: 5 }]);
  });

  it("registers a byte length, not a character count", async () => {
    // Four characters, twelve bytes of UTF-8 — a size that counted characters would make the
    // row disagree with the `stat` the listing does a moment later.
    await tools().writeFile.invoke({ path: "cn.txt", content: "中文字" });
    expect(h.written[0]!.size).toBe(Buffer.byteLength("中文字", "utf8"));
  });

  it("overwrites an existing file", async () => {
    await tools().writeFile.invoke({ path: "a.txt", content: "first" });
    await tools().writeFile.invoke({ path: "a.txt", content: "second" });
    expect(readFileSync(join(h.sessionDir, "a.txt"), "utf8")).toBe("second");
  });
});

describe("read_file", () => {
  it("reads from the conversation folder", async () => {
    writeFileSync(join(h.sessionDir, "a.txt"), "contents");
    await expect(tools().readFile.invoke({ path: "a.txt" })).resolves.toBe("contents");
  });

  it("falls back to the other folder and says so", async () => {
    // The default is `session` and this file is in the workspace, which is exactly the case a
    // model meets after a setting changes under a conversation: the file it wrote is still
    // there, and a silent "not found" would teach it to stop trusting the tools.
    writeFileSync(join(h.workdir, "a.txt"), "shared");
    const result = (await tools().readFile.invoke({ path: "a.txt" })) as string;
    expect(result).toContain("[from the workspace folder]");
    expect(result).toContain("shared");
  });

  it("prefers the default folder when both have the path", async () => {
    writeFileSync(join(h.sessionDir, "a.txt"), "mine");
    writeFileSync(join(h.workdir, "a.txt"), "shared");
    await expect(tools().readFile.invoke({ path: "a.txt" })).resolves.toBe("mine");
  });

  it("honours an explicit location instead of falling back", async () => {
    writeFileSync(join(h.sessionDir, "a.txt"), "mine");
    writeFileSync(join(h.workdir, "a.txt"), "shared");
    await expect(
      tools().readFile.invoke({ path: "a.txt", location: "workspace" })
    ).resolves.toBe("shared");
  });

  it("truncates a long file and flags it", async () => {
    writeFileSync(join(h.sessionDir, "big.txt"), "x".repeat(45_000));
    const result = (await tools().readFile.invoke({ path: "big.txt" })) as string;
    expect(result).toContain("truncated at 40000 characters");
    expect(result.length).toBeLessThan(41_000);
  });

  it("names both folders it looked in when the file is nowhere", async () => {
    await expect(tools().readFile.invoke({ path: "gone.txt" })).rejects.toThrow(
      /the session folder or the workspace folder/
    );
  });
});

describe("list_files", () => {
  it("lists the folder the default names", async () => {
    writeFileSync(join(h.sessionDir, "a.txt"), "x");
    writeFileSync(join(h.workdir, "shared.txt"), "x");
    const parsed = JSON.parse((await tools().listFiles.invoke({ path: "." })) as string) as {
      location: string;
      entries: { name: string; type: string }[];
    };
    expect(parsed.location).toBe("session");
    expect(parsed.entries).toEqual([{ name: "a.txt", type: "file" }]);
  });

  it("lists the other folder when asked", async () => {
    writeFileSync(join(h.workdir, "shared.txt"), "x");
    const parsed = JSON.parse(
      (await tools().listFiles.invoke({ path: ".", location: "workspace" })) as string
    ) as { entries: { name: string }[] };
    expect(parsed.entries.map((e) => e.name)).toEqual(["shared.txt"]);
  });

  it("puts directories before files, each alphabetically", async () => {
    writeFileSync(join(h.sessionDir, "b.txt"), "x");
    writeFileSync(join(h.sessionDir, "a.txt"), "x");
    await tools().createDirectory.invoke({ path: "zeta" });
    await tools().createDirectory.invoke({ path: "alpha" });

    const parsed = JSON.parse((await tools().listFiles.invoke({ path: "." })) as string) as {
      entries: { name: string }[];
    };
    expect(parsed.entries.map((e) => e.name)).toEqual(["alpha", "zeta", "a.txt", "b.txt"]);
  });

  it("prefixes entries with the relative directory being listed", async () => {
    await tools().createDirectory.invoke({ path: "sub" });
    writeFileSync(join(h.sessionDir, "sub/inner.txt"), "x");
    const parsed = JSON.parse((await tools().listFiles.invoke({ path: "sub" })) as string) as {
      entries: { name: string }[];
    };
    expect(parsed.entries[0]!.name).toBe("sub/inner.txt");
  });

  it("defaults to the root when no path is given", async () => {
    // The schema declares `.default(".")`, so an omitted path must not blow up.
    await expect(tools().listFiles.invoke({})).resolves.toBeTypeOf("string");
  });

  it("caps the listing and says how many were hidden", async () => {
    for (let i = 0; i < 205; i++) writeFileSync(join(h.sessionDir, `f${i}.txt`), "x");
    const result = (await tools().listFiles.invoke({ path: "." })) as string;
    expect(result).toContain("truncated from 205 entries");
  });
});

describe("create_directory and delete_file", () => {
  it("creates a directory with parents", async () => {
    await expect(tools().createDirectory.invoke({ path: "a/b" })).resolves.toBe(
      "Created directory a/b in the session folder."
    );
    expect(existsSync(join(h.sessionDir, "a/b"))).toBe(true);
  });

  it("registers nothing for a directory", async () => {
    // A directory is not a source. Stated as a test so the symmetry argument — "every write
    // leaves a row" — cannot quietly grow a row for something no model can read.
    await tools().createDirectory.invoke({ path: "a/b" });
    expect(h.written).toEqual([]);
  });

  it("deletes a file", async () => {
    writeFileSync(join(h.sessionDir, "a.txt"), "x");
    await expect(tools().deleteFile.invoke({ path: "a.txt" })).resolves.toBe(
      "Deleted a.txt from the session folder."
    );
    expect(existsSync(join(h.sessionDir, "a.txt"))).toBe(false);
  });

  it("hands a file that has a reference to the registry rather than unlinking it", async () => {
    /*
     * **The v5 rule, stated where the model can violate it.** A file some writer made
     * referenceable is deleted *through* that reference — one operation owns the rows, the bytes
     * and the trash — so the tool must not remove the bytes first: the registry's delete would
     * then be handed a file that is already gone. It calls `unregister` instead, and the bytes
     * are left for whoever handles it.
     */
    h.handlesRemoval = true;
    writeFileSync(join(h.sessionDir, "a.txt"), "x");
    await expect(tools().deleteFile.invoke({ path: "a.txt" })).resolves.toBe(
      "Deleted a.txt from the session folder."
    );
    expect(h.removed).toEqual([{ location: "session", relPath: "a.txt" }]);
    expect(existsSync(join(h.sessionDir, "a.txt"))).toBe(true);
  });

  it("unlinks the file itself when nothing ever referenced it", async () => {
    // The other answer: a `.mmd` nobody drew, a parse result — no reference, so the bytes are the
    // whole of it, and the tool has to do the work the registry declined.
    h.handlesRemoval = false;
    writeFileSync(join(h.sessionDir, "loose.txt"), "x");
    await tools().deleteFile.invoke({ path: "loose.txt" });
    expect(h.removed).toEqual([{ location: "session", relPath: "loose.txt" }]);
    expect(existsSync(join(h.sessionDir, "loose.txt"))).toBe(false);
  });

  it("deletes an empty directory", async () => {
    await tools().createDirectory.invoke({ path: "empty" });
    await tools().deleteFile.invoke({ path: "empty" });
    expect(existsSync(join(h.sessionDir, "empty"))).toBe(false);
  });

  it("refuses to delete a non-empty directory", async () => {
    // `delete_file` is deliberately not gated behind a confirm dialog, so it must not be
    // able to take a populated tree with it.
    mkdirSync(join(h.sessionDir, "full"), { recursive: true });
    writeFileSync(join(h.sessionDir, "full/a.txt"), "x");
    await expect(tools().deleteFile.invoke({ path: "full" })).rejects.toThrow();
    expect(existsSync(join(h.sessionDir, "full/a.txt"))).toBe(true);
  });

  it("refuses when the same path is in both folders", async () => {
    // The one operation where a guess cannot be walked back, so an ambiguity is an error the
    // model resolves by naming a folder.
    writeFileSync(join(h.sessionDir, "a.txt"), "mine");
    writeFileSync(join(h.workdir, "a.txt"), "shared");
    await expect(tools().deleteFile.invoke({ path: "a.txt" })).rejects.toThrow(
      /exists in both folders/
    );
    expect(existsSync(join(h.sessionDir, "a.txt"))).toBe(true);
    expect(existsSync(join(h.workdir, "a.txt"))).toBe(true);
  });

  it("deletes the one it can find when the other folder does not have it", async () => {
    writeFileSync(join(h.workdir, "only-shared.txt"), "x");
    await expect(tools().deleteFile.invoke({ path: "only-shared.txt" })).resolves.toBe(
      "Deleted only-shared.txt from the workspace folder."
    );
  });

  it("deletes from the named folder when asked", async () => {
    writeFileSync(join(h.sessionDir, "a.txt"), "mine");
    writeFileSync(join(h.workdir, "a.txt"), "shared");
    await tools().deleteFile.invoke({ path: "a.txt", location: "workspace" });
    expect(existsSync(join(h.workdir, "a.txt"))).toBe(false);
    expect(existsSync(join(h.sessionDir, "a.txt"))).toBe(true);
  });

  it("says so when the path is in neither folder", async () => {
    await expect(tools().deleteFile.invoke({ path: "gone.txt" })).rejects.toThrow(
      /does not exist in either folder/
    );
  });
});

describe("sandbox", () => {
  const escapes = ["../outside.txt", "../../etc/passwd", "/etc/passwd", "a/../../outside.txt"];

  it.each(escapes)("refuses to write to %s", async (path) => {
    await expect(tools().writeFile.invoke({ path, content: "x" })).rejects.toThrow(
      /outside the workspace sandbox/
    );
  });

  it.each(escapes)("refuses to read %s", async (path) => {
    await expect(tools().readFile.invoke({ path })).rejects.toThrow(/outside the workspace sandbox/);
  });

  it.each(escapes)("refuses to delete %s", async (path) => {
    await expect(tools().deleteFile.invoke({ path })).rejects.toThrow(/outside the workspace sandbox/);
  });

  it.each(escapes)("refuses to create a directory at %s", async (path) => {
    await expect(tools().createDirectory.invoke({ path })).rejects.toThrow(
      /outside the workspace sandbox/
    );
  });

  it.each(escapes)("refuses %s in the workspace folder too", async (path) => {
    // Both roots are the same boundary. The session folder is not a back door into the
    // workspace's parent, and the workspace folder is not one into the data root.
    await expect(
      tools().writeFile.invoke({ path, content: "x", location: "workspace" })
    ).rejects.toThrow(/outside the workspace sandbox/);
  });

  it("cannot reach the conversation folder from a workspace-relative path", async () => {
    // The two roots are siblings, so this is the escape that a one-root implementation would
    // have missed: `sessions/<id>/` is one `..` away from `workdir/`.
    await expect(
      tools().writeFile.invoke({
        path: "../sessions/s1/leak.txt",
        content: "x",
        location: "workspace",
      })
    ).rejects.toThrow(/outside the workspace sandbox/);
    expect(existsSync(join(h.sessionDir, "leak.txt"))).toBe(false);
  });

  it("cannot reach the workspace folder from a session-relative path", async () => {
    await expect(
      tools().writeFile.invoke({ path: "../workdir/leak.txt", content: "x", location: "session" })
    ).rejects.toThrow(/outside the workspace sandbox/);
    expect(existsSync(join(h.workdir, "leak.txt"))).toBe(false);
  });

  it("still allows a path that dips out and back in", async () => {
    await expect(tools().writeFile.invoke({ path: "a/../b.txt", content: "x" })).resolves.toContain(
      "b.txt"
    );
  });
});
