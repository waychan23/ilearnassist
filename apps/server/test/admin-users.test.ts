import { afterEach, describe, expect, it } from "vitest";
import type { LightMyRequestResponse } from "fastify";
import type {
  AdminUser,
  AuthResult,
  UserCredentials,
  UserRole,
} from "@ilearnassist/shared";
import { startTestServer, TEST_PASSWORD, type TestEnv } from "./helpers/tempEnv.js";

/**
 * The platform console: making accounts, taking them away, and the rules that decide who may
 * touch whom.
 *
 * Every route here is an administrator's, so most of these tests are as much about who is
 * *refused* as about what the route does. The forced password change has its own describe,
 * because it is the one rule that reaches into every other route in the product.
 *
 * Recovery for a *forgotten* password is deliberately not here — it is not a route at all. See
 * the note at the end of this file.
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

/**
 * Create an account through the console. Leaves it owing a password change.
 *
 * `roles` defaults to whatever the server makes an account when nobody says — `["user"]` — so
 * only the tests about the two tiers pass it, and they pass it explicitly rather than relying
 * on the default they are here to tell apart from.
 */
async function createAccount(
  env: TestEnv,
  username: string,
  roles?: UserRole[]
): Promise<{ user: AdminUser; password: string }> {
  const created = await env.inject({
    method: "POST",
    url: "/api/admin/users",
    payload: roles ? { username, roles } : { username },
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
async function createAndSignIn(
  env: TestEnv,
  username: string,
  roles?: UserRole[]
): Promise<TestAccount> {
  const { user, password: issued } = await createAccount(env, username, roles);
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

  it("makes an ordinary administrator when the superadmin asks", async () => {
    env = await startTestServer();
    const res = await env.inject({
      method: "POST",
      url: "/api/admin/users",
      payload: { username: "Bob", roles: ["admin"] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<UserCredentials>().user.roles).toEqual(["admin"]);
  });

  it("never mints a superadmin through the console, even for a superadmin", async () => {
    // The one superadmin is the account the desktop control panel bootstraps with the server
    // stopped. Granting the role here would be the second mint path, so it does not exist —
    // the box is absent from the dialog and a hand-written request gets the same refusal.
    env = await startTestServer();
    const res = await env.inject({
      method: "POST",
      url: "/api/admin/users",
      payload: { username: "Bob", roles: ["superadmin"] },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<Body>().error.code).toBe("SUPERADMIN_NOT_GRANTABLE");
    expect(env.server.db.findUserByUsername("Bob")).toBeUndefined();
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
      payload: { roles: ["admin"] satisfies UserRole[] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<AdminUser>().roles).toEqual(["admin"]);
    // The role is read per request rather than baked into the token, so it takes effect now.
    expect(
      (await bob.inject({ method: "GET", url: "/api/admin/users" })).statusCode
    ).toBe(200);
  });

  it("refuses to promote an account to superadmin, whoever is asking", async () => {
    // There is exactly one superadmin, the control-panel bootstrap account. Promotion here
    // would be a second mint path, so it is refused rather than silently downgraded.
    env = await startTestServer();
    const bob = await createAndSignIn(env, "Bob");

    const res = await env.inject({
      method: "PATCH",
      url: `/api/admin/users/${bob.user.id}`,
      payload: { roles: ["superadmin"] },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<Body>().error.code).toBe("SUPERADMIN_NOT_GRANTABLE");
    expect(env.server.db.getUser(bob.user.id)!.roles).toEqual(["user"]);
  });

  it("leaves fields the request does not mention alone", async () => {
    // A `PATCH` that omitted `roles` must not read as "no roles" — the two are separate checks
    // at the call site for exactly this reason.
    env = await startTestServer();
    const bob = await createAndSignIn(env, "Bob");
    await env.inject({
      method: "PATCH",
      url: `/api/admin/users/${bob.user.id}`,
      payload: { roles: ["admin"] },
    });

    const res = await env.inject({
      method: "PATCH",
      url: `/api/admin/users/${bob.user.id}`,
      payload: { disabled: true },
    });
    expect(res.json<AdminUser>().roles).toEqual(["admin"]);
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

  it("lets the superadmin demote an ordinary administrator, but never the bootstrap one", async () => {
    // An installation has one superadmin and it is not editable through a screen. The
    // superadmin may still take the ordinary tier back from an account it gave it to; the
    // bootstrap account cannot demote *itself* (self-guard) and nobody else may touch its row
    // (`manageRefusal`, pinned in the two-tier describe below).
    env = await startTestServer({ username: "Ada" });
    const bob = await createAndSignIn(env, "Bob", ["admin"]);

    const demoted = await env.inject({
      method: "PATCH",
      url: `/api/admin/users/${bob.user.id}`,
      payload: { roles: ["user"] },
    });
    expect(demoted.statusCode).toBe(200);
    expect(demoted.json<AdminUser>().roles).toEqual(["user"]);

    // Still exactly one enabled superadmin, and it is the bootstrap account.
    const superadmins = env.server.db
      .listUsers()
      .filter((u) => !u.disabled && u.roles.includes("superadmin"));
    expect(superadmins).toHaveLength(1);
    expect(superadmins[0]!.username).toBe("Ada");
  });

  it("allows a change that does not cost the account its own authority", async () => {
    // The guard is about *losing* the role, not about touching the row: re-enabling yourself
    // is an ordinary edit. Roles are omitted here because the superadmin role can no longer
    // be restated through a write body.
    env = await startTestServer();
    const res = await env.inject({
      method: "PATCH",
      url: `/api/admin/users/${env.user.id}`,
      payload: { disabled: false },
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

  it("does not make an administrator change the password they just set for themselves", async () => {
    // The asymmetry, and it is the whole reason the two paths are different routes: resetting
    // *your own* password is a choice you made a moment ago and are about to keep using, so a
    // screen demanding you replace it would be a step with nothing behind it.
    //
    // Checked on an *ordinary* administrator, because the superadmin's own reset is refused
    // outright — see the next test. The rule this pins is about a self-reset that is allowed.
    env = await startTestServer();
    const ada = await createAndSignIn(env, "Ada", ["admin"]);

    const res = await ada.inject({
      method: "POST",
      url: `/api/admin/users/${ada.user.id}/password`,
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
      (await post(env.server, "/api/auth/login", { username: "Ada", password })).statusCode
    ).toBe(200);
  });

  it("refuses a superadmin's own reset and names the control panel", async () => {
    // A rule rather than a convenience. The web console is reached with a credential the caller
    // already holds, so a self-reset here would be a second and weaker way to replace the one
    // credential that can undo the installation. The panel proves identity by being the machine,
    // which is why it is the way back in.
    env = await startTestServer();
    const res = await env.inject({
      method: "POST",
      url: `/api/admin/users/${env.user.id}/password`,
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<Body>().error.code).toBe("PANEL_RESET_REQUIRED");

    // And the refusal is not a half-applied change: the existing credential still works.
    expect(
      (await post(env.server, "/api/auth/login", { username: "tester", password: TEST_PASSWORD }))
        .statusCode
    ).toBe(200);
  });

  it("lets a superadmin reset an ordinary administrator's password", async () => {
    // The common case the tier exists for: a superadmin hands an administrator a way back in.
    // Nothing about the target being an administrator changes the shape of the reply.
    env = await startTestServer();
    const ada = await createAndSignIn(env, "Ada", ["admin"]);

    const res = await env.inject({
      method: "POST",
      url: `/api/admin/users/${ada.user.id}/password`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const { user, password, tokens } = res.json<UserCredentials>();
    expect(user.mustChangePassword).toBe(true);
    expect(password).not.toBe(ada.password);
    expect(tokens).toBeUndefined();
    // Signed out everywhere, which is half of what a reset is.
    expect((await ada.inject({ method: "GET", url: "/api/auth/me" })).statusCode).toBe(401);
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

/**
 * The two tiers, and this is where the difference between them is pinned.
 *
 * A superadmin is the account the installation was bootstrapped with: created by the control
 * panel or the CLI, and the only role that may appoint anybody. An ordinary `admin` runs the
 * installation's *accounts* — and an account that administers it is not one of them. Every
 * refusal here is about the target rather than the action, which is why the same caller is
 * allowed one line and refused the next.
 */
describe("the two tiers of administrator", () => {
  /** One ordinary administrator, plus one ordinary account, under a superadmin. */
  async function tiers() {
    const started = await startTestServer();
    return {
      env: started,
      ada: await createAndSignIn(started, "Ada", ["admin"]),
      bob: await createAndSignIn(started, "Bob"),
    };
  }

  it("lets an ordinary administrator run the ordinary accounts", async () => {
    const { env: e, ada, bob } = await tiers();

    // Sees the list (which is how the console knows what to offer), and acts on a plain account.
    const listed = await ada.inject({ method: "GET", url: "/api/admin/users" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ users: AdminUser[] }>().users).toHaveLength(3);

    const disabled = await ada.inject({
      method: "PATCH",
      url: `/api/admin/users/${bob.user.id}`,
      payload: { disabled: true },
    });
    expect(disabled.statusCode).toBe(200);
    expect((await bob.inject({ method: "GET", url: "/api/auth/me" })).statusCode).toBe(401);
  });

  it("refuses an ordinary administrator every action on another administrator's row", async () => {
    const { env: e, ada } = await tiers();
    // A peer administrator: two ordinary admins may not manage each other either — the tier
    // that appoints an administrator is the tier that undoes one.
    const cara = await createAndSignIn(e, "Cara", ["admin"]);

    // Both the superadmin who bootstrapped the installation and the peer administrator.
    for (const target of [
      ["the bootstrap superadmin", e.user.id],
      ["a peer administrator", cara.user.id],
    ] as const) {
      for (const [method, url, payload] of [
        ["PATCH", `/api/admin/users/${target[1]}`, { disabled: true }],
        ["PATCH", `/api/admin/users/${target[1]}`, { roles: ["user"] }],
        ["POST", `/api/admin/users/${target[1]}/password`, {}],
        ["POST", `/api/admin/users/${target[1]}/revoke`, {}],
      ] as const) {
        const res = await ada.inject({ method, url, payload });
        expect(res.statusCode, `${target[0]}: ${method} ${url}`).toBe(403);
        expect(res.json<Body>().error.code, `${target[0]}: ${method} ${url}`).toBe(
          "CANNOT_MODIFY_ADMIN"
        );
      }
    }

    // And the rows are untouched: still an enabled superadmin who can sign in...
    expect((await e.inject({ method: "GET", url: "/api/auth/me" })).statusCode).toBe(200);
    // ...and the peer still holds the admin role.
    expect(e.server.db.getUser(cara.user.id)!.disabled).toBe(false);
    expect(e.server.db.getUser(cara.user.id)!.roles).toEqual(["admin"]);
  });

  it("refuses to let an ordinary administrator appoint one — including a peer", async () => {
    const { env: e, ada } = await tiers();

    // Not silently stripped down to `user`: a request that asked for an administrator and got
    // an ordinary account would report success and deliver something else.
    const created = await ada.inject({
      method: "POST",
      url: "/api/admin/users",
      payload: { username: "Eve", roles: ["admin"] },
    });
    expect(created.statusCode).toBe(403);
    expect(created.json<Body>().error.code).toBe("ROLES_NOT_GRANTABLE");

    // Promotion, too, and not only creation.
    const promoted = await ada.inject({
      method: "PATCH",
      url: `/api/admin/users/${(await createAndSignIn(e, "Cara")).user.id}`,
      payload: { roles: ["admin"] },
    });
    expect(promoted.statusCode).toBe(403);
    expect(promoted.json<Body>().error.code).toBe("ROLES_NOT_GRANTABLE");

    // Nothing was written by either attempt.
    const users = (await e.inject({ method: "GET", url: "/api/admin/users" })).json<{
      users: AdminUser[];
    }>().users;
    expect(users.find((u) => u.username === "Eve")).toBeUndefined();
    expect(users.find((u) => u.username === "Cara")!.roles).toEqual(["user"]);
  });

  it("lets a superadmin take an ordinary administrator's tier back as well as give it", async () => {
    const { env: e, ada } = await tiers();

    // Disable and kick an ordinary administrator.
    expect(
      (await e.inject({ method: "PATCH", url: `/api/admin/users/${ada.user.id}`, payload: { disabled: true } }))
        .statusCode
    ).toBe(200);
    expect((await ada.inject({ method: "GET", url: "/api/auth/me" })).statusCode).toBe(401);

    // Re-enable as an ordinary account: the superadmin may demote an administrator down to a
    // plain account. The bootstrap superadmin itself is never on the receiving end — there is
    // no second superadmin to act, and self-demotion is the self-guard's refusal.
    const restored = await e.inject({
      method: "PATCH",
      url: `/api/admin/users/${ada.user.id}`,
      payload: { disabled: false, roles: ["user"] },
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json<AdminUser>().roles).toEqual(["user"]);
    // Still exactly one superadmin: the account that made the request.
    expect(
      e.server.db.listUsers().filter((u) => !u.disabled && u.roles.includes("superadmin"))
    ).toHaveLength(1);
    expect((await e.inject({ method: "GET", url: "/api/admin/users" })).statusCode).toBe(200);
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

  it("leave a superadmin able to change them", async () => {
    // The gate has to be a gate and not a wall: these routes were reachable before there were
    // roles at all, and the bootstrap account is the one that must never be locked out.
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

  it("leave an ordinary administrator able to change them, which is the job", async () => {
    /*
     * The split the feature is built on: an administrator *configures* the models and an
     * ordinary account *chooses among* them. So this gate is the wider one, unlike the account
     * routes — appointing an administrator is a superadmin's act, and running the installation
     * is what the `admin` role is appointed to do.
     */
    env = await startTestServer();
    const ada = await createAndSignIn(env, "Ada", ["admin"]);

    const created = await ada.inject({
      method: "POST",
      url: "/api/providers",
      payload: { name: "Second", baseURL: "http://127.0.0.1:1/v1" },
    });
    expect(created.statusCode).toBe(201);

    // And the app default, which is the one that decides where everybody's prompts go.
    expect((await ada.inject({ method: "PUT", url: "/api/defaults", payload: {} })).statusCode).toBe(
      200
    );
    expect(
      (await ada.inject({ method: "POST", url: "/api/document-parsers", payload: {} })).statusCode
    ).toBe(400);
  });

  it("are still refused to an account that administers nothing", async () => {
    // The other half, and the reason the tier is worth having: a user may choose a model, and
    // may not write one into the list everybody chooses from.
    env = await startTestServer();
    const bob = await createAndSignIn(env, "Bob");

    const res = await bob.inject({
      method: "POST",
      url: "/api/providers",
      payload: { name: "Mine", baseURL: "http://127.0.0.1:1/v1" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<Body>().error.code).toBe("FORBIDDEN");

    // Readable, though: the composer's model list is everybody's.
    expect((await bob.inject({ method: "GET", url: "/api/providers" })).statusCode).toBe(200);
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

/*
 * There is deliberately **no HTTP route that resets a forgotten password**, so there is nothing
 * here to test. Every route in this file is reached by somebody already signed in, which is
 * exactly what a forgotten password prevents — recovery cannot live on this side at all.
 *
 * It lives in the administrator CLI, which the control panel spawns as a one-shot child on the
 * operator's own machine: `reset-admin`. See `adminCli.test.ts` for the rule and
 * `docs/desktop.md` for why a route guarded by a per-launch secret was replaced by one that
 * works whether or not the server is up.
 */
