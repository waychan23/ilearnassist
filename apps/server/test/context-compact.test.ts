import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  ChatStreamEvent,
  ContextState,
  Message,
  Session,
  SessionUsageResponse,
  Workspace,
} from "@ilearnassist/shared";
import { parseSse } from "./helpers/sse.js";
import { startFakeLlm, type FakeLlm } from "./helpers/fakeLlm.js";
import {
  keylessProvider,
  newSession,
  newWorkspace,
  providerFor,
  startTestServer,
  type TestEnv,
} from "./helpers/tempEnv.js";

/**
 * Context compaction over the real routes and the real database.
 *
 * What each case is really about: *what the next turn sends*. The stored summary and the
 * session's pointer are the mechanism; the assertion that makes the feature true is the body
 * the fake model received — the summary and the messages after the point, and none of the
 * messages the summary stands in for.
 */

let llm: FakeLlm;
let env: TestEnv;
let workspace: Workspace;

/** The marker the compactor's own system prompt carries — see `fakeLlm.ts`. */
const COMPACT_MARKER = "context-compression function";
const SUMMARY = "Recap: the learner is studying recursion and asked two questions about it.";

beforeAll(async () => {
  llm = await startFakeLlm();
  env = await startTestServer({
    providers: [providerFor(llm), keylessProvider("keyless")],
    defaultProvider: "fake",
    defaultModel: "fake-model",
  });
  workspace = await newWorkspace(env);
});

afterAll(async () => {
  await env.cleanup();
  await llm.close();
});

beforeEach(() => {
  llm.reset();
  llm.setTitle("Fake Conversation Title");
  // The summary reply is body-keyed rather than the sticky title, so a spec says what the
  // summary *is* — the auto-titler keeps its own answer.
  llm.setMatches([{ includes: COMPACT_MARKER, content: SUMMARY }]);
});

