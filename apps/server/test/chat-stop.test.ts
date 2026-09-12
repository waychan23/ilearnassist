import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ChatStreamEvent, Message, Session } from "@ilearnassist/shared";
import type { ProviderDef } from "../src/config.js";
import { parseSse } from "./helpers/sse.js";
import { startFakeLlm, type FakeLlm } from "./helpers/fakeLlm.js";
import { newSession, newWorkspace, startTestServer, type TestEnv } from "./helpers/tempEnv.js";

/**
 * Stopping a turn mid-flight, end to end: the real agent loop streaming from the fake
 * model, a real `POST /stop` from outside it, and the real SSE response the browser sees.
 *
 * The point of the design under test is that the chat request outlives the stop — the
 * client does not abort its own fetch, so the partial reply can still be reported on the
 * stream that is already open. That is why these assert on the *whole* transcript of the
 * interrupted turn rather than just its persisted row.
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
    models: [{ id: "fake-model", name: "fake-model" }],
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function freshSession(): Promise<Session> {
  const workspace = await newWorkspace(env, `W-${Math.random().toString(36).slice(2)}`);
  return newSession(env, workspace.id);
}

function startChat(sessionId: string, message: string) {
  return env.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/chat`,
    payload: { message },
  });
}

function stop(sessionId: string, inject: TestEnv["inject"] = env.inject) {
  return inject({ method: "POST", url: `/api/sessions/${sessionId}/stop` });
}

async function messagesOf(sessionId: string): Promise<Message[]> {
  return (await env.inject({ method: "GET", url: `/api/sessions/${sessionId}/messages` })).json<Message[]>();
}

/** The last streamed request the model was sent, i.e. the history it actually saw. */
function lastStreamedHistory(): { role: string; content: string }[] {
  const streamed = llm.requests().filter((r) => r.stream === true);
  return (streamed.at(-1) as { messages: { role: string; content: string }[] }).messages;
}

/**
 * A turn is written in one synchronous burst by default, so there is no instant at which
 * it could be interrupted. The pause here is long enough that the stop below cannot miss
 * it: the first frame — the text — is written before any pause, and the turn then sits
 * mid-stream until the abort lands.
 */
const HELD_TURN = { content: "half an answer", holdMs: 100 };
/** Comfortably inside the held turn above, and far longer than the text needs to arrive. */
const STOP_AFTER_MS = 120;

describe("POST /api/sessions/:id/stop", () => {
  it("interrupts the turn, keeps what had streamed, and ends the stream cleanly", async () => {
    const session = await freshSession();
    llm.setTurns([HELD_TURN]);

    const chatPromise = startChat(session.id, "tell me something long");
    // Long enough for the text to have arrived, far shorter than the turn's own pause.
    await sleep(STOP_AFTER_MS);

    const stopped = await stop(session.id);
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json()).toEqual({ ok: true });

    const res = await chatPromise;
    const events = parseSse(res.body) as ChatStreamEvent[];

    // The client is mid-`for await` on this stream, so it has to end the way every other
    // turn does — a `message_done` it can render and then `done`. An `error` here would
    // surface the user's own deliberate stop as a failure.
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(events.at(-1)).toEqual({ type: "done" });

    const done = events.find((e) => e.type === "message_done") as { message: Message } | undefined;
    expect(done?.message).toMatchObject({ role: "assistant", content: "half an answer", stopped: true });

    // Persisted, and flagged: the transcript keeps the exchange rather than losing it.
    expect((await messagesOf(session.id)).map((m) => [m.role, m.content, m.stopped === true])).toEqual([
      ["user", "tell me something long", false],
      ["assistant", "half an answer", true],
    ]);

    // The stop reached the provider: the connection was closed mid-turn, not merely
    // abandoned while the model kept generating.
    expect(llm.abortedRequests()).toBe(1);
  });

  it("leaves the conversation usable, with the partial reply in the model's history", async () => {
    const session = await freshSession();
    llm.setTurns([HELD_TURN]);

    const chatPromise = startChat(session.id, "start something");
    await sleep(STOP_AFTER_MS);
    await stop(session.id);
    await chatPromise;

    // The saved partial reply is the assistant's half of the exchange, so this next turn
    // is well formed rather than a second user message in a row.
    llm.setTurns([{ content: "the follow-up" }]);
    const res = await startChat(session.id, "carry on");

    expect(parseSse(res.body).at(-1)).toEqual({ type: "done" });
    expect((await messagesOf(session.id)).map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);

    const history = lastStreamedHistory();
    expect(history.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(history[2]!.content).toBe("half an answer");
  });

  it("does not report usage for a turn that never finished", async () => {
    const session = await freshSession();
    llm.setTurns([HELD_TURN]);

    const chatPromise = startChat(session.id, "and stop");
    await sleep(STOP_AFTER_MS);
    await stop(session.id);
    const events = parseSse((await chatPromise).body) as ChatStreamEvent[];

    // A half-finished step's token counts are not a number worth showing or summing.
    expect(events.some((e) => e.type === "usage")).toBe(false);
    const done = events.find((e) => e.type === "message_done") as { message: Message };
    expect(done.message.usage).toBeUndefined();
  });

  it("is a no-op when nothing is streaming, and 404s for an unknown session", async () => {
    const session = await freshSession();

    // Losing the race to the stream's own `done` is not an error — the stop the client
    // asked for has already happened.
    const idle = await stop(session.id);
    expect(idle.statusCode).toBe(200);
    expect(idle.json()).toEqual({ ok: false });

    expect((await stop("nope")).statusCode).toBe(404);
  });

  /*
   * The map this route consults is keyed by session id alone, so the `ForUser` read in front
   * of it is the only thing standing between an id guess and ending a stranger's turn. That
   * makes it worth a test of its own rather than a line in the generic scoping sweep.
   */
  it("cannot stop another account's turn", async () => {
    const session = await freshSession();
    llm.setTurns([HELD_TURN]);
    const bob = await env.asUser("bob");

    const chatPromise = startChat(session.id, "mine, not yours");
    await sleep(STOP_AFTER_MS);

    expect((await stop(session.id, bob.inject)).statusCode).toBe(404);

    // Still running: the refusal reached nobody.
    expect(llm.abortedRequests()).toBe(0);
    await stop(session.id);
    expect((await (await chatPromise)).statusCode).toBe(200);
    expect(llm.abortedRequests()).toBe(1);
  });
});
