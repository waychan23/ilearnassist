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
  makeupQuestions,
  quizAnswerKeysForCall,
  recordMakeupAnswers,
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

/* ----------------------------------- answer key ----------------------------------- */

describe("quiz answer key", () => {
  function registerKeyed() {
    registerQuizQuestions(db, SESSION, {
      toolCallId: "call-1",
      items: [
        {
          ...item("Q1", 1),
          referenceAnswer: ["滑动"],
          explanation: "滑动窗口按步长触发。",
        },
        item("Q2", 2),
      ],
    });
  }

  it("stores the key on the rows but never in the client views", () => {
    registerKeyed();
    const rows = db.listQuizQuestionsBySession(SESSION);
    expect(rows[0]).toMatchObject({
      referenceAnswer: ["滑动"],
      explanation: "滑动窗口按步长触发。",
    });
    // Keyless question: nulls, not an empty key.
    expect(rows[1]).toMatchObject({ referenceAnswer: null, explanation: null });

    for (const view of listQuizQuestionViews(db, OWNER, SESSION)) {
      expect(view).not.toHaveProperty("referenceAnswer");
      expect(view).not.toHaveProperty("explanation");
    }
  });

  it("reads the key back by the suspending call's id, keyed by Qn", () => {
    registerKeyed();
    // Only questions posed with a key (or explanation) appear.
    const keys = quizAnswerKeysForCall(db, SESSION, "call-1");
    expect(keys.size).toBe(1);
    expect(keys.get("Q1")).toEqual({
      referenceAnswer: ["滑动"],
      explanation: "滑动窗口按步长触发。",
    });
    expect(quizAnswerKeysForCall(db, SESSION, "other-call").size).toBe(0);
  });

});

/* ------------------------------- batch make-up (the card) ------------------------------- */

/**
 * The two functions the make-up card is built on: what it asks, and what answering it writes.
 *
 * The card itself is asserted in `quiz-widget-sse.test.ts`, over a real turn; what is here is the
 * domain layer's own contract — which questions are eligible, what happens when one of them moved
 * under the card, and that a batch is all or nothing.
 */
describe("makeupQuestions", () => {
  it("offers the questions the learner never submitted, in the panel's order", () => {
    /*
     * Two calls, because that is the only way to get a mixed set: a submission answers *every*
     * pending question of its own call (the validator will not accept a partial one), so "answered
     * and skipped" is two quizzes — one the learner did, one they walked away from.
     */
    registerQuiz([["Q1", 1]], "call-1");
    recordQuizAnswers(db, SESSION, "call-1", { Q1: { selected: ["滚动"] } });
    registerQuiz([["Q2", 2], ["Q3", 3]], "call-2");
    skipQuizQuestions(db, SESSION, ["call-2"]);
    const rows = listQuizQuestionViews(db, OWNER, SESSION);

    const offered = makeupQuestions(db, SESSION);

    expect(offered.map((q) => q.id)).toEqual(["Q2", "Q3"]);
    // Both ids travel: the Qn the answer is keyed by, and the UUID the row is written by.
    expect(offered[0]).toMatchObject({ id: "Q2", uid: rows[1]!.id });
    expect(offered[0]!.options.map((o) => o.label)).toEqual(["滚动", "滑动"]);
    // The recorded shape is `QuizQuestion`, which has no key field — asserted rather than assumed,
    // because the key's secrecy is the rule the whole quiz family shares.
    expect(JSON.stringify(offered)).not.toMatch(/referenceAnswer|explanation/);
  });

  it("narrows to the ids the model named, in the order it named them", () => {
    registerQuiz([["Q1", 1], ["Q2", 2], ["Q3", 3]]);
    skipQuizQuestions(db, SESSION, ["call-1"]);
    const rows = listQuizQuestionViews(db, OWNER, SESSION);

    const offered = makeupQuestions(db, SESSION, [rows[2]!.id, rows[0]!.id]);

    expect(offered.map((q) => q.id)).toEqual(["Q3", "Q1"]);
  });

  it("refuses a named id that is not an unanswered question here", () => {
    // A named id is a claim the model made. Dropping it silently would answer a different question
    // than the one it asked for.
    registerQuiz([["Q1", 1], ["Q2", 2]]);
    recordQuizAnswers(db, SESSION, "call-1", { Q1: { selected: ["滚动"] }, Q2: { selected: ["滑动"] } });
    const answered = listQuizQuestionViews(db, OWNER, SESSION)[0]!.id;

    expect(() => makeupQuestions(db, SESSION, [answered])).toThrow(/not a question this conversation/);
    expect(() => makeupQuestions(db, SESSION, ["nope"])).toThrow(/not a question this conversation/);
  });

  it("ignores another conversation's questions", () => {
    registerQuizQuestions(db, OTHER_SESSION, {
      toolCallId: "call-other",
      items: [item("Q1", 1)],
    });
    skipQuizQuestions(db, OTHER_SESSION, ["call-other"]);

    expect(makeupQuestions(db, SESSION)).toEqual([]);
    expect(makeupQuestions(db, OTHER_SESSION)).toHaveLength(1);
  });
});

