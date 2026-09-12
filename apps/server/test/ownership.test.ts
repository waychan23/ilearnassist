import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type AppDb } from "../src/db.js";
import { startTestServer, type TestEnv } from "./helpers/tempEnv.js";

/**
 * The scoping rule, walked accessor by accessor with two fully-populated accounts.
 *
 * Every user-owned read takes an owner and puts it in the `WHERE`, so another account's id
 * is not a permission question to be checked — the row is simply not found. That makes the
 * failure mode specific: one accessor added without the filter, which returns another
 * person's conversation. A spot check of the two or three an author happened to think of
 * would miss exactly that one, so this file is deliberately exhaustive rather than
 * illustrative.
 *
 * HTTP is covered separately — here it is the database's own surface, which is where the
 * rule is implemented and therefore where it has to hold.
 */

let root: string;
let db: AppDb;

const ADA = "u-ada";
const BOB = "u-bob";

/** One workspace, one conversation, one message — per account, keyed by the owner's id. */
function seed(userId: string): void {
  db.createWorkspace({
    id: `w-${userId}`,
    userId,
    name: "W",
    slug: "w",
    dirPath: join(root, userId, "w"),
  });
  db.createSession({
    id: `s-${userId}`,
    workspaceId: `w-${userId}`,
    copilotId: null,
    title: "T",
  });
  db.createMessage({
    id: `m-${userId}`,
    sessionId: `s-${userId}`,
    role: "user",
    content: "hi",
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ila-own-"));
  db = createDb(join(root, "test.sqlite"));
  db.createUser({ id: ADA, username: "ada", slug: "ada" });
  db.createUser({ id: BOB, username: "bob", slug: "bob" });
  seed(ADA);
  seed(BOB);
});

afterEach(() => {
  try {
    db.raw.close();
  } catch {
    /* already closed */
  }
  rmSync(root, { recursive: true, force: true });
});

describe("workspaces", () => {
  it("lists only the caller's own", () => {
    expect(db.listWorkspaces(ADA).map((w) => w.id)).toEqual([`w-${ADA}`]);
    expect(db.listWorkspaces(BOB).map((w) => w.id)).toEqual([`w-${BOB}`]);
  });

  it("does not find another account's workspace by id", () => {
    expect(db.getWorkspaceForUser(`w-${BOB}`, ADA)).toBeUndefined();
    expect(db.getWorkspaceForUser(`w-${ADA}`, ADA)?.id).toBe(`w-${ADA}`);
  });

  it("does not rename another account's workspace", () => {
    expect(db.renameWorkspaceForUser(`w-${BOB}`, ADA, "stolen")).toBeUndefined();
    // Unchanged, which is the half that actually matters — a refused write that still wrote
    // would pass an assertion on the return value alone.
    expect(db.getWorkspaceForUser(`w-${BOB}`, BOB)?.name).toBe("W");
  });

  it("does not delete another account's workspace", () => {
    expect(db.deleteWorkspaceForUser(`w-${BOB}`, ADA)).toBe(false);
    expect(db.getWorkspaceForUser(`w-${BOB}`, BOB)).toBeDefined();
  });

  it("reports its own not-found and another's alike, so an id cannot be probed", () => {
    // Both are `undefined`. A distinguishable answer would turn id guessing into a way to
    // learn what other accounts have.
    expect(db.getWorkspaceForUser("w-nope", ADA)).toBeUndefined();
    expect(db.getWorkspaceForUser(`w-${BOB}`, ADA)).toBeUndefined();
  });
});

describe("sessions", () => {
  it("lists only the conversations in the caller's own workspace", () => {
    expect(db.listSessionsForUser(`w-${ADA}`, ADA).map((s) => s.id)).toEqual([`s-${ADA}`]);
    expect(db.listSessionsForUser(`w-${BOB}`, ADA)).toEqual([]);
  });

  it("does not find another account's conversation by id", () => {
    expect(db.getSessionForUser(`s-${BOB}`, ADA)).toBeUndefined();
    expect(db.getSessionForUser(`s-${ADA}`, ADA)?.session.id).toBe(`s-${ADA}`);
  });

  it("hands back the workspace that owns the conversation, and it is the caller's", () => {
    expect(db.getSessionForUser(`s-${ADA}`, ADA)?.workspace.id).toBe(`w-${ADA}`);
  });

  it("does not update another account's conversation", () => {
    expect(db.updateSessionForUser(`s-${BOB}`, ADA, { title: "stolen" })).toBeUndefined();
    expect(db.getSessionForUser(`s-${BOB}`, BOB)?.session.title).toBe("T");
  });

  it("does not auto-title another account's conversation", () => {
    expect(db.setAutoTitleForUser(`s-${BOB}`, ADA, "stolen")).toBeUndefined();
    expect(db.getSessionForUser(`s-${BOB}`, BOB)?.session.title).toBe("T");
  });

  it("does not delete another account's conversation", () => {
    expect(db.deleteSessionForUser(`s-${BOB}`, ADA)).toBe(false);
    expect(db.getSessionForUser(`s-${BOB}`, BOB)).toBeDefined();
  });
});

describe("messages", () => {
  it("lists only the messages in the caller's own conversation", () => {
    expect(db.listMessagesForUser(`s-${ADA}`, ADA).map((m) => m.id)).toEqual([`m-${ADA}`]);
    expect(db.listMessagesForUser(`s-${BOB}`, ADA)).toEqual([]);
  });

  it("does not find another account's message by id", () => {
    expect(db.getMessageForUser(`m-${BOB}`, ADA)).toBeUndefined();
    expect(db.getMessageForUser(`m-${ADA}`, ADA)?.id).toBe(`m-${ADA}`);
  });
});

describe("deleting an account", () => {
  it("takes its workspaces, conversations and messages with it", () => {
    // The foreign keys are what make "delete this account" a single statement rather than a
    // sweep somebody has to remember to extend. Nothing deletes accounts over HTTP yet; this
    // pins the cascade so the route that does cannot quietly leave rows behind.
    db.raw.prepare("DELETE FROM users WHERE id = ?").run(BOB);

    expect(db.listWorkspaces(BOB)).toEqual([]);
    expect(db.getSessionForUser(`s-${BOB}`, BOB)).toBeUndefined();
    expect(db.getMessageForUser(`m-${BOB}`, BOB)).toBeUndefined();
    // And the other account is untouched.
    expect(db.listWorkspaces(ADA).map((w) => w.id)).toEqual([`w-${ADA}`]);
  });
});

/**
 * The same rule over HTTP, which is where it is actually relied on.
 *
 * The database cannot enforce this on its own — it answers whatever it is asked — so the
 * layer above is what has to ask with the right owner. These go through the real routes with
 * two real sessions, because "the accessor is scoped" and "the route passes the right id" are
 * different claims and only the second one is the promise.
 */
describe("over HTTP, with two signed-in accounts", () => {
  let env: TestEnv | undefined;

  afterEach(async () => {
    await env?.cleanup();
    env = undefined;
  });

  /** A workspace and a conversation in it, owned by `who`. */
  async function seedFor(who: { inject: TestEnv["inject"] }): Promise<{ workspaceId: string; sessionId: string }> {
    const workspace = await who
      .inject({ method: "POST", url: "/api/workspaces", payload: { name: "Mine" } })
      .then((r) => r.json<{ id: string }>());
    const session = await who
      .inject({ method: "POST", url: `/api/workspaces/${workspace.id}/sessions`, payload: {} })
      .then((r) => r.json<{ id: string }>());
    return { workspaceId: workspace.id, sessionId: session.id };
  }

  it("does not see another account's workspace in a listing", async () => {
    env = await startTestServer({ username: "Ada" });
    const bob = await env.asUser("Bob");
    const theirs = await seedFor(bob);

    const mine = await env.inject({ method: "GET", url: "/api/workspaces" });
    expect(mine.json<{ id: string }[]>().map((w) => w.id)).not.toContain(theirs.workspaceId);
  });

  it("answers 404 — not 403 — for another account's ids", async () => {
    // The same answer as a made-up id. A 403 would confirm the row exists, which turns id
    // guessing into a way to learn what other accounts have.
    env = await startTestServer({ username: "Ada" });
    const bob = await env.asUser("Bob");
    const theirs = await seedFor(bob);

    const attempts = [
      ["GET", `/api/workspaces/${theirs.workspaceId}/files`],
      ["GET", `/api/workspaces/${theirs.workspaceId}/sessions`],
      ["PATCH", `/api/workspaces/${theirs.workspaceId}`],
      ["DELETE", `/api/workspaces/${theirs.workspaceId}`],
      ["GET", `/api/sessions/${theirs.sessionId}/messages`],
      ["PATCH", `/api/sessions/${theirs.sessionId}`],
      ["DELETE", `/api/sessions/${theirs.sessionId}`],
      ["GET", `/api/sessions/${theirs.sessionId}/sources`],
      // Reaches a process-local map of running turns, so if the `ForUser` read in front of
      // it were dropped, an id guess would end someone else's generation.
      ["POST", `/api/sessions/${theirs.sessionId}/stop`],
    ] as const;

    for (const [method, url] of attempts) {
      const res = await env.inject({ method, url, payload: method === "GET" ? undefined : {} });
      expect([url, res.statusCode]).toEqual([url, 404]);
      // And it is their row that survives, which the status alone would not prove.
      const stillThere = await bob.inject({ method: "GET", url: `/api/workspaces/${theirs.workspaceId}/files` });
      expect(stillThere.statusCode).toBe(200);
    }
  });

  it("does not read another account's files through the browser", async () => {
    // The workspace is real and its `workdir/` exists on disk, so a leak here would be a
    // *path* leak rather than a missing-directory error — which is the case worth testing.
    env = await startTestServer({ username: "Ada" });
    const bob = await env.asUser("Bob");
    const theirs = await seedFor(bob);

    const res = await env.inject({
      method: "GET",
      url: `/api/workspaces/${theirs.workspaceId}/files`,
    });
    expect(res.statusCode).toBe(404);

    // The owner's browser, on the same workspace, still works.
    expect(
      (await bob.inject({ method: "GET", url: `/api/workspaces/${theirs.workspaceId}/files` }))
        .statusCode
    ).toBe(200);
  });
});
