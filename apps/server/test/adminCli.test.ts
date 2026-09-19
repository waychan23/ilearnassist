import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AdminCliErrorCode,
  AdminCreateResult,
  AdminMigrateStatusResult,
  AdminMigrateUpResult,
  AdminResetResult,
  AdminStatusResult,
} from "@ilearnassist/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyPassword } from "../src/auth.js";
import { createDb } from "../src/db.js";
import {
  adminStatus,
  migrateUp,
  migrationStatus,
  assertHasAdministrator,
  createAdmin,
  noAdministratorMessage,
  NoAdministratorError,
  PANEL_LAUNCH_ENV,
  resetAdmin,
} from "../src/adminCli.js";
import { dataLayout } from "../src/paths.js";
import { SCHEMA_VERSION } from "../src/schema.js";
import { startBareServer } from "./helpers/tempEnv.js";

/**
 * The administrator CLI's rules, driven directly.
 *
 * This is the whole bootstrap of the product — the control panel spawns it, and a machine with
 * no panel runs it from a terminal — so the subject here is not "does the command work" but
 * "under what circumstances does it refuse, and what does it leave behind when it does".
 *
 * The read-only half is the one worth being paranoid about. `status` answers a *question*, and
 * a question must never be what creates a database, applies a migration or decides a file is
 * fine when it is not.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ila-admincli-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const dbFile = (): string => dataLayout(root).sqliteFile;

/** A root with a schema and no accounts — what a first boot leaves. */
function freshDatabase(): string {
  const db = createDb(dbFile());
  db.raw.close();
  return root;
}

/** A database this build refuses, as `applySchema` would find it. */
function unreadableDatabase(): string {
  mkdirSync(join(root, "db", "sqlite"), { recursive: true });
  const db = new Database(dbFile());
  db.pragma("user_version = 99");
  db.exec("CREATE TABLE something (id TEXT)");
  db.close();
  return root;
}

type AnyOutcome =
  | Awaited<ReturnType<typeof createAdmin>>
  | Awaited<ReturnType<typeof resetAdmin>>
  | ReturnType<typeof adminStatus>;

/** The envelope's error code, asserting the outcome failed. */
function codeOf(outcome: AnyOutcome): AdminCliErrorCode {
  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw new Error("expected a refusal");
  return outcome.body.error.code;
}

/** The status value, asserting that is what came back. */
function statusOf(outcome: AnyOutcome): AdminStatusResult {
  if (!outcome.ok || outcome.value.command !== "status") {
    throw new Error(`expected a status result, got ${JSON.stringify(outcome)}`);
  }
  return outcome.value;
}

/** The migrate-status value, asserting that is what came back. */
function migrateStatusOf(outcome: AnyOutcome): AdminMigrateStatusResult {
  if (!outcome.ok || outcome.value.command !== "migrate-status") {
    throw new Error(`expected a migrate-status result, got ${JSON.stringify(outcome)}`);
  }
  return outcome.value;
}

/** The migrate-up value, asserting that is what came back. */
function migrateUpOf(outcome: AnyOutcome): AdminMigrateUpResult {
  if (!outcome.ok || outcome.value.command !== "migrate-up") {
    throw new Error(`expected a migrate-up result, got ${JSON.stringify(outcome)}`);
  }
  return outcome.value;
}

/** The create value, asserting that is what came back. */
function createOf(outcome: AnyOutcome): AdminCreateResult {
  if (!outcome.ok || (outcome.value.command !== "create-admin" && outcome.value.command !== "ensure-admin")) {
    throw new Error(`expected a create result, got ${JSON.stringify(outcome)}`);
  }
  return outcome.value;
}

/** The reset value, asserting that is what came back. */
function resetOf(outcome: AnyOutcome): AdminResetResult {
  if (!outcome.ok || outcome.value.command !== "reset-admin") {
    throw new Error(`expected a reset result, got ${JSON.stringify(outcome)}`);
  }
  return outcome.value;
}

