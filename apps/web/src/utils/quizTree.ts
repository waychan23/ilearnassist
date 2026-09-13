import {
  planNodeNumbers,
  type PlanTreeNode,
  type QuizQuestionView,
} from "../api/types";

/**
 * The quiz widget's tree grouping. Pure, so the widget's collapsed-set bookkeeping stays
 * in the component and the grouping rules stay unit-tested (components themselves are not).
 *
 * Two roots, as the requirement names them:
 * - "in plan" (学习测验): questions bound to a plan node, grouped by the LIVE plan tree so
 *   chapters keep their 1.2 numbers and order. A node later deleted by an edit falls back
 *   to a synthetic top-level folder carrying the snapshot title.
 * - "other" (其他问题): session-level questions, flat.
 */

export type QuizFilter = "all" | "answered" | "skipped" | "wrong";

/** Synthetic root ids; their titles come from the catalog in the component. */
export const IN_PLAN_ROOT = "root:in-plan";
export const OTHER_ROOT = "root:other";

export interface QuizTreeFolder {
  id: string;
  /** Hierarchical ordinal for live plan nodes ("1.2"); "" for roots/synthetic folders. */
  number: string;
  /** "" for the two roots, whose labels are catalog strings. */
  title: string;
  /** A snapshot folder whose node left the live plan tree (deleted by an edit). */
  missing: boolean;
  questions: QuizQuestionView[];
  children: QuizTreeFolder[];
}

export interface QuizTree {
  inPlan: QuizTreeFolder;
  other: QuizTreeFolder;
}

function root(id: string): QuizTreeFolder {
  return { id, number: "", title: "", missing: false, questions: [], children: [] };
}

function matches(question: QuizQuestionView, filter: QuizFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "answered":
      return question.status === "answered";
    case "skipped":
      // Skipped (walked away) and dismissed (quiz cancelled) are both "never submitted".
      return question.status === "skipped" || question.status === "dismissed";
    case "wrong":
      return question.verdict === "incorrect";
  }
}

function byPosition(a: QuizQuestionView, b: QuizQuestionView): number {
  return a.position - b.position;
}

/**
 * Build the two-root tree from the questions and the current plan (nullable). Only folders
 * holding a surviving question — directly or through descendants — survive the filter.
 */
export function buildQuizTree(
  allQuestions: QuizQuestionView[],
  planTree: PlanTreeNode[] | null,
  filter: QuizFilter = "all"
): QuizTree {
  const questions = allQuestions.filter((q) => matches(q, filter)).sort(byPosition);
  const inPlan = root(IN_PLAN_ROOT);
  const other = root(OTHER_ROOT);

  const byNode = new Map<string, QuizQuestionView[]>();
  const orphan = new Map<string, QuizQuestionView[]>();
  const liveIds = new Set<string>();
  const orphanTitles = new Map<string, string>();

  const walkLive = (nodes: PlanTreeNode[]): void => {
    for (const node of nodes) {
      liveIds.add(node.id);
      if (node.children) walkLive(node.children);
    }
  };
  if (planTree) walkLive(planTree);

  for (const question of questions) {
    if (!question.nodeId) {
      other.questions.push(question);
      continue;
    }
    if (liveIds.has(question.nodeId)) {
      const list = byNode.get(question.nodeId) ?? [];
      list.push(question);
      byNode.set(question.nodeId, list);
    } else {
      // Node deleted (or a plan-less row that somehow carried a node id): keep it readable
      // under the in-plan root, titled by the snapshot.
      const list = orphan.get(question.nodeId) ?? [];
      list.push(question);
      orphan.set(question.nodeId, list);
      orphanTitles.set(question.nodeId, question.nodeTitle ?? "");
    }
  }

  if (planTree) {
    const numbers = planNodeNumbers(planTree);

    // Folders only for nodes that have a surviving question themselves or below them.
    const build = (nodes: PlanTreeNode[]): QuizTreeFolder[] => {
      const folders: QuizTreeFolder[] = [];
      for (const node of nodes) {
        const children = node.children ? build(node.children) : [];
        const own = byNode.get(node.id) ?? [];
        if (own.length === 0 && children.length === 0) continue;
        folders.push({
          id: node.id,
          number: numbers.get(node.id) ?? "",
          title: node.title,
          missing: false,
          questions: own,
          children,
        });
      }
      return folders;
    };

    inPlan.children.push(...build(planTree));
  }

  // Snapshot folders for deleted nodes, in first-question order: stable without a live tree
  // to position them against.
  for (const [nodeId, list] of orphan) {
    inPlan.children.push({
      id: `missing:${nodeId}`,
      number: "",
      title: orphanTitles.get(nodeId) ?? "",
      missing: true,
      questions: list,
      children: [],
    });
  }

  return { inPlan, other };
}

/* ---------------------------------- flat rows ---------------------------------- */

export type QuizTreeRow =
  | {
      kind: "group";
      id: string;
      depth: number;
      number: string;
      title: string;
      missing: boolean;
      hasChildren: boolean;
      /** How many questions the group contains in total, descendants included. */
      questionCount: number;
    }
  | { kind: "question"; depth: number; question: QuizQuestionView };

function countQuestions(folder: QuizTreeFolder): number {
  return (
    folder.questions.length + folder.children.reduce((n, child) => n + countQuestions(child), 0)
  );
}

/**
 * Flatten for rendering: both roots always appear (even empty, so the grouping is visible;
 * their titles come from the catalog), a collapsed chapter hides its descendants, and
 * question leaves carry their filtered order.
 */
export function flattenQuizTree(
  tree: QuizTree,
  collapsed: ReadonlySet<string> = new Set()
): QuizTreeRow[] {
  const out: QuizTreeRow[] = [];

  const groupRow = (folder: QuizTreeFolder, depth: number): QuizTreeRow => ({
    kind: "group",
    id: folder.id,
    depth,
    number: folder.number,
    title: folder.title,
    missing: folder.missing,
    hasChildren: folder.children.length > 0,
    questionCount: countQuestions(folder),
  });

  const walkChild = (folder: QuizTreeFolder, depth: number): void => {
    out.push(groupRow(folder, depth));
    if (collapsed.has(folder.id)) return;
    for (const question of folder.questions) {
      out.push({ kind: "question", depth: depth + 1, question });
    }
    for (const child of folder.children) walkChild(child, depth + 1);
  };

  const walkRoot = (folder: QuizTreeFolder): void => {
    // Roots ignore `collapsed`: both groupings are the point of the view.
    out.push(groupRow(folder, 0));
    for (const question of folder.questions) {
      out.push({ kind: "question", depth: 1, question });
    }
    for (const child of folder.children) walkChild(child, 1);
  };

  walkRoot(tree.inPlan);
  walkRoot(tree.other);
  return out;
}
