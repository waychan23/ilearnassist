import { z } from "zod";
import type {
  PlanNodeInput,
  PlanNodeStatus,
  PlanSnapshotNode,
  PlanStatus,
  PlanTreeNode,
  PlanVersionSummary,
  PlanView,
  ToolCall,
} from "@ilearnassist/shared";
import { planNodeNumbers } from "@ilearnassist/shared";
import { newId, type AppDb, type PlanNodeInsert, type PlanNodeRecord, type PlanRecord } from "./db.js";

/**
 * The versioned plan behind the plan widget.
 *
 * Two shapes are deliberately kept apart:
 *
 * - `plan_versions.tree_json` is a **structural** snapshot — id/title/children, nothing else.
 *   Browsing V1 reads V1 as it was edited, and progress never rewrites history, which is why
 *   progress is not in it.
 * - `plan_nodes` holds each node exactly once, keyed by a server-assigned UUID that survives
 *   renames and moves, and that is the only place progress lives. The current tree is rebuilt
 *   from those rows; a node missing from a new edit stays as a **tombstone** — `deleted`,
 *   frozen at its last parent/position, rendered struck through — while dropping out of that
 *   version's snapshot.
 *
 * Everything here is reached through the plan tools (model writes) and the two GET routes
 * (widget reads); there is no UI write path yet, but nothing in this shape rules one out.
 */

export const PLAN_MAX_NODES = 300;
export const PLAN_MAX_DEPTH = 8;
export const PLAN_TITLE_MAX = 200;

/* --------------------------------- input parsing -------------------------------- */

const nodeInputSchema: z.ZodType<PlanNodeInput> = z.lazy(() =>
  z.object({
    id: z.string().min(1).max(100).optional(),
    title: z.string().min(1).max(PLAN_TITLE_MAX),
    children: z.array(nodeInputSchema).optional(),
  })
);

/** The shape `ila_make_plan` accepts; also the validator the conflict resume runs. */
export const planTreeInputSchema = z.object({
  tree: z.array(nodeInputSchema).min(1).max(PLAN_MAX_NODES),
});

export const planProgressInputSchema = z
  .object({
    planStatus: z.enum(["not_started", "in_progress", "completed"]).optional(),
    nodes: z
      .array(
        z.object({
          id: z.string().min(1).max(100),
          status: z.enum(["not_started", "in_progress", "completed", "skipped", "deleted"]),
        })
      )
      .max(PLAN_MAX_NODES)
      .optional(),
  })
  .refine((v) => v.planStatus !== undefined || (v.nodes !== undefined && v.nodes.length > 0), {
    message: "say which plan/node statuses to change",
  });

/** A submission flattened into the shape the merge walks, with trimmed titles. */
interface NormNode {
  /** The id the model supplied, or null for a node this edit creates. */
  id: string | null;
  title: string;
  children: NormNode[];
}

function normalizeTree(nodes: PlanNodeInput[]): NormNode[] {
  let count = 0;
  const walk = (list: PlanNodeInput[], depth: number): NormNode[] => {
    if (depth > PLAN_MAX_DEPTH) {
      throw new Error(`ila_make_plan: a plan is at most ${PLAN_MAX_DEPTH} levels deep`);
    }
    return list.map((n) => {
      count += 1;
      if (count > PLAN_MAX_NODES) {
        throw new Error(`ila_make_plan: a plan has at most ${PLAN_MAX_NODES} nodes`);
      }
      const title = n.title.trim();
      if (!title) throw new Error("ila_make_plan: every node needs a non-empty title");
      const id = typeof n.id === "string" && n.id.trim() ? n.id.trim() : null;
      return { id, title, children: n.children ? walk(n.children, depth + 1) : [] };
    });
  };
  return walk(nodes, 1);
}

/** Every id the submission uses, rejecting a repeated one — one id must mean one node. */
function collectIds(nodes: NormNode[]): Set<string> {
  const ids = new Set<string>();
  const walk = (list: NormNode[]): void => {
    for (const n of list) {
      if (n.id) {
        if (ids.has(n.id)) {
          throw new Error(`ila_make_plan: node id ${n.id} appears more than once in the tree`);
        }
        ids.add(n.id);
      }
      walk(n.children);
    }
  };
  walk(nodes);
  return ids;
}