describe("status", () => {
  it("says a folder with no database is not set up, without creating one", async () => {
    // The ordinary first-run state, and the answer the panel needs: "you may create one". It
    // must not *make* the database, or a question would be a write.
    const value = statusOf(adminStatus(join(root, "nothing-here")));

    expect(value.database).toBe("absent");
    expect(value.hasAdmin).toBe(false);
    expect(readdirNames(join(root, "nothing-here"))).toEqual([]);
  });

  it("reports a database with no accounts as present, with no administrator", () => {
    freshDatabase();
    const value = statusOf(adminStatus(root));

    expect(value.database).toBe("present");
    expect(value.hasAdmin).toBe(false);
    expect(value.adminUsername).toBeNull();
  });

  it("names the administrator once there is one", async () => {
    await createAdmin({ dataRoot: root, username: "Ada", password: "ada-password" });
    const value = statusOf(adminStatus(root));

    expect(value.hasAdmin).toBe(true);
    expect(value.adminUsername).toBe("Ada");
  });

  it("does not mistake an ordinary account for an administrator", () => {
    /*
     * The regression the whole predicate exists for. `hasPasswordAccounts` — a *sign-in*
     * question — would answer yes here, and the server would boot, the panel would hide the
     * create control, and the installation would be one nobody could administer. An account
     * with a credential and no role is not an administrator.
     */
    const db = createDb(dbFile());
    db.createUser({
      id: "u1",
      username: "Ada",
      slug: "ada",
      roles: ["user"],
      passwordHash: "scrypt$16384$8$1$c2FsdA==$ZGVhZGJlZWY=",
    });
    db.raw.close();

    expect(statusOf(adminStatus(root)).hasAdmin).toBe(false);
  });

  it("ignores a disabled superadmin, who can administer nothing", () => {
    const db = createDb(dbFile());
    const user = db.createUser({
      id: "u1",
      username: "Ada",
      slug: "ada",
      roles: ["superadmin"],
      passwordHash: "scrypt$16384$8$1$c2FsdA==$ZGVhZGJlZWY=",
    });
    db.setUserDisabled(user.id, true);
    db.raw.close();

    expect(statusOf(adminStatus(root)).hasAdmin).toBe(false);
  });

  it("refuses to guess at a schema this build cannot read", () => {
    unreadableDatabase();
    const outcome = adminStatus(root);

    expect(codeOf(outcome)).toBe("SCHEMA_UNREADABLE");
    expect(outcome.ok || outcome.body.error.params).toEqual({ found: 99, needed: SCHEMA_VERSION });
  });

  it("does not migrate a database it was only asked about", () => {
    // The sharp edge: one of the `ensureColumn` migrations is an irreversible
    // `DELETE FROM copilots`. A question about a data root must not be what runs it.
    mkdirSync(join(root, "db", "sqlite"), { recursive: true });
    writeFileSync(dbFile(), "not a database at all");

    expect(codeOf(adminStatus(root))).toBe("NOT_A_DATABASE");
    expect(readFileSync(dbFile(), "utf8")).toBe("not a database at all");
  });

  it("refuses a path that is a file rather than a folder", () => {
    const file = join(root, "just-a-file");
    writeFileSync(file, "hello");
    expect(codeOf(adminStatus(file))).toBe("DATA_DIR_INVALID");
  });
});

