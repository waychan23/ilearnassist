import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  ChatStreamEvent,
  GetSessionThreadsResponse,
  Session,
} from "@ilearnassist/shared";
import type { ProviderDef } from "../src/config.js";
import { parseSse } from "./helpers/sse.js";
import { startFakeLlm, type FakeLlm } from "./helpers/fakeLlm.js";
import { newSession, newWorkspace, startTestServer, type TestEnv } from "./helpers/tempEnv.js";

/**
 * The thread widget over HTTP: the post-turn sync classifies while the widget is installed
 * and makes no model call when it is not; the sync route drives a backfill and swallows a
 * classifier failure; the GET route is the panel's read model.
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
  llm.setTitle("Thread conversation");
});

/** Every non-streaming request whose body carries the classifier's marker is one of ours. */
function classifierRequests(): number {
  return llm.requests().filter((r) => JSON.stringify(r).includes("topic-classification")).length;
}

/** One classifier decision per turn the pending run contains. */
function classifierAnswer(decisions: unknown[]): void {
  llm.setMatches([{ includes: "<new_turns>", content: JSON.stringify({ decisions }) }]);
}

async function threadSession(widgets: string[] = ["thread"]): Promise<Session> {
  const workspace = await newWorkspace(env, `W-${Math.random().toString(36).slice(2)}`);
  return newSession(env, workspace.id, { widgets });
}

async function chat(sessionId: string, message: string) {
  const res = await env.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/chat`,
    payload: { message },
  });
  return { res, events: parseSse(res.body) as ChatStreamEvent[] };
}

async function getThreads(sessionId: string): Promise<GetSessionThreadsResponse> {
  const res = await env.inject({ method: "GET", url: `/api/sessions/${sessionId}/threads` });
  expect(res.statusCode).toBe(200);
  return res.json<GetSessionThreadsResponse>();
}

async function syncThreads(sessionId: string) {
  const res = await env.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/threads/sync`,
  });
  expect(res.statusCode).toBe(200);
  return res.json<GetSessionThreadsResponse>();
}

