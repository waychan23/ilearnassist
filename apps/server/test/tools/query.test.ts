import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SESSION_TITLE,
  createDb,
  newId,
  type AppDb,
  type NoteInsert,
} from "../../src/db.js";
import { registerDiagram } from "../../src/diagrams.js";
import { registerTable } from "../../src/tables.js";
import { QUERY_TABLE_SOURCE_MAX } from "../../src/tools/query.js";
import { forceMakePlan, readCurrentPlan, renderReadResult } from "../../src/plans.js";
import { registerQuizQuestions } from "../../src/quizzes.js";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { QUERY_KINDS } from "@ilearnassist/shared";
import { buildQueryTool, QUERY_RESULT_MAX } from "../../src/tools/query.js";
import { NO_SCOPE } from "../../src/workspaceScope.js";

/**
 * `ila_query` is the one tool that reaches the conversation's own record, so what these cases
 * are really pinning is that it *delegates*: each kind must return what its widget's route
 * returns, and the quiz kind must inherit the answer key's secrecy rather than re-deriving it.
 */

let root: string;
let db: AppDb;
let sessionDirPath: string;
const OWNER = "u1";
const OTHER = "u2";
const SESSION = "s1";
const OTHER_SESSION = "s2";
/** The workspace the conversation is in — what the `source` kind unions the whitelist with. */
const WORKSPACE = "w1";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gl-query-"));
  db = createDb(join(root, "test.sqlite"));
  db.createUser({ id: OWNER, username: "tester", slug: "tester" });
  db.createUser({ id: OTHER, username: "other", slug: "other" });
  db.createWorkspace({ userId: OWNER, id: "w1", name: "W", slug: "w1", dirPath: join(root, "w1") });
  db.createWorkspace({ userId: OTHER, id: "w2", name: "W2", slug: "w2", dirPath: join(root, "w2") });
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
  db.createSession({
    id: OTHER_SESSION,
    workspaceId: "w2",
    copilotId: null,
    copilotName: "",
    systemPrompt: "",
    allTools: true,
    tools: [],
    title: DEFAULT_SESSION_TITLE,
  });
  sessionDirPath = join(root, "w1", "sessions", SESSION);
  mkdirSync(sessionDirPath, { recursive: true });
});

afterEach(() => {
  try {
    db.raw.close();
  } catch {
    /* already closed */
  }
  rmSync(root, { recursive: true, force: true });
});

/** The tool as `turnContext` builds it, with the owner and directory the context carries. */
function build(options: { userId?: string; sessionId?: string } = {}) {
  return buildQueryTool({
    db,
    userId: options.userId ?? OWNER,
    sessionId: options.sessionId ?? SESSION,
    workspaceId: WORKSPACE,
    scope: NO_SCOPE,
    sessionDirPath,
  });
}

/** Parse a tool result, failing loudly rather than returning `undefined` on nonsense. */
function parse(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") throw new Error(`not a string: ${String(raw)}`);
  return JSON.parse(raw) as Record<string, unknown>;
}

const ask = async (input: Record<string, unknown>, options = {}) =>
  parse(await build(options).invoke(input));

/** A question that carries an answer key, so the secrecy case has something to leak. */
function registerQuestion(): void {
  registerQuizQuestions(db, SESSION, {
    toolCallId: "call-1",
    items: [
      {
        qid: "Q1",
        position: 1,
        header: "递归",
        question: "递归的终止条件是什么？",
        options: [{ label: "A", description: "一个不再递归的分支" }, { label: "B" }],
        referenceAnswer: ["A"],
        explanation: "没有终止条件的递归会栈溢出。",
      },
    ],
  });
}

function addNote(content: string, quote = ""): void {
  const note: NoteInsert = {
    id: newId(),
    sessionId: SESSION,
    messageId: null,
    type: "idea",
    quote,
    occurrence: 0,
    content,
    targetKind: "text",
    targetRef: null,
  };
  db.createNote(note);
}

describe("ila_query — the plan", () => {
  it("answers with the same string ila_read_plan does", async () => {
    // The two tools are two doors to one fact; the render must not be able to differ between
    // them, because `ila_make_plan`'s description tells the model to carry these ids forward.
    forceMakePlan(db, SESSION, { tree: [{ title: "第一章", children: [{ title: "1.1" }] }] });
    const result = await build().invoke({ kind: "plan" });
    expect(result).toBe(renderReadResult(readCurrentPlan(db, SESSION)));
  });

  it("says so when there is no plan", async () => {
    const answer = await ask({ kind: "plan" });
    expect(answer).toMatchObject({ plan: null });
  });
});