/* ------------------------------------ results ------------------------------------ */

export interface PlanCommitResult {
  planId: string;
  version: number;
  status: PlanStatus;
  tree: PlanTreeNode[];
  createdAt: string;
  updatedAt: string;
}

/** The "a plan already exists and this submission looks like a fresh create" fork. */
export interface PlanConflict {
  conflict: true;
}

export type MakePlanResult = PlanCommitResult | PlanConflict;

export function planConflicted(r: MakePlanResult): r is PlanConflict {
  return "conflict" in r;
}

/* ----------------------------------- tree helpers ----------------------------------- */

interface ResolvedNode {
  id: string;
  title: string;
  children: ResolvedNode[];
}

function toSnapshot(nodes: ResolvedNode[]): PlanSnapshotNode[] {
  return nodes.map((n) => {
    const children = n.children.length > 0 ? toSnapshot(n.children) : undefined;
    return children ? { id: n.id, title: n.title, children } : { id: n.id, title: n.title };
  });
}

/** All live nodes completed → completed; anything underway/skipped → in progress. */
function derivePlanStatus(live: { status: PlanNodeStatus }[]): PlanStatus {
  if (live.length === 0) return "not_started";
  if (live.every((n) => n.status === "completed")) return "completed";
  if (live.some((n) => n.status !== "not_started")) return "in_progress";
  return "not_started";
}

/** What the rollup reads, so a stored row and a pending insert can both take part. */
interface RollupNode {
  id: string;
  parentId: string | null;
  position: number;
  status: PlanNodeStatus;
  removedVersion: number | null;
  anchorToolCallId: string | null;
  anchorAt: string | null;
}

/** A live node's derived state: its status, and the anchor a click should land on. */
interface EffectiveNode {
  status: PlanNodeStatus;
  anchorToolCallId: string | null;
  anchorAt: string | null;
}

/**
 * The status and anchor every node must hold, derived from its live children.
 *
 * Status:
 * - Every live child completed → `completed` (a chapter is done when its topics are; the
 *   promotion cascades, so a completion can finish its section, chapter and the whole plan).
 * - Any child completed or in_progress, or a completed container with any unfinished child →
 *   `in_progress`. A chapter with a topic underway is underway, for the same reason at the
 *   plan level `derivePlanStatus` treats any started node as in progress.
 * - A child that is only `skipped` does **not** drag the container into `in_progress`; the
 *   jump marks a passed-over chapter and its topics together, and flipping the chapter would
 *   take its play affordance away (only not-started/skipped nodes are playable).
 * - Otherwise no opinion: a leaf's own status, an empty container, and a container someone
 *   opened (jump) or skipped all keep whatever the row says. Deriving `not_started` for every
 *   all-unstarted parent would erase the `in_progress` jump deliberately writes.
 *
 * Anchor: a container that reads as `completed` or `in_progress` but carries no anchor of its
 * own — a chapter just rolled up, or one a jump opened — borrows the anchor of the **first
 * live child in document order** that is itself jumpable (completed or in_progress, with an
 * anchor to land on; a derived container child answers the same way). The chapter's click then
 * lands where its first started/finished section begins, and a completion rolled up from rows
 * written before the rollup existed is locatable without a stored marker of its own.
 *
 * Tombstones are not children any more. A `skipped` child is unfinished and blocks the
 * rollup, the same reading `derivePlanStatus` takes.
 *
 * Read as well as written: `buildCurrentTree` derives display state from it, so rows written
 * before the rollup existed (or by an older build) still render consistently, and the write
 * paths persist exactly what a read derives.
 */