/** The post-turn sync is fire-and-forget; poll its read model. */
async function waitForClassified(sessionId: string): Promise<GetSessionThreadsResponse> {
  for (let i = 0; i < 100; i++) {
    const view = await getThreads(sessionId);
    if (view.unassigned === 0 && view.threads.length > 0) return view;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("post-turn sync never classified the turn");
}

describe("GET /sessions/:id/threads", () => {
  it("404s a conversation that does not exist", async () => {
    const res = await env.inject({ method: "GET", url: "/api/sessions/does-not-exist/threads" });
    expect(res.statusCode).toBe(404);
  });

  it("starts empty with a backlog count, not a 404", async () => {
    const session = await threadSession();
    const view = await getThreads(session.id);
    expect(view).toEqual({ threads: [], unassigned: 0 });
  });
});

describe("post-turn classification", () => {
  it("classifies the turn after it ends while the widget is installed", async () => {
    const session = await threadSession();
    classifierAnswer([{ thread: "new", branch: "other", title: "问候" }]);

    const { events } = await chat(session.id, "你好");
    expect(events.at(-1)).toEqual({ type: "done" });

    const view = await waitForClassified(session.id);
    expect(view.threads).toHaveLength(1);
    expect(view.threads[0]).toMatchObject({ branch: "other", title: "问候" });
    // Both messages of the turn land in one thread.
    expect(view.threads[0]!.messages).toHaveLength(2);
    expect(classifierRequests()).toBe(1);
  });

  it("makes no classifier call when the widget is not installed", async () => {
    const session = await threadSession([]);
    const { events } = await chat(session.id, "你好");
    expect(events.at(-1)).toEqual({ type: "done" });
    // Give a fire-and-forget hook that should not exist a moment to wrongly fire.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(classifierRequests()).toBe(0);
    const view = await getThreads(session.id);
    expect(view.threads).toEqual([]);
    expect(view.unassigned).toBe(2);
  });

  async function getDiagrams(sessionId: string): Promise<{ id: string; threadId: string | null; threadTitle: string | null }[]> {
    const res = await env.inject({ method: "GET", url: `/api/sessions/${sessionId}/diagrams` });
    expect(res.statusCode).toBe(200);
    return (res.json() as { diagrams: { id: string; threadId: string | null; threadTitle: string | null }[] })
      .diagrams;
  }

  /** A turn that draws one diagram, queued for the next chat. */
  function turnDrawingDiagram(name: string): void {
    llm.setTurns([
      {
        content: "我画一张图。",
        toolCalls: [
          {
            id: "call_d1",
            name: "ila_diagram",
            args: { name, source: "flowchart TD\n  A --> B", summary: "登录流程图" },
          },
        ],
      },
      { content: "画好了。" },
    ]);
  }

  it("places a diagram drawn in the turn into its classified thread", async () => {
    const session = await threadSession();
    // The classifier names the turn and also the diagram; "continue" lands it in the new thread.
    llm.setMatches([
      {
        includes: "<new_turns>",
        content: JSON.stringify({
          decisions: [{ thread: "new", branch: "other", title: "登录" }],
          diagrams: [{ ref: "d1", thread: "continue" }],
        }),
      },
    ]);
    turnDrawingDiagram("auth flow");
    await chat(session.id, "画个登录流程图");

    await waitForClassified(session.id);
    const diagrams = await getDiagrams(session.id);
    expect(diagrams).toHaveLength(1);
    expect(diagrams[0]).toMatchObject({ threadTitle: "登录" });
    expect(diagrams[0]!.threadId).not.toBeNull();
  });

  it("still classifies the turn when a diagram decision is unusable, and the diagram collapses", async () => {
    const session = await threadSession();
    llm.setMatches([
      {
        includes: "<new_turns>",
        // Valid turn decision; an unknown ref and "new" for the diagram are both dropped.
        content: JSON.stringify({
          decisions: [{ thread: "new", branch: "other", title: "登录" }],
          diagrams: [
            { ref: "d9", thread: "e7" },
            { ref: "d1", thread: "new" },
          ],
        }),
      },
    ]);
    turnDrawingDiagram("flow");
    await chat(session.id, "画个流程图");

    const view = await waitForClassified(session.id);
    expect(view.threads.map((t) => t.title)).toEqual(["登录"]);
    const diagrams = await getDiagrams(session.id);
    expect(diagrams[0]!.threadTitle).toBe("登录");
  });

  it("does not call the model again once nothing is unassigned", async () => {
    const session = await threadSession();
    classifierAnswer([{ thread: "new", branch: "other", title: "问候" }]);
    await chat(session.id, "你好");
    await waitForClassified(session.id);

    const after = classifierRequests();
    await syncThreads(session.id);
    expect(classifierRequests()).toBe(after);
  });
});

describe("POST /sessions/:id/threads/sync", () => {
  it("backfills a session the widget was only just installed on", async () => {
    // Widget absent for the first two turns, so nothing classified as they happened.
    const session = await threadSession([]);
    classifierAnswer([{ thread: "new", branch: "other", title: "第一个话题" }]);
    await chat(session.id, "第一句话");
    await new Promise((resolve) => setTimeout(resolve, 50));
    classifierAnswer([{ thread: "new", branch: "other", title: "第二个话题" }]);
    await chat(session.id, "第二句话");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await getThreads(session.id)).threads).toEqual([]);

    // Install mid-session (the client's onInstall calls this same route), then classify.
    const install = await env.inject({
      method: "PUT",
      url: `/api/sessions/${session.id}/widgets/thread`,
      payload: { enabled: true },
    });
    expect(install.statusCode).toBe(200);

    classifierAnswer([
      { thread: "new", branch: "other", title: "第一个话题" },
      { thread: "new", branch: "other", title: "第二个话题" },
    ]);
    let view = await syncThreads(session.id);
    while (view.unassigned > 0) view = await syncThreads(session.id);

    expect(view.threads.map((t) => t.title)).toEqual(["第一个话题", "第二个话题"]);
  });

  it("swallows a classifier failure and leaves the backlog for later", async () => {
    const session = await threadSession();
    classifierAnswer([{ thread: "bogus" }]);
    await chat(session.id, "你好");
    // Let the post-turn attempt fail first.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const view = await syncThreads(session.id);
    expect(view.threads).toEqual([]);
    expect(view.unassigned).toBe(2);
  });

  it("404s a conversation that does not exist", async () => {
    const res = await env.inject({
      method: "POST",
      url: "/api/sessions/does-not-exist/threads/sync",
    });
    expect(res.statusCode).toBe(404);
  });
});
