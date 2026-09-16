import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SourceCategory, SourceOrigin, SourceStorage } from "@ilearnassist/shared";
import type { SourceRecord } from "../src/db.js";
import {
  isSupportedMime,
  normalizeMime,
  resolveSourceBytes,
  resolveSourceParsed,
  sourceRawPath,
  sourceWebPath,
} from "../src/sourcePaths.js";
import { dataLayout, userLayout, sessionDir, workspaceWorkdir, type UserLayout } from "../src/paths.js";

/**
 * Where a source's bytes are, for every kind of source, and the check every read goes through.
 *
 * A source used to have exactly one home and this was one expression. It now has five, which is
 * why the question has a module of its own: `resolveSourceBytes` is the single place that turns
 * a row into a path, and a second implementation of it — in a route, or in a tool — is how one
 * kind of source reads in one place and is missing in another.
 *
 * The rows here are hand-built rather than written to a database: this module's whole contract
 * is *`SourceRecord` in, path or undefined out*, and a fixture that had to go through a schema,
 * a migration and a create call to hand it one would be testing the database instead.
 */

let root: string;
let user: UserLayout;
/** The workspace's own directory — the parent of `workdir/` and `sessions/`. */
let workspaceRoot: string;

function source(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id: "src-1",
    userId: "u1",
    name: "file.txt",
    mimeType: "text/plain",
    size: 3,
    kind: "file",
    ownerKind: "session",
    ownerId: "s1",
    origin: "session_attachment" as SourceOrigin,
    storage: "upload" as SourceStorage,
    category: "text" as SourceCategory,
    parseStatus: "none",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "gl-srcpaths-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  user = userLayout(dataLayout(root), "tester");
  workspaceRoot = join(user.workspacesRoot, "ws");
  mkdirSync(workspaceWorkdir(workspaceRoot), { recursive: true });
  mkdirSync(sessionDir(workspaceRoot, "s1"), { recursive: true });
  mkdirSync(user.rawDir, { recursive: true });
  mkdirSync(user.webDir, { recursive: true });
});

describe("MIME vocabulary", () => {
  it("trusts a supported MIME type from the browser", () => {
    expect(normalizeMime("whatever.bin", "image/png")).toBe("image/png");
  });

  it("falls back to the extension when the browser says nothing useful", () => {
    expect(normalizeMime("notes.md", undefined)).toBe("text/markdown");
    expect(normalizeMime("notes.md", "application/octet-stream")).toBe("text/markdown");
  });

  it("returns undefined for a file we cannot handle", () => {
    expect(normalizeMime("thing.xyz", "application/xyz")).toBeUndefined();
    expect(normalizeMime("noextension", undefined)).toBeUndefined();
    expect(isSupportedMime(undefined)).toBe(false);
    expect(isSupportedMime("application/xyz")).toBe(false);
  });
});

describe("blob paths", () => {
  it("derives the extension from the MIME type", () => {
    expect(sourceRawPath(user, "att-1", "text/plain")).toBe(join(user.rawDir, "att-1.txt"));
    expect(sourceRawPath(user, "att-1", "application/pdf")).toBe(join(user.rawDir, "att-1.pdf"));
    expect(sourceWebPath(user, "att-1", "text/html")).toBe(join(user.webDir, "att-1.html"));
  });

  it("keeps a page's bytes out of the uploads directory", () => {
    // A sibling, not a corner of `raw/`: these bytes came off the network, and a listing of
    // the two should be able to tell them apart.
    expect(sourceWebPath(user, "att-1", "text/html").startsWith(user.rawDir)).toBe(false);
  });

  it("refuses an id that could steer the path", () => {
    // The id is generated, never client-supplied — but this is the function that turns it
    // into a path, so it is where the guard belongs.
    for (const bad of ["../escape", "a/b", "..", "", "with space"]) {
      expect(() => sourceRawPath(user, bad, "text/plain")).toThrow(/Invalid source id/);
    }
  });

  it("refuses a MIME type it cannot map to an extension", () => {
    expect(() => sourceRawPath(user, "att-1", "application/xyz")).toThrow(/Unsupported/);
  });
});