function effectiveNodes(nodes: RollupNode[]): Map<string, EffectiveNode> {
  const live = nodes.filter((n) => n.removedVersion === null);
  const childrenOf = new Map<string, RollupNode[]>();
  for (const n of live) {
    if (!n.parentId) continue;
    const list = childrenOf.get(n.parentId) ?? [];
    list.push(n);
    childrenOf.set(n.parentId, list);
  }
  // Document order, so "the first jumpable child" is a well-defined one.
  for (const list of childrenOf.values()) list.sort((a, b) => a.position - b.position);

  const status = new Map<string, PlanNodeStatus>(live.map((n) => [n.id, n.status]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of live) {
      const children = childrenOf.get(n.id);
      if (!children || children.length === 0) continue;
      const current = status.get(n.id)!;
      const allDone = children.every((c) => status.get(c.id) === "completed");
      const started = children.some((c) => {
        const childStatus = status.get(c.id);
        return childStatus === "completed" || childStatus === "in_progress";
      });
      const next: PlanNodeStatus = allDone
        ? "completed"
        : started || current === "completed"
          ? "in_progress"
          : current;
      if (next !== current) {
        status.set(n.id, next);
        changed = true;
      }
    }
  }

  // A node's own anchor wins; otherwise a jumpable container borrows, fixpoint, so a derived
  // child's borrowed anchor can itself be borrowed one level up.
  const anchors = new Map<string, { toolCallId: string; at: string | null }>();
  for (const n of live) {
    if (n.anchorToolCallId) anchors.set(n.id, { toolCallId: n.anchorToolCallId, at: n.anchorAt });
  }
  changed = true;
  while (changed) {
    changed = false;
    for (const n of live) {
      if (anchors.has(n.id)) continue;
      const children = childrenOf.get(n.id);
      if (!children || children.length === 0) continue;
      const own = status.get(n.id)!;
      if (own !== "completed" && own !== "in_progress") continue;
      const first = children.find((c) => {
        const childStatus = status.get(c.id)!;
        return (
          (childStatus === "completed" || childStatus === "in_progress") && anchors.has(c.id)
        );
      });
      const borrowed = first ? anchors.get(first.id) : undefined;
      if (borrowed) {
        anchors.set(n.id, borrowed);
        changed = true;
      }
    }
  }

  return new Map(
    live.map((n) => [
      n.id,
      {
        status: status.get(n.id)!,
        anchorToolCallId: anchors.get(n.id)?.toolCallId ?? null,
        anchorAt: anchors.get(n.id)?.at ?? null,
      },
    ])
  );
}

/**
 * Persist what `effectiveNodes` says the containers must be, reading the plan's rows fresh.
 *
 * A promotion takes the derived anchor — the first jumpable child's marker — so a container
 * that rolls up or starts up lands where that section began, not on whatever call happened to
 * trigger the scan; `completingCallId` is only the fallback for a container whose children
 * carry no anchor, and is empty on the paths with no call to name (an edit or a jump). A
 * container whose own row already carries an anchor keeps it, the same way a demotion and an
 * explicit `in_progress` do.
 */
function persistEffectiveStatuses(
  db: AppDb,
  planId: string,
  ts: string,
  completingCallId: string
): void {
  const rows = db.listPlanNodes(planId);
  const effective = effectiveNodes(rows);
  for (const row of rows) {
    const node = effective.get(row.id);
    if (!node || node.status === row.status) continue;
    if (node.status === "completed") {
      db.updatePlanNodeProgress(
        planId,
        row.id,
        "completed",
        node.anchorToolCallId ?? (completingCallId || null),
        node.anchorAt ?? (completingCallId ? ts : null),
        row.startMessageId,
        null,
        null
      );
    } else {
      // in_progress, whether promoted from not-started/skipped or demoted from completed:
      // keep the row's own anchor when it has one, otherwise persist the borrowed one so the
      // stored row answers exactly what a read derives, and skip facts are cleared.
      db.updatePlanNodeProgress(
        planId,
        row.id,
        node.status,
        node.anchorToolCallId,
        node.anchorAt,
        row.startMessageId,
        null,
        null
      );
    }
  }
}

/* ------------------------------------ commits ------------------------------------ */

function commitCreate(db: AppDb, sessionId: string, submitted: NormNode[]): PlanCommitResult {
  const ts = new Date().toISOString();
  const planId = newId();

  // Every node is new: assign ids up front so the snapshot and the rows agree.
  const assign = (list: NormNode[]): ResolvedNode[] =>
    list.map((n) => ({ id: newId(), title: n.title, children: assign(n.children) }));
  const resolved = assign(submitted);

  const writes = (): void => {
    db.insertPlan({ id: planId, sessionId, version: 1, status: "not_started", createdAt: ts, updatedAt: ts });
    db.insertPlanVersion({
      id: newId(),
      planId,
      version: 1,
      treeJson: JSON.stringify(toSnapshot(resolved)),
      createdAt: ts,
    });
    const write = (list: ResolvedNode[], parentId: string | null): void => {
      list.forEach((n, position) => {
        const insert: PlanNodeInsert = {
          id: n.id,
          planId,
          parentId,
          position,
          title: n.title,
          status: "not_started",
          introducedVersion: 1,
        };
        db.insertPlanNode(insert);
        write(n.children, n.id);
      });
    };
    write(resolved, null);
  };
  db.raw.transaction(writes)();

  // PlanView is a PlanCommitResult plus `versions`, so it satisfies the narrower return.
  return buildPlanView(db, db.getPlanBySession(sessionId)!);
}

