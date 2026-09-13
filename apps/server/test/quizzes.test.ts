import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PlanTreeNode, type QuizAnswer } from "@ilearnassist/shared";
import { createDb, DEFAULT_SESSION_TITLE, type AppDb } from "../src/db.js";
import { applyProgress, forceMakePlan } from "../src/plans.js";
import {
  dismissQuizQuestions,
  gradeQuizAnswers,
  listQuizQuestionViews,
  makeupAnswer,
  recordQuizAnswers,
  registerQuizQuestions,
  skipQuizQuestions,
} from "../src/quizzes.js";

let root: string;
let db: AppDb;
const OWNER = "u1";
const OTHER = "u2";
const SESSION = "s1";
const OTHER_SESSION = "s2";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gl-quizzes-"));
  db = createDb(join(root, "test.sqlite"));
  db.createUser({ id: OWNER, username: "tester", slug: "tester" });
  db.createUser({ id: OTHER, username: "other", slug: "other" });
  db.createWorkspace({ userId: OWNER, id: "w1", name: "W", slug: "w1", dirPath: join(root, "w1") });
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
  db.createWorkspace({
    userId: OTHER,
    id: "w2",
    name: "W2",
    slug: "w2",
    dirPath: join(root, "w2"),
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
});

afterEach(() => {
  try {
    db.raw.close();
  } catch {
    /* already closed */
  }
  rmSync(root, { recursive: true, force: true });
});

/** An awaiting `ila_quiz` call keeps its pending rows pending during read reconciliation. */
function awaitingMessage(id: string, toolCallId: string): void {
  db.createMessage({
    id,
    sessionId: SESSION,
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: toolCallId,
        name: "ila_quiz",
        input: JSON.stringify({ questions: [] }),
        status: "awaiting",
      },
    ],
  });
}

const options = () => [{ label: "滚动" }, { label: "滑动" }];
const item = (qid: string, position: number) => ({
  qid,
  position,
  header: "窗口",
  question: "Flink 有哪几种窗口？",
  options: options(),
});

function registerQuiz(qids: [string, number][], toolCallId = "call-1", modelNodeId?: string) {
  return registerQuizQuestions(db, SESSION, {
    toolCallId,
    ...(modelNodeId ? { modelNodeId } : {}),
    items: qids.map(([qid, position]) => item(qid, position)),
  });
}

/** Flatten the current plan tree from a V1 created straight through. */
function planNodes(): PlanTreeNode[] {
  const view = forceMakePlan(db, SESSION, {
    tree: [{ title: "第一章", children: [{ title: "窗口" }] }, { title: "第二章" }],
  });
  return view.tree;
}

/* -------------------------------- registration -------------------------------- */

