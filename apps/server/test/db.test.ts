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

let root: string;
let db: AppDb;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gl-db-"));
  db = createDb(join(root, "test.sqlite"));
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
  db.createWorkspace({ id, name: "W", slug: id, dirPath: join(root, id) });
  return id;
}

describe("workspaces", () => {
  it("creates and reads back a workspace", () => {
    const created = db.createWorkspace({ id: "w1", name: "Notes", slug: "notes", dirPath: "/tmp/notes" });
    expect(created).toMatchObject({ id: "w1", name: "Notes", slug: "notes", dirPath: "/tmp/notes" });
    expect(db.getWorkspace("w1")).toEqual(created);
  });

  it("returns undefined for an unknown id", () => {
    expect(db.getWorkspace("nope")).toBeUndefined();
  });

  it("lists workspaces oldest first", () => {
    addWorkspace("w1");
    addWorkspace("w2");
    expect(db.listWorkspaces().map((w) => w.id)).toEqual(["w1", "w2"]);
  });

  it("deletes a workspace", () => {
    addWorkspace("w1");
    db.deleteWorkspace("w1");
    expect(db.getWorkspace("w1")).toBeUndefined();
  });

  it("counts each workspace's sessions and dates its last activity", () => {
    addWorkspace("w1");
    addWorkspace("w2");
    db.createSession({ id: "s1", workspaceId: "w1", copilotId: null, title: "a" });
    db.createSession({ id: "s2", workspaceId: "w1", copilotId: null, title: "b" });

    const [first, second] = db.listWorkspaces();

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

    const renamed = db.renameWorkspace("w1", "Renamed")!;

    expect(renamed.name).toBe("Renamed");
    // Not an identity change: the directory is where the agent's files already live.
    expect(renamed.slug).toBe("w1");
    expect(renamed.dirPath).toBe(join(root, "w1"));
    // The response drives a card replacement in the client, so it has to carry the numbers
    // that card renders rather than the bare-row defaults.
    expect(renamed.sessionCount).toBe(1);
    expect(renamed.lastActivityAt).toBeTruthy();
    expect(db.getWorkspace("w1")?.name).toBe("Renamed");
  });

  it("returns undefined when renaming a workspace that is not there", () => {
    expect(db.renameWorkspace("nope", "x")).toBeUndefined();
  });

  it("does not hand back a bare row from createWorkspace or getWorkspace", () => {
    // Both default the stats rather than joining for them, which is only safe because a
    // brand-new workspace cannot have conversations and getWorkspace is an existence check.
    const created = db.createWorkspace({ id: "w1", name: "W", slug: "w1", dirPath: "/tmp/w1" });
    expect(created.sessionCount).toBe(0);
    expect(created.lastActivityAt).toBeNull();
    expect(db.getWorkspace("w1")).toEqual(created);
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
    const renamed = db.updateSession("s1", { title: "  My Notes  " });
    expect(renamed!.title).toBe("My Notes");
    expect(renamed!.titleSource).toBe("user");
  });

  it("ignores a blank title, leaving the existing one in place", () => {
    db.createSession({ id: "s1", workspaceId: "w1", copilotId: null, title: "Kept" });
    const updated = db.updateSession("s1", { title: "   " });
    expect(updated!.title).toBe("Kept");
    expect(updated!.titleSource).toBe("auto");
  });

  it("keeps the title ownership flag on a settings-only update", () => {
    db.createSession({ id: "s1", workspaceId: "w1", copilotId: null, title: DEFAULT_SESSION_TITLE });
    db.updateSession("s1", { title: "Mine" });
    const updated = db.updateSession("s1", { settings: { temperature: 0.7 } });
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
    const updated = db.updateSession("s1", { settings: { maxSteps: 9 } });
    expect(updated!.settings).toEqual({ temperature: 0.1, maxSteps: 9 });
  });

  it("lets the auto-titler rename without taking ownership", () => {
    db.createSession({ id: "s1", workspaceId: "w1", copilotId: null, title: DEFAULT_SESSION_TITLE });
    const titled = db.setAutoTitle("s1", "Model Chose This");
    expect(titled!.title).toBe("Model Chose This");
    expect(titled!.titleSource).toBe("auto");
  });

  it("returns undefined from setAutoTitle for a missing session", () => {
    expect(db.setAutoTitle("nope", "x")).toBeUndefined();
  });

  it("returns undefined from updateSession for a missing session", () => {
    expect(db.updateSession("nope", { title: "x" })).toBeUndefined();
  });

  it("lists a workspace's sessions, most recently updated first", () => {
    db.createSession({ id: "s1", workspaceId: "w1", copilotId: null, title: "one" });
    db.createSession({ id: "s2", workspaceId: "w1", copilotId: null, title: "two" });

    // Timestamps are millisecond-resolution, so rows created in the same tick tie and
    // the order between them is arbitrary. Pin them to make the assertion deterministic.
    const stamp = db.raw.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?");
    stamp.run("2026-01-01T00:00:00.000Z", "s1");
    stamp.run("2026-01-02T00:00:00.000Z", "s2");
    expect(db.listSessions("w1").map((s) => s.id)).toEqual(["s2", "s1"]);

    db.touchSession("s1"); // bumps s1 to now, which is later than both
    expect(db.listSessions("w1").map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  it("repoints the session at another copilot", () => {
    db.createCopilot({ id: "c1", name: "C", description: "", systemPrompt: "", tools: [], settings: {} });
    db.createSession({ id: "s1", workspaceId: "w1", copilotId: null, title: "t" });
    db.setSessionCopilot("s1", "c1");
    expect(db.getSession("s1")!.copilotId).toBe("c1");
  });

  it("cascades messages away with the session", () => {
    db.createSession({ id: "s1", workspaceId: "w1", copilotId: null, title: "t" });
    db.createMessage({ id: "m1", sessionId: "s1", role: "user", content: "hi" });
    db.deleteSession("s1");
    expect(db.listMessages("s1")).toEqual([]);
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
    expect(db.listMessages("s1").map((m) => m.content)).toEqual(["one", "two"]);
  });

  it("keeps messages of different sessions apart", () => {
    db.createSession({ id: "s2", workspaceId: "w1", copilotId: null, title: "t" });
    db.createMessage({ id: "m1", sessionId: "s1", role: "user", content: "in s1" });
    expect(db.listMessages("s2")).toEqual([]);
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

describe("migrations", () => {
  /** A database as it existed before attachments/usage/reasoning/settings/title_source. */
  function writeLegacyDb(path: string): void {
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
        dir_path TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
      );
      CREATE TABLE copilots (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
        system_prompt TEXT NOT NULL, model TEXT, tools TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, copilot_id TEXT,
        title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
        content TEXT NOT NULL, tool_calls TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE providers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL, api_key TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE models (
        id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, model_id TEXT NOT NULL, name TEXT NOT NULL,
        context_window INTEGER, max_output INTEGER, capabilities TEXT NOT NULL DEFAULT '[]',
        sort_order INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);

    const now = new Date().toISOString();
    legacy
      .prepare("INSERT INTO workspaces VALUES (?,?,?,?,?)")
      .run("w1", "W", "w1", "/tmp/w1", now);
    legacy
      .prepare("INSERT INTO copilots VALUES (?,?,?,?,?,?,?,?)")
      .run("c1", "Legacy", "", "prompt", "legacy-model", "[]", now, now);
    const insertSession = legacy.prepare("INSERT INTO sessions VALUES (?,?,?,?,?,?)");
    insertSession.run("s-auto", "w1", "c1", "New conversation", now, now);
    insertSession.run("s-hand", "w1", null, "Hand written title", now, now);
    insertSession.run("s-blank", "w1", null, "", now, now);
    legacy
      .prepare("INSERT INTO messages VALUES (?,?,?,?,?,?)")
      .run("m1", "s-auto", "user", "hello", null, now);
    legacy.close();
  }

  it("adds the missing columns and backfills without losing data", () => {
    const path = join(root, "legacy.sqlite");
    writeLegacyDb(path);
    const migrated = createDb(path);
    try {
      // Rows survive the ALTER TABLEs.
      expect(migrated.listWorkspaces()).toHaveLength(1);
      expect(migrated.getMessage("m1")).toMatchObject({ content: "hello" });

      // New columns exist and default sensibly on old rows.
      expect(migrated.getMessage("m1")!.reasoning).toBeUndefined();
      expect(migrated.getMessage("m1")!.usage).toBeUndefined();
      expect(migrated.getMessage("m1")!.attachments).toBeUndefined();

      // The legacy `copilots.model` column is folded into settings.modelId.
      expect(migrated.getCopilot("c1")!.settings).toEqual({ modelId: "legacy-model" });

      // A pre-existing non-placeholder title is assumed to be hand-written.
      expect(migrated.getSession("s-hand")!.titleSource).toBe("user");
      expect(migrated.getSession("s-auto")!.titleSource).toBe("auto");
      expect(migrated.getSession("s-blank")!.titleSource).toBe("auto");
    } finally {
      migrated.raw.close();
    }
  });

  it("does not re-run the title backfill on later boots", () => {
    // Regression: run on every boot, the backfill also rewrote titles the *auto-titler*
    // had written (it stores them with title_source = 'auto'), permanently locking
    // conversations no person ever renamed.
    const path = join(root, "restart.sqlite");
    const first = createDb(path);
    first.createWorkspace({ id: "w1", name: "W", slug: "w1", dirPath: join(root, "w1") });
    first.createSession({ id: "s1", workspaceId: "w1", copilotId: null, title: DEFAULT_SESSION_TITLE });
    first.setAutoTitle("s1", "Model Wrote This");
    first.raw.close();

    const second = createDb(path);
    try {
      expect(second.getSession("s1")).toMatchObject({
        title: "Model Wrote This",
        titleSource: "auto",
      });
    } finally {
      second.raw.close();
    }
  });
});
