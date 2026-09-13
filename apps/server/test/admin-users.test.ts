import { afterEach, describe, expect, it } from "vitest";
import type { LightMyRequestResponse } from "fastify";
import type {
  AdminUser,
  AuthResult,
  UserCredentials,
  UserRole,
} from "@ilearnassist/shared";
import { PANEL_TOKEN_ENV, PANEL_TOKEN_HEADER } from "../src/auth.js";
import { startTestServer, TEST_PASSWORD, type TestEnv } from "./helpers/tempEnv.js";

/**
 * The platform console: making accounts, taking them away, and the two ways back in.
 *
 * Every route here is a superadmin's, so most of these tests are as much about who is *refused*
 * as about what the route does. The forced password change has its own describe, because it is
 * the one rule that reaches into every other route in the product.
 */

let env: TestEnv | undefined;

afterEach(async () => {
  await env?.cleanup();
  env = undefined;
  delete process.env[PANEL_TOKEN_ENV];
});

type Body = { error: { code: string } };

const post = (
  server: TestEnv["server"],
  url: string,
  payload: Record<string, unknown> = {}
): Promise<LightMyRequestResponse> => server.app.inject({ method: "POST", url, payload });

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

interface TestAccount {
  user: AdminUser;
  /** The password it currently has — which after settling is `TEST_PASSWORD`. */
  password: string;
  token: string;
  inject: TestEnv["inject"];
}

/** An `inject` that carries one token, for tests that drive a second account by hand. */
function injectWith(env: TestEnv, token: string): TestEnv["inject"] {
  return (opts) => env.server.app.inject({ ...opts, headers: { ...opts.headers, ...bearer(token) } });
}

/** Create an account through the console. Leaves it owing a password change. */
async function createAccount(
  env: TestEnv,
  username: string
): Promise<{ user: AdminUser; password: string }> {
  const created = await env.inject({
    method: "POST",
    url: "/api/admin/users",
    payload: { username },
  });
  expect(created.statusCode).toBe(200);
  return created.json<UserCredentials>();
}

/** Sign in with a password and keep the token. */
async function signIn(
  env: TestEnv,
  username: string,
  password: string
): Promise<{ token: string; refreshToken: string; inject: TestEnv["inject"] }> {
  const res = await post(env.server, "/api/auth/login", { username, password });
  expect(res.statusCode).toBe(200);
  const { tokens } = res.json<AuthResult>();
  return {
    token: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    inject: injectWith(env, tokens.accessToken),
  };
}

/**
 * Create an account and bring it to the state it spends the rest of its life in.
 *
 * Two steps rather than one, because an account an administrator makes is *not* usable when
 * the reply arrives: it was handed a password to read off a screen, and the first thing it
 * does is replace it. Only the forced-change tests want the state in between, and they build
 * it themselves out of the two pieces above — so everything else here is about an account
 * that is already through it.
 */
async function createAndSignIn(env: TestEnv, username: string): Promise<TestAccount> {
  const { user, password: issued } = await createAccount(env, username);
  const first = await signIn(env, username, issued);

  const settled = await first.inject({
    method: "POST",
    url: "/api/auth/password",
    payload: { oldPassword: issued, newPassword: TEST_PASSWORD },
  });
  expect(settled.statusCode).toBe(200);
  const { tokens } = settled.json<AuthResult>();

  // Re-read rather than reuse the reply: this is the *console's* view of the account, and the
  // one the password route hands back is the account's own. Same person, different shape —
  // and taking the wrong one would leave `mustChangePassword` reading true after it was spent.
  const listed = await env.inject({ method: "GET", url: "/api/admin/users" });
  const settledUser = listed.json<{ users: AdminUser[] }>().users.find((u) => u.id === user.id)!;

  return {
    user: settledUser,
    password: TEST_PASSWORD,
    token: tokens.accessToken,
    inject: injectWith(env, tokens.accessToken),
  };
}

