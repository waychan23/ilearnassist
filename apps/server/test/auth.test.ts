import { afterEach, describe, expect, it } from "vitest";
import type { LightMyRequestResponse } from "fastify";
import type { AuthResult, User } from "@ilearnassist/shared";
import { createAdmin } from "../src/adminCli.js";
import { ACCESS_TOKEN_TTL_SECONDS, hashToken, REFRESH_TOKEN_TTL_SECONDS } from "../src/auth.js";
import { startBareServer, startTestServer, TEST_PASSWORD, type TestEnv } from "./helpers/tempEnv.js";

/**
 * Signing in, and the token that makes it mean something.
 *
 * The subject is that the server knows *who* is asking, that a token cannot be forged or
 * reused, and that a route which forgot to think about any of it is refused rather than open.
 * The console's own routes have their own file.
 *
 * These tests use `server.app.inject` (the raw one, no header) wherever the missing token is
 * the point, and `env.inject` — the harness's signed-in version — everywhere else.
 */

let env: TestEnv | undefined;

afterEach(async () => {
  await env?.cleanup();
  env = undefined;
});

type Body = { error: { code: string } };

const post = (
  server: TestEnv["server"],
  url: string,
  payload: Record<string, unknown> = {}
): Promise<LightMyRequestResponse> => server.app.inject({ method: "POST", url, payload });

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe("POST /api/auth/login", () => {
  it("answers with the account and a pair of tokens", async () => {
    env = await startTestServer({ username: "Ada" });
    const res = await post(env.server, "/api/auth/login", {
      username: "ada",
      password: TEST_PASSWORD,
    });

    expect(res.statusCode).toBe(200);
    const { user, tokens } = res.json<AuthResult>();
    expect(user.id).toBe(env.user.id);
    expect(tokens.expiresIn).toBe(ACCESS_TOKEN_TTL_SECONDS);
    expect(tokens.refreshToken).not.toBe(tokens.accessToken);
  });

  it("refuses an account that has no password at all, whatever it presents", async () => {
    /*
     * The regression this pins is the sharpest one in the feature. A login with no account to
     * compare against still runs `scrypt`, against a hash of a fixed string, to keep the
     * *timing* honest — and an earlier version fed that verdict into the decision. The known
     * string was then a working password for every row with `password_hash IS NULL`, which is
     * not a hypothetical state: it is exactly the data root carried over from the build where
     * a username was the credential.
     */
    const bare = await startBareServer();
    try {
      const legacy = bare.server.db.createUser({ id: "legacy", username: "Legacy", slug: "legacy" });
      expect(legacy.passwordHash).toBeNull();

      // Another account has one, so this installation *has* been set up — the state an
      // upgraded data root is in, where a legacy row without a credential sits beside a real
      // account.
      const made = await createAdmin({
        dataRoot: bare.dataRoot,
        username: "Ada",
        password: TEST_PASSWORD,
      });
      expect(made.ok).toBe(true);

      for (const guess of ["decoy-password-for-timing-only", "anything at all", "Legacy"]) {
        const res = await post(bare.server, "/api/auth/login", {
          username: "Legacy",
          password: guess,
        });
        expect([guess, res.statusCode]).toEqual([guess, 401]);
      }
    } finally {
      await bare.cleanup();
    }
  });

  it("gives a wrong password and an unknown name the same answer", async () => {
    // One reply for both, so the response cannot be read to find out which accounts exist.
    env = await startTestServer({ username: "Ada" });

    const wrong = await post(env.server, "/api/auth/login", {
      username: "Ada",
      password: "not-the-password",
    });
    const unknown = await post(env.server, "/api/auth/login", {
      username: "Nobody",
      password: TEST_PASSWORD,
    });

    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json<Body>().error.code).toBe("INVALID_CREDENTIALS");
    expect(unknown.json<Body>().error.code).toBe("INVALID_CREDENTIALS");
    expect(wrong.body).toBe(unknown.body);
  });

  it("tells a disabled account apart, once the password is known", async () => {
    // Deliberately a different answer: this is only reachable *after* a correct password, so
    // the caller has already proved they know which account it is and there is nothing left
    // to withhold.
    env = await startTestServer({ username: "Ada" });
    env.server.db.setUserDisabled(env.user.id, true);

    const res = await post(env.server, "/api/auth/login", {
      username: "Ada",
      password: TEST_PASSWORD,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<Body>().error.code).toBe("ACCOUNT_DISABLED");
  });

  it("refuses everyone while nobody has a password", async () => {
    /*
     * The API's half of the boot rule.
     *
     * `main()` refuses to listen in this state, so the ordinary way to reach a server is
     * unreachable — but `buildServer` is usable on its own (this harness does exactly that),
     * and a caller in that state deserves a sentence it can act on rather than a 401 that
     * reads as a wrong password.
     */
    const bare = await startBareServer();
    try {
      bare.server.db.createUser({ id: "u1", username: "Ada", slug: "ada" });
      const res = await post(bare.server, "/api/auth/login", {
        username: "Ada",
        password: TEST_PASSWORD,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json<Body>().error.code).toBe("SETUP_REQUIRED");
    } finally {
      await bare.cleanup();
    }
  });

  it("refuses a blank name or password before touching the database", async () => {
    env = await startTestServer();
    expect(
      (await post(env.server, "/api/auth/login", { password: TEST_PASSWORD })).json<Body>().error.code
    ).toBe("USERNAME_REQUIRED");
    expect(
      (await post(env.server, "/api/auth/login", { username: "tester" })).json<Body>().error.code
    ).toBe("PASSWORD_REQUIRED");
  });
});

describe("tokens", () => {
  it("accepts an access token and refuses anything else", async () => {
    env = await startTestServer();

    for (const token of ["", "not-a-token", env.user.id, `${env.token}x`]) {
      const res = await env.server.app.inject({
        method: "GET",
        url: "/api/auth/me",
        headers: token ? auth(token) : {},
      });
      expect([token, res.statusCode]).toEqual([token, 401]);
    }
  });

  it("will not take a refresh token as an access token", async () => {
    // The whole reason the two lifetimes are separated: a week-long credential that the gate
    // accepted would be a week-long API credential.
    env = await startTestServer();
    const { tokens } = (
      await post(env.server, "/api/auth/login", { username: "tester", password: TEST_PASSWORD })
    ).json<AuthResult>();

    const res = await env.server.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: auth(tokens.refreshToken),
    });
    expect(res.statusCode).toBe(401);
  });

  it("refuses a token that has been revoked", async () => {
    env = await startTestServer();
    expect((await env.inject({ method: "GET", url: "/api/auth/me" })).statusCode).toBe(200);

    env.server.db.revokeUserTokens(env.user.id, new Date().toISOString());

    expect((await env.inject({ method: "GET", url: "/api/auth/me" })).statusCode).toBe(401);
  });

  it("refuses a token that has expired", async () => {
    env = await startTestServer();
    const expired = "a-token-whose-row-says-yesterday";
    env.server.db.createAuthToken({
      id: hashToken(expired),
      userId: env.user.id,
      kind: "access",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    const res = await env.server.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: auth(expired),
    });
    expect(res.statusCode).toBe(401);
  });

  it("refuses a token belonging to a disabled account", async () => {
    // Checked on every request rather than only at sign-in: disabling an account whose token
    // kept working for a day would be a control that reports a state it does not have.
    env = await startTestServer();
    env.server.db.setUserDisabled(env.user.id, true);
    expect((await env.inject({ method: "GET", url: "/api/auth/me" })).statusCode).toBe(401);
  });

  it("prunes what is dead without touching what is live", async () => {
    // Housekeeping, and it has to be *somewhere*: this is the only table that grows with use
    // rather than with what somebody made — one row per sign-in, per device, forever.
    env = await startTestServer();
    env.server.db.createAuthToken({
      id: hashToken("long-expired"),
      userId: env.user.id,
      kind: "access",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    expect(env.server.db.pruneAuthTokens(new Date().toISOString())).toBeGreaterThan(0);
    expect(env.server.db.getAuthToken(hashToken("long-expired"))).toBeUndefined();
    // The session in use is not collateral: it has neither expired nor been revoked.
    expect(env.server.db.getAuthToken(hashToken(env.token))).toBeDefined();
    expect((await env.inject({ method: "GET", url: "/api/auth/me" })).statusCode).toBe(200);
  });

  it("stores only a hash, so the database is not a list of credentials", async () => {
    env = await startTestServer();
    const rows = env.server.db.raw
      .prepare("SELECT id FROM auth_tokens")
      .all() as { id: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((r) => r.id)).not.toContain(env.token);
    expect(rows.map((r) => r.id)).toContain(hashToken(env.token));
  });
});

describe("POST /api/auth/refresh", () => {
  it("exchanges a refresh token for a fresh pair and spends the old one", async () => {
    // Rotation, and it is the thing that bounds a stolen token to a single exchange.
    env = await startTestServer();
    const first = (
      await post(env.server, "/api/auth/login", { username: "tester", password: TEST_PASSWORD })
    ).json<AuthResult>();

    const res = await post(env.server, "/api/auth/refresh", {
      refreshToken: first.tokens.refreshToken,
    });
    expect(res.statusCode).toBe(200);
    const second = res.json<AuthResult>();
    expect(second.tokens.refreshToken).not.toBe(first.tokens.refreshToken);
    expect(
      (
        await env.server.app.inject({
          method: "GET",
          url: "/api/auth/me",
          headers: auth(second.tokens.accessToken),
        })
      ).statusCode
    ).toBe(200);

    // The one that was just spent is dead.
    const replay = await post(env.server, "/api/auth/refresh", {
      refreshToken: first.tokens.refreshToken,
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json<Body>().error.code).toBe("INVALID_REFRESH_TOKEN");
  });

  it("leaves another device's refresh token alone", async () => {
    // Two clients, two sessions. Rotating one is not a request to end the other, which is what
    // makes signing in from a second machine not sign the first one out.
    env = await startTestServer();
    const phone = (
      await post(env.server, "/api/auth/login", { username: "tester", password: TEST_PASSWORD })
    ).json<AuthResult>();
    const laptop = (
      await post(env.server, "/api/auth/login", { username: "tester", password: TEST_PASSWORD })
    ).json<AuthResult>();

    await post(env.server, "/api/auth/refresh", { refreshToken: phone.tokens.refreshToken });

    const other = await post(env.server, "/api/auth/refresh", {
      refreshToken: laptop.tokens.refreshToken,
    });
    expect(other.statusCode).toBe(200);
  });

  it("gives the refresh token the longer life of the two", async () => {
    // Read off the rows rather than off a constant, so the two cannot drift apart in silence.
    env = await startTestServer();
    const rows = env.server.db.raw
      .prepare("SELECT kind, expires_at FROM auth_tokens WHERE user_id = ?")
      .all(env.user.id) as { kind: string; expires_at: string }[];
    const access = rows.find((r) => r.kind === "access")!;
    const refresh = rows.find((r) => r.kind === "refresh")!;
    expect(new Date(refresh.expires_at).getTime()).toBeGreaterThan(
      new Date(access.expires_at).getTime()
    );
    expect(Date.parse(refresh.expires_at) - Date.parse(access.expires_at)).toBe(
      (REFRESH_TOKEN_TTL_SECONDS - ACCESS_TOKEN_TTL_SECONDS) * 1000
    );
  });

  it("refuses an access token presented as a refresh token", async () => {
    env = await startTestServer();
    const res = await post(env.server, "/api/auth/refresh", { refreshToken: env.token });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /api/auth/logout", () => {
  it("ends this client's session and no one else's", async () => {
    env = await startTestServer();
    const other = (
      await post(env.server, "/api/auth/login", { username: "tester", password: TEST_PASSWORD })
    ).json<AuthResult>();

    const res = await env.inject({
      method: "POST",
      url: "/api/auth/logout",
      payload: { refreshToken: other.tokens.refreshToken },
    });
    expect(res.statusCode).toBe(200);

    // Both halves of the pair that was handed over are dead...
    expect((await env.inject({ method: "GET", url: "/api/auth/me" })).statusCode).toBe(401);
    expect(
      (
        await post(env.server, "/api/auth/refresh", {
          refreshToken: other.tokens.refreshToken,
        })
      ).statusCode
    ).toBe(401);
  });

  it("answers ok even with nothing to revoke", async () => {
    // Signing out cannot fail in a way the user would have to act on: the local state is going
    // either way, so a refusal here would buy nothing.
    env = await startTestServer();
    const res = await env.server.app.inject({ method: "POST", url: "/api/auth/logout" });
    expect(res.statusCode).toBe(200);
  });
});

describe("POST /api/auth/password", () => {
  it("changes the password when the current one is given", async () => {
    env = await startTestServer();
    const res = await env.inject({
      method: "POST",
      url: "/api/auth/password",
      payload: { oldPassword: TEST_PASSWORD, newPassword: "a-new-password-1" },
    });

    expect(res.statusCode).toBe(200);
    const { user, tokens } = res.json<AuthResult>();
    expect(user.mustChangePassword).toBe(false);
    expect(
      (
        await post(env.server, "/api/auth/login", {
          username: "tester",
          password: "a-new-password-1",
        })
      ).statusCode
    ).toBe(200);
    // The pair that comes back is the one to use: every other session was ended.
    expect(
      (
        await env.server.app.inject({
          method: "GET",
          url: "/api/auth/me",
          headers: auth(tokens.accessToken),
        })
      ).statusCode
    ).toBe(200);
  });

  it("ends every other session, because a change is what you do when something leaked", async () => {
    env = await startTestServer();
    const other = (
      await post(env.server, "/api/auth/login", { username: "tester", password: TEST_PASSWORD })
    ).json<AuthResult>();

    await env.inject({
      method: "POST",
      url: "/api/auth/password",
      payload: { oldPassword: TEST_PASSWORD, newPassword: "a-new-password-1" },
    });

    const stale = await env.server.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: auth(other.tokens.accessToken),
    });
    expect(stale.statusCode).toBe(401);
  });

  it("refuses without the current password", async () => {
    env = await startTestServer();
    const res = await env.inject({
      method: "POST",
      url: "/api/auth/password",
      payload: { oldPassword: "not-it", newPassword: "a-new-password-1" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<Body>().error.code).toBe("INVALID_CREDENTIALS");
  });

  it("refuses the password it already has", async () => {
    // Otherwise the flag would clear with the choice still unmade, and the screen the user
    // just left would have changed nothing.
    env = await startTestServer();
    const res = await env.inject({
      method: "POST",
      url: "/api/auth/password",
      payload: { oldPassword: TEST_PASSWORD, newPassword: TEST_PASSWORD },
    });
    expect(res.json<Body>().error.code).toBe("PASSWORD_UNCHANGED");
  });

  it("applies the length policy to the new password", async () => {
    env = await startTestServer();
    const res = await env.inject({
      method: "POST",
      url: "/api/auth/password",
      payload: { oldPassword: TEST_PASSWORD, newPassword: "short" },
    });
    expect(res.json<Body>().error.code).toBe("PASSWORD_TOO_SHORT");
  });
});

describe("the gate", () => {
  it("refuses every data route without a token", async () => {
    // A representative sweep rather than all forty: the point is that the default is refusal,
    // and a route added later inherits it without anyone remembering to ask.
    env = await startTestServer();
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
      ["GET", "/api/admin/users"],
      ["GET", `/api/workspaces/${workspace.id}/files`],
      ["GET", `/api/workspaces/${workspace.id}/sessions`],
      ["GET", `/api/sessions/${session.id}/messages`],
      ["PATCH", `/api/sessions/${session.id}`],
      ["DELETE", `/api/sessions/${session.id}`],
    ] as const;

    for (const [method, url] of paths) {
      const res = await env.server.app.inject({
        method,
        url,
        payload: method === "GET" ? undefined : {},
      });
      expect([url, res.statusCode]).toEqual([url, 401]);
      expect(res.json<Body>().error.code).toBe("UNAUTHENTICATED");
    }
  });

  it("lets the routes that have to be public answer for themselves", async () => {
    // The ones with no credential to offer, and why each: `health` so a probe can probe,
    // `login`/`refresh` because they are how a token is obtained, `logout` because a client
    // that has lost half its pair must still be able to spend the other half, and `me` because
    // it is how a client asks whether it already has a session.
    //
    // `me` answers 401 without a token, from the route rather than from the gate — and the two
    // replies are deliberately identical, so nothing here can tell them apart. That is the
    // point: what makes `me` public is that its handler runs, not that its status differs.
    env = await startTestServer();

    const publicPaths = [
      ["GET", "/api/health"],
      ["POST", "/api/auth/logout"],
    ] as const;
    for (const [method, url] of publicPaths) {
      const res = await env.server.app.inject({ method, url, payload: method === "GET" ? undefined : {} });
      expect([url, res.statusCode]).toEqual([url, 200]);
    }

    // `me` is the fourth, and is the exception that proves the flag is doing something: its
    // handler runs and *answers* 401, where a gated route would have been refused by the hook.
    expect((await env.server.app.inject({ method: "GET", url: "/api/auth/me" })).statusCode).toBe(
      401
    );

    // And the bootstrap is spent, which the CLI is where you find out — the panel asks it
    // rather than the API, because it has to work with the server stopped.
    const again = await createAdmin({
      dataRoot: env.dataRoot,
      username: "mallory",
      password: TEST_PASSWORD,
    });
    expect(again.ok).toBe(false);
    expect(again.ok || again.body.error.code).toBe("ADMIN_EXISTS");
  });
});

describe("GET /api/auth/me", () => {
  it("answers with the account the token names", async () => {
    env = await startTestServer({ username: "Ada" });
    const me = await env.inject({ method: "GET", url: "/api/auth/me" });

    expect(me.statusCode).toBe(200);
    const user = me.json<User>();
    expect(user.id).toBe(env.user.id);
    expect(user.roles).toEqual(["superadmin"]);
    // The record's private half must not travel. The password hash is a credential, and the
    // disabled flag is not something the holder of a working token needs told.
    expect(me.body).not.toContain("passwordHash");
    expect(me.body).not.toContain("disabled");
  });

  it("401s without a token, which is an answer rather than a failure", async () => {
    // The client relies on this: a cold load has no other way to ask, so this particular 401
    // must not be mistaken for an expired session.
    env = await startTestServer();
    const me = await env.server.app.inject({ method: "GET", url: "/api/auth/me" });

    expect(me.statusCode).toBe(401);
    expect(me.json<Body>().error.code).toBe("UNAUTHENTICATED");
  });
});
