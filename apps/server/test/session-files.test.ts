import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiErrorBody, DirectoryListing, FileContent } from "@ilearnassist/shared";
import { sessionDir } from "../src/paths.js";
import { newSession, newWorkspace, startTestServer, type TestEnv } from "./helpers/tempEnv.js";

/**
 * A conversation's own directory, browsed.
 *
 * The claims worth testing are the ones that make this a *second root* rather than a second
 * browser: the same sandbox rules as the workspace's (`files.ts` is reused, not copied), one
 * conversation's files invisible from another, and another account's session answering 404
 * rather than someone else's directory. The last one is the whole reason every route resolves
 * through `getSessionForUser` before it touches a path.
 *
 * There is also one case here that has nothing to do with security and would otherwise be
 * found by a user: a conversation whose directory is missing. The session route makes one
 * best-effort, and the plan widget's "make a new plan" fork writes its session straight to the
 * database and never goes near that route — so "no files yet" must be an empty listing, not a
 * failure.
 */

let env: TestEnv;
let workspaceDir: string;
let sessionId: string;
/** A second conversation in the same workspace: same owner, different directory. */
let otherSessionId: string;

/** Writes a file into a conversation's directory, creating it. */
function seed(id: string, name: string, contents: string | Buffer): void {
  const dir = sessionDir(workspaceDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), contents);
}

function list(id: string, path?: string) {
  const url = `/api/sessions/${id}/files${path === undefined ? "" : `?path=${encodeURIComponent(path)}`}`;
  return env.inject({ method: "GET", url });
}

function content(id: string, path: string) {
  return env.inject({
    method: "GET",
    url: `/api/sessions/${id}/files/content?path=${encodeURIComponent(path)}`,
  });
}

beforeAll(async () => {
  env = await startTestServer();
  const workspace = await newWorkspace(env);
  workspaceDir = workspace.dirPath;
  sessionId = (await newSession(env, workspace.id)).id;
  otherSessionId = (await newSession(env, workspace.id)).id;
});

afterAll(async () => {
  await env.cleanup();
});

