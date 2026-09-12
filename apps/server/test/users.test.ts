import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type AppDb } from "../src/db.js";
import { startTestServer, type TestEnv } from "./helpers/tempEnv.js";

/**
 * Accounts, and the two rules that make them safe to build a directory tree on: a username
 * is matched case-insensitively, and the slug that names the directory is chosen once.
 *
 * There is no password yet, so nothing here is about credentials — see `auth` when it lands.
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

describe("the account the server runs as", () => {
  let env: TestEnv | undefined;

  afterEach(async () => {
    await env?.cleanup();
  });

  it("exists, and its tree exists under the chosen data root", async () => {
    env = await startTestServer();

    expect(env.user.username).toBe("default");
    expect(env.user.slug).toBe("default");
    expect(env.workspacesRoot).toBe(
      join(env.dataRoot, "users", "default", "workspaces")
    );
    expect(existsSync(env.workspacesRoot)).toBe(true);
    expect(existsSync(env.userLayout.rawDir)).toBe(true);
    expect(existsSync(env.userLayout.parsedDir)).toBe(true);
  });

  it("is reused rather than recreated when the same data root boots twice", async () => {
    // The rule that keeps a restart from orphaning a tree: the account is found by name.
    // The root is made here rather than by the helper, because a caller-named root is the
    // caller's to remove — which is what makes booting it a second time possible at all.
    const shared = mkdtempSync(join(tmpdir(), "ila-restart-"));
    try {
      const first = await startTestServer({ dataRoot: shared });
      const firstId = first.user.id;
      await first.cleanup();

      env = await startTestServer({ dataRoot: shared });
      expect(env.user.id).toBe(firstId);
    } finally {
      rmSync(shared, { recursive: true, force: true });
    }
  });
});
