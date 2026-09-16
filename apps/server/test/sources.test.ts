import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FileEntry } from "@ilearnassist/shared";
import { createDb, type AppDb } from "../src/db.js";
import {
  fileOwner,
  listSourceViewsForUser,
  reconcileFilesystem,
  reconcileListing,
  registerFileSource,
  renameSourceFile,
} from "../src/sources.js";
import { dataLayout, userLayout, sessionDir, workspaceWorkdir, type UserLayout } from "../src/paths.js";

/**
 * The registry: what turns a file's existence into a row, and back.
 *
 * The two claims worth pinning are the ones the design turns on. **A file's identity is its
 * id, not its path and not its bytes** — so a rename keeps the row and everything hanging off
 * it, and two identical files in two directories are two sources. And **drift is computed** —
 * a row whose file is gone is reported missing rather than hidden, because the one writer that
 * creates that drift is the agent's `delete_file`, which must not become a database write.
 */

let root: string;
let db: AppDb;
let user: UserLayout;
/** The workspace's own directory, the parent of `workdir/` and `sessions/`. */
let workspaceRoot: string;
let sessionId: string;
let workspaceId: string;

const OWNER = () => ({ kind: "session" as const, id: sessionId });

async function mkdirp(path: string): Promise<void> {
  mkdirSync(path, { recursive: true });
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "gl-sources-"));
  db = createDb(join(root, "db", "sqlite", "ilearnassist.sqlite"));

  const account = db.createUser({
    id: "u1",
    username: "Ada",
    slug: "ada",
    roles: ["superadmin"],
    passwordHash: "scrypt$16384$8$1$c2FsdA==$ZGVhZGJlZWY=",
  });
  user = userLayout(dataLayout(root), account.slug);
  workspaceRoot = join(user.workspacesRoot, "study");

  const workspace = db.createWorkspace({
    id: "w1",
    userId: account.id,
    name: "Study",
    slug: "study",
    dirPath: workspaceRoot,
  });
  workspaceId = workspace.id;

  const session = db.createSession({
    id: "s1",
    workspaceId: workspace.id,
    copilotId: null,
    copilotName: "",
    systemPrompt: "",
    allTools: true,
    tools: [],
    title: "A conversation",
  });
  sessionId = session.id;

  await mkdirp(workspaceWorkdir(workspaceRoot));
  await mkdirp(sessionDir(workspaceRoot, sessionId));
});

afterEach(() => {
  db.raw.close();
  rmSync(root, { recursive: true, force: true });
});

function entry(path: string, size = 3): FileEntry {
  return { name: path.slice(path.lastIndexOf("/") + 1), path, type: "file", size, modifiedAt: null };
}

describe("fileOwner", () => {
  it("makes the sandbox the owner", () => {
    // A file in `workdir/` is the workspace's: every conversation in it can read the file, so
    // calling it one conversation's would be a claim the tools do not honour.
    expect(fileOwner("workspace", { workspaceId: "w1", sessionId: "s1" })).toEqual({
      kind: "workspace",
      id: "w1",
    });
    expect(fileOwner("session", { workspaceId: "w1", sessionId: "s1" })).toEqual({
      kind: "session",
      id: "s1",
    });
  });
});

