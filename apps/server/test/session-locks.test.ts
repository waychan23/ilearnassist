import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SESSION_LOCK_TTL_SECONDS, type Session, type SessionLockView } from "@ilearnassist/shared";
import { startFakeLlm, type FakeLlm } from "./helpers/fakeLlm.js";
import { newSession, newWorkspace, startTestServer, type TestEnv } from "./helpers/tempEnv.js";
import type { ProviderDef } from "../src/config.js";

/**
 * Session write locks, over real requests.
 *
 * Two clients of **one account** is the situation the lock is about, and it is what `asClient`
 * exists for — `asUser` would make a second account, which is a different question (that one is
 * answered by a 404, and is asserted here too, because a lock must not become a way to probe for
 * conversations).
 *
 * `route-lock-coverage.test.ts` is the other half: it proves the flag is on the right routes,
 * which no request can show.
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

/** The two clients every test below is about. Same token, different ids — see `asClient`. */
const FIRST = "client-alpha";
const SECOND = "client-beta";

let workspaceId: string;
let session: Session;

beforeEach(async () => {
  workspaceId = (await newWorkspace(env)).id;
  session = await newSession(env, workspaceId);
});

const asFirst = () => env.asClient(FIRST);
const asSecond = () => env.asClient(SECOND);

function lock(id: string, client = asFirst()) {
  return client({ method: "POST", url: `/api/sessions/${id}/lock` });
}

function unlock(id: string, client = asFirst()) {
  return client({ method: "DELETE", url: `/api/sessions/${id}/lock` });
}

function locks(client = asFirst()) {
  return client({ method: "GET", url: `/api/workspaces/${workspaceId}/locks` });
}

/** Push a lease's expiry into the past, which is the only way to test an expiry without waiting. */
function expire(id: string): void {
  env.server.db.raw
    .prepare("UPDATE session_locks SET expires_at = ? WHERE session_id = ?")
    .run(new Date(Date.now() - 1_000).toISOString(), id);
}

function storedExpiry(id: string): string {
  const row = env.server.db.raw
    .prepare("SELECT expires_at FROM session_locks WHERE session_id = ?")
    .get(id) as { expires_at: string } | undefined;
  return row?.expires_at ?? "";
}

describe("POST /api/sessions/:id/lock", () => {
  it("takes a free conversation and reports it as this client's", async () => {
    const res = await lock(session.id);
    expect(res.statusCode).toBe(200);
    const { lock: lease } = res.json<{ lock: SessionLockView }>();
    expect(lease).toMatchObject({ sessionId: session.id, clientId: FIRST, mine: true });
    expect(new Date(lease.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("refuses a second client while the lease is live", async () => {
    await lock(session.id);
    const res = await asSecond()({ method: "POST", url: `/api/sessions/${session.id}/lock` });

    expect(res.statusCode).toBe(409);
    // The code is what the client keys its wording on, so it is part of the contract.
    expect(res.json<{ error: { code: string } }>().error.code).toBe("SESSION_LOCKED");
  });

  it("treats the holder's own second call as a beat, not an error", async () => {
    // The requirement's re-entrancy rule. It falls out of the statement rather than being a
    // branch, which is why the assertion is that nothing about the lease was *reset* except its
    // expiry — a fresh acquire would have moved `acquiredAt` too.
    const first = (await lock(session.id)).json<{ lock: SessionLockView }>().lock;
    const again = await lock(session.id);
    const second = again.json<{ lock: SessionLockView }>().lock;

    expect(again.statusCode).toBe(200);
    expect(second.acquiredAt).toBe(first.acquiredAt);
    expect(new Date(second.expiresAt).getTime()).toBeGreaterThanOrEqual(
      new Date(first.expiresAt).getTime()
    );
  });

  it("hands an expired conversation to whoever asks next", async () => {
    await lock(session.id);
    expire(session.id);

    const res = await asSecond()({ method: "POST", url: `/api/sessions/${session.id}/lock` });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ lock: SessionLockView }>().lock.clientId).toBe(SECOND);
  });

  it("refuses a client that does not say who it is, and does not let it take the lease", async () => {
    // A request with no id cannot be told apart from one that is not the holder. The second half
    // of this is the one that matters: if it were allowed to *take* the lease, it would leave a
    // row nobody could ever release, and the conversation would be stuck read-only for everyone.
    //
    // `env.inject` deliberately cannot express this — it is the harness's whole-account request
    // and carries the default client id — so this goes to the app directly with the token and no
    // client header at all, which is what a script or an older client looks like.
    const anonymous = await env.server.app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/lock`,
      headers: { authorization: `Bearer ${env.token}` },
    });

    expect(anonymous.statusCode).toBe(409);
    expect(
      env.server.db.raw
        .prepare("SELECT COUNT(*) AS n FROM session_locks WHERE session_id = ?")
        .get(session.id)
    ).toEqual({ n: 0 });
    // And the conversation is genuinely still free.
    expect((await lock(session.id)).statusCode).toBe(200);
  });

  it("refuses an anonymous write to a conversation somebody holds", async () => {
    // The write gate's half of the rule above, and the same reasoning: without a name there is no
    // way to be the holder, so a conversation somebody is in cannot be written to anonymously.
    await lock(session.id);
    const anonymous = await env.server.app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/chat`,
      payload: { message: "hello" },
      headers: { authorization: `Bearer ${env.token}` },
    });

    expect(anonymous.statusCode).toBe(409);
  });

  it("answers 404 for another account's conversation, never 409", async () => {
    // The rule every owner-scoped route keeps: "not yours" and "does not exist" are one answer,
    // or the route becomes a way to find out which conversations exist.
    const other = await env.asUser("outsider-lock");
    const res = await other.inject({ method: "POST", url: `/api/sessions/${session.id}/lock` });

    expect(res.statusCode).toBe(404);
  });
});