describe("GET /api/admin/users", () => {
  it("lists every account with what it may do", async () => {
    env = await startTestServer({ username: "Ada" });
    await createAndSignIn(env, "Bob");

    const res = await env.inject({ method: "GET", url: "/api/admin/users" });
    expect(res.statusCode).toBe(200);
    const { users } = res.json<{ users: AdminUser[] }>();
    expect(users.map((u) => u.username).sort()).toEqual(["Ada", "Bob"]);
    expect(users.find((u) => u.username === "Ada")!.roles).toEqual(["superadmin"]);
    expect(users.find((u) => u.username === "Bob")!.roles).toEqual(["user"]);
  });

  it("refuses an ordinary account", async () => {
    env = await startTestServer();
    const bob = await createAndSignIn(env, "Bob");

    const res = await bob.inject({ method: "GET", url: "/api/admin/users" });
    expect(res.statusCode).toBe(403);
    expect(res.json<Body>().error.code).toBe("FORBIDDEN");
  });
});

describe("POST /api/admin/users", () => {
  it("creates an account with a generated password it will never show again", async () => {
    env = await startTestServer();
    const res = await env.inject({
      method: "POST",
      url: "/api/admin/users",
      payload: { username: "Bob" },
    });

    expect(res.statusCode).toBe(200);
    const { user, password } = res.json<UserCredentials>();
    expect(user.username).toBe("Bob");
    expect(user.roles).toEqual(["user"]);
    // Set on creation, because what the administrator hands over is a way in rather than a
    // password the account keeps.
    expect(user.mustChangePassword).toBe(true);
    expect(password.length).toBeGreaterThanOrEqual(12);

    // Nothing anywhere can read it back. Only a hash is stored, which is why the console pairs
    // this reply with a copy button rather than a "show password" one.
    const listed = await env.inject({ method: "GET", url: "/api/admin/users" });
    expect(listed.body).not.toContain(password);
    expect(
      env.server.db.raw.prepare("SELECT password_hash FROM users WHERE id = ?").get(user.id)
    ).not.toMatchObject({ password_hash: password });
  });

  it("makes an administrator when asked", async () => {
    env = await startTestServer();
    const res = await env.inject({
      method: "POST",
      url: "/api/admin/users",
      payload: { username: "Bob", roles: ["superadmin"] },
    });
    expect(res.json<UserCredentials>().user.roles).toEqual(["superadmin"]);
  });

  it("refuses a role this build does not know rather than dropping it", async () => {
    // A dropped role is a selection that looks like it worked: the box was ticked, the request
    // succeeded, and the account does not have it.
    env = await startTestServer();
    const res = await env.inject({
      method: "POST",
      url: "/api/admin/users",
      payload: { username: "Bob", roles: ["root"] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<Body>().error.code).toBe("INVALID_FIELD");
  });

  it("refuses a name that is taken, in either case", async () => {
    env = await startTestServer({ username: "Ada" });
    const res = await env.inject({
      method: "POST",
      url: "/api/admin/users",
      payload: { username: "ada" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<Body>().error.code).toBe("USERNAME_TAKEN");
  });

  it("refuses an empty or overlong name", async () => {
    env = await startTestServer();
    expect(
      (await env.inject({ method: "POST", url: "/api/admin/users", payload: {} })).json<Body>()
        .error.code
    ).toBe("USERNAME_REQUIRED");
    expect(
      (
        await env.inject({
          method: "POST",
          url: "/api/admin/users",
          payload: { username: "a".repeat(65) },
        })
      ).json<Body>().error.code
    ).toBe("USERNAME_TOO_LONG");
  });
});

describe("PATCH /api/admin/users/:id", () => {
  it("disables an account, and the account cannot sign in afterwards", async () => {
    env = await startTestServer();
    const bob = await createAndSignIn(env, "Bob");

    const res = await env.inject({
      method: "PATCH",
      url: `/api/admin/users/${bob.user.id}`,
      payload: { disabled: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<AdminUser>().disabled).toBe(true);

    // The live token stops working too — otherwise "disabled" would be a label on a control
    // that still does everything.
    expect((await bob.inject({ method: "GET", url: "/api/auth/me" })).statusCode).toBe(401);
    expect(
      (await post(env.server, "/api/auth/login", { username: "Bob", password: bob.password }))
        .statusCode
    ).toBe(403);
  });

  it("re-enables an account", async () => {
    env = await startTestServer();
    const bob = await createAndSignIn(env, "Bob");
    await env.inject({
      method: "PATCH",
      url: `/api/admin/users/${bob.user.id}`,
      payload: { disabled: true },
    });

    const res = await env.inject({
      method: "PATCH",
      url: `/api/admin/users/${bob.user.id}`,
      payload: { disabled: false },
    });
    expect(res.json<AdminUser>().disabled).toBe(false);
  });

  it("changes what an account may do", async () => {
    env = await startTestServer();
    const bob = await createAndSignIn(env, "Bob");

    const res = await env.inject({
      method: "PATCH",
      url: `/api/admin/users/${bob.user.id}`,
      payload: { roles: ["superadmin"] satisfies UserRole[] },
    });
    expect(res.json<AdminUser>().roles).toEqual(["superadmin"]);
    // The role is read per request rather than baked into the token, so it takes effect now.
    expect(
      (await bob.inject({ method: "GET", url: "/api/admin/users" })).statusCode
    ).toBe(200);
  });

  it("leaves fields the request does not mention alone", async () => {
    // A `PATCH` that omitted `roles` must not read as "no roles" — the two are separate checks
    // at the call site for exactly this reason.
    env = await startTestServer();
    const bob = await createAndSignIn(env, "Bob");
    await env.inject({
      method: "PATCH",
      url: `/api/admin/users/${bob.user.id}`,
      payload: { roles: ["superadmin"] },
    });

    const res = await env.inject({
      method: "PATCH",
      url: `/api/admin/users/${bob.user.id}`,
      payload: { disabled: true },
    });
    expect(res.json<AdminUser>().roles).toEqual(["superadmin"]);
  });

  it("refuses an unknown account and an unknown role", async () => {
    env = await startTestServer();
    expect(
      (await env.inject({ method: "PATCH", url: "/api/admin/users/nope", payload: {} })).json<
        Body
      >().error.code
    ).toBe("USER_NOT_FOUND");
    expect(
      (
        await env.inject({
          method: "PATCH",
          url: `/api/admin/users/${env.user.id}`,
          payload: { roles: ["nope"] },
        })
      ).json<Body>().error.code
    ).toBe("INVALID_FIELD");
  });

  it("refuses a `disabled` that is not a boolean rather than coercing it", async () => {
    /*
     * `"false"` is truthy, so coercing it stores 1 while `disabled === true` misses the
     * self-guard — an administrator disables their own account past the check that exists to
     * stop exactly that, and the panel's recovery then finds no enabled superadmin to reset.
     * The console sends real booleans, so anything else is a hand-written request.
     */
    env = await startTestServer();
    const res = await env.inject({
      method: "PATCH",
      url: `/api/admin/users/${env.user.id}`,
      payload: { disabled: "false" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<Body>().error.code).toBe("INVALID_FIELD");
    expect(env.server.db.getUser(env.user.id)!.disabled).toBe(false);
    // And still usable, which is what the coercion would have cost.
    expect((await env.inject({ method: "GET", url: "/api/auth/me" })).statusCode).toBe(200);
  });

  it("refuses to let an administrator disable or demote themselves", async () => {
    // The footgun this exists for: one click and the console has nobody who can reach it, with
    // no way back in from the app at all.
    env = await startTestServer();
    for (const payload of [{ disabled: true }, { roles: ["user"] }]) {
      const res = await env.inject({
        method: "PATCH",
        url: `/api/admin/users/${env.user.id}`,
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json<Body>().error.code).toBe("CANNOT_MODIFY_SELF");
    }
  });

  it("leaves at least one administrator, whichever way accounts are changed", async () => {
    // The invariant, and the reason there is no separate "you may not remove the last
    // administrator" rule to go with the self-guard: reaching this route at all means the
    // caller is an enabled superadmin, so one administrator always survives whoever is
    // changed. By induction the count cannot reach zero.
    env = await startTestServer({ username: "Ada" });
    const bob = await createAndSignIn(env, "Bob");
    await env.inject({
      method: "PATCH",
      url: `/api/admin/users/${bob.user.id}`,
      payload: { roles: ["superadmin"] },
    });

    // Bob may demote Ada — he is an administrator too, so the console stays reachable...
    const demoted = await bob.inject({
      method: "PATCH",
      url: `/api/admin/users/${env.user.id}`,
      payload: { roles: ["user"] },
    });
    expect(demoted.statusCode).toBe(200);

    // ...and that is exactly why he may not then demote himself.
    const self = await bob.inject({
      method: "PATCH",
      url: `/api/admin/users/${bob.user.id}`,
      payload: { roles: ["user"] },
    });
    expect(self.statusCode).toBe(400);
    expect(self.json<Body>().error.code).toBe("CANNOT_MODIFY_SELF");
    expect(
      env.server.db.listUsers().filter((u) => !u.disabled && u.roles.includes("superadmin"))
    ).toHaveLength(1);
  });

  it("allows a change that does not cost the account its own authority", async () => {
    // The guard is about *losing* the role, not about touching the row: re-enabling yourself,
    // or re-stating the roles you already hold, is an ordinary edit.
    env = await startTestServer();
    const res = await env.inject({
      method: "PATCH",
      url: `/api/admin/users/${env.user.id}`,
      payload: { disabled: false, roles: ["superadmin"] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<AdminUser>().roles).toEqual(["superadmin"]);
  });
});

describe("POST /api/admin/users/:id/password", () => {
  it("gives another account a new password and makes it change its own", async () => {
    env = await startTestServer();
    const bob = await createAndSignIn(env, "Bob");

    const res = await env.inject({
      method: "POST",
      url: `/api/admin/users/${bob.user.id}/password`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const { user, password, tokens } = res.json<UserCredentials>();
    // Set for somebody else's account: that password was read off a screen and sent through a
    // chat window, so it is a way in rather than one to keep.
    expect(user.mustChangePassword).toBe(true);
    expect(password).not.toBe(bob.password);
    // No replacement pair, because the caller's own session was not the one being reset.
    expect(tokens).toBeUndefined();
  });

  it("ends the target's sessions, which is half of what a reset is", async () => {
    env = await startTestServer();
    const bob = await createAndSignIn(env, "Bob");

    await env.inject({
      method: "POST",
      url: `/api/admin/users/${bob.user.id}/password`,
      payload: {},
    });

    expect((await bob.inject({ method: "GET", url: "/api/auth/me" })).statusCode).toBe(401);
  });

  it("does not make the administrator change the password they just set for themselves", async () => {
    // The asymmetry, and it is the whole reason the two paths are different routes: resetting
    // *your own* password is a choice you made a moment ago and are about to keep using, so a
    // screen demanding you replace it would be a step with nothing behind it.
    env = await startTestServer();
    const res = await env.inject({
      method: "POST",
      url: `/api/admin/users/${env.user.id}/password`,
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const { user, password, tokens } = res.json<UserCredentials>();
    expect(user.mustChangePassword).toBe(false);
    // The reset ended this session along with the rest, so a replacement comes back — otherwise
    // the administrator would be signed out by their own action.
    expect(tokens).toBeTruthy();

    const me = await env.server.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: bearer(tokens!.accessToken),
    });
    expect(me.statusCode).toBe(200);
    expect(
      (await post(env.server, "/api/auth/login", { username: "tester", password })).statusCode
    ).toBe(200);
  });

  it("takes a password the administrator chose, if one is given", async () => {
    env = await startTestServer();
    const bob = await createAndSignIn(env, "Bob");

    const res = await env.inject({
      method: "POST",
      url: `/api/admin/users/${bob.user.id}/password`,
      payload: { password: "chosen-by-the-admin" },
    });
    expect(res.json<UserCredentials>().password).toBe("chosen-by-the-admin");

    const weak = await env.inject({
      method: "POST",
      url: `/api/admin/users/${bob.user.id}/password`,
      payload: { password: "short" },
    });
    expect(weak.json<Body>().error.code).toBe("PASSWORD_TOO_SHORT");
  });

  it("refuses an ordinary account and an unknown one", async () => {
    env = await startTestServer();
    const bob = await createAndSignIn(env, "Bob");
    expect(
      (await bob.inject({ method: "POST", url: `/api/admin/users/${env.user.id}/password` }))
        .statusCode
    ).toBe(403);
    expect(
      (await env.inject({ method: "POST", url: "/api/admin/users/nope/password" })).json<Body>()
        .error.code
    ).toBe("USER_NOT_FOUND");
  });
});

describe("POST /api/admin/users/:id/revoke", () => {
  it("signs an account out everywhere without touching its password", async () => {
    env = await startTestServer();
    const bob = await createAndSignIn(env, "Bob");

    const res = await env.inject({
      method: "POST",
      url: `/api/admin/users/${bob.user.id}/revoke`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ revoked: number }>().revoked).toBe(2);

    expect((await bob.inject({ method: "GET", url: "/api/auth/me" })).statusCode).toBe(401);
    // Not a reset: the credential is untouched and the account signs straight back in.
    expect(
      (await post(env.server, "/api/auth/login", { username: "Bob", password: bob.password }))
        .statusCode
    ).toBe(200);
  });

  it("refuses to kick the administrator out of their own session", async () => {
    // The control is for ending somebody else's session; signing yourself out already has a
    // button, and this one would leave the console on a screen it cannot use.
    env = await startTestServer();
    const res = await env.inject({
      method: "POST",
      url: `/api/admin/users/${env.user.id}/revoke`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<Body>().error.code).toBe("CANNOT_MODIFY_SELF");
  });
});

describe("installation-wide settings", () => {
  it("are readable by anybody and writable only by an administrator", async () => {
    /*
     * Reads stay open because the composer needs the model list and the parse state, and a
     * screen that cannot say which models exist is not one anybody can use. Writes are the
     * administrator's, and it matters more than it looks now that there is more than one
     * account: a provider's `baseURL` is where every conversation's prompts go, so an account
     * that can add one and point the defaults at it reads everybody's traffic. And
     * `POST /api/document-parsers/:id/test` makes the *server* fetch a `baseURL` the caller
     * chose — the capability `web_fetch` needs an SSRF guard for.
     */
    env = await startTestServer();
    const bob = await createAndSignIn(env, "Bob");

    for (const url of ["/api/providers", "/api/document-parsers", "/api/config"]) {
      expect([url, (await bob.inject({ method: "GET", url })).statusCode]).toEqual([url, 200]);
    }

    const refused = [
      ["POST", "/api/providers"],
      ["PUT", "/api/defaults"],
      ["PUT", "/api/document-parsing"],
      ["POST", "/api/document-parsers"],
    ] as const;
    for (const [method, url] of refused) {
      const res = await bob.inject({ method, url, payload: {} });
      expect([url, res.statusCode]).toEqual([url, 403]);
      expect(res.json<Body>().error.code).toBe("FORBIDDEN");
    }
  });

  it("leave an administrator able to change them", async () => {
    // The gate has to be a gate and not a wall: Settings is a superadmin's, and every one of
    // these routes was reachable before there were roles at all.
    env = await startTestServer();
    expect(
      (
        await env.inject({
          method: "POST",
          url: "/api/providers",
          payload: { name: "Second", baseURL: "http://127.0.0.1:1/v1" },
        })
      ).statusCode
    ).toBe(201);
    expect((await env.inject({ method: "PUT", url: "/api/defaults", payload: {} })).statusCode).toBe(
      200
    );
  });
});

describe("the forced password change", () => {
  /** The state between the two: created, signed in, and not yet through the change. */
  async function freshAccount(username: string): Promise<TestAccount> {
    const { user, password } = await createAccount(env!, username);
    const session = await signIn(env!, username, password);
    return { user, password, token: session.token, inject: session.inject };
  }

  it("refuses every other route until the password is chosen", async () => {
    // Enforced on the server, not only on the screen. The account holds a working token, so a
    // rule the client is the only thing applying is not a rule — anything that can make a
    // request could skip the screen.
    env = await startTestServer();
    const bob = await freshAccount("Bob");
    expect(bob.user.mustChangePassword).toBe(true);

    for (const [method, url] of [
      ["GET", "/api/workspaces"],
      ["GET", "/api/config"],
      ["GET", "/api/admin/users"],
    ] as const) {
      const res = await bob.inject({ method, url });
      expect([url, res.statusCode]).toEqual([url, 403]);
      expect(res.json<Body>().error.code).toBe("PASSWORD_CHANGE_REQUIRED");
    }
  });

  it("leaves the three routes that make it escapable open", async () => {
    env = await startTestServer();
    const bob = await freshAccount("Bob");

    // Asking who you are is how the client knows which screen to draw...
    const me = await bob.inject({ method: "GET", url: "/api/auth/me" });
    expect(me.statusCode).toBe(200);
    expect(me.json<{ mustChangePassword: boolean }>().mustChangePassword).toBe(true);

    // ...and setting the password is the way out. The pair that comes back is the one to use
    // from here: the change ended every session the account had, this one included.
    const changed = await bob.inject({
      method: "POST",
      url: "/api/auth/password",
      payload: { oldPassword: bob.password, newPassword: TEST_PASSWORD },
    });
    expect(changed.statusCode).toBe(200);
    const settled = injectWith(env, changed.json<AuthResult>().tokens.accessToken);

    // ...and signing out has to work, or a user who cannot remember what they were given is
    // stuck on a screen with no exit at all.
    const bystander = await freshAccount("Carol");
    expect((await bystander.inject({ method: "POST", url: "/api/auth/logout" })).statusCode).toBe(
      200
    );

    // And afterwards the account is ordinary.
    expect((await settled({ method: "GET", url: "/api/workspaces" })).statusCode).toBe(200);
    // The token it held while it owed the change is gone with the rest — that is the cost of
    // ending every session, and why the reply carries a replacement.
    expect((await bob.inject({ method: "GET", url: "/api/workspaces" })).statusCode).toBe(401);
  });

  it("survives a refresh, so a reload does not lose the obligation", async () => {
    env = await startTestServer();
    const bob = await freshAccount("Bob");
    const refreshed = await post(env.server, "/api/auth/login", {
      username: "Bob",
      password: bob.password,
    }).then((r) => r.json<AuthResult>());

    const res = await env.server.app.inject({
      method: "GET",
      url: "/api/workspaces",
      headers: bearer(refreshed.tokens.accessToken),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /api/auth/panel-reset", () => {
  it("is not there at all when no control panel launched the server", async () => {
    // A checkout, a `pnpm dev`, a test run. Answering 404 rather than 403 means an installation
    // with no panel does not advertise a recovery endpoint it will never accept.
    env = await startTestServer();
    const res = await post(env.server, "/api/auth/panel-reset", {});
    expect(res.statusCode).toBe(404);
  });

  it("refuses a request that does not carry the panel's secret", async () => {
    env = await startTestServer();
    process.env[PANEL_TOKEN_ENV] = "the-panel-secret";

    const res = await post(env.server, "/api/auth/panel-reset", {});
    expect(res.statusCode).toBe(403);

    const wrong = await env.server.app.inject({
      method: "POST",
      url: "/api/auth/panel-reset",
      headers: { [PANEL_TOKEN_HEADER]: "not-the-panel-secret" },
      payload: {},
    });
    expect(wrong.statusCode).toBe(403);
  });

  it("replaces an administrator's password and ends their sessions", async () => {
    // The way back in for a forgotten password. Without it an installation whose only
    // administrator forgot theirs is a directory of files nobody can open.
    env = await startTestServer({ username: "Ada" });
    process.env[PANEL_TOKEN_ENV] = "the-panel-secret";

    const res = await env.server.app.inject({
      method: "POST",
      url: "/api/auth/panel-reset",
      headers: { [PANEL_TOKEN_HEADER]: "the-panel-secret" },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const { user, password } = res.json<UserCredentials>();
    expect(user.username).toBe("Ada");
    // No forced change: the panel is the one place where sitting at the machine is the proof of
    // identity, and the person doing this is the administrator themselves.
    expect(user.mustChangePassword).toBe(false);

    // The old session is gone, and the new password works.
    expect((await env.inject({ method: "GET", url: "/api/auth/me" })).statusCode).toBe(401);
    expect(
      (await post(env.server, "/api/auth/login", { username: "Ada", password })).statusCode
    ).toBe(200);
  });

  it("resets the administrator named, and refuses an ordinary account", async () => {
    env = await startTestServer({ username: "Ada" });
    process.env[PANEL_TOKEN_ENV] = "the-panel-secret";
    const header = { [PANEL_TOKEN_HEADER]: "the-panel-secret" };

    const bob = await createAndSignIn(env, "Bob");
    const refused = await env.server.app.inject({
      method: "POST",
      url: "/api/auth/panel-reset",
      headers: header,
      payload: { username: "Bob" },
    });
    expect(refused.statusCode).toBe(400);

    const named = await env.server.app.inject({
      method: "POST",
      url: "/api/auth/panel-reset",
      headers: header,
      payload: { username: "Ada" },
    });
    expect(named.json<UserCredentials>().user.id).toBe(env.user.id);
    expect(bob.user.id).not.toBe(env.user.id);
  });
});
