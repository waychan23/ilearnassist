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

/**
 * One workspace, one Copilot, one conversation, one message — per account, keyed by owner id.
 *
 * The Copilot is private, so it is the thing an account must never see through another's eyes;
 * the tests that need a *public* one publish it themselves.
 */
function seed(userId: string): void {
  db.createWorkspace({
    id: `w-${userId}`,
    userId,
    name: "W",
    slug: "w",
    dirPath: join(root, userId, "w"),
  });
  addCopilot(`c-${userId}`, userId, "private");
  db.createSession({
    id: `s-${userId}`,
    workspaceId: `w-${userId}`,
    copilotId: null,
    copilotName: "",
    systemPrompt: "",
    allTools: true,
    tools: [],
    title: "T",
  });
  db.createMessage({
    id: `m-${userId}`,
    sessionId: `s-${userId}`,
    role: "user",
    content: "hi",
  });
  db.createNote({
    id: `n-${userId}`,
    sessionId: `s-${userId}`,
    messageId: `m-${userId}`,
    type: "annotation",
    quote: "hi",
    occurrence: 0,
    content: `${userId}'s own`,
  });
}

function addCopilot(id: string, userId: string, visibility: "private" | "public"): void {
  db.createCopilot({
    id,
    userId,
    name: id,
    description: "",
    systemPrompt: `prompt of ${id}`,
    // A restriction on purpose: it is the field whose loss would go unnoticed, because
    // "no restriction" is the wider state and the one a default lands on.
    allTools: false,
    tools: ["read_file"],
    settings: { temperature: 0.2 },
    widgets: ["session_stats"],
    visibility,
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
    expect(db.softDeleteWorkspaceForUser(`w-${BOB}`, ADA)).toBe(false);
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
    expect(db.softDeleteSessionForUser(`s-${BOB}`, ADA)).toBe(false);
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

/**
 * Copilots are the one table with a *two-sided* rule, which is why it needs its own block.
 *
 * "Owned" would be too simple — a published Copilot is deliberately usable by accounts that do
 * not own it. So the reads take the wider predicate (own, or public) and the writes take the
 * narrower one (own only), and every case below is one half of that asymmetry.
 */
describe("copilots", () => {
  it("lists the caller's own plus every public one, and not another account's private", () => {
    addCopilot("c-bob-public", BOB, "public");

    expect(db.listCopilotsForUser(ADA).map((c) => c.id).sort()).toEqual(
      [`c-${ADA}`, "c-bob-public"].sort()
    );
    // Named separately from the equality above because this is the assertion that matters: a
    // listing that returned everything would fail it while looking perfectly plausible.
    expect(db.listCopilotsForUser(ADA).map((c) => c.id)).not.toContain(`c-${BOB}`);
  });

  it("lets an account use a public Copilot it does not own, and not a private one", () => {
    addCopilot("c-bob-public", BOB, "public");

    expect(db.getCopilotForUser("c-bob-public", ADA)?.id).toBe("c-bob-public");
    expect(db.getCopilotForUser(`c-${BOB}`, ADA)).toBeUndefined();
    expect(db.getCopilotForUser(`c-${BOB}`, BOB)?.id).toBe(`c-${BOB}`);
  });

  it("hands an ownerless Copilot to nobody, even a public one", () => {
    /*
     * `user_id` is nullable so the column could be added to older databases without a default
     * (see `schema.ts`). The price of that is paid here: a row whose owner is gone must match no
     * read at all rather than being offered to whoever asks.
     *
     * `public` on purpose. The disjunction alone would still return it — `visibility = 'public'`
     * is true however absent the owner is — so a private orphan would pass this test against an
     * unfixed predicate. Marking it public is what makes the assertion about the guard.
     */
    addCopilot("c-orphan", BOB, "public");
    db.raw.prepare("UPDATE copilots SET user_id = NULL WHERE id = ?").run("c-orphan");

    expect(db.getCopilotForUser("c-orphan", ADA)).toBeUndefined();
    expect(db.getCopilotForUser("c-orphan", BOB)).toBeUndefined();
    expect(db.listCopilotsForUser(ADA).map((c) => c.id)).not.toContain("c-orphan");
  });

  it("does not let an account edit or delete a public Copilot it does not own", () => {
    addCopilot("c-bob-public", BOB, "public");

    expect(
      db.updateCopilotForUser("c-bob-public", ADA, {
        name: "stolen",
        description: "",
        systemPrompt: "stolen",
        allTools: true,
        tools: [],
        settings: {},
        widgets: [],
        visibility: "private",
      })
    ).toBeUndefined();
    expect(db.softDeleteCopilotForUser("c-bob-public", ADA)).toBe(false);

    // Unchanged, which is the half that actually matters: a refused write that still wrote
    // would pass an assertion on the return value alone.
    expect(db.getOwnedCopilot("c-bob-public", BOB)).toMatchObject({
      name: "c-bob-public",
      systemPrompt: "prompt of c-bob-public",
      tools: ["read_file"],
      visibility: "public",
    });
  });

  it("reports its own not-found and another's alike, so an id cannot be probed", () => {
    expect(db.getCopilotForUser("c-nope", ADA)).toBeUndefined();
    expect(db.getCopilotForUser("c-bob", ADA)).toBeUndefined();
    expect(db.getOwnedCopilot("c-bob", ADA)).toBeUndefined();
  });

  it("takes an account's Copilots with it when the account goes", () => {
    addCopilot("c-bob-public", BOB, "public");
    db.raw.prepare("DELETE FROM users WHERE id = ?").run(BOB);

    expect(db.getOwnedCopilot(`c-${BOB}`, BOB)).toBeUndefined();
    expect(db.listCopilotsForUser(ADA).map((c) => c.id)).toEqual([`c-${ADA}`]);
  });
});

describe("widgets", () => {
  it("does not see another account's installs", () => {
    /*
     * The read resolves every widget the registry knows, so a foreign id does not come back
     * empty — it comes back as the **defaults**, which is the same answer an unwidgetted
     * workspace gives. That is the right shape for this layer (the route refuses the id with a
     * 404 before asking), and the thing worth pinning is that nothing Bob *decided* leaks:
     * `enabled` stays false everywhere for Ada.
     */
    db.setWorkspaceWidgetForUser(BOB, `w-${BOB}`, "workspace_stats", true);
    db.setSessionWidgetForUser(BOB, `s-${BOB}`, "session_stats", true);

    expect(db.listWorkspaceWidgetsForUser(ADA, `w-${BOB}`).every((w) => !w.enabled)).toBe(true);
    expect(db.listSessionWidgetsForUser(ADA, `s-${BOB}`).every((w) => !w.enabled)).toBe(true);

    // And the owner still has them, so the assertions above are about scoping rather than
    // about the writes having failed.
    expect(db.listWorkspaceWidgetsForUser(BOB, `w-${BOB}`)).toEqual([
      { id: "workspace_stats", scope: "workspace", enabled: true },
    ]);
  });

  it("does not install or uninstall on another account's object", () => {
    expect(db.setWorkspaceWidgetForUser(ADA, `w-${BOB}`, "workspace_stats", true)).toBe(false);
    expect(db.setSessionWidgetForUser(ADA, `s-${BOB}`, "session_stats", true)).toBe(false);

    // Unchanged, which is the half that matters: a refused write that still wrote would pass an
    // assertion on the return value alone.
    expect(db.listWorkspaceWidgetsForUser(BOB, `w-${BOB}`).every((w) => !w.enabled)).toBe(true);
    expect(db.listSessionWidgetsForUser(BOB, `s-${BOB}`).every((w) => !w.enabled)).toBe(true);
  });

  it("does not read another account's statistics", () => {
    expect(db.statsForWorkspace(ADA, `w-${BOB}`)).toBeUndefined();
    expect(db.statsForSessionForUser(ADA, `s-${BOB}`)).toBeUndefined();

    // The owner's own, on the same rows, still resolves — so this is scoping and not a query
    // that happens to return nothing.
    expect(db.statsForWorkspace(BOB, `w-${BOB}`)?.sessions.map((s) => s.sessionId)).toEqual([
      `s-${BOB}`,
    ]);
  });
});

describe("notes", () => {
  it("lists only the caller's own conversation's notes", () => {
    expect(db.listNotesForUser(ADA, `s-${BOB}`)).toEqual([]);
    expect(db.listNotesForUser(BOB, `s-${BOB}`).map((n) => n.id)).toEqual([`n-${BOB}`]);
  });

  it("does not find another account's note by id", () => {
    expect(db.getNoteForUser(ADA, `s-${BOB}`, `n-${BOB}`)).toBeUndefined();
    expect(db.getNoteForUser(ADA, `s-${ADA}`, "n-nope")).toBeUndefined();
  });

  it("does not reach a note through another conversation's id", () => {
    /*
     * `updateNote`/`softDeleteNote` take a bare session id, the documented shape for an
     * accessor every caller reaches after a `ForUser` read has resolved the session. The
     * session id in the WHERE is therefore the scoping that matters here — it is what keeps a
     * note id from one conversation out of another conversation's route, which the owner
     * check upstream cannot see.
     */
    expect(db.updateNote(`s-${ADA}`, `n-${BOB}`, { content: "stolen" })).toBeUndefined();
    expect(db.softDeleteNote(`s-${ADA}`, `n-${BOB}`)).toBe(false);

    // Unchanged, which is the half that matters: a refused write that still wrote would pass
    // an assertion on the return value alone.
    expect(db.getNoteForUser(BOB, `s-${BOB}`, `n-${BOB}`)?.content).toBe(`${BOB}'s own`);
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

  /** A workspace, a private Copilot and a conversation, all owned by `who`. */
  async function seedFor(
    who: { inject: TestEnv["inject"] }
  ): Promise<{ workspaceId: string; sessionId: string; copilotId: string }> {
    const workspace = await who
      .inject({ method: "POST", url: "/api/workspaces", payload: { name: "Mine" } })
      .then((r) => r.json<{ id: string }>());
    const copilot = await who
      .inject({
        method: "POST",
        url: "/api/copilots",
        payload: {
          name: "Theirs",
          systemPrompt: "their private persona",
          allTools: false,
          tools: ["read_file"],
        },
      })
      .then((r) => r.json<{ id: string }>());
    const session = await who
      .inject({ method: "POST", url: `/api/workspaces/${workspace.id}/sessions`, payload: {} })
      .then((r) => r.json<{ id: string }>());
    return { workspaceId: workspace.id, sessionId: session.id, copilotId: copilot.id };
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
      // A Copilot someone else published is usable but not editable; a private one is neither,
      // and to a caller that does not own it the two are indistinguishable.
      ["PUT", `/api/copilots/${theirs.copilotId}`],
      ["DELETE", `/api/copilots/${theirs.copilotId}`],
    ] as const;

    for (const [method, url] of attempts) {
      const res = await env.inject({ method, url, payload: method === "GET" ? undefined : {} });
      expect([url, res.statusCode]).toEqual([url, 404]);
      // And it is their row that survives, which the status alone would not prove.
      const stillThere = await bob.inject({ method: "GET", url: `/api/workspaces/${theirs.workspaceId}/files` });
      expect(stillThere.statusCode).toBe(200);
    }
  });

  it("tells the creator a Copilot is theirs, by an id that matches their account", async () => {
    /*
     * The client splits the list into "mine" and "published by someone else" by comparing
     * `copilot.userId` with the id `/auth/me` gave it, so those two have to be the same id — and
     * an owner must never be shown the read-only view of their own Copilot. Asserted over HTTP
     * rather than at the db, because it is the *wire* shape the client reads.
     */
    env = await startTestServer({ username: "Ada" });

    const created = (
      await env.inject({
        method: "POST",
        url: "/api/copilots",
        payload: { name: "Mine", systemPrompt: "" },
      })
    ).json<{ id: string; userId: string }>();
    const me = (await env.inject({ method: "GET", url: "/api/auth/me" })).json<{ id: string }>();

    expect(me.id).toBeTruthy();
    expect(created.userId).toBe(me.id);

    const bob = await env.asUser("Bob");
    await seedFor(bob); // one of Bob's too, so the listing is not all one account's

    const listed = (await env.inject({ method: "GET", url: "/api/copilots" })).json<
      { id: string; userId: string }[]
    >();
    expect(listed.find((c) => c.id === created.id)?.userId).toBe(me.id);

    /*
     * And every row that reaches the client carries an owner. The client decides "may I edit
     * this" by comparing `userId` with its own account id, so a row that arrived without one
     * would be handed to its owner as somebody else's Copilot — read-only, with a "copy to
     * mine" button. That is the shape of an ownerless row, which is why the column being
     * nullable must not mean a row can be *served* without it.
     */
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.every((c) => !!c.userId)).toBe(true);
  });

  it("refuses to start a conversation from another account's private Copilot", async () => {
    /*
     * The regression this whole change exists for. A Copilot id arriving on a session-create was
     * looked up unscoped, and the prompt was then read live on every turn — so this one request
     * was enough to have another account's persona, and its tool allowlist, drive a conversation
     * the caller owned. Refused rather than dropped: a silently Copilotless session would look
     * exactly like success.
     */
    env = await startTestServer({ username: "Ada" });
    const bob = await env.asUser("Bob");
    const theirs = await seedFor(bob);
    const mine = await seedFor(env);

    const res = await env.inject({
      method: "POST",
      url: `/api/workspaces/${mine.workspaceId}/sessions`,
      payload: { copilotId: theirs.copilotId },
    });

    expect(res.statusCode).toBe(404);
    // And no session was created as a side effect of the refusal.
    expect((await env.inject({ method: "GET", url: `/api/workspaces/${mine.workspaceId}/sessions` }))
      .json<{ id: string }[]>().length).toBe(1);
  });

  it("starts a conversation from a public Copilot it does not own, copying it in", async () => {
    env = await startTestServer({ username: "Ada" });
    const bob = await env.asUser("Bob");
    const theirs = await seedFor(bob);
    await bob.inject({
      method: "PUT",
      url: `/api/copilots/${theirs.copilotId}`,
      payload: { visibility: "public" },
    });
    const mine = await seedFor(env);

    const created = await env.inject({
      method: "POST",
      url: `/api/workspaces/${mine.workspaceId}/sessions`,
      payload: { copilotId: theirs.copilotId },
    });

    expect(created.statusCode).toBe(201);
    // All four parts of the Copilot are copied, not just the ones that happened to be visible —
    // the allowlist included, since an empty one would read as "all tools".
    expect(
      created.json<{ copilotId: string; copilotName: string; systemPrompt: string; tools: string[] }>()
    ).toMatchObject({
      copilotId: theirs.copilotId,
      copilotName: "Theirs",
      systemPrompt: "their private persona",
      tools: ["read_file"],
    });
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