describe("DELETE /api/sessions/:id/lock", () => {
  it("releases the holder's lease, and then the other client can take it", async () => {
    await lock(session.id);
    expect((await unlock(session.id)).json<{ released: boolean }>().released).toBe(true);
    expect((await lock(session.id, asSecond())).statusCode).toBe(200);
  });

  it("says so rather than failing when there is nothing of its own to release", async () => {
    // A stale tab doing this is ordinary, and the caller is leaving either way — the same reason
    // `/leave` always answers 200.
    await lock(session.id);
    const res = await unlock(session.id, asSecond());

    expect(res.statusCode).toBe(200);
    expect(res.json<{ released: boolean }>().released).toBe(false);
    // Crucially, it did *not* release somebody else's lease on the way past.
    expect((await lock(session.id, asSecond())).statusCode).toBe(409);
  });

  it("lets the holder tidy up a lease that already expired", async () => {
    await lock(session.id);
    expire(session.id);
    expect((await unlock(session.id)).json<{ released: boolean }>().released).toBe(true);
  });
});

describe("GET /api/workspaces/:workspaceId/locks", () => {
  it("returns the live leases with mine set for the asking client", async () => {
    const other = await newSession(env, workspaceId);
    await lock(session.id);
    await lock(other.id, asSecond());

    const first = (await locks()).json<{ locks: SessionLockView[] }>().locks;
    expect(first.map((l) => [l.sessionId, l.mine]).sort()).toEqual(
      [
        [session.id, true],
        [other.id, false],
      ].sort()
    );

    const second = (await locks(asSecond())).json<{ locks: SessionLockView[] }>().locks;
    expect(second.map((l) => [l.sessionId, l.mine]).sort()).toEqual(
      [
        [session.id, false],
        [other.id, true],
      ].sort()
    );
  });

  it("drops a lease once it has expired", async () => {
    await lock(session.id);
    expire(session.id);
    expect((await locks()).json<{ locks: SessionLockView[] }>().locks).toEqual([]);
  });

  it("is one request for the whole workspace, not one per conversation", async () => {
    // The shape exists so the session list can be marked without a request per row. Several
    // conversations, several holders, one reply.
    const ids = [session.id];
    for (let i = 0; i < 3; i += 1) ids.push((await newSession(env, workspaceId)).id);
    await lock(ids[0]!);
    await lock(ids[1]!, asSecond());
    await lock(ids[3]!);

    expect((await locks()).json<{ locks: SessionLockView[] }>().locks).toHaveLength(3);
  });

  it("answers 404 for a workspace this account does not own", async () => {
    const other = await env.asUser("outsider-locks");
    const res = await other.inject({ method: "GET", url: `/api/workspaces/${workspaceId}/locks` });
    expect(res.statusCode).toBe(404);
  });
});

