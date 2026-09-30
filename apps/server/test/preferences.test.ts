import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PREFERENCE_CONTENT_MAX } from "@ilearnassist/shared";
import { DEFAULT_SESSION_TITLE, createDb, newId, type AppDb } from "../src/db.js";
import {
  formatPreferences,
  parseExtractedPreference,
  preferencesBlock,
  savePreference,
} from "../src/preferences.js";

/**
 * The preference store: the one write, the effective switch, and the two pure renderers.
 *
 * The conflict rule is the heart of it and gets the most attention: a replacement has to delete
 * the old row *and* insert the new one in one transaction, and an id the conversation does not
 * hold has to refuse the whole write rather than being skipped — a delete that did not happen
 * must never look like one.
 */

let root: string;
let db: AppDb;
const OWNER = "u1";
const OTHER = "u2";
const SESSION = "s1";
const OTHER_SESSION = "s2";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gl-preferences-"));
  db = createDb(join(root, "test.sqlite"));
  db.createUser({ id: OWNER, username: "tester", slug: "tester" });
  db.createUser({ id: OTHER, username: "other", slug: "other" });
  db.createWorkspace({ userId: OWNER, id: "w1", name: "W", slug: "w1", dirPath: join(root, "w1") });
  db.createWorkspace({ userId: OTHER, id: "w2", name: "W2", slug: "w2", dirPath: join(root, "w2") });
  for (const [id, workspaceId] of [
    [SESSION, "w1"],
    [OTHER_SESSION, "w2"],
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

describe("savePreference", () => {
  it("records a session-level row with its source and message", () => {
    const { preference, preferences } = savePreference(db, OWNER, SESSION, {
      type: "positive",
      content: "回答先给结论",
      source: "auto",
    });
    expect(preference).toMatchObject({
      scope: "session",
      scopeId: SESSION,
      type: "positive",
      content: "回答先给结论",
      source: "auto",
    });
    expect(preferences).toEqual([preference]);

    const manual = savePreference(db, OWNER, SESSION, {
      type: "negative",
      content: "不要使用表格",
      source: "manual",
      sourceMessageId: "m1",
    });
    expect(manual.preference.source).toBe("manual");
    expect(manual.preferences).toHaveLength(2);
  });

  it("deletes every named preference and inserts the replacement in one write", () => {
    const first = savePreference(db, OWNER, SESSION, {
      type: "positive",
      content: "回答先给结论",
      source: "auto",
    });
    const second = savePreference(db, OWNER, SESSION, {
      type: "negative",
      content: "不要用列表回答",
      source: "auto",
    });

    const replaced = savePreference(db, OWNER, SESSION, {
      type: "positive",
      content: "回答都用条目列表",
      source: "auto",
      replaces: [first.preference.id, second.preference.id],
    });

    // The old rows are gone from every read, and only the new one stands.
    expect(replaced.preferences.map((p) => p.id)).toEqual([replaced.preference.id]);
    expect(db.listSessionPreferencesForUser(OWNER, SESSION)).toEqual(replaced.preferences);
    // A soft delete: the row is still in the table, which is what makes "this replaced that"
    // inspectable later — and the reason the table carries `deleted_at` at all.
    const raw = db.raw
      .prepare("SELECT id, deleted_at FROM user_preferences WHERE id IN (?, ?)")
      .all(first.preference.id, second.preference.id) as { deleted_at: string | null }[];
    expect(raw).toHaveLength(2);
    expect(raw.every((row) => row.deleted_at !== null)).toBe(true);
  });

  it("refuses an unknown replace id and writes nothing", () => {
    const kept = savePreference(db, OWNER, SESSION, {
      type: "positive",
      content: "回答先给结论",
      source: "auto",
    });
    expect(() =>
      savePreference(db, OWNER, SESSION, {
        type: "negative",
        content: "不要用表格",
        source: "auto",
        replaces: ["no-such-id"],
      })
    ).toThrow(/no-such-id/);
    // The refusal is total: the old rule stands and no new row landed.
    expect(db.listSessionPreferencesForUser(OWNER, SESSION)).toEqual([kept.preference]);
  });

  it("cannot replace a preference that belongs to another conversation", () => {
    // Written through the *other* account's session, then named from this one — the owner and
    // the session are both in the read the validation is against, so it is simply unknown here.
    const foreign = savePreference(db, OTHER, OTHER_SESSION, {
      type: "positive",
      content: "用英文回答",
      source: "auto",
    });
    expect(() =>
      savePreference(db, OWNER, SESSION, {
        type: "positive",
        content: "用中文回答",
        source: "auto",
        replaces: [foreign.preference.id],
      })
    ).toThrow(/no live preference/);
    expect(db.listSessionPreferencesForUser(OTHER, OTHER_SESSION)).toHaveLength(1);
  });

  it("refuses an empty or oversized rule before writing", () => {
    expect(() =>
      savePreference(db, OWNER, SESSION, { type: "positive", content: "   ", source: "auto" })
    ).toThrow(/empty/);
    expect(() =>
      savePreference(db, OWNER, SESSION, {
        type: "positive",
        content: "x".repeat(PREFERENCE_CONTENT_MAX + 1),
        source: "auto",
      })
    ).toThrow(/limit/);
    expect(db.listSessionPreferencesForUser(OWNER, SESSION)).toEqual([]);
  });
});

describe("formatPreferences", () => {
  it("renders one element per row carrying its id, scope and type", () => {
    const saved = savePreference(db, OWNER, SESSION, {
      type: "negative",
      content: "不要使用表格",
      source: "auto",
    }).preference;
    const text = formatPreferences([saved]);
    expect(text).toContain(`<preference id="${saved.id}" scope="session" type="negative">`);
    expect(text).toContain("不要使用表格");
    expect(text.endsWith("</preference>")).toBe(true);
  });

  it("substitutes the rows into the catalog block, precedence sentence included", () => {
    const saved = savePreference(db, OWNER, SESSION, {
      type: "positive",
      content: "回答先给结论",
      source: "auto",
    }).preference;
    const block = preferencesBlock([saved]);
    expect(block).toContain("<user_preferences>");
    expect(block).toContain("回答先给结论");
    // The scope precedence is the part a list of rows cannot state — one of the sentences the
    // catalog entry exists for, and a reflow that dropped it would go unnoticed otherwise.
    expect(block).toContain("session rule overrides a workspace rule");
  });
});

describe("parseExtractedPreference", () => {
  it("reads a saved answer, fence and prose included", () => {
    const parsed = parseExtractedPreference(
      '好的，这是结果：\n```json\n{"status":"saved","type":"negative","content":"不要使用表格",' +
        '"replaces":["a","a","b"]}\n```'
    );
    expect(parsed).toEqual({
      status: "saved",
      type: "negative",
      content: "不要使用表格",
      replaces: ["a", "b"],
    });
  });

  it("reads a decline as a usable answer rather than a failure", () => {
    expect(parseExtractedPreference('{"status":"skipped"}')).toEqual({ status: "skipped" });
  });

  it("returns null for anything unusable", () => {
    for (const raw of [
      "no json here",
      '{"status":"saved"}',
      '{"status":"saved","type":"maybe","content":"x"}',
      '{"status":"saved","type":"positive","content":"   "}',
      '{"status":"saved","type":"positive","content":"' + "x".repeat(PREFERENCE_CONTENT_MAX + 1) + '"}',
      '{"status":"other"}',
    ]) {
      expect(parseExtractedPreference(raw), raw).toBeNull();
    }
  });
});

describe("the stored row's identity", () => {
  it("gives each preference a fresh id", () => {
    const a = savePreference(db, OWNER, SESSION, {
      type: "positive",
      content: "规则一",
      source: "auto",
    });
    const b = savePreference(db, OWNER, SESSION, {
      type: "positive",
      content: "规则二",
      source: "auto",
    });
    expect(a.preference.id).not.toBe(b.preference.id);
    expect(newId()).toBeTypeOf("string");
  });
});
