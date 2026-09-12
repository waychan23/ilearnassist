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
import type { ToolCall } from "@ilearnassist/shared";
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

  it("deletes a workspace", () => {
    addWorkspace("w1");
    db.deleteWorkspaceForUser("w1", OWNER);
    expect(db.getWorkspaceForUser("w1", OWNER)).toBeUndefined();
  });

  it("counts each workspace's sessions and dates its last activity", () => {
    addWorkspace("w1");
    addWorkspace("w2");
    db.createSession({ id: "s1", workspaceId: "w1", copilotId: null, title: "a" });
    db.createSession({ id: "s2", workspaceId: "w1", copilotId: null, title: "b" });

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
    db.createSession({ id: "s1", workspaceId: "w1", copilotId: null, title: "a" });

    const renamed = db.renameWorkspaceForUser("w1", OWNER, "Renamed")!;

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
    expect(db.renameWorkspaceForUser("nope", OWNER, "x")).toBeUndefined();
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
  const input = {
    id: "c1",
    name: "Tutor",
    description: "helps",
    systemPrompt: "You teach.",
    tools: ["read_file", "web_search"],
    settings: { temperature: 0.3, modelId: "m1" },
  };

  it("round-trips tools and settings through JSON columns", () => {
    const created = db.createCopilot(input);
    expect(created.tools).toEqual(["read_file", "web_search"]);
    expect(created.settings).toEqual({ temperature: 0.3, modelId: "m1" });
  });

  it("updates in place and bumps updatedAt", () => {
    const created = db.createCopilot(input);
    const updated = db.updateCopilot("c1", {
      name: "Coach",
      description: "",
      systemPrompt: "S",
      tools: [],
      settings: {},
    });
    expect(updated).toMatchObject({ name: "Coach", tools: [], settings: {} });
    expect(updated!.updatedAt >= created.updatedAt).toBe(true);
  });

  it("returns undefined when updating a missing copilot", () => {
    expect(db.updateCopilot("nope", input)).toBeUndefined();
  });

  it("deletes a copilot", () => {
    db.createCopilot(input);
    db.deleteCopilot("c1");
    expect(db.getCopilot("c1")).toBeUndefined();
  });

  it("tolerates corrupt JSON in a JSON column", () => {
    // A hand-edited or truncated column must degrade to an empty value, not throw.
    db.createCopilot(input);
    db.raw.prepare("UPDATE copilots SET tools = ? WHERE id = ?").run("{not json", "c1");
    expect(db.getCopilot("c1")!.tools).toEqual([]);
    expect(db.getCopilot("c1")!.settings).toEqual({ temperature: 0.3, modelId: "m1" });

    db.raw.prepare("UPDATE copilots SET settings = ? WHERE id = ?").run("[1,2]", "c1");
    expect(db.getCopilot("c1")!.settings).toEqual({});
  });
});