describe("registerQuizQuestions", () => {
  it("creates pending rows with global uids and session-level binding when there is no plan", () => {
    const registered = registerQuiz([["Q1", 1], ["Q2", 2]]);
    expect(registered).toHaveLength(2);
    expect(registered[0]!.uid).toMatch(/^[0-9a-f-]{36}$/);
    expect(registered.map((r) => r.qid)).toEqual(["Q1", "Q2"]);
    expect(new Set(registered.map((r) => r.uid)).size).toBe(2);

    // The unscoped read does not reconcile; the live-card read's pending state is pinned
    // separately below.
    const rows = db.listQuizQuestionsBySession(SESSION);
    expect(rows).toHaveLength(2);
    expect(rows.every((q) => q.status === "pending")).toBe(true);
    expect(rows[0]).toMatchObject({
      qid: "Q1",
      nodeId: null,
      nodeTitle: null,
      toolCallId: "call-1",
      multiSelect: false,
    });
    expect(rows[0]!.options).toEqual(options());
  });

  it("binds to the chapter currently in progress when no node is named", () => {
    const tree = planNodes();
    const chapter = tree[0]!.children![0]!;
    applyProgress(
      db,
      SESSION,
      { nodes: [{ id: chapter.id, status: "in_progress" }] },
      "anchor-call"
    );

    registerQuiz([["Q1", 1]]);
    expect(listQuizQuestionViews(db, OWNER, SESSION)[0]).toMatchObject({
      nodeId: chapter.id,
      nodeTitle: "窗口",
    });
  });

  it("accepts the model's explicit live node id over the current chapter", () => {
    const tree = planNodes();
    const current = tree[0]!.children![0]!;
    const target = tree[1]!;
    applyProgress(
      db,
      SESSION,
      { nodes: [{ id: current.id, status: "in_progress" }] },
      "anchor-call"
    );

    registerQuiz([["Q1", 1]], "call-1", target.id);
    expect(listQuizQuestionViews(db, OWNER, SESSION)[0]).toMatchObject({
      nodeId: target.id,
      nodeTitle: "第二章",
    });
  });

  it("throws on a node id that is not live, and writes nothing", () => {
    expect(() => registerQuiz([["Q1", 1]], "call-1", "no-such-node")).toThrow(
      /not a live node/
    );
    expect(db.listQuizQuestionsBySession(SESSION)).toHaveLength(0);
  });

  it("keeps Qn ordering across two quizzes in one session", () => {
    registerQuiz([["Q1", 1], ["Q2", 2]], "call-1");
    registerQuiz([["Q3", 3]], "call-2");
    expect(listQuizQuestionViews(db, OWNER, SESSION).map((q) => q.qid)).toEqual([
      "Q1",
      "Q2",
      "Q3",
    ]);
  });
});

/* ------------------------------ call transitions ------------------------------ */

describe("quiz call transitions", () => {
  it("records the submitted answers, then dismisses nothing else", () => {
    registerQuiz([["Q1", 1], ["Q2", 2]]);
    const answers = {
      Q1: { selected: ["滚动"] } satisfies QuizAnswer,
      Q2: { selected: [], unsure: true, unsureReason: "没听过" } satisfies QuizAnswer,
    };
    recordQuizAnswers(db, SESSION, "call-1", answers);

    const views = listQuizQuestionViews(db, OWNER, SESSION);
    expect(views.map((q) => q.status)).toEqual(["answered", "answered"]);
    expect(views[1]!.answer).toEqual({ selected: [], unsure: true, unsureReason: "没听过" });
    expect(views.every((q) => q.answeredAt)).toBe(true);
    expect(views.every((q) => q.verdict === null)).toBe(true);
  });

  it("dismisses the pending rows of a cancelled call", () => {
    registerQuiz([["Q1", 1]]);
    dismissQuizQuestions(db, SESSION, "call-1");
    expect(listQuizQuestionViews(db, OWNER, SESSION)[0]!.status).toBe("dismissed");
  });

  it("skips pending rows when the user walks away, by tool-call id", () => {
    registerQuiz([["Q1", 1]], "call-1");
    registerQuiz([["Q2", 2]], "call-2");
    awaitingMessage("m1", "call-2");
    skipQuizQuestions(db, SESSION, ["call-1"]);
    const views = listQuizQuestionViews(db, OWNER, SESSION);
    expect(views.map((q) => [q.qid, q.status])).toEqual([
      ["Q1", "skipped"],
      ["Q2", "pending"],
    ]);
  });

  it("is a no-op for a legacy call that has no rows", () => {
    registerQuiz([["Q1", 1]]);
    awaitingMessage("m1", "call-1");
    expect(() => recordQuizAnswers(db, SESSION, "legacy-call", {})).not.toThrow();
    expect(listQuizQuestionViews(db, OWNER, SESSION)[0]!.status).toBe("pending");
  });
});

/* ------------------------------ owner scoping / orphans ------------------------------ */

