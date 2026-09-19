import { describe, expect, it } from "vitest";
import type { StoredFile, WebPage, WorkResource } from "../../src/api/types";
import {
  fileOf,
  pageOf,
  resourceAttachment,
  resourceCategory,
  resourceExtension,
  resourceIsImage,
  resourceMime,
  resourceName,
  resourceSandboxPath,
  resourceSize,
  resourceUrl,
} from "../../src/utils/resourceView";

/**
 * Reading a `WorkResource` the way the UI reads it.
 *
 * The module exists because a v4 reference is **polymorphic** — a file or a page — and four
 * surfaces draw the same row. What is worth pinning is therefore every place the two arms
 * differ, because that is where a caller that assumed a file gets an answer it should not have:
 * a page has no category, no path and no size, and a page's "bytes" are not what its row is
 * about.
 */

function fileResource(overrides: Partial<WorkResource> = {}, file: Partial<StoredFile> = {}): WorkResource {
  return {
    id: "r1",
    resourceType: "file",
    resourceId: "f1",
    ownerType: "workspace",
    ownerId: "w1",
    title: "notes/a.md",
    parseStatus: "ready",
    createdAt: "2026-01-01T00:00:00.000Z",
    resource: {
      id: "f1",
      sourceType: "agent_create",
      title: "a.md",
      path: "workspaces/study/workdir/notes/a.md",
      mimeType: "text/markdown",
      category: "markdown",
      size: 42,
      createdAt: "2026-01-01T00:00:00.000Z",
      ...file,
    },
    ...overrides,
  };
}

function pageResource(overrides: Partial<WorkResource> = {}, page: Partial<WebPage> = {}): WorkResource {
  return {
    id: "r2",
    resourceType: "web_page",
    resourceId: "p1",
    ownerType: "session",
    ownerId: "s1",
    title: "Kept article",
    parseStatus: "none",
    createdAt: "2026-01-01T00:00:00.000Z",
    resource: {
      id: "p1",
      sourceType: "agent_fetch",
      url: "https://example.com/a",
      title: "Kept article",
      createdAt: "2026-01-01T00:00:00.000Z",
      ...page,
    },
    ...overrides,
  };
}

describe("the two arms", () => {
  it("answers which entity a reference points at", () => {
    expect(fileOf(fileResource())?.id).toBe("f1");
    expect(fileOf(pageResource())).toBeNull();
    expect(pageOf(pageResource())?.url).toBe("https://example.com/a");
    expect(pageOf(fileResource())).toBeNull();
  });

  it("takes the display name from the reference, never from the entity", () => {
    // The two are deliberately different here: a file keeps the first title it was registered
    // under, so an owner that names it something else must win — it is what the chip showed.
    expect(resourceName(fileResource())).toBe("notes/a.md");
    expect(resourceName(fileResource({}, { title: "a.md" }))).toBe("notes/a.md");
  });

  it("has no category for a page, and does not invent one", () => {
    // `page` was a category in v3 and is a `resourceType` in v4: a category is derived from a
    // file's *name*, and a page has no name to derive one from.
    expect(resourceCategory(fileResource())).toBe("markdown");
    expect(resourceCategory(pageResource())).toBeNull();
  });

  it("describes a page as the stored HTML it is", () => {
    expect(resourceMime(pageResource())).toBe("text/html");
    expect(resourceSize(pageResource())).toBe(0);
  });

  it("tells an image from a file by its MIME type", () => {
    expect(resourceIsImage(fileResource({}, { mimeType: "image/png" }))).toBe(true);
    expect(resourceIsImage(fileResource())).toBe(false);
    expect(resourceIsImage(pageResource())).toBe(false);
  });

  it("has a URL only for a page", () => {
    expect(resourceUrl(pageResource())).toBe("https://example.com/a");
    expect(resourceUrl(fileResource())).toBeUndefined();
  });
});

