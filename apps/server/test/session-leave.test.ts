import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Session, TitleRetryResult } from "@ilearnassist/shared";
import type { ProviderDef } from "../src/config.js";
import { DEFAULT_SESSION_TITLE } from "../src/db.js";
import { startFakeLlm, type FakeLlm } from "./helpers/fakeLlm.js";
import { newSession, newWorkspace, startTestServer, type TestEnv } from "./helpers/tempEnv.js";

/**
 * The second attempt at a title.
 *
 * The titler runs once, on a conversation's first turn, and the server's hook for it is
 * `finishTurn` — which is not a reader leaving. So this route exists for the two ways a
 * conversation ends up misnamed for good: the titling call failed and what is showing is the
 * user's own clipped words, and the first turn produced no text at all so nothing was attempted.
 *
 * The failures are as much the subject as the success: a leave must never get worse for the
 * asking, so a model that will not answer has to leave the row exactly as it was.
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
  llm.setTitle("A Model Title");
});

async function freshSession(workspaceId?: string): Promise<Session> {
  const workspace =
    workspaceId ??
    (await newWorkspace(env, `W-${Math.random().toString(36).slice(2)}`)).id;
  return newSession(env, workspace);
}

/** One turn. `content` is what the assistant says, and so whether the titler is reached at all. */
async function turn(sessionId: string, message: string, content = "Sure."): Promise<void> {
  llm.setTurns([{ content }]);
  const res = await env.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/chat`,
    payload: { message },
  });
  if (res.statusCode !== 200) throw new Error(`turn failed: ${res.statusCode} ${res.body}`);
}

async function readSession(id: string): Promise<Session | undefined> {
  const res = await env.inject({ method: "GET", url: "/api/workspaces" });
  for (const workspace of res.json<{ id: string }[]>()) {
    const listed = await env.inject({
      method: "GET",
      url: `/api/workspaces/${workspace.id}/sessions`,
    });
    const found = listed.json<Session[]>().find((s) => s.id === id);
    if (found) return found;
  }
  return undefined;
}

async function leave(sessionId: string): Promise<{ statusCode: number; body: TitleRetryResult }> {
  const res = await env.inject({ method: "POST", url: `/api/sessions/${sessionId}/leave` });
  return { statusCode: res.statusCode, body: res.json<TitleRetryResult>() };
}

/** A conversation the titler ran on and failed — the user's own words, recorded as the fallback. */
async function failedTitling(workspaceId?: string): Promise<Session> {
  const session = await freshSession(workspaceId);
  // The fake answers a non-streaming call with its sticky title; an empty one is what makes
  // `generateTitle` throw "returned no title", which is the failure this state comes from.
  llm.setTitle("");
  await turn(session.id, "什么是递归");
  const failed = await readSession(session.id);
  expect(failed?.titleState, "the titler should have fallen back").toBe("fallback");
  return failed!;
}

describe("POST /api/sessions/:id/leave", () => {
  it("tries again and reports the title it settled on", async () => {
    const session = await failedTitling();

    llm.setTitle("递归入门");
    const { statusCode, body } = await leave(session.id);

    expect(statusCode).toBe(200);
    expect(body).toEqual({ status: "titled", title: "递归入门" });
    expect(await readSession(session.id)).toMatchObject({
      title: "递归入门",
      // Still the titler's to change, and now recorded as having succeeded — which is what stops
      // the next leave asking again.
      titleSource: "auto",
      titleState: "model",
    });
  });

  it("does not ask again when the last turn already found nothing to name", async () => {
    /*
     * The decline, end to end, and the reason it is a recorded state rather than a missing one:
     * `unnamed` says the titler **read this conversation** and there was nothing in it to name, so
     * leaving is not an occasion to ask the same question again — the answer would be the same and
     * the call would be paid for twice. A later turn asks again on its own.
     */
    const session = await freshSession();
    llm.setTitle("NO_TITLE");
    await turn(session.id, "你好");

    const declined = await readSession(session.id);
    expect(declined).toMatchObject({
      // No title was written: the placeholder the client sent at creation is still there, which is
      // what "keeps the untitled state" means in the row.
      title: DEFAULT_SESSION_TITLE,
      titleSource: "auto",
      titleState: "unnamed",
    });

    llm.setTitle("递归入门");
    const before = llm.requests().length;
    expect((await leave(session.id)).body).toEqual({ status: "skipped" });
    expect(llm.requests().length).toBe(before);
    expect((await readSession(session.id))?.title).toBe(DEFAULT_SESSION_TITLE);
  });

  it("records a decline on the leave path too, without touching the title", async () => {
    // The same answer arriving at the other end: a conversation the titler failed on, and a model
    // that now reads it and says there is nothing to name.
    const session = await failedTitling();
    const before = await readSession(session.id);

    llm.setTitle("NO_TITLE");
    expect((await leave(session.id)).body).toEqual({ status: "skipped" });
    expect(await readSession(session.id)).toMatchObject({
      title: before!.title,
      titleState: "unnamed",
    });
  });

  it("leaves the row exactly as it was when the model will not answer", async () => {
    /*
     * The half that matters most. A failure must not write the fallback again — that is the string
     * being replaced — and must not mark the attempt as done, or the retry would have no second
     * chance. So: an unchanged title, an unchanged state, and a `failed` the client says nothing
     * about.
     */
    const session = await failedTitling();
    const before = await readSession(session.id);

    llm.setTitle("");
    const { statusCode, body } = await leave(session.id);

    expect(statusCode).toBe(200);
    expect(body).toEqual({ status: "failed" });
    expect(await readSession(session.id)).toMatchObject({
      title: before!.title,
      titleState: "fallback",
    });
  });

  it("says nothing for a conversation the model already named", async () => {
    // Titled on the first turn, so the gate is closed before any model call — asserted on the
    // request count too, because a `skipped` that still paid for a completion would be the wrong
    // answer by the only measure that matters here.
    const session = await freshSession();
    await turn(session.id, "什么是递归");
    expect((await readSession(session.id))?.titleState).toBe("model");
    const before = llm.requests().length;

    expect((await leave(session.id)).body).toEqual({ status: "skipped" });
    expect(llm.requests().length).toBe(before);
  });

  it("says nothing for a conversation a person named", async () => {
    const session = await failedTitling();
    await env.inject({
      method: "PATCH",
      url: `/api/sessions/${session.id}`,
      payload: { title: "我的名字" },
    });

    expect((await leave(session.id)).body).toEqual({ status: "skipped" });
    expect(await readSession(session.id)).toMatchObject({
      title: "我的名字",
      titleSource: "user",
    });
  });

  it("says nothing for a conversation nobody has answered", async () => {
    // Nothing to read: there is no exchange to name, and the next leave is the one that will have
    // something to work with.
    const session = await freshSession();
    expect((await leave(session.id)).body).toEqual({ status: "skipped" });
  });

  it("404s for a conversation that does not exist", async () => {
    expect((await env.inject({ method: "POST", url: "/api/sessions/nope/leave" })).statusCode).toBe(
      404
    );
  });

  it("makes one call when two tabs ask at once", async () => {
    /*
     * The client debounces, but two tabs have two debounces. Joining the in-flight attempt is the
     * server's own guarantee, and the request count is the assertion: a second model call here
     * would be invisible in the responses either way.
     */
    const session = await failedTitling();
    llm.setTitle("递归入门");
    const before = llm.requests().length;

    const [a, b] = await Promise.all([leave(session.id), leave(session.id)]);

    expect([a.body.status, b.body.status]).toEqual(["titled", "titled"]);
    expect(llm.requests().length - before).toBe(1);
  });

  it("numbers the new title against its siblings", async () => {
    /*
     * The titler has no idea what else is in the list, so two conversations that open the same way
     * would otherwise both be called the same thing. **Siblings means the same workspace**: the
     * numbering is scoped to the list the sidebar draws, so a name taken in another one is not
     * taken at all.
     */
    const workspace = await newWorkspace(env, `W-${Math.random().toString(36).slice(2)}`);
    const sibling = await freshSession(workspace.id);
    await env.inject({
      method: "PATCH",
      url: `/api/sessions/${sibling.id}`,
      payload: { title: "递归入门" },
    });

    const session = await failedTitling(workspace.id);
    llm.setTitle("递归入门");

    expect((await leave(session.id)).body.title).toBe("递归入门 (2)");
  });

  it("refuses to re-title a conversation the user renames while it is in flight", async () => {
    /*
     * The race the guarded write exists for, and it is reachable: the client reports on a 3s
     * debounce and the model can take 20s, so a rename lands inside the window easily. The
     * statement carries `title_source = 'auto'`, so the automatic title is refused rather than
     * overwriting the name a person chose — and the answer says `skipped`, because nothing was
     * written.
     */
    const session = await failedTitling();
    llm.setTitle("递归入门");
    const pending = leave(session.id);

    await env.inject({
      method: "PATCH",
      url: `/api/sessions/${session.id}`,
      payload: { title: "我的名字" },
    });

    expect((await pending).body).toEqual({ status: "skipped" });
    expect(await readSession(session.id)).toMatchObject({
      title: "我的名字",
      titleSource: "user",
    });
  });
});
