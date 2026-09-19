import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ChatStreamEvent, Message, Session } from "@ilearnassist/shared";
import type { ProviderDef } from "../src/config.js";
import { eventTypes, parseSse } from "./helpers/sse.js";
import { startFakeLlm, type FakeLlm } from "./helpers/fakeLlm.js";
import {
  keylessProvider,
  newSession,
  newWorkspace,
  startTestServer,
  type TestEnv,
} from "./helpers/tempEnv.js";

/**
 * Deleting and regenerating the last message, end to end.
 *
 * Two things are worth testing at this level rather than in `db.test.ts`. The **tail rule** is
 * a read plus a write that has to agree, so it is exercised through the route that sequences
 * them; and **regenerate is the `/answers` shape, not `/chat`'s**, which is only visible in
 * what the model is actually sent — hence the assertions against the fake LLM's recorded
 * request rather than against the rows alone. A turn that replayed the user message twice would
 * persist exactly the same messages and still be wrong.
 *
 * A third subject used to live here: that a deleted message drops out of the conversation's
 * `messageCount` and token totals. Those totals were the demo statistics widget's, and they went
 * with it. The rule itself is unchanged and still tested — the conversation's **list** hides a
 * deleted message in "peels the tail", and the **model's context** hides it in "keeps a deleted
 * message out of the model's context". Both read through `stmtListMessages`, which is the one
 * statement the rule lives in.
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
    models: [{ id: "fake-model", name: "fake-model" }, { id: "fake-vision", name: "fake-vision" }],
  };
  // A second provider with no key, so a turn can be failed deterministically from the route
  // rather than from the model — `failTurn`'s path, which is what the failure test is about.
  env = await startTestServer({
    providers: [provider, keylessProvider()],
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

async function chat(sessionId: string, payload: Record<string, unknown>) {
  const res = await env.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/chat`,
    payload,
  });
  return { res, events: parseSse(res.body) as ChatStreamEvent[] };
}

async function regenerate(sessionId: string) {
  const res = await env.inject({ method: "POST", url: `/api/sessions/${sessionId}/regenerate` });
  return { res, events: parseSse(res.body) as ChatStreamEvent[] };
}

function deleteMessage(sessionId: string, messageId: string) {
  return env.inject({
    method: "DELETE",
    url: `/api/sessions/${sessionId}/messages/${messageId}`,
  });
}

async function messagesOf(sessionId: string): Promise<Message[]> {
  return (await env.inject({ method: "GET", url: `/api/sessions/${sessionId}/messages` })).json<
    Message[]
  >();
}

/** The messages the model was last sent, i.e. the history it actually saw. */
function lastSentMessages(): { role: string; content: string }[] {
  const streamed = llm.requests().filter((r) => r.stream === true);
  return (streamed.at(-1) as { messages: { role: string; content: string }[] }).messages;
}

/** The raw row, to prove a delete marked rather than removed. */
function rawMessage(id: string): { deleted_at: string | null } | undefined {
  return env.server.db.raw
    .prepare("SELECT deleted_at FROM messages WHERE id = ?")
    .get(id) as { deleted_at: string | null } | undefined;
}

