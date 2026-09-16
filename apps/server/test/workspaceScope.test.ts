import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SESSION_TITLE, createDb, type AppDb } from "../src/db.js";
import {
  EMPTY_SCOPE,
  normalizeWorkspaceScope,
  resolveWorkspaceScope,
  scopeIdsJson,
  scopeIsEmpty,
  type ResolvedScope,
} from "../src/workspaceScope.js";

/**
 * The `@` grant's resolver — the one reader of `session.settings.workspaceScope`, and therefore
 * the only place the answer to "what may this conversation read across" is decided.
 *
 * Two claims are being pinned and they are different ones. The first is that **nothing widens by
 * default**: an absent, null, empty or nonsensical value leaves a conversation exactly as it
 * was before the feature existed. The second is that a *stored* id is not trusted — the grant is
 * re-derived from the account's live workspaces on every turn, so a row that names a workspace
 * somebody else owns, or one that has been deleted, resolves to nothing rather than to access.
 */

let root: string;
let db: AppDb;

const OWNER = "u1";
const OTHER = "u2";
const SESSION = "s1";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gl-scope-"));
  db = createDb(join(root, "test.sqlite"));
  db.createUser({ id: OWNER, username: "tester", slug: "tester" });
  db.createUser({ id: OTHER, username: "other", slug: "other" });
  for (const [id, name, slug] of [
    ["w1", "Home", "home"],
    ["w2", "Other", "other-ws"],
    ["w3", "Third", "third"],
  ] as const) {
    db.createWorkspace({
      userId: OWNER,
      id,
      name,
      slug,
      dirPath: join(root, slug),
    });
  }
  // Somebody else's workspace, which no grant may ever reach.
  db.createWorkspace({
    userId: OTHER,
    id: "foreign",
    name: "Not Yours",
    slug: "not-yours",
    dirPath: join(root, "not-yours"),
  });
  db.createSession({
    id: SESSION,
    workspaceId: "w1",
    copilotId: null,
    copilotName: "",
    systemPrompt: "",
    allTools: true,
    tools: [],
    title: DEFAULT_SESSION_TITLE,
  });
});

afterEach(() => {
  try {
    db.raw.close();
  } catch {
    /* already closed */
  }
  rmSync(root, { recursive: true, force: true });
});

/** The session as the resolver sees it, with a grant stored on it. */
function sessionWith(workspaceScope: unknown) {
  db.updateSessionForUser(SESSION, OWNER, {
    settings: { workspaceScope: workspaceScope as never },
  });
  return db.getSessionForUser(SESSION, OWNER)!.session;
}

const idsOf = (scope: ResolvedScope): string[] => scope.workspaces.map((w) => w.id);

describe("resolveWorkspaceScope", () => {
  it("resolves to nothing when the conversation has no grant", () => {
    const session = db.getSessionForUser(SESSION, OWNER)!.session;
    expect(resolveWorkspaceScope(db, OWNER, session)).toBe(EMPTY_SCOPE);
  });

  it("resolves to nothing for an empty or nonsensical value", () => {
    // Every one of these is a value a client could send or a database could hold, and each must
    // read as "no grant" rather than as an error a turn would fail on.
    for (const value of [null, {}, { all: false }, { all: false, workspaceIds: [] }, "all", 1]) {
      const scope = resolveWorkspaceScope(db, OWNER, sessionWith(value));
      expect(scopeIsEmpty(scope)).toBe(true);
      expect(scope.workspaces).toEqual([]);
    }
  });

  it("resolves the named workspaces it can find", () => {
    const scope = resolveWorkspaceScope(db, OWNER, sessionWith({ workspaceIds: ["w2", "w3"] }));
    expect(scope.all).toBe(false);
    expect(idsOf(scope)).toEqual(["w2", "w3"]);
    // The path `ila_explore` reads through, carried on the grant rather than derived per call.
    expect(scope.workspaces[0]!.workdirPath).toBe(join(root, "other-ws", "workdir"));
  });

  it("drops the conversation's own workspace, because it is readable anyway", () => {
    // `@`-ing the workspace you are in grants nothing, so the grant must not carry it — a
    // duplicate would list it twice in the prompt and resolve a path it already has.
    const scope = resolveWorkspaceScope(db, OWNER, sessionWith({ workspaceIds: ["w1", "w2"] }));
    expect(idsOf(scope)).toEqual(["w2"]);
  });

  it("drops a workspace the account does not own", () => {
    // The grant is re-derived, never trusted: an id written by a client resolves through
    // `getWorkspaceForUser`, which puts the owner in its `WHERE`. Another account's workspace
    // is simply not found, the same answer as one that does not exist.
    const scope = resolveWorkspaceScope(db, OWNER, sessionWith({ workspaceIds: ["foreign"] }));
    expect(scopeIsEmpty(scope)).toBe(true);
  });

  it("drops a workspace that has been deleted since the grant was made", () => {
    // A stale id must narrow the grant rather than fail a turn — the workspace can go between
    // the chip being drawn and the next message being sent.
    const scope = resolveWorkspaceScope(
      db,
      OWNER,
      sessionWith({ workspaceIds: ["w2", "w3"] })
    );
    expect(idsOf(scope)).toEqual(["w2", "w3"]);

    db.softDeleteWorkspaceForUser("w3", OWNER);
    const after = resolveWorkspaceScope(db, OWNER, sessionWith({ workspaceIds: ["w2", "w3"] }));
    expect(idsOf(after)).toEqual(["w2"]);
  });

  it("resolves `all` to every workspace the account holds", () => {
    const scope = resolveWorkspaceScope(db, OWNER, sessionWith({ all: true }));
    expect(scope.all).toBe(true);
    // The conversation's own workspace is still excluded from the list; `all` is what says
    // "everything", and the readable-anyway workspace needs no second mention.
    expect(idsOf(scope).sort()).toEqual(["w2", "w3"]);
  });

  it("covers a workspace created after the grant was made", () => {
    // The whole reason `all` is a flag rather than a snapshot of ids: the user asked for
    // "everything I have", not "everything I had on Tuesday".
    const session = sessionWith({ all: true });
    expect(idsOf(resolveWorkspaceScope(db, OWNER, session))).toEqual(["w2", "w3"]);

    db.createWorkspace({
      userId: OWNER,
      id: "w4",
      name: "Later",
      slug: "later",
      dirPath: join(root, "later"),
    });
    expect(idsOf(resolveWorkspaceScope(db, OWNER, session)).sort()).toEqual(["w2", "w3", "w4"]);
  });
});

