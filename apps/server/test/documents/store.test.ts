import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  readParsedText,
  readParsedTextHead,
  removeParsedText,
  parsedTextPath,
  writeParsedText,
} from "../../src/documents/store.js";
import { rawFilePath } from "../../src/resourcePaths.js";
import { dataLayout, userLayout, type UserLayout } from "../../src/paths.js";

/**
 * Extracted text on disk, and where it sits relative to the bytes it came from.
 *
 * This module is only about the text now — parse *state* lives in the `sources` row, so
 * there is no sidecar to round-trip and nothing to keep in step with a database column.
 */

let root: string;
let user: UserLayout;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "gl-store-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  user = userLayout(dataLayout(root), "tester");
});

describe("extracted text", () => {
  it("round-trips", async () => {
    await writeParsedText(user, "att-1", "extracted body");
    expect(await readParsedText(user, "att-1")).toBe("extracted body");
  });

  it("returns undefined rather than throwing for anything missing", async () => {
    expect(await readParsedText(user, "nope")).toBeUndefined();
    expect(await readParsedTextHead(user, "nope", 100)).toBeUndefined();
  });

  it("refuses ids that are not shaped like the ones we issue", async () => {
    // Same guard as the uploaded bytes: an id from a URL must never reach the filesystem.
    for (const bad of ["../escape", "a/b", "..", "", "with space"]) {
      expect(await readParsedText(user, bad)).toBeUndefined();
      expect(await writeParsedText(user, bad, "x").catch(() => "refused")).toBe("refused");
    }
  });

  it("reads only the head of a long document", async () => {
    await writeParsedText(user, "long", "y".repeat(5_000));

    expect(await readParsedTextHead(user, "long", 100)).toHaveLength(100);
    expect(await readParsedTextHead(user, "long", 5_000)).toHaveLength(5_000);
    // One past the end is what tells the caller there is no more to fetch.
    expect(await readParsedTextHead(user, "long", 5_001)).toHaveLength(5_000);
  });

  it("does not split a multi-byte character at the byte boundary", async () => {
    // A naive byte-slice would cut a UTF-8 sequence in half and produce a replacement char.
    await writeParsedText(user, "cjk", "文档内容测试".repeat(50));
    const head = await readParsedTextHead(user, "cjk", 10);
    expect(head).toBe("文档内容测试文档内容");
    expect(head).not.toContain("�");
  });

  it("clears the text so a re-parse starts from nothing", async () => {
    await writeParsedText(user, "att-1", "old text");
    await removeParsedText(user, "att-1");
    expect(await readParsedText(user, "att-1")).toBeUndefined();
  });

  it("swallows a removal for something that was never there", async () => {
    await expect(removeParsedText(user, "never-existed")).resolves.toBeUndefined();
  });
});

describe("where the two kinds of file sit", () => {
  it("keeps raw bytes and extracted text in separate directories", async () => {
    // Not load-bearing any more — nothing globs for a file by id, because the path is a
    // column — but the split is still the contract: a reader should never have to check
    // which of the two it is holding. The hazard that made this mandatory is pinned below.
    const raw = rawFilePath(user, "att-1", "application/pdf");
    const parsed = parsedTextPath(user, "att-1")!;

    expect(raw).toBe(join(user.rawDir, "att-1.pdf"));
    expect(parsed).toBe(join(user.parsedDir, "att-1.txt"));
    expect(raw.startsWith(user.parsedDir)).toBe(false);
    expect(parsed.startsWith(user.rawDir)).toBe(false);
  });

  it("no longer has a collision to avoid, because nothing lists the directory", async () => {
    // The hazard this used to guard, kept as an executable record of why it is safe now:
    // `findStoredAttachment` globbed `<id>.*` in the session directory, and `txt` is a valid
    // extension in the MIME table — so a flat `<id>.txt` could be served in place of the
    // PDF. The path comes from the row now, so the download route reads the bytes it was
    // told to read and the question does not arise.
    mkdirSync(user.rawDir, { recursive: true });
    writeFileSync(rawFilePath(user, "att-1", "application/pdf"), Buffer.from("%PDF-1.4"));
    await writeParsedText(user, "att-1", "extracted text that must not be served");

    const raw = rawFilePath(user, "att-1", "application/pdf");
    expect(raw).toBeTruthy();
    expect(raw!.endsWith("att-1.pdf")).toBe(true);
  });
});