describe("sessions", () => {
  beforeEach(() => addWorkspace());

  it("starts life auto-titled", () => {
    const session = db.createSession({
      id: "s1",
      workspaceId: "w1",
      copilotId: null,
      title: DEFAULT_SESSION_TITLE,
    });
    expect(session.titleSource).toBe("auto");
    expect(session.settings).toEqual({});
  });

  it("flips to user-titled when a title is supplied", () => {
    db.createSession({ id: "s1", workspaceId: "w1", copilotId: null, title: DEFAULT_SESSION_TITLE });
    const renamed = db.updateSessionForUser("s1", OWNER, { title: "  My Notes  " });
    expect(renamed!.title).toBe("My Notes");
    expect(renamed!.titleSource).toBe("user");
  });

  it("ignores a blank title, leaving the existing one in place", () => {
    db.createSession({ id: "s1", workspaceId: "w1", copilotId: null, title: "Kept" });
    const updated = db.updateSessionForUser("s1", OWNER, { title: "   " });
    expect(updated!.title).toBe("Kept");
    expect(updated!.titleSource).toBe("auto");
  });

  it("keeps the title ownership flag on a settings-only update", () => {
    db.createSession({ id: "s1", workspaceId: "w1", copilotId: null, title: DEFAULT_SESSION_TITLE });
    db.updateSessionForUser("s1", OWNER, { title: "Mine" });
    const updated = db.updateSessionForUser("s1", OWNER, { settings: { temperature: 0.7 } });
    expect(updated!.titleSource).toBe("user");
    expect(updated!.title).toBe("Mine");
  });

  it("merges settings rather than replacing them", () => {
    db.createSession({
      id: "s1",
      workspaceId: "w1",
      copilotId: null,
      title: "t",
      settings: { temperature: 0.1, maxSteps: 5 },
    });
    const updated = db.updateSessionForUser("s1", OWNER, { settings: { maxSteps: 9 } });
    expect(updated!.settings).toEqual({ temperature: 0.1, maxSteps: 9 });
  });

  it("lets the auto-titler rename without taking ownership", () => {
    db.createSession({ id: "s1", workspaceId: "w1", copilotId: null, title: DEFAULT_SESSION_TITLE });
    const titled = db.setAutoTitleForUser("s1", OWNER, "Model Chose This");
    expect(titled!.title).toBe("Model Chose This");
    expect(titled!.titleSource).toBe("auto");
  });

  it("returns undefined from setAutoTitle for a missing session", () => {
    expect(db.setAutoTitleForUser("nope", OWNER, "x")).toBeUndefined();
  });

  it("returns undefined from updateSession for a missing session", () => {
    expect(db.updateSessionForUser("nope", OWNER, { title: "x" })).toBeUndefined();
  });

  it("lists a workspace's sessions, most recently updated first", () => {
    db.createSession({ id: "s1", workspaceId: "w1", copilotId: null, title: "one" });
    db.createSession({ id: "s2", workspaceId: "w1", copilotId: null, title: "two" });

    // Timestamps are millisecond-resolution, so rows created in the same tick tie and
    // the order between them is arbitrary. Pin them to make the assertion deterministic.
    const stamp = db.raw.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?");
    stamp.run("2026-01-01T00:00:00.000Z", "s1");
    stamp.run("2026-01-02T00:00:00.000Z", "s2");
    expect(db.listSessionsForUser("w1", OWNER).map((s) => s.id)).toEqual(["s2", "s1"]);

    db.touchSession("s1"); // bumps s1 to now, which is later than both
    expect(db.listSessionsForUser("w1", OWNER).map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  it("repoints the session at another copilot", () => {
    db.createCopilot({ id: "c1", name: "C", description: "", systemPrompt: "", tools: [], settings: {} });
    db.createSession({ id: "s1", workspaceId: "w1", copilotId: null, title: "t" });
    db.setSessionCopilot("s1", "c1");
    expect(db.getSessionForUser("s1", OWNER)!.session.copilotId).toBe("c1");
  });

  it("cascades messages away with the session", () => {
    db.createSession({ id: "s1", workspaceId: "w1", copilotId: null, title: "t" });
    db.createMessage({ id: "m1", sessionId: "s1", role: "user", content: "hi" });
    db.deleteSessionForUser("s1", OWNER);
    expect(db.listMessagesForUser("s1", OWNER)).toEqual([]);
  });
});

describe("messages", () => {
  beforeEach(() => {
    addWorkspace();
    db.createSession({ id: "s1", workspaceId: "w1", copilotId: null, title: "t" });
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
    db.createSession({ id: "s2", workspaceId: "w1", copilotId: null, title: "t" });
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

  it("orders models per provider and cascades on delete", () => {
    db.createProvider({ id: "p1", name: "One", baseURL: "http://1" });
    db.createProvider({ id: "p2", name: "Two", baseURL: "http://2" });
    db.createModel({ id: "m1", providerId: "p1", modelId: "a", name: "A", capabilities: ["tool_use"] });
    db.createModel({ id: "m2", providerId: "p1", modelId: "b", name: "B", capabilities: [] });
    db.createModel({ id: "m3", providerId: "p2", modelId: "c", name: "C", capabilities: [] });

    expect(db.getProvider("p1")!.models.map((m) => m.modelId)).toEqual(["a", "b"]);
    db.deleteProvider("p1");
    expect(db.getProvider("p1")).toBeUndefined();
    expect(db.listProviders().map((p) => p.id)).toEqual(["p2"]);
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

  it("reports whether a model delete actually removed anything", () => {
    db.createProvider({ id: "p1", name: "One", baseURL: "http://1" });
    db.createModel({ id: "m1", providerId: "p1", modelId: "a", name: "A", capabilities: [] });
    expect(db.deleteModel("m1")).toBe(true);
    expect(db.deleteModel("m1")).toBe(false);
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
      opened.createSession({ id: "s1", workspaceId: "w1", copilotId: null, title: "t" });
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
    db.createSession({ id: "s1", workspaceId: "w1", copilotId: null, title: "t" });
    db.createSession({ id: "s2", workspaceId: "w1", copilotId: null, title: "other" });
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

  it("skips every awaiting call in a session and reports how many", () => {
    askMessage("m1", "s1", "call_1", "awaiting");
    askMessage("m2", "s1", "call_2", "awaiting");
    askMessage("m3", "s2", "call_3", "awaiting");

    expect(db.skipAwaitingToolCalls("s1")).toBe(2);

    expect(db.getMessageForUser("m1", OWNER)!.toolCalls![0]!.status).toBe("skipped");
    expect(db.getMessageForUser("m2", OWNER)!.toolCalls![0]!.status).toBe("skipped");
    // Another session's question is none of this one's business.
    expect(db.getMessageForUser("m3", OWNER)!.toolCalls![0]!.status).toBe("awaiting");
  });

  it("leaves a settled call alone", () => {
    askMessage("m1", "s1", "call_1", "answered");

    expect(db.skipAwaitingToolCalls("s1")).toBe(0);
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