describe("ila_query — quizzes", () => {
  it("returns the learner's questions with their state", async () => {
    registerQuestion();
    const answer = await ask({ kind: "quiz" });
    expect(answer).toMatchObject({ total: 1, returned: 1, truncated: false });
    const [item] = answer.items as Record<string, unknown>[];
    // `skipped`, not `pending`, and that is the read working: `listQuizQuestionViews`
    // reconciles a pending row whose suspending call is no longer awaiting, and this test's
    // question was registered with a call id nothing is waiting on. Reading the rows directly
    // would tell the model there is a live card on screen when there is not.
    expect(item).toMatchObject({
      qid: "Q1",
      header: "递归",
      status: "skipped",
      verdict: null,
      answer: null,
      feedback: null,
    });
  });

  it("never carries the answer key", async () => {
    // The whole reason this kind reads through `listQuizQuestionViews` rather than the rows:
    // `toView` drops `reference_answer_json`/`explanation` by construction. This is asserted
    // against a row that genuinely has both, so it fails the day someone reads rows directly.
    registerQuestion();
    const raw = await build().invoke({ kind: "quiz" });
    expect(typeof raw).toBe("string");
    expect(raw as string).not.toContain("栈溢出");
    expect(raw as string).not.toContain("referenceAnswer");
    expect(raw as string).not.toContain("explanation");
  });

  it("filters by status", async () => {
    registerQuestion();
    expect(await ask({ kind: "quiz", status: "answered" })).toMatchObject({ total: 0 });
    expect(await ask({ kind: "quiz", status: "skipped" })).toMatchObject({ total: 1 });
  });
});

describe("ila_query — threads", () => {
  it("lists a thread with its plan node resolved to a number and a title", async () => {
    const plan = forceMakePlan(db, SESSION, { tree: [{ title: "第一章" }, { title: "第二章" }] });
    const node = plan.tree[1]!;
    db.insertThread({
      id: newId(),
      sessionId: SESSION,
      branch: "plan",
      title: "第二章",
      planNodeId: node.id,
    });

    const answer = await ask({ kind: "thread" });
    expect(answer).toMatchObject({ total: 1, unassignedMessages: 0 });
    const [item] = answer.items as Record<string, unknown>[];
    // The number, not the opaque id — a model reading "2" and "第二章" can act on it.
    expect(item).toMatchObject({
      branch: "plan",
      title: "第二章",
      planNode: { number: "2", title: "第二章" },
      messageCount: 0,
    });
  });

  it("reports messages the classifier has not reached", async () => {
    db.createMessage({ id: newId(), sessionId: SESSION, role: "user", content: "你好" });
    const answer = await ask({ kind: "thread" });
    expect(answer).toMatchObject({ total: 0, unassignedMessages: 1 });
    expect(answer.note as string).toContain("may follow");
  });
});

