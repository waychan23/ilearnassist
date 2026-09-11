import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  listParseRecords,
  readParseRecord,
  readParsedText,
  readParsedTextHead,
  removeParsed,
  writeParseRecord,
  writeParsedText,
} from "../../src/documents/store.js";
import { findStoredAttachment } from "../../src/attachments.js";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "gl-store-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  // Each test starts from an empty uploads root.
  rmSync(root, { recursive: true, force: true });
});

describe("parse sidecar", () => {
  it("round-trips text and a record", async () => {
    await writeParsedText(root, "s1", "att-1", "extracted body");
    await writeParseRecord(root, "s1", "att-1", {
      status: "ready",
      parserId: "local",
      parsedChars: 14,
      pageCount: 2,
    });

    expect(await readParsedText(root, "s1", "att-1")).toBe("extracted body");
    const record = await readParseRecord(root, "s1", "att-1");
    expect(record?.status).toBe("ready");
    expect(record?.pageCount).toBe(2);
    expect(record?.updatedAt).toBeTruthy();
  });

  it("returns undefined rather than throwing for anything missing", async () => {
    expect(await readParsedText(root, "nope", "nope")).toBeUndefined();
    expect(await readParseRecord(root, "nope", "nope")).toBeUndefined();
    expect(await readParsedTextHead(root, "nope", "nope", 100)).toBeUndefined();
    expect(await listParseRecords(root, "nope")).toEqual(new Map());
  });

  it("refuses ids that are not shaped like the ones we issue", async () => {
    // Same guard as the uploaded bytes: an id from a URL must never reach the filesystem.
    for (const bad of ["../escape", "a/b", "..", "", "with space"]) {
      expect(await readParsedText(root, "s1", bad)).toBeUndefined();
      expect(await writeParsedText(root, "s1", bad, "x").catch(() => "refused")).toBe("refused");
    }
    expect(await readParsedText(root, "../escape", "att")).toBeUndefined();
  });

  it("reads only the head of a long document", async () => {
    await writeParsedText(root, "s1", "long", "y".repeat(5_000));

    expect(await readParsedTextHead(root, "s1", "long", 100)).toHaveLength(100);
    expect(await readParsedTextHead(root, "s1", "long", 5_000)).toHaveLength(5_000);
    // One past the end is what tells the caller there is no more to fetch.
    expect(await readParsedTextHead(root, "s1", "long", 5_001)).toHaveLength(5_000);
  });

  it("does not split a multi-byte character at the byte boundary", async () => {
    // A naive byte-slice would cut a UTF-8 sequence in half and produce a replacement char.
    await writeParsedText(root, "s1", "cjk", "文档内容测试".repeat(50));
    const head = await readParsedTextHead(root, "s1", "cjk", 10);
    expect(head).toBe("文档内容测试文档内容");
    expect(head).not.toContain("�");
  });

  it("lists every record in a session", async () => {
    await writeParseRecord(root, "s1", "a", { status: "ready" });
    await writeParseRecord(root, "s1", "b", { status: "failed", error: "boom" });
    await writeParseRecord(root, "s2", "c", { status: "ready" });

    const records = await listParseRecords(root, "s1");
    expect([...records.keys()].sort()).toEqual(["a", "b"]);
    expect(records.get("b")?.error).toBe("boom");
  });

  it("clears derived data so a re-parse starts from nothing", async () => {
    await writeParsedText(root, "s1", "att-1", "old text");
    await writeParseRecord(root, "s1", "att-1", { status: "ready" });

    await removeParsed(root, "s1", "att-1");
    expect(await readParsedText(root, "s1", "att-1")).toBeUndefined();
    expect(await readParseRecord(root, "s1", "att-1")).toBeUndefined();
  });
});

describe("sidecar placement", () => {
  it("never shadows the uploaded bytes", async () => {
    // The hazard this guards: `findStoredAttachment` globs `<id>.*` in the session
    // directory, and `txt` is a valid extension in the MIME table. A flat `<id>.txt`
    // sibling would let the download endpoint serve extracted text instead of the PDF.
    const sessionDir = join(root, "s1");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "att-1.pdf"), Buffer.from("%PDF-1.4 fake"));
    await writeParsedText(root, "s1", "att-1", "extracted text that must not be served");

    const found = await findStoredAttachment(root, "s1", "att-1");
    expect(found).toBeDefined();
    expect(found!.mimeType).toBe("application/pdf");
    expect(found!.path.endsWith("att-1.pdf")).toBe(true);
  });
});
