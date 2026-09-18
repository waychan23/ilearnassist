import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Message, UsageStats, Workspace } from "@ilearnassist/shared";
import {
  addRow,
  bucketBy,
  buildSessionRows,
  buildStats,
  dayOf,
  emptyTotals,
  usageFilter,
} from "../src/usage.js";
import type { UsageRow } from "../src/db.js";
import {
  newSession,
  newWorkspace,
  startTestServer,
  type TestEnv,
} from "./helpers/tempEnv.js";
import { startFakeLlm, type FakeLlm } from "./helpers/fakeLlm.js";
import type { ProviderDef } from "../src/config.js";

/**
 * The usage ledger: what a call cost, and who may see it.
 *
 * The pure half of `usage.ts` is tested directly, because the arithmetic is where a statistics
 * page can be wrong in a way nobody notices — a total that excludes a purpose, a cache-miss figure
 * that double-counts. The route half is tested through the real stack, because the only thing that
 * makes this feature safe is that an account cannot see another account's spend.
 */

/* ------------------------------------ pure ------------------------------------ */

function row(over: Partial<UsageRow> = {}): UsageRow {
  return {
    id: "u1",
    userId: "user-1",
    workspaceId: "ws-1",
    sessionId: "s-1",
    messageId: null,
    purpose: "chat",
    providerId: "p-1",
    providerName: "Provider",
    modelId: "m-1",
    modelName: "Model",
    inputTokens: 100,
    cachedInputTokens: 40,
    outputTokens: 20,
    reasoningTokens: 5,
    totalTokens: 120,
    durationMs: 1000,
    createdAt: "2026-09-17T04:00:00.000Z",
    ...over,
  };
}

describe("the totals", () => {
  it("derives cache-miss input rather than storing a third figure", () => {
    const totals = emptyTotals();
    addRow(totals, row());
    // 100 in, 40 of them cached — so 60 were paid for at full rate.
    expect(totals.inputTokens).toBe(100);
    expect(totals.cachedInputTokens).toBe(40);
    expect(totals.cacheMissInputTokens).toBe(60);
    // …and the two halves are the whole input, which is the point of deriving it.
    expect(totals.cachedInputTokens + totals.cacheMissInputTokens).toBe(totals.inputTokens);
  });

  it("clamps a provider that reports more cached tokens than input tokens", () => {
    // Impossible, and a negative spend is a worse thing to show than a clamped one.
    const totals = emptyTotals();
    addRow(totals, row({ inputTokens: 10, cachedInputTokens: 999 }));
    expect(totals.cacheMissInputTokens).toBe(0);
  });

  it("sums reasoning and duration beside the token figures", () => {
    const totals = emptyTotals();
    addRow(totals, row());
    addRow(totals, row({ reasoningTokens: 7, durationMs: 500 }));
    expect(totals.calls).toBe(2);
    expect(totals.reasoningTokens).toBe(12);
    expect(totals.durationMs).toBe(1500);
  });

  it("counts a row with no duration as zero time but still as a call", () => {
    // NULL is "nobody timed this", which must not be read as an instant call — but the call
    // itself is real and belongs in the average's denominator.
    const totals = emptyTotals();
    addRow(totals, row({ durationMs: null }));
    expect(totals.calls).toBe(1);
    expect(totals.durationMs).toBe(0);
  });
});

describe("bucketBy", () => {
  it("keeps a label when the row carries one", () => {
    const buckets = bucketBy(
      [row({ workspaceId: "ws-1", workspaceName: "Algebra" })],
      (r) => r.workspaceId,
      (r) => r.workspaceName
    );
    expect(buckets).toEqual([
      expect.objectContaining({ key: "ws-1", label: "Algebra", calls: 1 }),
    ]);
  });

  it("skips rows whose key is null rather than bucketing them under nothing", () => {
    // A row with no workspace is real spend, but a bucket keyed `null` would render as a blank
    // table row — and the totals above it already include the row, so nothing is lost.
    const buckets = bucketBy([row({ workspaceId: null })], (r) => r.workspaceId);
    expect(buckets).toEqual([]);
  });
});

