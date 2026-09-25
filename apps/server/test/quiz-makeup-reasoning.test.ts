import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ChatStreamEvent } from "@ilearnassist/shared";
import { parseSse } from "./helpers/sse.js";
import { startFakeLlm, type FakeLlm } from "./helpers/fakeLlm.js";
import { newSession, newWorkspace, providerFor, startTestServer, type TestEnv } from "./helpers/tempEnv.js";

/**
 * The thinking-mode passback rule, asserted over the make-up flows.
 *
 * DeepSeek's V4 thinking mode refuses a request whose `messages` contain an assistant message with
 * `tool_calls` and no `reasoning_content`:
 *
 *     400 The `reasoning_content` in the thinking mode must be passed back to the API.
 *
 * and it stays refused — the offending message is in history, so every later turn fails too. The
 * fix is the field's **presence**, with the empty string an accepted value (several client
 * libraries hit exactly this and pass it back verbatim as `""`).
 *
 * A make-up is the flow that walks into it: the answers arrive as a call the **server** wrote,
 * whose message has no reasoning of its own to record. So this file does not assert that a
 * particular message is right — it runs each door to a make-up, then checks the rule against every
 * request the run actually sent. That is the shape that catches the next hole rather than this one.
 */

let llm: FakeLlm;
/** A model record that declares `reasoning`: the configuration the replay is gated on. */
let env: TestEnv;
/** And one that does not, which is the state a user with a thinking-on provider is in. */
let plainEnv: TestEnv;

const QUESTIONS = [
  {
    header: "窗口",
    question: "Flink 里按时间切分的窗口是哪一种？",
    options: [{ label: "滚动窗口" }, { label: "状态后端" }],
    referenceAnswer: ["滚动窗口"],
    explanation: "按时间切分的是滚动窗口。",
  },
  {
    header: "状态",
    question: "下面哪一个是状态后端？",
    options: [{ label: "RocksDB" }, { label: "Kafka" }],
  },
];

beforeAll(async () => {
  llm = await startFakeLlm();
  /*
   * Two servers over one fake provider, because the two questions this file asks are answered by
   * *different configurations*: the rule is about a model that declares `reasoning` (the replay is
   * gated on the record), and the recovery is about one that does not. A single env would have to
   * pick one and would be asserting the other from a state it never reaches.
   */
  env = await startTestServer({
    providers: [providerFor(llm, { capabilities: ["tool_use", "reasoning"] })],
    defaultProvider: "fake",
    defaultModel: "fake-model",
  });
  plainEnv = await startTestServer({
    providers: [providerFor(llm, { capabilities: ["tool_use"] })],
    defaultProvider: "fake",
    defaultModel: "fake-model",
  });
});

afterAll(async () => {
  await env.cleanup();
  await plainEnv.cleanup();
  await llm.close();
});

beforeEach(() => {
  llm.reset();
  llm.setTitle("Reasoning passback");
});

/** Every assistant message that carries tool calls but no `reasoning_content`, described. */
function breaches(): string[] {
  const out: string[] = [];
  for (const request of llm.requests()) {
    // A refused request is the one the provider rejected — for the recovery cases it is the
    // subject of the test rather than evidence about the request the app *meant* to send.
    if (llm.refusedRequests().includes(request)) continue;
    const messages = request.messages;
    if (!Array.isArray(messages)) continue;
    for (const [at, message] of (messages as Record<string, unknown>[]).entries()) {
      if (!message || message.role !== "assistant") continue;
      const calls = message.tool_calls;
      if (!Array.isArray(calls) || calls.length === 0) continue;
      // The key must be there — `""` is a value the provider itself sends, an absent key is what
      // it refuses.
      if (!Object.prototype.hasOwnProperty.call(message, "reasoning_content")) {
        out.push(`message ${at} (${String(calls[0] && (calls[0] as { name?: string }).name)})`);
      }
    }
  }
  return out;
}

const streamRequests = (): Record<string, unknown>[] => llm.requests().filter((r) => r.stream === true);

async function quizSession(target: TestEnv = env): Promise<string> {
  const workspace = await newWorkspace(target, `W-${Math.random().toString(36).slice(2)}`);
  const session = await newSession(target, workspace.id, { widgets: ["quiz"] });
  return session.id;
}