describe("registerFileSource", () => {
  it("creates one row for a file", () => {
    const row = registerFileSource(db, {
      userId: "u1",
      owner: OWNER(),
      storage: "session",
      relPath: "notes/a.md",
      origin: "agent_session",
      size: 3,
    });

    expect(row.relPath).toBe("notes/a.md");
    expect(row.name).toBe("a.md");
    expect(row.category).toBe("markdown");
    expect(row.mimeType).toBe("text/markdown");
    expect(row.ownerKind).toBe("session");
    expect(row.origin).toBe("agent_session");
    expect(db.listSourcesForOwner("u1", OWNER())).toHaveLength(1);
  });

  it("updates the row it already has, keeping its id", () => {
    // The property every downstream feature rests on: a message's attachment snapshot names
    // this id, so a second write of the same file must not be a second source.
    const first = registerFileSource(db, {
      userId: "u1",
      owner: OWNER(),
      storage: "session",
      relPath: "a.txt",
      origin: "agent_session",
      size: 3,
    });
    const second = registerFileSource(db, {
      userId: "u1",
      owner: OWNER(),
      storage: "session",
      relPath: "a.txt",
      origin: "agent_session",
      size: 42,
    });

    expect(second.id).toBe(first.id);
    expect(second.size).toBe(42);
    expect(db.listSourcesForOwner("u1", OWNER())).toHaveLength(1);
  });

  it("gives two identical files in two directories two rows", () => {
    // Identity is where a file is, not what is in it. Hashing file content would collapse
    // these, and a rename would then be a delete and an insert.
    for (const relPath of ["a.txt", "b/a.txt"]) {
      registerFileSource(db, {
        userId: "u1",
        owner: OWNER(),
        storage: "session",
        relPath,
        origin: "agent_session",
        size: 3,
      });
    }
    expect(db.listSourcesForOwner("u1", OWNER())).toHaveLength(2);
  });

  it("does not confuse a file with an upload of the same name", () => {
    // The blob index is partial, so a file row carries no hash at all — and a lookup by hash
    // cannot reach one.
    registerFileSource(db, {
      userId: "u1",
      owner: OWNER(),
      storage: "session",
      relPath: "a.txt",
      origin: "agent_session",
      size: 3,
    });
    expect(db.findSourceByHash("u1", "")).toBeUndefined();
  });

  it("classifies what it is told to store", () => {
    const diagram = registerFileSource(db, {
      userId: "u1",
      owner: OWNER(),
      storage: "session",
      relPath: "flow.mmd",
      origin: "agent_session",
      size: 10,
      summary: "一张流程图",
    });
    expect(diagram.category).toBe("diagram");
    expect(diagram.summary).toBe("一张流程图");
  });
});

describe("renameSourceFile", () => {
  it("keeps the row and everything hanging off it", async () => {
    const row = registerFileSource(db, {
      userId: "u1",
      owner: OWNER(),
      storage: "session",
      relPath: "old.md",
      origin: "agent_session",
      size: 3,
      summary: "what it is about",
    });

    expect(renameSourceFile(db, { userId: "u1", owner: OWNER(), from: "old.md", to: "new.md" })).toBe(
      true
    );

    const after = db.getSourceForUser(row.id, "u1")!;
    expect(after.id).toBe(row.id);
    expect(after.relPath).toBe("new.md");
    expect(after.name).toBe("new.md");
    // The summary is the user's own words about the file, and a rename is not a reason to
    // lose them.
    expect(after.summary).toBe("what it is about");
  });

  it("reports false when there was nothing at the old path", () => {
    expect(renameSourceFile(db, { userId: "u1", owner: OWNER(), from: "gone.md", to: "new.md" })).toBe(
      false
    );
  });

  it("frees the old path for a new file", () => {
    // The place index is filtered on `deleted_at`, not on the path, so the row moving away is
    // what lets a different file take the name.
    registerFileSource(db, {
      userId: "u1",
      owner: OWNER(),
      storage: "session",
      relPath: "a.md",
      origin: "agent_session",
      size: 3,
    });
    renameSourceFile(db, { userId: "u1", owner: OWNER(), from: "a.md", to: "b.md" });
    const fresh = registerFileSource(db, {
      userId: "u1",
      owner: OWNER(),
      storage: "session",
      relPath: "a.md",
      origin: "agent_session",
      size: 9,
    });
    expect(db.listSourcesForOwner("u1", OWNER())).toHaveLength(2);
    expect(fresh.relPath).toBe("a.md");
  });
});

