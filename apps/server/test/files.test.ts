import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_FILE_PREVIEW_BYTES } from "@ilearnassist/shared";
import {
  FileAccessError,
  MAX_PREVIEW_BYTES,
  listDirectory,
  readFileContent,
  readRawFile,
} from "../src/files.js";

/**
 * The browser's read side. The interesting cases are not the happy path: they are what
 * happens at the sandbox edge (a symlink out of the workspace is the one
 * `resolveInWorkspace` cannot see), what a file the server cannot render reports, and what
 * a file larger than the preview cap does.
 */

let workspace: string;
let outside: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "gl-browse-"));
  outside = mkdtempSync(join(tmpdir(), "gl-outside-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

/** The code a rejected call carried, or a failure naming what it did instead. */
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof FileAccessError) return err.code;
    throw err;
  }
  throw new Error("expected the call to reject");
}

describe("listDirectory", () => {
  it("lists the root, directories first and then files", async () => {
    writeFileSync(join(workspace, "b.txt"), "x");
    writeFileSync(join(workspace, "a.txt"), "x");
    mkdirSync(join(workspace, "zeta"));
    mkdirSync(join(workspace, "alpha"));

    const listing = await listDirectory(workspace);
    expect(listing.path).toBe("");
    expect(listing.entries.map((e) => e.name)).toEqual(["alpha", "zeta", "a.txt", "b.txt"]);
    expect(listing.entries.map((e) => e.type)).toEqual(["dir", "dir", "file", "file"]);
  });

  it("treats an absent path, \".\" and \"\" as the root", async () => {
    writeFileSync(join(workspace, "a.txt"), "x");
    for (const path of [undefined, ".", "", "./"]) {
      const listing = await listDirectory(workspace, path);
      expect(listing.entries.map((e) => e.name)).toEqual(["a.txt"]);
    }
  });

  it("reports a file's size and a directory's absence of one", async () => {
    writeFileSync(join(workspace, "a.txt"), "hello");
    mkdirSync(join(workspace, "dir"));

    const { entries } = await listDirectory(workspace);
    expect(entries.find((e) => e.name === "a.txt")).toMatchObject({ size: 5 });
    expect(entries.find((e) => e.name === "dir")).toMatchObject({
      size: null,
      modifiedAt: null,
    });
  });

  it("lists one level with a workspace-relative path per entry", async () => {
    mkdirSync(join(workspace, "sub"));
    writeFileSync(join(workspace, "sub", "inner.txt"), "x");

    const listing = await listDirectory(workspace, "sub");
    expect(listing.path).toBe("sub");
    expect(listing.entries.map((e) => e.path)).toEqual(["sub/inner.txt"]);
  });

  it("404s a directory that is not there", async () => {
    expect(await codeOf(listDirectory(workspace, "nope"))).toBe("FILE_NOT_FOUND");
  });

  it("refuses to list a file", async () => {
    writeFileSync(join(workspace, "a.txt"), "x");
    expect(await codeOf(listDirectory(workspace, "a.txt"))).toBe("NOT_A_DIRECTORY");
  });

  it("rejects a path that escapes the workspace", async () => {
    expect(await codeOf(listDirectory(workspace, "../.."))).toBe("INVALID_FILE_PATH");
    expect(await codeOf(listDirectory(workspace, ".."))).toBe("INVALID_FILE_PATH");
  });

  /**
   * The case `resolveInWorkspace` cannot catch: the path never leaves the workspace as a
   * *string*, so only resolving what it points at reveals the escape.
   */
  it("rejects a symlink pointing out of the workspace", async () => {
    writeFileSync(join(outside, "secret.txt"), "not yours");
    symlinkSync(outside, join(workspace, "link"));

    expect(await codeOf(listDirectory(workspace, "link"))).toBe("INVALID_FILE_PATH");
  });

  it("still lists a symlink that stays inside the workspace", async () => {
    mkdirSync(join(workspace, "real"));
    writeFileSync(join(workspace, "real", "inner.txt"), "x");
    symlinkSync(join(workspace, "real"), join(workspace, "link"));

    const listing = await listDirectory(workspace, "link");
    expect(listing.entries.map((e) => e.name)).toEqual(["inner.txt"]);
  });

  it("lists a broken symlink rather than dropping it silently", async () => {
    symlinkSync(join(workspace, "gone"), join(workspace, "dangling"));

    const listing = await listDirectory(workspace);
    expect(listing.entries.map((e) => e.name)).toContain("dangling");
  });

  it("truncates a directory past the cap and says so", async () => {
    for (let i = 0; i < 2_005; i++) writeFileSync(join(workspace, `f${i}.txt`), "x");

    const listing = await listDirectory(workspace);
    expect(listing.entries).toHaveLength(2_000);
    expect(listing.truncated).toBe(true);
  });
});

