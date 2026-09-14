import {
  planNodeNumbers,
  type PlanTreeNode,
  type ThreadMessageView,
  type ThreadView,
} from "../api/types";

/**
 * The thread widget's tree. Pure, on the quiz-tree pattern: grouping rules stay here and
 * unit-tested, collapse bookkeeping stays in the component.
 *
 * The shape the requirement names:
 * - 计划 (plan branch): threads nested by the LIVE plan tree — chapter 1 holds 1.1/1.2's
 *   threads — and a chapter with no thread of its own still appears as a container when a
 *   descendant has one. A node later deleted by an edit becomes a top-level "missing" row
 *   titled by the thread's stored title.
 * - 其他 (other branch): background and off-plan threads, flat in creation order.
 *
 * Neither branch is a stored row: their labels are catalog strings, so they never freeze in
 * the conversation's language.
 */

/** Synthetic branch ids; their titles come from the catalog in the component. */
export const PLAN_ROOT = "root:plan";
export const OTHER_ROOT = "root:other";

export interface PlanFolder {
  id: string;
  /** Hierarchical ordinal ("1.2"); "" for a missing-node folder. */
  number: string;
  title: string;
  /** A node that left the live plan tree (deleted by an edit). */
  missing: boolean;
  /** The one thread this node itself is, when a turn was classified onto it. */
  thread?: ThreadView;
  children: PlanFolder[];
}

export interface ThreadTree {
  /** Live plan order, with deleted-node folders appended. */
  plan: PlanFolder[];
  other: ThreadView[];
}

export function buildThreadTree(
  threads: ThreadView[],
  planTree: PlanTreeNode[] | null
): ThreadTree {
  const byNode = new Map<string, ThreadView>();
  const other: ThreadView[] = [];
  for (const thread of threads) {
    if (thread.branch === "plan" && thread.planNodeId) byNode.set(thread.planNodeId, thread);
    else if (thread.branch === "other") other.push(thread);
  }

  const plan: PlanFolder[] = [];
  const liveIds = new Set<string>();
  const numbers = planTree ? planNodeNumbers(planTree) : new Map<string, string>();

  const walkLive = (nodes: PlanTreeNode[]): void => {
    for (const node of nodes) {
      liveIds.add(node.id);
      if (node.children) walkLive(node.children);
    }
  };
  if (planTree) walkLive(planTree);

  if (planTree) {
    // Folders only for nodes that are a thread themselves or hold one below them.
    const build = (nodes: readonly PlanTreeNode[]): PlanFolder[] => {
      const folders: PlanFolder[] = [];
      for (const node of nodes) {
        const children = node.children ? build(node.children) : [];
        const thread = byNode.get(node.id);
        if (!thread && children.length === 0) continue;
        folders.push({
          id: node.id,
          number: numbers.get(node.id) ?? "",
          title: node.title,
          missing: false,
          ...(thread ? { thread } : {}),
          children,
        });
      }
      return folders;
    };
    plan.push(...build(planTree));
  }

  // A plan thread whose node left the tree (deleted, or no plan any more): keep it readable
  // at the plan root, titled by its stored snapshot, in first-thread order.
  for (const thread of byNode.values()) {
    const nodeId = thread.planNodeId!;
    if (liveIds.has(nodeId)) continue;
    plan.push({
      id: `missing:${nodeId}`,
      number: "",
      title: thread.title,
      missing: true,
      thread,
      children: [],
    });
  }

  return { plan, other };
}

/* ---------------------------------- flat rows ---------------------------------- */

export type ThreadTreeRow =
  | { kind: "branch"; id: string; depth: 0; messageCount: number }
  | {
      kind: "node";
      id: string;
      depth: number;
      number: string;
      title: string;
      missing: boolean;
      /** Set when the node itself is a thread: a click scrolls to its first message. */
      firstMessageId?: string;
      messageCount: number;
      hasChildren: boolean;
    }
  | {
      kind: "thread";
      id: string;
      depth: number;
      title: string;
      firstMessageId?: string;
      messageCount: number;
    }
  | { kind: "message"; id: string; depth: number; message: ThreadMessageView };

function threadCount(thread: ThreadView | undefined): number {
  return thread?.messages.length ?? 0;
}

function folderCount(folder: PlanFolder): number {
  return threadCount(folder.thread) + folder.children.reduce((n, child) => n + folderCount(child), 0);
}

/**
 * Flatten for rendering. A branch appears only when it holds something, so a pre-plan
 * conversation lists just 其他; both branches ignore `collapsed` (the two groupings are the
 * point of the view), while node and thread rows honour it.
 */
export function flattenThreadTree(
  tree: ThreadTree,
  collapsed: ReadonlySet<string> = new Set()
): ThreadTreeRow[] {
  const out: ThreadTreeRow[] = [];

  const leaves = (messages: ThreadMessageView[], depth: number): void => {
    for (const message of messages) {
      out.push({ kind: "message", id: message.id, depth, message });
    }
  };

  const walkFolder = (folder: PlanFolder, depth: number): void => {
    const firstMessageId = folder.thread?.messages[0]?.id;
    out.push({
      kind: "node",
      id: folder.id,
      depth,
      number: folder.number,
      title: folder.title,
      missing: folder.missing,
      ...(firstMessageId ? { firstMessageId } : {}),
      messageCount: folderCount(folder),
      hasChildren: folder.children.length > 0,
    });
    if (collapsed.has(folder.id)) return;
    if (folder.thread) leaves(folder.thread.messages, depth + 1);
    for (const child of folder.children) walkFolder(child, depth + 1);
  };

  const planCount = tree.plan.reduce((n, folder) => n + folderCount(folder), 0);
  if (planCount > 0) {
    out.push({ kind: "branch", id: PLAN_ROOT, depth: 0, messageCount: planCount });
    for (const folder of tree.plan) walkFolder(folder, 1);
  }

  const otherCount = tree.other.reduce((n, thread) => n + thread.messages.length, 0);
  if (otherCount > 0) {
    out.push({ kind: "branch", id: OTHER_ROOT, depth: 0, messageCount: otherCount });
    for (const thread of tree.other) {
      const firstMessageId = thread.messages[0]?.id;
      out.push({
        kind: "thread",
        id: thread.id,
        depth: 1,
        title: thread.title,
        ...(firstMessageId ? { firstMessageId } : {}),
        messageCount: thread.messages.length,
      });
      if (!collapsed.has(thread.id)) leaves(thread.messages, 2);
    }
  }

  return out;
}
