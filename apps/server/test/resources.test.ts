import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SESSION_TITLE, createDb } from "../src/db.js";
import type { AppDb } from "../src/db.js";
import {
  ensureWorkResource,
  reconcileListing,
  registerFile,
  renameFile,
  renameFileSubtree,
  sessionFilePath,
  workspaceFilePath,
} from "../src/resources.js";

/**
 * The registry: an entity, and a reference to it.
 *
 * Three claims, and the first is the one the whole model turns on:
 *
 * 1. **`registerFile` never makes a file referenceable.** That is not an omission — it is what
 *    keeps a diagram's `.mmd` and a document's extracted text out of the library, and it is the
 *    reason the two writes are two functions rather than one.
 * 2. **The three identities hold.** Two files cannot share a path while both are live, identical
 *    user-supplied bytes are one file, one owner cannot reference the same entity twice, and two
 *    owners can.
 * 3. **Reconciliation makes what it finds usable and leaves what it did not find alone.** A
 *    dropped-in file becomes referenceable; a file whose writer decided otherwise keeps that
 *    decision.
 */

let root: string;
let db: AppDb;

const USER = "u1";
const OTHER = "u2";
const WS = "wA";
const SESSION = "s1";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gl-resources-"));
  db = createDb(join(root, "test.sqlite"));
  db.createUser({ id: USER, username: "tester", slug: "tester" });
  db.createUser({ id: OTHER, username: "other", slug: "other" });
  db.createWorkspace({ userId: USER, id: WS, name: "A", slug: "a", dirPath: join(root, "a") });
  db.createSession({
    id: SESSION,
    workspaceId: WS,
    copilotId: null,
    copilotName: "",
    systemPrompt: "",
    allTools: true,
    tools: [],
    title: DEFAULT_SESSION_TITLE,
  });
});

afterEach(() => {
  try {
    db.raw.close();
  } catch {
    /* already closed */
  }
  rmSync(root, { recursive: true, force: true });
});

/** A file row, the way a writer that does not want a reference makes one. */
function file(path: string, over: Partial<Parameters<typeof registerFile>[1]> = {}) {
  return registerFile(db, { userId: USER, path, sourceType: "agent_create", size: 1, ...over });
}

describe("registerFile", () => {
  it("makes no work resource", () => {
    const stored = file(workspaceFilePath("a", "flow.mmd"));
    expect(db.listWorkResourcesForResource(USER, "file", stored.id)).toEqual([]);
  });

  it("keeps the id across a re-register, so a reference survives a rewrite", () => {
    const first = file(workspaceFilePath("a", "a.md"), { size: 1 });
    const second = file(workspaceFilePath("a", "a.md"), { size: 99 });
    expect(second.id).toBe(first.id);
    expect(second.size).toBe(99);
  });

  it("does not reset a title the caller did not name", () => {
    // The reconcile path passes no title, and the fallback would otherwise rename an export
    // back to its filename on nothing more than somebody opening the library.
    const first = file(workspaceFilePath("a", "a.md"), { title: "Week one notes" });
    const second = file(workspaceFilePath("a", "a.md"));
    expect(second.title).toBe("Week one notes");
  });

  it("refuses to hand a foreign row back", () => {
    const mine = file(workspaceFilePath("a", "a.md"));
    expect(db.getFileForUser(OTHER, mine.id)).toBeUndefined();
  });
});