describe("create-admin", () => {
  it("creates an administrator that can sign in", async () => {
    const outcome = await createAdmin({ dataRoot: root, username: "Ada", password: "ada-password" });

    const value = createOf(outcome);
    expect(value).toMatchObject({ command: "create-admin", created: true, adopted: false, generated: false });
    expect(value.username).toBe("Ada");
    expect(value.slug).toBe("ada");

    // The real check: the stored hash accepts it.
    const db = createDb(dbFile());
    const stored = db.listUsers()[0]!;
    await expect(verifyPassword("ada-password", stored.passwordHash)).resolves.toBe(true);
    await expect(verifyPassword("something-else", stored.passwordHash)).resolves.toBe(false);
    db.raw.close();
  });

  it("invents a readable password when asked, and returns it once", async () => {
    const value = createOf(await createAdmin({ dataRoot: root, username: "Ada" }));

    expect(value.generated).toBe(true);
    expect(value.password).toMatch(/^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/);

    // Only a hash is stored, so there is nothing to read back — the reply is the one chance.
    const db = createDb(dbFile());
    const row = db.raw.prepare("SELECT password_hash FROM users").get() as { password_hash: string };
    expect(row.password_hash).not.toContain(value.password);
    db.raw.close();
  });

  it("adopts the account that owns the work rather than stranding it", async () => {
    /*
     * The upgrade path. A data root carried over from the build where a username was the
     * credential has accounts and no passwords, and that row owns the workspaces — a second
     * account beside it would leave the work under a name nobody can sign in as.
     */
    const db = createDb(dbFile());
    const legacy = db.createUser({ id: "legacy", username: "Ada", slug: "ada" });
    expect(legacy.passwordHash).toBeNull();
    db.raw.close();

    const value = createOf(
      await createAdmin({ dataRoot: root, username: "ada", password: "ada-password" })
    );
    expect(value.adopted).toBe(true);

    const after = createDb(dbFile());
    expect(after.listUsers()).toHaveLength(1);
    expect(after.getUser("legacy")!.roles).toEqual(["superadmin"]);
    expect(after.getUser("legacy")!.passwordHash).not.toBeNull();
    after.raw.close();
  });

  it("refuses a second administrator, and says who has it", async () => {
    await createAdmin({ dataRoot: root, username: "Ada", password: "ada-password" });
    const outcome = await createAdmin({ dataRoot: root, username: "Mallory", password: "mal-password" });

    expect(codeOf(outcome)).toBe("ADMIN_EXISTS");
    expect(outcome.ok || outcome.body.error.params).toEqual({ username: "Ada" });
  });

  it("does nothing at all under `ensure-admin` when there is already one", async () => {
    // What the e2e harness chains before the server: it runs on every start, including a
    // second start against a data folder a killed run left behind.
    await createAdmin({ dataRoot: root, username: "Ada", password: "ada-password" });
    const before = createDb(dbFile());
    const countBefore = before.listUsers().length;
    before.raw.close();

    const outcome = await createAdmin({
      dataRoot: root,
      username: "Mallory",
      password: "mal-password",
      ensureOnly: true,
    });

    expect(createOf(outcome)).toMatchObject({
      command: "ensure-admin",
      created: false,
      username: "Ada",
    });
    const after = createDb(dbFile());
    expect(after.listUsers()).toHaveLength(countBefore);
    after.raw.close();
  });

  it("creates under `ensure-admin` when there is not one", async () => {
    const outcome = await createAdmin({
      dataRoot: root,
      username: "Ada",
      password: "ada-password",
      ensureOnly: true,
    });
    expect(createOf(outcome)).toMatchObject({ command: "ensure-admin", created: true });
  });

  it("applies the shared credential policy rather than one of its own", async () => {
    expect(codeOf(await createAdmin({ dataRoot: root, username: "  ", password: "long-enough" }))).toBe(
      "USERNAME_REQUIRED"
    );
    expect(codeOf(await createAdmin({ dataRoot: root, username: "Ada", password: "short" }))).toBe(
      "PASSWORD_TOO_SHORT"
    );
    expect(
      codeOf(await createAdmin({ dataRoot: root, username: "Ada", password: "" }))
    ).toBe("PASSWORD_REQUIRED");
  });

  it("refuses a schema it cannot read, without writing to it", async () => {
    unreadableDatabase();
    const outcome = await createAdmin({ dataRoot: root, username: "Ada", password: "ada-password" });

    expect(codeOf(outcome)).toBe("SCHEMA_UNREADABLE");
    // Still version 99, and still without the tables this build would have added.
    const db = new Database(dbFile());
    expect(db.pragma("user_version", { simple: true })).toBe(99);
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((t) => t.name);
    expect(tables).toEqual(["something"]);
    db.close();
  });

  it("lets exactly one of two simultaneous calls win", async () => {
    /*
     * Both calls hash — ~100ms of `scrypt`, which is an `await` — so the *check* cannot be the
     * thing that decides: by the time either looks, the other may already have written. The
     * loser must come out as `ADMIN_EXISTS` rather than as a second administrator nobody at
     * the machine chose.
     *
     * In one process this holds whether or not the write is a transaction, because
     * `better-sqlite3` is synchronous and nothing can interleave once it starts. The property
     * it is really guarding — two *processes* racing — is `cli.test.ts`'s, with two real
     * children. This one is the cheap half.
     */
    const [a, b] = await Promise.all([
      createAdmin({ dataRoot: root, username: "Ada", password: "ada-password" }),
      createAdmin({ dataRoot: root, username: "Mallory", password: "mal-password" }),
    ]);

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const loser = a.ok ? b : a;
    expect(codeOf(loser)).toBe("ADMIN_EXISTS");

    const db = createDb(dbFile());
    expect(db.listUsers()).toHaveLength(1);
    db.raw.close();
  });

  it("creates the account's directory tree, so the row is usable", async () => {
    createOf(await createAdmin({ dataRoot: root, username: "Ada", password: "ada-password" }));

    const layout = dataLayout(root);
    // The row and the tree are written separately — the transaction must not contain a
    // `mkdir` — so this is the assertion that the second half happened.
    expect(readdirNames(join(layout.usersRoot, "ada"))).toContain("workspaces");
  });
});

