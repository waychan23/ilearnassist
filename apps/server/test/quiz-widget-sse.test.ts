import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  ChatStreamEvent,
  GetQuizQuestionsResponse,
  GetPlanResponse,
  QuizQuestionView,
  Session,
} from "@ilearnassist/shared";
import type { ProviderDef } from "../src/config.js";
import { parseSse } from "./helpers/sse.js";
import { startFakeLlm, type FakeLlm } from "./helpers/fakeLlm.js";
import { newSession, newWorkspace, startTestServer, type TestEnv } from "./helpers/tempEnv.js";

/**
 * The quiz widget end to end with only the model faked: the widget install assembles both
 * quiz tools (bypassing the allow-list), a suspending quiz registers pending rows, a
 * submission answers them and the resumed turn grades them through `ila_review_quiz`, a
 * walked-away quiz is skipped, and the make-up POST re-opens one skipped row for a later
 * turn to grade — always the SAME row, never a duplicate.
 */

let llm: FakeLlm;
let env: TestEnv;

const QUESTIONS = [
  {
    header: "窗口",
    question: "Flink 里按时间切分的窗口是哪一种？",
    options: [{ label: "滚动窗口" }, { label: "状态后端" }],
  },
  {
    header: "状态",
    question: "下面哪一个是状态后端？",
    options: [{ label: "RocksDB" }, { label: "Kafka" }],
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
  llm.setTitle("Quiz Widget Conversation");
});

