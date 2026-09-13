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
  // nodes start unstarted, tombstones stop counting.
  const liveAfter: { status: PlanNodeStatus }[] = [];
  for (const row of existing) {
    if (row.removedVersion !== null) continue;
    if (removed.some((r) => r.id === row.id)) continue;
    liveAfter.push({ status: row.status });
  }
  for (const _ of inserts) liveAfter.push({ status: "not_started" });
  const finalStatus = derivePlanStatus(liveAfter);

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
      if (change.status === "completed") {
        // First completion records the jump anchor; a repeat must not move it to a later turn.
        db.updatePlanNodeProgress(
          plan.id,
          row.id,
          "completed",
          row.status === "completed" ? row.doneToolCallId : anchorToolCallId,
          row.status === "completed" ? row.doneAt : ts
        );
      } else {
        // Leaving completed clears the anchor — the message it pointed at is no longer the answer.
        db.updatePlanNodeProgress(plan.id, row.id, change.status, null, null);
      }
    }

    let status: PlanStatus;
    if (input.planStatus) {
      status = input.planStatus;
    } else {
      const live = db
        .listPlanNodes(plan.id)
        .filter((r) => r.removedVersion === null && !(input.nodes ?? []).some((n) => n.id === r.id))
        .map((r) => ({ status: r.status }));
      for (const n of input.nodes ?? []) {
        if (n.status !== "deleted") live.push({ status: n.status });
      }
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
      const node: PlanTreeNode = {
        id: r.id,
        title: r.title,
        status: r.status,
      };
      if (r.status === "completed" && r.doneToolCallId) node.doneToolCallId = r.doneToolCallId;
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
