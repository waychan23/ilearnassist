import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Attachment } from "@ilearnassist/shared";
import { MAX_INLINE_CHARS, sha256Of, buildUserContent } from "../src/attachments.js";
import { normalizeMime, sourceRawPath } from "../src/sourcePaths.js";
import { writeParsedText } from "../src/documents/store.js";
import { dataLayout, userLayout, type UserLayout } from "../src/paths.js";

/**
 * How an attachment becomes model content: what is inlined, what is named, and what an
 * unparsed or missing file reads as.
 *
 * The path helpers moved out from under this file when a source stopped being only an upload.
 * Where a source's bytes are — and the containment check every read goes through — is
 * `sourcePaths.ts` now, tested in `test/source-paths.test.ts`. What is left here is the half
 * that is about *content*.
 */

let root: string;
let user: UserLayout;

function att(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: "att-1",
    name: "file.txt",
    mimeType: "text/plain",
    size: 3,
    kind: "file",
    ...overrides,
  };
}

/** Put bytes where `sourceRawPath` would look for them. */
function store(attachment: Attachment, body = "hi"): void {
  mkdirSync(user.rawDir, { recursive: true });
  writeFileSync(sourceRawPath(user, attachment.id, attachment.mimeType), body);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "gl-att-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  user = userLayout(dataLayout(root), "tester");
});