async function quizSession(extra: Record<string, unknown> = {}): Promise<Session> {
  const workspace = await newWorkspace(env, `W-${Math.random().toString(36).slice(2)}`);
  return newSession(env, workspace.id, { widgets: ["quiz"], ...extra });
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

async function quizRows(sessionId: string): Promise<QuizQuestionView[]> {
  const res = await env.inject({ method: "GET", url: `/api/sessions/${sessionId}/quizzes` });
  expect(res.statusCode).toBe(200);
  return res.json<GetQuizQuestionsResponse>().questions;
}

const callIdFrom = (events: ChatStreamEvent[]): string =>
  (events.find((e) => e.type === "message_done") as { message: { toolCalls: { id: string }[] } })
    .message.toolCalls[0]!.id;

const quizScript = (args: Record<string, unknown> = { questions: QUESTIONS }) =>
  [{ id: "call_quiz", name: "ila_quiz", args }];

describe("widget gating", () => {
  it("does not assemble ila_quiz without the widget, even with every tool allowed", async () => {
    const workspace = await newWorkspace(env, "no-quiz-widget");
    const plain = await newSession(env, workspace.id);
    llm.setTurns([
      { toolCalls: quizScript() },
      { content: "done" },
    ]);
    const { events } = await chat(plain.id, "测测我");
    const end = events.find((e) => e.type === "tool_end");
    expect(end?.type === "tool_end" && end.toolCall.output).toContain("Unknown tool");
    expect(await quizRows(plain.id)).toEqual([]);
  });

  it("assembles the quiz tools with the widget, including an empty tool allow-list", async () => {
    const locked = await quizSession({ allTools: false, tools: [] });
    llm.setTurns([
      { content: "先测一下。", toolCalls: quizScript() },
    ]);
    const { events } = await chat(locked.id, "开始");
    expect(events.some((e) => e.type === "error")).toBe(false);
    const done = events.find((e) => e.type === "message_done");
    expect(done?.type === "message_done" && done.message.toolCalls?.[0]).toMatchObject({
      name: "ila_quiz",
      status: "awaiting",
    });
    expect(await quizRows(locked.id)).toHaveLength(2);
  });

  it("picks up a widget installed mid-conversation", async () => {
    const workspace = await newWorkspace(env, "mid-install");
    const session = await newSession(env, workspace.id);
    llm.setTurns([{ toolCalls: quizScript() }, { content: "done" }]);
    await chat(session.id, "测测我");
    expect(await quizRows(session.id)).toEqual([]);

    const toggle = await env.inject({
      method: "PUT",
      url: `/api/sessions/${session.id}/widgets/quiz`,
      payload: { enabled: true },
    });
    expect(toggle.statusCode).toBe(200);

    llm.reset();
    llm.setTurns([{ toolCalls: quizScript() }]);
    await chat(session.id, "再来");
    expect(await quizRows(session.id)).toHaveLength(2);
  });
});

describe("quiz rows follow the call", () => {
  it("registers pending rows at suspension and answers them with the submission", async () => {
    const session = await quizSession();
    llm.setTurns([
      { content: "先测一下。", toolCalls: quizScript() },
    ]);
    const { events } = await chat(session.id, "我想学 Flink");
    const toolCallId = callIdFrom(events);

    let rows = await quizRows(session.id);
    expect(rows.map((q) => [q.qid, q.status])).toEqual([
      ["Q1", "pending"],
      ["Q2", "pending"],
    ]);
    expect(rows[0]!.toolCallId).toBe(toolCallId);

    // The resumed turn grades via the widget-bound review tool, which proves the tool is
    // assembled on a resumed turn as well as a fresh one.
    llm.setTurns([
      {
        toolCalls: [
          {
            id: "call_grade",
            name: "ila_review_quiz",
            args: {
              reviews: [
                { quizId: rows[0]!.id, verdict: "correct", explanation: "答对了。" },
                { quizId: rows[1]!.id, verdict: "incorrect", explanation: "应选 RocksDB。" },
              ],
            },
          },
        ],
      },
      { content: "第一题对，第二题错。" },
    ]);

    const { res } = await answer(session.id, {
      toolCallId,
      action: "submit",
      answers: {
        Q1: { selected: ["滚动窗口"] },
        Q2: { selected: ["Kafka"] },
      },
    });
    expect(res.statusCode).toBe(200);

    rows = await quizRows(session.id);
    expect(rows.map((q) => q.status)).toEqual(["answered", "answered"]);
    expect(rows[0]).toMatchObject({ verdict: "correct", feedback: "答对了。" });
    expect(rows[1]).toMatchObject({ verdict: "incorrect", feedback: "应选 RocksDB。" });
  });

  it("dismisses the rows when the whole quiz is cancelled", async () => {
    const session = await quizSession();
    llm.setTurns([{ toolCalls: quizScript() }, { content: "好。" }]);
    const { events } = await chat(session.id, "开始");
    await answer(session.id, { toolCallId: callIdFrom(events), action: "cancel" });
    expect((await quizRows(session.id)).map((q) => q.status)).toEqual(["dismissed", "dismissed"]);
  });

  it("skips the rows when the user walks away", async () => {
    const session = await quizSession();
    llm.setTurns([{ toolCalls: quizScript() }, { content: "好。" }]);
    await chat(session.id, "开始");
    llm.reset();
    llm.setTurns([{ content: "先讲别的。" }]);
    await chat(session.id, "算了先讲别的");
    expect((await quizRows(session.id)).map((q) => q.status)).toEqual(["skipped", "skipped"]);
  });
});

describe("the make-up POST", () => {
  async function skippedQuiz(): Promise<{ session: Session; row: QuizQuestionView }> {
    const session = await quizSession();
    llm.setTurns([{ toolCalls: quizScript() }, { content: "好。" }]);
    await chat(session.id, "开始");
    llm.reset();
    llm.setTurns([{ content: "先讲别的。" }]);
    await chat(session.id, "先讲别的");
    const row = (await quizRows(session.id))[0]!;
    return { session, row };
  }

  it("answers a skipped question on the same row, which a later turn grades once", async () => {
    const { session, row } = await skippedQuiz();

    const post = await env.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/quizzes/${row.id}/answer`,
      payload: { answer: { selected: ["滚动窗口"] } },
    });
    expect(post.statusCode).toBe(200);
    expect(post.json<{ question: QuizQuestionView }>().question.id).toBe(row.id);

    const rows = await quizRows(session.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: row.id, status: "answered", verdict: null });

    // The follow-up chat turn grades the SAME id; still exactly two rows.
    llm.setTurns([
      {
        toolCalls: [
          {
            id: "call_grade_late",
            name: "ila_review_quiz",
            args: {
              reviews: [{ quizId: row.id, verdict: "correct", explanation: "补答正确。" }],
            },
          },
        ],
      },
      { content: "这次对了。" },
    ]);
    await chat(session.id, "补答：Q1 我选滚动窗口");

    const after = await quizRows(session.id);
    expect(after).toHaveLength(2);
    expect(after.find((q) => q.id === row.id)).toMatchObject({
      status: "answered",
      verdict: "correct",
      feedback: "补答正确。",
    });
  });

  it("409s a question that is answered or pending", async () => {
    const session = await quizSession();
    llm.setTurns([{ toolCalls: quizScript() }]);
    const { events } = await chat(session.id, "开始");
    const pendingId = (await quizRows(session.id))[0]!.id;

    const pending = await env.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/quizzes/${pendingId}/answer`,
      payload: { answer: { selected: ["滚动窗口"] } },
    });
    expect(pending.statusCode).toBe(409);
    expect(pending.json()).toMatchObject({ error: { code: "QUIZ_NOT_ANSWERABLE" } });

    // Answered after a normal submit is refused too.
    llm.setTurns([{ content: "好。" }]);
    await answer(session.id, {
      toolCallId: callIdFrom(events),
      action: "submit",
      answers: { Q1: { selected: ["滚动窗口"] }, Q2: { selected: ["RocksDB"] } },
    });
    const answered = await env.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/quizzes/${pendingId}/answer`,
      payload: { answer: { selected: ["滚动窗口"] } },
    });
    expect(answered.statusCode).toBe(409);
  });

  it("400s an answer that picks an option never offered", async () => {
    const { session, row } = await skippedQuiz();
    const res = await env.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/quizzes/${row.id}/answer`,
      payload: { answer: { selected: ["瞎选"] } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "INVALID_ANSWER" } });
  });

  it("404s an unknown id", async () => {
    const { session } = await skippedQuiz();
    const res = await env.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/quizzes/no-such-id/answer`,
      payload: { answer: { selected: ["滚动窗口"] } },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "QUIZ_QUESTION_NOT_FOUND" } });
  });

  it("lets a question cancelled with its quiz be made up like a skipped one", async () => {
    const session = await quizSession();
    llm.setTurns([{ toolCalls: quizScript() }, { content: "好。" }]);
    const { events } = await chat(session.id, "开始");
    await answer(session.id, { toolCallId: callIdFrom(events), action: "cancel" });
    const row = (await quizRows(session.id))[0]!;
    expect(row.status).toBe("dismissed");

    const post = await env.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/quizzes/${row.id}/answer`,
      payload: { answer: { selected: ["滚动窗口"] } },
    });
    expect(post.statusCode).toBe(200);
    const rows = await quizRows(session.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: row.id, status: "answered", verdict: null });
  });
});

