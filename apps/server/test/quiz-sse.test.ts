import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ChatStreamEvent, Message, QuizAnswers, Session, ToolCall } from "@ilearnassist/shared";
import type { ProviderDef } from "../src/config.js";
import { eventTypes, parseSse } from "./helpers/sse.js";
import { startFakeLlm, type FakeLlm } from "./helpers/fakeLlm.js";
import { newSession, newWorkspace, startTestServer, type TestEnv } from "./helpers/tempEnv.js";

/**
 * The quiz turn, across two HTTP requests.
 *
 * `quiz` uses the same suspension as `ask_user`, so what is proved here is what `quiz` adds
 * on top of it: the ids the tool assigns are in the record the card renders from and the
 * model replays, the two tools' answer keys do not cross, and the counter is scoped to the
 * conversation rather than to the call — a second quiz carries on numbering where the first
 * stopped. The real loop, the real SSE framing, the real database, and only the model faked.
 */

let llm: FakeLlm;
let env: TestEnv;

/** Two questions, the second multi-select, so both modes travel the whole path. */
const QUESTIONS = [
  {
    header: "窗口",
    question: "Flink 里按时间切分的窗口是哪一种？",
    options: [{ label: "滚动窗口" }, { label: "状态后端" }],
  },
  {
    header: "状态",
    question: "下面哪些属于状态后端？",
    multiSelect: true,
    options: [{ label: "RocksDB" }, { label: "HashMap" }],
  },
];