describe("listQuizQuestionViews", () => {
  it("returns nothing for another account", () => {
    registerQuiz([["Q1", 1]]);
    expect(listQuizQuestionViews(db, OTHER, SESSION)).toEqual([]);
  });

  it("reconciles a pending row whose suspending call is no longer awaiting", () => {
    registerQuiz([["Q1", 1]], "call-1");
    // Simulate the crash window: the row exists but no awaiting call names it.
    expect(listQuizQuestionViews(db, OWNER, SESSION)[0]!.status).toBe("skipped");
  });

  it("leaves a pending row pending while its call is still awaiting", () => {
    registerQuiz([["Q1", 1]], "call-1");
    db.createMessage({
      id: "m1",
      sessionId: SESSION,
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call-1",
          name: "ila_quiz",
          input: JSON.stringify({ questions: [] }),
          status: "awaiting",
        },
      ],
    });
    expect(listQuizQuestionViews(db, OWNER, SESSION)[0]!.status).toBe("pending");
  });
});

/* ----------------------------------- grading ----------------------------------- */

describe("gradeQuizAnswers", () => {
  function answered(answer: QuizAnswer = { selected: ["滑动"] }) {
    registerQuiz([["Q1", 1], ["Q2", 2]]);
    recordQuizAnswers(db, SESSION, "call-1", { Q1: { selected: ["滚动"] }, Q2: answer });
    return listQuizQuestionViews(db, OWNER, SESSION);
  }

  it("writes each verdict and explanation in place", () => {
    const before = answered();
    gradeQuizAnswers(db, SESSION, "grade-call", {
      reviews: [
        { quizId: before[0]!.id, verdict: "correct", explanation: "正确。" },
        { quizId: before[1]!.id, verdict: "incorrect", explanation: "应选滑动。" },
      ],
    });
    const views = listQuizQuestionViews(db, OWNER, SESSION);
    expect(views[0]).toMatchObject({ verdict: "correct", feedback: "正确。" });
    expect(views[1]).toMatchObject({ verdict: "incorrect", feedback: "应选滑动。" });
    expect(views).toHaveLength(2);
  });

  it("grades an unsure answer as unsure rather than wrong", () => {
    const before = answered({ selected: [], unsure: true });
    gradeQuizAnswers(db, SESSION, "grade-call", {
      reviews: [{ quizId: before[1]!.id, verdict: "unsure", explanation: "没关系。" }],
    });
    expect(listQuizQuestionViews(db, OWNER, SESSION)[1]!.verdict).toBe("unsure");
  });

  it("updates in place when re-graded, never inserting a row", () => {
    const before = answered();
    gradeQuizAnswers(db, SESSION, "g1", {
      reviews: [{ quizId: before[0]!.id, verdict: "correct", explanation: "first" }],
    });
    gradeQuizAnswers(db, SESSION, "g2", {
      reviews: [{ quizId: before[0]!.id, verdict: "incorrect", explanation: "second" }],
    });
    const views = listQuizQuestionViews(db, OWNER, SESSION);
    expect(views).toHaveLength(2);
    expect(views[0]).toMatchObject({ verdict: "incorrect", feedback: "second" });
  });

  it("rejects an unknown id, a pending question, and a duplicated id in the batch", () => {
    const before = answered();
    expect(() =>
      gradeQuizAnswers(db, SESSION, "g", {
        reviews: [{ quizId: "nope", verdict: "correct", explanation: "x" }],
      })
    ).toThrow(/not a question in this conversation/);

    registerQuiz([["Q3", 3]], "call-9");
    const pending = listQuizQuestionViews(db, OWNER, SESSION).find((q) => q.qid === "Q3")!;
    expect(() =>
      gradeQuizAnswers(db, SESSION, "g", {
        reviews: [{ quizId: pending.id, verdict: "correct", explanation: "x" }],
      })
    ).toThrow(/no answer to grade/);

    expect(() =>
      gradeQuizAnswers(db, SESSION, "g", {
        reviews: [
          { quizId: before[0]!.id, verdict: "correct", explanation: "x" },
          { quizId: before[0]!.id, verdict: "correct", explanation: "y" },
        ],
      })
    ).toThrow(/appears more than once/);
  });
});

/* --------------------------------- make-up answer --------------------------------- */

