import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  ChatStreamEvent,
  ContextState,
  Message,
  Session,
  Workspace,
} from "@ilearnassist/shared";
import { parseSse } from "./helpers/sse.js";
import { startFakeLlm, type FakeLlm } from "./helpers/fakeLlm.js";
import {
  newSession,
  newWorkspace,
  providerFor,
  startTestServer,
  type TestEnv,
} from "./helpers/tempEnv.js";

/**
 * The experimental smart-context mode, over the real routes and the real database.
 *
 * What each case is really about: *what the next turn sends*. The mode is a session setting; the
 * mechanism is the window `trimHistory` applies; and the assertion that makes the feature true is
 * the body the fake model received — the newest two history messages and nothing else, with the
 * prompt saying so and the built-in reads available to look the rest up.
 *
 * The mode deliberately does not touch compaction state: the summary row and the session's pointer
 * stay exactly as they were, and turning the mode off restores the compacted context. That half is
 * asserted as carefully as the window itself, because "the summary is kept" is the reason the two
 * modes can coexist at all.
 */

let llm: FakeLlm;
let env: TestEnv;
let workspace: Workspace;

/** The marker the compactor's own system prompt carries — see `fakeLlm.ts`. */
const COMPACT_MARKER = "context-compression function";
const SUMMARY = "Recap: the learner asked about recursion twice.";
/** A phrase only the smart-context prompt block carries. */
const SMART_MARKER = "smart context mode";

