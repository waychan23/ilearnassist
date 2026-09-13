import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAdmin } from "../src/adminCli.js";
import { createDb, type AppDb } from "../src/db.js";
import type { AuthResult } from "@ilearnassist/shared";
import { startBareServer, startTestServer, TEST_PASSWORD, type TestEnv } from "./helpers/tempEnv.js";

/**
 * Accounts, and the two rules that make them safe to build a directory tree on: a username
 * is matched case-insensitively, and the slug that names the directory is chosen once.
 *
 * Nothing here is about credentials — `auth.test.ts` owns signing in. This is about the row
 * underneath, and the directory tree built on top of it.
 */

let root: string;
let db: AppDb;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ila-users-"));
  db = createDb(join(root, "test.sqlite"));
});

afterEach(() => {
  try {
    db.raw.close();
  } catch {
    /* already closed */
  }
  rmSync(root, { recursive: true, force: true });
});

describe("users", () => {
  it("creates and reads back an account", () => {
    const created = db.createUser({ id: "u1", username: "Ada", slug: "ada" });
    expect(created).toMatchObject({ id: "u1", username: "Ada", slug: "ada" });
    expect(created.createdAt).toBeTruthy();
    expect(db.getUser("u1")).toEqual(created);
  });

  it("returns undefined for an unknown id", () => {
    expect(db.getUser("nope")).toBeUndefined();
  });

  it("matches the username case-insensitively, so one person is one account", () => {
    // Otherwise "Ada" and "ada" are two accounts with two directories and two sets of
    // conversations, and the login screen cannot tell the user which one they are about to
    // open.
    db.createUser({ id: "u1", username: "Ada", slug: "ada" });
    expect(db.findUserByUsername("ada")?.id).toBe("u1");
    expect(db.findUserByUsername("ADA")?.id).toBe("u1");
    expect(db.findUserByUsername("  Ada  ")).toBeUndefined(); // trimming is the route's job
    expect(db.findUserByUsername("bob")).toBeUndefined();
  });

  it("refuses a second account with the same slug", () => {
    // The slug is a directory name under `users/`, so this constraint is the thing standing
    // between two accounts and one shared tree.
    db.createUser({ id: "u1", username: "Ada", slug: "ada" });
    expect(() => db.createUser({ id: "u2", username: "Ada2", slug: "ada" })).toThrow();
  });

  it("keeps the slug when the username changes", () => {
    // Renaming is display-only, for the same reason a workspace's is: every path in the
    // user's workspaces is built on the slug, and moving them would break every path the
    // agent has already written into a conversation.
    db.createUser({ id: "u1", username: "Ada", slug: "ada" });
    db.raw.prepare("UPDATE users SET username = ? WHERE id = ?").run("Ada Lovelace", "u1");

    const renamed = db.getUser("u1")!;
    expect(renamed.username).toBe("Ada Lovelace");
    expect(renamed.slug).toBe("ada");
    expect(db.findUserByUsername("Ada Lovelace")?.id).toBe("u1");
  });

  it("lists accounts by username, case-insensitively", () => {
    db.createUser({ id: "u1", username: "bob", slug: "bob" });
    db.createUser({ id: "u2", username: "Ada", slug: "ada" });
    expect(db.listUsers().map((u) => u.username)).toEqual(["Ada", "bob"]);
  });

  it("lets two accounts hold a workspace with the same slug", () => {
    // `UNIQUE(user_id, slug)` rather than `UNIQUE(slug)`: the slug only has to be unique
    // among *one* user's workspaces, and a global constraint would refuse the second person
    // to create a workspace called "notes" for no reason they could act on.
    db.createUser({ id: "u1", username: "ada", slug: "ada" });
    db.createUser({ id: "u2", username: "bob", slug: "bob" });

    db.createWorkspace({
      id: "w1",
      userId: "u1",
      name: "Notes",
      slug: "notes",
      dirPath: join(root, "users", "ada", "workspaces", "notes"),
    });
    expect(() =>
      db.createWorkspace({
        id: "w2",
        userId: "u2",
        name: "Notes",
        slug: "notes",
        dirPath: join(root, "users", "bob", "workspaces", "notes"),
      })
    ).not.toThrow();

    expect(db.listWorkspaces("u1").map((w) => w.id)).toEqual(["w1"]);
    expect(db.listWorkspaces("u2").map((w) => w.id)).toEqual(["w2"]);
  });
});

describe("signing in", () => {
  let env: TestEnv | undefined;

  afterEach(async () => {
    await env?.cleanup();
  });

  it("creates the account and its whole tree under the chosen data root", async () => {
    // The harness signs in, so this is also the assertion that a first sign-in is what
    // materialises `users/<slug>/` — there is no account until somebody names one.
    env = await startTestServer({ username: "Ada" });

    expect(env.user.username).toBe("Ada");
    expect(env.user.slug).toBe("ada");
    expect(env.workspacesRoot).toBe(join(env.dataRoot, "users", "ada", "workspaces"));
    expect(existsSync(env.workspacesRoot)).toBe(true);
    expect(existsSync(env.userLayout.rawDir)).toBe(true);
    expect(existsSync(env.userLayout.parsedDir)).toBe(true);
  });

  it("signs the same account back in after a restart, and never offers setup again", async () => {
    // The rule that keeps a restart — or a second device — from orphaning a tree: the name is
    // the identity, and the account is found rather than made. The root is made here rather
    // than by the helper, because a caller-named root is the caller's to remove, which is what
    // makes booting it twice possible at all.
    const shared = mkdtempSync(join(tmpdir(), "ila-restart-"));
    try {
      const first = await startTestServer({ dataRoot: shared, username: "Ada" });
      const firstId = first.user.id;
      await first.cleanup();

      // The harness bootstraps by *creating* an administrator, which a root that already has
      // one refuses — so the second boot signs in instead, which is what a person does.
      const second = await startBareServer({ dataRoot: shared });
      try {
        const res = await second.server.app.inject({
          method: "POST",
          url: "/api/auth/login",
          // A different case, deliberately: the lookup is case-insensitive, so this is the same
          // person and the stored spelling is the one they first used.
          payload: { username: "ada", password: TEST_PASSWORD },
        });
        expect(res.statusCode).toBe(200);
        const { user } = res.json<AuthResult>();
        expect(user.id).toBe(firstId);
        expect(user.username).toBe("Ada");

        // And the bootstrap stays shut, which is what "once, and then never again" means for
        // a root that already has an administrator. Asked through the CLI, because that is
        // what the control panel asks — it has to work with the server stopped.
        const again = await createAdmin({
          dataRoot: shared,
          username: "Mallory",
          password: TEST_PASSWORD,
        });
        expect(again.ok).toBe(false);
        expect(again.ok || again.body.error.code).toBe("ADMIN_EXISTS");
      } finally {
        await second.cleanup();
      }
    } finally {
      rmSync(shared, { recursive: true, force: true });
    }
  });

  it("gives two accounts different trees under one data root", async () => {
    env = await startTestServer({ username: "Ada" });
    const bob = await env.asUser("Bob");

    expect(bob.user.slug).toBe("bob");
    expect(env.workspacesRoot).not.toBe(
      join(env.dataRoot, "users", "bob", "workspaces")
    );
    expect(existsSync(join(env.dataRoot, "users", "bob", "workspaces"))).toBe(true);
  });
});