describe("reconcileListing", () => {
  it("gives every file an id, including one no writer claimed", () => {
    // The half that cannot be eager: a file dropped in from the Finder, restored from a
    // backup, or cloned into the workspace has no writer to register it.
    const ids = reconcileListing(db, {
      userId: "u1",
      owner: OWNER(),
      storage: "session",
      entries: [entry("a.txt"), entry("b.md")],
    });

    expect(ids.size).toBe(2);
    const rows = db.listSourcesForOwner("u1", OWNER());
    expect(rows.map((r) => r.relPath).sort()).toEqual(["a.txt", "b.md"]);
    expect(rows[0]!.origin).toBe("discovered");
  });

  it("does not claim the assistant wrote something it did not", () => {
    // `origin` is what the browser prints as "生成自"; a file nobody's tool wrote, labelled
    // with the assistant's name, is a lie the user cannot catch.
    reconcileListing(db, {
      userId: "u1",
      owner: OWNER(),
      storage: "session",
      entries: [entry("dropped-in.pdf")],
    });
    expect(db.listSourcesForOwner("u1", OWNER())[0]!.origin).toBe("discovered");
  });

  it("leaves an existing row alone", () => {
    const original = registerFileSource(db, {
      userId: "u1",
      owner: OWNER(),
      storage: "session",
      relPath: "a.txt",
      origin: "agent_session",
      size: 3,
      summary: "mine",
    });

    const ids = reconcileListing(db, {
      userId: "u1",
      owner: OWNER(),
      storage: "session",
      entries: [entry("a.txt")],
    });

    expect(ids.get("a.txt")).toBe(original.id);
    const after = db.getSourceForUser(original.id, "u1")!;
    expect(after.origin).toBe("agent_session");
    expect(after.summary).toBe("mine");
  });

  it("ignores directories", () => {
    const ids = reconcileListing(db, {
      userId: "u1",
      owner: OWNER(),
      storage: "session",
      entries: [{ ...entry("node_modules"), type: "dir", size: null }],
    });
    expect(ids.size).toBe(0);
    expect(db.listSourcesForOwner("u1", OWNER())).toHaveLength(0);
  });

  it("stays inside its owner", () => {
    // Two conversations in one workspace, each with a file at the same relative path. The
    // place index is per owner, so this is two rows rather than a collision.
    const other = db.createSession({
      id: "s2",
      workspaceId,
      copilotId: null,
      copilotName: "",
      systemPrompt: "",
      allTools: true,
      tools: [],
      title: "Another",
    });

    const asSession = (id: string) => ({ kind: "session" as const, id });
    for (const owner of [OWNER(), asSession(other.id)]) {
      reconcileListing(db, {
        userId: "u1",
        owner,
        storage: "session",
        entries: [entry("a.txt")],
      });
    }

    expect(db.listSourcesForOwner("u1", OWNER())).toHaveLength(1);
    expect(db.listSourcesForOwner("u1", asSession(other.id))).toHaveLength(1);
    expect(db.listSourcesForOwner("u1", OWNER())[0]!.id).not.toBe(
      db.listSourcesForOwner("u1", asSession(other.id))[0]!.id
    );
  });
});

describe("listSourceViews", () => {
  it("reports a file that is really there as present", async () => {
    writeFileSync(join(sessionDir(workspaceRoot, sessionId), "a.txt"), "hi");
    registerFileSource(db, {
      userId: "u1",
      owner: OWNER(),
      storage: "session",
      relPath: "a.txt",
      origin: "agent_session",
      size: 2,
    });

    const views = await listSourceViewsForUser(db, user, "u1");
    expect(views[0]!.missing).toBe(false);
  });

  it("reports a row whose file is gone as missing, and still returns the row", async () => {
    /*
     * Drift, and the shape of the answer. The file tool's `delete_file` is a plain filesystem
     * operation, so the row stays — and a row that vanished from the listing because its file
     * did would be indistinguishable from one that was never there. Computed on read, never
     * stored: a stored flag would need somebody to clear it, and the only somebody is a
     * database write inside a tool that must not make one.
     */
    registerFileSource(db, {
      userId: "u1",
      owner: OWNER(),
      storage: "session",
      relPath: "gone.txt",
      origin: "agent_session",
      size: 2,
    });

    const views = await listSourceViewsForUser(db, user, "u1");
    expect(views).toHaveLength(1);
    expect(views[0]!.missing).toBe(true);
    expect(views[0]!.relPath).toBe("gone.txt");
  });

  it("reports a row whose path left its sandbox as missing rather than reading it", async () => {
    registerFileSource(db, {
      userId: "u1",
      owner: OWNER(),
      storage: "session",
      relPath: "../../etc/passwd",
      origin: "agent_session",
      size: 2,
    });

    const views = await listSourceViewsForUser(db, user, "u1");
    expect(views[0]!.missing).toBe(true);
  });
});