describe("resourceExtension", () => {
  /*
   * The pill the library draws beside a title. It exists because a title is what a person called
   * the material, so it may say nothing about the format — and it is read from the **file's own
   * name**, never from the reference title, which is the whole point.
   */
  it("reads the format from the file's name, not from the row's title", () => {
    const row = fileResource({ title: "季度对比" }, { title: "report.xlsx" });
    expect(resourceExtension(row)).toBe(".xlsx");
  });

  it("lowercases it, so a camera's IMG_1234.JPG does not shout", () => {
    expect(resourceExtension(fileResource({}, { title: "IMG_1234.JPG" }))).toBe(".jpg");
  });

  it("falls back to the stored path when the name carries no format", () => {
    // An upload's bytes are named from the MIME table, so a `.jpeg` the user picked is stored
    // `.jpg` — the same format, and the fallback is what keeps the pill truthful for a row whose
    // title is a bare label with no dot in it.
    const row = fileResource({}, { title: "photo", path: "sources/raw/abc123.jpg" });
    expect(resourceExtension(row)).toBe(".jpg");
  });

  it("says nothing when neither the name nor the path has a format", () => {
    const bare = (name: string) =>
      resourceExtension(fileResource({}, { title: name, path: `workspaces/study/workdir/${name}` }));
    expect(bare("Makefile")).toBeUndefined();
    expect(bare("trailing.")).toBeUndefined();
    expect(bare(".hidden")).toBeUndefined();
  });

  it("ignores a dot that carries no format, and answers with the path's", () => {
    // A version number is the case this is for: the title has a dot in it, and what follows is a
    // format only if you did not read the whole word. The stored name is the authority, and it
    // says `.md`.
    const row = fileResource(
      {},
      { title: "报告 v1.2 定稿", path: "workspaces/study/workdir/notes.md" }
    );
    expect(resourceExtension(row)).toBe(".md");
  });

  it("has none for a page, which is a URL rather than a file", () => {
    // A page's row is drawn with 网页 in the origin column instead — an extension would be the
    // app inventing a format for something that has none.
    expect(resourceExtension(pageResource())).toBeUndefined();
  });
});

describe("resourceSandboxPath", () => {
  it("strips a workspace file's sandbox prefix", () => {
    // The stored path is relative to the *account*, so the prefix is the same for every row of
    // an owner and would draw three levels of directory nobody named.
    expect(resourceSandboxPath(fileResource())).toBe("notes/a.md");
    expect(
      resourceSandboxPath(fileResource({}, { path: "workspaces/study/workdir/deep/nested/b.md" }))
    ).toBe("deep/nested/b.md");
  });

  it("strips a conversation's prefix, for that conversation's id", () => {
    const row = fileResource(
      { ownerType: "session", ownerId: "sess1" },
      { path: "workspaces/study/sessions/sess1/diagram.mmd" }
    );
    expect(resourceSandboxPath(row)).toBe("diagram.mmd");
  });

  it("returns nothing for a file whose path names another conversation", () => {
    // The claim the grouping rests on: a path is only meaningful under its owner, so a session
    // file found under a *different* owner's id is not filed as this one's.
    const row = fileResource(
      { ownerType: "session", ownerId: "sess1" },
      { path: "workspaces/study/sessions/sess2/diagram.mmd" }
    );
    expect(resourceSandboxPath(row)).toBeUndefined();
  });

  it("returns nothing for an upload, whose bytes are not in a sandbox", () => {
    // An upload is *named*, not located — `sources/raw/<id>.<ext>` says nothing about where the
    // material came from, so the row belongs at its owner rather than under a `sources/raw` group.
    expect(resourceSandboxPath(fileResource({}, { path: "sources/raw/f1.pdf" }))).toBeUndefined();
  });

  it("returns nothing for a page", () => {
    expect(resourceSandboxPath(pageResource())).toBeUndefined();
  });
});

describe("resourceAttachment", () => {
  it("keeps the entity id and the reference id apart", () => {
    // The v4 split in miniature: the bytes are fetched by the first and read by the model
    // through the second, and swapping them is a chip that never leaves "parsing".
    const attachment = resourceAttachment(fileResource());
    expect(attachment.id).toBe("f1");
    expect(attachment.resourceId).toBe("r1");
  });

  it("carries the parse state, which belongs to the reference", () => {
    const attachment = resourceAttachment(
      fileResource({ parseStatus: "failed", parseError: "boom", parsedChars: 12 })
    );
    expect(attachment.parseStatus).toBe("failed");
    expect(attachment.parseError).toBe("boom");
    expect(attachment.parsedChars).toBe(12);
  });

  it("carries the title, the MIME type and the kind a chip draws", () => {
    const attachment = resourceAttachment(
      fileResource({}, { mimeType: "image/png", size: 7 })
    );
    expect(attachment.name).toBe("notes/a.md");
    expect(attachment.mimeType).toBe("image/png");
    expect(attachment.size).toBe(7);
    expect(attachment.kind).toBe("image");
  });
});