function commitEdit(db: AppDb, plan: PlanRecord, submitted: NormNode[]): PlanCommitResult {
  const existing = db.listPlanNodes(plan.id);
  const byId = new Map<string, PlanNodeRecord>(existing.map((r) => [r.id, r]));

  // Every id the model kept has to be one this plan holds and that is still alive. Reusing a
  // tombstone id is refused — an id deleted in Vn names that old node forever; a replacement
  // is a new node without an id.
  for (const id of collectIds(submitted)) {
    const row = byId.get(id);
    if (!row) {
      throw new Error(
        `ila_make_plan: node id ${id} is not part of this plan. Edit existing nodes with ` +
          "the ids ila_read_plan returned, and omit the id for new nodes."
      );
    }
    if (row.removedVersion !== null) {
      throw new Error(
        `ila_make_plan: node ${id} was deleted in an earlier version; add a new node without an id instead.`
      );
    }
  }

  const ts = new Date().toISOString();
  // Derived from the row just read: better-sqlite3 is synchronous and single-process, so
  // nothing can interleave between the read and the transaction below.
  const newVersion = plan.version + 1;
  const touched = new Set<string>();
  const inserts: PlanNodeInsert[] = [];
  const structureUpdates: {
    id: string;
    parentId: string | null;
    position: number;
    title: string;
  }[] = [];

  const resolve = (list: NormNode[], parentId: string | null): ResolvedNode[] =>
    list.map((n, position) => {
      let id: string;
      if (n.id) {
        id = n.id;
        touched.add(id);
        structureUpdates.push({ id, parentId, position, title: n.title });
      } else {
        id = newId();
        inserts.push({
          id,
          planId: plan.id,
          parentId,
          position,
          title: n.title,
          status: "not_started",
          introducedVersion: newVersion,
        });
      }
      return { id, title: n.title, children: resolve(n.children, id) };
    });
  const resolvedTree = resolve(submitted, null);

  // Alive nodes the submission no longer mentions become tombstones in this version.
  const removed = existing.filter((r) => r.removedVersion === null && !touched.has(r.id));

  // Status the plan should hold after the merge: surviving nodes keep their progress, new
  // nodes start unstarted, tombstones stop counting — and containers derive from their live
  // children, so an added child reopens a completed parent while dropping the last unfinished
  // child completes it. Moved nodes count under the parent this edit gives them, which is why
  // the merge applies `structureUpdates` rather than reading `existing` as it was.
  const moved = new Map(structureUpdates.map((u) => [u.id, u]));
  const merged: RollupNode[] = [];
  for (const r of existing) {
    if (r.removedVersion !== null) continue;
    if (removed.some((x) => x.id === r.id)) continue;
    const place = moved.get(r.id);
    merged.push({
      id: r.id,
      parentId: place?.parentId ?? r.parentId,
      position: place?.position ?? r.position,
      status: r.status,
      removedVersion: null,
      anchorToolCallId: r.anchorToolCallId,
      anchorAt: r.anchorAt,
    });
  }
  for (const n of inserts) {
    merged.push({
      id: n.id,
      parentId: n.parentId,
      position: n.position,
      status: n.status,
      removedVersion: null,
      anchorToolCallId: null,
      anchorAt: null,
    });
  }
  const effective = effectiveNodes(merged);
  const finalStatus = derivePlanStatus(
    [...effective.values()].map((n) => ({ status: n.status }))
  );

  const writes = (): void => {
    // Increments version = version + 1 and sets the final status in one statement.
    db.bumpPlanVersion(plan.id, finalStatus, ts);
    db.insertPlanVersion({
      id: newId(),
      planId: plan.id,
      version: newVersion,
      treeJson: JSON.stringify(toSnapshot(resolvedTree)),
      createdAt: ts,
    });
    for (const node of inserts) db.insertPlanNode(node);
    for (const u of structureUpdates) {
      db.updatePlanNodeStructure({ ...u, planId: plan.id });
    }
    for (const row of removed) db.softDeletePlanNode(plan.id, row.id, newVersion);
    // The shape is final now, so the same reconciliation the progress path runs persists the
    // derived container statuses. No tool call exists on an edit, so promotions carry the
    // node's own anchor or none.
    persistEffectiveStatuses(db, plan.id, ts, "");
    db.setPlanStatus(plan.id, finalStatus, ts);
  };
  db.raw.transaction(writes)();

  return buildPlanView(db, db.getPlanBySession(plan.sessionId)!);
}