beforeAll(async () => {
  llm = await startFakeLlm();
  env = await startTestServer({
    providers: [providerFor(llm)],
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

async function setSmartContext(sessionId: string, value: unknown) {
  return env.inject({
    method: "PATCH",
    url: `/api/sessions/${sessionId}`,
    payload: { settings: { smartContext: value } },
  });
}

async function compact(sessionId: string) {
  return env.inject({ method: "POST", url: `/api/sessions/${sessionId}/context/compact` });
}

/** The agent-turn request carrying a phrase, out of everything the fake recorded. */
function requestWith(phrase: string): Record<string, unknown> {
  const found = llm.requests().find((r) => JSON.stringify(r).includes(phrase));
  if (!found) throw new Error(`no request carried ${JSON.stringify(phrase)}`);
  return found;
}

function bodyOf(request: Record<string, unknown>): {
  messages: { role: string; content: unknown }[];
} {
  return request as { messages: { role: string; content: unknown }[] };
}

async function sessionWithTwoTurns(): Promise<Session> {
  const session = await newSession(env, workspace.id);
  llm.script([{ content: "first answer" }]);
  await chat(session.id, "first question");
  llm.script([{ content: "second answer" }]);
  await chat(session.id, "second question");
  return session;
}

describe("smart context mode", () => {
  it("sends only the newest two history messages, and no summary, while it is on", async () => {
    const session = await sessionWithTwoTurns();
    // Compact first, so the mode is proven to win over an active summary rather than over
    // nothing: the summary would otherwise be in both the prompt and (through the point) the
    // history.
    expect((await compact(session.id)).statusCode).toBe(200);
    expect((await setSmartContext(session.id, true)).statusCode).toBe(200);

    llm.script([{ content: "third answer" }]);
    await chat(session.id, "third question");

    const sent = bodyOf(requestWith("third question"));
    const wire = JSON.stringify(sent.messages);
    // The window: the second exchange verbatim, the first gone, and no summary block at all.
    expect(wire).toContain("second question");
    expect(wire).toContain("second answer");
    expect(wire).not.toContain("first question");
    expect(wire).not.toContain("first answer");
    expect(wire).not.toContain("<conversation_summary>");
    expect(wire).not.toContain(SUMMARY);

    // Exactly system + two history messages + the live question.
    expect(sent.messages).toHaveLength(4);
    expect(sent.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(String(sent.messages[0]!.content)).toContain(SMART_MARKER);
  });

  it("restores the same compacted context when the mode is turned off", async () => {
    const session = await sessionWithTwoTurns();
    await compact(session.id);
    await setSmartContext(session.id, true);

    llm.script([{ content: "third answer" }]);
    await chat(session.id, "third question");
    // The turn written under the mode carries no summary id — it did not run under one.
    const afterSmart = await messagesOf(session.id);
    expect(afterSmart[afterSmart.length - 1]!.summaryId).toBeUndefined();

    await setSmartContext(session.id, false);
    llm.script([{ content: "fourth answer" }]);
    await chat(session.id, "fourth question");

    const wire = JSON.stringify(bodyOf(requestWith("fourth question")).messages);
    // The compaction is in force again, exactly as it was: the summary plus everything after
    // its point — which now includes the turn the smart window ran.
    expect(wire).toContain("<conversation_summary>");
    expect(wire).toContain(SUMMARY);
    expect(wire).toContain("third question");
    expect(wire).toContain("fourth question");
    expect(wire).not.toContain("first question");

    // And the stored state was never rewritten: the pointer still names the same summary.
    const state = await contextOf(session.id);
    expect(state.summary?.content).toBe(SUMMARY);
  });

  it("lets the agent recall what the window left out", async () => {
    const session = await sessionWithTwoTurns();
    await setSmartContext(session.id, true);

    // The model notices the earlier history is missing and searches the stored transcript —
    // the loop the mode exists to produce, and why `ila_recall` is built-in.
    llm.script([
      {
        content: "让我查一下之前那段话。",
        toolCalls: [{ name: "ila_recall", args: { mode: "search", query: "first question" } }],
      },
      { content: "找到了：你当时问的是第一个问题。" },
    ]);
    await chat(session.id, "第三个问题");

    const messages = await messagesOf(session.id);
    const call = (messages[messages.length - 1]!.toolCalls ?? []).find(
      (c) => c.name === "ila_recall"
    );
    expect(call?.output).toContain("first question");

    // And the model saw it: the step after the tool call carried the recalled text as a tool
    // result, even though the message it recalls is outside the window.
    const sawIt = llm.requests().filter((r) => {
      const history = (r as { messages?: { role?: string; content?: unknown }[] }).messages ?? [];
      return history.some(
        (m) => m.role === "tool" && JSON.stringify(m.content).includes("first question")
      );
    });
    expect(sawIt).toHaveLength(1);
  });

  it("regenerates from a window that may open on an assistant message", async () => {
    /*
     * The shape the loop test pins at the unit level, here over the real route: after the peel,
     * the newest two are [first answer, second question], so the request opens on an assistant
     * row. That is valid and deliberate — advancing to a user turn would drop the answer the
     * regenerate is being asked to replace.
     */
    const session = await sessionWithTwoTurns();
    await setSmartContext(session.id, true);

    llm.script([{ content: "regenerated answer" }]);
    const res = await env.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/regenerate`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);

    const streaming = llm.requests().filter((r) => (r as { stream?: boolean }).stream === true);
    const sent = bodyOf(streaming[streaming.length - 1]!);
    expect(sent.messages.map((m) => m.role)).toEqual(["system", "assistant", "user"]);
    expect(JSON.stringify(sent.messages)).toContain("first answer");
    expect(JSON.stringify(sent.messages)).toContain("second question");
    expect(JSON.stringify(sent.messages)).not.toContain("first question");
  });

  it("offers the built-in reads even when the allow-list is empty", async () => {
    /*
     * `ila_query` and `ila_recall` are `BUILTIN_TOOL_NAMES`: a conversation whose Copilot
     * allow-list says "no tools" asked for no capabilities, not for amnesia — and the smart
     * prompt names both as the way back. Asserted through a real turn rather than by calling
     * `buildTools`, because the allow-list is applied where the request is assembled.
     */
    const session = await newSession(env, workspace.id, { settings: { smartContext: true } });
    const patched = await env.inject({
      method: "PATCH",
      url: `/api/sessions/${session.id}`,
      payload: { allTools: false, tools: [] },
    });
    expect(patched.statusCode).toBe(200);

    llm.script([{ content: "ok" }]);
    await chat(session.id, "hello");

    const request = llm.requests().find((r) => Array.isArray(r.tools));
    expect(request).toBeDefined();
    const names = (request!.tools as { function?: { name?: string } }[]).map(
      (t) => t.function?.name
    );
    expect(names).toEqual(expect.arrayContaining(["ila_query", "ila_recall"]));
    // The allow-list still means "no capabilities": nothing else is smuggled in beside them.
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("web_search");
  });

  it("refuses a smartContext that is not a boolean, rather than coercing it", async () => {
    // `"false"` is truthy, so a coerced write would store `1` while the switch read "off" — the
    // one direction a settings blob cannot walk back. Refused by name, like `workspaceScope`.
    const session = await newSession(env, workspace.id);

    const res = await setSmartContext(session.id, "true");
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("INVALID_FIELD");

    // And nothing was stored: the conversation's settings blob never gained the field.
    const found = env.server.db.getSessionForUser(session.id, env.user.id);
    expect(found?.session.settings.smartContext).toBeUndefined();
  });

  it("answers 404 for a conversation that is not this account's", async () => {
    const res = await setSmartContext("does-not-exist", true);
    expect(res.statusCode).toBe(404);
  });
});