/**
 * The filters the source browser draws with.
 *
 * Every one is independent, and the two that matter are the scope ones: a *workspace* holds
 * more than what it owns — a file uploaded in one of its conversations is owned by that
 * conversation while being readable by the whole workspace — so filtering by ownership alone
 * would hide exactly the sharing the link tables exist for. These cases are about that
 * widening, and about a search that is a search rather than a pattern language.
 */
describe("listSourcesForUser filters", () => {
  /** A second conversation in the same workspace, and a second workspace. */
  function secondSession(id: string) {
    return db.createSession({
      id,
      workspaceId,
      copilotId: null,
      copilotName: "",
      systemPrompt: "",
      allTools: true,
      tools: [],
      title: "Another",
    });
  }

  function seedAll(): { uploadId: string; sessionFileId: string; workspaceFileId: string } {
    const upload = db.createSource({
      id: "src-upload",
      userId: "u1",
      ownerKind: "session",
      ownerId: sessionId,
      origin: "session_attachment",
      storage: "upload",
      relPath: null,
      name: "lecture.pdf",
      mimeType: "application/pdf",
      category: "document",
      size: 10,
      url: null,
      summary: null,
      sha256: "a".repeat(64),
    });
    db.linkSourceToSession("u1", sessionId, upload.id);
    db.linkSourceToWorkspace("u1", workspaceId, upload.id);

    const sessionFile = registerFileSource(db, {
      userId: "u1",
      owner: OWNER(),
      storage: "session",
      relPath: "flow.mmd",
      origin: "agent_session",
      size: 3,
    });
    const workspaceFile = registerFileSource(db, {
      userId: "u1",
      owner: { kind: "workspace", id: workspaceId },
      storage: "workspace",
      relPath: "notes/a.md",
      origin: "agent_workspace",
      size: 3,
    });
    return { uploadId: upload.id, sessionFileId: sessionFile.id, workspaceFileId: workspaceFile.id };
  }

  it("returns everything for an account when no filter is given", () => {
    seedAll();
    expect(db.listSourcesForUser("u1")).toHaveLength(3);
  });

  it("narrows to one storage", () => {
    seedAll();
    const uploads = db.listSourcesForUser("u1", { storage: "upload" });
    expect(uploads.map((s) => s.name)).toEqual(["lecture.pdf"]);
  });

  it("narrows by category and by origin", () => {
    seedAll();
    expect(db.listSourcesForUser("u1", { category: "diagram" }).map((s) => s.name)).toEqual([
      "flow.mmd",
    ]);
    expect(db.listSourcesForUser("u1", { origin: "agent_workspace" }).map((s) => s.name)).toEqual([
      "a.md",
    ]);
  });

  it("finds a workspace's files, its conversations' files, and what is linked to it", () => {
    const { uploadId, sessionFileId, workspaceFileId } = seedAll();
    const ids = db.listSourcesForUser("u1", { workspaceId }).map((s) => s.id).sort();
    expect(ids).toEqual([uploadId, sessionFileId, workspaceFileId].sort());
  });

  it("finds a conversation's own files and the uploads linked to it", () => {
    const { uploadId, sessionFileId } = seedAll();
    const ids = db.listSourcesForUser("u1", { sessionId }).map((s) => s.id).sort();
    expect(ids).toEqual([uploadId, sessionFileId].sort());
  });

  it("does not put another conversation's files in this one", () => {
    seedAll();
    secondSession("s2");
    expect(db.listSourcesForUser("u1", { sessionId: "s2" })).toEqual([]);
  });

  it("treats a search as text rather than as a pattern", () => {
    seedAll();
    db.createSource({
      id: "src-hat",
      userId: "u1",
      ownerKind: "session",
      ownerId: sessionId,
      origin: "session_attachment",
      storage: "upload",
      relPath: null,
      name: "100%_done.txt",
      mimeType: "text/plain",
      category: "text",
      size: 1,
      url: null,
      summary: null,
      sha256: "b".repeat(64),
    });

    // `%` typed into a search box is a character someone is looking for, not a wildcard.
    expect(db.listSourcesForUser("u1", { name: "%" }).map((s) => s.name)).toEqual(["100%_done.txt"]);
    expect(db.listSourcesForUser("u1", { name: "_" }).map((s) => s.name)).toEqual(["100%_done.txt"]);
    expect(db.listSourcesForUser("u1", { name: "lecture" }).map((s) => s.name)).toEqual([
      "lecture.pdf",
    ]);
    expect(db.listSourcesForUser("u1", { name: "nothing" })).toEqual([]);
  });
});