/* ----------------------------------- public API ----------------------------------- */

/**
 * Create V1, edit to a new version, or report the create-vs-existing conflict.
 *
 * The conflict is a *result* here rather than a throw: the suspension class belongs to the
 * tool layer, and the conflict resume commits through `forceMakePlan` without suspending.
 */
export function makePlan(db: AppDb, sessionId: string, rawInput: unknown): MakePlanResult {
  const parsed = planTreeInputSchema.parse(rawInput);
  const submitted = normalizeTree(parsed.tree);

  const plan = db.getPlanBySession(sessionId);
  if (!plan) return commitCreate(db, sessionId, submitted);

  // A submission carrying no id at all reads as "create a new plan"; one carrying any id
  // reads as an edit (new children may still omit ids). The fork is the model's to ask about.
  if (collectIds(submitted).size === 0) return { conflict: true };

  return commitEdit(db, plan, submitted);
}

/** The conflict's "edit" fork: overwrite the existing plan as a new version, never suspending. */
export function forceMakePlan(db: AppDb, sessionId: string, rawInput: unknown): PlanCommitResult {
  const parsed = planTreeInputSchema.parse(rawInput);
  const submitted = normalizeTree(parsed.tree);
  const plan = db.getPlanBySession(sessionId);
  if (!plan) return commitCreate(db, sessionId, submitted);
  // No ids means a wholesale replacement: every existing node is a candidate for the
  // tombstone set, which commitEdit derives from the touched set. With ids it is a normal edit.
  return commitEdit(db, plan, submitted);
}

/** The current plan, or undefined when the conversation has none. */
export function readCurrentPlan(db: AppDb, sessionId: string): PlanView | undefined {
  const plan = db.getPlanBySession(sessionId);
  return plan ? buildPlanView(db, plan) : undefined;
}

/**
 * Apply a batch of progress changes. `deleted` is deliberately refused: a node is deleted by
 * an edit (ila_make_plan), not by a progress update, so the two write paths cannot disagree
 * about what a tombstone is.
 */
export function applyProgress(
  db: AppDb,
  sessionId: string,
  rawInput: unknown,
  anchorToolCallId: string
): PlanView {
  const input = planProgressInputSchema.parse(rawInput);
  const plan = db.getPlanBySession(sessionId);
  if (!plan) throw new Error("ila_update_plan_progress: this conversation has no plan yet");

  const rows = db.listPlanNodes(plan.id);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ts = new Date().toISOString();

  const writes = (): void => {
    for (const change of input.nodes ?? []) {
      const row = byId.get(change.id);
      if (!row) {
        throw new Error(`ila_update_plan_progress: node ${change.id} is not part of this plan`);
      }
      if (row.removedVersion !== null) {
        throw new Error(`ila_update_plan_progress: node ${change.id} was deleted; progress cannot change`);
      }
      if (change.status === "deleted") {
        throw new Error(
          "ila_update_plan_progress: nodes are deleted by editing the plan with ila_make_plan, not here"
        );
      }
      if (change.status === "in_progress" || change.status === "completed") {
        // The start anchor: the call placed *before* the node is taught, which is the jump
        // target a reader wants; first start wins. Completion keeps it, falling back to the
        // completion call when the node finished in one step. The resolved start message is
        // kept and filled post-turn; any old skip facts are cleared.
        db.updatePlanNodeProgress(
          plan.id,
          row.id,
          change.status,
          row.anchorToolCallId ?? (anchorToolCallId || null),
          row.anchorAt ?? (anchorToolCallId ? ts : null),
          row.startMessageId,
          null,
          null
        );
      } else if (change.status === "skipped") {
        // A skip preserves whatever start marker the node has — a node skipped mid-study
        // differs from one never begun. The message position is filled post-turn.
        db.skipPlanNode(plan.id, row.id, ts, null);
      } else {
        // Explicit reset to not-started clears every marker.
        db.updatePlanNodeProgress(plan.id, row.id, change.status, null, null, null, null, null);
      }
    }

    // Completing a node can complete its ancestors; reopening one can reopen them. The rollup
    // runs before the plan status so that status sees the nodes as they now stand.
    persistEffectiveStatuses(db, plan.id, ts, anchorToolCallId);

    let status: PlanStatus;
    if (input.planStatus) {
      status = input.planStatus;
    } else {
      const live = db
        .listPlanNodes(plan.id)
        .filter((r) => r.removedVersion === null)
        .map((r) => ({ status: r.status }));
      status = derivePlanStatus(live);
    }
    db.setPlanStatus(plan.id, status, ts);
  };
  db.raw.transaction(writes)();

  return buildPlanView(db, db.getPlanBySession(sessionId)!);
}