describe("readFileContent", () => {
  it("returns text, with its metadata", async () => {
    writeFileSync(join(workspace, "a.txt"), "hello");

    const content = await readFileContent(workspace, "a.txt");
    expect(content).toMatchObject({
      path: "a.txt",
      name: "a.txt",
      size: 5,
      kind: "text",
      text: "hello",
      truncated: false,
    });
    expect(Date.parse(content.modifiedAt)).not.toBeNaN();
  });

  it("classifies markdown as markdown", async () => {
    writeFileSync(join(workspace, "README.md"), "# hi");
    expect((await readFileContent(workspace, "README.md")).kind).toBe("markdown");
  });

  it("classifies diagram source as a diagram, and sends the source", async () => {
    // Both extensions, because `.mermaid` is what people arrive with and `.mmd` is what
    // `ila_diagram` writes — the client draws either.
    writeFileSync(join(workspace, "flow.mmd"), "flowchart TD\n  A --> B");
    writeFileSync(join(workspace, "other.mermaid"), "sequenceDiagram\n  A->>B: hi");

    const mmd = await readFileContent(workspace, "flow.mmd");
    expect(mmd.kind).toBe("diagram");
    expect(mmd.text).toBe("flowchart TD\n  A --> B");
    expect((await readFileContent(workspace, "other.mermaid")).kind).toBe("diagram");
  });

  it("decides a diagram by its extension, before reading the bytes", async () => {
    /*
     * A decision, not an oversight. Markdown works the same way, and for the same reason: the
     * source is what the client needs to draw the thing, so a `.mmd` that happens to hold NUL
     * bytes gets sent as text and decodes to replacement characters rather than being refused
     * as a binary — which is the honest outcome for a file that claims by its name to be
     * diagram source. Nobody can produce one except by making it.
     */
    writeFileSync(join(workspace, "broken.mmd"), Buffer.from([0x00, 0x01, 0xff]));

    const content = await readFileContent(workspace, "broken.mmd");
    expect(content.kind).toBe("diagram");
    expect(content.text).not.toBeNull();
  });

  it("still flags a diagram longer than the preview cap", async () => {
    // A truncated diagram will not parse, which is the renderer's problem to survive — but the
    // truncation is still reported, because a file that looks like it ends there is a lie.
    writeFileSync(join(workspace, "big.mmd"), "x".repeat(MAX_PREVIEW_BYTES + 1_000));
    expect((await readFileContent(workspace, "big.mmd")).truncated).toBe(true);
  });

  /**
   * An extensionless file is the case a table of extensions cannot answer, and the reason
   * the classification reads the bytes at all.
   */
  it("reads an extensionless text file", async () => {
    writeFileSync(join(workspace, "Makefile"), "all:\n\techo hi\n");
    const content = await readFileContent(workspace, "Makefile");
    expect(content.kind).toBe("text");
    expect(content.text).toContain("echo hi");
  });

  it("classifies a known binary by its name, without reading it", async () => {
    // Valid UTF-8 text, and deliberately so: a NUL byte or a bad decode would reach the same
    // `binary` by the sniff, and then this would prove nothing about the name winning. Text in
    // a `.png` can only come out `binary` if the extension was consulted first.
    const text = "this is not really a png";
    writeFileSync(join(workspace, "a.png"), text);

    const content = await readFileContent(workspace, "a.png");
    expect(content.kind).toBe("binary");
    expect(content.text).toBeNull();
    // The metadata still arrives, which is what the viewer's panels render.
    expect(content.size).toBe(Buffer.byteLength(text));
  });

  it("classifies a file whose bytes are not text as binary", async () => {
    writeFileSync(join(workspace, "blob"), Buffer.from([0x00, 0x01, 0x02, 0xff]));
    expect((await readFileContent(workspace, "blob")).kind).toBe("binary");
  });

  it("returns only the first cap of a long file, and flags it", async () => {
    writeFileSync(join(workspace, "big.txt"), "x".repeat(MAX_PREVIEW_BYTES + 1_000));

    const content = await readFileContent(workspace, "big.txt");
    expect(content.truncated).toBe(true);
    expect(content.text).toHaveLength(MAX_PREVIEW_BYTES);
    expect(content.size).toBe(MAX_PREVIEW_BYTES + 1_000);
  });

  it("does not flag a file that is exactly the cap", async () => {
    writeFileSync(join(workspace, "exact.txt"), "x".repeat(MAX_PREVIEW_BYTES));
    expect((await readFileContent(workspace, "exact.txt")).truncated).toBe(false);
  });

  it("keeps multi-byte characters intact", async () => {
    writeFileSync(join(workspace, "cn.txt"), "工作空间");
    expect((await readFileContent(workspace, "cn.txt")).text).toBe("工作空间");
  });

  it("404s a file that is not there", async () => {
    expect(await codeOf(readFileContent(workspace, "nope.txt"))).toBe("FILE_NOT_FOUND");
  });

  it("refuses to read a directory", async () => {
    mkdirSync(join(workspace, "dir"));
    expect(await codeOf(readFileContent(workspace, "dir"))).toBe("NOT_A_FILE");
  });

  it("requires a path", async () => {
    expect(await codeOf(readFileContent(workspace, ""))).toBe("INVALID_FILE_PATH");
  });

  it("rejects a symlink to a file outside the workspace", async () => {
    writeFileSync(join(outside, "secret.txt"), "not yours");
    symlinkSync(join(outside, "secret.txt"), join(workspace, "link.txt"));

    expect(await codeOf(readFileContent(workspace, "link.txt"))).toBe("INVALID_FILE_PATH");
  });
});

