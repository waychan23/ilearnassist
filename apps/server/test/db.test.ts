import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDb,
  DEFAULT_SESSION_TITLE,
  guessCapabilities,
  seedFromConfig,
  SETTING_DEFAULT_MODEL,
  SETTING_DEFAULT_PROVIDER,
  type AppDb,
} from "../src/db.js";
import { DEFAULT_WIDGET_IDS, type Session, type ToolCall } from "@ilearnassist/shared";
import { SCHEMA_VERSION } from "../src/schema.js";

let root: string;
let db: AppDb;

/**
 * The account every test below acts as.
 *
 * Reads take an owner now — see `AppDb` — and naming it once keeps these assertions about
 * workspaces and sessions legible. The tests that are *about* ownership need two accounts,
 * so they live in their own file.
 */
const OWNER = "u1";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gl-db-"));
  db = createDb(join(root, "test.sqlite"));
  db.createUser({ id: OWNER, username: "tester", slug: "tester" });
});

afterEach(() => {
  try {
    db.raw.close();
  } catch {
    /* already closed by the test */
  }
  rmSync(root, { recursive: true, force: true });
});

function addWorkspace(id = "w1"): string {
  db.createWorkspace({ userId: OWNER, id, name: "W", slug: id, dirPath: join(root, id) });
  return id;
}

/**
 * A Copilotless conversation, with an empty snapshot.
 *
 * `createSession` requires all four snapshot fields instead of defaulting them, so that a
 * conversation started from a Copilot cannot be built with half of it — copying the prompt but
 * not the tool allowlist is precisely the shape that widens silently. Tests that are not about
 * the snapshot say so once here; the ones that *are* pass it explicitly.
 */
function addSession(
  id = "s1",
  overrides: Partial<Parameters<AppDb["createSession"]>[0]> = {}
): Session {
  return db.createSession({
    id,
    workspaceId: "w1",
    copilotId: null,
    copilotName: "",
    systemPrompt: "",
    allTools: true,
    tools: [],
    title: DEFAULT_SESSION_TITLE,
    ...overrides,
  });
}

describe("workspaces", () => {
  it("creates and reads back a workspace", () => {
    const created = db.createWorkspace({ userId: OWNER, id: "w1", name: "Notes", slug: "notes", dirPath: "/tmp/notes" });
    expect(created).toMatchObject({ id: "w1", name: "Notes", slug: "notes", dirPath: "/tmp/notes" });
    expect(db.getWorkspaceForUser("w1", OWNER)).toEqual(created);
  });

  it("returns undefined for an unknown id", () => {
    expect(db.getWorkspaceForUser("nope", OWNER)).toBeUndefined();
  });

  it("lists workspaces oldest first", () => {
    addWorkspace("w1");
    addWorkspace("w2");
    expect(db.listWorkspaces(OWNER).map((w) => w.id)).toEqual(["w1", "w2"]);
  });

  it("soft-deletes a workspace, leaving the row in place", () => {
    addWorkspace("w1");
    expect(db.softDeleteWorkspaceForUser("w1", OWNER)).toBe(true);
    expect(db.getWorkspaceForUser("w1", OWNER)).toBeUndefined();
    expect(db.listWorkspaces(OWNER)).toEqual([]);
    // The row is still there — that is what soft means, and what a restore would need.
    const raw = db.raw.prepare("SELECT deleted_at FROM workspaces WHERE id = ?").get("w1") as {
      deleted_at: string | null;
    };
    expect(raw.deleted_at).not.toBeNull();
    // And a second delete finds nothing live to mark.
    expect(db.softDeleteWorkspaceForUser("w1", OWNER)).toBe(false);
  });

  it("counts each workspace's sessions and dates its last activity", () => {
    addWorkspace("w1");
    addWorkspace("w2");
    addSession("s1", { title: "a" });
    addSession("s2", { title: "b" });

    const [first, second] = db.listWorkspaces(OWNER);

    // A workspace nobody has talked to still appears, with no activity — that is the
    // LEFT JOIN doing its job, and the state of every workspace a user has just created.
    expect(second!.id).toBe("w2");
    expect(second!.sessionCount).toBe(0);
    expect(second!.lastActivityAt).toBeNull();

    expect(first!.sessionCount).toBe(2);
    expect(first!.lastActivityAt).toBeTruthy();
    expect(Number.isNaN(Date.parse(first!.lastActivityAt!))).toBe(false);
  });

  it("renames a workspace, keeping its identity and its stats", () => {
    addWorkspace("w1");
    addSession("s1", { title: "a" });

    const renamed = db.patchWorkspaceForUser("w1", OWNER, { name: "Renamed" })!;

    expect(renamed.name).toBe("Renamed");
    // Not an identity change: the directory is where the agent's files already live.
    expect(renamed.slug).toBe("w1");
    expect(renamed.dirPath).toBe(join(root, "w1"));
    // The response drives a card replacement in the client, so it has to carry the numbers
    // that card renders rather than the bare-row defaults.
    expect(renamed.sessionCount).toBe(1);
    expect(renamed.lastActivityAt).toBeTruthy();
    expect(db.getWorkspaceForUser("w1", OWNER)?.name).toBe("Renamed");
  });

  it("returns undefined when renaming a workspace that is not there", () => {
    expect(db.patchWorkspaceForUser("nope", OWNER, { name: "x" })).toBeUndefined();
  });

  it("does not hand back a bare row from createWorkspace or getWorkspace", () => {
    // Both default the stats rather than joining for them, which is only safe because a
    // brand-new workspace cannot have conversations and getWorkspace is an existence check.
    const created = db.createWorkspace({ userId: OWNER, id: "w1", name: "W", slug: "w1", dirPath: "/tmp/w1" });
    expect(created.sessionCount).toBe(0);
    expect(created.lastActivityAt).toBeNull();
    expect(db.getWorkspaceForUser("w1", OWNER)).toEqual(created);
  });
});