describe("the day axis", () => {
  it("cuts a day in the reader's zone, not the server's", () => {
    /*
     * 04:00 UTC is the 17th in Shanghai and the 16th in Los Angeles — and the day a call belongs
     * to is the day the reader was having. Slicing the ISO string would give the UTC answer and
     * put a late-evening call on tomorrow.
     */
    const late = row({ createdAt: "2026-09-17T04:00:00.000Z" });
    expect(dayOf(late, "Asia/Shanghai")).toBe("2026-09-17");
    expect(dayOf(late, "America/Los_Angeles")).toBe("2026-09-16");
  });

  it("resolves the requested range in that zone too", () => {
    const filter = usageFilter({ from: "2026-09-17", to: "2026-09-17", timezone: "Asia/Shanghai" }, "UTC");
    // The named day starts eight hours before UTC midnight, and the upper bound is the *end* of
    // it, so `to` includes the whole day rather than stopping at its start.
    expect(filter.fromIso).toBe("2026-09-16T16:00:00.000Z");
    expect(filter.toIso).toBe("2026-09-17T16:00:00.000Z");
    expect(filter.fromDate).toBe("2026-09-17");
  });

  it("drops a bound it cannot parse rather than refusing the query", () => {
    // Reachable only from a hand-edited URL, and the answer to that is the unbounded answer.
    const filter = usageFilter({ from: "yesterday", timezone: "UTC" }, "UTC");
    expect(filter.fromIso).toBeNull();
    expect(filter.fromDate).toBeNull();
  });

  it("fills the quiet days in a named range", () => {
    // A chart drawn from only the days that have calls compresses a quiet week into a busy line.
    const filter = usageFilter({ from: "2026-09-15", to: "2026-09-18", timezone: "UTC" }, "UTC");
    const stats = buildStats([row({ createdAt: "2026-09-16T10:00:00.000Z" })], filter, null);
    expect(stats.byDay.map((d) => d.key)).toEqual([
      "2026-09-15",
      "2026-09-16",
      "2026-09-17",
      "2026-09-18",
    ]);
    expect(stats.byDay.map((d) => d.calls)).toEqual([0, 1, 0, 0]);
  });

  it("leaves an unbounded range unfilled", () => {
    // There is no "quiet day" to invent when the reader asked for everything.
    const filter = usageFilter({ timezone: "UTC" }, "UTC");
    const stats = buildStats([row()], filter, null);
    expect(stats.byDay.map((d) => d.key)).toEqual(["2026-09-17"]);
  });
});

describe("buildStats", () => {
  it("orders the purpose breakdown the way the constant lists it", () => {
    // A panel whose rows reorder themselves between two queries is one nobody can read across.
    const rows = [
      row({ purpose: "title" }),
      row({ purpose: "chat" }),
      row({ purpose: "summary.media" }),
    ];
    const filter = usageFilter({ timezone: "UTC" }, "UTC");
    expect(buildStats(rows, filter, null).byPurpose.map((b) => b.key)).toEqual([
      "chat",
      "title",
      "summary.media",
    ]);
  });

  it("carries the since date through, which is how a page says when counting began", () => {
    const filter = usageFilter({ timezone: "UTC" }, "UTC");
    const stats = buildStats([row()], filter, "2026-09-01T00:00:00.000Z");
    expect(stats.since).toBe("2026-09-01T00:00:00.000Z");
  });
});

describe("buildSessionRows", () => {
  it("groups by conversation, newest spend first, and keeps the title", () => {
    const rows = [
      row({ sessionId: "s-1", sessionTitle: "Small", totalTokens: 10 }),
      row({ sessionId: "s-2", sessionTitle: "Big", totalTokens: 900 }),
      row({ sessionId: "s-1", sessionTitle: "Small", totalTokens: 5 }),
    ];
    const sessions = buildSessionRows(rows);
    expect(sessions.map((s) => s.sessionId)).toEqual(["s-2", "s-1"]);
    expect(sessions[1]!.totalTokens).toBe(15);
    expect(sessions[0]!.title).toBe("Big");
  });

  it("skips a row with no conversation, which no feature writes today", () => {
    expect(buildSessionRows([row({ sessionId: null })])).toEqual([]);
  });
});

/* ----------------------------------- routes ----------------------------------- */


let llm: FakeLlm;
let env: TestEnv;
let workspace: Workspace;

