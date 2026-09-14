import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ChatStreamEvent, Message, Session, ToolCall } from "@ilearnassist/shared";
import type { ProviderDef } from "../src/config.js";
import { eventTypes, parseSse } from "./helpers/sse.js";
import { startFakeLlm, type FakeLlm, type FakeTurn } from "./helpers/fakeLlm.js";

type FakeTurnList = FakeTurn[];
import { newSession, newWorkspace, startTestServer, type TestEnv } from "./helpers/tempEnv.js";

/**
 * The suspended turn, across two HTTP requests.
 *
 * `ask_user` is the only tool that ends the turn instead of answering within it, so this
 * is where the mechanism is proved end to end: the first request stops and persists a
 * pending call, the second writes the user's answers onto it and carries on — with the
 * real loop, the real SSE framing and the real database, and only the model faked.
 */

let llm: FakeLlm;
let env: TestEnv;

const QUESTIONS = [
  {
    header: "认证方式",
    question: "要用哪种认证方式？",
    options: [{ label: "OAuth" }, { label: "API Key" }],
  },
  {
    header: "数据库",
    question: "数据库用哪个？",
    options: [{ label: "PostgreSQL" }, { label: "MySQL" }],
  },
];

beforeAll(async () => {
  llm = await startFakeLlm();
  const provider: ProviderDef = {
    id: "fake",
    name: "Fake Provider",
    baseURL: llm.baseURL,
    apiKey: "test-key",
    models: [{ id: "fake-model", name: "fake-model" }],
  };
  env = await startTestServer({
    providers: [provider],
    defaultProvider: "fake",
    defaultModel: "fake-model",
  });
});

afterAll(async () => {
  await env.cleanup();
  await llm.close();
});

beforeEach(() => {
  llm.reset();
  llm.setTitle("Fake Conversation Title");
});

async function freshSession(): Promise<Session> {
  const workspace = await newWorkspace(env, `W-${Math.random().toString(36).slice(2)}`);
  return newSession(env, workspace.id);
}

async function chat(sessionId: string, message: string) {
  const res = await env.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/chat`,
    payload: { message },
  });
  return { res, events: parseSse(res.body) as ChatStreamEvent[] };
}

async function answer(sessionId: string, payload: Record<string, unknown>) {
  const res = await env.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/answers`,
    payload,
  });
  return {
    res,
    events: res.headers["content-type"]?.includes("event-stream")
      ? (parseSse(res.body) as ChatStreamEvent[])
      : [],
  };
}

async function messagesOf(sessionId: string): Promise<Message[]> {
  return (
    await env.inject({ method: "GET", url: `/api/sessions/${sessionId}/messages` })
  ).json<Message[]>();
}

/** The assistant message holding the pending call, and that call. */
async function pendingOf(sessionId: string): Promise<{ message: Message; call: ToolCall }> {
  const messages = await messagesOf(sessionId);
  for (const message of messages) {
    const call = (message.toolCalls ?? []).find((tc) => tc.name === "ask_user");
    if (call) return { message, call };
  }
  throw new Error("no ask_user call was persisted");
}

/** Script the model to ask, then answer whatever comes back. */
function scriptAsk(continuation = "好的，按你选的来。") {
  llm.setTurns([
    { content: "有两件事需要你定。", toolCalls: [{ id: "call_ask", name: "ask_user", args: { questions: QUESTIONS } }] },
    { content: continuation },
  ]);
}

/**
 * The agent-loop requests only. The auto-titler also calls the model, non-streaming, on a
 * first turn — so counting every request would be counting two different things.
 */
function loopRequests(): Record<string, unknown>[] {
  return llm.requests().filter((r) => r.stream === true);
}

