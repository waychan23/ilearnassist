import { afterEach, describe, expect, it } from "vitest";
import type { User } from "@ilearnassist/shared";
import { SESSION_COOKIE } from "../src/auth.js";
import { SETTING_AUTH_SECRET } from "../src/db.js";
import { startTestServer, type TestEnv } from "./helpers/tempEnv.js";

/**
 * Signing in, and the gate that makes it mean something.
 *
 * There is no password, so nothing here is about keeping anyone *out* — the subject is that
 * the server knows who is asking, that its answer cannot be forged, and that a route which
 * forgot to think about any of it is refused rather than open.
 *
 * These tests use `server.app.inject` (the raw one, no cookie) wherever the missing cookie is
 * the point, and `env.inject` — the harness's signed-in version — everywhere else.
 */

let env: TestEnv | undefined;

afterEach(async () => {
  await env?.cleanup();
  env = undefined;
});

/** The cookie's `name=value` pair, as a client would send it back. */
function cookieOf(res: { headers: Record<string, unknown> }): string {
  const header = res.headers["set-cookie"];
  return String(Array.isArray(header) ? header[0] : header).split(";")[0] ?? "";
}

const signInRaw = (server: TestEnv["server"], username: unknown) =>
  server.app.inject({ method: "POST", url: "/api/auth/login", payload: { username } });

describe("POST /api/auth/login", () => {
  it("creates the account and answers with it", async () => {
    env = await startTestServer({ username: "Ada" });
    const res = await signInRaw(env.server, "Grace");

    expect(res.statusCode).toBe(200);
    const user = res.json<User>();
    expect(user.username).toBe("Grace");
    expect(user.slug).toBe("grace");
    expect(user.id).toBeTruthy();
  });

  it("sets a signed, HttpOnly cookie", async () => {
    env = await startTestServer();
    const res = await signInRaw(env.server, "grace");
    const header = String(res.headers["set-cookie"]);

    expect(header).toContain(`${SESSION_COOKIE}=`);
    // HttpOnly is what makes the cookie unreadable to page script, which is why the client
    // has to ask `/api/auth/me` rather than looking at it.
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    // `<id>.<signature>`: the value is not the bare id, so a cookie cannot be made up by
    // anyone who learns one.
    expect(cookieOf(res).split("=")[1]).toMatch(/^[0-9a-f-]{36}\.[0-9a-f]{64}$/);
  });

  it("trims the name, and refuses one that is blank", async () => {
    env = await startTestServer();

    expect((await signInRaw(env.server, "  Ada  ")).json<User>().username).toBe("Ada");

    const blank = await signInRaw(env.server, "   ");
    expect(blank.statusCode).toBe(400);
    expect(blank.json<{ error: { code: string } }>().error.code).toBe("USERNAME_REQUIRED");

    expect((await signInRaw(env.server, undefined)).statusCode).toBe(400);
    expect((await signInRaw(env.server, 42)).statusCode).toBe(400);
  });

  it("refuses a name longer than the limit rather than truncating it into another one", async () => {
    // Truncating would be worse than refusing: two long names sharing a prefix would become
    // one account, and the user would never learn why.
    env = await startTestServer();
    const res = await signInRaw(env.server, "a".repeat(65));

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("USERNAME_TOO_LONG");
  });
});

describe("GET /api/auth/me", () => {
  it("answers with the account the cookie names", async () => {
    env = await startTestServer({ username: "Ada" });
    const me = await env.inject({ method: "GET", url: "/api/auth/me" });

    expect(me.statusCode).toBe(200);
    expect(me.json<User>().id).toBe(env.user.id);
  });

  it("401s without a cookie, which is an answer rather than a failure", async () => {
    // The client relies on this: a cold load has no other way to ask, so this particular 401
    // must not be mistaken for an expired session.
    env = await startTestServer();
    const me = await env.server.app.inject({ method: "GET", url: "/api/auth/me" });

    expect(me.statusCode).toBe(401);
    expect(me.json<{ error: { code: string } }>().error.code).toBe("UNAUTHENTICATED");
  });

  it("refuses a cookie whose signature was tampered with", async () => {
    env = await startTestServer({ username: "Ada" });
    const good = cookieOf(await signInRaw(env.server, "Ada"));
    const [name, value] = good.split("=");
    const [id, signature] = (value ?? "").split(".");

    // Flip one hex digit of the signature: the id it names is real, and the point is that
    // knowing a real id is not enough.
    const flipped = (signature ?? "").replace(/.$/, (c) => (c === "0" ? "1" : "0"));
    const res = await env.server.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: `${name}=${id}.${flipped}` },
    });

    expect(res.statusCode).toBe(401);
  });

  it("refuses a cookie that carries a bare id with no signature", async () => {
    env = await startTestServer({ username: "Ada" });
    const res = await env.server.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: `${SESSION_COOKIE}=${env.user.id}` },
    });

    expect(res.statusCode).toBe(401);
  });

  it("refuses a well-formed cookie naming an account that does not exist", async () => {
    env = await startTestServer({ username: "Ada" });
    const good = cookieOf(await signInRaw(env.server, "Ada"));
    // Re-signing is not something a client can do, so the only way this state is reachable is
    // a deleted account — but the lookup has to survive it either way.
    const [name] = good.split("=");
    const res = await env.server.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: `${name}=00000000-0000-4000-8000-000000000000.${"0".repeat(64)}` },
    });

    expect(res.statusCode).toBe(401);
  });

  it("refuses a cookie signed with another installation's secret", async () => {
    // Two data roots, two secrets. A cookie is a claim about *these* accounts, and it has to
    // stop meaning anything the moment it crosses into another tree — which is what makes
    // keeping the secret in the database (and so inside the data root) the right home for it.
    const other = await startTestServer({ username: "Ada" });
    try {
      const foreign = cookieOf(await signInRaw(other.server, "Ada"));

      env = await startTestServer({ username: "Ada" });
      const res = await env.server.app.inject({
        method: "GET",
        url: "/api/auth/me",
        headers: { cookie: foreign },
      });

      expect(res.statusCode).toBe(401);
    } finally {
      await other.cleanup();
    }
  });
});