describe("DELETE /api/sessions/:id/messages/:messageId", () => {
  it("peels the tail, marking the row and leaving it in the table", async () => {
    const session = await freshSession();
    llm.setTurns([{ content: "first answer" }]);
    await chat(session.id, { message: "first question" });

    const before = await messagesOf(session.id);
    const reply = before.at(-1)!;
    expect(reply.role).toBe("assistant");

    expect((await deleteMessage(session.id, reply.id)).statusCode).toBe(200);

    const after = await messagesOf(session.id);
    expect(after.map((m) => m.id)).toEqual([before[0]!.id]);
    // Soft, not gone: the row is there with a marker, which is what a restore would read.
    expect(rawMessage(reply.id)!.deleted_at).not.toBeNull();
  });

  it("peels repeatedly from the end, but never from the middle", async () => {
    // The rule the client renders: the control belongs to whatever is currently last, so a
    // delete exposes the next one. A message with anything after it is refused.
    const session = await freshSession();
    llm.setTurns([{ content: "answer one" }, { content: "answer two" }]);
    await chat(session.id, { message: "question one" });
    await chat(session.id, { message: "question two" });

    const four = await messagesOf(session.id);
    expect(four).toHaveLength(4);

    // Not the tail: the assistant reply before the last user message.
    const middle = await deleteMessage(session.id, four[1]!.id);
    expect(middle.statusCode).toBe(409);
    expect(middle.json()).toMatchObject({ error: { code: "MESSAGE_NOT_LAST" } });

    // The tail goes, and then the one it exposes is a valid target — the same call, twice.
    expect((await deleteMessage(session.id, four[3]!.id)).statusCode).toBe(200);
    expect((await deleteMessage(session.id, four[2]!.id)).statusCode).toBe(200);
    expect((await messagesOf(session.id)).map((m) => m.id)).toEqual([four[0]!.id, four[1]!.id]);
  });

  it("answers 404 for an unknown message, another conversation's, or someone else's", async () => {
    const session = await freshSession();
    llm.setTurns([{ content: "answer" }]);
    await chat(session.id, { message: "question" });

    const other = await freshSession();
    llm.setTurns([{ content: "other answer" }]);
    await chat(other.id, { message: "other question" });
    const foreign = (await messagesOf(other.id)).at(-1)!;

    expect((await deleteMessage(session.id, "nope")).statusCode).toBe(404);
    // Real message, wrong conversation: the same answer, so an id cannot be probed.
    const crossed = await deleteMessage(session.id, foreign.id);
    expect(crossed.statusCode).toBe(404);
    expect(crossed.json()).toMatchObject({ error: { code: "MESSAGE_NOT_FOUND" } });
  });

  it("404s when the conversation itself is gone", async () => {
    const session = await freshSession();
    llm.setTurns([{ content: "answer" }]);
    await chat(session.id, { message: "question" });
    const reply = (await messagesOf(session.id)).at(-1)!;

    await env.inject({ method: "DELETE", url: `/api/sessions/${session.id}` });
    expect((await deleteMessage(session.id, reply.id)).statusCode).toBe(404);
  });

  it("keeps a deleted message out of the model's context", async () => {
    // The whole point, and the reason the filter lives on `stmtListMessages`: that one
    // statement is what both the conversation view and `buildHistoryMessages` read.
    const session = await freshSession();
    llm.setTurns([{ content: "an answer the user did not want" }]);
    await chat(session.id, { message: "a question" });
    const reply = (await messagesOf(session.id)).at(-1)!;
    await deleteMessage(session.id, reply.id);

    llm.setTurns([{ content: "second answer" }]);
    await chat(session.id, { message: "second question" });

    const sent = lastSentMessages();
    expect(sent.map((m) => m.content)).not.toContain("an answer the user did not want");
    expect(sent.at(-1)).toMatchObject({ role: "user", content: "second question" });
  });

  it("refuses while a turn is streaming", async () => {
    const session = await freshSession();
    llm.setTurns([{ content: "settled" }]);
    await chat(session.id, { message: "first" });
    const tail = (await messagesOf(session.id)).at(-1)!;

    llm.setTurns([{ content: "starting", holdMs: 200 }]);
    const pending = env.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/chat`,
      payload: { message: "hold on" },
    });
    // Long enough for `beginTurn` to have registered, far shorter than the held turn.
    await new Promise((r) => setTimeout(r, 60));

    // A real message id, so the refusal under test is the turn and not the lookup: the
    // alternative would peel the tail out from under a reply that is still arriving.
    const res = await deleteMessage(session.id, tail.id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: "TURN_IN_PROGRESS" } });

    await pending;
    // And the tail is still there, because the refusal was the whole of what happened.
    expect((await messagesOf(session.id)).map((m) => m.id)).toContain(tail.id);
  });
});

describe("POST /api/sessions/:id/regenerate", () => {
  it("replaces the last reply without replaying the user message", async () => {
    const session = await freshSession();
    llm.setTurns([{ content: "the first attempt" }]);
    await chat(session.id, { message: "explain X" });

    const original = await messagesOf(session.id);
    const reply = original.at(-1)!;
    llm.setTurns([{ content: "the second attempt" }]);

    const { res, events } = await regenerate(session.id);
    expect(res.statusCode).toBe(200);
    // The client is told the old row is gone *before* the replacement streams, or it renders
    // both at once for the length of the turn.
    expect(events[0]).toEqual({ type: "meta", sessionId: session.id });
    expect(events[1]).toEqual({ type: "message_removed", id: reply.id });

    const after = await messagesOf(session.id);
    expect(after.map((m) => m.content)).toEqual(["explain X", "the second attempt"]);
    expect(rawMessage(reply.id)!.deleted_at).not.toBeNull();

    // Exactly one user message reached the model — the persisted one, replayed from its row
    // rather than appended a second time by the route.
    const sent = lastSentMessages();
    expect(sent.filter((m) => m.role === "user")).toHaveLength(1);
    expect(sent.at(-1)).toMatchObject({ role: "user", content: "explain X" });
    // And the reply being replaced is not part of what it was shown.
    expect(sent.map((m) => m.content)).not.toContain("the first attempt");
  });

  it("replays the user turn's attachments from the persisted row", async () => {
    const session = await freshSession();
    // A 1x1 PNG, enough to be stored and replayed as an image block.
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const uploaded = (
      await env.inject({
        method: "POST",
        url: `/api/sessions/${session.id}/resources`,
        payload: { name: "dot.png", mimeType: "image/png", data: png },
      })
    ).json<{ id: string; name: string }>();

    // The model is a property of the *conversation*, not of one request: regenerate takes no
    // body, so it answers with whatever the session is set to. Point it at the vision model
    // first, or the replay happens as a text placeholder and the assertion proves nothing.
    await env.inject({
      method: "PATCH",
      url: `/api/sessions/${session.id}`,
      payload: { settings: { modelId: "fake-vision" } },
    });

    llm.setTurns([{ content: "I see a dot" }]);
    await chat(session.id, {
      message: "what is this",
      model: "fake-vision",
      attachments: [uploaded],
    });

    llm.setTurns([{ content: "still a dot" }]);
    const { res } = await regenerate(session.id);
    expect(res.statusCode).toBe(200);

    // The image is rebuilt from the message row — where `attachments` is a snapshot — so the
    // client never has to hand back the bytes it sent, and a reload-then-regenerate works.
    const sent = JSON.stringify(lastSentMessages());
    expect(sent).toContain("data:image/png;base64");
    expect((await messagesOf(session.id)).map((m) => m.content)).toEqual([
      "what is this",
      "still a dot",
    ]);
  });

  it("leaves a named conversation alone, and lets an unnamed one be named", async () => {
    /*
     * A regenerate is not a first turn, and it no longer has to be one: the titler reads the
     * conversation rather than the turn's arguments, so what decides is whether the conversation
     * has a name yet. A named one is left alone; one the titler has not managed to name is handed
     * the replacement answer as evidence, which is the only turn that reply will ever be part of.
     */
    const named = await freshSession();
    llm.setTurns([{ content: "an answer" }]);
    const first = await chat(named.id, { message: "name this conversation" });
    expect(eventTypes(first.res.body)).toContain("title");

    llm.setTurns([{ content: "another answer" }]);
    const quiet = await regenerate(named.id);
    expect(eventTypes(quiet.res.body)).not.toContain("title");

    const unnamed = await freshSession();
    llm.setTitle("");
    llm.setTurns([{ content: "an answer" }]);
    await chat(unnamed.id, { message: "name this conversation" });

    llm.setTitle("Now It Has A Name");
    llm.setTurns([{ content: "another answer" }]);
    const { res } = await regenerate(unnamed.id);
    expect(eventTypes(res.body)).toContain("title");
  });

  it("refuses on an empty conversation, a user tail, and an active turn", async () => {
    const empty = await freshSession();
    const nothing = await regenerate(empty.id);
    expect(nothing.res.statusCode).toBe(409);
    expect(nothing.res.json()).toMatchObject({ error: { code: "NO_REPLY_TO_REGENERATE" } });

    const session = await freshSession();
    llm.setTurns([{ content: "answer" }]);
    await chat(session.id, { message: "question" });
    // The tail is the assistant reply, so the reply is peelable; delete it and the user
    // message becomes the tail, which is what a regenerate cannot work from.
    const reply = (await messagesOf(session.id)).at(-1)!;
    await deleteMessage(session.id, reply.id);
    const userTail = await regenerate(session.id);
    expect(userTail.res.statusCode).toBe(409);
    expect(userTail.res.json()).toMatchObject({ error: { code: "NO_REPLY_TO_REGENERATE" } });

    llm.setTurns([{ content: "starting", holdMs: 200 }]);
    const pending = env.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/chat`,
      payload: { message: "hold on" },
    });
    await new Promise((r) => setTimeout(r, 60));
    const busy = await regenerate(session.id);
    expect(busy.res.statusCode).toBe(409);
    expect(busy.res.json()).toMatchObject({ error: { code: "TURN_IN_PROGRESS" } });
    await pending;
  });

  it("replaces a suspended reply only once its question is out of the way", async () => {
    // An assistant tail holding an unanswered question is the card's state, not this
    // button's: regenerating it would discard the question the user is answering.
    const session = await freshSession();
    llm.setTurns([
      {
        toolCalls: [
          {
            id: "call_ask",
            name: "ask_user",
            args: {
              questions: [
                {
                  header: "Pick",
                  question: "Which one?",
                  options: [{ label: "A" }, { label: "B" }],
                },
              ],
            },
          },
        ],
      },
    ]);
    await chat(session.id, { message: "ask me something" });
    const suspended = (await messagesOf(session.id)).at(-1)!;
    expect(suspended.toolCalls?.[0]?.status).toBe("awaiting");

    const refused = await regenerate(session.id);
    expect(refused.res.statusCode).toBe(409);
    expect(refused.res.json()).toMatchObject({ error: { code: "NO_REPLY_TO_REGENERATE" } });

    // Deleting it is allowed — the tail is the tail — and the question goes with it.
    expect((await deleteMessage(session.id, suspended.id)).statusCode).toBe(200);
    expect((await messagesOf(session.id)).map((m) => m.id)).not.toContain(suspended.id);
  });

  it("persists a warning message when the regenerated turn fails", async () => {
    const session = await freshSession();
    llm.setTurns([{ content: "an answer" }]);
    await chat(session.id, { message: "question" });
    const reply = (await messagesOf(session.id)).at(-1)!;
    expect(reply.content).toBe("an answer");

    // Aim the conversation at the keyless provider, so the next turn fails on the way out
    // rather than at the model — which is the shape `failTurn` handles.
    await env.inject({
      method: "PATCH",
      url: `/api/sessions/${session.id}`,
      payload: { settings: { providerId: "keyless" } },
    });

    const { res, events } = await regenerate(session.id);
    expect(res.statusCode).toBe(200);
    expect(events.some((e) => e.type === "error")).toBe(true);

    const after = await messagesOf(session.id);
    // The old reply stays deleted and the warning takes its place as the tail — history is
    // still user/assistant, and the user can press retry again.
    expect(rawMessage(reply.id)!.deleted_at).not.toBeNull();
    expect(after).toHaveLength(2);
    expect(after[0]!.content).toBe("question");
    expect(after[1]!.content).toMatch(/^⚠️ /);
  });
});
