import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { writeParsedText } from "../../src/documents/store.js";
import { createDb, type AppDb } from "../../src/db.js";
import { classifySource } from "../../src/sourceCategory.js";
import { dataLayout, userLayout, type UserLayout } from "../../src/paths.js";
import { sourceRawPath } from "../../src/sourcePaths.js";
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
let db: AppDb;

/**
 * The account whose sources these are.
 *
 * A real database rather than a stub, and it is here for exactly one behaviour: a source that
 * was never going to have extracted text — a Markdown file, a `.txt` — is read from its bytes
 * instead. That needs a row to resolve the bytes from, and the whitelist membership question
 * this file deliberately does not test is still answered elsewhere.
 */
const OWNER = "u1";

const sources = [
  { id: "att-1", name: "lecture-01.pdf", mimeType: "application/pdf" },
  {
    id: "att-2",
    name: "notes.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
];

function toolFor(overrides: Partial<DocumentToolContext> = {}) {
  return buildDocumentTool({ db, userId: OWNER, user, sources, ...overrides });
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
  db = createDb(join(root, "test.sqlite"));
  db.createUser({ id: OWNER, username: "tester", slug: "tester" });
});

afterAll(() => {
  db.raw.close();
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

  /*
   * The half that was a dead end until now.
   *
   * `document` and `image` are the only categories ever extracted, so a Markdown or text file
   * has never had anything in `parsed/` — which meant the tool could be handed a `.md` by name
   * and could not read a byte of it. That was survivable while the model was only given ids it
   * had just been shown; it stops being survivable once an `@工作区` grant makes uploads
   * elsewhere addressable, because "here is an id" with nothing behind it is a broken tool.
   */
  describe("a source that was never going to be parsed", () => {
    function seedUpload(id: string, name: string, mimeType: string, body: string): void {
      const row = db.createSource({
        id,
        userId: OWNER,
        ownerKind: "session",
        ownerId: "s1",
        origin: "session_attachment",
        storage: "upload",
        relPath: null,
        name,
        mimeType,
        // Derived, never written by hand: the whole point of these two cases is the *category*
        // deciding whether bytes are a fallback — `needsParse` — and a hardcoded one here would
        // let the test assert the opposite of what the app does.
        category: classifySource(name, mimeType).category,
        size: Buffer.byteLength(body, "utf8"),
        url: null,
        summary: null,
        sha256: null,
      });
      const bytes = sourceRawPath(user, row.id, row.mimeType);
      mkdirSync(dirname(bytes), { recursive: true });
      writeFileSync(bytes, body);
    }

    it("reads a Markdown source's bytes, because there is no extracted text to read", async () => {
      seedUpload("att-md", "notes.md", "text/markdown", "# 递归\n\n自己调用自己。");
      const out = await read(
        { sourceId: "att-md" },
        { sources: [{ id: "att-md", name: "notes.md", mimeType: "text/markdown" }] }
      );
      expect(out).toContain("自己调用自己");
      expect(out).not.toContain("没有可读文本");
    });

    it("still reports nothing readable for a document with no extracted text", async () => {
      // The fallback is for the categories a parse was never going to produce anything for.
      // A PDF that failed to extract must not have its raw bytes decoded and handed over as
      // though they were its text.
      seedUpload("att-pdf", "scan.pdf", "application/pdf", "%PDF-1.4 binary");
      db.updateSourceParse("att-pdf", OWNER, { status: "failed" });
      const out = await read(
        { sourceId: "att-pdf" },
        { sources: [{ id: "att-pdf", name: "scan.pdf", mimeType: "application/pdf" }] }
      );
      expect(out).toContain("没有可读文本");
    });

    it("keeps the miss path's catalogue short when the whitelist is the whole account", async () => {
      // The catalogue is built only when a lookup fails, and it is capped: with an
      // `@所有工作区` grant the whitelist is every source the account has ever linked, and a
      // per-turn string proportional to that is not affordable.
      const many = Array.from({ length: 1_000 }, (_, i) => ({
        id: `many-${i}`,
        name: `file-${i}.md`,
        mimeType: "text/markdown",
      }));
      const out = await read({ sourceId: "nope" }, { sources: many });
      expect(out).toContain("… 950 more");
      expect(out).not.toContain("file-999.md");
    });
  });
});