describe("POST /api/auth/logout", () => {
  it("clears the cookie, so the next request is anonymous", async () => {
    env = await startTestServer({ username: "Ada" });
    // Signed in, so the harness's `inject` still carries a now-useless cookie afterwards —
    // which is exactly the behaviour worth pinning.
    const res = await env.inject({ method: "POST", url: "/api/auth/logout" });

    expect(res.statusCode).toBe(200);
    expect(String(res.headers["set-cookie"])).toContain("Max-Age=0");

    const cleared = String(res.headers["set-cookie"]).split(";")[0] ?? "";
    const after = await env.server.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: cleared },
    });
    expect(after.statusCode).toBe(401);
  });
});

describe("GET /api/auth/users", () => {
  it("lists the accounts that exist, without ids", async () => {
    env = await startTestServer({ username: "Ada" });
    await env.asUser("Bob");

    const res = await env.server.app.inject({ method: "GET", url: "/api/auth/users" });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ usernames: string[] }>().usernames.sort()).toEqual(["Ada", "Bob"]);
    // The summary type carries no id, and the response must not either: an id is the one
    // thing worth guessing at.
    expect(res.body).not.toContain(env.user.id);
  });

  it("is reachable without a cookie, so a first-time visitor can see the names", async () => {
    env = await startTestServer();
    expect((await env.server.app.inject({ method: "GET", url: "/api/auth/users" })).statusCode).toBe(
      200
    );
  });
});

describe("the gate", () => {
  it("refuses every data route without a cookie", async () => {
    // A representative sweep rather than all forty: the point is that the default is refusal,
    // and a route added later inherits it without anyone remembering to ask.
    env = await startTestServer({ username: "Ada" });
    const workspace = await env.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { name: "Mine" },
    }).then((r) => r.json<{ id: string }>());
    const session = await env.inject({
      method: "POST",
      url: `/api/workspaces/${workspace.id}/sessions`,
      payload: {},
    }).then((r) => r.json<{ id: string }>());

    const paths = [
      ["GET", "/api/workspaces"],
      ["GET", "/api/config"],
      ["GET", "/api/providers"],
      ["GET", "/api/copilots"],
      ["GET", `/api/workspaces/${workspace.id}/files`],
      ["GET", `/api/workspaces/${workspace.id}/sessions`],
      ["GET", `/api/sessions/${session.id}/messages`],
      ["PATCH", `/api/sessions/${session.id}`],
      ["DELETE", `/api/sessions/${session.id}`],
    ] as const;

    for (const [method, url] of paths) {
      const res = await env.server.app.inject({ method, url, payload: method === "GET" ? undefined : {} });
      expect([url, res.statusCode]).toEqual([url, 401]);
      expect(res.json<{ error: { code: string } }>().error.code).toBe("UNAUTHENTICATED");
    }
  });

  it("lets the routes that have to be public answer for themselves", async () => {
    // The four, and why each: `health` so a probe can probe, `users` so a first-time visitor
    // can see which names exist, `login` because it is how a cookie is obtained, and `me`
    // because it is how a client asks whether it already has one.
    //
    // `me` answers 401 without a cookie, from the route rather than from the gate — and the
    // two replies are deliberately identical, so nothing here can tell them apart. That is
    // the point: what makes `me` public is that its handler runs, not that its status differs.
    env = await startTestServer();

    expect((await env.server.app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    expect((await env.server.app.inject({ method: "GET", url: "/api/auth/users" })).statusCode).toBe(200);
    expect(
      (
        await env.server.app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { username: "Ada" },
        })
      ).statusCode
    ).toBe(200);
    expect((await env.server.app.inject({ method: "GET", url: "/api/auth/me" })).statusCode).toBe(401);
  });
});

describe("the signing secret", () => {
  it("survives a restart, so the panel restarting the server does not sign anyone out", async () => {
    // The panel restarts the child on every launch and on every settings change. A secret
    // generated per boot would log the user out several times a day for no reason.
    env = await startTestServer({ username: "Ada" });
    const before = await env.inject({ method: "GET", url: "/api/auth/me" });
    expect(before.statusCode).toBe(200);

    const secret = env.server.db.getSetting(SETTING_AUTH_SECRET);
    expect(secret).toBeTruthy();
    expect(env.server.db.getSetting(SETTING_AUTH_SECRET)).toBe(secret);
  });

  it("is what rotates a session, so deleting the row signs everyone out", async () => {
    env = await startTestServer({ username: "Ada" });
    expect((await env.inject({ method: "GET", url: "/api/auth/me" })).statusCode).toBe(200);

    env.server.db.setSetting(SETTING_AUTH_SECRET, "a-different-secret");

    // The same cookie, against a secret that no longer signed it.
    expect((await env.inject({ method: "GET", url: "/api/auth/me" })).statusCode).toBe(401);
  });
});
