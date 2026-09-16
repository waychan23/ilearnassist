import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SESSION_TITLE, createDb, type AppDb } from "../src/db.js";
import { NO_SCOPE, resolveWorkspaceScope, scopeQuery } from "../src/workspaceScope.js";

/**
 * The read whitelist — what `read_document` will accept an id for, and what `ila_query kind
 * "source"` lists.
 *
 * **The first case is the most important one in the file.** The statement grew two `UNION ALL`
 * arms so that an `@` grant can widen it, and the thing that must not change is the *unscoped*
 * answer: `NO_SCOPE` has to return byte-for-byte what it returned before the grant existed. An
 * arm that also fired without a grant would be a conversation silently reading its sibling
 * conversations — a change nobody asked for, invisible in the UI.
 *
 * The rest is the two arms themselves, which are two and not one for a reason worth keeping in
 * view: a workspace holds material only `workspace_sources` knows about (its uploads and its
 * kept pages) *and* material only `session_sources` knows about — anything a conversation
 * inside it merely `@`-referenced, since `registerFileSource` writes no link row at all. Either
 * arm alone leaves half the material unreachable while looking like it works.
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
  root = mkdtempSync(join(tmpdir(), "gl-readable-"));
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

/** A source, linked the way a real writer links it. */
function source(
  id: string,
  opts: {
    userId?: string;
    /** `both` is what the upload route writes; `session-only` is what an `@`-reference writes. */
    linkTo?: "both" | "session-only" | "workspace-only" | "none";
    session?: string;
    workspace?: string;
  } = {}
): void {
  const userId = opts.userId ?? OWNER;
  const session = opts.session ?? SESSION;
  const workspace = opts.workspace ?? WS_A;
  db.createSource({
    id,
    userId,
    ownerKind: "session",
    ownerId: session,
    origin: "session_attachment",
    storage: "upload",
    relPath: null,
    name: `${id}.pdf`,
    mimeType: "application/pdf",
    category: "document",
    size: 1,
    url: null,
    summary: null,
    sha256: null,
  });
  const how = opts.linkTo ?? "both";
  if (how === "both" || how === "session-only") db.linkSourceToSession(userId, session, id);
  if (how === "both" || how === "workspace-only") db.linkSourceToWorkspace(userId, workspace, id);
}

/**
 * The whitelist this conversation resolves to with `grant` stored on it.
 *
 * Going through `updateSessionForUser` and `resolveWorkspaceScope` rather than building the
 * `ScopeQuery` by hand is the point: that is the path a turn takes, so the test is about the
 * feature rather than about a parameter the test itself computed.
 */
function readableUnder(grant: unknown): string[] {
  db.updateSessionForUser(SESSION, OWNER, {
    settings: { workspaceScope: grant as never },
  });
  const found = db.getSessionForUser(SESSION, OWNER)!;
  const scope = resolveWorkspaceScope(db, OWNER, found.session);
  return db
    .listReadableSources(OWNER, SESSION, WS_A, scopeQuery(scope))
    .map((s) => s.id);
}

/** The unscoped answer, which is the one that must never move. */
function readableUnscoped(): string[] {
  return db.listReadableSources(OWNER, SESSION, WS_A, NO_SCOPE).map((s) => s.id);
}

describe("listReadableSources without a grant", () => {
  it("returns exactly the conversation's own sources and its workspace's", () => {
    // The regression pin. Material exists everywhere below, including in sibling
    // conversations, and none of it may appear here.
    source("own", { session: SESSION, workspace: WS_A, linkTo: "session-only" });
    source("shared", { session: SESSION, workspace: WS_A });
    source("sibling-in-a", { session: SESSION_B, workspace: WS_A });
    source("elsewhere", { session: SESSION_B, workspace: WS_B });
    source("referenced-in-b", { session: SESSION_B, workspace: WS_B, linkTo: "session-only" });
    source("unlinked", { linkTo: "none" });

    // `sibling-in-a` *is* readable — it is linked to the workspace this conversation is in, and
    // that widening predates this feature. `elsewhere` and `referenced-in-b` are not, and they
    // are what the second arm would have added if it fired without a grant.
    expect(new Set(readableUnscoped())).toEqual(new Set(["own", "shared", "sibling-in-a"]));
  });

  it("never returns another account's source", () => {
    source("theirs", { userId: OTHER, session: SESSION_B, workspace: WS_B });
    expect(readableUnscoped()).not.toContain("theirs");
  });

  it("does not change when a grant is stored as no grant at all", () => {
    source("own");
    expect(new Set(readableUnder(null))).toEqual(new Set(readableUnscoped()));
    expect(new Set(readableUnder({ all: false }))).toEqual(new Set(readableUnscoped()));
    expect(new Set(readableUnder({ workspaceIds: [] }))).toEqual(new Set(readableUnscoped()));
  });
});

describe("listReadableSources with a grant", () => {
  it("adds the granted workspace's own uploads and kept pages", () => {
    source("in-b", { session: SESSION_B, workspace: WS_B });
    source("in-c", { session: SESSION_C, workspace: WS_C });

    const ids = readableUnder({ workspaceIds: [WS_B] });
    expect(ids).toContain("in-b");
    // The workspace nobody opened stays out, which is the whole point of naming one.
    expect(ids).not.toContain("in-c");
  });

  it("adds what a conversation inside the granted workspace merely referenced", () => {
    // The arm one arm would have missed entirely: `registerFileSource` writes a `sources` row
    // and no link row, so a source a conversation inside B only pointed at lives in
    // `session_sources` alone — and without this arm, a message read out of B would name an id
    // that resolves to nothing.
    source("referenced-in-b", { session: SESSION_B, workspace: WS_B, linkTo: "session-only" });

    expect(readableUnscoped()).not.toContain("referenced-in-b");
    expect(readableUnder({ workspaceIds: [WS_B] })).toContain("referenced-in-b");
  });

  it("narrows again when the grant is removed", () => {
    source("in-b", { session: SESSION_B, workspace: WS_B });
    expect(readableUnder({ workspaceIds: [WS_B] })).toContain("in-b");
    expect(readableUnder(null)).not.toContain("in-b");
  });

  it("reaches every workspace under `all`", () => {
    source("in-b", { session: SESSION_B, workspace: WS_B });
    source("in-c", { session: SESSION_C, workspace: WS_C });

    const ids = readableUnder({ all: true });
    expect(ids).toContain("in-b");
    expect(ids).toContain("in-c");
  });

  it("drops a deleted workspace's material without dismantling anything", () => {
    source("in-b", { session: SESSION_B, workspace: WS_B });
    source("in-c", { session: SESSION_C, workspace: WS_C });

    db.softDeleteWorkspaceForUser(WS_B, OWNER);
    const ids = readableUnder({ all: true });
    expect(ids).not.toContain("in-b");
    expect(ids).toContain("in-c");
  });

  it("returns a source once, however many arms matched it", () => {
    // An upload is linked to its conversation *and* its workspace, so with a grant three arms
    // can match the same row. Collapsing on the id is what keeps one file from arriving as
    // several — which in the UI is one file rendering as several chips.
    source("shared", { session: SESSION_B, workspace: WS_B });
    const ids = readableUnder({ workspaceIds: [WS_B] });
    expect(ids.filter((id) => id === "shared")).toHaveLength(1);
  });

  it("adds nothing when the grant names a workspace the account does not own", () => {
    source("in-b", { session: SESSION_B, workspace: WS_B });
    expect(readableUnder({ workspaceIds: ["not-a-workspace"] })).toEqual(readableUnscoped());
  });
});
