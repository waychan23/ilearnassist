import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, DEFAULT_SESSION_TITLE, type AppDb } from "../src/db.js";
import {
  MAX_TABLE_CHARS,
  TABLE_SUMMARY_MAX,
  looksLikeMarkdownTable,
  registerTable,
  tableName,
} from "../src/tables.js";

/**
 * The table row's domain rules, and the one place they differ from a diagram's: there is no file.
 *
 * `diagrams.test.ts` is the template — the naming rule as identity, the revise upsert — with the
 * extension-stripping cases gone (a table name has no extension to strip) and one validator added
 * that the diagram tool deliberately does not have.
 */
describe("tableName", () => {
  it("kebab-cases a name, with no extension", () => {
    // Where `diagramFileName` gives `auth-flow.mmd`, this gives `auth-flow`: the name is a row's
    // identity and a label, not a file name, and an extension would be inventing a file that does
    // not exist.
    expect(tableName("Quarterly Comparison")).toBe("quarterly-comparison");
    expect(tableName("auth-flow")).toBe("auth-flow");
  });

  it("keeps CJK, because a slug is meant to stay readable", () => {
    expect(tableName("季度对比")).toBe("季度对比");
    expect(tableName("季度 对比")).toBe("季度-对比");
  });

  it("falls back when nothing survives the filter", () => {
    // "table", not "workspace" — `slugify`'s default would be a quiet lie about what this is.
    expect(tableName("!!!")).toBe("table");
    expect(tableName("")).toBe("table");
    expect(tableName("   ")).toBe("table");
  });

  it("turns a traversal attempt into an ordinary name", () => {
    // Nothing here touches a filesystem — but the name reaches the client, the viewer and a
    // download attribute, so a path-shaped value is worth normalising at the one place it enters.
    expect(tableName("../../etc/passwd")).toBe("etc-passwd");
  });

  it("never returns a separator or a leading dot", () => {
    for (const name of ["a/b", "..", ".hidden", "a\\b", "a:b", "/abs"]) {
      const canonical = tableName(name);
      expect(canonical).not.toContain("/");
      expect(canonical).not.toContain("\\");
      expect(canonical.startsWith(".")).toBe(false);
    }
  });

  it("caps the name", () => {
    expect(tableName("x".repeat(200)).length).toBe(48);
  });
});

describe("looksLikeMarkdownTable", () => {
  it("accepts a table with a header and a separator row", () => {
    expect(looksLikeMarkdownTable("| 项目 | 数值 |\n| --- | --- |\n| 速度 | 3 |")).toBe(true);
  });

  it("accepts the spellings markdown itself does", () => {
    // Alignment colons, outer pipes omitted, a single column: all of these are tables to
    // markdown-it, so refusing any of them would be refusing something the reply renders.
    expect(looksLikeMarkdownTable("a | b\n--- | ---\n1 | 2")).toBe(true);
    expect(looksLikeMarkdownTable("| a | b |\n| :--- | ---: |\n| 1 | 2 |")).toBe(true);
    expect(looksLikeMarkdownTable("| 项目 |\n| --- |\n| 一个 |")).toBe(true);
  });

  it("refuses prose, a list and a single line", () => {
    // The one thing this validates, and it is the case with no reading in which the caller was
    // right: the panel's claim is that a thing called a table renders as one.
    expect(looksLikeMarkdownTable("这是一段说明。")).toBe(false);
    expect(looksLikeMarkdownTable("- 一\n- 二")).toBe(false);
    expect(looksLikeMarkdownTable("| 项目 | 数值 |")).toBe(false);
    expect(looksLikeMarkdownTable("")).toBe(false);
  });

  it("is not fooled by a line of dashes that is a horizontal rule", () => {
    // `---` alone is a rule to markdown, not a separator row: a separator has cells, and the
    // whole point is that the *table* renders.
    expect(looksLikeMarkdownTable("说明\n\n---\n\n更多说明")).toBe(false);
  });
});