/** Directory names under a path, or an empty list when it is not there. */
function readdirNames(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

describe("the boot refusal", () => {
  it("is satisfied by a buildServer root with no administrator, but the listener is not", async () => {
    /*
     * The property the whole design rests on, and worth pinning on its own: `buildServer`
     * must stay usable without an administrator — the test harness is exactly such a caller,
     * and so is anything that embeds the app — while `main()` refuses to listen. Building
     * the server and serving the server are deliberately two different gates.
     */
    const bare = await startBareServer();
    try {
      expect(bare.server.db.hasSuperadmin()).toBe(false);
      expect(() => assertHasAdministrator(bare.server.db)).toThrow(NoAdministratorError);

      // The login route is still there: this is what a bypassed boot rule is answered with,
      // rather than a 401 that reads as a wrong password.
      const login = await bare.server.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "Ada", password: "ada-password" },
      });
      expect(login.statusCode).toBe(409);
    } finally {
      await bare.cleanup();
    }
  });

  it("passes once an administrator exists", async () => {
    await createAdmin({ dataRoot: root, username: "Ada", password: "ada-password" });
    const db = createDb(dbFile());
    expect(() => assertHasAdministrator(db)).not.toThrow();
    db.raw.close();
  });

  it("names the panel when it launched the process, and the CLI otherwise", () => {
    // Two readers of the same refusal: the one with the button three centimetres away, and the
    // one with a terminal. Telling either about the other's remedy is a sentence the reader has
    // to translate first.
    //
    // The flag is a *flag* — the env var used to carry a launch-scoped secret guarding a
    // recovery route, and it only ever decided which of these two sentences to print.
    const previous = process.env[PANEL_LAUNCH_ENV];
    try {
      delete process.env[PANEL_LAUNCH_ENV];
      expect(noAdministratorMessage()).toContain("cli create-admin");
      process.env[PANEL_LAUNCH_ENV] = "1";
      expect(noAdministratorMessage()).toContain("control panel");
    } finally {
      if (previous === undefined) delete process.env[PANEL_LAUNCH_ENV];
      else process.env[PANEL_LAUNCH_ENV] = previous;
    }
  });
});

/**
 * `reset-admin`: the way back in for a forgotten password.
 *
 * The panel used to reach this through an HTTP route guarded by a per-launch secret. It is a
 * CLI command now, and the reason is the one thing that test could not assert: it has to work
 * **with the server stopped**, because a forgotten password is often found in the same moment
 * as something else being wrong. What is pinned here is that it is a real write, that it signs
 * the account out, and that it refuses everything it should.
 */