async function chat(sessionId: string, message: string): Promise<ChatStreamEvent[]> {
  const res = await env.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/chat`,
    payload: { message },
  });
  if (res.statusCode !== 200) throw new Error(`chat failed: ${res.statusCode} ${res.body}`);
  return parseSse(res.body) as ChatStreamEvent[];
}

async function messagesOf(sessionId: string): Promise<Message[]> {
  return (await env.inject({ method: "GET", url: `/api/sessions/${sessionId}/messages` })).json();
}

async function contextOf(sessionId: string): Promise<ContextState> {
  return (await env.inject({ method: "GET", url: `/api/sessions/${sessionId}/context` })).json();
}

async function compact(sessionId: string) {
  return env.inject({ method: "POST", url: `/api/sessions/${sessionId}/context/compact` });
}

async function restore(sessionId: string) {
  return env.inject({ method: "POST", url: `/api/sessions/${sessionId}/context/restore` });
}

/** The agent-turn request carrying a phrase, out of everything the fake recorded. */
function requestWith(phrase: string): Record<string, unknown> | undefined {
  return llm.requests().find((r) => JSON.stringify(r).includes(phrase));
}

async function sessionWithTwoTurns(): Promise<Session> {
  const session = await newSession(env, workspace.id);
  llm.script([{ content: "first answer" }]);
  await chat(session.id, "first question");
  llm.script([{ content: "second answer" }]);
  await chat(session.id, "second question");
  return session;
}

describe("POST /api/sessions/:id/context/compact", () => {
  it("stores the summary, points the session at it, and bills the call", async () => {
    const session = await sessionWithTwoTurns();

    const res = await compact(session.id);
    expect(res.statusCode).toBe(200);
    const state = res.json<ContextState>();
    expect(state.summary?.content).toBe(SUMMARY);
    expect(state.totalMessages).toBe(4);
    expect(state.tailMessages).toBe(0);

    // The point is the conversation's last live message, so nothing after it is sent verbatim.
    const messages = await messagesOf(session.id);
    expect(state.summary?.throughMessageId).toBe(messages[messages.length - 1]!.id);
    expect(state.summary?.messageCount).toBe(4);

    // The summarizer's tokens are on the ledger under their own purpose, attributed to the
    // conversation and the model that ran it.
    const rows = env.server.db.listUsageRows({
      userId: env.user.id,
      sessionId: session.id,
      fromIso: null,
      toIso: null,
    });
    const compactRows = rows.filter((r) => r.purpose === "summary.context");
    expect(compactRows).toHaveLength(1);
    expect(compactRows[0]!.inputTokens).toBe(20);
    expect(compactRows[0]!.outputTokens).toBe(4);
    expect(compactRows[0]!.modelId).toBe("fake-model");
  });

  it("sends the summary plus the messages after the point, and not what it replaced", async () => {
    const session = await sessionWithTwoTurns();
    await compact(session.id);

    llm.script([{ content: "third answer" }]);
    await chat(session.id, "third question");

    const sent = JSON.stringify(requestWith("third question"));
    expect(sent).toContain(SUMMARY);
    expect(sent).toContain("<conversation_summary>");
    // The two compacted turns are gone from the request, in both directions.
    expect(sent).not.toContain("first question");
    expect(sent).not.toContain("first answer");

    // And the messages written under the compacted context carry its id.
    const messages = await messagesOf(session.id);
    const lastTwo = messages.slice(-2);
    expect(lastTwo.map((m) => m.role)).toEqual(["user", "assistant"]);
    for (const message of lastTwo) expect(message.summaryId).toBe((await contextOf(session.id)).summary?.id);
    // The originals do not: they predate the compaction.
    expect(messages[0]!.summaryId).toBeUndefined();
  });

  it("counts the new tail in the state after the next turn", async () => {
    const session = await sessionWithTwoTurns();
    await compact(session.id);
    llm.script([{ content: "third answer" }]);
    await chat(session.id, "third question");

    const state = await contextOf(session.id);
    expect(state.totalMessages).toBe(6);
    expect(state.tailMessages).toBe(2);
    expect(state.summary?.messageCount).toBe(4);
  });

  it("folds the previous summary into a re-compression instead of re-reading the originals", async () => {
    const session = await sessionWithTwoTurns();
    await compact(session.id);
    llm.script([{ content: "third answer" }]);
    await chat(session.id, "third question");

    const res = await compact(session.id);
    expect(res.statusCode).toBe(200);
    const state = res.json<ContextState>();
    expect(state.summary?.messageCount).toBe(6);
    expect(state.tailMessages).toBe(0);

    // The second compaction's request carries the earlier summary, and only the two new
    // messages — not the four the first summary already covered.
    const compactRequests = llm.requests().filter((r) => JSON.stringify(r).includes(COMPACT_MARKER));
    expect(compactRequests).toHaveLength(2);
    const second = JSON.stringify(compactRequests[1]);
    expect(second).toContain("<previous_summary>");
    expect(second).toContain(SUMMARY);
    expect(second).toContain("third question");
    expect(second).not.toContain("first question");
  });

  it("refuses an empty conversation with CONTEXT_EMPTY and writes nothing", async () => {
    const session = await newSession(env, workspace.id);
    const res = await compact(session.id);
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("CONTEXT_EMPTY");
    expect(await contextOf(session.id)).toMatchObject({ summary: null });
  });

  it("refuses when the model cannot run, leaving the previous state in force", async () => {
    const session = await newSession(env, workspace.id, {
      settings: { providerId: "keyless", modelId: "fake-model" },
    });
    llm.script([{ content: "an answer" }]);
    await chat(session.id, "a question");

    const res = await compact(session.id);
    expect(res.statusCode).toBe(502);
    const body = res.json<{ error: { code: string; params?: Record<string, string> } }>();
    expect(body.error.code).toBe("COMPACT_FAILED");
    expect(body.error.params?.detail).toContain("no API key");
    // Nothing was written: the conversation is still on the full context.
    expect((await contextOf(session.id)).summary).toBeNull();
  });

  it("answers 404 for a conversation that is not this account's", async () => {
    const res = await env.inject({
      method: "POST",
      url: "/api/sessions/does-not-exist/context/compact",
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("a failed turn under compaction", () => {
  it("attributes the ⚠️ row to the summary the turn ran under", async () => {
    const session = await sessionWithTwoTurns();
    await compact(session.id);
    // 400 rather than 500: the OpenAI client retries 5xx, which would consume the queue's next
    // turn and turn this into a successful chat instead of the failure it is about.
    llm.script([{ fail: { status: 400, message: "provider exploded" } }]);

    const res = await env.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/chat`,
      payload: { message: "boom" },
    });
    expect(res.statusCode).toBe(200);

    const messages = await messagesOf(session.id);
    const failure = messages[messages.length - 1]!;
    expect(failure.content).toContain("⚠️");
    expect(failure.summaryId).toBe((await contextOf(session.id)).summary?.id);
  });
});