/**
 * The byte route, which exists because the one above cannot carry a PDF: it decodes UTF-8 and
 * stops at a quarter of a megabyte.
 *
 * The sandbox is the thing to re-prove here rather than assume. `readRawFile` shares
 * `resolveReal` with every other read, but "it calls the same function" is not the same
 * evidence as a symlink refused, and this is the route that hands out whole files.
 */
describe("readRawFile", () => {
  it("returns the whole file, past the text preview cap", async () => {
    // Larger than MAX_PREVIEW_BYTES on purpose: the entire reason this route exists is that
    // the other one truncates, so a test under the cap would pass either way.
    const bytes = Buffer.alloc(MAX_PREVIEW_BYTES + 1024, 0x41);
    writeFileSync(join(workspace, "big.bin"), bytes);

    const raw = await readRawFile(workspace, "big.bin");
    expect(raw.bytes.length).toBe(bytes.length);
    expect(raw.bytes.equals(bytes)).toBe(true);
    expect(raw.size).toBe(bytes.length);
    expect(raw.name).toBe("big.bin");
  });

  it("refuses a file past the preview limit, without reading it", async () => {
    // Sparse rather than written: a 32 MB `writeFileSync` is a slow test, and truncating gives
    // the same `stat`-visible size for nothing.
    writeFileSync(join(workspace, "huge.bin"), "");
    truncateSync(join(workspace, "huge.bin"), MAX_FILE_PREVIEW_BYTES + 1);

    expect(await codeOf(readRawFile(workspace, "huge.bin"))).toBe("FILE_TOO_LARGE");
  });

  it("allows a file exactly at the limit", async () => {
    // The boundary is inclusive, and it is worth pinning: an off-by-one here would refuse the
    // largest file the constant promises to serve.
    writeFileSync(join(workspace, "exact.bin"), "");
    truncateSync(join(workspace, "exact.bin"), MAX_FILE_PREVIEW_BYTES);

    expect((await readRawFile(workspace, "exact.bin")).size).toBe(MAX_FILE_PREVIEW_BYTES);
  });

  it("refuses to read a directory", async () => {
    mkdirSync(join(workspace, "dir"));
    expect(await codeOf(readRawFile(workspace, "dir"))).toBe("NOT_A_FILE");
  });

  it("requires a path", async () => {
    expect(await codeOf(readRawFile(workspace, ""))).toBe("INVALID_FILE_PATH");
  });

  it("404s a file that is not there", async () => {
    expect(await codeOf(readRawFile(workspace, "nope.pdf"))).toBe("FILE_NOT_FOUND");
  });

  it("rejects a path that climbs out of the workspace", async () => {
    expect(await codeOf(readRawFile(workspace, "../outside.txt"))).toBe("INVALID_FILE_PATH");
  });

  it("rejects a symlink to a file outside the workspace", async () => {
    writeFileSync(join(outside, "secret.pdf"), "not yours");
    symlinkSync(join(outside, "secret.pdf"), join(workspace, "link.pdf"));

    // The realpath check, and the reason it is repeated here rather than trusted to the read
    // above: this is the route that hands a caller a whole file.
    expect(await codeOf(readRawFile(workspace, "link.pdf"))).toBe("INVALID_FILE_PATH");
  });
});