describe("GET /api/sessions/:id/files", () => {
  it("lists a conversation that has never been drawn in as empty", async () => {
    // Not a 404: the directory exists, so "nothing in it" is the answer — and that is what
    // the panel's empty state renders.
    const res = await list(sessionId);
    expect(res.statusCode).toBe(200);
    expect(res.json<DirectoryListing>()).toEqual({ path: "", entries: [], truncated: false });
  });

  it("makes the directory rather than failing when it is missing", async () => {
    /*
     * The reachable case, not a hypothetical: a session forked by `ila_make_plan` is written
     * straight through `db.createSession` and never passes the route that makes a directory.
     * A 404 here would put an error where the panel's empty state belongs.
     */
    const dir = sessionDir(workspaceDir, sessionId);
    rmSync(dir, { recursive: true, force: true });

    const res = await list(sessionId);
    expect(res.statusCode).toBe(200);
    expect(res.json<DirectoryListing>().entries).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  it("lists what the conversation has written", async () => {
    seed(sessionId, "flow.mmd", "flowchart TD\n  A --> B");
    seed(sessionId, "notes.md", "# notes");

    const listing = (await list(sessionId)).json<DirectoryListing>();
    expect(listing.entries.map((e) => e.name)).toEqual(["flow.mmd", "notes.md"]);
    expect(listing.entries[0]).toMatchObject({ path: "flow.mmd", type: "file" });
  });

  it("keeps one conversation's files out of another's", async () => {
    // Same workspace, same owner — the directory is per conversation, which is the whole
    // point of `sessions/<id>/` rather than a shared folder.
    expect((await list(otherSessionId)).json<DirectoryListing>().entries).toEqual([]);
  });

  it("refuses a path that escapes the conversation", async () => {
    expect((await list(sessionId, "../../../etc")).statusCode).toBe(400);
    expect((await list(sessionId, "/etc/passwd")).statusCode).toBe(400);
  });

  it("refuses a repeated path parameter as a bad request rather than a 500", async () => {
    /*
     * `?path=a&path=b` parses to an *array*, and a string operation on it is a `TypeError` —
     * which Fastify would answer with its own 500. The refusal is in `normalizeRel`, so a
     * future route cannot forget it.
     */
    const res = await env.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/files?path=a&path=b`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<ApiErrorBody>().error.code).toBe("INVALID_FILE_PATH");
  });

  it("lists an escaping symlink rather than hiding it", async () => {
    // An entry the listing silently omits is indistinguishable from one that was never
    // there — so it is shown, and the refusal happens when it is opened.
    const outside = join(env.dataRoot, "outside-session-dir");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "not yours");
    const dir = sessionDir(workspaceDir, sessionId);
    symlinkSync(join(outside, "secret.txt"), join(dir, "link.txt"));

    const listing = (await list(sessionId)).json<DirectoryListing>();
    expect(listing.entries.map((e) => e.name)).toContain("link.txt");
  });

  it("answers 404 for a session that is not there", async () => {
    expect((await list("no-such-session")).statusCode).toBe(404);
  });
});

describe("GET /api/sessions/:id/files/content", () => {
  it("returns a file's text", async () => {
    const res = await content(sessionId, "flow.mmd");
    expect(res.statusCode).toBe(200);
    expect(res.json<FileContent>()).toMatchObject({
      name: "flow.mmd",
      kind: "diagram",
      text: "flowchart TD\n  A --> B",
    });
  });

  it("refuses a symlink pointing out of the conversation", async () => {
    // The half the lexical `resolveInWorkspace` cannot see, and the reason the browser is
    // stricter than the agent's own tools: one click is enough to follow one.
    const res = await content(sessionId, "link.txt");
    expect(res.statusCode).toBe(400);
    expect(res.json<ApiErrorBody>().error.code).toBe("INVALID_FILE_PATH");
  });

  it("404s a file that is not there", async () => {
    const res = await content(sessionId, "nope.mmd");
    expect(res.statusCode).toBe(404);
    expect(res.json<ApiErrorBody>().error.code).toBe("FILE_NOT_FOUND");
  });

  it("refuses to read a directory", async () => {
    // A real subdirectory, not `"."` — that one normalizes to the empty path and is refused
    // earlier, as "a path is required" (`INVALID_FILE_PATH`). Different sentence, different
    // mistake.
    mkdirSync(join(sessionDir(workspaceDir, sessionId), "sub"), { recursive: true });

    const res = await content(sessionId, "sub");
    expect(res.statusCode).toBe(400);
    expect(res.json<ApiErrorBody>().error.code).toBe("NOT_A_FILE");
  });

  it("requires a path", async () => {
    const res = await env.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/files/content`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<ApiErrorBody>().error.code).toBe("INVALID_FILE_PATH");
  });

  it("answers 404 for a session that is not there", async () => {
    expect((await content("no-such-session", "flow.mmd")).statusCode).toBe(404);
  });
});

describe("another account's conversation", () => {
  it("answers 404, not its files", async () => {
    // "Not yours" and "does not exist" are the same answer on purpose: an id cannot be
    // probed for existence. Both routes, because a listing that leaked names would still be
    // a leak even if the content route refused.
    const other = await env.asUser("session-files-other");
    seed(sessionId, "private.mmd", "flowchart TD\n  A --> B");

    const listed = await other.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/files`,
    });
    const read = await other.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/files/content?path=private.mmd`,
    });

    expect(listed.statusCode).toBe(404);
    expect(read.statusCode).toBe(404);
    expect(listed.json<ApiErrorBody>().error.code).toBe("SESSION_NOT_FOUND");
  });
});

describe("the diagram tool's file, through the browser", () => {
  it("is what the listing shows and the content route returns", async () => {
    /*
     * The two halves joined: the tool writes, the routes read, and nothing in between keeps a
     * second copy. This is the assertion that the session directory is the record — a table
     * would be somewhere else to look and somewhere else to be wrong.
     */
    const dir = sessionDir(workspaceDir, otherSessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "架构图.mmd"), "flowchart LR\n  甲 --> 乙");

    const listing = (await list(otherSessionId)).json<DirectoryListing>();
    expect(listing.entries.map((e) => e.name)).toEqual(["架构图.mmd"]);

    const file = (await content(otherSessionId, "架构图.mmd")).json<FileContent>();
    expect(file.kind).toBe("diagram");
    expect(file.text).toBe("flowchart LR\n  甲 --> 乙");
  });
});
