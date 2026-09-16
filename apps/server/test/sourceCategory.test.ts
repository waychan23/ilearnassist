import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DIAGRAM_FILE_EXTENSIONS } from "@ilearnassist/shared";
import { categoryFor, classifySource, extensionOf, mimeForName } from "../src/sourceCategory.js";
import { isDocumentMime } from "../src/documents/formats.js";
import { normalizeMime } from "../src/sourcePaths.js";

/**
 * What a file is, and the guard that keeps this answer in agreement with the two other places
 * that classify files.
 *
 * `category` is a *label*: it is what the browser filters on and what tells a reader at a
 * glance what a list holds. Nothing about whether a file is readable hangs off it — that is
 * `isDocumentMime` for parsing and the byte sniff for text — so the failure this file is built
 * to prevent is not a crash but a disagreement: a `.mmd` stored as `text` would be shown as
 * source in the browser and drawn as a diagram in the panel, which is a bug this codebase has
 * already had once with the preview dialog.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

describe("extensionOf", () => {
  it("lowercases, drops the dot, and answers empty for a name without one", () => {
    expect(extensionOf("A.PDF")).toBe("pdf");
    expect(extensionOf("archive.tar.gz")).toBe("gz");
    expect(extensionOf("Makefile")).toBe("");
    // A dotfile has no extension by Node's reading, which is why `CODE_BASENAMES` lists them
    // by full name rather than by suffix.
    expect(extensionOf(".gitignore")).toBe("");
  });
});

describe("mimeForName", () => {
  it("keeps a MIME type the caller already knows", () => {
    expect(mimeForName("weird.xyz", "text/html")).toBe("text/html");
  });

  it("does not keep the one value that means 'no opinion'", () => {
    // The browser's generic type for an unknown file, which would make every `.md` a binary
    // if it were believed.
    expect(mimeForName("notes.md", "application/octet-stream")).toBe("text/markdown");
  });

  it("derives from the extension, and falls back to octet-stream", () => {
    expect(mimeForName("plot.png")).toBe("image/png");
    expect(mimeForName("thing.xyz")).toBe("application/octet-stream");
    expect(mimeForName("LICENSE")).toBe("application/octet-stream");
  });
});

describe("categoryFor", () => {
  it("calls an image an image, by type or by name", () => {
    expect(categoryFor("photo.jpg")).toBe("image");
    expect(categoryFor("whatever.bin", "image/webp")).toBe("image");
    expect(categoryFor("scan.tiff")).toBe("image");
  });

  it("calls a document a document — the same six types the parser handles", () => {
    for (const mime of [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.oasis.opendocument.text",
      "application/vnd.oasis.opendocument.spreadsheet",
    ]) {
      expect(isDocumentMime(mime), `${mime} should be a document type`).toBe(true);
      expect(categoryFor("file", mime)).toBe("document");
    }
  });

  it("separates markdown, code and plain text", () => {
    expect(categoryFor("README.md")).toBe("markdown");
    expect(categoryFor("main.ts")).toBe("code");
    expect(categoryFor("notes.txt")).toBe("text");
    expect(categoryFor("data.csv")).toBe("text");
  });

  it("knows a diagram by its extension", () => {
    for (const ext of DIAGRAM_FILE_EXTENSIONS) {
      expect(categoryFor(`flow.${ext}`)).toBe("diagram");
    }
  });

  it("reads a file with no extension as text rather than as nothing", () => {
    // `LICENSE` and `Makefile` are the case: the second is code by name, the first is text by
    // default, and neither is `other` — a category nothing can be done with.
    expect(categoryFor("Makefile")).toBe("code");
    expect(categoryFor("LICENSE")).toBe("text");
    expect(categoryFor("NOTES")).toBe("text");
  });

  it("answers `other` for a binary nothing else claims", () => {
    for (const name of ["bundle.zip", "clip.mp4", "font.woff2", "app.exe", "lib.wasm", "x.sqlite"]) {
      expect(categoryFor(name), name).toBe("other");
    }
  });

  it("never answers `page` from a name", () => {
    // A page is decided by *origin* — a fetched URL — and an `.html` file in a workspace is
    // code. If this ever returned `page`, a file on disk would claim to be a web page.
    for (const name of ["index.html", "page.htm", "site.xml"]) {
      expect(categoryFor(name)).not.toBe("page");
    }
  });
});

describe("classifySource", () => {
  it("answers both questions and resolves the MIME type", () => {
    expect(classifySource("paper.pdf")).toEqual({
      category: "document",
      mimeType: "application/pdf",
    });
  });

  it("believes the caller's MIME type over the extension", () => {
    // An upload knows what the browser said, and a file dumped in a workspace does not — so
    // the same name can honestly be two things, and the caller decides.
    expect(classifySource("export.bin", "image/png").category).toBe("image");
    expect(classifySource("export.bin").category).toBe("other");
  });
});

/**
 * The drift guard, and the reason this test file exists rather than a handful of cases above.
 *
 * Three modules classify files and they must agree, because they answer three questions about
 * the same bytes: *what kind of thing is this* (here), *may it be uploaded* (`sourcePaths`'s
 * MIME table), *is it text or binary for a reader* (`files.ts`'s read-avoidance list). A new
 * member of either of the other two sets that this classifier calls `text` or `code` is a file
 * the browser offers as text and cannot open — a `.mmd` drawn in one panel and shown as source
 * in another, which is exactly the bug the preview dialog's exhaustive switch was written for.
 */
describe("agreement with the other two lists", () => {
  /** The private sets in `files.ts`, read out of the source rather than exported. */
  function setInFiles(name: string): string[] {
    const source = readFileSync(join(HERE, "..", "src", "files.ts"), "utf8");
    const block = new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`).exec(source);
    if (!block) throw new Error(`${name} not found in files.ts`);
    return [...block[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  }

  it("never calls a known-binary extension text, code, markdown or a diagram", () => {
    for (const ext of setInFiles("BINARY_EXTENSIONS")) {
      const category = categoryFor(`file.${ext}`);
      expect(["text", "code", "markdown", "diagram"], `.${ext} classified as ${category}`).not.toContain(
        category
      );
    }
  });

  it("calls every diagram extension a diagram", () => {
    // From `shared` rather than out of `files.ts`, because that is where the set comes from:
    // `files.ts` builds its own from this constant, so reading the constant is reading the
    // source of both.
    for (const ext of DIAGRAM_FILE_EXTENSIONS) {
      expect(categoryFor(`file.${ext}`), `.${ext}`).toBe("diagram");
    }
  });

  it("calls every markdown extension markdown", () => {
    for (const ext of setInFiles("MARKDOWN_EXTENSIONS")) {
      expect(categoryFor(`file.${ext}`), `.${ext}`).toBe("markdown");
    }
  });

  it("agrees with the upload table about what an accepted type is", () => {
    // The acceptance list is a whitelist and this is a description, so they are not the same
    // set — but where they overlap they must not disagree, or a file type that can be uploaded
    // would arrive as `other`.
    for (const name of ["a.png", "a.txt", "a.md", "a.csv", "a.html", "a.json", "a.pdf", "a.docx"]) {
      expect(normalizeMime(name, undefined), name).toBeDefined();
      expect(categoryFor(name), name).not.toBe("other");
    }
  });
});