describe("recordMakeupAnswers", () => {
  function skippedPair() {
    registerQuiz([["Q1", 1], ["Q2", 2]]);
    skipQuizQuestions(db, SESSION, ["call-1"]);
    return {
      questions: makeupQuestions(db, SESSION),
      rows: listQuizQuestionViews(db, OWNER, SESSION),
    };
  }

  it("writes every answered row and returns the keys for grading", () => {
    registerQuizQuestions(db, SESSION, {
      toolCallId: "call-1",
      items: [
        { ...item("Q1", 1), referenceAnswer: ["滚动"], explanation: "它是按时间切的。" },
        item("Q2", 2),
      ],
    });
    skipQuizQuestions(db, SESSION, ["call-1"]);
    const questions = makeupQuestions(db, SESSION);

    const written = recordMakeupAnswers(db, OWNER, SESSION, questions, {
      Q1: { selected: ["滚动"] },
      Q2: { selected: ["滑动"] },
    });

    expect(written.ok).toBe(true);
    if (!written.ok) throw new Error("expected ok");
    expect(written.applied.map((w) => w.qid).sort()).toEqual(["Q1", "Q2"]);
    // Each entry names the call that asked it, which is where the answer is written back.
    expect(written.applied.every((w) => w.toolCallId === "call-1")).toBe(true);
    // Only the question posed with a key has one: a keyless question grades without one, exactly
    // as it does on a first answer.
    expect(written.keys.get("Q1")).toEqual({
      referenceAnswer: ["滚动"],
      explanation: "它是按时间切的。",
    });
    expect(written.keys.has("Q2")).toBe(false);

    const rows = listQuizQuestionViews(db, OWNER, SESSION);
    expect(rows.map((r) => [r.qid, r.status, r.answer?.selected])).toEqual([
      ["Q1", "answered", ["滚动"]],
      ["Q2", "answered", ["滑动"]],
    ]);
  });

  it("does not answer a question the submission left out, and does not fail over it", () => {
    // The partial answer is a requirement, not a hole: whatever the learner skipped stays skipped,
    // so it can be brought back again.
    const { questions } = skippedPair();

    const written = recordMakeupAnswers(db, OWNER, SESSION, [questions[0]!], {
      Q1: { selected: ["滚动"] },
    });

    expect(written.ok).toBe(true);
    expect(listQuizQuestionViews(db, OWNER, SESSION).map((r) => [r.qid, r.status])).toEqual([
      ["Q1", "answered"],
      ["Q2", "skipped"],
    ]);
  });

  it("refuses the whole batch when one question moved since the card opened", () => {
    /*
     * All or nothing, and the reason is legibility: a partly-written batch leaves the card's own
     * record of what was answered disagreeing with the rows, with nothing on screen able to say
     * which half landed.
     */
    const { questions, rows } = skippedPair();
    // Another tab answers Q2 through the ordinary flow while this card is open.
    db.transitionQuizQuestion({
      sessionId: SESSION,
      id: rows[1]!.id,
      expectedStatus: "skipped",
      status: "answered",
      answerJson: JSON.stringify({ selected: ["滑动"] }),
      answeredAt: new Date().toISOString(),
    });

    const written = recordMakeupAnswers(db, OWNER, SESSION, questions, {
      Q1: { selected: ["滚动"] },
      Q2: { selected: ["滑动"] },
    });

    expect(written).toMatchObject({ ok: false, status: 409, code: "QUIZ_NOT_ANSWERABLE" });
    // Nothing at all: the first row is still open for a retry.
    expect(listQuizQuestionViews(db, OWNER, SESSION)[0]!.status).toBe("skipped");
  });

  it("refuses every row when one belongs to another account", () => {
    const { questions } = skippedPair();

    const written = recordMakeupAnswers(db, OTHER, SESSION, questions, {
      Q1: { selected: ["滚动"] },
      Q2: { selected: ["滑动"] },
    });

    expect(written).toMatchObject({ ok: false, status: 404, code: "QUIZ_QUESTION_NOT_FOUND" });
    expect(listQuizQuestionViews(db, OWNER, SESSION).every((r) => r.status === "skipped")).toBe(true);
  });

  it("refuses a submission that answered none of the questions", () => {
    // Not a partial answer but an empty one: the card's submit is disabled in this state, and the
    // rule is enforced here as well so the function is safe on its own.
    const { questions } = skippedPair();

    const written = recordMakeupAnswers(db, OWNER, SESSION, questions, {});

    expect(written).toMatchObject({ ok: false, status: 400, code: "INVALID_ANSWER" });
    expect(listQuizQuestionViews(db, OWNER, SESSION).every((r) => r.status === "skipped")).toBe(true);
  });

  it("refuses a legacy question with no row behind it", () => {
    const written = recordMakeupAnswers(
      db,
      OWNER,
      SESSION,
      [{ id: "Q1", header: "窗口", question: "哪几种？", options: options() }],
      { Q1: { selected: ["滚动"] } }
    );

    expect(written).toMatchObject({ ok: false, status: 404 });
  });

  it("writes the answer with no verdict, so the row is awaiting a grade", () => {
    /*
     * A make-up never carries a grade of its own — it is the learner's answer, and the verdict
     * comes from `ila_review_quiz` in the resumed turn. Asserted because the panel renders exactly
     * this state, and because it is what the guarded UPDATE's grade-clearing columns are for: a row
     * that arrives here from anywhere else must not show a stale verdict beside a new answer.
     */
    const { questions } = skippedPair();

    recordMakeupAnswers(db, OWNER, SESSION, [questions[0]!], { Q1: { selected: ["滑动"] } });

    const row = listQuizQuestionViews(db, OWNER, SESSION).find((r) => r.qid === "Q1")!;
    expect(row.status).toBe("answered");
    expect(row.answer?.selected).toEqual(["滑动"]);
    expect(row.verdict).toBeNull();
    expect(row.feedback).toBeNull();
    expect(row.gradedAt).toBeNull();
  });
});
