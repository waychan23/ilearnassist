import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { writeParsedText } from "../../src/documents/store.js";
import { dataLayout, userLayout, type UserLayout } from "../../src/paths.js";
import { buildDocumentTool, type DocumentToolContext } from "../../src/tools/documentTools.js";

/**
 * `read_document`, the tool a model uses to page through a document that was only partly
 * inlined into its prompt.
 *
 * What this file tests is the tool's own boundary: **the whitelist it was handed**. Which
 * sources end up in that list is a question about the database — a conversation's own
 * sources unioned with its workspace's — and it is answered in `db.test.ts` and
 * `ownership.test.ts`. Keeping them apart matters, because "the tool refuses what it was not
 * given" and "the right things were given" are different claims and only one of them is
 * testable here.
 */

let root: string;
let user: UserLayout;

const sources = [
  { id: "att-1", name: "lecture-01.pdf", mimeType: "application/pdf" },
  {
    id: "att-2",
    name: "notes.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
];

function toolFor(overrides: Partial<DocumentToolContext> = {}) {
  return buildDocumentTool({ user, sources, ...overrides });
}

/** The tool returns a string; this keeps the assertions readable. */
async function read(
  args: { sourceId: string; offset?: number; limit?: number },
  overrides: Partial<DocumentToolContext> = {}
): Promise<string> {
  return (await toolFor(overrides).invoke(args)) as string;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "gl-doctool-"));
  user = userLayout(dataLayout(root), "tester");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await writeParsedText(user, "att-1", "0123456789".repeat(10));
  await writeParsedText(user, "att-2", "word document text");
});

describe("read_document", () => {
  it("reads from the start by default", async () => {
    const out = await read({ sourceId: "att-1" });
    expect(out).toContain("0123456789");
    expect(out).toContain("lecture-01.pdf");
    expect(out).toContain("共 100 字符");
  });

  it("pages with offset and limit, and reports where to continue", async () => {
    const first = await read({ sourceId: "att-1", offset: 0, limit: 30 });
    expect(first).toContain("0–30 / 共 100 字符");
    expect(first).toContain("offset=30");

    const second = await read({ sourceId: "att-1", offset: 30, limit: 30 });
    expect(second).toContain("30–60 / 共 100 字符");
  });

  it("says when the end has been reached instead of inviting another call", async () => {
    const out = await read({ sourceId: "att-1", offset: 90, limit: 50 });
    expect(out).toContain("已到末尾");
    expect(out).not.toContain("继续读取");
  });

  it("refuses an offset past the end, naming the real length", async () => {
    const out = await read({ sourceId: "att-1", offset: 5_000 });
    expect(out).toContain("超出范围");
    expect(out).toContain("100");
  });

  it("caps a single read at the configured ceiling", async () => {
    // A model asking for everything at once must not be able to blow the context window.
    const out = await read({ sourceId: "att-1", offset: 0, limit: 999_999 }, { maxChars: 25 });
    expect(out).toContain("0–25 / 共 100 字符");
  });

  it("refuses a source that is not in its whitelist", async () => {
    // The whitelist is the security boundary: ids are guessable, so a document the caller
    // was not handed must fail the lookup before any path is touched.
    const out = await read({ sourceId: "att-from-elsewhere" });
    expect(out).toContain("No such document");
    expect(out).toContain("lecture-01.pdf"); // and lists what it *can* read
  });

  it("lists nothing available when the whitelist is empty", async () => {
    const out = await read({ sourceId: "anything" }, { sources: [] });
    expect(out).toContain("(none)");
  });

  it("reports a source whose parse produced no text", async () => {
    // A whitelisted source with no extracted text: extraction is still running, or it
    // failed. Either way the model must be told it read nothing, not handed an empty string
    // it will answer about anyway.
    const out = await read(
      { sourceId: "att-9" },
      { sources: [{ id: "att-9", name: "empty.pdf", mimeType: "application/pdf" }] }
    );
    expect(out).toContain("没有可读文本");
  });

  it("advertises itself clearly enough for a model to know when to call it", async () => {
    const tool = toolFor();
    expect(tool.name).toBe("read_document");
    expect(tool.description).toContain("offset");
    // The scope it will accept is stated, so the model does not have to discover it by
    // having a call refused.
    expect(tool.description).toContain("workspace");
  });
});