describe("ask_user over the wire", () => {
  it("suspends the turn: a tool_start with no tool_end, then the pending call", async () => {
    const session = await freshSession();
    scriptAsk();

    const { res, events } = await chat(session.id, "帮我加个登录");

    expect(res.statusCode).toBe(200);
    expect(eventTypes(res.body)).toEqual([
      "meta",
      // The server's row for the user's own message, so the client can address it later.
      "message_saved",
      "text",
      "tool_start",
      "usage",
      "message_done",
      "title",
      "done",
    ]);

    // The stream ends normally rather than being held open — this is what lets the answer
    // arrive from a later request, or after a reload.
    expect(events.at(-1)).toEqual({ type: "done" });

    const done = events.find((e) => e.type === "message_done") as { message: Message };
    const call = done.message.toolCalls![0]!;
    expect(call).toMatchObject({ id: "call_ask", name: "ask_user", status: "awaiting" });
    expect(call.output).toBeUndefined();
    // The questions travel on `input`, which is what the card renders from.
    expect(JSON.parse(call.input).questions).toHaveLength(2);
  });

  it("persists the preamble the model streamed before asking", async () => {
    const session = await freshSession();
    scriptAsk();

    await chat(session.id, "帮我加个登录");

    const { message } = await pendingOf(session.id);
    // The live view showed the narration, and unlike a tool-calling step it survives a
    // reload here — the turn ended on the question, so nothing replaced the text.
    expect(message.content).toBe("有两件事需要你定。");
  });

  it("carries the answers into the resumed turn and a new assistant reply", async () => {
    const session = await freshSession();
    scriptAsk("就按 OAuth + PostgreSQL 来。");

    const first = await chat(session.id, "帮我加个登录");
    const pending = (first.events.find((e) => e.type === "message_done") as { message: Message })
      .message.toolCalls![0]!;
    // One request so far: the suspended turn ran the loop once and stopped.
    expect(loopRequests()).toHaveLength(1);

    const { res, events } = await answer(session.id, {
      toolCallId: pending.id,
      action: "submit",
      answers: {
        "0": { selected: ["OAuth"] },
        "1": { selected: ["PostgreSQL"] },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(events[0]).toEqual({ type: "meta", sessionId: session.id });
    expect(events.at(-1)).toEqual({ type: "done" });

    const done = events.find((e) => e.type === "message_done") as { message: Message };
    expect(done.message.content).toBe("就按 OAuth + PostgreSQL 来。");

    // The resumed request is built from history, not from a new user message: it ends on
    // the tool result, with the assistant's `tool_calls` block replayed above it.
    const sent = loopRequests().at(-1) as {
      messages: { role: string; content: unknown; tool_calls?: { id: string; function: { name: string } }[] }[];
    };
    expect(sent.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(sent.messages[2]!.tool_calls?.[0]!.function.name).toBe("ask_user");
    expect(String(sent.messages[3]!.content)).toContain("OAuth");

    // And the answers are on the tool call itself, in both readers' shapes.
    const { call } = await pendingOf(session.id);
    expect(call.status).toBe("answered");
    expect(call.answer).toEqual({
      "0": { selected: ["OAuth"] },
      "1": { selected: ["PostgreSQL"] },
    });
    expect(JSON.parse(call.output!)).toEqual({
      user_answers: [
        { question: "要用哪种认证方式？", selected: ["OAuth"] },
        { question: "数据库用哪个？", selected: ["PostgreSQL"] },
      ],
    });

    const persisted = await messagesOf(session.id);
    expect(persisted.map((m) => [m.role, m.content])).toEqual([
      ["user", "帮我加个登录"],
      ["assistant", "有两件事需要你定。"],
      ["assistant", "就按 OAuth + PostgreSQL 来。"],
    ]);
  });

  it("survives a reload: the pending call is readable long before it is answered", async () => {
    const session = await freshSession();
    scriptAsk();

    await chat(session.id, "帮我加个登录");

    // Nothing about the pending state is held in the process — a fresh GET, which is
    // exactly what a reloaded page does, still finds the question and its options.
    const { call } = await pendingOf(session.id);
    const questions = JSON.parse(call.input).questions as typeof QUESTIONS;
    expect(call.status).toBe("awaiting");
    expect(questions[0]!.header).toBe("认证方式");
    expect(questions[0]!.options.map((o) => o.label)).toEqual(["OAuth", "API Key"]);
  });

  it("records a cancel as a dismissal and lets the model carry on", async () => {
    const session = await freshSession();
    scriptAsk("那我先按 OAuth 做，随时可以改。");

    const first = await chat(session.id, "帮我加个登录");
    const pending = (first.events.find((e) => e.type === "message_done") as { message: Message })
      .message.toolCalls![0]!;

    await answer(session.id, { toolCallId: pending.id, action: "cancel" });

    const { call } = await pendingOf(session.id);
    expect(call.status).toBe("dismissed");
    expect(call.answer).toEqual({});

    const sent = loopRequests().at(-1) as { messages: { role: string; content: unknown }[] };
    expect(String(sent.messages.at(-1)!.content)).toContain("dismissed the questions");
  });
});

describe("ask_user — retiring a question the user walked away from", () => {
  it("marks it skipped when a new message arrives, and keeps it out of the next turn", async () => {
    const session = await freshSession();
    scriptAsk();

    await chat(session.id, "帮我加个登录");
    expect((await pendingOf(session.id)).call.status).toBe("awaiting");

    // The user ignores the questions and says something else.
    await chat(session.id, "算了，先不做了");

    const { call } = await pendingOf(session.id);
    expect(call.status).toBe("skipped");

    // With no `output` the call is dropped from history, so the model is not handed a
    // `tool_calls` block whose result is missing — which OpenAI rejects outright.
    const sent = loopRequests().at(-1) as {
      messages: { role: string; content: unknown; tool_calls?: unknown }[];
    };
    expect(sent.messages.some((m) => m.tool_calls !== undefined)).toBe(false);
    expect(String(sent.messages.at(-1)!.content)).toContain("算了，先不做了");
  });
});

describe("POST /api/sessions/:id/answers — validation", () => {
  it("404s an unknown session", async () => {
    const res = await env.inject({
      method: "POST",
      url: "/api/sessions/nope/answers",
      payload: { toolCallId: "c1", action: "submit", answers: {} },
    });
    expect(res.statusCode).toBe(404);
  });

  it("409s a tool call that is not awaiting an answer", async () => {
    const session = await freshSession();
    scriptAsk();

    const res = await env.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/answers`,
      payload: { toolCallId: "never-existed", action: "submit", answers: {} },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: "QUESTION_NOT_PENDING" } });
  });

  it("409s a second submission of the same question", async () => {
    const session = await freshSession();
    scriptAsk();

    const first = await chat(session.id, "帮我加个登录");
    const pending = (first.events.find((e) => e.type === "message_done") as { message: Message })
      .message.toolCalls![0]!;
    const payload = {
      toolCallId: pending.id,
      action: "submit",
      answers: { "0": { selected: ["OAuth"] }, "1": { selected: ["PostgreSQL"] } },
    };

    expect((await answer(session.id, payload)).res.statusCode).toBe(200);

    // A stale tab submitting again must not overwrite the recorded answer or start a
    // second resumed turn.
    const again = await answer(session.id, payload);
    expect(again.res.statusCode).toBe(409);
    expect(again.res.json()).toMatchObject({ error: { code: "QUESTION_NOT_PENDING" } });
  });

  it("400s a label the model never offered", async () => {
    const session = await freshSession();
    scriptAsk();
    const first = await chat(session.id, "帮我加个登录");
    const pending = (first.events.find((e) => e.type === "message_done") as { message: Message })
      .message.toolCalls![0]!;

    const { res } = await answer(session.id, {
      toolCallId: pending.id,
      action: "submit",
      answers: { "0": { selected: ["OAuth", "something injected"] }, "1": { selected: ["MySQL"] } },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "INVALID_ANSWER" } });

    // Rejected means nothing was written: the question is still live and answerable.
    expect((await pendingOf(session.id)).call.status).toBe("awaiting");
  });

  it("400s a submission that leaves a question unanswered", async () => {
    const session = await freshSession();
    scriptAsk();
    const first = await chat(session.id, "帮我加个登录");
    const pending = (first.events.find((e) => e.type === "message_done") as { message: Message })
      .message.toolCalls![0]!;

    const { res } = await answer(session.id, {
      toolCallId: pending.id,
      action: "submit",
      answers: { "0": { selected: ["OAuth"] } },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "INVALID_ANSWER" } });
  });
});

describe("ask_user after another tool has already run", () => {
  /**
   * The shape that was reported from a real session: the model lists the workspace first,
   * then in a *later step* writes a preamble and asks. Two differences from the simple
   * case — the suspension happens on the second step, and the assistant message carries a
   * completed tool call beside the pending one.
   */
  const TWO_STEP: FakeTurnList = [
    { toolCalls: [{ id: "call_ls", name: "list_files", args: { path: "." } }] },
    {
      content: "先说一句。",
      toolCalls: [{ id: "call_ask", name: "ask_user", args: { questions: QUESTIONS } }],
    },
    { content: "好的，开始吧。" },
  ];

  it("still suspends, and still resumes when answered", async () => {
    const session = await freshSession();
    llm.setTurns([...TWO_STEP]);

    const first = await chat(session.id, "教我 Flink");

    const done = (first.events.find((e) => e.type === "message_done") as { message: Message })
      .message;
    // The completed call and the pending one share one assistant message.
    expect(done.toolCalls!.map((tc) => [tc.name, tc.status])).toEqual([
      ["list_files", undefined],
      ["ask_user", "awaiting"],
    ]);
    expect(done.toolCalls![0]!.output).toContain("entries");
    expect(done.content).toBe("先说一句。");

    const { res, events } = await answer(session.id, {
      toolCallId: "call_ask",
      action: "submit",
      answers: { "0": { selected: ["OAuth"] }, "1": { selected: ["PostgreSQL"] } },
    });

    expect(res.statusCode).toBe(200);
    expect(events.some((e) => e.type === "error")).toBe(false);
    const reply = events.find((e) => e.type === "message_done") as { message: Message };
    expect(reply.message.content).toBe("好的，开始吧。");
  });
});