async function chat(sessionId: string, message: string, target: TestEnv = env) {
  const res = await target.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/chat`,
    payload: { message },
  });
  return { res, events: parseSse(res.body) as ChatStreamEvent[] };
}

/** A quiz posed and then walked away from: the state both make-up doors start from. */
async function skippedQuiz(target: TestEnv = env): Promise<string> {
  const sessionId = await quizSession(target);
  llm.setTurns([
    {
      content: "先测一下。",
      toolCalls: [{ id: "call_quiz", name: "ila_quiz", args: { questions: QUESTIONS } }],
    },
  ]);
  await chat(sessionId, "开始", target);
  llm.reset();
  llm.setTurns([{ content: "先讲别的。" }]);
  await chat(sessionId, "先讲别的", target);
  return sessionId;
}

/**
 * The refusal, verbatim, as the provider sends it.
 *
 * A recorder for the one flow this file is about, not decoration: the recovery is triggered by
 * these words, so a test that used a paraphrased error would pass against an implementation that
 * recognised nothing.
 */
const REFUSAL = {
  status: 400,
  message: "The `reasoning_content` in the thinking mode must be passed back to the API.",
};

describe("the thinking-mode passback rule", () => {
  it("holds across a live quiz answer", async () => {
    const workspace = await newWorkspace(env, `W-${Math.random().toString(36).slice(2)}`);
    const session = await newSession(env, workspace.id, { widgets: ["quiz"] });
    llm.setTurns([
      { toolCalls: [{ id: "call_quiz", name: "ila_quiz", args: { questions: QUESTIONS } }] },
    ]);
    const { events } = await chat(session.id, "开始");
    const toolCallId = (
      events.find((e) => e.type === "message_done") as { message: { toolCalls: { id: string }[] } }
    ).message.toolCalls[0]!.id;

    llm.setTurns([{ content: "好。" }]);
    await env.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/answers`,
      payload: {
        toolCallId,
        action: "submit",
        answers: { Q1: { selected: ["滚动窗口"] }, Q2: { selected: ["RocksDB"] } },
      },
    });

    expect(breaches()).toEqual([]);
    expect(streamRequests().length).toBeGreaterThan(1);
  });

  it("holds across a make-up the learner submits in the card", async () => {
    /*
     * The reported failure. The make-up's own record is a call the server wrote, so its message
     * has no reasoning to record — and an assistant tool-call message without the field is exactly
     * what the provider refuses.
     */
    const sessionId = await skippedQuiz();
    llm.reset();
    llm.setTurns([{ content: "这次对了。" }]);

    const res = await env.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/quizzes/makeup`,
      payload: { answers: { Q1: { selected: ["滚动窗口"] } } },
    });
    expect(res.statusCode).toBe(200);

    expect(breaches()).toEqual([]);
  });

  it("holds across a make-up the model opens itself", async () => {
    const sessionId = await skippedQuiz();
    llm.reset();
    llm.setTurns([
      { content: "补一下吧。", toolCalls: [{ id: "call_makeup", name: "ila_makeup_quiz", args: {} }] },
    ]);
    const { events } = await chat(sessionId, "把上次跳过的题给我补一下");
    const toolCallId = (
      events.find((e) => e.type === "message_done") as { message: { toolCalls: { id: string }[] } }
    ).message.toolCalls[0]!.id;

    llm.setTurns([{ content: "好。" }]);
    await env.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/answers`,
      payload: { toolCallId, action: "submit", answers: { Q1: { selected: ["滚动窗口"] } } },
    });

    expect(breaches()).toEqual([]);
  });

  it("holds on a turn that used tools in an earlier step", async () => {
    // The loop's own assistant message from step one is replayed into step two — built in memory
    // rather than read from the history, which is the other way a tool-call message can arrive
    // without a reasoning value behind it.
    const sessionId = await quizSession();
    llm.setTurns([
      {
        content: "看一眼。",
        toolCalls: [{ id: "call_files", name: "list_files", args: { path: "" } }],
      },
      { content: "看完了。" },
    ]);
    await chat(sessionId, "工作区里有什么");

    expect(breaches()).toEqual([]);
    expect(streamRequests().length).toBeGreaterThan(1);
  });
});

describe("recovering from the refusal", () => {
  /*
   * The shape a user actually hits: a provider in thinking mode whose **model record does not say
   * so**. The record is what gates the replay (rightly — a provider without the field rejects an
   * unknown argument), so the turn goes out without it and is refused. The recovery is the
   * refusal itself: the wrapper echoes the field and re-sends the one request.
   *
   * Worth stating why this is not "just a config fix": the gate is right in principle and wrong
   * about particular providers — DeepSeek V4 turns thinking on by default and its id contains none
   * of the words `guessCapabilities` looks for — and the cost of the mismatch is every turn that
   * replays a tool call, which is most of a working conversation.
   */
  it("re-sends the refused request with the field echoed, and the turn completes", async () => {
    const sessionId = await skippedQuiz(plainEnv);
    llm.reset();
    llm.setTurns([
      { fail: REFUSAL },
      { content: "这次对了。" },
    ]);

    const res = await plainEnv.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/quizzes/makeup`,
      payload: { answers: { Q1: { selected: ["滚动窗口"] } } },
    });
    expect(res.statusCode).toBe(200);

    // The first request is the one that was refused; the second is the same conversation with the
    // field on it, which is what makes the retry worth doing rather than merely a second attempt.
    const streams = streamRequests();
    expect(streams).toHaveLength(2);
    expect(breaches()).toEqual([]);

    const second = streams[1] as { messages?: Record<string, unknown>[] };
    const toolCallMessage = (second.messages ?? []).find(
      (m) => Array.isArray(m.tool_calls) && (m.tool_calls as unknown[]).length > 0
    );
    // `""` is the value: nothing was recorded for the call the server wrote, and the provider
    // wants the field present rather than the text.
    expect(toolCallMessage).toMatchObject({ reasoning_content: "" });
  });

  it("leaves a plain refusal alone", async () => {
    // Anything else a 400 can mean — a bad parameter, a revoked key — must reach the caller as
    // itself. A retry here would be a second request sent for a reason the error did not state.
    const sessionId = await quizSession(plainEnv);
    llm.setTurns([{ fail: { status: 400, message: "Unrecognized request argument: foo" } }]);

    const { res } = await chat(sessionId, "你好", plainEnv);
    expect(res.statusCode).toBe(200);
    expect(streamRequests()).toHaveLength(1);
  });
});
