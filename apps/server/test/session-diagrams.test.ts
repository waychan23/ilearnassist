import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ChatStreamEvent, Diagram, Workspace } from "@ilearnassist/shared";
import type { ProviderDef } from "../src/config.js";
import { parseSse } from "./helpers/sse.js";
import { startFakeLlm, type FakeLlm } from "./helpers/fakeLlm.js";
import { newSession, newWorkspace, startTestServer, type TestEnv } from "./helpers/tempEnv.js";

/**
 * `GET /api/sessions/:id/diagrams`: the panel's read model over the rows the tool writes.
 *
 * Most of the row's behaviour (the upsert, the revise, the cleared thread) is a unit test
 * against a real database in `diagrams.test.ts`. What is here is the HTTP seam: an empty
 * list is a 200, another account's session is a 404, and a diagram drawn in a real turn
 * comes back with its file checked on disk — including when that file is gone.
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

async function getDiagrams(sessionId: string): Promise<{ status: number; body: unknown }> {
  const res = await env.inject({ method: "GET", url: `/api/sessions/${sessionId}/diagrams` });
  return { status: res.statusCode, body: res.json() };
}

describe("GET /api/sessions/:id/diagrams", () => {
  it("answers an empty list for a conversation that drew nothing", async () => {
    const workspace = await newWorkspace(env, "diagrams-empty");
    const session = await newSession(env, workspace.id);

    const { status, body } = await getDiagrams(session.id);
    expect(status).toBe(200);
    expect(body).toEqual({ diagrams: [] });
  });

  it("answers 404 for a session that is not yours", async () => {
    // The same collapse as every session route: "not yours" and "never existed" give one
    // answer, so an id cannot be probed.
    const res = await env.inject({ method: "GET", url: "/api/sessions/no-such-session/diagrams" });
    expect(res.statusCode).toBe(404);
  });

  it("lists a diagram drawn in a turn, with its file present", async () => {
    const workspace = await newWorkspace(env, "diagrams-one");
    const session = await newSession(env, workspace.id);

    llm.setTurns([
      {
        content: "我画一张图。",
        toolCalls: [
          {
            id: "call_d1",
            name: "ila_diagram",
            args: { name: "auth flow", source: "flowchart TD\n  A --> B", summary: "登录流程图" },
          },
        ],
      },
      { content: "画好了。" },
    ]);
    const chat = await env.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/chat`,
      payload: { message: "draw it" },
    });
    expect(chat.statusCode).toBe(200);
    const chatEvents = parseSse(chat.body) as ChatStreamEvent[];
    expect(chatEvents.some((e) => e.type === "tool_end")).toBe(true);

    const { status, body } = await getDiagrams(session.id);
    expect(status).toBe(200);
    const diagrams = (body as { diagrams: Diagram[] }).diagrams;
    expect(diagrams).toHaveLength(1);
    expect(diagrams[0]).toMatchObject({
      name: "auth-flow.mmd",
      summary: "登录流程图",
      toolCallId: "call_d1",
      threadId: null,
      threadTitle: null,
      fileMissing: false,
    });
    expect(diagrams[0]?.id).toBeTypeOf("string");
  });

  it("reports a row whose file is gone rather than offering a dead open", async () => {
    const workspace = await newWorkspace(env, "diagrams-missing");
    const session = await newSession(env, workspace.id);
    const full = workspace as Workspace;

    llm.setTurns([
      {
        toolCalls: [
          {
            id: "call_d2",
            name: "ila_diagram",
            args: { name: "gone", source: "flowchart TD\n  A --> B", summary: "会消失的图" },
          },
        ],
      },
      { content: "done" },
    ]);
    await env.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/chat`,
      payload: { message: "draw it" },
    });

    // The on-disk half goes away; the row survives and says so, the same way a note whose
    // message was deleted reports `messageMissing`.
    rmSync(join(full.dirPath, "sessions", session.id, "gone.mmd"), { force: true });

    const diagrams = (await getDiagrams(session.id)).body as { diagrams: Diagram[] };
    expect(diagrams.diagrams[0]?.fileMissing).toBe(true);
  });
});