describe("POST /api/sessions/:id/context/restore", () => {
  it("goes back to the full history, and the next turn sends all of it again", async () => {
    const session = await sessionWithTwoTurns();
    await compact(session.id);

    const res = await restore(session.id);
    expect(res.statusCode).toBe(200);
    const state = res.json<ContextState>();
    expect(state.summary).toBeNull();
    expect(state.tailMessages).toBe(0);

    llm.script([{ content: "third answer" }]);
    await chat(session.id, "third question");
    const sent = JSON.stringify(requestWith("third question"));
    expect(sent).toContain("first question");
    expect(sent).toContain("first answer");
    expect(sent).not.toContain("<conversation_summary>");

    // Restoring does not rewrite provenance: the turns written under the summary keep its id.
    const messages = await messagesOf(session.id);
    expect(messages[5]!.summaryId).toBeUndefined();
  });

  it("is idempotent on a conversation already on the full context", async () => {
    const session = await newSession(env, workspace.id);
    const res = await restore(session.id);
    expect(res.statusCode).toBe(200);
    expect(res.json<ContextState>()).toMatchObject({ summary: null, totalMessages: 0 });
  });
});

describe("GET /api/sessions/:id/context", () => {
  it("reports the full context for a fresh conversation", async () => {
    const session = await newSession(env, workspace.id);
    expect(await contextOf(session.id)).toEqual({
      summary: null,
      totalMessages: 0,
      tailMessages: 0,
    });
  });

  it("carries the same state a compact returns", async () => {
    const session = await sessionWithTwoTurns();
    const compacted = (await compact(session.id)).json<ContextState>();
    expect(await contextOf(session.id)).toEqual(compacted);
  });
});

describe("GET /api/sessions/:id/usage", () => {
  it("sums the conversation's own ledger, including the compaction call", async () => {
    const session = await sessionWithTwoTurns();
    await compact(session.id);

    const res = await env.inject({ method: "GET", url: `/api/sessions/${session.id}/usage` });
    expect(res.statusCode).toBe(200);
    const { totals } = res.json<SessionUsageResponse>();
    // Two chat turns plus the compactor — the auto-title and thread passes also land here,
    // which is the point: the number is what this conversation has cost, not just its replies.
    expect(totals.calls).toBeGreaterThanOrEqual(3);

    const rows = env.server.db.listUsageRows({
      userId: env.user.id,
      sessionId: session.id,
      fromIso: null,
      toIso: null,
    });
    const expected = rows.reduce((sum, r) => sum + r.totalTokens, 0);
    expect(totals.totalTokens).toBe(expected);

    // Another conversation's spend is not in here.
    const other = await sessionWithTwoTurns();
    const otherRes = await env.inject({ method: "GET", url: `/api/sessions/${other.id}/usage` });
    const otherTotals = otherRes.json<SessionUsageResponse>().totals;
    expect(otherTotals.calls).toBeGreaterThan(0);
    expect(otherTotals.totalTokens).toBeLessThan(totals.totalTokens);
  });

  it("answers 404 for a conversation that is not this account's", async () => {
    const res = await env.inject({ method: "GET", url: "/api/sessions/does-not-exist/usage" });
    expect(res.statusCode).toBe(404);
  });
});