describe("plan node binding", () => {
  const PLAN_TREE = [{ title: "第一章", children: [{ title: "窗口模型" }] }];

  async function plannedSession(): Promise<{ session: Session; nodeId: string }> {
    const workspace = await newWorkspace(env, `W-${Math.random().toString(36).slice(2)}`);
    const session = await newSession(env, workspace.id, { widgets: ["plan", "quiz"] });
    llm.setTurns([
      { toolCalls: [{ id: "call_plan", name: "ila_make_plan", args: { tree: PLAN_TREE } }] },
      { content: "计划好了。" },
    ]);
    await chat(session.id, "做个计划");
    const plan = (
      await env.inject({ method: "GET", url: `/api/sessions/${session.id}/plan` })
    ).json<GetPlanResponse>().plan!;
    const nodeId = plan.tree[0]!.children![0]!.id;
    return { session, nodeId };
  }

  it("binds a quiz to the chapter in progress automatically", async () => {
    const { session, nodeId } = await plannedSession();
    llm.setTurns([
      {
        toolCalls: [
          {
            id: "call_progress",
            name: "ila_update_plan_progress",
            args: { nodes: [{ id: nodeId, status: "in_progress" }] },
          },
        ],
      },
      { content: "开始。" },
    ]);
    await chat(session.id, "开始第一章");

    llm.setTurns([{ toolCalls: quizScript() }]);
    await chat(session.id, "测一下");
    const row = (await quizRows(session.id))[0]!;
    expect(row.nodeId).toBe(nodeId);
    expect(row.nodeTitle).toBe("窗口模型");
  });

  it("honours the model's explicit node id", async () => {
    const { session } = await plannedSession();
    const plan = (
      await env.inject({ method: "GET", url: `/api/sessions/${session.id}/plan` })
    ).json<GetPlanResponse>().plan!;
    const rootId = plan.tree[0]!.id;

    llm.setTurns([{ toolCalls: quizScript({ nodeId: rootId, questions: [QUESTIONS[0]] }) }]);
    await chat(session.id, "测一下整章");
    expect((await quizRows(session.id))[0]).toMatchObject({
      nodeId: rootId,
      nodeTitle: "第一章",
    });
  });

  it("turns an invalid node id into a tool error and registers nothing", async () => {
    const { session } = await plannedSession();
    llm.setTurns([
      { toolCalls: quizScript({ nodeId: "no-such-node", questions: [QUESTIONS[0]] }) },
      { content: "出错了。" },
    ]);
    const { events } = await chat(session.id, "测一下");
    const end = events.find((e) => e.type === "tool_end");
    expect(end?.type === "tool_end" && end.toolCall.output).toContain("not a live node");
    expect(await quizRows(session.id)).toEqual([]);
  });
});