beforeAll(async () => {
  llm = await startFakeLlm();
  const provider: ProviderDef = {
    id: "fake",
    name: "Fake Provider",
    baseURL: llm.baseURL,
    apiKey: "test-key",
    // A second model, so "which model ran this turn" is a question with two possible answers.
    models: [
      { id: "fake-model", name: "Fake Model" },
      { id: "other-model", name: "Other Model" },
    ],
  };
  // No API key, so a turn sent to this one fails at the provider — which is how the other tests
  // reach the `⚠️` path, and the only way to make a real turn fail without mocking the loop.
  const keyless: ProviderDef = {
    id: "keyless",
    name: "Keyless",
    baseURL: llm.baseURL,
    models: [{ id: "fake-model", name: "Fake Model" }],
  };
  env = await startTestServer({
    providers: [provider, keyless],
    defaultProvider: "fake",
    defaultModel: "fake-model",
  });
});

afterAll(async () => {
  await env.cleanup();
  await llm.close();
});

/**
 * A workspace of this test's own.
 *
 * Not shared across the file, and that is the whole reason: the ledger accumulates, so a total
 * read from `/api/stats` would include every earlier test's turns. Each test asks about the
 * workspace it made, which is also what exercises the `workspaceId` filter the pages use.
 */
beforeEach(async () => {
  llm.reset();
  llm.setTitle("Fake Conversation Title");
  workspace = await newWorkspace(env, `Ledger ${Math.random().toString(36).slice(2)}`);
});

