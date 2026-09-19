import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALL_TOOL_NAMES, WIDGET_IDS } from "@ilearnassist/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAdmin } from "../src/adminCli.js";
import builtinCatalog from "../src/builtin.json";
import { createDb, SETTING_BUILTIN_COPILOTS_SEEDED, type AppDb } from "../src/db.js";
import { dataLayout } from "../src/paths.js";
import { startBareServer } from "./helpers/tempEnv.js";

/**
 * The assistants a new installation ships with.
 *
 * Two subjects, and the second is the one with teeth: what `builtin.json` *contains* (which is
 * a question about a file, answerable without a database), and **when it is allowed to become
 * rows**. The timing is the whole feature — a built-in assistant has to appear for the person
 * who just installed the app, be owned by somebody, and then never come back after its owner
 * deletes it.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ila-builtin-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const dbFile = (): string => dataLayout(root).sqliteFile;

/** A root with a schema and no accounts — what a first boot leaves. */
function freshDatabase(): void {
  createDb(dbFile()).raw.close();
}

function open(): AppDb {
  return createDb(dbFile());
}

const BUILT_IN_ID = "builtin-guided-learning";
const OWNER = "Ada";
const PASSWORD = "ada-password";

/** Create the first administrator through the real CLI path, then hand back an open handle. */
async function bootstrap(): Promise<AppDb> {
  const outcome = await createAdmin({ dataRoot: root, username: OWNER, password: PASSWORD });
  expect(outcome.ok, JSON.stringify(outcome.ok ? {} : outcome.body)).toBe(true);
  return open();
}

const ownerIdOf = (db: AppDb): string => {
  const user = db.findUserByUsername(OWNER);
  if (!user) throw new Error("the administrator was not created");
  return user.id;
};

