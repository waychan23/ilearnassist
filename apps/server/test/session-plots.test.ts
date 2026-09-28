import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ChatStreamEvent, Plot } from "@ilearnassist/shared";
import type { ProviderDef } from "../src/config.js";
import { parseSse } from "./helpers/sse.js";
import { startFakeLlm, type FakeLlm } from "./helpers/fakeLlm.js";
import { newSession, newWorkspace, startTestServer, type TestEnv } from "./helpers/tempEnv.js";

/**
 * `GET /api/sessions/:id/plots`: the panel's read model over the rows the tool writes.
 *
 * `session-tables.test.ts`'s twin, with the one field a table has and a plot does not swapped: a
 * plot's row carries the JSON `spec` rather than markdown, and there is no `fileMissing` case
 * because there is no file. What the spec *means* is the renderer's business; this file pins that
 * it is stored verbatim and delivered whole.
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
});

const SPEC = { elements: [{ kind: "function", expr: "x^2", from: -3, to: 3 }] };

async function getPlots(sessionId: string): Promise<{ status: number; body: unknown }> {
  const res = await env.inject({ method: "GET", url: `/api/sessions/${sessionId}/plots` });
  return { status: res.statusCode, body: res.json() };
}

/** One turn that plots a figure, then says it is done. */
async function plotFigure(env: TestEnv, sessionId: string, name: string): Promise<void> {
  llm.setTurns([
    {
      content: "我画一下。",
      toolCalls: [
        {
          id: "call_p1",
          name: "ila_plot",
          args: { name, spec: SPEC, summary: "抛物线 y=x²" },
        },
      ],
    },
    { content: "画好了。" },
  ]);
  const chat = await env.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/chat`,
    payload: { message: "画个抛物线" },
  });
  expect(chat.statusCode).toBe(200);
  const events = parseSse(chat.body) as ChatStreamEvent[];
  // The call succeeded rather than being refused — the rows below are about the write, not about
  // a tool error the fake LLM would happily have streamed anyway.
  expect(events.some((e) => e.type === "tool_end")).toBe(true);
}

describe("GET /api/sessions/:id/plots", () => {
  it("answers an empty list for a conversation that plotted nothing", async () => {
    const workspace = await newWorkspace(env, "plots-empty");
    const session = await newSession(env, workspace.id);

    const { status, body } = await getPlots(session.id);
    expect(status).toBe(200);
    expect(body).toEqual({ plots: [] });
  });

  it("answers 404 for a session that is not yours", async () => {
    const res = await env.inject({ method: "GET", url: "/api/sessions/no-such-session/plots" });
    expect(res.statusCode).toBe(404);
  });

  it("lists a figure plotted in a turn, spec included", async () => {
    const workspace = await newWorkspace(env, "plots-one");
    const session = await newSession(env, workspace.id);
    await plotFigure(env, session.id, "抛物线");

    const { status, body } = await getPlots(session.id);
    expect(status).toBe(200);
    const plots = (body as { plots: Plot[] }).plots;
    expect(plots).toHaveLength(1);
    expect(plots[0]).toMatchObject({
      name: "抛物线",
      summary: "抛物线 y=x²",
      // The row *is* the artifact: the panel hands this straight to the renderer, no file and no
      // second request.
      spec: JSON.stringify({ elements: [{ kind: "function", expr: "x^2", from: -3, to: 3 }] }),
      toolCallId: "call_p1",
      threadId: null,
      threadTitle: null,
    });
    expect(plots[0]?.id).toBeTypeOf("string");
    // And nothing on the wire claims a file exists, because none does.
    expect(plots[0]).not.toHaveProperty("fileMissing");
  });

  it("hides another account's list behind its own 404, not an empty 200", async () => {
    const workspace = await newWorkspace(env, "plots-private");
    const session = await newSession(env, workspace.id);
    await plotFigure(env, session.id, "私有图");

    const bob = await env.asUser("PlotBob");
    const res = await bob.inject({ method: "GET", url: `/api/sessions/${session.id}/plots` });
    expect(res.statusCode).toBe(404);
  });
});
