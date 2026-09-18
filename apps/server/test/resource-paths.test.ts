import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dataLayout, sessionDir, userLayout, workspaceWorkdir } from "../src/paths.js";
import type { UserLayout } from "../src/paths.js";
import {
  parsedFilePath,
  rawFilePath,
  resolveFilePath,
  resolveParsedFile,
  storePath,
  webFilePath,
} from "../src/resourcePaths.js";
import { sessionFilePath, trashFilePath, workspaceFilePath } from "../src/resources.js";

/**
 * The locator, in both directions.
 *
 * `files.path` is the *only* record of where a file's bytes are — v4 has no `storage` column to
 * pick a root and no owner to ask — so the two halves of that fact are the two functions here:
 * a writer stores what `storePath` produced, and a reader resolves it back. A drift between them
 * is a file that lists in the library and 404s on open, which is silent until somebody clicks.
 *
 * That is why the first block asserts the relative *builders* agree with the absolute paths
 * `paths.ts` produces: the builders spell out path segments (`workspaces/<slug>/workdir/…`) that
 * `paths.ts` also spells out, and nothing in the type system connects the two.
 */

let dataRoot: string;
let user: UserLayout;

beforeEach(() => {
  dataRoot = mkdtempSync(join(tmpdir(), "gl-paths-"));
  user = userLayout(dataLayout(dataRoot), "ada");
});

afterEach(() => {
  rmSync(dataRoot, { recursive: true, force: true });
});

describe("the relative builders agree with the layout", () => {
  it("places a workspace file inside its workdir", () => {
    const absolute = join(workspaceWorkdir(join(user.workspacesRoot, "study")), "notes/a.md");
    expect(join(user.userRoot, workspaceFilePath("study", "notes/a.md"))).toBe(absolute);
  });

  it("places a session file inside that conversation's directory", () => {
    const absolute = join(sessionDir(join(user.workspacesRoot, "study"), "s1"), "flow.mmd");
    expect(join(user.userRoot, sessionFilePath("study", "s1", "flow.mmd"))).toBe(absolute);
  });

  it("places a deleted file under the workspace's trash, namespaced by file id", () => {
    const absolute = join(
      join(user.workspacesRoot, "study"),
      "trash",
      "f1",
      "notes/a.md"
    );
    expect(join(user.userRoot, trashFilePath("study", "f1", "notes/a.md"))).toBe(absolute);
  });

  it("places a blob where the MIME table says", () => {
    // The blob and parsed helpers are absolute — they are what a writer opens — so the stored
    // form comes back through `storePath`, which is the pair a caller actually uses.
    expect(rawFilePath(user, "f1", "application/pdf")).toBe(join(user.rawDir, "f1.pdf"));
    expect(webFilePath(user, "f2", "text/html")).toBe(join(user.webDir, "f2.html"));
    expect(parsedFilePath(user, "r1")).toBe(join(user.parsedDir, "r1.txt"));

    expect(storePath(user, rawFilePath(user, "f1", "application/pdf"))).toBe(
      "sources/raw/f1.pdf"
    );
    expect(storePath(user, parsedFilePath(user, "r1"))).toBe("sources/parsed/r1.txt");
  });
});

describe("storePath", () => {
  it("round-trips through resolveFilePath", () => {
    const absolute = join(user.userRoot, workspaceFilePath("study", "notes/a.md"));
    const stored = storePath(user, absolute);
    expect(stored).toBe("workspaces/study/workdir/notes/a.md");
    expect(resolveFilePath(user, { path: stored })).toBe(absolute);
  });

  it("stores forward slashes, so a database is portable", () => {
    // `relative` is the platform's separator, and the stored form normalises it away — a
    // database written on one platform has to read on another.
    const absolute = join(user.userRoot, "workspaces", "study", "workdir", "a.md");
    expect(storePath(user, absolute).includes("\\")).toBe(false);
  });
});

describe("resolveFilePath refuses what a row cannot be trusted to name", () => {
  it("refuses an empty path", () => {
    // An empty path resolves to the user root itself, and a live row naming a directory is not
    // a file. `resolveInWorkspace`'s `allowRoot = false` is what makes this a refusal.
    expect(resolveFilePath(user, { path: "" })).toBeUndefined();
  });

  it("refuses a path that climbs out of the user root", () => {
    expect(resolveFilePath(user, { path: "../../etc/passwd" })).toBeUndefined();
    expect(resolveFilePath(user, { path: "workspaces/../../etc/passwd" })).toBeUndefined();
  });

  it("refuses an absolute path", () => {
    // The reason the column is relative in the first place: an absolute path is what breaks when
    // a data root is copied. Storing one and resolving it anyway would defeat the rule.
    expect(resolveFilePath(user, { path: "/etc/passwd" })).toBeUndefined();
  });

  it("accepts an ordinary relative path", () => {
    expect(resolveFilePath(user, { path: "sources/raw/f1.pdf" })).toBe(
      join(user.rawDir, "f1.pdf")
    );
  });
});

describe("resolveParsedFile", () => {
  it("answers nothing for a resource that was never parsed", () => {
    // `none` is a different claim from `ready`, and the distinction is what keeps a chip from
    // offering text that does not exist.
    expect(resolveParsedFile(user, { parseStatus: "none", parsedFileId: "f1" })).toBeUndefined();
  });

  it("answers nothing for a parse that produced no file", () => {
    expect(resolveParsedFile(user, { parseStatus: "ready" })).toBeUndefined();
  });

  it("follows the row's own pointer", () => {
    expect(resolveParsedFile(user, { parseStatus: "ready", parsedFileId: "f1" })).toBe(
      join(user.parsedDir, "f1.txt")
    );
  });
});
