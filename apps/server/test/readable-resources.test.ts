import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SESSION_TITLE, createDb } from "../src/db.js";
import type { AppDb } from "../src/db.js";
import { ensureWorkResource, registerFile, workspaceFilePath } from "../src/resources.js";
import { NO_SCOPE, resolveWorkspaceScope, scopeQuery } from "../src/workspaceScope.js";

/**
 * The read whitelist — what `read_document` will accept an id for.
 *
 * **The first case is the most important one in the file.** The statement has three arms so that
 * an `@` grant can widen it, and the thing that must not change is the *unscoped* answer:
 * `NO_SCOPE` has to return exactly the conversation's own material plus its workspace's. An arm
 * that also fired without a grant would be a conversation silently reading its sibling
 * conversations — a change nobody asked for, invisible in the UI.
 *
 * The three arms are three because a workspace holds two kinds of material and the grant makes
 * them reachable at two levels: its *own* references, and the ones its *conversations* hold. The
 * third arm cannot gain a `@workspaceId` clause — that is what would widen the ungranted case —
 * and the case below is what pins it.
 */

let root: string;
let db: AppDb;

const OWNER = "u1";
const OTHER = "u2";

/** The conversation asking, in workspace A. */
const SESSION = "s1";
const WS_A = "wA";
/** A conversation in workspace B, which is what a grant opens. */
const SESSION_B = "sB";
const WS_B = "wB";
/** A workspace nobody grants, so that "not opened" has something to mean. */
const SESSION_C = "sC";
const WS_C = "wC";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gl-readable-res-"));
  db = createDb(join(root, "test.sqlite"));
  db.createUser({ id: OWNER, username: "tester", slug: "tester" });
  db.createUser({ id: OTHER, username: "other", slug: "other" });

  for (const [id, name, slug] of [
    [WS_A, "A", "a"],
    [WS_B, "B", "b"],
    [WS_C, "C", "c"],
  ] as const) {
    db.createWorkspace({ userId: OWNER, id, name, slug, dirPath: join(root, slug) });
  }

  for (const [id, workspaceId] of [
    [SESSION, WS_A],
    [SESSION_B, WS_B],
    [SESSION_C, WS_C],
  ] as const) {
    db.createSession({
      id,
      workspaceId,
      copilotId: null,
      copilotName: "",
      systemPrompt: "",
      allTools: true,
      tools: [],
      title: DEFAULT_SESSION_TITLE,
    });
  }
});

afterEach(() => {
  try {
    db.raw.close();
  } catch {
    /* already closed */
  }
  rmSync(root, { recursive: true, force: true });
});

/**
 * A reference, as a real writer makes one: a file row, then the reference to it.
 *
 * The path has to be unique per call, because identity for a file *is* its path — two references
 * to "the same file" are two references to one row, and only the last of two identical paths
 * would be meaningful.
 */
function resource(
  id: string,
  opts: { userId?: string; owner?: { kind: "workspace" | "session"; id: string } } = {}
): void {
  const userId = opts.userId ?? OWNER;
  const owner = opts.owner ?? { kind: "session" as const, id: SESSION };
  const file = registerFile(db, {
    userId,
    path: workspaceFilePath("a", `notes/${id}.md`),
    sourceType: "agent_create",
    size: 1,
  });
  ensureWorkResource(db, {
    userId,
    owner,
    resourceType: "file",
    resourceId: file.id,
    title: id,
  });
}

/** The whitelist this conversation resolves to with `grant` stored on it. */
function readableUnder(grant: unknown): string[] {
  db.updateSessionForUser(SESSION, OWNER, { settings: { workspaceScope: grant as never } });
  const found = db.getSessionForUser(SESSION, OWNER)!;
  const scope = resolveWorkspaceScope(db, OWNER, found.session);
  return db
    .listReadableWorkResources(OWNER, SESSION, WS_A, scopeQuery(scope))
    .map((r) => r.title)
    .sort();
}

/** The unscoped answer, which is the one that must never move. */
function readableUnscoped(): string[] {
  return db
    .listReadableWorkResources(OWNER, SESSION, WS_A, NO_SCOPE)
    .map((r) => r.title)
    .sort();
}

describe("without a grant", () => {
  it("returns the conversation's own material and its workspace's, and nothing else", () => {
    resource("mine", { owner: { kind: "session", id: SESSION } });
    resource("workspace", { owner: { kind: "workspace", id: WS_A } });
    resource("sibling", { owner: { kind: "session", id: SESSION_B } });
    resource("other-workspace", { owner: { kind: "workspace", id: WS_B } });

    // A sibling conversation in the *same* workspace is not readable by name — the workspace's
    // material is, because every conversation in it can read the same tree.
    expect(readableUnscoped()).toEqual(["mine", "workspace"]);
  });

  it("drops a reference whose entity is gone", () => {
    resource("gone");
    const [row] = db.listReadableWorkResources(OWNER, SESSION, WS_A, NO_SCOPE);
    db.softDeleteFileForUser(row!.resourceId, OWNER);
    expect(readableUnscoped()).toEqual([]);
  });

  it("refuses another account's material", () => {
    resource("theirs", { userId: OTHER });
    expect(readableUnscoped()).toEqual([]);
  });
});

describe("with a grant", () => {
  it("opens a named workspace's material and its conversations' material", () => {
    // Two arms, deliberately: a workspace's own references, and what its conversations hold.
    // Either alone leaves half the material unreachable while looking like it works.
    resource("workspace-b", { owner: { kind: "workspace", id: WS_B } });
    resource("session-b", { owner: { kind: "session", id: SESSION_B } });
    resource("workspace-c", { owner: { kind: "workspace", id: WS_C } });

    expect(readableUnder({ workspaceIds: [WS_B, WS_B] })).toEqual(["session-b", "workspace-b"]);
  });

  it("opens everything under `all`, except the asking conversation's own workspace twice", () => {
    resource("mine", { owner: { kind: "session", id: SESSION } });
    resource("workspace-b", { owner: { kind: "workspace", id: WS_B } });
    resource("session-c", { owner: { kind: "session", id: SESSION_C } });

    expect(readableUnder({ all: true })).toEqual(["mine", "session-c", "workspace-b"]);
  });

  it("does not widen the ungranted answer to a sibling conversation", () => {
    /*
     * The arm-3 property, and the reason it has no `@workspaceId` clause: with an empty grant the
     * statement must return exactly what it returned before the grant existed. A sibling in the
     * *same* workspace stays unreadable by name.
     */
    resource("mine", { owner: { kind: "session", id: SESSION } });
    resource("sibling", { owner: { kind: "session", id: SESSION_B } });

    // Arm 1 — the conversation's own material — applies with or without a grant, so "mine" is
    // on both lists. What the grant must not do is add the sibling.
    expect(readableUnder({ workspaceIds: [] })).toEqual(["mine"]);
    expect(readableUnscoped()).toEqual(["mine"]);
  });

  it("ignores a granted id that is not this account's", () => {
    resource("mine", { owner: { kind: "session", id: SESSION } });
    resource("theirs", { owner: { kind: "workspace", id: WS_B }, userId: OTHER });
    // `resolveWorkspaceScope` drops the id it cannot resolve, so the grant narrows to nothing
    // rather than failing the turn — and arm 1 still answers for the conversation itself.
    expect(readableUnder({ workspaceIds: ["not-a-workspace"] })).toEqual(["mine"]);
  });
});