describe("ensureWorkResource", () => {
  it("is idempotent on owner and entity", () => {
    const stored = file(workspaceFilePath("a", "a.md"));
    const first = ensureWorkResource(db, {
      userId: USER,
      owner: { kind: "workspace", id: WS },
      resourceType: "file",
      resourceId: stored.id,
      title: stored.title,
    });
    const second = ensureWorkResource(db, {
      userId: USER,
      owner: { kind: "workspace", id: WS },
      resourceType: "file",
      resourceId: stored.id,
      title: stored.title,
    });
    expect(first?.id).toBe(second?.id);
    expect(db.listWorkResourcesForResource(USER, "file", stored.id)).toHaveLength(1);
  });

  it("lets two owners reference one file, which is the whole point of the split", () => {
    const stored = file(workspaceFilePath("a", "a.md"));
    for (const owner of [
      { kind: "workspace" as const, id: WS },
      { kind: "session" as const, id: SESSION },
    ]) {
      ensureWorkResource(db, {
        userId: USER,
        owner,
        resourceType: "file",
        resourceId: stored.id,
        title: stored.title,
      });
    }
    expect(db.listWorkResourcesForResource(USER, "file", stored.id)).toHaveLength(2);
    // And it is still *one* file — that is what decoupling buys.
    expect(db.getFileForUser(USER, stored.id)?.id).toBe(stored.id);
  });

  it("refuses another account's entity, rather than making a row pointing at it", () => {
    const theirs = file(workspaceFilePath("a", "a.md"), { userId: OTHER });
    const made = ensureWorkResource(db, {
      userId: USER,
      owner: { kind: "workspace", id: WS },
      resourceType: "file",
      resourceId: theirs.id,
      title: "not mine",
    });
    expect(made).toBeUndefined();
  });

  it("refuses an entity that is not there at all", () => {
    expect(
      ensureWorkResource(db, {
        userId: USER,
        owner: { kind: "workspace", id: WS },
        resourceType: "file",
        resourceId: "nope",
        title: "ghost",
      })
    ).toBeUndefined();
  });

  it("hides a reference whose entity has been deleted", () => {
    /*
     * Deletes never dismantle: the reference row stays and the file is marked gone. A read that
     * returned the reference anyway would hand the library a row about nothing, which is why
     * both listing and single reads drop it instead.
     */
    const stored = file(workspaceFilePath("a", "a.md"));
    const ref = ensureWorkResource(db, {
      userId: USER,
      owner: { kind: "workspace", id: WS },
      resourceType: "file",
      resourceId: stored.id,
      title: stored.title,
    })!;
    db.softDeleteFileForUser(stored.id, USER);
    expect(db.getWorkResourceForUser(USER, ref.id)).toBeUndefined();
    expect(db.listWorkResourcesFiltered(USER, {})).toEqual([]);
  });
});

describe("a conversation-scoped listing", () => {
  /** A second conversation in the same workspace, which is what several holders need. */
  const OTHER_SESSION = "s2";
  beforeEach(() => {
    db.createSession({
      id: OTHER_SESSION,
      workspaceId: WS,
      copilotId: null,
      copilotName: "",
      systemPrompt: "",
      allTools: true,
      tools: [],
      title: DEFAULT_SESSION_TITLE,
    });
  });

  /** Hold `entity` for each owner given, in order — the rows a listing has to choose between. */
  function hold(owner: { kind: "workspace" | "session"; id: string }, resourceId: string) {
    return ensureWorkResource(db, {
      userId: USER,
      owner,
      resourceType: "file",
      resourceId,
      title: "mindmap.png",
    })!;
  }

  it("lists the row a link names, and not the other holders of the same file", () => {
    /*
     * **The reported bug, and the fix that is a model change rather than a filter.** An image
     * uploaded into a workspace and then again from two conversations is one file with three
     * holders; a fourth conversation that merely *referred* to it listed all three — three
     * identical rows in 参考资料 — because a link named the *entity* and this arm therefore
     * matched every holder of it.
     *
     * A link names a reference now, so the arm returns that row and nothing else. No dedupe is
     * involved, and none is wanted: two links to two different holders are two rows, because they
     * are two references and the user chose each of them.
     */
    const row = file("workspaces/a/workdir/mindmap.png", { sourceType: "upload" });
    const theirs = hold({ kind: "workspace", id: WS }, row.id);
    hold({ kind: "session", id: OTHER_SESSION }, row.id);
    db.addSessionReference({ id: "sref-1", sessionId: SESSION, workResourceId: theirs.id });

    const listed = db.listWorkResourcesFiltered(USER, { sessionId: SESSION });
    expect(listed.map((r) => r.id)).toEqual([theirs.id]);

    /*
     * And the library — unscoped — still answers with one row per reference, which is not a leak
     * of the same bug: each of those rows is a thing its owner can be rid of on its own, and the
     * delete acts on the reference it was pressed on.
     */
    expect(db.listWorkResourcesFiltered(USER, {})).toHaveLength(2);
  });

  it("keeps a dangling link out of the answer, which is how it reports itself", () => {
    // A link whose reference was deleted resolves to nothing: that *omission* is the report, and
    // it is why nothing has to sweep links when material goes.
    const row = file("workspaces/a/workdir/mindmap.png", { sourceType: "upload" });
    const theirs = hold({ kind: "workspace", id: WS }, row.id);
    db.addSessionReference({ id: "sref-1", sessionId: SESSION, workResourceId: theirs.id });
    expect(db.listWorkResourcesFiltered(USER, { sessionId: SESSION })).toHaveLength(1);

    db.softDeleteWorkResourceForUser(theirs.id, USER);
    expect(db.listWorkResourcesFiltered(USER, { sessionId: SESSION })).toEqual([]);
  });

  it("still lists what the conversation holds, which is the other half of the arm", () => {
    // The arm the listing has always had. Its own workspace's material is deliberately *not*
    // here — that is the read whitelist's wider question, and the panel's narrower one.
    const owned = file("workspaces/a/workdir/notes.md", { sourceType: "upload" });
    const mine = hold({ kind: "session", id: SESSION }, owned.id);

    const ids = db.listWorkResourcesFiltered(USER, { sessionId: SESSION }).map((r) => r.id);
    expect(ids).toEqual([mine.id]);
  });
});

