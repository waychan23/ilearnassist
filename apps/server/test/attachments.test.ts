import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Attachment } from "@guided-learning/shared";
import {
  attachmentPath,
  buildUserContent,
  ensureSessionUploadDir,
  findStoredAttachment,
  isSupportedMime,
  isTextLike,
  kindFor,
  normalizeMime,
  removeSessionUploads,
  resolveStoredPath,
} from "../src/attachments.js";

/**
 * Uploads live outside the workspace on purpose, and `resolveStoredPath` is what keeps a
 * client-supplied id from steering a read or write anywhere else — so the guard cases
 * below carry most of this file's weight.
 */

let uploadRoot: string;
const SESSION = "sess-1";

const att = (overrides: Partial<Attachment> = {}): Attachment => ({
  id: "att-1",
  name: "file.txt",
  mimeType: "text/plain",
  size: 5,
  kind: "file",
  ...overrides,
});

/** Write bytes where the upload route would have put them. */
function store(attachment: Attachment, contents = "hello"): string {
  const dir = join(uploadRoot, SESSION);
  mkdirSync(dir, { recursive: true });
  const path = attachmentPath(uploadRoot, SESSION, attachment);
  writeFileSync(path, contents);
  return path;
}

beforeEach(() => {
  uploadRoot = mkdtempSync(join(tmpdir(), "gl-att-"));
});

afterEach(() => {
  rmSync(uploadRoot, { recursive: true, force: true });
});

describe("normalizeMime", () => {
  it("trusts a browser MIME type we support", () => {
    expect(normalizeMime("a.png", "image/png")).toBe("image/png");
  });

  it("falls back to the extension when the browser sends an unsupported type", () => {
    expect(normalizeMime("notes.md", "application/octet-stream")).toBe("text/markdown");
  });

  it("falls back to the extension when the browser sends nothing", () => {
    expect(normalizeMime("data.json", undefined)).toBe("application/json");
  });

  it("is case-insensitive about the extension", () => {
    expect(normalizeMime("PHOTO.PNG", undefined)).toBe("image/png");
  });

  it("returns undefined for a file we cannot place", () => {
    expect(normalizeMime("archive.zip", "application/zip")).toBeUndefined();
    expect(normalizeMime("noext", undefined)).toBeUndefined();
  });
});

describe("mime classification", () => {
  it("accepts only MIME types it has an extension for", () => {
    expect(isSupportedMime("image/png")).toBe(true);
    expect(isSupportedMime("application/zip")).toBe(false);
    expect(isSupportedMime(undefined)).toBe(false);
  });

  it("calls anything image/* an image", () => {
    expect(kindFor("image/webp")).toBe("image");
    expect(kindFor("text/plain")).toBe("file");
  });

  it("inlines text-like types and nothing else", () => {
    for (const mime of ["text/plain", "application/json", "application/xml", "application/typescript"]) {
      expect(isTextLike(mime)).toBe(true);
    }
    expect(isTextLike("image/png")).toBe(false);
    expect(isTextLike("application/pdf")).toBe(false);
  });
});

describe("attachmentPath", () => {
  it("derives the filename from the id and MIME type", () => {
    expect(attachmentPath(uploadRoot, SESSION, att())).toBe(join(uploadRoot, SESSION, "att-1.txt"));
  });

  it.each(["../evil", "a/b", "a\\b", "", "a b"])("rejects the unsafe id %s", (id) => {
    expect(() => attachmentPath(uploadRoot, SESSION, att({ id }))).toThrow(/Invalid attachment id/);
  });

  it("rejects an unsafe session id", () => {
    expect(() => attachmentPath(uploadRoot, "../..", att())).toThrow(/Invalid attachment id/);
  });

  it("rejects a MIME type it has no extension for", () => {
    expect(() => attachmentPath(uploadRoot, SESSION, att({ mimeType: "application/zip" }))).toThrow(
      /Unsupported attachment type/
    );
  });
});

describe("resolveStoredPath", () => {
  it("resolves a well-formed attachment", () => {
    expect(resolveStoredPath(uploadRoot, SESSION, att())).toBe(join(uploadRoot, SESSION, "att-1.txt"));
  });

  it.each<[string, string, Partial<Attachment>]>([
    ["traversal in the id", SESSION, { id: "../escape" }],
    ["traversal in the session", "../../escape", {}],
    ["an unsupported MIME type", SESSION, { mimeType: "application/zip" }],
  ])("returns undefined for %s", (_label, sessionId, override) => {
    expect(resolveStoredPath(uploadRoot, sessionId, att(override))).toBeUndefined();
  });
});