describe("reset-admin", () => {
  it("replaces the superadmin's password, and only a hash is kept", async () => {
    await createAdmin({ dataRoot: root, username: "Ada", password: "the-old-one" });

    const value = resetOf(await resetAdmin({ dataRoot: root }));

    expect(value.username).toBe("Ada");
    const generated = value.password;
    expect(generated).not.toBe("the-old-one");
    expect(generated!.length).toBeGreaterThanOrEqual(12);

    // The new one verifies and the old one does not — read straight out of the file, because
    // the point is what was written and not what a route would say about it.
    const db = new Database(dbFile(), { readonly: true });
    try {
      const row = db.prepare("SELECT password_hash AS h FROM users WHERE username = 'Ada'").get() as {
        h: string;
      };
      expect(row.h).not.toContain(generated);
      expect(await verifyPassword(generated!, row.h)).toBe(true);
      expect(await verifyPassword("the-old-one", row.h)).toBe(false);
    } finally {
      db.close();
    }
  });

  it("sets the password the operator chose and does not hand it back", async () => {
    // The panel's path: the person at the machine is the superadmin, so they choose the new
    // password rather than receiving a generated one. It is not echoed on the result.
    await createAdmin({ dataRoot: root, username: "Ada", password: "the-old-one" });

    const outcome = await resetAdmin({ dataRoot: root, password: "the-new-one" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("expected success");
    expect(outcome.value).toMatchObject({ command: "reset-admin", username: "Ada" });
    expect("password" in outcome.value).toBe(false);

    const db = new Database(dbFile(), { readonly: true });
    try {
      const row = db.prepare("SELECT password_hash AS h FROM users WHERE username = 'Ada'").get() as {
        h: string;
      };
      expect(row.h).not.toContain("the-new-one");
      expect(await verifyPassword("the-new-one", row.h)).toBe(true);
      expect(await verifyPassword("the-old-one", row.h)).toBe(false);
    } finally {
      db.close();
    }
  });

  it("refuses a chosen password the shared policy rejects", async () => {
    await createAdmin({ dataRoot: root, username: "Ada", password: "the-old-one" });

    const outcome = await resetAdmin({ dataRoot: root, password: "x" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.body.error.code).toBe("PASSWORD_TOO_SHORT");
    // The old credential is untouched.
    const db = new Database(dbFile(), { readonly: true });
    try {
      const row = db.prepare("SELECT password_hash AS h FROM users WHERE username = 'Ada'").get() as {
        h: string;
      };
      expect(await verifyPassword("the-old-one", row.h)).toBe(true);
    } finally {
      db.close();
    }
  });

  it("leaves `mustChangePassword` clear", async () => {
    // Whoever runs this is holding the machine, and the value they are about to use is one they
    // just generated for themselves. A screen demanding they replace it would be a step with
    // nothing behind it.
    await createAdmin({
      dataRoot: root,
      username: "Ada",
      password: "the-old-one",
    });
    await resetAdmin({ dataRoot: root });

    const db = new Database(dbFile(), { readonly: true });
    try {
      const row = db
        .prepare("SELECT must_change_password AS m FROM users WHERE username = 'Ada'")
        .get() as { m: number };
      expect(row.m).toBe(0);
    } finally {
      db.close();
    }
  });

  it("ends every session the account holds, which is half of what a reset is", async () => {
    // A forgotten password that is replaced while the old session is still live has not really
    // been replaced.
    //
    // Booted on the *same* root the CLI wrote to, because the claim is about a running server
    // seeing a write another process made — which is exactly the shape of the panel using this
    // while the server is up.
    await createAdmin({ dataRoot: root, username: "Ada", password: "the-old-one" });
    const env = await startBareServer({ dataRoot: root });
    try {
      const signedIn = await env.server.app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "Ada", password: "the-old-one" },
      });
      const { tokens } = signedIn.json<{ tokens: { accessToken: string } }>();
      const bearer = { authorization: `Bearer ${tokens.accessToken}` };
      expect((await env.server.app.inject({ method: "GET", url: "/api/auth/me", headers: bearer })).statusCode).toBe(200);

      const value = resetOf(await resetAdmin({ dataRoot: root }));

      // The token that worked a moment ago does not, which is the whole claim.
      expect((await env.server.app.inject({ method: "GET", url: "/api/auth/me", headers: bearer })).statusCode).toBe(401);
      expect(
        (
          await env.server.app.inject({
            method: "POST",
            url: "/api/auth/login",
            payload: { username: "Ada", password: value.password! },
          })
        ).statusCode
      ).toBe(200);
    } finally {
      await env.cleanup();
    }
  });

  it("works on a data root with no database at all, by refusing", async () => {
    // Not "creates one": a question about a folder nobody has set up must not be the thing that
    // puts a database in it.
    await expect(resetAdmin({ dataRoot: join(root, "nothing-here") })).resolves.toMatchObject({
      ok: false,
    });
    expect(codeOf(await resetAdmin({ dataRoot: join(root, "nothing-here") }))).toBe("ADMIN_NOT_FOUND");
  });

  it("refuses when there is no administrator to reset", async () => {
    freshDatabase();
    expect(codeOf(await resetAdmin({ dataRoot: root }))).toBe("ADMIN_NOT_FOUND");
  });

  it("refuses an ordinary account, and refuses a name it cannot find", async () => {
    // The panel recovers the credential that can undo the installation. An ordinary account's
    // password is the web console's business, and this command is not a way round that.
    const db = createDb(dbFile());
    try {
      const { createAccountRow } = await import("../src/auth.js");
      const { hashPassword } = await import("../src/auth.js");
      const { dataLayout: layout } = await import("../src/paths.js");
      createAccountRow(db, layout(root), {
        username: "Bob",
        roles: ["user"],
        passwordHash: await hashPassword("bobs-password"),
        mustChangePassword: false,
      });
    } finally {
      db.raw.close();
    }

    expect(codeOf(await resetAdmin({ dataRoot: root, username: "Bob" }))).toBe("ADMIN_NOT_FOUND");
    expect(codeOf(await resetAdmin({ dataRoot: root, username: "Nobody" }))).toBe("ADMIN_NOT_FOUND");
  });

  it("resets the administrator named, case-insensitively", async () => {
    await createAdmin({ dataRoot: root, username: "Ada", password: "the-old-one" });
    expect(resetOf(await resetAdmin({ dataRoot: root, username: "ada" })).username).toBe("Ada");
  });

  it("refuses a database this build cannot read, rather than writing into it", async () => {
    // A write to a file whose schema is unknown is a write nobody can undo. The read-only half
    // of this module refuses these; the write half has to as well.
    unreadableDatabase();
    expect(codeOf(await resetAdmin({ dataRoot: root }))).toBe("SCHEMA_UNREADABLE");
  });
});