describe("the write gate", () => {
  it("refuses a turn from a client that does not hold the conversation", async () => {
    await lock(session.id);
    const res = await asSecond()({
      method: "POST",
      url: `/api/sessions/${session.id}/chat`,
      payload: { message: "hello" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("SESSION_LOCKED");
  });

  it("refuses the second client's rename and message delete too", async () => {
    // "Read-only" is the whole conversation, not just the turn: renaming or deleting the thing
    // somebody else is editing is the same interleaving one route over.
    await lock(session.id);

    const renamed = await asSecond()({
      method: "PATCH",
      url: `/api/sessions/${session.id}`,
      payload: { title: "mine now" },
    });
    expect(renamed.statusCode).toBe(409);

    const deleted = await asSecond()({
      method: "DELETE",
      url: `/api/sessions/${session.id}/messages/nope`,
    });
    expect(deleted.statusCode).toBe(409);
  });

  it("still lets that client read everything about it", async () => {
    // The refusal has to be a read-only conversation rather than an invisible one: the client
    // shows the messages and explains itself, which it cannot do with nothing.
    await lock(session.id);
    const second = asSecond();

    for (const url of [
      `/api/sessions/${session.id}/messages`,
      `/api/sessions/${session.id}/resources`,
      `/api/sessions/${session.id}/stats`,
    ]) {
      expect((await second({ method: "GET", url })).statusCode).toBe(200);
    }
  });

  it("lets the other client leave, because the release travels that way", async () => {
    await lock(session.id);
    const res = await asSecond()({ method: "POST", url: `/api/sessions/${session.id}/leave` });
    expect(res.statusCode).toBe(200);
  });

  it("allows a write to a conversation nobody holds, and does not take a lease for it", async () => {
    // A write on a free conversation is allowed — there is nobody to conflict with — and it
    // deliberately leaves no lease behind. Claiming one would mean any API client that wrote to a
    // conversation seized it and left the reader's own tab read-only for two minutes, having never
    // asked for a lease and having no lifecycle to give it back.
    expect((await locks(asSecond())).json<{ locks: SessionLockView[] }>().locks).toEqual([]);

    llm.setTurns([{ content: "the answer" }]);
    const res = await asSecond()({
      method: "POST",
      url: `/api/sessions/${session.id}/chat`,
      payload: { message: "hello" },
    });

    expect(res.statusCode).toBe(200);
    expect((await locks(asSecond())).json<{ locks: SessionLockView[] }>().locks).toEqual([]);
  });

  it("renews the holder's lease on a write, so an active client cannot lapse", async () => {
    await lock(session.id);
    // Wind the expiry back to something a fresh acquire would never produce, so "did the write
    // renew it" is a difference this can see rather than a few milliseconds of clock.
    const stale = new Date(Date.now() + 5_000).toISOString();
    env.server.db.raw
      .prepare("UPDATE session_locks SET expires_at = ? WHERE session_id = ?")
      .run(stale, session.id);

    llm.setTurns([{ content: "the answer" }]);
    await asFirst()({
      method: "POST",
      url: `/api/sessions/${session.id}/chat`,
      payload: { message: "hello" },
    });

    expect(storedExpiry(session.id) > stale).toBe(true);
    expect(new Date(storedExpiry(session.id)).getTime()).toBeGreaterThan(
      Date.now() + (SESSION_LOCK_TTL_SECONDS - 10) * 1000
    );
  });

  it("answers 404 for a conversation id that does not exist", async () => {
    // The gate must not become a second, differently-shaped answer about existence: a bad id in a
    // URL would otherwise come back "somebody is editing this" for a conversation nobody can edit.
    const res = await asFirst()({
      method: "POST",
      url: "/api/sessions/does-not-exist/chat",
      payload: { message: "hello" },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("SESSION_NOT_FOUND");
  });
});