/**
 * The boot scan.
 *
 * Reconciliation happens when a directory is *listed*, and the source browser lists rows — so
 * without this, a file that appeared with no writer at all (cloned into a workspace, restored
 * from a backup, dropped in before the app ever saw it) is invisible in the browser until
 * somebody happens to open the file tree on that exact folder. Found by a spec, not by
 * reasoning: the browser's own e2e case seeded a file on disk and waited for a row that never
 * came.
 */
describe("scanExistingFiles", () => {
  it("registers files that no writer ever claimed", async () => {
    mkdirSync(join(workspaceWorkdir(workspaceRoot), "src"), { recursive: true });
    writeFileSync(join(workspaceWorkdir(workspaceRoot), "cloned.md"), "x");
    writeFileSync(join(workspaceWorkdir(workspaceRoot), "src", "deep.ts"), "x");

    const result = await reconcileFilesystem(db);

    expect(result.scanned).toBe(2);
    const rows = db.listSourcesForUser("u1");
    expect(rows.map((r) => r.relPath).sort()).toEqual(["cloned.md", "src/deep.ts"]);
    // `discovered`, not one of the two `agent_*` origins: nobody's tool wrote these.
    expect(rows.every((r) => r.origin === "discovered")).toBe(true);
  });

  it("registers a conversation's own files too", async () => {
    writeFileSync(join(sessionDir(workspaceRoot, sessionId), "drawn.mmd"), "graph TD");
    await reconcileFilesystem(db);

    const rows = db.listSourcesForUser("u1", { storage: "session" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ownerKind).toBe("session");
    expect(rows[0]!.category).toBe("diagram");
  });

  it("is idempotent, which is what lets it run on every listing", async () => {
    // The property that makes this a plain call rather than a cache with an invalidation
    // policy: `registerFileSource` upserts on the place, so a second walk cannot produce a
    // second row for the same file.
    writeFileSync(join(workspaceWorkdir(workspaceRoot), "a.md"), "x");
    await reconcileFilesystem(db);
    const first = db.listSourcesForUser("u1").map((r) => r.id);

    await reconcileFilesystem(db);
    expect(db.listSourcesForUser("u1").map((r) => r.id)).toEqual(first);
  });

  it("walks only the scope it was asked about", async () => {
    // A question about one workspace must not walk the account: the browser's scope filter is
    // the case, and the cost of ignoring it is every other workspace's files.
    writeFileSync(join(workspaceWorkdir(workspaceRoot), "here.md"), "x");
    const other = db.createWorkspace({
      id: "w2",
      userId: "u1",
      name: "Other",
      slug: "other",
      dirPath: join(user.workspacesRoot, "other"),
    });
    mkdirSync(workspaceWorkdir(other.dirPath), { recursive: true });
    writeFileSync(join(workspaceWorkdir(other.dirPath), "there.md"), "x");

    const result = await reconcileFilesystem(db, { workspaceId: workspaceId });
    expect(result.scanned).toBe(1);
    expect(db.listSourcesForUser("u1").map((r) => r.name)).toEqual(["here.md"]);
  });

  it("says nothing about an empty data root", async () => {
    const result = await reconcileFilesystem(db);
    expect(result.scanned).toBe(0);
    expect(result.truncated).toBe(false);
  });
});
