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
import { forceMakePlan, readCurrentPlan, renderReadResult } from "../../src/plans.js";
import { registerQuizQuestions } from "../../src/quizzes.js";
import { buildQueryTool, QUERY_RESULT_MAX } from "../../src/tools/query.js";

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
});

describe("ila_query — diagrams", () => {
  beforeEach(() => {
    registerDiagram(db, SESSION, {
      name: "auth-flow.mmd",
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
    registerDiagram(db, SESSION, { name: "x.mmd", summary: "s", toolCallId: null });
    addNote("mine");
    const other = { userId: OTHER, sessionId: OTHER_SESSION };
    expect(await ask({ kind: "plan" }, other)).toMatchObject({ plan: null });
    expect(await ask({ kind: "quiz" }, other)).toMatchObject({ total: 0 });
    expect(await ask({ kind: "thread" }, other)).toMatchObject({ total: 0 });
    expect(await ask({ kind: "note" }, other)).toMatchObject({ total: 0 });
    expect(await ask({ kind: "diagram" }, other)).toMatchObject({ total: 0 });
  });

  it("answers nothing when the owner does not match the session", async () => {
    addNote("mine");
    expect(await ask({ kind: "note" }, { userId: OTHER })).toMatchObject({ total: 0 });
  });
});

describe("ila_query — the schema", () => {
  it("refuses a kind it does not have", async () => {
    await expect(build().invoke({ kind: "everything" })).rejects.toThrow();
  });

  it("refuses a field that belongs to another kind", async () => {
    // The point of the discriminated union: `status` means nothing for a plan, and a loose
    // schema would push that check into the handler where it becomes a tool error string.
    await expect(build().invoke({ kind: "plan", status: "answered" })).rejects.toThrow();
  });
});