describe("copilots", () => {
  // The scoping rules — who may see and who may edit — need a second account and live in
  // `ownership.test.ts`. What is here is the row shape: the JSON columns, and the CRUD.
  const input = {
    id: "c1",
    userId: OWNER,
    name: "Tutor",
    description: "helps",
    systemPrompt: "You teach.",
    allTools: false,
    tools: ["read_file", "web_search"],
    settings: { temperature: 0.3, modelId: "m1" },
    widgets: [],
    visibility: "private" as const,
  };

  it("round-trips tools, settings and widgets through JSON columns", () => {
    const created = db.createCopilot({ ...input, widgets: ["session_stats"] });
    expect(created.tools).toEqual(["read_file", "web_search"]);
    expect(created.settings).toEqual({ temperature: 0.3, modelId: "m1" });
    expect(created.widgets).toEqual(["session_stats"]);
  });

  it("reads a Copilot whose widgets were never set as the defaults", () => {
    /*
     * The column is nullable precisely so "never set" survives as a distinct answer from "set to
     * none": a `NOT NULL DEFAULT '[]'` would have told every Copilot written before the column
     * existed that it installs nothing, a decision their owners never made. NULL resolves here
     * instead, and the assertion is against a hand-written row because no write path can produce
     * one any more.
     */
    db.createCopilot(input);
    db.raw.prepare("UPDATE copilots SET widgets = NULL WHERE id = ?").run("c1");
    expect(db.getOwnedCopilot("c1", OWNER)!.widgets).toEqual([...DEFAULT_WIDGET_IDS]);

    db.raw.prepare("UPDATE copilots SET widgets = ? WHERE id = ?").run("[]", "c1");
    expect(db.getOwnedCopilot("c1", OWNER)!.widgets).toEqual([]);
  });

  it("refuses to write a Copilot with no owner", () => {
    /*
     * `undefined` binds as NULL in silence, and an ownerless row is one every read refuses —
     * invisible to the person who made it, with nothing to explain it. That is worse than an
     * error at the call site, and it has already happened once: two Copilots created while a
     * dev server was mid-reload ended up with no owner and simply never appeared.
     */
    expect(() => db.createCopilot({ ...input, userId: undefined as unknown as string })).toThrow(
      /must have an owner/
    );
    expect(() => db.createCopilot({ ...input, userId: "" })).toThrow(/must have an owner/);
  });

  it("records the owner and defaults nothing about visibility", () => {
    const created = db.createCopilot(input);
    expect(created.userId).toBe(OWNER);
    expect(created.ownerName).toBe("tester");
    expect(created.visibility).toBe("private");
  });

  it("updates in place and bumps updatedAt", () => {
    const created = db.createCopilot(input);
    const updated = db.updateCopilotForUser("c1", OWNER, {
      name: "Coach",
      description: "",
      systemPrompt: "S",
      allTools: false,
      tools: [],
      settings: {},
      widgets: [],
      visibility: "public",
    });
    expect(updated).toMatchObject({
      name: "Coach",
      allTools: false,
      tools: [],
      settings: {},
      visibility: "public",
    });
    expect(updated!.updatedAt >= created.updatedAt).toBe(true);
  });

  it("returns undefined when updating a missing copilot", () => {
    expect(db.updateCopilotForUser("nope", OWNER, input)).toBeUndefined();
  });

  it("soft-deletes a copilot", () => {
    db.createCopilot(input);
    expect(db.softDeleteCopilotForUser("c1", OWNER)).toBe(true);
    expect(db.getOwnedCopilot("c1", OWNER)).toBeUndefined();
    expect(db.getCopilotForUser("c1", OWNER)).toBeUndefined();
    expect(db.listCopilotsForUser(OWNER)).toEqual([]);
  });

  it("tolerates corrupt JSON in a JSON column", () => {
    // A hand-edited or truncated column must degrade to an empty value, not throw.
    db.createCopilot(input);
    db.raw.prepare("UPDATE copilots SET tools = ? WHERE id = ?").run("{not json", "c1");
    expect(db.getOwnedCopilot("c1", OWNER)!.tools).toEqual([]);
    expect(db.getOwnedCopilot("c1", OWNER)!.settings).toEqual({ temperature: 0.3, modelId: "m1" });

    db.raw.prepare("UPDATE copilots SET settings = ? WHERE id = ?").run("[1,2]", "c1");
    expect(db.getOwnedCopilot("c1", OWNER)!.settings).toEqual({});
  });
});