describe("counting who holds a file", () => {
  it("counts every live reference to one entity, whatever owns it", () => {
    /*
     * The library's delete asks this before it destroys anything: deleting a workspace file takes
     * the shared `files` row with it, so every conversation pointing at that file loses it. The
     * count is what lets the dialog say how many, and it has to be about the **entity** rather
     * than the owner — "does this owner hold it" is true of every row it would be asked about.
     */
    const row = file("workspaces/a/workdir/notes.md");
    for (const owner of [
      { kind: "workspace" as const, id: WS },
      { kind: "session" as const, id: SESSION },
    ]) {
      ensureWorkResource(db, {
        userId: USER,
        owner,
        resourceType: "file",
        resourceId: row.id,
        title: "notes.md",
      });
    }

    const counts = db.countReferencesForEntities(USER, "file", [row.id]);
    expect(counts.get(row.id)).toBe(2);
    // A file nobody holds is absent from the map rather than zero — the caller's `?? 2` treats
    // unknown as "somebody might", and a zero would read as an answer.
    expect(counts.get("no-such-file")).toBeUndefined();
  });

  it("does not count a reference somebody deleted", () => {
    // A deleted reference is not a second copy of anything, and counting one would make the
    // dialog warn about a holder that is not there.
    const row = file("workspaces/a/workdir/notes.md");
    const held = [
      ensureWorkResource(db, {
        userId: USER,
        owner: { kind: "workspace", id: WS },
        resourceType: "file",
        resourceId: row.id,
        title: "notes.md",
      })!,
      ensureWorkResource(db, {
        userId: USER,
        owner: { kind: "session", id: SESSION },
        resourceType: "file",
        resourceId: row.id,
        title: "notes.md",
      })!,
    ];
    db.softDeleteWorkResourceForUser(held[1]!.id, USER);

    expect(db.countReferencesForEntities(USER, "file", [row.id]).get(row.id)).toBe(1);
  });

  it("counts a conversation that only points at the file, through the reference it names", () => {
    /*
     * Both relations, because the number is what the delete dialog says out loud: a conversation
     * that merely *refers* to the file loses it when the material goes — its link stays and starts
     * reporting the object is gone — so counting holdings alone would answer "nobody else is
     * working from this" about material two panels were built around.
     *
     * The link names a *reference*, so the count reaches the entity through it. That join is the
     * whole implementation of "this conversation is about that file".
     */
    const row = file("workspaces/a/workdir/notes.md");
    const held = ensureWorkResource(db, {
      userId: USER,
      owner: { kind: "workspace", id: WS },
      resourceType: "file",
      resourceId: row.id,
      title: "notes.md",
    })!;
    db.addSessionReference({ id: "sref-1", sessionId: SESSION, workResourceId: held.id });

    expect(db.countReferencesForEntities(USER, "file", [row.id]).get(row.id)).toBe(2);
  });

  it("never counts another account's references", () => {
    const row = file("workspaces/a/workdir/notes.md");
    ensureWorkResource(db, {
      userId: USER,
      owner: { kind: "workspace", id: WS },
      resourceType: "file",
      resourceId: row.id,
      title: "notes.md",
    });

    expect(db.countReferencesForEntities(OTHER, "file", [row.id]).size).toBe(0);
  });
});

describe("the three identities", () => {
  it("will not let two live files share a path", () => {
    file(workspaceFilePath("a", "a.md"));
    // A *second* row at the same path is what the unique index refuses. `registerFile` upserts
    // instead, so the constraint is asserted through the raw statement it protects.
    expect(() =>
      db.createFile({
        id: "f2",
        userId: USER,
        sourceType: "agent_create",
        title: "a.md",
        path: workspaceFilePath("a", "a.md"),
        mimeType: "text/markdown",
        category: "markdown",
        size: 1,
      })
    ).toThrow(/UNIQUE/i);
  });

  it("lets a new file take a path a deleted one vacated", () => {
    const first = file(workspaceFilePath("a", "a.md"));
    db.softDeleteFileForUser(first.id, USER);
    const second = file(workspaceFilePath("a", "a.md"), { sourceType: "upload" });
    expect(second.id).not.toBe(first.id);
  });

  it("treats identical user-supplied bytes as one file, and revives a deleted one", () => {
    const hash = "a".repeat(64);
    const first = file("sources/raw/f1.pdf", { sourceType: "upload", sha256: hash });
    expect(db.findFileByHash(USER, hash)?.id).toBe(first.id);

    db.softDeleteFileForUser(first.id, USER);
    expect(db.findFileByHash(USER, hash)).toBeUndefined();
    // The deleted twin is what a re-upload revives rather than inserting beside.
    expect(db.findDeletedFileByHash(USER, hash)?.id).toBe(first.id);
    expect(db.reviveFileForUser(first.id, USER)?.id).toBe(first.id);
  });

  it("lets two byte-identical parse results both insert", () => {
    /*
     * The case the narrowed index exists for, and it is not hypothetical: two different
     * documents whose extracted text comes out byte-identical (two empty scans, the same page
     * rendered twice) are two files, and a table-wide `(user_id, sha256)` would refuse the
     * second with a UNIQUE violation — a parse dying with nothing in the error to say the two
     * rows were never the same thing.
     */
    const same = "b".repeat(64);
    const one = file("sources/parsed/r1.txt", { sha256: same, sourceType: "agent_create" });
    const two = file("sources/parsed/r2.txt", { sha256: same, sourceType: "agent_create" });
    expect(one.id).not.toBe(two.id);
  });
});

