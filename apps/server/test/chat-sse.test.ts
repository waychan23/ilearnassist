import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Attachment, ChatStreamEvent, Message, Session } from "@ilearnassist/shared";
import type { ProviderDef } from "../src/config.js";
import { eventTypes, parseSse } from "./helpers/sse.js";
import { startFakeLlm, type FakeLlm } from "./helpers/fakeLlm.js";
import { newSession, newWorkspace, startTestServer, type TestEnv } from "./helpers/tempEnv.js";

/**
 * The chat route end to end: HTTP request → real agent loop → real SSE frames → persisted
 * messages. Only the model is fake. `inject()` captures the hijacked SSE response in full,
 * so no port is bound and the assertions run on the exact bytes the browser would receive.
 */

let llm: FakeLlm;
let env: TestEnv;

beforeAll(async () => {
  llm = await startFakeLlm();
  const provider: ProviderDef = {
    id: "fake",
    name: "Fake Provider",
    baseURL: llm.baseURL,
    apiKey: "test-key",
    // `fake-vision` picks up the `vision` capability from `guessCapabilities`.
    models: [{ id: "fake-model", name: "fake-model" }, { id: "fake-vision", name: "fake-vision" }],
  };
  env = await startTestServer({ providers: [provider], defaultProvider: "fake", defaultModel: "fake-model" });
});

afterAll(async () => {
  await env.cleanup();
  await llm.close();
});

beforeEach(() => {
  llm.reset();
  llm.setTitle("Fake Conversation Title");
});