/**
 * The two migration commands, and what the read-only `status` says about a database that needs
 * walking.
 *
 * The **walk** is `migrations.test.ts`'s subject and the snapshot is `backup.test.ts`'s. What is
 * tested here is the command line's half: that `migrate-status` answers a question without writing,
 * that `migrate-up` walks and reports what it did, and that `status` — which the panel runs before
 * the user presses Start — says when a data root is about to be upgraded.
 */
describe("migrate-status", () => {
  it("reports a fresh install as current, with nothing to do", async () => {
    // `create-admin` opens the database, which applies the current schema, so the answer here is
    // the ordinary one: nothing pending, and no way to be wrong about it.
    await createAdmin({ dataRoot: root, username: "Ada", password: "ada-password" });
    const value = migrateStatusOf(migrationStatus(root));

    expect(value.found).toBe(SCHEMA_VERSION);
    expect(value.needed).toBe(SCHEMA_VERSION);
    expect(value.pending).toEqual([]);
    expect(value.applied).toEqual([]);
    expect(value.blocker).toBeNull();
    expect(value.walkable).toBe(true);
  });

  it("says there is no database rather than inventing a version for one", () => {
    // A data root nobody has set up. Answering `0` here would be a version the file does not
    // have, and the caller cannot tell that apart from an empty database.
    expect(codeOf(migrationStatus(root))).toBe("DATA_DIR_INVALID");
  });

  it("reports a refused database as unreadable, keeping its version", () => {
    // A file from a newer build: `create-admin` refuses it, and this must agree rather than
    // claim there is nothing to do.
    freshDatabase();
    const db = new Database(dbFile());
    db.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    db.close();

    const value = migrateStatusOf(migrationStatus(root));
    expect(value.found).toBe(SCHEMA_VERSION + 1);
    expect(value.walkable).toBe(false);
    expect(value.blocker).toEqual({ found: SCHEMA_VERSION + 1, needed: SCHEMA_VERSION });
    expect(value.pending).toEqual([]);
  });

  it("does not touch the file it is only asked about", () => {
    // The read-only guarantee, and the sharpest edge of it: `status` and `migrate-status` must
    // never be the thing that changes a database. The version is read before and after.
    freshDatabase();
    const db = new Database(dbFile());
    db.exec("CREATE TABLE t (a TEXT)");
    db.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    db.close();

    migrationStatus(root);

    const after = new Database(dbFile(), { readonly: true });
    expect(after.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION + 1);
    expect(after.prepare("SELECT name FROM sqlite_master WHERE name = 't'").get()).toBeDefined();
    after.close();
  });
});

