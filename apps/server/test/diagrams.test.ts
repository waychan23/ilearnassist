import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, DEFAULT_SESSION_TITLE, type AppDb } from "../src/db.js";
import { diagramFileName, registerDiagram } from "../src/diagrams.js";

/**
 * The naming rule lives beside the tool that writes the file: the canonical name is on the
 * row now, so the client never derives one and the rule does not need to cross the wire.
 */
describe("diagramFileName", () => {
  it("kebab-cases a name and gives it the diagram extension", () => {
    expect(diagramFileName("Auth Flow")).toBe("auth-flow.mmd");
  });

  it("keeps CJK, because a slug is meant to stay readable", () => {
    // `slugify` filters on `\p{Letter}`, which Han is — deliberately, and the file browser's
    // `?path=` query parameter exists for the same reason (names legitimately hold CJK). A
    // transliteration scheme here would be a name nobody recognises in their own folder.
    expect(diagramFileName("架构图")).toBe("架构图.mmd");
    expect(diagramFileName("登录流程 图")).toBe("登录流程-图.mmd");
  });

  it("falls back when nothing survives the filter", () => {
    // Not "workspace": that is `slugify`'s default and would be a quiet lie about the file.
    expect(diagramFileName("!!!")).toBe("diagram.mmd");
    expect(diagramFileName("")).toBe("diagram.mmd");
    expect(diagramFileName("   ")).toBe("diagram.mmd");
  });

  it("does not double an extension the model already wrote", () => {
    // A model that passes "auth-flow.mmd" means the same diagram as one that passes
    // "auth-flow"; slugify alone would make `auth-flow-mmd.mmd` of it.
    expect(diagramFileName("auth-flow.mmd")).toBe("auth-flow.mmd");
    expect(diagramFileName("auth-flow.mermaid")).toBe("auth-flow.mmd");
    expect(diagramFileName("AUTH-FLOW.MMD")).toBe("auth-flow.mmd");
  });

  it("turns a traversal attempt into an ordinary name", () => {
    // The tool still resolves through the sandbox; this is what makes that a formality.
    expect(diagramFileName("../../etc/passwd")).toBe("etc-passwd.mmd");
    expect(diagramFileName("..")).toBe("diagram.mmd");
    expect(diagramFileName("/etc/passwd")).toBe("etc-passwd.mmd");
  });

  it("never returns a path separator or a leading dot", () => {
    for (const name of ["a/b", "..", ".hidden", "a\\b", "a:b", "/abs"]) {
      const file = diagramFileName(name);
      expect(file).not.toContain("/");
      expect(file).not.toContain("\\");
      expect(file.startsWith(".")).toBe(false);
    }
  });

  it("caps the name and keeps the extension", () => {
    const file = diagramFileName("x".repeat(200));
    expect(file.endsWith(".mmd")).toBe(true);
    expect(file.length).toBe(48 + ".mmd".length);
  });

  it("is stable, so a revise call names the same file", () => {
    // The whole revise mechanism: same name in, same file out, so the second call overwrites
    // rather than leaving two diagrams of one thing on screen.
    expect(diagramFileName("Auth Flow")).toBe(diagramFileName("auth flow"));
    expect(diagramFileName("  auth-flow  ")).toBe(diagramFileName("auth-flow"));
  });
});

/*
 * registerDiagram against a real database. The file is not involved here — the tool test
 * covers file-then-row ordering; this is the upsert rule: one file, one row, revised in
 * place, with the thread judgement reset for the new shape.
 */
describe("registerDiagram", () => {
  let root: string;
  let db: AppDb;
  const SESSION = "s1";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gl-diagrams-db-"));
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

  it("creates one row with the canonical name, unjudged", () => {
    const row = registerDiagram(db, SESSION, {
      name: diagramFileName("Auth Flow"),
      summary: "登录流程",
      toolCallId: "c1",
    });

    expect(row).toMatchObject({
      sessionId: SESSION,
      name: "auth-flow.mmd",
      summary: "登录流程",
      toolCallId: "c1",
      threadId: null,
      threadTitle: null,
    });
    expect(db.listDiagramsBySession(SESSION)).toHaveLength(1);
  });

  it("revises one row in place: new summary and anchor, id and birth kept", () => {
    const first = registerDiagram(db, SESSION, {
      name: "flow.mmd",
      summary: "一版",
      toolCallId: "c1",
    });
    const second = registerDiagram(db, SESSION, {
      name: "flow.mmd",
      summary: "二版",
      toolCallId: "c2",
    });

    const rows = db.listDiagramsBySession(SESSION);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(first.id);
    expect(rows[0]?.summary).toBe("二版");
    expect(rows[0]?.toolCallId).toBe("c2");
    expect(rows[0]?.createdAt).toBe(first.createdAt);
    // updated_at is set to now on the revise; two calls in one millisecond can timestamp
    // equal, so this asserts "never moved backwards" rather than "always later" — the read
    // order's same-ms tiebreak is rowid, not updated_at.
    expect((rows[0]?.updatedAt ?? "") >= first.updatedAt).toBe(true);
    expect(second.id).toBe(first.id);
  });

  it("clears a thread judgement when the drawing is revised", () => {
    /*
     * A revise can be a genuine topic change ("no — draw the deployment topology"), so
     * keeping the old thread files the new drawing under the old chapter. The new shape
     * must be judged again; the upsert clears it and the next thread sync reassigns it.
     */
    registerDiagram(db, SESSION, { name: "flow.mmd", summary: "一版", toolCallId: "c1" });
    db.raw
      .prepare("UPDATE session_diagrams SET thread_id = ? WHERE session_id = ?")
      .run("t-old", SESSION);
    expect(db.listDiagramsBySession(SESSION)[0]?.threadId).toBe("t-old");

    registerDiagram(db, SESSION, { name: "flow.mmd", summary: "二版", toolCallId: "c2" });
    expect(db.listDiagramsBySession(SESSION)[0]?.threadId).toBeNull();
  });

  it("keeps distinct names as distinct rows", () => {
    registerDiagram(db, SESSION, { name: "one.mmd", summary: "一", toolCallId: "c1" });
    registerDiagram(db, SESSION, { name: "two.mmd", summary: "二", toolCallId: "c2" });
    expect(db.listDiagramsBySession(SESSION).map((d) => d.name).sort()).toEqual([
      "one.mmd",
      "two.mmd",
    ]);
  });
});