describe("sha256Of", () => {
  it("is stable and content-addressed", () => {
    expect(sha256Of(Buffer.from("hello"))).toBe(sha256Of(Buffer.from("hello")));
    expect(sha256Of(Buffer.from("hello"))).not.toBe(sha256Of(Buffer.from("hello!")));
  });

  it("gives the digest everyone else does", () => {
    // A known vector, so a future change to the algorithm or the encoding is caught here
    // rather than by sources silently failing to dedupe against rows written last week.
    expect(sha256Of(Buffer.from(""))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });
});

describe("buildUserContent", () => {
  const opts = (vision: boolean) => ({ user, vision });

  it("returns a plain string when there is nothing attached", async () => {
    // Keeps the common path byte-identical to a non-multimodal turn.
    await expect(buildUserContent("hi", undefined, opts(true))).resolves.toBe("hi");
    await expect(buildUserContent("hi", [], opts(true))).resolves.toBe("hi");
  });

  it("inlines a text file behind a filename header", async () => {
    const attachment = att({ mimeType: "text/markdown", name: "notes.md" });
    store(attachment, "# Title");

    const blocks = (await buildUserContent("look", [attachment], opts(false))) as {
      type: string;
      text: string;
    }[];
    expect(blocks).toHaveLength(2);
    expect(blocks[1]!.text).toContain("--- 附件：notes.md ---");
    expect(blocks[1]!.text).toContain("# Title");
    expect(blocks[1]!.text).toContain("--- 附件结束 ---");
  });

  it("truncates a long text file and says so", async () => {
    const attachment = att({ mimeType: "text/plain", name: "big.txt" });
    store(attachment, "x".repeat(25_000));

    const blocks = (await buildUserContent("", [attachment], opts(false))) as { text: string }[];
    expect(blocks[0]!.text).toContain(`已在 ${MAX_INLINE_CHARS} 字符处截断`);
    expect(blocks[0]!.text.length).toBeLessThan(MAX_INLINE_CHARS + 1_000);
  });

  it("sends an image as a data URL when the model can see it", async () => {
    const attachment = att({ id: "img-1", mimeType: "image/png", name: "shot.png", kind: "image" });
    store(attachment, "fake-png");

    const blocks = (await buildUserContent("look at this", [attachment], opts(true))) as {
      type: string;
      image_url?: { url: string };
    }[];
    expect(blocks[1]!.type).toBe("image_url");
    expect(blocks[1]!.image_url!.url).toBe(
      `data:image/png;base64,${Buffer.from("fake-png").toString("base64")}`
    );
  });

  it("degrades an image to a placeholder when the model cannot see it", async () => {
    const attachment = att({ id: "img-1", mimeType: "image/png", name: "shot.png", kind: "image" });
    store(attachment);

    const blocks = (await buildUserContent("", [attachment], opts(false))) as {
      type: string;
      text: string;
    }[];
    expect(blocks[0]!.text).toContain("当前模型不支持图片输入");
  });

  it("reports an unreadable image instead of dropping it silently", async () => {
    // A well-formed attachment whose bytes are gone: the path derives fine, so the read is
    // attempted and fails.
    const attachment = att({ id: "gone", mimeType: "image/png", kind: "image" });
    const blocks = (await buildUserContent("", [attachment], opts(true))) as { text: string }[];
    expect(blocks[0]!.text).toContain("读取失败");
  });

  it("distinguishes 'no path' from 'unreadable' for a vision model", async () => {
    // An id that could never address a file never reaches the read at all, and gets the
    // "missing" wording rather than "read failed".
    const attachment = att({ id: "../evil", mimeType: "image/png", kind: "image" });
    const blocks = (await buildUserContent("", [attachment], opts(true))) as { text: string }[];
    expect(blocks[0]!.text).toContain("文件缺失");
  });

  it("names a binary file instead of parsing it", async () => {
    const attachment = att({ mimeType: "application/pdf", name: "doc.pdf" });
    store(attachment, "%PDF-1.4");

    const blocks = (await buildUserContent("", [attachment], opts(false))) as { text: string }[];
    expect(blocks[0]!.text).toBe("[附件：doc.pdf（application/pdf，未解析内容）]");
  });

  it("reports an unreadable text file", async () => {
    const attachment = att({ mimeType: "text/plain", name: "missing.txt" });
    const blocks = (await buildUserContent("", [attachment], opts(false))) as { text: string }[];
    expect(blocks[0]!.text).toContain("读取失败");
  });

  it("omits the leading text block when the message has no text", async () => {
    const attachment = att({ mimeType: "text/plain", name: "a.txt" });
    store(attachment, "body");
    const blocks = (await buildUserContent("   ", [attachment], opts(false))) as unknown[];
    expect(blocks).toHaveLength(1);
  });
});

/**
 * How a parsed document reaches the prompt.
 *
 * The parse state read here comes off the *attachment* — a snapshot taken from the source's
 * row when the message was written — so a document that was still parsing when the message
 * was sent keeps reading that way in history. That is deliberate: a message describes the
 * turn that was had, not the state of the world now. The current state is what the chip and
 * `/sources` are for.
 */
describe("buildUserContent, for documents", () => {
  const opts = (toolUse: boolean) => ({ user, vision: false, toolUse });

  const pdf = (overrides: Partial<Attachment> = {}) =>
    att({ mimeType: "application/pdf", name: "paper.pdf", ...overrides });

  it("inlines the whole text when it is short enough", async () => {
    const attachment = pdf();
    await writeParsedText(user, "att-1", "the whole paper");

    const blocks = (await buildUserContent("", [attachment], opts(true))) as { text: string }[];
    expect(blocks[0]!.text).toContain("the whole paper");
    expect(blocks[0]!.text).not.toContain("read_document");
  });

  it("gives a preview and points at the tool when it is long", async () => {
    // Inlining a whole book would put it in the context window once per turn for the rest of
    // the conversation — exactly the case `read_document` exists to avoid.
    const attachment = pdf();
    await writeParsedText(user, "att-1", "x".repeat(MAX_INLINE_CHARS + 500));

    const blocks = (await buildUserContent("", [attachment], opts(true))) as { text: string }[];
    expect(blocks[0]!.text).toContain("read_document");
    expect(blocks[0]!.text).toContain(`"att-1"`);
    expect(blocks[0]!.text.length).toBeLessThan(MAX_INLINE_CHARS);
  });

  it("does not point at a tool the model cannot call", async () => {
    // Telling a model without tool use to call something leaves it believing the rest is
    // retrievable when it is not.
    const attachment = pdf();
    await writeParsedText(user, "att-1", "x".repeat(MAX_INLINE_CHARS + 500));

    const blocks = (await buildUserContent("", [attachment], opts(false))) as { text: string }[];
    expect(blocks[0]!.text).toContain("剩余部分已省略");
    expect(blocks[0]!.text).not.toContain("read_document");
  });

  it("says a failed parse failed, naming the reason", async () => {
    const attachment = pdf({ parseStatus: "failed", parseError: "密码错误" });
    const blocks = (await buildUserContent("", [attachment], opts(true))) as { text: string }[];
    expect(blocks[0]!.text).toContain("解析失败");
    expect(blocks[0]!.text).toContain("密码错误");
  });

  it("says a document is still being parsed rather than pretending it is empty", async () => {
    // The distinction matters: a model told a file it never saw is empty will answer about it
    // anyway.
    for (const status of ["pending", "parsing"] as const) {
      const attachment = pdf({ parseStatus: status });
      const blocks = (await buildUserContent("", [attachment], opts(true))) as { text: string }[];
      expect(blocks[0]!.text).toContain("正在解析");
    }
  });

  it("names a document that was never parsed at all", async () => {
    const attachment = pdf({ parseStatus: "none" });
    const blocks = (await buildUserContent("", [attachment], opts(true))) as { text: string }[];
    expect(blocks[0]!.text).toContain("未解析内容");
  });
});