describe("scopeIdsJson", () => {
  it("is always valid JSON, including for the empty grant", () => {
    // The statement reads these with `json_each`, and `json_each('')` raises — which would be a
    // 500 on every turn in every conversation. `[]` is what an empty grant must bind.
    expect(scopeIdsJson(EMPTY_SCOPE)).toBe("[]");
    expect(JSON.parse(scopeIdsJson(EMPTY_SCOPE))).toEqual([]);

    const scope = resolveWorkspaceScope(db, OWNER, sessionWith({ workspaceIds: ["w2"] }));
    expect(JSON.parse(scopeIdsJson(scope))).toEqual(["w2"]);
  });
});

describe("normalizeWorkspaceScope", () => {
  it("reads an absent or null value as no grant", () => {
    expect(normalizeWorkspaceScope(undefined)).toEqual({ ok: true, value: null });
    expect(normalizeWorkspaceScope(null)).toEqual({ ok: true, value: null });
  });

  it("refuses a value that is not an object", () => {
    for (const raw of ["all", 1, true, []]) {
      expect(normalizeWorkspaceScope(raw).ok).toBe(false);
    }
  });

  it("refuses a non-boolean `all` rather than coercing it", () => {
    // `"false"` is truthy, so a coerced value would store a grant the caller never asked for —
    // and this is a grant. Same discipline as `normalizeRoles` refusing an unknown role.
    expect(normalizeWorkspaceScope({ all: "true" }).ok).toBe(false);
    expect(normalizeWorkspaceScope({ all: "false" }).ok).toBe(false);
    expect(normalizeWorkspaceScope({ all: 1 }).ok).toBe(false);
  });

  it("refuses ids that are not non-empty strings", () => {
    expect(normalizeWorkspaceScope({ workspaceIds: "w2" }).ok).toBe(false);
    expect(normalizeWorkspaceScope({ workspaceIds: [""] }).ok).toBe(false);
    expect(normalizeWorkspaceScope({ workspaceIds: [7] }).ok).toBe(false);
    expect(normalizeWorkspaceScope({ workspaceIds: ["x".repeat(65)] }).ok).toBe(false);
  });

  it("bounds the list, so a crafted body cannot be a per-turn cost forever", () => {
    const many = Array.from({ length: 201 }, (_, i) => `w-${i}`);
    expect(normalizeWorkspaceScope({ workspaceIds: many }).ok).toBe(false);
  });

  it("drops the list when `all` is set, rather than hiding it underneath", () => {
    // `all` covers the list, so keeping it would be a set of names nobody can see — and it
    // would survive an edit that removed the flag's meaning.
    expect(normalizeWorkspaceScope({ all: true, workspaceIds: ["w2"] })).toEqual({
      ok: true,
      value: { all: true },
    });
  });

  it("stores no grant as null, so 'nothing' has one representation", () => {
    expect(normalizeWorkspaceScope({ all: false })).toEqual({ ok: true, value: null });
    expect(normalizeWorkspaceScope({ all: false, workspaceIds: [] })).toEqual({
      ok: true,
      value: null,
    });
  });

  it("de-duplicates ids", () => {
    expect(normalizeWorkspaceScope({ workspaceIds: ["w2", "w2", "w3"] })).toEqual({
      ok: true,
      value: { all: false, workspaceIds: ["w2", "w3"] },
    });
  });
});