describe("makeupAnswer", () => {
  function skipped(): string {
    registerQuiz([["Q1", 1]]);
    skipQuizQuestions(db, SESSION, ["call-1"]);
    return listQuizQuestionViews(db, OWNER, SESSION)[0]!.id;
  }

  it("re-answers a skipped question on the same row, which is then gradable", () => {
    const id = skipped();
    const result = makeupAnswer(db, OWNER, SESSION, id, {
      answer: { selected: ["滚动"] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.view.id).toBe(id);
    expect(result.view.status).toBe("answered");
    expect(result.view.answer).toEqual({ selected: ["滚动"] });

    // Exactly one row — the make-up never duplicates the question.
    expect(db.listQuizQuestionsBySession(SESSION)).toHaveLength(1);

    gradeQuizAnswers(db, SESSION, "grade-call", {
      reviews: [{ quizId: id, verdict: "correct", explanation: "补答正确。" }],
    });
    expect(listQuizQuestionViews(db, OWNER, SESSION)[0]!.verdict).toBe("correct");
  });

  it("validates the make-up against the options the row recorded", () => {
    const id = skipped();
    const result = makeupAnswer(db, OWNER, SESSION, id, {
      answer: { selected: ["从未提供的选项"] },
    });
    expect(result).toMatchObject({ ok: false, status: 400, code: "INVALID_ANSWER" });
  });

  it("refuses a question that is answered or pending", () => {
    // Answered: submit normally, then a make-up must not overwrite it.
    registerQuiz([["Q1", 1]], "call-a");
    recordQuizAnswers(db, SESSION, "call-a", { Q1: { selected: ["滚动"] } });
    const answeredId = db.listQuizQuestionsBySession(SESSION).find((q) => q.qid === "Q1")!.id;
    expect(makeupAnswer(db, OWNER, SESSION, answeredId, { answer: { selected: ["滑动"] } }))
      .toMatchObject({ ok: false, status: 409, code: "QUIZ_NOT_ANSWERABLE" });

    // Pending: a live card, answered through the ordinary flow rather than the make-up POST.
    registerQuiz([["Q2", 2]], "call-b");
    awaitingMessage("m-b", "call-b");
    const pendingId = db.listQuizQuestionsBySession(SESSION).find((q) => q.qid === "Q2")!.id;
    expect(makeupAnswer(db, OWNER, SESSION, pendingId, { answer: { selected: ["滚动"] } }))
      .toMatchObject({ ok: false, status: 409, code: "QUIZ_NOT_ANSWERABLE" });
  });

  it("re-answers a dismissed question too, on the same row", () => {
    // Cancelling the quiz is equivalent to skipping each question: the user never
    // submitted, so the question stays make-up eligible.
    registerQuiz([["Q1", 1]], "call-c");
    dismissQuizQuestions(db, SESSION, "call-c");
    const dismissedId = db.listQuizQuestionsBySession(SESSION).find((q) => q.qid === "Q1")!.id;

    const result = makeupAnswer(db, OWNER, SESSION, dismissedId, {
      answer: { selected: ["滚动"] },
    });
    expect(result.ok).toBe(true);
    expect(db.listQuizQuestionsBySession(SESSION)).toHaveLength(1);
    const row = db.listQuizQuestionsBySession(SESSION)[0]!;
    expect(row).toMatchObject({ id: dismissedId, status: "answered" });
    expect(row.answer).toEqual({ selected: ["滚动"] });
  });

  it("404s on an unknown id and on another account's question", () => {
    const id = skipped();
    const unknown = makeupAnswer(db, OWNER, SESSION, "no-such-uid", {
      answer: { selected: ["滚动"] },
    });
    expect(unknown).toMatchObject({
      ok: false,
      status: 404,
      code: "QUIZ_QUESTION_NOT_FOUND",
    });
    const foreign = makeupAnswer(db, OTHER, SESSION, id, { answer: { selected: ["滚动"] } });
    expect(foreign).toMatchObject({
      ok: false,
      status: 404,
      code: "QUIZ_QUESTION_NOT_FOUND",
    });
  });

  it("rejects a malformed body", () => {
    const id = skipped();
    const result = makeupAnswer(db, OWNER, SESSION, id, { answer: { nope: true } });
    expect(result).toMatchObject({ ok: false, status: 400 });
  });
});