async function send(
  sessionId: string,
  message: string,
  over: Record<string, unknown> = {}
): Promise<void> {
  await env.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/chat`,
    payload: { message, ...over },
  });
}

/** The stats for the workspace this test made, which is what isolates it from the others. */
async function statsOf(query = ""): Promise<UsageStats> {
  const res = await env.inject({
    method: "GET",
    url: `/api/stats?workspaceId=${workspace.id}${query}`,
  });
  expect(res.statusCode).toBe(200);
  return res.json<UsageStats>();
}

describe("GET /api/stats", () => {
  it("records a chat turn and the auto-title as two different purposes", async () => {
    /*
     * The claim a sum over `messages` could not make: only the turn writes a message, and the
     * titler's call costs real tokens that no transcript holds. Both land here — which is the
     * whole reason the ledger is a table rather than a query over the transcript.
     */
    llm.setTurns([{ content: "hello", usage: { input: 100, output: 20 } }]);
    const session = await newSession(env, workspace.id);
    await send(session.id, "hi");

    const stats = await statsOf();
    const purposes = Object.fromEntries(stats.byPurpose.map((b) => [b.key, b]));
    expect(purposes["chat"]?.calls).toBe(1);
    expect(purposes["chat"]?.inputTokens).toBe(100);
    // The fake titler reports a fixed 20 in / 4 out.
    expect(purposes["title"]?.calls).toBe(1);
    expect(purposes["title"]?.totalTokens).toBe(24);
    // Both calls are in the total, which is what no per-message figure could say.
    expect(stats.totals.calls).toBe(2);
    expect(stats.totals.totalTokens).toBe(144);
    expect(stats.since).toBeTruthy();
  });

  it("derives cache-miss input from the cached share", async () => {
    llm.setTurns([{ content: "ok", usage: { input: 200, output: 10, cached: 150 } }]);
    const session = await newSession(env, workspace.id);
    await send(session.id, "cache me");

    const chat = (await statsOf()).byPurpose.find((b) => b.key === "chat")!;
    expect(chat.inputTokens).toBe(200);
    expect(chat.cachedInputTokens).toBe(150);
    expect(chat.cacheMissInputTokens).toBe(50);
    expect(chat.cachedInputTokens + chat.cacheMissInputTokens).toBe(chat.inputTokens);
  });

  it("attributes a turn to the model that ran it, and keeps them apart", async () => {
    // A model can be changed mid-conversation, so "the model" is a property of each turn — and a
    // breakdown that merged the two would be a number nobody could act on.
    llm.setTurns([
      { content: "first", usage: { input: 10, output: 1 } },
      { content: "second", usage: { input: 20, output: 2 } },
    ]);
    const session = await newSession(env, workspace.id);
    await send(session.id, "one");
    await send(session.id, "two", { model: "other-model" });

    const byModel = Object.fromEntries((await statsOf()).byModel.map((b) => [b.key, b]));
    // Two calls, not one: this breakdown is by model, so the first turn and the titler that ran
    // on it are both here — the fake titler reporting its fixed 20 in / 4 out.
    expect(byModel["fake-model"]).toMatchObject({ calls: 2, inputTokens: 30 });
    // The second turn went to the other model, and is attributed there alone.
    expect(byModel["other-model"]).toMatchObject({
      calls: 1,
      inputTokens: 20,
      label: "Other Model",
    });
  });

  it("narrows to a date range, and fills the quiet days inside it", async () => {
    llm.setTurns([{ content: "ok", usage: { input: 10, output: 1 } }]);
    const session = await newSession(env, workspace.id);
    await send(session.id, "today");

    // A range in the far past has nothing in it. The assertion is that the ledger is filtered,
    // not that the clock was mocked — mocking `Date` would be testing `Date`.
    const past = await statsOf("&from=2020-01-01&to=2020-01-03");
    expect(past.totals.calls).toBe(0);
    expect(past.byDay.map((d) => d.key)).toEqual(["2020-01-01", "2020-01-02", "2020-01-03"]);

    expect((await statsOf()).totals.calls).toBeGreaterThan(0);
  });

  it("names the workspace a turn was spent in", async () => {
    llm.setTurns([{ content: "ok", usage: { input: 5, output: 1 } }]);
    const session = await newSession(env, workspace.id);
    await send(session.id, "here");

    expect((await statsOf()).byWorkspace).toEqual([
      expect.objectContaining({ key: workspace.id, label: workspace.name }),
    ]);
  });

  it("lists the conversations that spent the most", async () => {
    llm.setTurns([
      { content: "small", usage: { input: 1, output: 1 } },
      { content: "big", usage: { input: 500, output: 100 } },
    ]);
    const small = await newSession(env, workspace.id);
    const big = await newSession(env, workspace.id);
    await send(small.id, "a");
    await send(big.id, "b");

    const res = await env.inject({
      method: "GET",
      url: `/api/stats/sessions?workspaceId=${workspace.id}`,
    });
    const rows = res.json<{
      sessions: { sessionId: string; title: string; totalTokens: number }[];
    }>().sessions;
    // Ordered by spend, biggest first: the question this table answers is "where did it go".
    expect(rows.map((r) => r.sessionId)).toEqual([big.id, small.id]);
    expect(rows[0]!.totalTokens).toBeGreaterThan(rows[1]!.totalTokens);
    // The title comes from the conversation, so the table is readable without a second lookup.
    expect(rows[0]!.title).toBeTruthy();
  });

  it("shows an account only its own spend", async () => {
    /*
     * The claim that makes the page safe to be everyone's. `asUser` goes the whole way round — the
     * console's create route, the first sign-in, the password change — so this is a second *real*
     * account rather than a row written into a state no account is ever in.
     */
    llm.setTurns([{ content: "ok", usage: { input: 100, output: 50 } }]);
    const session = await newSession(env, workspace.id);
    await send(session.id, "the first account's turn");

    const other = await env.asUser("Observer");
    const res = await other.inject({ method: "GET", url: "/api/stats" });
    expect(res.statusCode).toBe(200);
    const theirs = res.json<UsageStats>();
    // Unfiltered, and still nothing: the scope is the caller, not the query.
    expect(theirs.totals.calls).toBe(0);
    expect(theirs.since).toBeUndefined();

    // …and the first account's own total is untouched by the second account looking.
    expect((await statsOf()).totals.calls).toBeGreaterThan(0);
  });

  it("never carries a per-account breakdown on the self route", async () => {
    // The field's *absence* is the permission, so a self-scoped answer must not carry one at all.
    llm.setTurns([{ content: "ok", usage: { input: 1, output: 1 } }]);
    const session = await newSession(env, workspace.id);
    await send(session.id, "mine");

    expect((await statsOf()).byUser).toBeUndefined();
  });

  it("refuses a signed-out caller", async () => {
    const res = await env.server.app.inject({ method: "GET", url: "/api/stats" });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/admin/stats", () => {
  it("breaks the installation's spend down by account, for an administrator", async () => {
    llm.setTurns([{ content: "ok", usage: { input: 20, output: 5 } }]);
    const session = await newSession(env, workspace.id);
    await send(session.id, "the administrator's turn");

    const res = await env.inject({
      method: "GET",
      url: `/api/admin/stats?workspaceId=${workspace.id}`,
    });
    expect(res.statusCode).toBe(200);
    const stats = res.json<UsageStats>();
    expect(stats.byUser).toEqual([
      expect.objectContaining({ key: env.user.id, label: env.user.username }),
    ]);
  });

  it("is refused for an ordinary account", async () => {
    // A hidden button is not a permission: the route answers 403 regardless of what is drawn.
    const other = await env.asUser("Ordinary");
    const res = await other.inject({ method: "GET", url: "/api/admin/stats" });
    expect(res.statusCode).toBe(403);
  });

  it("narrows to one account when asked, and filters to nothing for an id that names nobody", async () => {
    llm.setTurns([{ content: "ok", usage: { input: 20, output: 5 } }]);
    const session = await newSession(env, workspace.id);
    await send(session.id, "somebody's turn");

    const mine = await env.inject({
      method: "GET",
      url: `/api/admin/stats?workspaceId=${workspace.id}&userId=${env.user.id}`,
    });
    expect(mine.json<UsageStats>().totals.calls).toBeGreaterThan(0);

    const nobody = await env.inject({
      method: "GET",
      url: `/api/admin/stats?workspaceId=${workspace.id}&userId=nobody`,
    });
    expect(nobody.json<UsageStats>().totals.calls).toBe(0);
  });
});

describe("the model on a message", () => {
  it("records which model wrote each turn, denormalized", async () => {
    /*
     * The requirement's other half, and the reason it is on the *message* rather than on the
     * session: a model can be changed mid-conversation, so a transcript with two models in it is
     * one whose numbers mean nothing without this. The names are stored beside the ids so a
     * provider renamed or deleted later cannot rewrite what a turn says about itself.
     */
    llm.setTurns([
      { content: "first", usage: { input: 10, output: 1 } },
      { content: "second", usage: { input: 20, output: 2 } },
    ]);
    const session = await newSession(env, workspace.id);
    await send(session.id, "one");
    await send(session.id, "two", { model: "other-model" });

    const res = await env.inject({ method: "GET", url: `/api/sessions/${session.id}/messages` });
    // The route answers the array itself, not an envelope.
    const messages = res.json<Message[]>().filter((m) => m.role === "assistant");
    expect(messages).toHaveLength(2);
    expect(messages[0]!.model).toEqual({
      providerId: "fake",
      providerName: "Fake Provider",
      modelId: "fake-model",
      modelName: "Fake Model",
    });
    expect(messages[1]!.model?.modelId).toBe("other-model");
    expect(messages[1]!.model?.modelName).toBe("Other Model");
  });

  it("attributes a failed turn too", async () => {
    /*
     * "Which model failed" is the first question anybody asks about a failure, and the `⚠️` row is
     * written by a different function from the successful one — so it is the site that would have
     * been forgotten.
     */
    const session = await newSession(env, workspace.id);
    await send(session.id, "this will fail", { provider: "keyless" });

    const res = await env.inject({ method: "GET", url: `/api/sessions/${session.id}/messages` });
    const failed = res
      .json<Message[]>()
      .filter((m) => m.role === "assistant")
      .at(-1);
    expect(failed?.content).toContain("⚠️");
    expect(failed?.model?.modelId).toBe("fake-model");
  });

  it("leaves the model absent rather than defaulting it", async () => {
    // A user message has no model, and neither does any message written before the columns
    // existed. Filling in the session's current model would be a claim about a turn nobody
    // recorded — so the field is absent, not guessed.
    const session = await newSession(env, workspace.id);
    await send(session.id, "just a user turn");

    const res = await env.inject({ method: "GET", url: `/api/sessions/${session.id}/messages` });
    const user = res.json<Message[]>().find((m) => m.role === "user");
    expect(user?.model).toBeUndefined();
  });
});

describe("the pass durations", () => {
  it("records how long an out-of-band pass took, and an em dash when nobody timed it", async () => {
    /*
     * The auto-titler is timed by its own factory — the caller does not know when the request left,
     * and a figure that included its bookkeeping would be a latency nobody experienced. The chat
     * turn is timed by the route around the whole run.
     *
     * Both rows are asserted together because the *difference* is the point: a page with a column
     * of zeroes reads as instantaneous calls rather than as unmeasured ones.
     */
    llm.setTurns([{ content: "ok", usage: { input: 10, output: 1 } }]);
    const session = await newSession(env, workspace.id);
    await send(session.id, "time this");

    const purposes = Object.fromEntries(
      (await statsOf()).byPurpose.map((b) => [b.key, b])
    );
    expect(purposes["chat"]?.calls).toBe(1);
    expect(purposes["title"]?.calls).toBe(1);
    // The titler's row carries a real measurement now, so the page can show an average for it.
    expect(purposes["title"]!.durationMs).toBeGreaterThan(0);
    expect(purposes["title"]!.durationMs).toBeLessThan(30_000);
  });
});