describe("reconciliation", () => {
  it("makes a file it discovers referenceable", () => {
    const ids = reconcileListing(db, {
      userId: USER,
      owner: { kind: "workspace", id: WS },
      pathFor: (rel) => workspaceFilePath("a", rel),
      entries: [{ type: "file", path: "dropped.md", size: 3 }],
    });
    const id = ids.get("dropped.md")!;
    expect(db.getFileForUser(USER, id)?.sourceType).toBe("discovered");
    expect(db.listWorkResourcesForResource(USER, "file", id)).toHaveLength(1);
  });

  it("leaves a file that already has a row exactly as its writer left it", () => {
    /*
     * The rule the whole walk is built around. A diagram registers its `.mmd` without a work
     * resource on purpose; a reconcile that gave every file it saw one would put the drawing in
     * the library the first time somebody opened it.
     */
    const diagram = file(sessionFilePath("a", SESSION, "flow.mmd"), { title: "A flow" });

    const ids = reconcileListing(db, {
      userId: USER,
      owner: { kind: "session", id: SESSION },
      pathFor: (rel) => sessionFilePath("a", SESSION, rel),
      entries: [{ type: "file", path: "flow.mmd", size: 1 }],
    });

    // The entry is the file the diagram already registered, so the walk links to it and adds
    // nothing — the drawing stays out of the library.
    expect(ids.get("flow.mmd")).toBe(diagram.id);
    expect(db.listWorkResourcesForResource(USER, "file", diagram.id)).toEqual([]);
  });

  it("ignores directories", () => {
    const ids = reconcileListing(db, {
      userId: USER,
      owner: { kind: "workspace", id: WS },
      pathFor: (rel) => workspaceFilePath("a", rel),
      entries: [
        { type: "directory", path: "node_modules" },
        { type: "file", path: "a.md" },
      ],
    });
    expect([...ids.keys()]).toEqual(["a.md"]);
  });
});

describe("renaming", () => {
  it("keeps the id, and with it every reference", () => {
    const stored = file(workspaceFilePath("a", "old.md"));
    const ref = ensureWorkResource(db, {
      userId: USER,
      owner: { kind: "workspace", id: WS },
      resourceType: "file",
      resourceId: stored.id,
      title: stored.title,
    })!;

    expect(
      renameFile(db, {
        userId: USER,
        from: workspaceFilePath("a", "old.md"),
        to: workspaceFilePath("a", "new.md"),
      })
    ).toBe(true);

    // The reference is untouched and still resolves — the file moved, it was not replaced.
    expect(db.getWorkResourceForUser(USER, ref.id)?.resourceId).toBe(stored.id);
    expect(db.getFileForUser(USER, stored.id)?.path).toBe(workspaceFilePath("a", "new.md"));
  });

  it("moves a whole subtree in one go", () => {
    file(workspaceFilePath("a", "notes/one.md"));
    file(workspaceFilePath("a", "notes/two.md"));
    file(workspaceFilePath("a", "other.md"));

    const moved = renameFileSubtree(db, {
      userId: USER,
      from: workspaceFilePath("a", "notes"),
      to: workspaceFilePath("a", "archive"),
    });

    expect(moved).toBe(2);
    expect(db.getFileByPath(USER, workspaceFilePath("a", "archive/one.md"))).toBeDefined();
    expect(db.getFileByPath(USER, workspaceFilePath("a", "archive/two.md"))).toBeDefined();
    expect(db.getFileByPath(USER, workspaceFilePath("a", "other.md"))).toBeDefined();
  });

  it("answers false when there was nothing at the old path", () => {
    expect(
      renameFile(db, { userId: USER, from: workspaceFilePath("a", "nope.md"), to: "x.md" })
    ).toBe(false);
  });
});