describe("registerTable", () => {
  let root: string;
  let db: AppDb;
  const SESSION = "s1";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gl-tables-"));
    db = createDb(join(root, "test.sqlite"));
    db.createUser({ id: "u1", username: "tester", slug: "tester" });
    db.createWorkspace({ userId: "u1", id: "w1", name: "W", slug: "w1", dirPath: join(root, "w1") });
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

  const TABLE = "| 项目 | 数值 |\n| --- | --- |\n| 速度 | 3 |";

  it("creates one row with the canonical name and the content, unjudged", () => {
    const row = registerTable(db, SESSION, {
      name: tableName("Quarterly Comparison"),
      summary: "季度对比",
      content: TABLE,
      toolCallId: "c1",
    });

    expect(row).toMatchObject({
      sessionId: SESSION,
      name: "quarterly-comparison",
      summary: "季度对比",
      // The row *is* the artifact — the whole reason this table has a content column where
      // `session_diagrams` has none.
      content: TABLE,
      toolCallId: "c1",
      threadId: null,
      threadTitle: null,
    });
    expect(db.listTablesBySession(SESSION)).toHaveLength(1);
  });

  it("revises one row in place: new summary, content and anchor; id and birth kept", () => {
    const first = registerTable(db, SESSION, {
      name: "flow",
      summary: "一版",
      content: TABLE,
      toolCallId: "c1",
    });
    const second = registerTable(db, SESSION, {
      name: "flow",
      summary: "二版",
      content: "| a |\n| --- |\n| 1 |",
      toolCallId: "c2",
    });

    const rows = db.listTablesBySession(SESSION);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(first.id);
    expect(rows[0]?.summary).toBe("二版");
    // Content moves as well as the summary, which the diagram's row has no field for: a revise
    // that moved the label and not the table would leave the panel showing the old one under a
    // new name.
    expect(rows[0]?.content).toBe("| a |\n| --- |\n| 1 |");
    expect(rows[0]?.toolCallId).toBe("c2");
    expect(rows[0]?.createdAt).toBe(first.createdAt);
    expect((rows[0]?.updatedAt ?? "") >= first.updatedAt).toBe(true);
    expect(second.id).toBe(first.id);
  });

  it("clears a thread judgement when the table is revised", () => {
    // The diagram's rule: a revise can be a genuine topic change, so the new shape has to be
    // judged again rather than filed under the old chapter.
    registerTable(db, SESSION, { name: "flow", summary: "一版", content: TABLE, toolCallId: "c1" });
    db.raw.prepare("UPDATE session_tables SET thread_id = ? WHERE session_id = ?").run("t-old", SESSION);
    expect(db.listTablesBySession(SESSION)[0]?.threadId).toBe("t-old");

    registerTable(db, SESSION, { name: "flow", summary: "二版", content: TABLE, toolCallId: "c2" });
    expect(db.listTablesBySession(SESSION)[0]?.threadId).toBeNull();
  });

  it("keeps distinct names as distinct rows", () => {
    registerTable(db, SESSION, { name: "a", summary: "s", content: TABLE, toolCallId: "c1" });
    registerTable(db, SESSION, { name: "b", summary: "s", content: TABLE, toolCallId: "c2" });
    expect(db.listTablesBySession(SESSION)).toHaveLength(2);
  });

  it("blanks the content in the classifier's read, and keeps it in the panel's", () => {
    /*
     * The one read that is not the same read. A table's markdown is thousands of characters and
     * the thread classifier is shown a name and a summary, so the briefs projection carries an
     * empty string rather than the table — the pair is asserted together because the value of the
     * optimisation is exactly that the other read is unaffected.
     */
    registerTable(db, SESSION, { name: "flow", summary: "s", content: TABLE, toolCallId: "c1" });

    const [brief] = db.listTableBriefsBySession(SESSION);
    expect(brief?.content).toBe("");
    expect(brief?.name).toBe("flow");
    expect(brief?.summary).toBe("s");
    expect(db.listTablesBySession(SESSION)[0]?.content).toBe(TABLE);
  });

  it("has no ownerless way in: the ForUser list is the API's read", () => {
    registerTable(db, SESSION, { name: "flow", summary: "s", content: TABLE, toolCallId: "c1" });
    expect(db.listTablesForUser("u1", SESSION)).toHaveLength(1);
    expect(db.listTablesForUser("someone-else", SESSION)).toEqual([]);
  });
});

describe("the caps", () => {
  it("are server-local, so the client has no number to enforce", () => {
    // Asserted rather than described: the reason `MAX_TABLE_CHARS` is not in `packages/shared`
    // (unlike `MAX_DIAGRAM_CHARS`) is that nothing on the client refuses a table — markdown
    // rendering is linear, where laying out a diagram is not.
    expect(MAX_TABLE_CHARS).toBeGreaterThan(TABLE_SUMMARY_MAX);
    expect(MAX_TABLE_CHARS).toBe(16 * 1024);
  });
});
