import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiErrorBody, DirectoryListing, WorkResource, Workspace } from "@ilearnassist/shared";
import { workspaceTrashDir } from "../src/paths.js";
import { newWorkspace, startTestServer, type TestEnv } from "./helpers/tempEnv.js";

/**
 * The file manager's writes: what a person does to a workspace's files from the browser.
 *
 * Two claims run through every case and are why this is a test file rather than a handful of
 * assertions in the read-side one. **Bytes first, rows second** — the row is what makes the file
 * a *source*, so a write that left none would produce a file the browser lists and the source
 * browser cannot name. And **the guard is the browser's own** (`files.ts`'s `resolveReal`, via
 * `fileOps.ts`), not a second one written for writes: a write that escapes a symlink does not
 * show someone a file, it overwrites it.
 *
 * The delete cases carry the third: the bytes are kept. A delete moves them to `trash/<id>/`,
 * which is a sibling of the sandbox rather than a corner of it, so the agent cannot read a file
 * the user deleted while a future restore still has something to restore.
 */

let env: TestEnv;
let workspace: Workspace;

const workdir = () => workspace.workdirPath;
const trash = () => workspaceTrashDir(workspace.dirPath);

beforeAll(async () => {
  env = await startTestServer();
  workspace = await newWorkspace(env, "管理");
});

afterAll(async () => {
  await env.cleanup();
});