async function chat(sessionId: string, payload: Record<string, unknown>) {
  const res = await env.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/chat`,
    payload,
  });
  return { res, events: parseSse(res.body) as ChatStreamEvent[] };
}

async function messagesOf(sessionId: string): Promise<Message[]> {
  return (await env.inject({ method: "GET", url: `/api/sessions/${sessionId}/messages` })).json<Message[]>();
}

/** The workspace owning the session under test, set by `freshSession`. */
let currentWorkspaceId: string;

async function sessionOf(sessionId: string): Promise<Session> {
  const sessions = (
    await env.inject({ method: "GET", url: `/api/workspaces/${currentWorkspaceId}/sessions` })
  ).json<Session[]>();
  return sessions.find((s) => s.id === sessionId)!;
}

async function freshSession(): Promise<{ session: Session; workdirPath: string }> {
  const workspace = await newWorkspace(env, `W-${Math.random().toString(36).slice(2)}`);
  currentWorkspaceId = workspace.id;
  const session = await newSession(env, workspace.id);
  return { session, workdirPath: workspace.workdirPath };
}

describe("POST /api/sessions/:id/chat", () => {
  it("validates the request", async () => {
    const { session } = await freshSession();

    expect((await env.inject({ method: "POST", url: "/api/sessions/nope/chat", payload: { message: "hi" } })).statusCode).toBe(404);

    const empty = await env.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/chat`,
      payload: { message: "   " },
    });
    expect(empty.statusCode).toBe(400);
  });

  it("streams the answer and persists both turns", async () => {
    const { session } = await freshSession();
    llm.setTurns([{ content: "Hello from the model", usage: { input: 30, output: 6 } }]);

    const { res, events } = await chat(session.id, { message: "hi there" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");

    // Framing: meta first, done last, and the answer in between.
    expect(events[0]).toEqual({ type: "meta", sessionId: session.id });
    expect(events.at(-1)).toEqual({ type: "done" });
    expect(eventTypes(res.body)).toEqual([
      "meta",
      // The persisted row for the user's own message: the client has been drawing that
      // bubble optimistically and needs the server's id to be able to address it.
      "message_saved",
      "text",
      "usage",
      "message_done",
      "title",
      "done",
    ]);

    const done = events.find((e) => e.type === "message_done") as { message: Message };
    expect(done.message).toMatchObject({ role: "assistant", content: "Hello from the model" });
    expect(done.message.usage).toMatchObject({ inputTokens: 30, outputTokens: 6 });

    const persisted = await messagesOf(session.id);
    expect(persisted.map((m) => [m.role, m.content])).toEqual([
      ["user", "hi there"],
      ["assistant", "Hello from the model"],
    ]);
  });

  it("streams reasoning separately from the answer", async () => {
    const { session } = await freshSession();
    llm.setTurns([{ reasoning: "weighing options", content: "the answer" }]);

    const { events } = await chat(session.id, { message: "why?" });

    expect(events.filter((e) => e.type === "reasoning")).toEqual([{ type: "reasoning", delta: "weighing options" }]);
    const persisted = await messagesOf(session.id);
    expect(persisted[1]!.reasoning).toBe("weighing options");
    expect(persisted[1]!.content).toBe("the answer");
  });

  it("runs a tool call and records it on the assistant message", async () => {
    const { session, workdirPath } = await freshSession();
    llm.setTurns([
      { content: "Writing the file.", toolCalls: [{ id: "call_1", name: "write_file", args: { path: "out.txt", content: "done" } }] },
      { content: "Wrote it." },
    ]);

    const { events } = await chat(session.id, { message: "write a file" });

    expect(events.map((e) => e.type)).toEqual([
      "meta",
      "message_saved",
      "text",
      "tool_start",
      "tool_end",
      "text",
      "usage",
      "message_done",
      "title",
      "done",
    ]);

    const started = events.find((e) => e.type === "tool_start") as { toolCall: { name: string } };
    expect(started.toolCall.name).toBe("write_file");

    // The tool really ran, inside the session's own workspace.
    expect(existsSync(join(workdirPath, "out.txt"))).toBe(true);
    expect(readFileSync(join(workdirPath, "out.txt"), "utf8")).toBe("done");

    const persisted = await messagesOf(session.id);
    expect(persisted[1]!.toolCalls).toHaveLength(1);
    expect(persisted[1]!.toolCalls![0]).toMatchObject({ name: "write_file" });
    expect(persisted[1]!.toolCalls![0]!.output).toContain("Wrote 4 characters");
  });

  it("names the conversation from the first exchange", async () => {
    const { session } = await freshSession();
    llm.setTurns([{ content: "Sure." }]);
    llm.setTitle("Recursion Basics");

    const { events } = await chat(session.id, { message: "what is recursion" });

    expect(events.find((e) => e.type === "title")).toEqual({
      type: "title",
      sessionId: session.id,
      title: "Recursion Basics",
    });
    expect(await sessionOf(session.id)).toMatchObject({ title: "Recursion Basics", titleSource: "auto" });
  });

  it("never overwrites a title the user typed", async () => {
    const { session } = await freshSession();
    await env.inject({
      method: "PATCH",
      url: `/api/sessions/${session.id}`,
      payload: { title: "My Own Title" },
    });
    llm.setTurns([{ content: "Sure." }]);
    llm.setTitle("Model Title");

    const { events } = await chat(session.id, { message: "hi" });

    expect(events.some((e) => e.type === "title")).toBe(false);
    expect(await sessionOf(session.id)).toMatchObject({ title: "My Own Title", titleSource: "user" });
  });

  it("only titles the first turn", async () => {
    const { session } = await freshSession();
    llm.setTurns([{ content: "first" }]);
    await chat(session.id, { message: "one" });

    llm.reset();
    llm.setTurns([{ content: "second" }]);
    const { events } = await chat(session.id, { message: "two" });

    expect(events.some((e) => e.type === "title")).toBe(false);
  });

  it("replays the earlier turns as history", async () => {
    const { session } = await freshSession();
    llm.setTurns([{ content: "first answer" }]);
    await chat(session.id, { message: "first question" });

    llm.reset();
    llm.setTurns([{ content: "second answer" }]);
    await chat(session.id, { message: "second question" });

    const sent = llm.requests()[0] as { messages: { role: string; content: unknown }[] };
    expect(sent.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(JSON.stringify(sent.messages)).toContain("first question");
    expect(JSON.stringify(sent.messages)).toContain("first answer");
  });

  it("degrades to the default provider when the override names an unknown one", async () => {
    const { session } = await freshSession();
    llm.setTurns([{ content: "still works" }]);

    const res = await env.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/chat`,
      payload: { message: "hi", provider: "keyless-for-error" },
    });

    // A stale provider id must not make the turn fail.
    expect(res.statusCode).toBe(200);
    expect(parseSse(res.body).some((e) => e.type === "error")).toBe(false);
    expect((await messagesOf(session.id))[1]!.content).toBe("still works");
  });

  it("persists a warning message when the provider cannot be used", async () => {
    const { session } = await freshSession();
    // Seed a provider that serves a model but has no API key, then point the turn at it.
    // (`buildModel` checks for a model before it checks for a key, so it needs both.)
    await env.inject({
      method: "POST",
      url: "/api/providers",
      payload: {
        name: "Keyless",
        baseURL: "http://127.0.0.1:1/v1",
        models: [{ modelId: "fake-model", name: "fake-model" }],
      },
    });
    const keyless = (
      await env.inject({ method: "GET", url: "/api/providers" })
    ).json<{ id: string; name: string }[]>().find((p) => p.name === "Keyless")!;

    const { events } = await chat(session.id, { message: "hi", provider: keyless.id });

    const error = events.find((e) => e.type === "error") as { message: string } | undefined;
    expect(error?.message).toMatch(/no API key configured/);
    // The stream still terminates cleanly.
    expect(events.at(-1)).toEqual({ type: "done" });

    const persisted = await messagesOf(session.id);
    expect(persisted).toHaveLength(2);
    expect(persisted[1]!.role).toBe("assistant");
    expect(persisted[1]!.content).toMatch(/^⚠️ /);
  });

  it("names the setting to change when a provider demands the reasoning echo", async () => {
    // The state this catches: a thinking model whose record omits the `reasoning`
    // capability, so `createReasoningFetch` is never handed a replay map and the request
    // goes out without the field. The provider's sentence describes the symptom and says
    // nothing about the cause, so the turn has to name the checkbox that fixes it.
    const rejecting = createServer((_req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: "The `reasoning_content` in the thinking mode must be passed back to the API.",
          },
        })
      );
    });
    await new Promise<void>((resolve) => rejecting.listen(0, "127.0.0.1", resolve));
    const { port } = rejecting.address() as AddressInfo;

    try {
      const { session } = await freshSession();
      await env.inject({
        method: "POST",
        url: "/api/providers",
        payload: {
          name: "Rejecting",
          baseURL: `http://127.0.0.1:${port}/v1`,
          apiKey: "test-key",
          models: [{ modelId: "deepseek-v4-pro", name: "deepseek-v4-pro" }],
        },
      });
      const rejectingProvider = (
        await env.inject({ method: "GET", url: "/api/providers" })
      ).json<{ id: string; name: string }[]>().find((p) => p.name === "Rejecting")!;

      const { events } = await chat(session.id, { message: "hi", provider: rejectingProvider.id });

      const error = events.find((e) => e.type === "error") as
        | { message: string; code?: string }
        | undefined;
      expect(error?.code).toBe("REASONING_NOT_DECLARED");
      // The code adds to the event; it does not replace what the provider said.
      expect(error?.message).toMatch(/reasoning_content/);

      // And the provider's words are what history keeps. That `⚠️` line is replayed to the
      // model next turn, so rewriting it into the sentence the *user* is shown would change
      // what the model is told about its own failure — a different decision entirely.
      const persisted = await messagesOf(session.id);
      expect(persisted[1]!.content).toMatch(/^⚠️ 400/);
      expect(persisted[1]!.content).toContain("reasoning_content");
    } finally {
      await new Promise<void>((resolve) => rejecting.close(() => resolve()));
    }
  });

  it("sends an attached image to a vision model as image content", async () => {
    const { session } = await freshSession();
    const attachment = (
      await env.inject({
        method: "POST",
        url: `/api/sessions/${session.id}/sources`,
        payload: { name: "shot.png", mimeType: "image/png", data: Buffer.from("fake-png").toString("base64") },
      })
    ).json<Attachment>();

    llm.setTurns([{ content: "I see it." }]);
    await chat(session.id, { message: "what is this", model: "fake-vision", attachments: [attachment] });

    const sent = llm.requests()[0] as { messages: { role: string; content: unknown }[] };
    const userTurn = sent.messages.at(-1)!;
    expect(JSON.stringify(userTurn.content)).toContain("image_url");
    expect(JSON.stringify(userTurn.content)).toContain("data:image/png;base64,");

    // The attachment is recorded on the persisted user message too.
    const persisted = await messagesOf(session.id);
    expect(persisted[0]!.attachments?.[0]).toMatchObject({ id: attachment.id, kind: "image" });
  });

  it("degrades an attached image to a placeholder for a non-vision model", async () => {
    const { session } = await freshSession();
    const attachment = (
      await env.inject({
        method: "POST",
        url: `/api/sessions/${session.id}/sources`,
        payload: { name: "shot.png", mimeType: "image/png", data: Buffer.from("fake-png").toString("base64") },
      })
    ).json<Attachment>();

    llm.setTurns([{ content: "ok" }]);
    await chat(session.id, { message: "what is this", model: "fake-model", attachments: [attachment] });

    const sent = llm.requests()[0] as { messages: { content: unknown }[] };
    const serialized = JSON.stringify(sent.messages.at(-1)!.content);
    expect(serialized).not.toContain("image_url");
    expect(serialized).toContain("当前模型不支持图片输入");
  });

  it("drops an attachment whose id could never address a stored file", async () => {
    // A stale or hostile client must not be able to record an attachment reference that
    // would later be resolved against the uploads tree.
    const { session } = await freshSession();

    llm.setTurns([{ content: "ok" }]);
    await chat(session.id, {
      message: "hi",
      attachments: [{ id: "../../escape", name: "x.txt", mimeType: "text/plain", size: 1, kind: "file" }],
    });

    const persisted = await messagesOf(session.id);
    expect(persisted[0]!.attachments).toBeUndefined();
    // The turn itself still went through.
    expect(persisted[1]!.content).toBe("ok");
  });

  /** A Copilot, and a conversation started from it. */
  async function sessionFromCopilot(payload: Record<string, unknown>) {
    const workspace = await newWorkspace(env, `W-${Math.random().toString(36).slice(2)}`);
    currentWorkspaceId = workspace.id;
    const copilot = (
      await env.inject({ method: "POST", url: "/api/copilots", payload })
    ).json<{ id: string }>();
    const session = await newSession(env, workspace.id, { copilotId: copilot.id });
    return { copilot, session };
  }

  /** The system message and the tool names the model was actually sent. */
  function sentToModel(index = 0) {
    const body = llm.requests()[index] as {
      messages: { role: string; content: unknown }[];
      tools?: { function?: { name: string } }[];
    };
    return {
      system: JSON.stringify(body.messages[0]!.content),
      tools: (body.tools ?? []).map((t) => t.function?.name),
    };
  }

  it("answers with the Copilot's prompt as it was at creation, not as it is now", async () => {
    const { copilot, session } = await sessionFromCopilot({
      name: "Coach",
      systemPrompt: "Be terse.",
      tools: [],
    });

    // Edited after the conversation exists. The session copied the prompt when it was created,
    // so this must not reach it — that is what the UI promises, and what the live read this
    // replaced used to break.
    await env.inject({
      method: "PUT",
      url: `/api/copilots/${copilot.id}`,
      payload: { systemPrompt: "Write essays." },
    });

    llm.setTurns([{ content: "ok" }]);
    await chat(session.id, { message: "hi" });

    const { system } = sentToModel();
    expect(system).toContain("Be terse.");
    expect(system).not.toContain("Write essays.");
  });

  it("keeps its tool allowlist after the Copilot it came from is deleted", async () => {
    /*
     * The widening this exists to prevent. `buildTools` reads an empty allowlist as "all tools",
     * and `sessions.copilot_id` is `ON DELETE SET NULL` — so while the allowlist was read live
     * from the Copilot, deleting it did not merely remove a restriction, it silently granted
     * every tool. The conversation's own copy is what makes the restriction outlive its source.
     */
    const { copilot, session } = await sessionFromCopilot({
      name: "Reader",
      systemPrompt: "Read only.",
      allTools: false,
      tools: ["read_file"],
    });
    expect((await env.inject({ method: "DELETE", url: `/api/copilots/${copilot.id}` })).statusCode).toBe(200);

    llm.setTurns([{ content: "ok" }]);
    await chat(session.id, { message: "hi" });

    const { tools } = sentToModel();
    expect(tools).toContain("read_file");
    expect(tools).not.toContain("write_file");
    expect(tools).not.toContain("delete_file");
  });

  it("sends no tools at all when the conversation is allowed none", async () => {
    /*
     * The state that used to be unreachable. An empty allow-list meant "no restriction", so a
     * Copilot locked down to nothing arrived at the model with every tool — the widest possible
     * reading of the narrowest possible selection.
     */
    const { session } = await sessionFromCopilot({
      name: "Silent",
      systemPrompt: "只聊天。",
      allTools: false,
      tools: [],
    });

    llm.setTurns([{ content: "ok" }]);
    await chat(session.id, { message: "hi" });

    const { tools } = sentToModel();
    expect(tools).toEqual([]);
    // The turn still ran, so this is a tool-less conversation rather than a failed request.
    expect(await messagesOf(session.id)).toHaveLength(2);
  });

  it("sends every tool when the flag is on, list or no list", async () => {
    // `allTools: true` is authoritative, so a stale selection left beside it changes nothing —
    // and the two must not be able to disagree about what the model was offered.
    const { session } = await sessionFromCopilot({
      name: "Everything",
      systemPrompt: "",
      allTools: true,
      tools: ["read_file"],
    });

    llm.setTurns([{ content: "ok" }]);
    await chat(session.id, { message: "hi" });

    expect(sentToModel().tools).toContain("write_file");
    // Which is to say all of them, not merely the one name that happened to be listed.
    expect(sentToModel().tools.length).toBeGreaterThan(1);
  });

  it("honours a per-turn model override that the provider actually serves", async () => {
    const { session } = await freshSession();
    llm.setTurns([{ content: "ok" }]);
    await chat(session.id, { message: "hi", model: "fake-vision" });

    expect((llm.requests()[0] as { model: string }).model).toBe("fake-vision");
  });

  it("rejects a model the provider does not serve and falls back", async () => {
    const { session } = await freshSession();
    llm.setTurns([{ content: "ok" }]);
    await chat(session.id, { message: "hi", model: "does-not-exist" });

    expect((llm.requests()[0] as { model: string }).model).toBe("fake-model");
  });
});
