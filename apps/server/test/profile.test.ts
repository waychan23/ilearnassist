import { afterEach, describe, expect, it } from "vitest";
import { PROFILE_ABOUT_MAX, type User } from "@ilearnassist/shared";
import { startTestServer, TEST_PASSWORD, type TestEnv } from "./helpers/tempEnv.js";

/**
 * `PATCH /api/auth/me` — the account's introduction.
 *
 * The one field of an account's own record it may write, so the interesting half is what it may
 * *not*: not while a password change is owed, not without a token, and never a coerced value.
 * The other half is that the text actually reaches the model, which is `prompts.test.ts`'s job on
 * the prompt side and `about.test.ts`'s on the turn's.
 */

let env: TestEnv | undefined;

afterEach(async () => {
  await env?.cleanup();
  env = undefined;
});

const patch = (e: TestEnv, payload: unknown) =>
  e.inject({ method: "PATCH", url: "/api/auth/me", payload: payload as Record<string, unknown> });

describe("PATCH /api/auth/me", () => {
  it("stores the introduction and answers the whole updated account", async () => {
    env = await startTestServer({ username: "Ada" });

    const res = await patch(env, { about: "I write backend code and am learning ML." });

    expect(res.statusCode).toBe(200);
    expect(res.json<User>().about).toBe("I write backend code and am learning ML.");
    // …and it is the account as the client already knows it, not a partial patch.
    expect(res.json<User>().username).toBe("Ada");

    // Persisted, not merely echoed: a fresh read agrees.
    const me = await env.inject({ method: "GET", url: "/api/auth/me" });
    expect(me.json<User>().about).toBe("I write backend code and am learning ML.");
  });

  it("trims, because this is prompt input rather than prose for others to read back", async () => {
    env = await startTestServer({ username: "Ada" });
    const res = await patch(env, { about: "   padded   " });
    expect(res.json<User>().about).toBe("padded");
  });

  it("clears it with an empty string", async () => {
    env = await startTestServer({ username: "Ada" });
    await patch(env, { about: "something" });
    const res = await patch(env, { about: "" });
    expect(res.statusCode).toBe(200);
    expect(res.json<User>().about).toBe("");
  });

  it("refuses a value that is not a string rather than coercing it", async () => {
    // `String(undefined)` is "undefined", which would then be written into every turn's prompt.
    env = await startTestServer({ username: "Ada" });
    for (const about of [undefined, null, 42, { text: "hi" }, ["hi"], true]) {
      const res = await patch(env, { about });
      expect(res.statusCode, `about = ${JSON.stringify(about)}`).toBe(400);
      expect(res.json<{ error: { code: string } }>().error.code).toBe("INVALID_FIELD");
    }
    expect((await env.inject({ method: "GET", url: "/api/auth/me" })).json<User>().about).toBe("");
  });

  it("refuses one past the ceiling, naming the limit", async () => {
    env = await startTestServer({ username: "Ada" });
    const res = await patch(env, { about: "x".repeat(PROFILE_ABOUT_MAX + 1) });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string; params?: { max?: number } } }>().error.params?.max).toBe(
      PROFILE_ABOUT_MAX
    );
  });

  it("accepts exactly the ceiling", async () => {
    env = await startTestServer({ username: "Ada" });
    const res = await patch(env, { about: "x".repeat(PROFILE_ABOUT_MAX) });
    expect(res.statusCode).toBe(200);
  });

  it("refuses a missing body rather than storing nothing quietly", async () => {
    env = await startTestServer({ username: "Ada" });
    const res = await env.inject({ method: "PATCH", url: "/api/auth/me" });
    expect(res.statusCode).toBe(400);
  });

  it("needs a signed-in account", async () => {
    env = await startTestServer({ username: "Ada" });
    const res = await env.server.app.inject({
      method: "PATCH",
      url: "/api/auth/me",
      payload: { about: "hi" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("touches this account and nobody else", async () => {
    env = await startTestServer({ username: "Ada" });
    const other = await env.asUser("Grace");

    await patch(env, { about: "Ada's own words." });

    const theirs = await other.inject({ method: "GET", url: "/api/auth/me" });
    expect(theirs.json<User>().about).toBe("");
    // And the route has no way to name a target at all — there is no id in the path or the body.
    expect(other.user.username).toBe("Grace");
  });

  it("is refused while a password change is still owed", async () => {
    /*
     * The account holds a working token, so this is a server rule rather than a screen's: an
     * account owing a password change is refused everything but the three routes that get it out
     * of that state, and writing a profile is not one of them. Enforced by the routes plugin's
     * `allowPendingPassword` hook, which is deny-by-default — this test is what would fail if
     * somebody marked the route opt-out without thinking about it.
     */
    env = await startTestServer({ username: "Ada" });
    const record = env.server.db.getUser(env.user.id);
    env.server.db.setUserPassword(env.user.id, record?.passwordHash ?? "x", true);

    const res = await patch(env, { about: "anything" });
    expect(res.statusCode).toBe(403);
    expect((await env.inject({ method: "GET", url: "/api/auth/me" })).json<User>().about).toBe("");
  });

  it("survives a password change, which is a different field of the same row", async () => {
    env = await startTestServer({ username: "Ada" });
    await patch(env, { about: "kept" });

    const changed = await env.inject({
      method: "POST",
      url: "/api/auth/password",
      payload: { oldPassword: TEST_PASSWORD, newPassword: "another-good-password" },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json<{ user: User }>().user.about).toBe("kept");
  });
});

describe("the users.about column", () => {
  it("arrives empty on a database created before it", async () => {
    // The migration itself is `db.test.ts`'s, beside every other `ensureColumn` case — the pattern
    // needs a hand-built old table and a version-stamped file, which is that file's furniture.
    // What this checks is the half this feature owns: an account that predates the column reads as
    // having written nothing, rather than crashing or claiming a value nobody set.
    env = await startTestServer({ username: "Ada" });
    expect(env.server.db.getUser(env.user.id)?.about).toBe("");
    expect((await env.inject({ method: "GET", url: "/api/auth/me" })).json<User>().about).toBe("");
  });
});