describe("builtin.json", () => {
  const entries = builtinCatalog.copilots;

  it("ships at least one assistant", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it("names only widgets this build knows", () => {
    // Filtered at write time rather than refused, because a boot that dies over a bundled file
    // is a worse failure than a missing tab — so *this* is where a bad id has to be caught. An
    // id `WIDGET_IDS` does not have installs nothing while looking installed.
    for (const entry of entries) {
      for (const id of entry.widgets) {
        expect(WIDGET_IDS as readonly string[], `${entry.id} names ${id}`).toContain(id);
      }
    }
  });

  it("installs the seven study widgets, and no others", () => {
    // Stated as an equality rather than a subset so that dropping one from the file is a
    // failure: the assistant's own prompt walks the learner through a plan, quizzes them and
    // then reflects, and each of those is a panel. A silently missing widget is a tutor that
    // asks you to answer a question it never renders.
    expect([...entries[0]!.widgets].sort()).toEqual(
      ["diagram", "insight", "notes", "plan", "quiz", "sources", "thread"].sort()
    );
  });

  it("makes every entry public", () => {
    // Ownership is the administrator's, and the read predicate is
    // `user_id = ? OR visibility = 'public'`. A private built-in is invisible to every other
    // account: present, correct, and useless to the people it was shipped for.
    for (const entry of entries) {
      expect(entry.visibility, entry.id).toBe("public");
    }
  });

  it("gives every entry what a copilots row needs", () => {
    for (const entry of entries) {
      expect(entry.id, "id").toMatch(/^[a-z0-9-]+$/);
      expect(entry.name.length, `${entry.id} name`).toBeGreaterThan(0);
      expect(entry.description.length, `${entry.id} description`).toBeGreaterThan(0);
      // The prompt is the reason the entry exists; an empty one would still create a row.
      expect(entry.systemPrompt.length, `${entry.id} systemPrompt`).toBeGreaterThan(200);
      expect(entry.allTools, `${entry.id} allTools`).toBe(true);
    }
  });

  it("names only tools that exist", () => {
    /*
     * The prompt names the tools it expects — `ila_quiz` for the check questions, `ila_read_plan`
     * to read the plan back, `ask_user` to put a choice to the learner. A prompt that names a
     * tool this build does not have is worse than one that names none: the model tries to call
     * it, the call fails, and the failure reads as the app being broken rather than the prompt
     * carrying a stale name. The check is on the identifier shape, so prose about teaching is not
     * scanned, and it is against `ALL_TOOL_NAMES` — the same list the wire schema test uses.
     */
    for (const entry of entries) {
      const named = entry.systemPrompt.match(/\b(?:ila_[a-z_]+|ask_user|web_search|web_fetch)\b/g) ?? [];
      expect(named.length, `${entry.id} names no tools at all`).toBeGreaterThan(0);
      for (const name of new Set(named)) {
        expect(ALL_TOOL_NAMES as readonly string[], `${entry.id} names ${name}`).toContain(name);
      }
    }
  });

  it("uses ids a generated one can never collide with", () => {
    // `newId()` is a UUID, so the `builtin-` prefix makes "this row is ours" readable by eye —
    // and it is what a future migration would key on to tell a shipped assistant from a user's.
    for (const entry of entries) {
      expect(entry.id.startsWith("builtin-"), entry.id).toBe(true);
    }
  });
});

describe("seeding the built-ins", () => {
  it("creates them when the first administrator is created", async () => {
    freshDatabase();
    const db = await bootstrap();
    try {
      const copilots = db.listCopilotsForUser(ownerIdOf(db));
      expect(copilots.map((c) => c.id)).toEqual([BUILT_IN_ID]);
      expect(copilots[0]!.visibility).toBe("public");
      expect(copilots[0]!.ownerName).toBe(OWNER);
    } finally {
      db.raw.close();
    }
  });

  it("writes the prompt from the catalog, unchanged", async () => {
    freshDatabase();
    const db = await bootstrap();
    try {
      const stored = db.listCopilotsForUser(ownerIdOf(db))[0]!;
      // Byte for byte, and the awkward part is deliberate: this text is a person's own writing
      // about how they want to be taught. A JSON reformat or a stray trim would edit it
      // silently, and the first thing anyone would notice is a tutor behaving differently.
      expect(stored.systemPrompt).toBe(builtinCatalog.copilots[0]!.systemPrompt);
      expect(stored.widgets).toEqual(builtinCatalog.copilots[0]!.widgets);
    } finally {
      db.raw.close();
    }
  });

  it("is readable — and usable — by an account that does not own it", async () => {
    freshDatabase();
    const db = await bootstrap();
    try {
      // The claim "public" is worth testing against a *different* account, because the
      // owner-scoped read would return it either way.
      const other = "Bob";
      expect(db.createUser({
        id: "u-bob",
        username: other,
        slug: "bob",
        roles: ["user"],
        passwordHash: "x",
        mustChangePassword: false,
      })).toBeDefined();
      const visible = db.listCopilotsForUser("u-bob");
      expect(visible.map((c) => c.id)).toContain(BUILT_IN_ID);
      expect(db.getCopilotForUser(BUILT_IN_ID, "u-bob")).toBeDefined();
      // Use, not change: reaching it through the owned read is how an edit would start, and it
      // must not answer for somebody else's row.
      expect(db.getOwnedCopilot(BUILT_IN_ID, "u-bob")).toBeUndefined();
    } finally {
      db.raw.close();
    }
  });

  it("does not seed a second time when the administrator already exists", async () => {
    freshDatabase();
    const first = await bootstrap();
    first.raw.close();

    // The same command again: refused, and nothing written on the way to being refused. What
    // this pins is that the `ADMIN_EXISTS` early return happens *before* the seeding, rather
    // than seeding and then refusing — a second helper row would be invisible here and obvious
    // to a user.
    const again = await createAdmin({ dataRoot: root, username: OWNER, password: PASSWORD });
    expect(again.ok).toBe(false);

    const db = open();
    try {
      expect(db.listCopilotsForUser(ownerIdOf(db))).toHaveLength(1);
    } finally {
      db.raw.close();
    }
  });

  it("does not recreate a purged assistant once it has seeded", async () => {
    /*
     * The marker's whole job, and the only test that holds it up.
     *
     * The other seeding tests all pass with the marker ignored, because something else covers
     * each of them: the second `createAdmin` returns at `ADMIN_EXISTS`, and a *soft-deleted*
     * built-in is caught by the existence check. This is the case neither of those reaches —
     * the rows are gone, so an empty table is the only signal, and reading it as "never seeded"
     * is how a built-in somebody removed comes back on the next boot. The marker stays set
     * here; that is the whole difference between this test and the upgrade-path one below.
     */
    freshDatabase();
    const db = await bootstrap();
    const ownerId = ownerIdOf(db);
    db.raw.prepare("DELETE FROM copilots").run();
    expect(db.getSetting(SETTING_BUILTIN_COPILOTS_SEEDED)).toBe("1");
    db.raw.close();

    const restarted = await startBareServer({ dataRoot: root });
    try {
      expect(restarted.server.db.listCopilotsForUser(ownerId)).toEqual([]);
    } finally {
      await restarted.cleanup();
    }
  });

  it("leaves a deleted built-in deleted across a restart", async () => {
    freshDatabase();
    const db = await bootstrap();
    const ownerId = ownerIdOf(db);
    expect(db.softDeleteCopilotForUser(BUILT_IN_ID, ownerId)).toBe(true);
    db.raw.close();

    // The question a restart asks. "Is the table empty" would answer no and put it back the
    // first time somebody purged the rows; the marker is what makes the deletion stick.
    const restarted = await startBareServer({ dataRoot: root });
    try {
      expect(restarted.server.db.listCopilotsForUser(ownerId)).toEqual([]);
    } finally {
      await restarted.cleanup();
    }
  });

  it("seeds an installation that predates the catalog, at boot", async () => {
    // A checkout somebody has been using: an administrator exists, the assistants were never
    // written, and no marker was ever set. Simulated by removing both, which is exactly the
    // state such a root is in.
    freshDatabase();
    const db = await bootstrap();
    db.raw.prepare("DELETE FROM copilots").run();
    db.raw.prepare("DELETE FROM app_settings WHERE key = ?").run(SETTING_BUILTIN_COPILOTS_SEEDED);
    const ownerId = ownerIdOf(db);
    db.raw.close();

    const restarted = await startBareServer({ dataRoot: root });
    try {
      expect(restarted.server.db.listCopilotsForUser(ownerId).map((c) => c.id)).toEqual([
        BUILT_IN_ID,
      ]);
    } finally {
      await restarted.cleanup();
    }
  });

  it("writes nothing at boot when there is nobody to own one", async () => {
    // A Copilot's `user_id` is its owner, and `createCopilot` refuses a row without one. A boot
    // against an empty root must therefore write no assistant rather than one nobody owns —
    // which is also the state `assertHasAdministrator` refuses to listen in.
    freshDatabase();
    const bare = await startBareServer({ dataRoot: root });
    try {
      expect(bare.server.db.listCopilotsForUser("anyone")).toEqual([]);
      expect(bare.server.db.getSetting(SETTING_BUILTIN_COPILOTS_SEEDED)).toBeUndefined();
    } finally {
      await bare.cleanup();
    }
  });

  it("adopts an existing row instead of colliding with it", async () => {
    // The belt, not the braces: the marker normally prevents a second insert. This is the
    // database somebody assembled by hand — a marker that went missing while the row stayed.
    // Without the existence check the insert collides on the primary key and the boot dies.
    freshDatabase();
    const db = await bootstrap();
    const ownerId = ownerIdOf(db);
    db.raw.prepare("DELETE FROM app_settings WHERE key = ?").run(SETTING_BUILTIN_COPILOTS_SEEDED);
    db.raw.close();

    const restarted = await startBareServer({ dataRoot: root });
    try {
      expect(restarted.server.db.listCopilotsForUser(ownerId)).toHaveLength(1);
      expect(restarted.server.db.getSetting(SETTING_BUILTIN_COPILOTS_SEEDED)).toBe("1");
    } finally {
      await restarted.cleanup();
    }
  });
});