/**
 * Rebuild the current tree from the node rows.
 *
 * Alive nodes are ordered by their sibling position; tombstones are appended after the live
 * siblings at their frozen parent (a deleted parent keeps its deleted children nested under
 * it). Status and the completion anchor ride along; versions never do.
 */
function buildCurrentTree(rows: PlanNodeRecord[]): PlanTreeNode[] {
  const byParent = new Map<string | null, PlanNodeRecord[]>();
  for (const row of rows) {
    const list = byParent.get(row.parentId) ?? [];
    list.push(row);
    byParent.set(row.parentId, list);
  }
  const known = new Set(rows.map((r) => r.id));
  // Display state is derived, not copied: a plan whose rows predate the rollup (or were
  // written by a build without it) still reads as its children say it is — including the
  // anchor a rolled-up container borrows from its first jumpable child.
  const effective = effectiveNodes(rows);

  const build = (parentId: string | null): PlanTreeNode[] => {
    const list = byParent.get(parentId) ?? [];
    // A parent row can never vanish, but a defensive root-attach keeps a node readable if a
    // future migration ever orphans one.
    if (parentId !== null && !known.has(parentId)) return build(null);
    const alive = list
      .filter((r) => r.removedVersion === null)
      .sort((a, b) => a.position - b.position);
    const tombstones = list
      .filter((r) => r.removedVersion !== null)
      .sort((a, b) => a.position - b.position);
    return [...alive, ...tombstones].map((r) => {
      const derived = effective.get(r.id);
      const node: PlanTreeNode = {
        id: r.id,
        title: r.title,
        status: derived?.status ?? r.status,
      };
      // A click jumps to the node's start marker (in_progress call before the content), or to
      // the completion call when no separate start was recorded; a rolled-up container borrows
      // its first jumpable child's marker.
      const anchor = derived?.anchorToolCallId ?? r.anchorToolCallId;
      if (anchor) node.anchorToolCallId = anchor;
      // The skip/start message facts ride along from the row; they never derive.
      if (r.startMessageId) node.startMessageId = r.startMessageId;
      if (r.skippedAt) node.skippedAt = r.skippedAt;
      if (r.skippedMessageId) node.skippedMessageId = r.skippedMessageId;
      const children = build(r.id);
      if (children.length > 0) node.children = children;
      return node;
    });
  };
  return build(null);
}