describe("migrate-up", () => {
  it("says there is nothing to do for a current database", async () => {
    await createAdmin({ dataRoot: root, username: "Ada", password: "ada-password" });
    const value = migrateUpOf(migrateUp(root));

    expect(value.from).toBe(SCHEMA_VERSION);
    expect(value.to).toBe(SCHEMA_VERSION);
    expect(value.applied).toEqual([]);
    // And it took no snapshot, because there was nothing to walk — the cost only exists where the
    // risk does.
    expect(value.backup).toBeNull();
  });

  it("refuses a database from a newer build rather than reporting success", () => {
    // The one thing it must not do is claim a database is fine when this build cannot read it.
    freshDatabase();
    const db = new Database(dbFile());
    db.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    db.close();

    expect(codeOf(migrateUp(root))).toBe("SCHEMA_UNREADABLE");
  });

  it("reports the data root as unset up rather than creating one to migrate", () => {
    expect(codeOf(migrateUp(root))).toBe("DATA_DIR_INVALID");
  });
});

describe("status reports the schema", () => {
  it("says nothing when the database is current", async () => {
    await createAdmin({ dataRoot: root, username: "Ada", password: "ada-password" });
    const value = statusOf(adminStatus(root));

    expect(value.schema).toEqual({ found: SCHEMA_VERSION, needed: SCHEMA_VERSION, pending: 0 });
  });

  it("reports no schema at all when there is no database", () => {
    // Nothing to describe: the file is about to be created, so pretending it is at v0 would be a
    // version nothing has.
    expect(statusOf(adminStatus(root)).schema).toBeNull();
  });

  it("refuses a database it cannot carry, rather than describing it", () => {
    /*
     * The refusal *is* the answer for a file this build cannot read, and it carries the two
     * versions so the panel can say which. That is why `AdminStatusResult.schema` has no
     * `walkable`: every file without a path forward is turned away here, so a successful status
     * reply could only ever report `true`.
     */
    freshDatabase();
    const db = new Database(dbFile());
    db.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    db.close();

    const outcome = adminStatus(root);
    expect(codeOf(outcome)).toBe("SCHEMA_UNREADABLE");
    if (outcome.ok) throw new Error("expected a refusal");
    expect(outcome.body.error.params).toMatchObject({
      found: SCHEMA_VERSION + 1,
      needed: SCHEMA_VERSION,
    });
  });
});

describe("the commands agree with the server about a tampered history", () => {
  /*
   * The gap a live run found: `migrate-status` and `status` both reported a database as healthy
   * while `migrate-up` refused it, because a **checksum** mismatch is not a version problem and
   * neither command looked. The server refuses such a file at boot (`runMigrations` verifies
   * before it walks), so a status that says "nothing to migrate" sends an operator to look at the
   * wrong thing — which is the failure this command exists to prevent.
   *
   * The file here has the *right* version and a history row that does not match any step, which is
   * what editing a shipped migration produces.
   */
  function databaseWithAForeignHistoryRow(): void {
    freshDatabase();
    const db = new Database(dbFile());
    db.exec("CREATE TABLE t (a TEXT)");
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
    db.prepare(
      `INSERT INTO schema_migrations (version, id, checksum, applied_at, duration_ms)
       VALUES (?, 'a-step-that-is-gone', 'deadbeef', '2026-01-01T00:00:00.000Z', 1)`
    ).run(SCHEMA_VERSION);
    db.close();
  }

  it("migrate-status reports it rather than saying nothing to migrate", () => {
    databaseWithAForeignHistoryRow();
    const value = migrateStatusOf(migrationStatus(root));

    expect(value.found).toBe(SCHEMA_VERSION);
    expect(value.walkable).toBe(false);
    expect(value.pending).toEqual([]);
    expect(value.historyProblem).toMatch(/no longer has/);
  });

  it("status refuses it with the code the server would fail on", () => {
    databaseWithAForeignHistoryRow();
    const outcome = adminStatus(root);

    // `MIGRATION_FAILED`, not `SCHEMA_UNREADABLE`: the version is fine and the *history* is not,
    // and an operator who is told the wrong one looks in the wrong place.
    expect(codeOf(outcome)).toBe("MIGRATION_FAILED");
  });

  it("migrate-up refuses it too, on the same check", () => {
    databaseWithAForeignHistoryRow();
    expect(codeOf(migrateUp(root))).toBe("MIGRATION_FAILED");
  });

  it("leaves a healthy database alone", async () => {
    // The other direction, so the check is not simply always failing.
    await createAdmin({ dataRoot: root, username: "Ada", password: "ada-password" });
    const value = migrateStatusOf(migrationStatus(root));
    expect(value.historyProblem).toBeNull();
    expect(value.walkable).toBe(true);
  });
});