describe("resolveSourceBytes", () => {
  it("finds an upload by deriving its name", () => {
    const row = source({ storage: "upload" });
    expect(resolveSourceBytes(user, row, workspaceRoot)).toBe(
      join(user.rawDir, "src-1.txt")
    );
  });

  it("finds a page in the web directory", () => {
    const row = source({ storage: "web", mimeType: "text/html", category: "page", origin: "web" });
    expect(resolveSourceBytes(user, row, workspaceRoot)).toBe(join(user.webDir, "src-1.html"));
  });

  it("finds a workspace file under the workdir", () => {
    const row = source({ storage: "workspace", relPath: "notes/a.md", mimeType: "text/markdown" });
    expect(resolveSourceBytes(user, row, workspaceRoot)).toBe(
      join(workspaceWorkdir(workspaceRoot), "notes/a.md")
    );
  });

  it("finds a session file under that conversation's directory", () => {
    const row = source({ storage: "session", relPath: "diagram.mmd", ownerId: "s1" });
    expect(resolveSourceBytes(user, row, workspaceRoot)).toBe(
      join(sessionDir(workspaceRoot, "s1"), "diagram.mmd")
    );
  });

  it("finds a deleted file in the trash, namespaced by its id", () => {
    const row = source({ storage: "trash", relPath: "notes/a.md" });
    expect(resolveSourceBytes(user, row, workspaceRoot)).toBe(
      join(workspaceRoot, "trash", "src-1", "notes/a.md")
    );
  });

  it("answers undefined for an upload whose MIME type fell out of the table", () => {
    // Not a throw: a row is not a trust boundary, and the honest answer for one this build
    // cannot reconstruct is "no path", which every caller already handles as a missing file.
    expect(resolveSourceBytes(user, source({ mimeType: "application/xyz" }), workspaceRoot)).toBe(
      undefined
    );
  });

  it("answers undefined for a file row that names no path", () => {
    expect(resolveSourceBytes(user, source({ storage: "workspace" }), workspaceRoot)).toBeUndefined();
  });

  it("refuses a path that climbs out of its root", () => {
    for (const bad of [
      "../workdir-escape.txt",
      "../../etc/passwd",
      "/etc/passwd",
      "a/../../outside.txt",
    ]) {
      expect(
        resolveSourceBytes(user, source({ storage: "workspace", relPath: bad }), workspaceRoot)
      ).toBeUndefined();
    }
  });

  it("cannot cross from one sandbox into the other", () => {
    // The two roots are siblings, so this is the escape a single-root guard would miss.
    expect(
      resolveSourceBytes(
        user,
        source({ storage: "session", relPath: "../workdir/leak.txt", ownerId: "s1" }),
        workspaceRoot
      )
    ).toBeUndefined();
  });

  it("refuses a session whose owner id is not an id", () => {
    expect(
      resolveSourceBytes(
        user,
        source({ storage: "session", relPath: "a.txt", ownerId: "../../etc" }),
        workspaceRoot
      )
    ).toBeUndefined();
  });

  it("survives the data root being copied somewhere else", () => {
    /*
     * The property that retiring `raw_path` bought, and the reason it was worth a version
     * bump. An absolute stored path resolves against the *old* root after a copy, so every
     * source would read as missing with nothing to point at why. Nothing absolute is stored
     * now, so the same row resolves under whatever root it is opened with.
     */
    const row = source({ storage: "upload" });
    const copied = userLayout(dataLayout(join(root, "moved")), "tester");
    mkdirSync(copied.rawDir, { recursive: true });
    expect(resolveSourceBytes(copied, row, workspaceRoot)).toBe(join(copied.rawDir, "src-1.txt"));
  });
});

describe("resolveSourceParsed", () => {
  it("puts every storage's extracted text in the one parsed tree", () => {
    // One tree for every kind of source is what keeps `read_document` to a single lookup.
    for (const storage of ["upload", "web", "workspace", "session", "trash"] as SourceStorage[]) {
      const row = source({ storage, relPath: storage === "upload" ? undefined : "a.txt" });
      expect(resolveSourceParsed(user, row)).toBe(join(user.parsedDir, "src-1.txt"));
    }
  });

  it("refuses an id that could steer the path", () => {
    expect(resolveSourceParsed(user, source({ id: "../escape" }))).toBeUndefined();
  });
});

describe("the resolver is where a caller's own write is checked", () => {
  it("agrees with itself about a file that exists", () => {
    // The cheap end-to-end shape: write at the path the resolver returns, then ask again.
    const row = source({ storage: "session", relPath: "d/x.txt", ownerId: "s1" });
    const path = resolveSourceBytes(user, row, workspaceRoot)!;
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "hi");
    expect(resolveSourceBytes(user, row, workspaceRoot)).toBe(path);
  });
});
