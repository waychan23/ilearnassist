import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { GenerateSessionInsightsResponse, GetSessionInsightsResponse, Session } from "@ilearnassist/shared";
import type { ProviderDef } from "../src/config.js";
import { startFakeLlm, type FakeLlm } from "./helpers/fakeLlm.js";
import { newSession, newWorkspace, startTestServer, type TestEnv } from "./helpers/tempEnv.js";

/**
 * The insight routes over HTTP.
 *
 * The pass goes through the **real** path — `ChatOpenAI` → `makeInsightGenerator` →
 * `generateInsights` → the transaction — against the fake provider, so this is the only place
 * that proves the pieces are wired to each other rather than merely correct in isolation.
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
  llm.setTitle("Insight conversation");
});

/**
 * A conversation with **no widgets installed**, deliberately.
 *
 * The routes are about the *object*, not about the panel that shows it: an observation outlives
 * the widget, the same reason `/notes` and `/threads` are not gated on theirs. A test that
 * installed the widget first would leave that unproven — and would not notice the day a route
 * acquired a dependency it should not have.
 *
 * **And with one note**, because a pass only runs when there is something to read: the readable
 * sources are all derived, so a bare conversation answers `"empty"` without calling the model.
 * Every case about the pass itself needs material, and without this they would all be asserting
 * the skip. `bareSession()` is the one without, so that answer has a subject of its own.
 */
async function insightSession(): Promise<Session> {
  const session = await bareSession();
  await addNote(session.id);
  return session;
}

/** The same conversation with nothing derived in it yet. */
async function bareSession(): Promise<Session> {
  const workspace = await newWorkspace(env, `W-${Math.random().toString(36).slice(2)}`);
  return newSession(env, workspace.id);
}

async function addNote(sessionId: string): Promise<void> {
  const res = await env.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/notes`,
    payload: { type: "idea", content: "这里我还是不太懂", quote: "", occurrence: 0 },
  });
  expect(res.statusCode).toBe(201);
}

const list = async (sessionId: string): Promise<GetSessionInsightsResponse> => {
  const res = await env.inject({ method: "GET", url: `/api/sessions/${sessionId}/insights` });
  expect(res.statusCode).toBe(200);
  return res.json<GetSessionInsightsResponse>();
};

const generate = async (sessionId: string): Promise<GenerateSessionInsightsResponse> => {
  const res = await env.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/insights/generate`,
  });
  expect(res.statusCode).toBe(200);
  return res.json<GenerateSessionInsightsResponse>();
};

/** What the pass will answer with: the fake LLM matches on the fenced record's marker. */
function answer(items: unknown[]): void {
  llm.setMatches([{ includes: "<study_record>", content: JSON.stringify({ items }) }]);
}

describe("the insight routes", () => {
  it("runs a pass and answers with the new list", async () => {
    const session = await insightSession();
    answer([
      { type: "difficulty", title: "递归", body: "反复出错" },
      { type: "habit", title: "只看不练" },
    ]);

    const result = await generate(session.id);

    expect(result.status).toBe("ok");
    expect(result.items.map((i) => i.title)).toEqual(["递归", "只看不练"]);
    expect(result.items.every((i) => !i.adopted)).toBe(true);
    // And the read route agrees with it, which is what the panel will do on the next reload.
    expect((await list(session.id)).items).toHaveLength(2);
  });

  it("adopts one, and the next pass keeps it while replacing the rest", async () => {
    const session = await insightSession();
    answer([{ type: "difficulty", title: "留着" }, { type: "advice", title: "换掉" }]);
    const first = await generate(session.id);
    const kept = first.items.find((i) => i.title === "留着")!;

    const patch = await env.inject({
      method: "PATCH",
      url: `/api/sessions/${session.id}/insights/${kept.id}`,
      payload: { adopted: true },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json<{ item: { adopted: boolean } }>().item.adopted).toBe(true);

    answer([{ type: "advice", title: "新的" }]);
    const second = await generate(session.id);

    expect(second.items.map((i) => i.title)).toEqual(["留着", "新的"]);
    expect(second.items[0]!.id).toBe(kept.id);
  });

  it("refuses a non-boolean adopted rather than coercing it", async () => {
    /*
     * `"false"` is truthy, so a coerced field stores the opposite of what was asked for — the
     * same failure `PATCH /api/admin/users/:id` refuses a stringified `disabled` for.
     */
    const session = await insightSession();
    answer([{ title: "条目" }]);
    const { items } = await generate(session.id);

    for (const adopted of ["false", 1, null]) {
      const res = await env.inject({
        method: "PATCH",
        url: `/api/sessions/${session.id}/insights/${items[0]!.id}`,
        payload: { adopted },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: { code: string } }>().error.code).toBe("INVALID_FIELD");
    }
    expect((await list(session.id)).items[0]!.adopted).toBe(false);
  });

  it("deletes one observation", async () => {
    const session = await insightSession();
    answer([{ title: "一" }, { title: "二" }]);
    const { items } = await generate(session.id);

    const res = await env.inject({
      method: "DELETE",
      url: `/api/sessions/${session.id}/insights/${items[0]!.id}`,
    });
    expect(res.statusCode).toBe(200);
    expect((await list(session.id)).items.map((i) => i.title)).toEqual(["二"]);
  });

  it("answers a conversation with nothing to reflect on with 200 and a distinct status", async () => {
    /*
     * `"empty"` and `"failed"` both arrive with zero new items and mean opposite things to a
     * reader — "go and have a conversation first" against "go and fix the provider" — so the
     * server has to be the one that says which, and the panel cannot infer it.
     *
     * The model is scripted as if a pass ran, so an implementation that called it anyway would
     * fill the list and fail here rather than passing quietly.
     */
    const session = await bareSession();
    answer([{ title: "不该出现" }]);

    const res = await env.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/insights/generate`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<GenerateSessionInsightsResponse>()).toMatchObject({
      status: "empty",
      generated: 0,
      items: [],
    });
    expect((await list(session.id)).items).toEqual([]);
    // No insight request reached the provider at all.
    expect(llm.requests().filter((r) => JSON.stringify(r).includes("study_record"))).toHaveLength(0);
  });

  it("answers a failed pass with 200 and the list untouched", async () => {
    // A provider that says something unusable is a fact about the pass, not an error the panel
    // should render as one — and the rows are the user's, so they stay exactly as they were.
    const session = await insightSession();
    answer([{ title: "已有的" }]);
    await generate(session.id);

    llm.setMatches([{ includes: "<study_record>", content: "I have nothing to say." }]);
    const result = await generate(session.id);

    expect(result.status).toBe("failed");
    expect(result.items.map((i) => i.title)).toEqual(["已有的"]);
  });

  it("reports an unknown insight id as not found, not as a silent success", async () => {
    const session = await insightSession();
    const missing = await env.inject({
      method: "DELETE",
      url: `/api/sessions/${session.id}/insights/does-not-exist`,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json<{ error: { code: string } }>().error.code).toBe("INSIGHT_NOT_FOUND");

    const patch = await env.inject({
      method: "PATCH",
      url: `/api/sessions/${session.id}/insights/does-not-exist`,
      payload: { adopted: true },
    });
    expect(patch.statusCode).toBe(404);
  });

  it("answers 404 for a session that is not this account's", async () => {
    // "Not yours" and "does not exist" answer the same way on purpose, so an id cannot be probed.
    const res = await env.inject({
      method: "GET",
      url: "/api/sessions/00000000-0000-0000-0000-000000000000/insights",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("SESSION_NOT_FOUND");
  });
});