export function buildPlanView(db: AppDb, plan: PlanRecord): PlanView {
  const rows = db.listPlanNodes(plan.id);
  const versions: PlanVersionSummary[] = db.listPlanVersions(plan.id);
  return {
    planId: plan.id,
    version: plan.version,
    status: plan.status,
    tree: buildCurrentTree(rows),
    versions,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

export interface PlanJumpResult {
  view: PlanView;
  /** The target's hierarchical ordinal in the live tree, e.g. "1.2". */
  number: string;
  title: string;
  /** How many not-yet-done nodes were marked skipped to get there. */
  skippedCount: number;
  /** The target had actually started before (a skipped node with a start marker). */
  started: boolean;
  /** The target's start message, when one was resolved. */
  startMessageId: string | null;
  /** The skip position the target sat at before being opened. */
  skippedMessageId: string | null;
}

/**
 * Move study to one chapter, as the widget's play button asks.
 *
 * Everything undone that the learner is jumping *past* is marked `skipped` (including the
 * chapter currently in progress, which is the case the requirement names): all live nodes
 * before the target in document order that are not its ancestors. The target and its
 * containing chapters are opened (`in_progress`) rather than skipped — you cannot be in
 * 2.1 while chapter 2 is skipped. Completed nodes are never touched. This is a user action,
 * not a model one, which is why it lives behind its own route rather than in the progress
 * tool.
 */
export function jumpToNode(db: AppDb, sessionId: string, nodeId: string): PlanJumpResult {
  const plan = db.getPlanBySession(sessionId);
  if (!plan) throw new Error("this conversation has no plan yet");
  const view = buildPlanView(db, plan);

  /** Live nodes only, in document order. */
  const live: PlanTreeNode[] = [];
  const strip = (nodes: PlanTreeNode[]): PlanTreeNode[] =>
    nodes
      .filter((n) => n.status !== "deleted")
      .map((n) => ({ ...n, children: n.children ? strip(n.children) : undefined }));
  const liveTree = strip(view.tree);
  const dfs = (nodes: PlanTreeNode[]): void => {
    for (const n of nodes) {
      live.push(n);
      if (n.children) dfs(n.children);
    }
  };
  dfs(liveTree);

  const target = live.find((n) => n.id === nodeId);
  if (!target) {
    throw new Error(`node ${nodeId} is not a live node in this plan`);
  }
  if (target.status === "completed") {
    throw new Error("that node is already completed");
  }

  // Target facts captured from the pre-jump tree; opening below clears its skip columns.
  const targetStarted = !!target.anchorToolCallId;
  const targetStartMessageId = target.startMessageId ?? null;
  const targetSkippedMessageId = target.skippedMessageId ?? null;
  // The abandoned position every newly skipped node records (null when the session has no
  // messages yet — the first turn resolves it post-turn).
  const lastMessageId = db.lastSessionMessageId(sessionId);

  const targetIndex = live.indexOf(target);
  const ancestors = new Set<string>();
  const collectAncestors = (
    nodes: PlanTreeNode[],
    chain: PlanTreeNode[]
  ): boolean => {
    for (const n of nodes) {
      if (n.id === nodeId) {
        chain.forEach((a) => ancestors.add(a.id));
        return true;
      }
      if (n.children && collectAncestors(n.children, [...chain, n])) return true;
    }
    return false;
  };
  collectAncestors(liveTree, []);

  const skippedIds = live
    .slice(0, targetIndex)
    .filter((n) => !ancestors.has(n.id) && (n.status === "not_started" || n.status === "in_progress"))
    .map((n) => n.id);
  // The target is always opened (a skipped node can be revisited); containing chapters are
  // opened unless they already carry progress or completion.
  const toOpen = (id: string): boolean => {
    const n = live.find((x) => x.id === id);
    return !!n && (n.status === "not_started" || n.status === "skipped");
  };
  const openedIds = [target.id, ...ancestors].filter(toOpen);

  const ts = new Date().toISOString();
  const writes = (): void => {
    // Skip facts only: an in-progress node keeps its start marker, an unstarted one has none.
    for (const id of skippedIds) {
      db.skipPlanNode(plan.id, id, ts, lastMessageId);
    }
    // The target is opened without clearing any start marker it had; its teaching continues
    // in the turn that follows. Ancestors are opened the same way.
    for (const id of openedIds) {
      db.openPlanNode(plan.id, id);
    }
    // A jump only skips and opens nodes, but the reconciliation still runs: an opened child
    // under a completed container reopens it, which is the legacy state the rollup must not
    // leave standing. No call is being completed here.
    persistEffectiveStatuses(db, plan.id, ts, "");
    const rows = db.listPlanNodes(plan.id).filter((r) => r.removedVersion === null);
    db.setPlanStatus(plan.id, derivePlanStatus(rows.map((r) => ({ status: r.status }))), ts);
  };
  db.raw.transaction(writes)();

  const numbers = planNodeNumbers(liveTree);
  return {
    view: buildPlanView(db, db.getPlanBySession(sessionId)!),
    number: numbers.get(nodeId) ?? "",
    title: target.title,
    skippedCount: skippedIds.length,
    started: targetStarted,
    startMessageId: targetStartMessageId,
    skippedMessageId: targetSkippedMessageId,
  };
}

export interface PlanMessageResolution {
  /** Nodes whose start message was resolved this call. */
  starts: number;
  /** Nodes whose skip position was set to the just-finished turn's message. */
  skips: number;
}

/**
 * Resolve the message columns of a session's plan nodes.
 *
 * Anchors are tool-call ids, so the start message resolves by mapping every live message's
 * tool calls to that message and filling each node whose anchor never resolved. Called after
 * every finished turn: a node marked `in_progress` in that turn gains its message, and a skip
 * the turn's progress tool made lands on the turn's assistant message (`turn.sinceIso` bounds
 * which skips that can be — jump skips already carry their position and an earlier instant).
 */
export function resolvePlanStartMessages(
  db: AppDb,
  userId: string,
  sessionId: string,
  turn?: { assistantMessageId: string; sinceIso: string }
): PlanMessageResolution {
  const planRow = db.getPlanBySession(sessionId);
  if (!planRow) return { starts: 0, skips: 0 };

  // Tool-call id → the message it sits in, over every live message.
  const anchorMessages = new Map<string, string>();
  for (const message of db.listMessagesForUser(sessionId, userId)) {
    for (const call of message.toolCalls ?? []) {
      anchorMessages.set(call.id, message.id);
    }
  }

  let starts = 0;
  let skips = 0;
  for (const node of db.listPlanNodes(planRow.id)) {
    if (node.anchorToolCallId && !node.startMessageId) {
      const messageId = anchorMessages.get(node.anchorToolCallId);
      if (messageId) {
        db.fillPlanNodeMessageIds(planRow.id, node.id, messageId, null);
        starts += 1;
      }
    }
    if (
      turn &&
      node.status === "skipped" &&
      node.skippedAt &&
      node.skippedAt >= turn.sinceIso
    ) {
      db.setPlanNodeSkippedMessage(planRow.id, node.id, turn.assistantMessageId);
      skips += 1;
    }
  }
  return { starts, skips };
}

/** One historical version, structure only. `undefined` when the version never existed. */
export function readPlanVersion(
  db: AppDb,
  userId: string,
  sessionId: string,
  version: number
): { version: number; createdAt: string; tree: PlanSnapshotNode[] } | undefined {
  const row = db.getPlanVersionForUser(userId, sessionId, version);
  if (!row) return undefined;
  try {
    const tree = JSON.parse(row.treeJson) as PlanSnapshotNode[];
    return { version: row.version, createdAt: row.createdAt, tree };
  } catch {
    // A damaged snapshot should read as "not this version" rather than 500 the whole widget.
    return undefined;
  }
}

/* ------------------------------ conflict call persistence ------------------------------ */

/**
 * The tree recorded on a suspended `ila_make_plan` call, or undefined when the stored input
 * is not one. The conflict commit re-validates it before writing anything.
 */
export function readPlanConflictTree(call: ToolCall): unknown {
  try {
    const parsed = JSON.parse(call.input) as { tree?: unknown };
    return parsed.tree;
  } catch {
    return undefined;
  }
}

/* --------------------------------- model-facing results --------------------------------- */

export function renderMakeResult(view: PlanCommitResult): string {
  return JSON.stringify(
    {
      version: view.version,
      status: view.status,
      tree: view.tree,
      note: "The plan panel now shows this. Present the full plan to the user in your message as well, in a readable outline, so the conversation itself shows what was decided.",
    },
    null,
    2
  );
}

export function renderReadResult(view: PlanView | undefined): string {
  if (!view) {
    return JSON.stringify({ plan: null, note: "This conversation has no plan yet." });
  }
  return JSON.stringify(
    {
      version: view.version,
      status: view.status,
      tree: view.tree,
      note: "Every node carries its id and current status. Keep these ids when editing the plan with ila_make_plan; omit the id only for nodes you are adding.",
    },
    null,
    2
  );
}

export function renderProgressResult(view: PlanView, changed: number): string {
  return JSON.stringify(
    {
      changedNodes: changed,
      planStatus: view.status,
      version: view.version,
      note: "The plan panel now reflects this progress.",
    },
    null,
    2
  );
}
