import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  ChatStreamEvent,
  GetPlanResponse,
  Message,
  PlanView,
  Session,
  ToolCall,
} from "@ilearnassist/shared";
import type { ProviderDef } from "../src/config.js";
import { parseSse } from "./helpers/sse.js";
import { startFakeLlm, type FakeLlm } from "./helpers/fakeLlm.js";
import { newSession, newWorkspace, startTestServer, type TestEnv } from "./helpers/tempEnv.js";

/**
 * The plan widget end to end with only the model faked: widget install assembles the bound
 * tools (bypassing the tool allow-list), the tools commit versioned plans, the conflict call
 * suspends and the answers route commits either fork, and the GET routes read it back.
 */

let llm: FakeLlm;
let env: TestEnv;

const TREE = [
  {
    title: "Chapter 1",
    children: [{ title: "1.1 Intro" }, { title: "1.2 Setup" }],
  },
  { title: "Chapter 2" },
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
  llm.setTitle("Plan conversation");
});

async function planSession(extra: Record<string, unknown> = {}): Promise<Session> {
  const workspace = await newWorkspace(env, `W-${Math.random().toString(36).slice(2)}`);
  return newSession(env, workspace.id, { widgets: ["plan"], ...extra });
}

async function chat(sessionId: string, message = "帮我制定学习计划") {
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

async function getPlan(sessionId: string): Promise<PlanView | null> {
  const res = await env.inject({ method: "GET", url: `/api/sessions/${sessionId}/plan` });
  expect(res.statusCode).toBe(200);
  return (res.json<GetPlanResponse>()).plan;
}

async function messagesOf(sessionId: string): Promise<Message[]> {
  return (
    await env.inject({ method: "GET", url: `/api/sessions/${sessionId}/messages` })
  ).json<Message[]>();
}

async function awaitingMakeCall(sessionId: string): Promise<ToolCall> {
  // The V1 call has the same name and comes first; the conflict call is the awaiting one.
  const messages = await messagesOf(sessionId);
  for (const message of [...messages].reverse()) {
    const call = (message.toolCalls ?? []).find(
      (tc) => tc.name === "ila_make_plan" && (tc.status === "awaiting" || tc.status === "answered" || tc.status === "dismissed")
    );
    if (call) return call;
  }
  throw new Error("no pending ila_make_plan call was persisted");
}

describe("widget-bound plan tools", () => {
  it("assembles the tools only when the plan widget is installed", async () => {
    // Without the widget the tool name is unknown to the loop, and no plan exists.
    const workspace = await newWorkspace(env, "no-widget");
    const plain = await newSession(env, workspace.id);
    llm.setTurns([
      { toolCalls: [{ id: "call_x", name: "ila_make_plan", args: { tree: TREE } }] },
      { content: "done" },
    ]);
    const { events } = await chat(plain.id);
    const end = events.find((e) => e.type === "tool_end");
    expect(end?.type === "tool_end" && end.toolCall.output).toContain("Unknown tool");
    expect(await getPlan(plain.id)).toBeNull();

    // With the widget the same call commits V1.
    const session = await planSession();
    llm.setTurns([
      { content: "好的。", toolCalls: [{ id: "call_plan", name: "ila_make_plan", args: { tree: TREE } }] },
      { content: "计划如下。" },
    ]);
    const made = await chat(session.id);
    expect(made.res.statusCode).toBe(200);
    expect(made.events.some((e) => e.type === "error")).toBe(false);
    const toolEnd = made.events.find((e) => e.type === "tool_end");
    expect(toolEnd?.type === "tool_end" && toolEnd.toolCall.output).toContain('"version": 1');

    const plan = await getPlan(session.id);
    expect(plan).not.toBeNull();
    expect(plan?.version).toBe(1);
    expect(plan?.status).toBe("not_started");
    expect(plan?.tree.map((n) => n.title)).toEqual(["Chapter 1", "Chapter 2"]);
    expect(plan?.versions).toHaveLength(1);
  });

  it("drives progress with the completing call id as the jump anchor", async () => {
    const session = await planSession();
    llm.setTurns([
      { toolCalls: [{ id: "call_plan", name: "ila_make_plan", args: { tree: TREE } }] },
      { content: "计划已建好。" },
    ]);
    await chat(session.id);

    const intro = (await getPlan(session.id))!.tree[0]!.children![0]!;

    llm.setTurns([
      {
        toolCalls: [
          {
            id: "call_progress",
            name: "ila_update_plan_progress",
            args: { nodes: [{ id: intro.id, status: "in_progress" }] },
          },
        ],
      },
      { content: "我们开始。" },
    ]);
    await chat(session.id, "开始吧");
    let plan = await getPlan(session.id);
    expect(plan?.status).toBe("in_progress");
    expect(plan?.tree[0]!.children![0]!.status).toBe("in_progress");

    llm.setTurns([
      {
        toolCalls: [
          {
            id: "call_done",
            name: "ila_update_plan_progress",
            args: { nodes: [{ id: intro.id, status: "completed" }] },
          },
        ],
      },
      { content: "这节学完了。" },
    ]);
    await chat(session.id, "学完了");
    plan = await getPlan(session.id);
    const completed = plan!.tree[0]!.children![0]!;
    expect(completed.status).toBe("completed");
    // The anchor is the first tool call that marked it completed.
    expect(completed.doneToolCallId).toBe("call_done");
  });
});

describe("the create-vs-existing conflict", () => {
  /** Seed V1, then have the model ask to create another plan with no ids. */
  async function suspendedConflict(): Promise<{ session: Session; call: ToolCall }> {
    const session = await planSession();
    llm.setTurns([
      { toolCalls: [{ id: "call_plan", name: "ila_make_plan", args: { tree: TREE } }] },
      { content: "V1" },
    ]);
    await chat(session.id);

    llm.setTurns([
      {
        content: "你想要一个全新的计划？",
        toolCalls: [
          { id: "call_conflict", name: "ila_make_plan", args: { tree: [{ title: "Brand new" }] } },
        ],
      },
    ]);
    const second = await chat(session.id, "我要一个全新的计划");
    expect(second.events.map((e) => e.type)).toContain("tool_start");
    expect(second.events.map((e) => e.type)).not.toContain("tool_end");
    const call = await awaitingMakeCall(session.id);
    expect(call.status).toBe("awaiting");
    return { session, call };
  }

  it("overwrites this plan as a new version when the choice is edit", async () => {
    const { session, call } = await suspendedConflict();
    llm.setTurns([{ content: "已覆盖当前计划。" }]);

    const { res, events } = await answer(session.id, {
      toolCallId: call.id,
      action: "submit",
      answers: { choice: "edit" },
    });

    expect(res.statusCode).toBe(200);
    expect(events.some((e) => e.type === "error")).toBe(false);
    const plan = await getPlan(session.id);
    expect(plan?.version).toBe(2);
    // Wholesale overwrite: old nodes are tombstones, the new tree is the single root.
    expect(plan?.tree.some((n) => n.status === "deleted")).toBe(true);
    expect(plan?.tree.filter((n) => n.status !== "deleted").map((n) => n.title)).toEqual([
      "Brand new",
    ]);
    const recorded = await awaitingMakeCall(session.id);
    expect(recorded.status).toBe("answered");
    expect(recorded.answer).toEqual({ choice: "edit" });
  });

  it("creates another conversation with V1 and switches to it for new_session", async () => {
    const { session, call } = await suspendedConflict();
    llm.setTurns([{ content: "已在新会话中创建。" }]);

    const { res, events } = await answer(session.id, {
      toolCallId: call.id,
      action: "submit",
      answers: { choice: "new_session" },
    });

    expect(res.statusCode).toBe(200);
    const nav = events.find((e) => e.type === "plan_session_created");
    expect(nav?.type === "plan_session_created").toBe(true);
    const newSessionId = nav?.type === "plan_session_created" ? nav.sessionId : "";
    expect(newSessionId).not.toBe(session.id);

    // The new conversation exists, carries the plan widget, and owns V1 of the new plan.
    const newPlan = await getPlan(newSessionId);
    expect(newPlan?.version).toBe(1);
    expect(newPlan?.tree.map((n) => n.title)).toEqual(["Brand new"]);

    const widgets = (
      await env.inject({ method: "GET", url: `/api/sessions/${newSessionId}/widgets` })
    ).json<{ session: { id: string; enabled: boolean }[] }>();
    expect(widgets.session.find((w) => w.id === "plan")?.enabled).toBe(true);

    // The old conversation's call records the decision and where it went.
    const recorded = await awaitingMakeCall(session.id);
    expect(recorded.status).toBe("answered");
    expect(recorded.answer).toEqual({ choice: "new_session", newSessionId });
    // The old conversation is untouched: still V1 with its own tree.
    expect((await getPlan(session.id))?.version).toBe(1);
  });

  it("rejects a choice that is neither fork", async () => {
    const { session, call } = await suspendedConflict();
    const { res } = await answer(session.id, {
      toolCallId: call.id,
      action: "submit",
      answers: { choice: "maybe" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("dismisses without writing anything", async () => {
    const { session, call } = await suspendedConflict();
    llm.setTurns([{ content: "好的，保持现有计划。" }]);
    const { res } = await answer(session.id, { toolCallId: call.id, action: "cancel" });
    expect(res.statusCode).toBe(200);
    const recorded = await awaitingMakeCall(session.id);
    expect(recorded.status).toBe("dismissed");
    expect((await getPlan(session.id))?.version).toBe(1);
  });
});

describe("GET plan routes", () => {
  it("answers {plan:null} with no plan, and 404s a missing version", async () => {
    const session = await planSession();
    expect(await getPlan(session.id)).toBeNull();

    llm.setTurns([
      { toolCalls: [{ id: "call_plan", name: "ila_make_plan", args: { tree: TREE } }] },
      { content: "ok" },
    ]);
    await chat(session.id);

    const missing = await env.inject({
      method: "GET",
      url: `/api/sessions/${session.id}/plan/versions/9`,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: "PLAN_VERSION_NOT_FOUND" } });

    const v1 = await env.inject({
      method: "GET",
      url: `/api/sessions/${session.id}/plan/versions/1`,
    });
    expect(v1.statusCode).toBe(200);
    expect(v1.json()).toMatchObject({ version: 1 });
  });

  it("hides another account's plan behind a 404", async () => {
    const session = await planSession();
    llm.setTurns([
      { toolCalls: [{ id: "call_plan", name: "ila_make_plan", args: { tree: TREE } }] },
      { content: "ok" },
    ]);
    await chat(session.id);

    const other = await env.asUser("intruder");
    const res = await other.inject({ method: "GET", url: `/api/sessions/${session.id}/plan` });
    expect(res.statusCode).toBe(404);
  });
});