describe("ensureSessionUploadDir", () => {
  it("creates the session directory", async () => {
    const dir = await ensureSessionUploadDir(uploadRoot, SESSION);
    expect(dir).toBe(join(uploadRoot, SESSION));
    expect(existsSync(dir)).toBe(true);
  });

  it("refuses an unsafe session id", async () => {
    await expect(ensureSessionUploadDir(uploadRoot, "../evil")).rejects.toThrow(/Invalid session id/);
  });
});

describe("findStoredAttachment", () => {
  it("locates the file and derives the MIME type from disk", async () => {
    const path = store(att({ id: "att-9", name: "shot.png", mimeType: "image/png", kind: "image" }), "png-bytes");
    await expect(findStoredAttachment(uploadRoot, SESSION, "att-9")).resolves.toEqual({
      path,
      mimeType: "image/png",
    });
  });

  it("does not trust a caller-supplied MIME type — the directory listing is the authority", async () => {
    store(att({ id: "att-9", mimeType: "image/png", kind: "image" }), "x");
    // Asking for it as text/plain still resolves to the .png on disk.
    await expect(findStoredAttachment(uploadRoot, SESSION, "att-9")).resolves.toMatchObject({
      mimeType: "image/png",
    });
  });

  it("returns undefined for an unknown id", async () => {
    store(att());
    await expect(findStoredAttachment(uploadRoot, SESSION, "nope")).resolves.toBeUndefined();
  });

  it("returns undefined when the session directory does not exist", async () => {
    await expect(findStoredAttachment(uploadRoot, "missing", "att-1")).resolves.toBeUndefined();
  });

  it("returns undefined for a file whose extension we do not know", async () => {
    const dir = join(uploadRoot, SESSION);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "att-1.exe"), "x");
    await expect(findStoredAttachment(uploadRoot, SESSION, "att-1")).resolves.toBeUndefined();
  });

  it("rejects unsafe ids before touching the filesystem", async () => {
    await expect(findStoredAttachment(uploadRoot, "../evil", "att-1")).resolves.toBeUndefined();
    await expect(findStoredAttachment(uploadRoot, SESSION, "../evil")).resolves.toBeUndefined();
  });
});

describe("removeSessionUploads", () => {
  it("removes the session's directory", async () => {
    store(att());
    await removeSessionUploads(uploadRoot, SESSION);
    expect(existsSync(join(uploadRoot, SESSION))).toBe(false);
  });

  it("is a no-op for a missing directory", async () => {
    await expect(removeSessionUploads(uploadRoot, "missing")).resolves.toBeUndefined();
  });

  it("ignores an unsafe session id", async () => {
    await expect(removeSessionUploads(uploadRoot, "../evil")).resolves.toBeUndefined();
  });
});

describe("buildUserContent", () => {
  const opts = (vision: boolean) => ({ uploadRoot, sessionId: SESSION, vision });

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
    expect(blocks[0]!.text).toContain("已在 20000 字符处截断");
    expect(blocks[0]!.text.length).toBeLessThan(21_000);
  });

  it("sends an image as a data URL when the model can see it", async () => {
    const attachment = att({ id: "img-1", mimeType: "image/png", name: "shot.png", kind: "image" });
    store(attachment, "fake-png");

    const blocks = (await buildUserContent("look at this", [attachment], opts(true))) as {
      type: string;
      image_url?: { url: string };
    }[];
    expect(blocks[1]!.type).toBe("image_url");
    expect(blocks[1]!.image_url!.url).toBe(`data:image/png;base64,${Buffer.from("fake-png").toString("base64")}`);
  });

  it("degrades an image to a placeholder when the model cannot see it", async () => {
    const attachment = att({ id: "img-1", mimeType: "image/png", name: "shot.png", kind: "image" });
    store(attachment);

    const blocks = (await buildUserContent("", [attachment], opts(false))) as { type: string; text: string }[];
    expect(blocks[0]!.text).toContain("当前模型不支持图片输入");
  });

  it("reports an unreadable image instead of dropping it silently", async () => {
    // A well-formed attachment whose bytes are gone: the path resolves, so the read is
    // attempted and fails.
    const attachment = att({ id: "gone", mimeType: "image/png", kind: "image" });
    const blocks = (await buildUserContent("", [attachment], opts(true))) as { text: string }[];
    expect(blocks[0]!.text).toContain("读取失败");
  });

  it("distinguishes 'no path' from 'unreadable' for a vision model", async () => {
    // An attachment whose id could never address a file never reaches the read at all,
    // and gets the "missing" wording rather than "read failed".
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