describe("the resumed routes", () => {
  it("regenerate runs on the compacted context too", async () => {
    const session = await sessionWithTwoTurns();
    await compact(session.id);

    llm.script([{ content: "regenerated answer" }]);
    const res = await env.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/regenerate`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);

    // The *last streamed* request is the regenerate — the background titler and thread pass are
    // non-streaming and may land after it. The question is compacted, so what the model sees is
    // the summary standing in for it.
    const streaming = llm.requests().filter((r) => (r as { stream?: boolean }).stream === true);
    const sent = JSON.stringify(streaming[streaming.length - 1]);
    expect(sent).toContain(SUMMARY);
    expect(sent).not.toContain("first question");
    expect(sent).not.toContain("first answer");

    // The reply itself is attributed to the summary that produced it.
    const messages = await messagesOf(session.id);
    const assistant = messages[messages.length - 1]!;
    expect(assistant.role).toBe("assistant");
    expect(assistant.summaryId).toBe((await contextOf(session.id)).summary?.id);
  });
});

describe("a pending question", () => {
  const QUESTIONS = [
    {
      header: "方向",
      question: "先讲哪一章？",
      options: [
        { label: "第一章", description: "从基础开始" },
        { label: "第二章", description: "跳过基础" },
      ],
    },
  ];

  it("refuses compaction until the card is answered or skipped, then allows it", async () => {
    const session = await newSession(env, workspace.id);
    llm.script([
      {
        content: "先确认一下方向：",
        toolCalls: [{ name: "ask_user", args: { questions: QUESTIONS } }],
      },
    ]);
    await chat(session.id, "开始复习");
    const suspended = await messagesOf(session.id);
    expect(suspended[suspended.length - 1]!.toolCalls?.some((c) => c.status === "awaiting")).toBe(
      true
    );

    // The awaiting call sits on the conversation's last message, which is exactly where the
    // compaction point would land — so the answer could never be replayed. Refused, not lost.
    const refused = await compact(session.id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe(
      "CONTEXT_PENDING_QUESTION"
    );
    expect((await contextOf(session.id)).summary).toBeNull();

    // Sending a message skips the card — the `/chat` rule — and compaction is then allowed.
    llm.script([{ content: "好，直接开始。" }]);
    await chat(session.id, "先跳过，直接开始");
    const allowed = await compact(session.id);
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json<ContextState>().summary?.content).toBe(SUMMARY);
  });
});

describe("reading compacted history back", () => {
  it("lets the agent recover a message the summary stands in for", async () => {
    const session = await sessionWithTwoTurns();
    await compact(session.id);

    // A turn whose model decides the summary is not enough and searches the stored transcript.
    llm.script([
      {
        content: "让我查一下之前那段话。",
        toolCalls: [
          { name: "ila_recall", args: { mode: "search", query: "first question" } },
        ],
      },
      { content: "找到了：你当时问的是第一个问题。" },
    ]);
    await chat(session.id, "第三个问题");

    const messages = await messagesOf(session.id);
    const last = messages[messages.length - 1]!;
    const call = (last.toolCalls ?? []).find((c) => c.name === "ila_recall");
    expect(call).toBeDefined();
    expect(call!.output).toContain("first question");

    // And the model saw it: the step after the tool call carried the recalled text as a tool
    // result. A summary may stand in for the exchange, but it cannot keep it out for good.
    const sawIt = llm.requests().filter((r) => {
      const history =
        (r as { messages?: { role?: string; content?: unknown }[] }).messages ?? [];
      return history.some(
        (m) => m.role === "tool" && JSON.stringify(m.content).includes("first question")
      );
    });
    expect(sawIt).toHaveLength(1);
  });
});