describe("sessions", () => {
  beforeEach(() => addWorkspace());

  it("starts life auto-titled", () => {
    const session = addSession("s1");
    expect(session.titleSource).toBe("auto");
    expect(session.settings).toEqual({});
  });

  it("flips to user-titled when a title is supplied", () => {
    addSession("s1");
    const renamed = db.updateSessionForUser("s1", OWNER, { title: "  My Notes  " });
    expect(renamed!.title).toBe("My Notes");
    expect(renamed!.titleSource).toBe("user");
  });

  it("ignores a blank title, leaving the existing one in place", () => {
    addSession("s1", { title: "Kept" });
    const updated = db.updateSessionForUser("s1", OWNER, { title: "   " });
    expect(updated!.title).toBe("Kept");
    expect(updated!.titleSource).toBe("auto");
  });

  it("keeps the title ownership flag on a settings-only update", () => {
    addSession("s1");
    db.updateSessionForUser("s1", OWNER, { title: "Mine" });
    const updated = db.updateSessionForUser("s1", OWNER, { settings: { temperature: 0.7 } });
    expect(updated!.titleSource).toBe("user");
    expect(updated!.title).toBe("Mine");
  });

  it("merges settings rather than replacing them", () => {
    addSession("s1", { title: "t", settings: { temperature: 0.1, maxSteps: 5 } });
    const updated = db.updateSessionForUser("s1", OWNER, { settings: { maxSteps: 9 } });
    expect(updated!.settings).toEqual({ temperature: 0.1, maxSteps: 9 });
  });

  it("lets the auto-titler rename without taking ownership", () => {
    addSession("s1");
    const titled = db.setAutoTitleForUser("s1", OWNER, "Model Chose This", "model");
    expect(titled!.title).toBe("Model Chose This");
    expect(titled!.titleSource).toBe("auto");
    // And how it was arrived at, which is what tells a retry whether there is anything to do.
    expect(titled!.titleState).toBe("model");
  });

  it("records a fallback title as such, so it can be retried", () => {
    // The distinction the retry is built on: both states leave `titleSource: "auto"` with a
    // non-empty title, so without this a conversation named by the user's own clipped words is
    // indistinguishable from one the model named.
    addSession("s1");
    const titled = db.setAutoTitleForUser("s1", OWNER, "用户自己的话", "fallback");
    expect(titled!.titleState).toBe("fallback");
  });

  it("refuses to auto-title a conversation the user has renamed", () => {
    /*
     * The guard is in the statement rather than in its callers' checks, because both callers read
     * the session and then write — a window the user can rename in, and a rename is permanent by
     * design. `undefined` is how the caller learns it lost that race, and it is the same answer a
     * missing session gives.
     */
    addSession("s1");
    db.updateSessionForUser("s1", OWNER, { title: "Mine" });

    expect(db.setAutoTitleForUser("s1", OWNER, "Machine", "model")).toBeUndefined();
    expect(db.getSessionForUser("s1", OWNER)?.session.title).toBe("Mine");
    expect(db.getSessionForUser("s1", OWNER)?.session.titleSource).toBe("user");
  });

  it("returns undefined from setAutoTitle for a missing session", () => {
    expect(db.setAutoTitleForUser("nope", OWNER, "x", "model")).toBeUndefined();
  });

  it("returns undefined from updateSession for a missing session", () => {
    expect(db.updateSessionForUser("nope", OWNER, { title: "x" })).toBeUndefined();
  });

  it("lists a workspace's sessions, most recently updated first", () => {
    addSession("s1", { title: "one" });
    addSession("s2", { title: "two" });

    // Timestamps are millisecond-resolution, so rows created in the same tick tie and
    // the order between them is arbitrary. Pin them to make the assertion deterministic.
    const stamp = db.raw.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?");
    stamp.run("2026-01-01T00:00:00.000Z", "s1");
    stamp.run("2026-01-02T00:00:00.000Z", "s2");
    expect(db.listSessionsForUser("w1", OWNER).map((s) => s.id)).toEqual(["s2", "s1"]);

    db.touchSession("s1"); // bumps s1 to now, which is later than both
    expect(db.listSessionsForUser("w1", OWNER).map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  it("holds a Copilot's snapshot independently of the Copilot", () => {
    // The conversation is not a view onto the Copilot. Editing the Copilot afterwards must
    // leave this row alone, and so must deleting it — which is the case that used to widen the
    // tool set, since an empty allowlist reads as "all tools".
    db.createCopilot({
      id: "c1",
      userId: OWNER,
      name: "Tutor",
      description: "",
      systemPrompt: "You teach.",
      allTools: false,
      tools: ["read_file"],
      settings: { temperature: 0.3 },
      widgets: [],
      visibility: "private",
    });
    addSession("s1", {
      copilotId: "c1",
      copilotName: "Tutor",
      systemPrompt: "You teach.",
      allTools: false,
      tools: ["read_file"],
      settings: { temperature: 0.3 },
    });

    db.updateCopilotForUser("c1", OWNER, {
      name: "Renamed",
      description: "",
      systemPrompt: "You now lecture.",
      allTools: true,
      tools: [],
      settings: { temperature: 1.8 },
      widgets: [],
      visibility: "public",
    });
    db.softDeleteCopilotForUser("c1", OWNER);

    const after = db.getSessionForUser("s1", OWNER)!.session;
    expect(after).toMatchObject({
      // The link is *kept*, where the old hard delete nulled it through `ON DELETE SET NULL`:
      // a soft delete fires no cascade, and there is nothing to gain by clearing a column the
      // UI only ever looks up — a deleted Copilot is not returned by any read, so the link
      // resolves to nothing on its own.
      copilotId: "c1",
      copilotName: "Tutor", // the label is what the badge reads, and it survives
      systemPrompt: "You teach.",
      allTools: false, // the *restriction* survives too, which is the half that matters
      tools: ["read_file"],
      settings: { temperature: 0.3 },
    });
    // Which is the thing that matters: the Copilot is not reachable any more, so nothing can
    // read its edited persona to answer with.
    expect(db.getCopilotForUser("c1", OWNER)).toBeUndefined();
  });

  it("lets a conversation edit its own persona without touching the Copilot", () => {
    db.createCopilot({
      id: "c1",
      userId: OWNER,
      name: "Tutor",
      description: "",
      systemPrompt: "You teach.",
      allTools: true,
      tools: [],
      settings: {},
      widgets: [],
      visibility: "private",
    });
    addSession("s1", { copilotId: "c1", copilotName: "Tutor", systemPrompt: "You teach." });

    const updated = db.updateSessionForUser("s1", OWNER, { systemPrompt: "Be terse." })!;

    expect(updated.systemPrompt).toBe("Be terse.");
    expect(db.getOwnedCopilot("c1", OWNER)!.systemPrompt).toBe("You teach.");
  });

  it("stores the tool flag authoritatively, so no row disagrees with itself", () => {
    // Both halves of the pair are supplied contradicting each other on purpose. Storing them
    // as given would leave a row whose `tools` is silently ignored, and the next reader with no
    // way to tell whether the list or the flag was meant.
    const copilot = db.createCopilot({
      id: "c1",
      userId: OWNER,
      name: "Every",
      description: "",
      systemPrompt: "",
      allTools: true,
      tools: ["read_file", "write_file"],
      settings: {},
      widgets: [],
      visibility: "private",
    });

    expect(copilot.allTools).toBe(true);
    expect(copilot.tools).toEqual([]);
    expect(
      db.raw.prepare("SELECT tools FROM copilots WHERE id = ?").get("c1")
    ).toMatchObject({ tools: "[]" });
  });

  it("keeps 'no tools' distinct from 'every tool'", () => {
    // The state that was unreachable before the flag existed: an empty list used to mean every
    // tool, so a Copilot could not be locked down to none.
    const none = db.createCopilot({
      id: "c-none",
      userId: OWNER,
      name: "None",
      description: "",
      systemPrompt: "",
      allTools: false,
      tools: [],
      settings: {},
      widgets: [],
      visibility: "private",
    });

    expect(none.allTools).toBe(false);
    expect(none.tools).toEqual([]);
  });

  it("carries the flag onto a conversation, and clears the list with it", () => {
    const session = addSession("s1", {
      allTools: true,
      tools: ["read_file"],
    });

    expect(session.allTools).toBe(true);
    expect(session.tools).toEqual([]);
  });

  it("hides a soft-deleted session's messages without unlinking them", () => {
    // The cascade this used to rely on no longer fires, so the rows stay. They are reached
    // through the session, which is why filtering it is enough — and why nothing has to be
    // dismantled to take a conversation out of view.
    addSession("s1", { title: "t" });
    db.createMessage({ id: "m1", sessionId: "s1", role: "user", content: "hi" });
    db.softDeleteSessionForUser("s1", OWNER);

    expect(db.getSessionForUser("s1", OWNER)).toBeUndefined();
    expect(db.listSessionsForUser("w1", OWNER)).toEqual([]);
    expect(db.listMessagesForUser("s1", OWNER)).toEqual([]);
    const remaining = db.raw
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?")
      .get("s1") as { n: number };
    expect(remaining.n).toBe(1);
  });
});

describe("messages", () => {
  beforeEach(() => {
    addWorkspace();
    addSession("s1", { title: "t" });
  });

  it("round-trips every optional payload", () => {
    const created = db.createMessage({
      id: "m1",
      sessionId: "s1",
      role: "assistant",
      content: "answer",
      reasoning: "  thought  ",
      toolCalls: [{ id: "call_1", name: "read_file", input: "{}", output: "ok" }],
      attachments: [{ id: "a1", name: "x.png", mimeType: "image/png", size: 3, kind: "image" }],
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    });

    // `trim()` is only the emptiness check — the text itself is stored verbatim, because
    // chain of thought is rendered as markdown and leading indentation is meaningful.
    expect(created.reasoning).toBe("  thought  ");
    expect(created.toolCalls?.[0]).toMatchObject({ id: "call_1", output: "ok" });
    expect(created.attachments?.[0]).toMatchObject({ id: "a1", kind: "image" });
    expect(created.usage).toEqual({ inputTokens: 1, outputTokens: 2, totalTokens: 3 });
  });

  it("stores a whitespace-only reasoning as absent", () => {
    const created = db.createMessage({
      id: "m1",
      sessionId: "s1",
      role: "assistant",
      content: "a",
      reasoning: "   \n  ",
    });
    expect(created.reasoning).toBeUndefined();
  });

  it("round-trips the stopped flag, and leaves it absent otherwise", () => {
    const stopped = db.createMessage({
      id: "m1",
      sessionId: "s1",
      role: "assistant",
      content: "half an answer",
      stopped: true,
    });
    expect(stopped.stopped).toBe(true);

    // Absent rather than `false`, matching the other optional columns: a caller asking
    // "was this stopped" must not have to tell "no" apart from "not recorded".
    const ordinary = db.createMessage({ id: "m2", sessionId: "s1", role: "assistant", content: "an answer" });
    expect(ordinary.stopped).toBeUndefined();
    expect(db.getMessageForUser("m2", OWNER)?.stopped).toBeUndefined();
  });

  it("stores an empty attachment list as absent rather than as '[]'", () => {
    const created = db.createMessage({
      id: "m1",
      sessionId: "s1",
      role: "user",
      content: "a",
      attachments: [],
      toolCalls: [],
    });
    expect(created.attachments).toBeUndefined();
    // Asymmetric on purpose: `toolCalls` has no `.length` guard, so an explicitly empty
    // list round-trips as `[]`. The chat route only ever passes a non-empty array, so
    // nothing depends on the difference — pinned here so a change is noticed.
    expect(created.toolCalls).toEqual([]);
  });

  it("lists a session's messages oldest first", () => {
    db.createMessage({ id: "m1", sessionId: "s1", role: "user", content: "one" });
    db.createMessage({ id: "m2", sessionId: "s1", role: "assistant", content: "two" });
    expect(db.listMessagesForUser("s1", OWNER).map((m) => m.content)).toEqual(["one", "two"]);
  });

  it("keeps messages of different sessions apart", () => {
    addSession("s2", { title: "t" });
    db.createMessage({ id: "m1", sessionId: "s1", role: "user", content: "in s1" });
    expect(db.listMessagesForUser("s2", OWNER)).toEqual([]);
  });
});

describe("providers and models", () => {
  it("preserves insertion order through sort_order", () => {
    db.createProvider({ id: "p1", name: "One", baseURL: "http://1", apiKey: "k" });
    db.createProvider({ id: "p2", name: "Two", baseURL: "http://2" });
    expect(db.listProviders().map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(db.getProvider("p2")!.apiKey).toBeUndefined();
  });

  it("keeps the stored key when the update omits one", () => {
    db.createProvider({ id: "p1", name: "One", baseURL: "http://1", apiKey: "original" });
    db.updateProvider("p1", { name: "Renamed" });
    expect(db.getProvider("p1")).toMatchObject({ name: "Renamed", apiKey: "original" });
  });

  it("clears the stored key when the update sends an empty one", () => {
    db.createProvider({ id: "p1", name: "One", baseURL: "http://1", apiKey: "original" });
    db.updateProvider("p1", { apiKey: "" });
    expect(db.getProvider("p1")!.apiKey).toBeUndefined();
  });

  it("ignores blank name/baseURL fields", () => {
    db.createProvider({ id: "p1", name: "One", baseURL: "http://1" });
    db.updateProvider("p1", { name: "   ", baseURL: "" });
    expect(db.getProvider("p1")).toMatchObject({ name: "One", baseURL: "http://1" });
  });

  it("returns undefined when updating a missing provider", () => {
    expect(db.updateProvider("nope", { name: "x" })).toBeUndefined();
  });

  it("orders models per provider, and hides the models when the provider goes", () => {
    db.createProvider({ id: "p1", name: "One", baseURL: "http://1" });
    db.createProvider({ id: "p2", name: "Two", baseURL: "http://2" });
    db.createModel({ id: "m1", providerId: "p1", modelId: "a", name: "A", capabilities: ["tool_use"] });
    db.createModel({ id: "m2", providerId: "p1", modelId: "b", name: "B", capabilities: [] });
    db.createModel({ id: "m3", providerId: "p2", modelId: "c", name: "C", capabilities: [] });

    expect(db.getProvider("p1")!.models.map((m) => m.modelId)).toEqual(["a", "b"]);
    db.softDeleteProvider("p1");
    expect(db.getProvider("p1")).toBeUndefined();
    expect(db.listProviders().map((p) => p.id)).toEqual(["p2"]);
    // `models.provider_id` is ON DELETE CASCADE and a soft delete fires no cascade, so the
    // models have to be marked in the same transaction or they stay resolvable under a
    // provider nothing lists.
    const marked = db.raw
      .prepare("SELECT id, deleted_at FROM models WHERE deleted_at IS NOT NULL ORDER BY id")
      .all() as { id: string; deleted_at: string }[];
    expect(marked.map((m) => m.id)).toEqual(["m1", "m2"]);
    // p2's model is untouched, which is the half that says this is scoped to one provider.
    expect(db.listProviders()[0]!.models.map((m) => m.modelId)).toEqual(["c"]);
  });

  it("updates a model field-by-field, keeping what was not sent", () => {
    db.createProvider({ id: "p1", name: "One", baseURL: "http://1" });
    db.createModel({
      id: "m1",
      providerId: "p1",
      modelId: "a",
      name: "A",
      contextWindow: 1000,
      capabilities: ["tool_use"],
    });

    const updated = db.updateModel("m1", { name: "Renamed", maxOutput: 500 });
    expect(updated).toMatchObject({ modelId: "a", name: "Renamed", contextWindow: 1000, maxOutput: 500 });
    expect(updated!.capabilities).toEqual(["tool_use"]);
  });

  it("reports whether a model delete actually marked anything", () => {
    db.createProvider({ id: "p1", name: "One", baseURL: "http://1" });
    db.createModel({ id: "m1", providerId: "p1", modelId: "a", name: "A", capabilities: [] });
    expect(db.softDeleteModel("m1")).toBe(true);
    // Already gone: the second call has nothing live to mark, so it says so.
    expect(db.softDeleteModel("m1")).toBe(false);
  });
});

describe("app settings", () => {
  it("returns undefined for an unset key", () => {
    expect(db.getSetting("nope")).toBeUndefined();
  });

  it("overwrites on conflict", () => {
    db.setSetting(SETTING_DEFAULT_MODEL, "a");
    db.setSetting(SETTING_DEFAULT_MODEL, "b");
    expect(db.getSetting(SETTING_DEFAULT_MODEL)).toBe("b");
  });
});

describe("guessCapabilities", () => {
  it.each([
    ["deepseek-v4-pro", ["tool_use"]], // "pro" is not a reasoning marker
    ["deepseek-reasoner", ["tool_use", "reasoning"]],
    ["gpt-4o-mini", ["tool_use", "vision"]],
    ["claude-sonnet-5", ["tool_use", "vision"]],
    ["o3-mini", ["tool_use", "reasoning"]],
    ["r1-distill", ["tool_use", "reasoning"]],
    ["deepseek-think-chat", ["tool_use", "reasoning"]],
    ["llama3.1", ["tool_use"]],
    ["qwen-vl-max", ["tool_use", "vision"]],
  ])("guesses %s", (modelId, expected) => {
    expect(guessCapabilities(modelId)).toEqual(expected);
  });
});

describe("seedFromConfig", () => {
  const seed = {
    providers: [
      { id: "p", name: "P", baseURL: "http://x", apiKey: "k", models: [{ id: "m1", name: "M1" }, { id: "m2", name: "M2" }] },
    ],
    defaultProvider: "p",
    defaultModel: "m1",
  };

  it("copies providers, models and defaults on first boot", () => {
    expect(seedFromConfig(db, seed)).toBe(true);
    const provider = db.getProvider("p")!;
    expect(provider.models.map((m) => m.modelId)).toEqual(["m1", "m2"]);
    expect(provider.apiKey).toBe("k");
    expect(db.getSetting(SETTING_DEFAULT_PROVIDER)).toBe("p");
    expect(db.getSetting(SETTING_DEFAULT_MODEL)).toBe("m1");
  });

  it("pre-fills capabilities", () => {
    seedFromConfig(db, seed);
    expect(db.getProvider("p")!.models[0]!.capabilities).toContain("tool_use");
  });

  it("is a no-op once providers exist, so UI edits survive a config change", () => {
    seedFromConfig(db, seed);
    db.updateProvider("p", { name: "Renamed In UI" });

    expect(seedFromConfig(db, seed)).toBe(false);
    expect(db.getProvider("p")!.name).toBe("Renamed In UI");
    expect(db.listProviders()).toHaveLength(1);
  });

  it("backfills a missing default without touching the providers", () => {
    seedFromConfig(db, seed);
    db.raw.prepare("DELETE FROM app_settings WHERE key = ?").run(SETTING_DEFAULT_MODEL);

    expect(seedFromConfig(db, seed)).toBe(false);
    expect(db.getSetting(SETTING_DEFAULT_MODEL)).toBe("m1");
  });
});

describe("schema versioning", () => {
  /** A database file carrying `version` in its header, optionally with one table in it. */
  function writeDbFile(path: string, version: number, withTable: boolean): void {
    const raw = new Database(path);
    if (withTable) raw.exec("CREATE TABLE something (id TEXT PRIMARY KEY)");
    raw.pragma(`user_version = ${version}`);
    raw.close();
  }

  const tablesIn = (path: string): string[] => {
    const raw = new Database(path);
    try {
      const rows = raw
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[];
      return rows.map((r) => r.name).sort();
    } finally {
      raw.close();
    }
  };

  it("stamps a brand-new file with the current version", () => {
    const path = join(root, "fresh.sqlite");
    const opened = createDb(path);
    try {
      expect(opened.raw.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    } finally {
      opened.raw.close();
    }
  });

  it("creates the tables on a genuinely empty file", () => {
    const path = join(root, "empty.sqlite");
    writeDbFile(path, 0, false);
    const opened = createDb(path);
    try {
      expect(opened.listUsers()).toEqual([]);
    } finally {
      opened.raw.close();
    }
  });

  it("gains the workspace settings column on an existing file of the current version", () => {
    /*
     * `ensureColumn`, not the version bump: adding a column is additive, and NULL is exactly
     * what a row written before it existed means — "nobody has chosen". This is the column the
     * write location needs, and a workspace from before it must read as "no opinion" rather
     * than as a value nobody set.
     */
    const path = join(root, "pre-settings.sqlite");
    writeDbFile(path, SCHEMA_VERSION, true);
    const raw = new Database(path);
    raw.exec(
      "CREATE TABLE workspaces (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, slug TEXT NOT NULL, dir_path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL)"
    );
    raw.close();

    const opened = createDb(path);
    try {
      const columns = (
        opened.raw.prepare("PRAGMA table_info(workspaces)").all() as { name: string }[]
      ).map((c) => c.name);
      expect(columns).toContain("settings");
    } finally {
      opened.raw.close();
    }
  });

  it("gains both description columns, and reads an old row as empty", () => {
    /*
     * `ensureColumn`, not a version bump — an added column is additive, which is the rule the
     * `pre-settings` case above states. What this one adds is a second half: the column arrives
     * `NOT NULL DEFAULT ''`, so a row written before it existed has to read as "nobody wrote
     * one" rather than as NULL or as a crash. Both tables are here because they are one feature
     * and a single-file check of the pair is what makes that visible.
     */
    const path = join(root, "pre-description.sqlite");
    writeDbFile(path, SCHEMA_VERSION, true);
    const raw = new Database(path);
    raw.exec(
      "CREATE TABLE workspaces (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, slug TEXT NOT NULL, dir_path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL)"
    );
    raw.exec(
      `CREATE TABLE sessions (
         id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, copilot_id TEXT, copilot_name TEXT NOT NULL DEFAULT '',
         system_prompt TEXT NOT NULL DEFAULT '', all_tools INTEGER NOT NULL DEFAULT 1, tools TEXT NOT NULL DEFAULT '[]',
         title TEXT NOT NULL, title_source TEXT NOT NULL DEFAULT 'auto', settings TEXT NOT NULL DEFAULT '{}',
         created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
       )`
    );
    raw
      .prepare("INSERT INTO workspaces VALUES ('w1', 'u1', 'Old', 'old', '/tmp/old', '2024-01-01')")
      .run();
    raw
      .prepare(
        "INSERT INTO sessions VALUES ('s1', 'w1', NULL, '', '', 1, '[]', 'Old Talk', 'auto', '{}', '2024-01-01', '2024-01-01', NULL)"
      )
      .run();
    raw.close();

    const opened = createDb(path);
    try {
      const columnsOf = (table: string): string[] =>
        (opened.raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
          (c) => c.name
        );
      expect(columnsOf("workspaces")).toContain("description");
      expect(columnsOf("sessions")).toContain("description");

      // The rows that predate the column, read through the ordinary accessors.
      expect(opened.getWorkspaceForUser("w1", "u1")?.description).toBe("");
      expect(opened.getSessionForUser("s1", "u1")?.session.description).toBe("");
    } finally {
      opened.raw.close();
    }
  });

  it("gains the counters table on an existing file of the current version", () => {
    // The claim that a new *table* needs no `SCHEMA_VERSION` bump — the DDL runs on every
    // open, so a database created before the table existed simply gains it. The bump rule
    // is for changing what an existing column means, which this is not.
    const path = join(root, "pre-counters.sqlite");
    writeDbFile(path, SCHEMA_VERSION, true);
    expect(tablesIn(path)).not.toContain("counters");

    const opened = createDb(path);
    try {
      expect(tablesIn(path)).toContain("counters");
      expect(opened.reserveCounter("session", "s1", "quiz_question", 2)).toEqual([1, 2]);
    } finally {
      opened.raw.close();
    }
  });

  it("gains the widget_instances table on an existing file of the current version", () => {
    // The counters test's twin, for the same claim: a new *table* needs no `SCHEMA_VERSION`
    // bump, because the DDL runs on every open. The round-trip is asserted rather than the
    // table's mere presence, since a table created with the wrong columns would satisfy that.
    const path = join(root, "pre-widgets.sqlite");
    writeDbFile(path, SCHEMA_VERSION, true);
    expect(tablesIn(path)).not.toContain("widget_instances");

    const opened = createDb(path);
    try {
      expect(tablesIn(path)).toContain("widget_instances");
      opened.createUser({ id: OWNER, username: "tester", slug: "tester" });
      opened.createWorkspace({
        id: "w1",
        userId: OWNER,
        name: "W",
        slug: "w",
        dirPath: join(root, "w"),
      });
      expect(opened.setWorkspaceWidgetForUser(OWNER, "w1", "workspace_stats", true)).toBe(true);
      expect(opened.listWorkspaceWidgetsForUser(OWNER, "w1")).toEqual([
        { id: "workspace_stats", scope: "workspace", enabled: true },
      ]);
    } finally {
      opened.raw.close();
    }
  });

  it("gains the insight_items table on an existing file of the current version", () => {
    // The third of the same claim: a new *table* needs no `SCHEMA_VERSION` bump, because the
    // DDL runs on every open and a missing table is created while an existing one is skipped.
    // The round-trip is asserted rather than the table's presence alone — a table created with
    // the wrong columns would satisfy that.
    const path = join(root, "pre-insights.sqlite");
    writeDbFile(path, SCHEMA_VERSION, true);
    expect(tablesIn(path)).not.toContain("insight_items");

    const opened = createDb(path);
    try {
      expect(tablesIn(path)).toContain("insight_items");
      opened.createUser({ id: OWNER, username: "tester", slug: "tester" });
      opened.createWorkspace({
        id: "w1",
        userId: OWNER,
        name: "W",
        slug: "w",
        dirPath: join(root, "w"),
      });
      opened.createSession({
        id: "s1",
        workspaceId: "w1",
        copilotId: null,
        copilotName: "",
        systemPrompt: "",
        allTools: true,
        tools: [],
        title: DEFAULT_SESSION_TITLE,
      });
      // Adopt-then-read is the round trip that matters: `adopted` is the one column a pass
      // reads back, and it is stored as 0/1 rather than a boolean.
      opened.replaceUnadoptedInsights("s1", [
        { id: "i1", sessionId: "s1", type: "advice", title: "T", body: "B", ordinal: 0 },
      ]);
      expect(opened.setInsightAdoptedForUser(OWNER, "s1", "i1", true)?.adopted).toBe(true);
      expect(opened.listInsightsForUser(OWNER, "s1").map((i) => i.title)).toEqual(["T"]);
    } finally {
      opened.raw.close();
    }
  });

  it("gains the session_threads table and messages.thread_id on an existing file", () => {
    // Twin of the widget_instances test: derived data with its own table, so no
    // SCHEMA_VERSION bump — an old file simply gains the table and the nullable column.
    const path = join(root, "pre-threads.sqlite");
    writeDbFile(path, SCHEMA_VERSION, true);
    expect(tablesIn(path)).not.toContain("session_threads");

    const opened = createDb(path);
    try {
      expect(tablesIn(path)).toContain("session_threads");
      opened.createUser({ id: OWNER, username: "tester", slug: "tester" });
      opened.createWorkspace({
        id: "w1",
        userId: OWNER,
        name: "W",
        slug: "w",
        dirPath: join(root, "w"),
      });
      opened.createSession({
        id: "s1",
        workspaceId: "w1",
        copilotId: null,
        copilotName: "",
        systemPrompt: "",
        allTools: true,
        tools: [],
        title: DEFAULT_SESSION_TITLE,
      });
      // Old messages read as "not classified yet" — the same state a fresh one is in.
      const message = opened.createMessage({
        id: "m1",
        sessionId: "s1",
        role: "user",
        content: "hello",
      });
      expect(opened.countPendingThreadMessages("s1")).toBe(1);
      const thread = opened.insertThread({
        id: "t1",
        sessionId: "s1",
        branch: "other",
        title: "问候",
      });
      expect(opened.assignMessagesToThread("s1", [message.id], thread.id)).toBe(1);
      expect(opened.countPendingThreadMessages("s1")).toBe(0);
      expect(opened.listThreadsForUser(OWNER, "s1")).toHaveLength(1);
    } finally {
      opened.raw.close();
    }
  });

  it("gains the notes table on an existing file of the current version", () => {
    // Twin of the threads test, with one difference worth asserting: notes is the only table
    // added recently that carries `deleted_at`, because it is user-authored rather than
    // derived. A table created without it would satisfy "the table is present" and then leak
    // deleted notes out of every read, so the round-trip is what is asserted.
    const path = join(root, "pre-notes.sqlite");
    writeDbFile(path, SCHEMA_VERSION, true);
    expect(tablesIn(path)).not.toContain("notes");

    const opened = createDb(path);
    try {
      expect(tablesIn(path)).toContain("notes");
      opened.createUser({ id: OWNER, username: "tester", slug: "tester" });
      opened.createWorkspace({
        id: "w1",
        userId: OWNER,
        name: "W",
        slug: "w",
        dirPath: join(root, "w"),
      });
      opened.createSession({
        id: "s1",
        workspaceId: "w1",
        copilotId: null,
        copilotName: "",
        systemPrompt: "",
        allTools: true,
        tools: [],
        title: DEFAULT_SESSION_TITLE,
      });
      opened.createMessage({ id: "m1", sessionId: "s1", role: "user", content: "hello" });

      const note = opened.createNote({
        id: "n1",
        sessionId: "s1",
        messageId: "m1",
        type: "annotation",
        quote: "hello",
        occurrence: 0,
        content: "",
      });
      expect(note).toMatchObject({ messageMissing: false, type: "annotation", quote: "hello" });
      expect(opened.listNotesForUser(OWNER, "s1").map((n) => n.id)).toEqual(["n1"]);

      // The two things the columns decide: deleting the message leaves the note readable but
      // reports the place it came from as gone, and deleting the note hides it from the read.
      expect(opened.softDeleteMessageForUser("s1", "m1", OWNER)).toBe(true);
      expect(opened.getNoteForUser(OWNER, "s1", "n1")).toMatchObject({ messageMissing: true });

      expect(opened.softDeleteNote("s1", "n1")).toBe(true);
      expect(opened.listNotesForUser(OWNER, "s1")).toEqual([]);
    } finally {
      opened.raw.close();
    }
  });

  it("gains the notes table on an existing file of the current version", () => {
    // Twin of the threads test, with one difference worth asserting: notes is the only table
    // added recently that carries `deleted_at`, because it is user-authored rather than
    // derived. A table created without it would satisfy "the table is present" and then leak
    // deleted notes out of every read, so the round-trip is what is asserted.
    const path = join(root, "pre-notes.sqlite");
    writeDbFile(path, SCHEMA_VERSION, true);
    expect(tablesIn(path)).not.toContain("notes");

    const opened = createDb(path);
    try {
      expect(tablesIn(path)).toContain("notes");
      opened.createUser({ id: OWNER, username: "tester", slug: "tester" });
      opened.createWorkspace({
        id: "w1",
        userId: OWNER,
        name: "W",
        slug: "w",
        dirPath: join(root, "w"),
      });
      opened.createSession({
        id: "s1",
        workspaceId: "w1",
        copilotId: null,
        copilotName: "",
        systemPrompt: "",
        allTools: true,
        tools: [],
        title: DEFAULT_SESSION_TITLE,
      });
      opened.createMessage({ id: "m1", sessionId: "s1", role: "user", content: "hello" });

      const note = opened.createNote({
        id: "n1",
        sessionId: "s1",
        messageId: "m1",
        type: "annotation",
        quote: "hello",
        occurrence: 0,
        content: "",
      });
      expect(note).toMatchObject({ messageMissing: false, type: "annotation", quote: "hello" });
      expect(opened.listNotesForUser(OWNER, "s1").map((n) => n.id)).toEqual(["n1"]);

      // The two things the columns decide: deleting the message leaves the note readable but
      // reports the place it came from as gone, and deleting the note hides it from the read.
      expect(opened.softDeleteMessageForUser("s1", "m1", OWNER)).toBe(true);
      expect(opened.getNoteForUser(OWNER, "s1", "n1")).toMatchObject({ messageMissing: true });

      expect(opened.softDeleteNote("s1", "n1")).toBe(true);
      expect(opened.listNotesForUser(OWNER, "s1")).toEqual([]);
    } finally {
      opened.raw.close();
    }
  });

  it("adds a nullable widgets column Copilots had no way to have", () => {
    /*
     * `ensureColumn` rather than a version bump, because this *adds* a column instead of changing
     * what one means. The nullable shape is the point of the test: a `NOT NULL DEFAULT '[]'`
     * would have told every Copilot written before this column existed that it installs nothing,
     * so the assertion is that an old row reads as the *defaults* and not as an empty selection.
     */
    const path = join(root, "pre-copilot-widgets.sqlite");
    writeDbFile(path, SCHEMA_VERSION, true);

    const opened = createDb(path);
    try {
      opened.createUser({ id: OWNER, username: "tester", slug: "tester" });
      // Written by hand, naming every column *except* `widgets`, which is what a row created
      // before this change looks like once the column arrives: present, and NULL.
      const seeded = opened.raw
        .prepare(
          `INSERT INTO copilots (id, user_id, name, description, system_prompt, all_tools, tools, settings, visibility, created_at, updated_at)
           VALUES (@id, @userId, 'T', '', '', 1, '[]', '{}', 'private', '2024-01-01', '2024-01-01')`
        )
        .run({ id: "c1", userId: OWNER });
      expect(seeded.changes).toBe(1);

      const columns = opened.raw.prepare("PRAGMA table_info(copilots)").all() as {
        name: string;
        notnull: number;
        dflt_value: string | null;
      }[];
      expect(columns.find((c) => c.name === "widgets")).toMatchObject({
        notnull: 0,
        dflt_value: null,
      });

      expect(opened.getOwnedCopilot("c1", OWNER)!.widgets).toEqual([...DEFAULT_WIDGET_IDS]);
    } finally {
      opened.raw.close();
    }
  });

  it("gives Copilots an owner, and drops the ones written before they had one", () => {
    /*
     * The one migration in this change, and the one place rows are deleted on purpose — so all
     * three halves are pinned here: the columns arrive on a file that predates them, the
     * ownerless Copilots go, and a conversation that referenced one survives with its link
     * cleared rather than being carried off by the cascade.
     *
     * Written by hand rather than by an older `createDb`, because the point is a file whose
     * `copilots` table has no `user_id` in its DDL — which is what a real upgrade looks like.
     */
    const path = join(root, "pre-owned.sqlite");
    const pre = new Database(path);
    pre.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE copilots (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        system_prompt TEXT NOT NULL, tools TEXT NOT NULL DEFAULT '[]',
        settings TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
        copilot_id TEXT REFERENCES copilots(id) ON DELETE SET NULL,
        title TEXT NOT NULL, title_source TEXT NOT NULL DEFAULT 'auto',
        settings TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO copilots (id, name, description, system_prompt, tools, settings, created_at, updated_at)
        VALUES ('c1', 'Tutor', '', 'You teach.', '["read_file"]', '{}', '2026-01-01', '2026-01-01');
      INSERT INTO sessions (id, workspace_id, copilot_id, title, title_source, settings, created_at, updated_at)
        VALUES ('s1', 'w1', 'c1', 'T', 'auto', '{}', '2026-01-01', '2026-01-01');
    `);
    pre.pragma("foreign_keys = ON");
    pre.pragma(`user_version = ${SCHEMA_VERSION}`);
    pre.close();

    const opened = createDb(path);
    try {
      const columns = (
        opened.raw.prepare("PRAGMA table_info(copilots)").all() as { name: string }[]
      ).map((c) => c.name);
      expect(columns).toContain("user_id");
      expect(columns).toContain("visibility");
      expect(columns).toContain("all_tools");

      // The default is the load-bearing half: an absent flag has to mean "every tool", because
      // that is what an empty list meant when these rows were written. `0` — "no tools" — is
      // the state this change exists to make *reachable*, so it must never be the fallback.
      const allTools = (
        opened.raw.prepare("PRAGMA table_info(copilots)").all() as {
          name: string;
          dflt_value: string | null;
        }[]
      ).find((c) => c.name === "all_tools");
      expect(allTools?.dflt_value).toBe("1");

      // Gone rather than guessed at an owner — there is no way to infer one.
      expect(opened.raw.prepare("SELECT COUNT(*) AS n FROM copilots").get()).toMatchObject({ n: 0 });

      // The conversation survives, and its link is cleared by `ON DELETE SET NULL`. This is
      // the half that would be a data loss if the delete cascaded through the reference.
      const session = opened.raw
        .prepare("SELECT copilot_id FROM sessions WHERE id = ?")
        .get("s1") as { copilot_id: string | null } | undefined;
      expect(session).toBeDefined();
      expect(session!.copilot_id).toBeNull();
    } finally {
      opened.raw.close();
    }
  });

  it("refuses a file that predates versioning, rather than adopting it", () => {
    // Version 0 *with tables* is a database written before the guard existed, not a new one.
    // Adopting it is how a file whose columns mean something else gets stamped as current
    // and then read with the wrong meaning for every path it holds — with no error anywhere
    // to say so.
    const path = join(root, "unversioned.sqlite");
    writeDbFile(path, 0, true);
    expect(() => createDb(path)).toThrow(/schema v0/);
  });

  it("adds a column a current-version file is missing, rather than reading it wrong", () => {
    // `CREATE TABLE IF NOT EXISTS` skips a table that already exists, so a database written
    // before `messages.stopped` existed would never gain it from the DDL alone — and every
    // read of a stopped turn would then silently answer "not stopped". The `ensureColumn`
    // call in `createDb` is what closes that gap, which is why this is asserted on a file
    // that reports the *current* version: versioning cannot cover an added column.
    const path = join(root, "pre-stopped.sqlite");
    const pre = new Database(path);
    pre.exec(`CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      reasoning TEXT,
      tool_calls TEXT,
      attachments TEXT,
      usage TEXT,
      created_at TEXT NOT NULL
    )`);
    pre.pragma(`user_version = ${SCHEMA_VERSION}`);
    pre.close();

    const opened = createDb(path);
    try {
      const columns = (
        opened.raw.prepare("PRAGMA table_info(messages)").all() as { name: string }[]
      ).map((c) => c.name);
      expect(columns).toContain("stopped");

      // And it is usable, not merely present: the default covers existing rows and a new
      // one round-trips.
      opened.createUser({ id: OWNER, username: "tester", slug: "tester" });
      opened.createWorkspace({ userId: OWNER, id: "w1", name: "W", slug: "w1", dirPath: join(root, "w1") });
      opened.createSession({
        id: "s1",
        workspaceId: "w1",
        copilotId: null,
        copilotName: "",
        systemPrompt: "",
        allTools: true,
        tools: [],
        title: "t",
      });
      expect(
        opened.createMessage({ id: "m1", sessionId: "s1", role: "assistant", content: "cut short", stopped: true })
          .stopped
      ).toBe(true);
    } finally {
      opened.raw.close();
    }
  });

  it("refuses a file written by a different version", () => {
    const path = join(root, "other.sqlite");
    writeDbFile(path, SCHEMA_VERSION + 1, true);
    expect(() => createDb(path)).toThrow(new RegExp(`schema v${SCHEMA_VERSION + 1}`));
  });

  it("leaves a refused file's schema and version exactly as they were", () => {
    // The refusal is only worth having if it is inert. A file half-changed on the way out
    // would be worse than an untouched one, because the next attempt would find it modified.
    const path = join(root, "refused.sqlite");
    writeDbFile(path, SCHEMA_VERSION + 7, true);
    expect(() => createDb(path)).toThrow();

    expect(tablesIn(path)).toEqual(["something"]);
    const raw = new Database(path);
    try {
      expect(raw.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION + 7);
    } finally {
      raw.close();
    }
  });
});

describe("suspended ask_user calls", () => {
  beforeEach(() => {
    addWorkspace();
    addSession("s1", { title: "t" });
    addSession("s2", { title: "other" });
  });

  /** An assistant message holding one `ask_user` call in the given state. */
  function askMessage(
    id: string,
    sessionId: string,
    toolCallId: string,
    status: ToolCall["status"]
  ): void {
    db.createMessage({
      id,
      sessionId,
      role: "assistant",
      content: "需要确认一件事。",
      toolCalls: [
        { id: toolCallId, name: "ask_user", input: JSON.stringify({ questions: [] }), status },
        { id: `${toolCallId}-read`, name: "read_file", input: "{}", output: "ok" },
      ],
    });
  }

  it("round-trips the status and the structured answer", () => {
    // Both live inside the `tool_calls` JSON blob, so this is also the check that adding
    // them needed no migration and no new column.
    db.createMessage({
      id: "m1",
      sessionId: "s1",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call_1",
          name: "ask_user",
          input: JSON.stringify({ questions: [] }),
          output: "{}",
          status: "answered",
          answer: { "0": { selected: ["OAuth"] } },
        },
      ],
    });

    expect(db.getMessageForUser("m1", OWNER)!.toolCalls![0]).toMatchObject({
      status: "answered",
      answer: { "0": { selected: ["OAuth"] } },
    });
  });

  it("finds an awaiting call, and only within its own session", () => {
    askMessage("m1", "s1", "call_1", "awaiting");

    expect(db.findAwaitingToolCall("s1", "call_1")).toMatchObject({ messageId: "m1" });
    // The id is client-supplied, so a bare lookup would let one conversation answer
    // another's question.
    expect(db.findAwaitingToolCall("s2", "call_1")).toBeUndefined();
  });

  it("does not find a call that is no longer awaiting", () => {
    askMessage("m1", "s1", "call_1", "answered");

    expect(db.findAwaitingToolCall("s1", "call_1")).toBeUndefined();
  });

  it("rewrites a message's tool calls wholesale", () => {
    askMessage("m1", "s1", "call_1", "awaiting");
    const calls = db.getMessageForUser("m1", OWNER)!.toolCalls!;

    db.updateMessageToolCalls(
      "m1",
      calls.map((tc) => (tc.id === "call_1" ? { ...tc, status: "answered" as const, output: "{}" } : tc))
    );

    expect(db.getMessageForUser("m1", OWNER)!.toolCalls![0]).toMatchObject({
      status: "answered",
      output: "{}",
    });
    // The sibling call is untouched — the update is per call, not per message.
    expect(db.getMessageForUser("m1", OWNER)!.toolCalls![1]).toMatchObject({ id: "call_1-read", output: "ok" });
  });

  it("skips every awaiting call in a session and reports which calls retired", () => {
    askMessage("m1", "s1", "call_1", "awaiting");
    askMessage("m2", "s1", "call_2", "awaiting");
    askMessage("m3", "s2", "call_3", "awaiting");

    expect(db.skipAwaitingToolCalls("s1")).toEqual([
      { id: "call_1", name: "ask_user" },
      { id: "call_2", name: "ask_user" },
    ]);

    expect(db.getMessageForUser("m1", OWNER)!.toolCalls![0]!.status).toBe("skipped");
    expect(db.getMessageForUser("m2", OWNER)!.toolCalls![0]!.status).toBe("skipped");
    // Another session's question is none of this one's business.
    expect(db.getMessageForUser("m3", OWNER)!.toolCalls![0]!.status).toBe("awaiting");
  });

  it("lists awaiting calls without retiring them", () => {
    askMessage("m1", "s1", "call_1", "awaiting");
    expect(db.listAwaitingToolCalls("s1")).toEqual([{ id: "call_1", name: "ask_user" }]);
    expect(db.getMessageForUser("m1", OWNER)!.toolCalls![0]!.status).toBe("awaiting");
  });

  it("leaves a settled call alone", () => {
    askMessage("m1", "s1", "call_1", "answered");

    expect(db.skipAwaitingToolCalls("s1")).toEqual([]);
    expect(db.getMessageForUser("m1", OWNER)!.toolCalls![0]!.status).toBe("answered");
  });

  it("does not give a skipped call an output", () => {
    // That absence is the whole mechanism: `buildHistoryMessages` drops a tool call with
    // no output, which is what keeps a walked-away question out of the model's context.
    askMessage("m1", "s1", "call_1", "awaiting");

    db.skipAwaitingToolCalls("s1");

    expect(db.getMessageForUser("m1", OWNER)!.toolCalls![0]!.output).toBeUndefined();
  });
});

describe("counters", () => {
  it("reserves the first block from 1, then continues from where it stopped", () => {
    expect(db.reserveCounter("session", "s1", "quiz_question", 3)).toEqual([1, 2, 3]);
    expect(db.reserveCounter("session", "s1", "quiz_question", 2)).toEqual([4, 5]);
  });

  it("keeps each sequence independent of every other", () => {
    // All three parts of the name are part of the identity, so the same counter can exist
    // per session, per user or per workspace without the callers agreeing on more than that.
    db.reserveCounter("session", "s1", "quiz_question", 2);

    expect(db.reserveCounter("session", "s2", "quiz_question", 1)).toEqual([1]);
    expect(db.reserveCounter("session", "s1", "other_thing", 1)).toEqual([1]);
    expect(db.reserveCounter("workspace", "s1", "quiz_question", 1)).toEqual([1]);
  });

  it("writes no row for an empty block", () => {
    // A counter sitting at 0 for a sequence nothing ever asked a number from is a row with
    // no reader.
    expect(db.reserveCounter("session", "s1", "quiz_question", 0)).toEqual([]);
    expect((db.raw.prepare("SELECT COUNT(*) AS n FROM counters").get() as { n: number }).n).toBe(0);
  });

  it("survives a reopen of the same file", () => {
    // The counter *is* the record rather than a cache of one: a second process must continue
    // the sequence, not restart it, or a session's question ids would collide after a restart.
    const path = join(root, "counters.sqlite");
    const first = createDb(path);
    try {
      expect(first.reserveCounter("session", "s1", "quiz_question", 2)).toEqual([1, 2]);
    } finally {
      first.raw.close();
    }

    const second = createDb(path);
    try {
      expect(second.reserveCounter("session", "s1", "quiz_question", 1)).toEqual([3]);
    } finally {
      second.raw.close();
    }
  });
});