const ONE_QUESTION = [
  {
    header: "算子",
    question: "哪一个算子是转换算子？",
    options: [{ label: "map" }, { label: "addSource" }],
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

/** Every `quiz` call the session has persisted, in message order. */
async function quizCallsOf(sessionId: string): Promise<ToolCall[]> {
  const messages = await messagesOf(sessionId);
  return messages.flatMap((m) => (m.toolCalls ?? []).filter((tc) => tc.name === "quiz"));
}

/** The single quiz call still awaiting an answer. */
async function pendingOf(sessionId: string): Promise<ToolCall> {
  const awaiting = (await quizCallsOf(sessionId)).filter((tc) => tc.status === "awaiting");
  if (awaiting.length !== 1) {
    throw new Error(`expected exactly one awaiting quiz call, found ${awaiting.length}`);
  }
  return awaiting[0]!;
}

const callFrom = (events: ChatStreamEvent[]): ToolCall =>
  (events.find((e) => e.type === "message_done") as { message: Message }).message.toolCalls![0]!;

/** Script the model to quiz, then answer whatever comes back. */
function scriptQuiz(continuation = "好，就按这个来。", questions = QUESTIONS) {
  llm.setTurns([
    {
      content: "先测一下你现在的印象。",
      toolCalls: [{ id: "call_quiz", name: "quiz", args: { questions } }],
    },
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

describe("quiz over the wire", () => {
  it("suspends the turn, and numbers the questions before persisting them", async () => {
    const session = await freshSession();
    scriptQuiz();

    const { res, events } = await chat(session.id, "我想学 Flink");

    expect(res.statusCode).toBe(200);
    expect(eventTypes(res.body)).toEqual([
      "meta",
      "text",
      "tool_start",
      "usage",
      "message_done",
      "title",
      "done",
    ]);

    const call = callFrom(events);
    expect(call).toMatchObject({ name: "quiz", status: "awaiting" });
    expect(call.output).toBeUndefined();
    // The stream ends normally rather than being held open — that is what lets the answer
    // arrive from a later request, or after a reload.
    expect(events.at(-1)).toEqual({ type: "done" });

    // The model asked without ids, and the record carries them anyway: this is the whole
    // point of the tool numbering its own input.
    const stored = JSON.parse(call.input) as { questions: { id: string }[] };
    expect(stored.questions.map((q) => q.id)).toEqual(["Q1", "Q2"]);
  });

  it("survives a reload: a fresh GET finds the questions and their ids", async () => {
    const session = await freshSession();
    scriptQuiz();

    await chat(session.id, "我想学 Flink");

    // Nothing about the pending state lives in the process, so the card a reloaded page
    // re-renders is built from this — ids and modes included.
    const call = await pendingOf(session.id);
    const { questions } = JSON.parse(call.input) as {
      questions: { id: string; header: string; multiSelect?: boolean }[];
    };

    expect(call.status).toBe("awaiting");
    expect(questions[0]!.id).toBe("Q1");
    expect(questions[1]!.header).toBe("状态");
    expect(questions[1]!.multiSelect).toBe(true);
  });

  it("carries an id-keyed answer into the resumed turn, and the model sees the ids", async () => {
    const session = await freshSession();
    scriptQuiz("按 RocksDB 那个来。");

    const first = await chat(session.id, "我想学 Flink");
    const pending = callFrom(first.events);
    expect(loopRequests()).toHaveLength(1);

    const { res, events } = await answer(session.id, {
      toolCallId: pending.id,
      action: "submit",
      answers: {
        Q1: { selected: ["滚动窗口"] },
        Q2: { selected: ["RocksDB", "HashMap"], notes: "记不太准，靠印象选的" },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(events[0]).toEqual({ type: "meta", sessionId: session.id });
    expect(events.at(-1)).toEqual({ type: "done" });

    const done = events.find((e) => e.type === "message_done") as { message: Message };
    expect(done.message.content).toBe("按 RocksDB 那个来。");

    // The resumed request is built from history, not from a new user message: it ends on the
    // tool result, with the assistant's `tool_calls` block replayed above it.
    const sent = loopRequests().at(-1) as {
      messages: {
        role: string;
        content: unknown;
        tool_calls?: { id: string; function: { name: string; arguments: string } }[];
      }[];
    };
    expect(sent.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(sent.messages[2]!.tool_calls?.[0]!.function.name).toBe("quiz");
    // The replayed call carries the recorded ids, so the model's own context lines up with
    // the ids the result refers to.
    expect(sent.messages[2]!.tool_calls?.[0]!.function.arguments).toContain("Q1");

    const result = JSON.parse(String(sent.messages[3]!.content)) as {
      user_answers: { id: string; question: string; selected: string[]; notes?: string }[];
    };
    expect(result.user_answers[0]).toEqual({
      id: "Q1",
      question: "Flink 里按时间切分的窗口是哪一种？",
      selected: ["滚动窗口"],
    });
    expect(result.user_answers[1]).toMatchObject({
      id: "Q2",
      selected: ["RocksDB", "HashMap"],
      notes: "记不太准，靠印象选的",
    });

    // Both readers' copies are on the call, keyed by id rather than by position.
    const call = (await quizCallsOf(session.id))[0]!;
    expect(call.status).toBe("answered");
    expect(call.answer).toEqual({
      Q1: { selected: ["滚动窗口"] },
      Q2: { selected: ["RocksDB", "HashMap"], notes: "记不太准，靠印象选的" },
    } satisfies QuizAnswers);
  });

  it("carries an unsure answer through with its reason", async () => {
    const session = await freshSession();
    scriptQuiz("那我从头讲一遍。");

    const first = await chat(session.id, "我想学 Flink");
    const pending = callFrom(first.events);

    await answer(session.id, {
      toolCallId: pending.id,
      action: "submit",
      answers: {
        Q1: { selected: [], unsure: true, unsureReason: "没见过这个词" },
        Q2: { selected: ["RocksDB"] },
      },
    });

    const sent = loopRequests().at(-1) as { messages: { role: string; content: unknown }[] };
    const result = JSON.parse(String(sent.messages.at(-1)!.content)) as {
      user_answers: { id: string; selected: string[]; unsure?: boolean; unsure_reason?: string }[];
    };

    expect(result.user_answers[0]).toEqual({
      id: "Q1",
      question: "Flink 里按时间切分的窗口是哪一种？",
      selected: [],
      unsure: true,
      unsure_reason: "没见过这个词",
    });
    expect(result.user_answers[1]).not.toHaveProperty("unsure");
  });

  it("numbers a later quiz in the same conversation where the first one stopped", async () => {
    // The counter is scoped to the session, not to the call — so Q3 belongs to the second
    // quiz because Q1 and Q2 were asked by the first, even though turns apart. Two quizzes
    // that both started at Q1 would make an id useless as a reference.
    const session = await freshSession();
    llm.setTurns([
      {
        content: "先测两个。",
        toolCalls: [{ id: "call_quiz_a", name: "quiz", args: { questions: QUESTIONS } }],
      },
      {
        content: "再补一个。",
        toolCalls: [{ id: "call_quiz_b", name: "quiz", args: { questions: ONE_QUESTION } }],
      },
      { content: "记住了。" },
    ]);

    const first = await chat(session.id, "我想学 Flink");
    const pendingA = callFrom(first.events);
    expect(
      (JSON.parse(pendingA.input) as { questions: { id: string }[] }).questions.map((q) => q.id)
    ).toEqual(["Q1", "Q2"]);

    // Answering the first quiz resumes the turn, which asks the second and suspends again.
    const resumed = await answer(session.id, {
      toolCallId: pendingA.id,
      action: "submit",
      answers: { Q1: { selected: ["滚动窗口"] }, Q2: { selected: ["RocksDB"] } },
    });
    const pendingB = callFrom(resumed.events);

    expect(resumed.res.statusCode).toBe(200);
    expect(
      (JSON.parse(pendingB.input) as { questions: { id: string }[] }).questions.map((q) => q.id)
    ).toEqual(["Q3"]);
    // Both calls are on record, and no id is shared between them.
    const ids = (await quizCallsOf(session.id)).flatMap((tc) =>
      (JSON.parse(tc.input) as { questions: { id: string }[] }).questions.map((q) => q.id)
    );
    expect(ids).toEqual(["Q1", "Q2", "Q3"]);
  });

  it("records a cancel as a dismissal and lets the model carry on", async () => {
    const session = await freshSession();
    scriptQuiz("那我先随便讲讲。");

    const first = await chat(session.id, "我想学 Flink");
    const pending = callFrom(first.events);

    await answer(session.id, { toolCallId: pending.id, action: "cancel" });

    const call = (await quizCallsOf(session.id))[0]!;
    expect(call.status).toBe("dismissed");
    expect(call.answer).toEqual({});

    const sent = loopRequests().at(-1) as { messages: { role: string; content: unknown }[] };
    expect(String(sent.messages.at(-1)!.content)).toContain("dismissed the quiz");
  });
});

describe("quiz — retiring a quiz the user walked away from", () => {
  it("marks it skipped when a new message arrives, and keeps it out of the next turn", async () => {
    const session = await freshSession();
    scriptQuiz();

    await chat(session.id, "我想学 Flink");
    expect((await pendingOf(session.id)).status).toBe("awaiting");

    // The user ignores the quiz and says something else.
    await chat(session.id, "算了，先讲别的");

    const call = (await quizCallsOf(session.id))[0]!;
    expect(call.status).toBe("skipped");

    // With no `output` the call is dropped from history, so the model is not handed a
    // `tool_calls` block whose result is missing — which OpenAI rejects outright.
    const sent = loopRequests().at(-1) as {
      messages: { role: string; content: unknown; tool_calls?: unknown }[];
    };
    expect(sent.messages.some((m) => m.tool_calls !== undefined)).toBe(false);
    expect(String(sent.messages.at(-1)!.content)).toContain("算了，先讲别的");
  });
});

describe("POST /api/sessions/:id/answers — quiz validation", () => {
  async function pendingFromFirstChat(): Promise<{ session: Session; id: string }> {
    const session = await freshSession();
    scriptQuiz();
    const first = await chat(session.id, "我想学 Flink");
    return { session, id: callFrom(first.events).id };
  }

  it("400s a submission keyed by position, which is ask_user's shape", async () => {
    // The two tools key differently, and this is the seam that catches a payload meant for
    // the other one — it would otherwise be read as "Q1 was not answered".
    const { session, id } = await pendingFromFirstChat();

    const { res } = await answer(session.id, {
      toolCallId: id,
      action: "submit",
      answers: { "0": { selected: ["滚动窗口"] }, "1": { selected: ["RocksDB"] } },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "INVALID_ANSWER" } });
  });

  it("400s an answer that is both unsure and a choice", async () => {
    const { session, id } = await pendingFromFirstChat();

    const { res } = await answer(session.id, {
      toolCallId: id,
      action: "submit",
      answers: {
        Q1: { selected: ["滚动窗口"], unsure: true },
        Q2: { selected: ["RocksDB"] },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "INVALID_ANSWER" } });
  });

  it("400s two choices on a single-select question, but accepts them on the multi one", async () => {
    // Both halves in one test, because the mode is per question and the pair is what proves
    // the arity rule is read from the question rather than from the call.
    const { session, id } = await pendingFromFirstChat();

    const tooMany = await answer(session.id, {
      toolCallId: id,
      action: "submit",
      answers: {
        Q1: { selected: ["滚动窗口", "状态后端"] },
        Q2: { selected: ["RocksDB"] },
      },
    });
    expect(tooMany.res.statusCode).toBe(400);

    const fine = await answer(session.id, {
      toolCallId: id,
      action: "submit",
      answers: {
        Q1: { selected: ["滚动窗口"] },
        Q2: { selected: ["RocksDB", "HashMap"] },
      },
    });
    expect(fine.res.statusCode).toBe(200);
  });

  it("400s a label the model never offered, and leaves the question answerable", async () => {
    const { session, id } = await pendingFromFirstChat();

    const { res } = await answer(session.id, {
      toolCallId: id,
      action: "submit",
      answers: {
        Q1: { selected: ["something injected"] },
        Q2: { selected: ["RocksDB"] },
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "INVALID_ANSWER" } });
    expect((await pendingOf(session.id)).status).toBe("awaiting");
  });

  it("400s notes with nothing selected and no unsure", async () => {
    // Notes are optional, so they cannot be what makes a question answered.
    const { session, id } = await pendingFromFirstChat();

    const { res } = await answer(session.id, {
      toolCallId: id,
      action: "submit",
      answers: { Q1: { selected: [], notes: "有点印象" }, Q2: { selected: ["RocksDB"] } },
    });

    expect(res.statusCode).toBe(400);
  });

  it("409s a second submission of the same quiz", async () => {
    const { session, id } = await pendingFromFirstChat();
    const payload = {
      toolCallId: id,
      action: "submit",
      answers: { Q1: { selected: ["滚动窗口"] }, Q2: { selected: ["RocksDB"] } },
    };

    expect((await answer(session.id, payload)).res.statusCode).toBe(200);

    // A stale tab submitting again must not overwrite the recorded answer or start a second
    // resumed turn.
    const again = await answer(session.id, payload);
    expect(again.res.statusCode).toBe(409);
    expect(again.res.json()).toMatchObject({ error: { code: "QUESTION_NOT_PENDING" } });
  });

  it("409s a call that holds no question set at all", async () => {
    // A `quiz` call whose stored input was not a question set — which is also what a future
    // suspending tool that nobody registered would look like.
    const { session, id } = await pendingFromFirstChat();

    const res = await env.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/answers`,
      payload: { toolCallId: `${id}-nope`, action: "submit", answers: {} },
    });
    expect(res.statusCode).toBe(409);
  });
});