describe("ila_query — a quiz question by id", () => {
  it("carries the global id, which is what a reference and ila_review_quiz take", async () => {
    /*
     * Absent for as long as the listing was only read by prose. The quiz follow-up used to quote
     * this id in a sentence and nothing could resolve it, because nothing was ever given it — so
     * what is asserted here is both halves: the id comes out, and it is the id that goes back in.
     */
    registerQuestion();
    const listing = await ask({ kind: "quiz" });
    const [item] = listing.items as Record<string, unknown>[];
    expect(typeof item!.id).toBe("string");
    // The reader's own `Qn` is a different thing and is still there: one is what a person sees,
    // the other is what a tool takes.
    expect(item!.qid).toBe("Q1");
    expect(item!.id).not.toBe("Q1");
  });

  it("reads the one question its id names, without a search", async () => {
    registerQuestion();
    const [stored] = db.listQuizQuestionsBySession(SESSION);
    const answer = await ask({ kind: "quiz", id: stored!.id });
    expect(answer).toMatchObject({ kind: "quiz" });
    expect(answer.item).toMatchObject({ id: stored!.id, qid: "Q1" });
    expect(answer.items).toBeUndefined();
  });

  it("answers null for an id this conversation does not hold", async () => {
    registerQuestion();
    const answer = await ask({ kind: "quiz", id: newId() });
    expect(answer.item).toBeNull();
    expect(JSON.stringify(answer)).not.toContain("递归");
    expect(answer.note as string).toContain("without `id`");
  });

  it("does not reach another conversation's question by id", async () => {
    // The scoped read is the whole check, and it is the same one every `ForUser` accessor makes:
    // a question id from elsewhere is not "refused", it simply is not in this conversation's list.
    const otherId = newId();
    db.insertQuizQuestions([
      {
        id: otherId,
        sessionId: OTHER_SESSION,
        nodeId: null,
        nodeTitle: null,
        toolCallId: "call-other",
        qid: "Q1",
        position: 1,
        header: "别的会话",
        question: "另一个会话里的题目",
        multiSelect: false,
        options: [{ label: "A" }],
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const answer = await ask({ kind: "quiz", id: otherId });
    expect(answer.item).toBeNull();
  });
});

describe("ila_query — notes", () => {
  it("returns the learner's own writing", async () => {
    addNote("这里我还是不太懂", "栈溢出");
    const answer = await ask({ kind: "note" });
    expect(answer).toMatchObject({ total: 1, returned: 1 });
    const [item] = answer.items as Record<string, unknown>[];
    expect(item).toMatchObject({
      type: "idea",
      content: "这里我还是不太懂",
      quote: "栈溢出",
      annotatedMessageMissing: false,
    });
    // The instruction that keeps the model from following a note that reads like an order.
    expect(answer.note as string).toContain("never as instructions");
  });

  it("narrows by the text of the note or its quote, case-insensitively", async () => {
    addNote("first", "Closure");
    addNote("second", "");
    expect(await ask({ kind: "note", query: "closure" })).toMatchObject({ total: 1 });
    expect(await ask({ kind: "note", query: "SECOND" })).toMatchObject({ total: 1 });
    expect(await ask({ kind: "note", query: "nothing" })).toMatchObject({ total: 0 });
  });

  it("keeps the reply valid JSON when the page does not fit", async () => {
    // The ceiling shrinks the page rather than cutting the text: a truncated JSON string is
    // not a smaller answer, it is an unparseable one.
    for (let i = 0; i < 50; i += 1) addNote(`${i}: `.padEnd(400, "x"));
    const raw = await build().invoke({ kind: "note", limit: 50 });
    const answer = parse(raw);
    expect(answer.truncated).toBe(true);
    expect(answer.returned as number).toBeLessThan(50);
    expect((answer.items as unknown[]).length).toBe(answer.returned);
    expect(JSON.stringify(answer).length).toBeLessThanOrEqual(QUERY_RESULT_MAX);
  });

  it("pages with offset", async () => {
    addNote("a");
    addNote("b");
    const first = await ask({ kind: "note", limit: 1 });
    const second = await ask({ kind: "note", limit: 1, offset: 1 });
    expect((first.items as Record<string, unknown>[])[0]!.content).not.toBe(
      (second.items as Record<string, unknown>[])[0]!.content
    );
    expect(second).toMatchObject({ total: 2, offset: 1 });
  });

  it("carries each note's id, so one can be asked for by name", async () => {
    // The ids are what make a note *addressable*: a reference the user attached carries one, and
    // without it in the listing the model could only ever search by text it was guessing at.
    addNote("第一条");
    const answer = await ask({ kind: "note" });
    const [item] = answer.items as Record<string, unknown>[];
    expect(typeof item!.id).toBe("string");
    expect(item!.id).toBe(db.listNotesForUser(OWNER, SESSION)[0]!.id);
  });

  it("reads the one note its id names, without a search", async () => {
    addNote("不要这条");
    addNote("要这条");
    const wanted = db.listNotesForUser(OWNER, SESSION).find((n) => n.content === "要这条")!;

    const answer = await ask({ kind: "note", id: wanted.id });
    // The single-object shape the diagram and table kinds use, not a one-item page: a caller who
    // named a note asked a question, and `items`/`total` would answer a different one.
    expect(answer).toMatchObject({ kind: "note" });
    expect(answer.item).toMatchObject({ id: wanted.id, content: "要这条" });
    expect(answer.items).toBeUndefined();
  });

  it("does not reach another conversation's note by id", async () => {
    /*
     * The lookup runs inside this conversation's own list, which is already owner-scoped — so an
     * id from elsewhere is not "refused", it simply is not found, and the answer says which of
     * the two it is by handing back a null rather than a note.
     */
    const otherNote = db.createNote({
      id: newId(),
      sessionId: OTHER_SESSION,
      messageId: null,
      type: "idea",
      quote: "",
      occurrence: 0,
      content: "别的会话",
      targetKind: "text",
      targetRef: null,
    });

    const answer = await ask({ kind: "note", id: otherNote.id });
    expect(answer.item).toBeNull();
    expect(JSON.stringify(answer)).not.toContain("别的会话");
    // The way back to something readable, since a page of uuids would not be.
    expect(answer.note as string).toContain("without `id`");
  });

  it("says what a note is about when it is about a figure", async () => {
    db.upsertDiagram({
      id: "d1",
      sessionId: SESSION,
      name: "auth-flow.mmd",
      fileId: "f-1",
      summary: "登录流程",
      toolCallId: null,
    });
    db.createNote({
      id: newId(),
      sessionId: SESSION,
      messageId: null,
      type: "idea",
      quote: "",
      occurrence: 0,
      content: "这一步没看懂",
      targetKind: "diagram",
      targetRef: "auth-flow.mmd",
    });

    const answer = await ask({ kind: "note" });
    const [item] = answer.items as Record<string, unknown>[];
    // The kind says which table to look in; the name is the handle, and it is the same one
    // `kind: "diagram"` takes — which is what makes a note a route to the figure itself.
    expect(item).toMatchObject({ target: { kind: "diagram", name: "auth-flow.mmd" } });

    // A text note carries no `target` at all, rather than one saying "text": the field is the
    // presence of a figure, so its absence is the honest spelling.
    addNote("普通笔记");
    const withText = await ask({ kind: "note", query: "普通" });
    expect((withText.items as Record<string, unknown>[])[0]).not.toHaveProperty("target");
  });

  it("says when the figure a note is about has gone", async () => {
    db.upsertDiagram({
      id: "d1",
      sessionId: SESSION,
      name: "gone.mmd",
      fileId: "f-1",
      summary: "",
      toolCallId: null,
    });
    db.createNote({
      id: newId(),
      sessionId: SESSION,
      messageId: null,
      type: "idea",
      quote: "",
      occurrence: 0,
      content: "看这张图",
      targetKind: "diagram",
      targetRef: "gone.mmd",
    });
    db.raw.prepare("DELETE FROM session_diagrams WHERE id = ?").run("d1");

    const answer = await ask({ kind: "note" });
    const [item] = answer.items as Record<string, unknown>[];
    // Named rather than omitted: the name is still what the note is about, and a reader who
    // follows it to `kind: "diagram"` gets the handler's own "no such diagram" answer.
    expect(item).toMatchObject({ target: { kind: "diagram", name: "gone.mmd" }, targetMissing: true });
  });
});

describe("ila_query — tables", () => {
  const TABLE = "| 项目 | 数值 |\n| --- | --- |\n| 速度 | 3 |";

  beforeEach(() => {
    registerTable(db, SESSION, {
      name: "季度对比",
      summary: "三项指标",
      content: TABLE,
      toolCallId: "call-8",
    });
  });

  it("lists names and summaries without the markdown", async () => {
    const answer = await ask({ kind: "table" });
    expect(answer).toMatchObject({ total: 1 });
    expect(answer.items).toEqual([
      { name: "季度对比", summary: "三项指标", threadTitle: null },
    ]);
    expect(JSON.stringify(answer)).not.toContain("速度");
  });

  it("returns one table's markdown, which is the only copy there is", async () => {
    /*
     * The read a file would otherwise have given, and the reason this kind exists: a table has no
     * file, so without this the model could not see one again once the turn that wrote it left the
     * history window — and the revise instruction the tool hands back ("call again with the same
     * name") would be advice it had no way to follow, since a revise needs the current contents.
     */
    const answer = await ask({ kind: "table", name: "季度对比" });
    expect(answer).toMatchObject({
      table: {
        name: "季度对比",
        summary: "三项指标",
        contentTruncated: false,
        content: TABLE,
      },
    });
  });

  it("normalises the name the way the writer does", async () => {
    // The same `tableName` on both sides, so a model that remembers "季度对比 " or a differently
    // cased Latin name still finds its row.
    expect((await ask({ kind: "table", name: " 季度对比 " })).table).not.toBeNull();
  });

  it("says what it has instead of failing when the name is unknown", async () => {
    const answer = await ask({ kind: "table", name: "nope" });
    expect(answer).toMatchObject({ table: null, available: ["季度对比"] });
  });

  it("is scoped to the account", async () => {
    // The same pair the other kinds use: another account's id returns nothing rather than a row.
    const other = { userId: OTHER, sessionId: OTHER_SESSION };
    expect(await ask({ kind: "table" }, other)).toMatchObject({ total: 0 });
  });

  it("truncates a table past the read cap, and says so", async () => {
    registerTable(db, SESSION, {
      name: "long",
      summary: "很长",
      content: `| a |\n| --- |\n| ${"x".repeat(QUERY_TABLE_SOURCE_MAX)} |`,
      toolCallId: "call-9",
    });
    const answer = await ask({ kind: "table", name: "long" });
    const table = answer.table as Record<string, unknown>;
    expect(table.contentTruncated).toBe(true);
    expect((table.content as string).length).toBe(QUERY_TABLE_SOURCE_MAX);
  });
});

describe("ila_query — diagrams", () => {
  beforeEach(() => {
    registerDiagram(db, SESSION, {
      name: "auth-flow.mmd",
      fileId: "f-1",
      summary: "登录流程",
      toolCallId: "call-9",
    });
    writeFileSync(join(sessionDirPath, "auth-flow.mmd"), "flowchart TD\n  A --> B\n", "utf8");
  });

  it("lists names and summaries without the source", async () => {
    const answer = await ask({ kind: "diagram" });
    expect(answer).toMatchObject({ total: 1 });
    expect(answer.items).toEqual([
      { name: "auth-flow.mmd", summary: "登录流程", threadTitle: null, fileMissing: false },
    ]);
    expect(JSON.stringify(answer)).not.toContain("flowchart");
  });

  it("returns one diagram's mermaid source, which no file tool can reach", async () => {
    // The `.mmd` lives in the conversation's own folder, a sibling of `workdir/` that
    // `resolveInWorkspace` refuses — so this is the only way the model sees it.
    const answer = await ask({ kind: "diagram", name: "auth-flow" });
    expect(answer).toMatchObject({
      diagram: {
        name: "auth-flow.mmd",
        summary: "登录流程",
        fileMissing: false,
        sourceTruncated: false,
        source: "flowchart TD\n  A --> B\n",
      },
    });
  });

  it("accepts the name either way the model might write it", async () => {
    const withExtension = await ask({ kind: "diagram", name: "auth-flow.mmd" });
    expect(withExtension.diagram).not.toBeNull();
  });

  it("lists what is available when the name is wrong", async () => {
    const answer = await ask({ kind: "diagram", name: "nope" });
    expect(answer).toMatchObject({ diagram: null, available: ["auth-flow.mmd"] });
  });

  it("reports a row whose file is gone without a source", async () => {
    rmSync(join(sessionDirPath, "auth-flow.mmd"));
    const answer = await ask({ kind: "diagram", name: "auth-flow" });
    expect(answer.diagram).toMatchObject({ fileMissing: true, source: null });
  });

  it("truncates a source past the cap and says so", async () => {
    writeFileSync(
      join(sessionDirPath, "auth-flow.mmd"),
      `flowchart TD\n${"  A --> B\n".repeat(1000)}`,
      "utf8"
    );
    const answer = await ask({ kind: "diagram", name: "auth-flow" });
    const diagram = answer.diagram as Record<string, unknown>;
    expect(diagram.sourceTruncated).toBe(true);
    expect((diagram.source as string).length).toBe(4_000);
  });
});

describe("ila_query — ownership", () => {
  it("answers nothing about another account's conversation", async () => {
    // Every kind is owner-scoped, so the ids are the whole defence: a guessed session id must
    // fail the scan rather than trusting that its route resolved the owner.
    registerDiagram(db, SESSION, { name: "x.mmd", fileId: "f-x", summary: "s", toolCallId: null });
    addNote("mine");
    const other = { userId: OTHER, sessionId: OTHER_SESSION };
    expect(await ask({ kind: "plan" }, other)).toMatchObject({ plan: null });
    expect(await ask({ kind: "quiz" }, other)).toMatchObject({ total: 0 });
    expect(await ask({ kind: "thread" }, other)).toMatchObject({ total: 0 });
    expect(await ask({ kind: "note" }, other)).toMatchObject({ total: 0 });
    expect(await ask({ kind: "diagram" }, other)).toMatchObject({ total: 0 });
    expect(await ask({ kind: "table" }, other)).toMatchObject({ total: 0 });
  });

  it("answers nothing when the owner does not match the session", async () => {
    addNote("mine");
    expect(await ask({ kind: "note" }, { userId: OTHER })).toMatchObject({ total: 0 });
  });
});

describe("ila_query — the schema", () => {
  /**
   * The wire shape, converted exactly as `@langchain/openai` converts it before a request.
   *
   * This is the assertion that matters most in this file, and it is here because its absence
   * shipped a broken tool: the schema was a `z.discriminatedUnion`, which converts to
   * `{"anyOf": […], "type": null}` — and a strict OpenAI-compatible endpoint refuses a function
   * schema that is not `type: "object"`. The symptom was a 400 on *every* turn in a conversation
   * where the tool was available, not only when it was called:
   *
   *     400 Invalid schema for function 'ila_query': schema must be a JSON Schema of
   *     'type: "object"', got 'type: null'.
   *
   * Nothing in the type system or in the handler's own tests could see that, which is why it is
   * pinned on the conversion rather than on the zod object.
   */
  const jsonSchema = (): Record<string, unknown> =>
    toJsonSchema(build().schema) as Record<string, unknown>;

  it("converts to a top-level object, which every strict endpoint requires", () => {
    const schema = jsonSchema();
    expect(schema.type).toBe("object");
    expect(schema).not.toHaveProperty("anyOf");
  });

  it("keeps the kinds as a real enum, and every kind in it", () => {
    // The union used to refuse an unknown kind at the schema. The flat object has to do it with
    // the enum, and it must list exactly `QUERY_KINDS` — the drift here would be a kind the tool
    // documents and refuses.
    const kind = (jsonSchema().properties as Record<string, { enum?: string[] }>).kind;
    expect(kind?.enum).toEqual([...QUERY_KINDS]);
  });

  it("tells the model which kind each optional field belongs to", () => {
    // The schema can no longer express the association, so the description is the only thing
    // that teaches it — `checkFields` is the refusal, and this is how a model avoids needing it.
    const properties = jsonSchema().properties as Record<string, { description?: string }>;
    for (const [field, kind] of [
      ["status", "quiz"],
      ["query", "note"],
      ["name", "diagram"],
    ] as const) {
      expect(properties[field]?.description, field).toContain(`kind: "${kind}"`);
    }
  });
});

describe("ila_query — refusals", () => {
  it("refuses a kind it does not have", async () => {
    await expect(build().invoke({ kind: "everything" })).rejects.toThrow();
  });

  it("refuses an unknown status", async () => {
    await expect(build().invoke({ kind: "quiz", status: "maybe" })).rejects.toThrow();
  });

  it("refuses a field that belongs to another kind, and names it", async () => {
    /*
     * What the union's `.strict()` used to give, rebuilt in `checkFields` because the wire format
     * cannot carry a union. `status` means nothing for a plan, and zod strips unknown keys by
     * default — so without this the model would get a plan back and never learn that its filter
     * went nowhere.
     */
    await expect(build().invoke({ kind: "plan", status: "answered" })).rejects.toThrow(
      /"plan" does not take "status"/
    );
    await expect(build().invoke({ kind: "thread", query: "x" })).rejects.toThrow(
      /It takes: limit/
    );
    await expect(build().invoke({ kind: "diagram", offset: 1 })).rejects.toThrow(
      /"diagram" does not take "offset"/
    );
  });

  it("says so plainly when a kind takes no other fields at all", async () => {
    await expect(build().invoke({ kind: "plan", limit: 5 })).rejects.toThrow(
      /It takes no other fields/
    );
  });

  it("accepts the fields a kind does take", async () => {
    // The refusal must not be so eager that it rejects the documented calls.
    await expect(build().invoke({ kind: "plan" })).resolves.toBeDefined();
    await expect(build().invoke({ kind: "quiz", status: "skipped", limit: 5 })).resolves.toBeDefined();
    await expect(build().invoke({ kind: "note", query: "x", offset: 1 })).resolves.toBeDefined();
  });
});
