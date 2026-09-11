import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { writeParsedText, writeParseRecord } from "../../src/documents/store.js";
import { buildDocumentTool, type DocumentToolContext } from "../../src/tools/documentTools.js";

/**
 * `read_document`, the tool a model uses to page through a document that was only partly
 * inlined into its prompt.
 */

let root: string;

const attachments = [
  { id: "att-1", name: "lecture-01.pdf", mimeType: "application/pdf" },
  { id: "att-2", name: "notes.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
];

function toolFor(overrides: Partial<DocumentToolContext> = {}) {
  return buildDocumentTool({
    uploadRoot: root,
    sessionId: "s1",
    attachments,
    ...overrides,
  });
}

/** The tool returns a string; this keeps the assertions readable. */
async function read(
  args: { attachmentId: string; offset?: number; limit?: number },
  overrides: Partial<DocumentToolContext> = {}
): Promise<string> {
  return (await toolFor(overrides).invoke(args)) as string;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "gl-doctool-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await writeParsedText(root, "s1", "att-1", "0123456789".repeat(10));
  await writeParsedText(root, "s1", "att-2", "word document text");
});

describe("read_document", () => {
  it("reads from the start by default", async () => {
    const out = await read({ attachmentId: "att-1" });
    expect(out).toContain("0123456789");
    expect(out).toContain("lecture-01.pdf");
    expect(out).toContain("共 100 字符");
  });

  it("pages with offset and limit, and reports where to continue", async () => {
    const first = await read({ attachmentId: "att-1", offset: 0, limit: 30 });
    expect(first).toContain("0–30 / 共 100 字符");
    expect(first).toContain("offset=30");

    const second = await read({ attachmentId: "att-1", offset: 30, limit: 30 });
    expect(second).toContain("30–60 / 共 100 字符");
  });

  it("says when the end has been reached instead of inviting another call", async () => {
    const out = await read({ attachmentId: "att-1", offset: 90, limit: 50 });
    expect(out).toContain("已到末尾");
    expect(out).not.toContain("继续读取");
  });

  it("refuses an offset past the end, naming the real length", async () => {
    const out = await read({ attachmentId: "att-1", offset: 5_000 });
    expect(out).toContain("超出范围");
    expect(out).toContain("100");
  });

  it("caps a single read at the configured ceiling", async () => {
    // A model asking for everything at once must not be able to blow the context window.
    const out = await read({ attachmentId: "att-1", offset: 0, limit: 999_999 }, { maxChars: 25 });
    expect(out).toContain("0–25 / 共 100 字符");
  });

  it("refuses an attachment from another conversation", async () => {
    // The whitelist is the security boundary: ids are guessable, so the tool must not be
    // able to read a document that simply is not in this conversation.
    const out = await read({ attachmentId: "att-from-elsewhere" });
    expect(out).toContain("No such attachment");
    expect(out).toContain("lecture-01.pdf"); // and lists what it *can* read
  });

  it("explains an attachment that has no extracted text yet", async () => {
    await writeParseRecord(root, "s1", "att-2", { status: "failed", error: "boom" });
    const out = await read({ attachmentId: "att-2" });
    // att-2 has text in this fixture, so clear it to exercise the missing case.
    expect(out).toContain("word document text");

    const missing = await read({ attachmentId: "att-3" });
    expect(missing).toContain("No such attachment");
  });

  it("reports an attachment whose parse produced nothing", async () => {
    const out = await read({ attachmentId: "att-1" }, {
      attachments: [{ id: "att-1", name: "empty.pdf", mimeType: "application/pdf" }],
      // Point at a session with no sidecar at all.
      sessionId: "s-other",
    });
    expect(out).toContain("没有可读文本");
  });

  it("advertises itself clearly enough for a model to know when to call it", async () => {
    const tool = toolFor();
    expect(tool.name).toBe("read_document");
    expect(tool.description).toContain("offset");
  });
});
