import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ChatStreamEvent, GetSessionPreferencesResponse, SessionWidgets } from "@ilearnassist/shared";
import { newId } from "../src/db.js";
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
 * User preferences over the real routes: the tool's write, the injected block, the query read
 * and the manual extraction.
 *
 * The assertion that makes injection true is the body the fake model received — the same
 * proof-shape `smart-context.test.ts` uses, because "was the block in the system prompt" is a
 * fact about the wire rather than about the UI. The extraction's cases run the real out-of-band
 * call against a scripted fake answer, so the route's parse, its conflict handling and its
 * refusal envelope are all exercised end to end.
 */

let llm: FakeLlm;
let env: TestEnv;

/** The marker `preference.system` carries — see `fakeLlm.ts`. */
const EXTRACT_MARKER = "user-preference extraction function";
/** A phrase only the injected block carries. */
const BLOCK_MARKER = "<user_preferences>";

beforeAll(async () => {
  llm = await startFakeLlm();
  env = await startTestServer({
    providers: [providerFor(llm)],
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

async function chat(sessionId: string, message: string): Promise<ChatStreamEvent[]> {
  const res = await env.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/chat`,
    payload: { message },
  });
  if (res.statusCode !== 200) throw new Error(`chat failed: ${res.statusCode} ${res.body}`);
  return parseSse(res.body) as ChatStreamEvent[];
}

async function listPreferences(sessionId: string): Promise<GetSessionPreferencesResponse> {
  const res = await env.inject({ method: "GET", url: `/api/sessions/${sessionId}/preferences` });
  if (res.statusCode !== 200) throw new Error(`list failed: ${res.statusCode} ${res.body}`);
  return res.json<GetSessionPreferencesResponse>();
}

/** Seed a rule the way a recording path would, without spending a turn on the setup. */
function seed(
  userId: string,
  sessionId: string,
  content: string,
  type: "positive" | "negative" = "positive"
): string {
  const id = newId();
  env.server.db.createPreference({
    id,
    userId,
    scope: "session",
    scopeId: sessionId,
    type,
    content,
    source: "auto",
    sourceMessageId: null,
  });
  return id;
}

/** The system prompt of the first recorded request whose body carries `phrase`. */
function systemWith(phrase: string): string {
  const request = llm.requests().find((r) => JSON.stringify(r).includes(phrase));
  if (!request) throw new Error(`no request carried ${JSON.stringify(phrase)}`);
  const messages = (request as { messages: { role: string; content: unknown }[] }).messages;
  const system = messages.find((m) => m.role === "system");
  return String(system?.content ?? "");
}

async function setSettings(sessionId: string, settings: Record<string, unknown>): Promise<void> {
  const res = await env.inject({
    method: "PATCH",
    url: `/api/sessions/${sessionId}`,
    payload: { settings },
  });
  if (res.statusCode !== 200) throw new Error(`settings failed: ${res.statusCode} ${res.body}`);
}

describe("the preference tool in a turn", () => {
  it("records what the model saves and installs the panel", async () => {
    const workspace = await newWorkspace(env, "pref-tool");
    const session = await newSession(env, workspace.id);
    llm.setTurns([
      {
        content: "好的，我记下来。",
        toolCalls: [
          {
            id: "call_p1",
            name: "ila_save_preference",
            args: { type: "positive", content: "回答先给结论" },
          },
        ],
      },
      { content: "记住了。" },
    ]);

    const events = await chat(session.id, "我希望以后回答先给结论");
    const end = events.find((e) => e.type === "tool_end");
    expect(end).toBeTruthy();
    if (end?.type !== "tool_end") throw new Error("no tool_end");
    expect(end.toolCall.output).not.toContain("Tool error");

    const { preferences } = await listPreferences(session.id);
    expect(preferences).toHaveLength(1);
    expect(preferences[0]).toMatchObject({
      type: "positive",
      content: "回答先给结论",
      source: "auto",
      scope: "session",
    });

    // The call is `auto-install` mode: the 用户偏好 panel arrives with the first recording, from
    // silence — see `installWidgetForToolUse`.
    const widgets = (
      await env.inject({ method: "GET", url: `/api/sessions/${session.id}/widgets` })
    ).json<SessionWidgets>();
    expect(widgets.session.find((w) => w.id === "preferences" && w.enabled)).toBeTruthy();
  });

  it("refuses a replace id the conversation does not hold, and writes nothing", async () => {
    const workspace = await newWorkspace(env, "pref-bad-replace");
    const session = await newSession(env, workspace.id);
    llm.setTurns([
      {
        content: "",
        toolCalls: [
          {
            id: "call_p2",
            name: "ila_save_preference",
            args: { type: "positive", content: "用中文回答", replaces: ["no-such-id"] },
          },
        ],
      },
      { content: "好。" },
    ]);

    const events = await chat(session.id, "以后用中文回答");
    const end = events.find((e) => e.type === "tool_end");
    if (end?.type !== "tool_end") throw new Error("no tool_end");
    // The tool error reaches the model, and the store is untouched: a delete that did not
    // happen must never look like one.
    expect(end.toolCall.output).toContain("Tool error");
    expect(end.toolCall.output).toContain("no-such-id");
    expect((await listPreferences(session.id)).preferences).toEqual([]);
  });
});

describe("what a turn's system prompt carries", () => {
  it("injects the block whenever the conversation has rules", async () => {
    // Injection is built in: no switch, no mode. A full-history turn with a stored rule
    // carries the block, with the ids and the precedence sentence.
    const workspace = await newWorkspace(env, "pref-block-on");
    const session = await newSession(env, workspace.id);
    const id = seed(env.user.id, session.id, "回答先给结论");
    llm.script([{ content: "好的" }]);

    await chat(session.id, "普通问题");
    const system = systemWith("普通问题");
    expect(system).toContain(BLOCK_MARKER);
    expect(system).toContain(id);
    expect(system).toContain("回答先给结论");
    expect(system).toContain("session rule overrides a workspace rule");
  });

  it("keeps injecting under smart context", async () => {
    // The deliberately narrow window is exactly where the block matters most, so the mode must
    // not displace it.
    const workspace = await newWorkspace(env, "pref-block-smart");
    const session = await newSession(env, workspace.id);
    seed(env.user.id, session.id, "不要使用表格");
    await setSettings(session.id, { smartContext: true });
    llm.script([{ content: "好的" }]);

    await chat(session.id, "智能上下文的问题");
    expect(systemWith("智能上下文的问题")).toContain(BLOCK_MARKER);
  });

  it("sends no block when the conversation has no rules", async () => {
    // The absence means "nothing stored", never "switched off": a fresh conversation is
    // byte-identical to one from before the feature existed.
    const workspace = await newWorkspace(env, "pref-block-empty");
    const session = await newSession(env, workspace.id);
    llm.script([{ content: "好的" }]);

    await chat(session.id, "没有偏好时的问题");
    expect(systemWith("没有偏好时的问题")).not.toContain(BLOCK_MARKER);
  });
});

describe("ila_query kind preference", () => {
  it("reads the rules back with the ids the replace protocol takes", async () => {
    const workspace = await newWorkspace(env, "pref-query");
    const session = await newSession(env, workspace.id);
    const id = seed(env.user.id, session.id, "不要使用表格", "negative");
    llm.setTurns([
      {
        content: "",
        toolCalls: [{ id: "call_q1", name: "ila_query", args: { kind: "preference" } }],
      },
      { content: "查到了。" },
    ]);

    const events = await chat(session.id, "我设过哪些偏好？");
    const end = events.find((e) => e.type === "tool_end");
    if (end?.type !== "tool_end") throw new Error("no tool_end");
    expect(end.toolCall.output).toContain(id);
    expect(end.toolCall.output).toContain("不要使用表格");
    expect(end.toolCall.output).toContain("replaces");
  });
});

describe("the manual extraction route", () => {
  it("saves the model's answer and installs the panel", async () => {
    const workspace = await newWorkspace(env, "pref-extract");
    const session = await newSession(env, workspace.id);
    llm.setMatches([
      {
        includes: EXTRACT_MARKER,
        content: JSON.stringify({
          status: "saved",
          type: "negative",
          content: "不要使用表格",
        }),
      },
    ]);

    const res = await env.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/preferences/extract`,
      payload: { text: "我不喜欢用表格，请用段落" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; preference: { content: string }; preferences: unknown[] }>();
    expect(body.status).toBe("saved");
    expect(body.preference.content).toBe("不要使用表格");
    expect(body.preferences).toHaveLength(1);

    const widgets = (
      await env.inject({ method: "GET", url: `/api/sessions/${session.id}/widgets` })
    ).json<SessionWidgets>();
    expect(widgets.session.find((w) => w.id === "preferences" && w.enabled)).toBeTruthy();
  });

  it("answers skipped without writing", async () => {
    const workspace = await newWorkspace(env, "pref-extract-skip");
    const session = await newSession(env, workspace.id);
    llm.setMatches([{ includes: EXTRACT_MARKER, content: '{"status":"skipped"}' }]);

    const res = await env.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/preferences/extract`,
      payload: { text: "地球是圆的" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string }>().status).toBe("skipped");
    expect((await listPreferences(session.id)).preferences).toEqual([]);
  });

  it("replaces what the extraction names", async () => {
    const workspace = await newWorkspace(env, "pref-extract-replace");
    const session = await newSession(env, workspace.id);
    const oldId = seed(env.user.id, session.id, "回答先给结论");
    llm.setMatches([
      {
        includes: EXTRACT_MARKER,
        content: JSON.stringify({
          status: "saved",
          type: "positive",
          content: "回答都用要点列表",
          replaces: [oldId],
        }),
      },
    ]);

    const res = await env.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/preferences/extract`,
      payload: { text: "我希望回答用要点列表" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ preferences: { id: string; content: string }[] }>();
    expect(body.preferences.map((p) => p.content)).toEqual(["回答都用要点列表"]);
    expect(body.preferences.some((p) => p.id === oldId)).toBe(false);
  });

  it("reports an unusable answer as PREFERENCE_EXTRACT_FAILED", async () => {
    const workspace = await newWorkspace(env, "pref-extract-bad");
    const session = await newSession(env, workspace.id);
    llm.setMatches([{ includes: EXTRACT_MARKER, content: "I could not tell." }]);

    const res = await env.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/preferences/extract`,
      payload: { text: "随便选的一段话" },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("PREFERENCE_EXTRACT_FAILED");
    expect((await listPreferences(session.id)).preferences).toEqual([]);
  });

  it("refuses an empty passage before calling the model", async () => {
    const workspace = await newWorkspace(env, "pref-extract-empty");
    const session = await newSession(env, workspace.id);
    const res = await env.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/preferences/extract`,
      payload: { text: "   " },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("INVALID_FIELD");
    // Nothing was called: the refusal is before the model, not after it.
    expect(llm.requests()).toEqual([]);
  });
});

describe("GET and DELETE /api/sessions/:id/preferences", () => {
  it("404s for another account's conversation", async () => {
    const workspace = await newWorkspace(env, "pref-foreign");
    const session = await newSession(env, workspace.id);
    seed(env.user.id, session.id, "回答先给结论");

    const bob = await env.asUser("PrefBob");
    const list = await bob.inject({
      method: "GET",
      url: `/api/sessions/${session.id}/preferences`,
    });
    expect(list.statusCode).toBe(404);
    const del = await bob.inject({
      method: "DELETE",
      url: `/api/sessions/${session.id}/preferences/${newId()}`,
    });
    expect(del.statusCode).toBe(404);
  });

  it("deletes one rule and 404s an unknown id", async () => {
    const workspace = await newWorkspace(env, "pref-delete");
    const session = await newSession(env, workspace.id);
    const id = seed(env.user.id, session.id, "回答先给结论");

    const missing = await env.inject({
      method: "DELETE",
      url: `/api/sessions/${session.id}/preferences/no-such-id`,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json<{ error: { code: string } }>().error.code).toBe("PREFERENCE_NOT_FOUND");

    const deleted = await env.inject({
      method: "DELETE",
      url: `/api/sessions/${session.id}/preferences/${id}`,
    });
    expect(deleted.statusCode).toBe(200);
    expect((await listPreferences(session.id)).preferences).toEqual([]);
  });
});
