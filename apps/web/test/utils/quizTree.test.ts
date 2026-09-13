import { describe, expect, it } from "vitest";
import type { PlanTreeNode, QuizQuestionView } from "@ilearnassist/shared";
import {
  buildQuizTree,
  flattenQuizTree,
  IN_PLAN_ROOT,
  OTHER_ROOT,
} from "../../src/utils/quizTree";

/**
 * The quiz widget's grouping rules. They live here rather than in the `.vue` file because
 * "a wrong answer shows up under its chapter and under the wrong-only filter" is a rule,
 * and a rule in a component is covered by Playwright or by nothing.
 */

let seq = 0;
function q(overrides: Partial<QuizQuestionView> = {}): QuizQuestionView {
  seq += 1;
  return {
    id: `quiz-${seq}`,
    qid: `Q${seq}`,
    position: seq,
    header: "题",
    question: `问题 ${seq}`,
    multiSelect: false,
    options: [{ label: "对" }, { label: "错" }],
    status: "answered",
    verdict: null,
    feedback: null,
    answer: null,
    nodeId: null,
    nodeTitle: null,
    toolCallId: `call-${seq}`,
    createdAt: `2026-01-0${seq}T00:00:00.000Z`,
    answeredAt: null,
    gradedAt: null,
    ...overrides,
  };
}

/** Two chapters, the first with a child. */
function planTree(): PlanTreeNode[] {
  return [
    {
      id: "c1",
      title: "第一章",
      status: "completed",
      children: [{ id: "c1-1", title: "1.1 窗口", status: "completed" }],
    },
    { id: "c2", title: "第二章", status: "not_started" },
  ];
}

describe("buildQuizTree", () => {
  it("puts session-level questions under the other root and node questions under chapters", () => {
    const tree = buildQuizTree(
      [q({ nodeId: "c1-1", nodeTitle: "1.1 窗口" }), q()],
      planTree()
    );
    expect(tree.inPlan.children[0]!.id).toBe("c1");
    expect(tree.inPlan.children[0]!.children[0]!.questions).toHaveLength(1);
    expect(tree.other.questions).toHaveLength(1);
  });

  it("numbers chapters with the same ordinals the plan panel uses", () => {
    const tree = buildQuizTree([q({ nodeId: "c2", nodeTitle: "第二章" })], planTree());
    expect(tree.inPlan.children.map((f) => f.number)).toEqual(["2"]);
    // The empty first chapter is pruned away rather than rendered empty.
    expect(tree.inPlan.children.map((f) => f.title)).toEqual(["第二章"]);
  });

  it("keeps ancestor folders with no questions of their own", () => {
    const tree = buildQuizTree([q({ nodeId: "c1-1", nodeTitle: "1.1 窗口" })], planTree());
    const first = tree.inPlan.children[0]!;
    expect(first.questions).toHaveLength(0);
    expect(first.children[0]!.questions).toHaveLength(1);
  });

  it("folds questions whose node left the plan tree into a snapshot folder", () => {
    const tree = buildQuizTree(
      [q({ nodeId: "gone", nodeTitle: "旧章节" })],
      planTree()
    );
    const folder = tree.inPlan.children.find((f) => f.id === "missing:gone")!;
    expect(folder).toBeDefined();
    expect(folder.missing).toBe(true);
    expect(folder.title).toBe("旧章节");
  });

  it("groups under the in-plan root even when no current plan exists", () => {
    // A question bound while a plan existed, in a session whose plan is gone: it is still
    // a planned question rather than an "other" one.
    const tree = buildQuizTree([q({ nodeId: "gone", nodeTitle: "旧章节" })], null);
    expect(tree.inPlan.children[0]!.id).toBe("missing:gone");
    expect(tree.other.questions).toHaveLength(0);
  });

  it("filters by status and verdict before grouping", () => {
    const questions = [
      q({ status: "answered", verdict: "incorrect" }),
      q({ status: "answered", verdict: "correct" }),
      q({ status: "skipped", verdict: null }),
      q({ status: "pending", verdict: null }),
    ];
    expect(
      buildQuizTree(questions, null, "wrong").other.questions.map((x) => x.verdict)
    ).toEqual(["incorrect"]);
    expect(buildQuizTree(questions, null, "skipped").other.questions).toHaveLength(1);
    // A dismissed quiz question counts as skipped for the panel's make-up filter.
    expect(
      buildQuizTree(
        [q({ status: "dismissed", verdict: null }), q({ status: "answered", verdict: null })],
        null,
        "skipped"
      ).other.questions
    ).toHaveLength(1);
    expect(buildQuizTree(questions, null, "answered").other.questions).toHaveLength(2);
  });

  it("orders questions by their Qn position", () => {
    const tree = buildQuizTree(
      [q({ position: 3, qid: "Q3" }), q({ position: 1, qid: "Q1" }), q({ position: 2, qid: "Q2" })],
      null
    );
    expect(tree.other.questions.map((x) => x.qid)).toEqual(["Q1", "Q2", "Q3"]);
  });
});

describe("flattenQuizTree", () => {
  it("always renders both roots, with question leaves one level in", () => {
    const rows = flattenQuizTree(buildQuizTree([q()], null));
    expect(rows[0]).toMatchObject({ kind: "group", id: IN_PLAN_ROOT, depth: 0 });
    expect(rows[1]).toMatchObject({ kind: "group", id: OTHER_ROOT, depth: 0 });
    const leaf = rows.find((r) => r.kind === "question");
    expect(leaf).toMatchObject({ kind: "question", depth: 1 });
  });

  it("hides a collapsed chapter's descendants but never the roots", () => {
    const tree = buildQuizTree([q({ nodeId: "c1-1", nodeTitle: "窗口" })], planTree());
    const expanded = flattenQuizTree(tree);
    expect(expanded.some((r) => r.kind === "question")).toBe(true);

    const collapsed = flattenQuizTree(tree, new Set(["c1"]));
    expect(collapsed.some((r) => r.kind === "question")).toBe(false);
    expect(collapsed.some((r) => r.kind === "group" && r.id === "c1-1")).toBe(false);
    // Roots ignore any collapse.
    const otherRoot = flattenQuizTree(tree, new Set([OTHER_ROOT])).find(
      (r) => r.kind === "group" && r.id === OTHER_ROOT
    );
    expect(otherRoot).toMatchObject({ kind: "group", id: OTHER_ROOT, depth: 0 });
  });

  it("counts a group's questions including descendants", () => {
    const tree = buildQuizTree([q({ nodeId: "c1-1", nodeTitle: "窗口" })], planTree());
    const root = flattenQuizTree(tree).find(
      (r) => r.kind === "group" && r.id === "c1"
    ) as Extract<(ReturnType<typeof flattenQuizTree>)[number], { kind: "group" }>;
    expect(root.questionCount).toBe(1);
  });
});