function seed(name: string, contents = "x"): void {
  const path = join(workdir(), name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
}

function createDir(path: string) {
  return env.inject({
    method: "POST",
    url: `/api/workspaces/${workspace.id}/files/directory`,
    payload: { path },
  });
}

function upload(dir: string, name: string, contents = "hello", mimeType?: string) {
  return env.inject({
    method: "POST",
    url: `/api/workspaces/${workspace.id}/files/upload`,
    payload: { dir, name, mimeType, data: Buffer.from(contents).toString("base64") },
  });
}

function move(from: string, to: string) {
  return env.inject({
    method: "POST",
    url: `/api/workspaces/${workspace.id}/files/move`,
    payload: { from, to },
  });
}

function remove(path: string) {
  return env.inject({
    method: "DELETE",
    url: `/api/workspaces/${workspace.id}/files?path=${encodeURIComponent(path)}`,
  });
}

function list(path = "") {
  return env.inject({
    method: "GET",
    url: `/api/workspaces/${workspace.id}/files?path=${encodeURIComponent(path)}`,
  });
}

async function resources(): Promise<WorkResource[]> {
  return (await env.inject({ method: "GET", url: "/api/resources" })).json<WorkResource[]>();
}

/**
 * The library row for a workspace file, by the path it is listed under.
 *
 * A row is a **reference**, so its locator lives on the entity — the filter reads through
 * `resource`, and `path` is stored relative to the user root, which is why the comparison is a
 * suffix rather than an equality.
 */
async function rowFor(relPath: string): Promise<WorkResource | undefined> {
  return (await resources()).find(
    (r) => r.ownerType === "workspace" && (r.resource as { path: string }).path.endsWith(`/${relPath}`)
  );
}

describe("create a directory", () => {
  it("makes the directory and registers nothing", async () => {
    // A directory is not a file. The test is here rather than only in the file tools' file
    // because the symmetry argument — "every write leaves a row" — is one line of code away
    // from being true in both places at once.
    const before = (await resources()).length;
    const res = await createDir("reports");
    expect(res.statusCode).toBe(201);
    expect(existsSync(join(workdir(), "reports"))).toBe(true);
    expect((await resources()).length).toBe(before);
  });

  it("makes parents", async () => {
    expect((await createDir("a/b/c")).statusCode).toBe(201);
    expect(existsSync(join(workdir(), "a/b/c"))).toBe(true);
  });

  it("refuses a path that leaves the workspace", async () => {
    for (const path of ["../escape", "/etc/escape", "a/../../escape"]) {
      const res = await createDir(path);
      expect(res.statusCode, path).toBe(400);
    }
    expect(existsSync(join(workdir(), "..", "escape"))).toBe(false);
  });
});

describe("upload a file", () => {
  it("writes the bytes and leaves a row", async () => {
    const res = await upload("uploads", "notes.md", "# hello");
    expect(res.statusCode).toBe(201);

    expect(readFileSync(join(workdir(), "uploads/notes.md"), "utf8")).toBe("# hello");
    const row = await rowFor("uploads/notes.md");
    expect(row).toBeTruthy();
    const file = row!.resource as { sourceType: string; category: string; mimeType: string; size: number };
    expect(file.sourceType).toBe("upload");
    expect(file.category).toBe("markdown");
    expect(file.mimeType).toBe("text/markdown");
    expect(file.size).toBe(7);
    expect(row!.missing).toBe(false);
  });

  it("creates the directory it is aimed at", async () => {
    await upload("fresh/deeper", "a.txt", "x");
    expect(existsSync(join(workdir(), "fresh/deeper/a.txt"))).toBe(true);
  });

  it("refuses a name that is a path", async () => {
    // The directory and the name are separate fields for this reason: a name that could carry a
    // separator is how an upload lands somewhere the person did not point at.
    for (const name of ["../escape.txt", "a/b.txt", "..", "with\\slash.txt"]) {
      const res = await upload("", name);
      expect(res.statusCode, name).toBe(400);
    }
    expect(existsSync(join(workdir(), "..", "escape.txt"))).toBe(false);
  });

  it("refuses a request with nothing in it", async () => {
    const noName = await env.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.id}/files/upload`,
      payload: { dir: "", data: Buffer.from("x").toString("base64") },
    });
    expect(noName.statusCode).toBe(400);

    const noData = await env.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.id}/files/upload`,
      payload: { dir: "", name: "a.txt" },
    });
    expect(noData.statusCode).toBe(400);
  });

  it("refuses a file over the cap", async () => {
    const tooBig = Buffer.alloc(10 * 1024 * 1024 + 1, 1).toString("base64");
    const res = await env.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.id}/files/upload`,
      payload: { dir: "", name: "big.bin", data: tooBig },
    });
    expect(res.statusCode).toBe(413);
    expect((res.json() as ApiErrorBody).error.code).toBe("FILE_TOO_LARGE");
  });
});

describe("move", () => {
  it("renames a file and keeps its row", async () => {
    seed("before.txt", "content");
    const id = (await list()).json<DirectoryListing>().entries.find((e) => e.name === "before.txt")!
      .fileId;

    const res = await move("before.txt", "after.txt");
    expect(res.statusCode).toBe(200);
    expect(existsSync(join(workdir(), "before.txt"))).toBe(false);
    expect(readFileSync(join(workdir(), "after.txt"), "utf8")).toBe("content");

    const row = await rowFor("after.txt");
    // Same file id: that is what keeps every reference to it — and the message snapshots that
    // name it — attached to the file that moved.
    expect(row?.resourceId).toBe(id);
    expect(row?.title).toBe("after.txt");
  });

  it("moves a file into a directory that is not there yet", async () => {
    seed("to-move.txt");
    await move("to-move.txt", "archive/2026/to-move.txt");
    expect(existsSync(join(workdir(), "archive/2026/to-move.txt"))).toBe(true);
  });

  it("carries a directory's rows with it", async () => {
    // The half that is easy to forget: N rows move with one `rename`, and a row left naming the
    // old place is a file the browser lists twice.
    seed("tree/one.txt");
    seed("tree/deep/two.txt");
    // Reconcile so both have rows before the move: the listing is what registers a file no
    // writer claimed, and it is per directory.
    await list("tree");
    await list("tree/deep");

    const res = await move("tree", "renamed");
    expect(res.statusCode).toBe(200);
    expect(existsSync(join(workdir(), "renamed/deep/two.txt"))).toBe(true);

    expect(await rowFor("renamed/one.txt")).toBeTruthy();
    expect(await rowFor("renamed/deep/two.txt")).toBeTruthy();
    expect(await rowFor("tree/one.txt")).toBeUndefined();
    expect(await rowFor("tree/deep/two.txt")).toBeUndefined();
  });

  it("refuses to overwrite what is already there", async () => {
    seed("kept.txt", "original");
    seed("elsewhere.txt", "other");
    const res = await move("elsewhere.txt", "kept.txt");
    expect(res.statusCode).toBe(400);
    // Nothing lost: a file manager that overwrites on a collision loses work without asking.
    expect(readFileSync(join(workdir(), "kept.txt"), "utf8")).toBe("original");
    expect(readFileSync(join(workdir(), "elsewhere.txt"), "utf8")).toBe("other");
  });

  it("refuses a destination outside the sandbox", async () => {
    seed("inside.txt");
    expect((await move("inside.txt", "../outside.txt")).statusCode).toBe(400);
    expect(existsSync(join(workdir(), "inside.txt"))).toBe(true);
  });

  it("refuses to move a directory inside itself", async () => {
    seed("self/x.txt");
    expect((await move("self", "self/nested")).statusCode).toBe(400);
    expect(existsSync(join(workdir(), "self/x.txt"))).toBe(true);
  });
});

describe("delete", () => {
  it("takes the file out of the workspace and keeps the bytes", async () => {
    seed("doomed.txt", "still here");
    const id = (await list()).json<DirectoryListing>().entries.find((e) => e.name === "doomed.txt")!
      .fileId;

    expect((await remove("doomed.txt")).statusCode).toBe(200);
    expect(existsSync(join(workdir(), "doomed.txt"))).toBe(false);
    // Kept, and reachable only through the row's id — the trash directory is a sibling of the
    // sandbox, so no file tool can read what the user deleted.
    expect(readFileSync(join(trash(), id!, "doomed.txt"), "utf8")).toBe("still here");
  });

  it("hides the row from every listing", async () => {
    seed("gone.txt");
    const id = (await list()).json<DirectoryListing>().entries.find((e) => e.name === "gone.txt")!
      .fileId;
    await remove("gone.txt");

    expect((await resources()).some((r) => r.resourceId === id)).toBe(false);
  });

  it("records that the bytes went to the trash", async () => {
    /*
     * The one field that changes about a source, and the reason `storage` is a field rather than
     * a derivation: this is where a future restore would look. Read out of the table rather than
     * through an accessor, because no accessor *should* return a soft-deleted row — that every
     * scoped read filters it is the behaviour, and asserting the other half of the same write
     * from outside is what this case is for.
     */
    seed("recorded.txt");
    const id = (await list()).json<DirectoryListing>().entries.find((e) => e.name === "recorded.txt")!
      .fileId;
    await remove("recorded.txt");

    /*
     * The bytes moved and the row says so: `path` now points under the workspace's trash,
     * namespaced by the file's id so two files deleted from different directories cannot collide.
     * The deleted marker is what hides it from every reader, and the path is kept rather than
     * blanked — a restore puts the file back where it was.
     */
    const row = env.server.db.raw
      .prepare("SELECT path, deleted_at FROM files WHERE id = ?")
      .get(id) as { path: string; deleted_at: string | null };

    expect(row.path).toContain("/trash/");
    expect(row.path.endsWith("/recorded.txt")).toBe(true);
    expect(row.deleted_at).toBeTruthy();
  });

  it("frees the path for a new file of the same name", async () => {
    // The place index is filtered on `deleted_at`, which is what lets a deleted file's name be
    // used again without reviving the old row.
    seed("reuse.txt", "first");
    await remove("reuse.txt");
    await upload("", "reuse.txt", "second");

    expect(readFileSync(join(workdir(), "reuse.txt"), "utf8")).toBe("second");
    const row = await rowFor("reuse.txt");
    expect(row).toBeTruthy();
    expect((row!.resource as { size: number }).size).toBe(6);
  });

  it("removes an empty directory without touching rows", async () => {
    await createDir("emptied");
    expect((await remove("emptied")).statusCode).toBe(200);
    expect(existsSync(join(workdir(), "emptied"))).toBe(false);
  });

  it("refuses a directory with anything in it", async () => {
    // One click in a browser is not a good place to recursively destroy work nobody saw.
    seed("populated/inside.txt");
    const res = await remove("populated");
    expect(res.statusCode).toBe(400);
    expect(existsSync(join(workdir(), "populated/inside.txt"))).toBe(true);
  });

  it("refuses when nothing is there", async () => {
    expect((await remove("never-existed.txt")).statusCode).toBe(404);
  });
});

describe("the guard and the owner", () => {
  it("answers 404 for another account's workspace", async () => {
    // Both halves at once, and the reason every route resolves the owner *first*: an id that is
    // not yours and an id that does not exist have to be the same answer, or the id can be
    // probed. A write is the case where getting this wrong edits somebody else's files.
    const bob = await env.asUser("bob");

    for (const call of [
      { method: "POST" as const, url: `/api/workspaces/${workspace.id}/files/directory`, payload: { path: "nope" } },
      { method: "POST" as const, url: `/api/workspaces/${workspace.id}/files/move`, payload: { from: "a", to: "b" } },
      { method: "DELETE" as const, url: `/api/workspaces/${workspace.id}/files?path=x.txt` },
    ]) {
      expect((await bob.inject(call)).statusCode, call.url).toBe(404);
    }
    expect(existsSync(join(workdir(), "nope"))).toBe(false);
  });

  it("cannot be reached without a signed-in account", async () => {
    // The gate is deny-by-default, so a route added without a thought about auth is refused
    // rather than exposed — which is what these four would have been.
    const raw = env.server.app;
    for (const call of [
      { method: "POST" as const, url: `/api/workspaces/${workspace.id}/files/directory`, payload: { path: "nope" } },
      { method: "POST" as const, url: `/api/workspaces/${workspace.id}/files/upload`, payload: {} },
      { method: "POST" as const, url: `/api/workspaces/${workspace.id}/files/move`, payload: {} },
      { method: "DELETE" as const, url: `/api/workspaces/${workspace.id}/files?path=x.txt` },
    ]) {
      expect((await raw.inject(call)).statusCode, call.url).toBe(401);
    }
  });
});
