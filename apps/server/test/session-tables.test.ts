import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ChatStreamEvent, Table } from "@ilearnassist/shared";
import type { ProviderDef } from "../src/config.js";
import { parseSse } from "./helpers/sse.js";
import { startFakeLlm, type FakeLlm } from "./helpers/fakeLlm.js";
import { newSession, newWorkspace, startTestServer, type TestEnv } from "./helpers/tempEnv.js";

/**
 * `GET /api/sessions/:id/tables`: the panel's read model over the rows the tool writes.
 *
 * `session-diagrams.test.ts`'s twin, and the shape of the test is the same question one level
 * over — a turn that records a table, and the list that comes back. One case is deliberately
 * *absent*: there is no `fileMissing` test, because a table has no file to be missing, and the
 * absence of that field on the wire is what the type says.
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

const TABLE = "| 项目 | 数值 |\n| --- | --- |\n| 速度 | 3 |";

async function getTables(sessionId: string): Promise<{ status: number; body: unknown }> {
  const res = await env.inject({ method: "GET", url: `/api/sessions/${sessionId}/tables` });
  return { status: res.statusCode, body: res.json() };
}

/** One turn that records a table, then says it is done. */
async function recordTable(env: TestEnv, sessionId: string, name: string): Promise<void> {
  llm.setTurns([
    {
      content: "我记录一下。",
      toolCalls: [
        {
          id: "call_t1",
          name: "ila_table",
          args: { name, table: TABLE, summary: "三项指标的对比" },
        },
      ],
    },
    { content: "记好了。" },
  ]);
  const chat = await env.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/chat`,
    payload: { message: "记一个表格" },
  });
  expect(chat.statusCode).toBe(200);
  const events = parseSse(chat.body) as ChatStreamEvent[];
  // The call succeeded rather than being refused — the rows below are then about the write, not
  // about a tool error the fake LLM would happily have streamed anyway.
  expect(events.some((e) => e.type === "tool_end")).toBe(true);
}

describe("GET /api/sessions/:id/tables", () => {
  it("answers an empty list for a conversation that recorded nothing", async () => {
    const workspace = await newWorkspace(env, "tables-empty");
    const session = await newSession(env, workspace.id);

    const { status, body } = await getTables(session.id);
    expect(status).toBe(200);
    expect(body).toEqual({ tables: [] });
  });

  it("answers 404 for a session that is not yours", async () => {
    // The same collapse as every session route: "not yours" and "never existed" give one answer,
    // so an id cannot be probed.
    const res = await env.inject({ method: "GET", url: "/api/sessions/no-such-session/tables" });
    expect(res.statusCode).toBe(404);
  });

  it("lists a table recorded in a turn, content included", async () => {
    const workspace = await newWorkspace(env, "tables-one");
    const session = await newSession(env, workspace.id);
    await recordTable(env, session.id, "季度对比");

    const { status, body } = await getTables(session.id);
    expect(status).toBe(200);
    const tables = (body as { tables: Table[] }).tables;
    expect(tables).toHaveLength(1);
    expect(tables[0]).toMatchObject({
      name: "季度对比",
      summary: "三项指标的对比",
      // The row *is* the artifact: no file is opened to render this, which is the whole reason a
      // table's read can be one request where a diagram's needs two.
      content: TABLE,
      toolCallId: "call_t1",
      threadId: null,
      threadTitle: null,
    });
    expect(tables[0]?.id).toBeTypeOf("string");
    // And nothing on the wire claims a file exists, because none does.
    expect(tables[0]).not.toHaveProperty("fileMissing");
  });

  it("hides another account's list behind its own 404, not an empty 200", async () => {
    const workspace = await newWorkspace(env, "tables-private");
    const session = await newSession(env, workspace.id);
    await recordTable(env, session.id, "私有表格");

    const bob = await env.asUser("TableBob");
    const res = await bob.inject({ method: "GET", url: `/api/sessions/${session.id}/tables` });
    expect(res.statusCode).toBe(404);
  });
});
