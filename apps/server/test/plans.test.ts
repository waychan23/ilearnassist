import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlanNodeInput, PlanTreeNode, PlanView } from "@ilearnassist/shared";
import { createDb, DEFAULT_SESSION_TITLE, type AppDb } from "../src/db.js";
import {
  applyProgress,
  forceMakePlan,
  jumpToNode,
  makePlan,
  planConflicted,
  planTreeInputSchema,
  readCurrentPlan,
  readPlanVersion,
  renderChapterJumpGuidance,
  resolvePlanStartMessages,
} from "../src/plans.js";

let root: string;
let db: AppDb;
const OWNER = "u1";
const OTHER = "u2";
const SESSION = "s1";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gl-plans-"));
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
});

afterEach(() => {
  try {
    db.raw.close();
  } catch {
    /* already closed */
  }
  rmSync(root, { recursive: true, force: true });
});

const input = (tree: PlanNodeInput[]) => ({ tree });

/** Every node in a current view, flattened. */
function flatten(nodes: PlanTreeNode[]): PlanTreeNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children ?? [])]);
}

/** Anything carrying a current tree — both the commit result and the full view. */
type TreeHolder = Pick<PlanView, "tree">;

function byTitle(view: TreeHolder, title: string): PlanTreeNode {
  const node = flatten(view.tree).find((n) => n.title === title);
  if (!node) throw new Error(`no node titled ${title}`);
  return node;
}

/** A three-node plan: A with child A1, plus B. */
function basicTree(): PlanNodeInput[] {
  return [{ title: "A", children: [{ title: "A1" }] }, { title: "B" }];
}

describe("makePlan — V1", () => {
  it("assigns every node an id and records V1 as not started", () => {
    const result = makePlan(db, SESSION, input(basicTree()));
    if (planConflicted(result)) throw new Error("should create");

    expect(result.version).toBe(1);
    expect(result.status).toBe("not_started");
    const flat = flatten(result.tree);
    expect(flat).toHaveLength(3);
    expect(flat.every((n) => n.id.length > 0)).toBe(true);
    expect(flat.every((n) => n.status === "not_started")).toBe(true);
    // Parent/child structure survives.
    expect(result.tree[0]?.children?.[0]?.title).toBe("A1");
  });

  it("is readable back with its version summary", () => {
    makePlan(db, SESSION, input(basicTree()));
    const view = readCurrentPlan(db, SESSION);
    expect(view?.versions).toEqual([{ version: 1, createdAt: expect.any(String) }]);
    expect(db.getPlanForSessionForUser(OWNER, SESSION)?.version).toBe(1);
  });

  it("rejects malformed trees through the zod schema", () => {
    expect(() => makePlan(db, SESSION, { tree: [] })).toThrow();
    expect(() => makePlan(db, SESSION, { tree: [{ title: "" }] })).toThrow();
    expect(planTreeInputSchema.safeParse({ tree: "nope" }).success).toBe(false);
  });
});

describe("makePlan — the create-vs-existing conflict", () => {
  it("reports a conflict when the plan exists and no id is supplied", () => {
    makePlan(db, SESSION, input(basicTree()));
    const second = makePlan(db, SESSION, input([{ title: "Brand new" }]));
    expect(planConflicted(second)).toBe(true);
    // Nothing was written: still V1 with its three nodes.
    expect(readCurrentPlan(db, SESSION)?.version).toBe(1);
  });

  it("treats a submission carrying any id as an edit, not a conflict", () => {
    const v1 = makePlan(db, SESSION, input(basicTree()));
    if (planConflicted(v1)) throw new Error("should create");
    const aId = v1.tree[0]!.id;
    const result = makePlan(db, SESSION, {
      tree: [{ id: aId, title: "A", children: [{ title: "A1" }] }, { title: "B" }],
    });
    if (planConflicted(result)) throw new Error("should edit");
    expect(result.version).toBe(2);
  });
});

describe("edits", () => {
  it("keeps ids, renames, adds nodes and writes a structural snapshot per version", () => {
    const v1 = makePlan(db, SESSION, input(basicTree()));
    if (planConflicted(v1)) throw new Error("should create");
    const a = byTitle(v1, "A");
    const a1 = byTitle(v1, "A1");
    const b = byTitle(v1, "B");

    const v2 = makePlan(db, SESSION, {
      tree: [
        { id: a.id, title: "A renamed", children: [{ id: a1.id, title: "A1" }, { title: "A2" }] },
        { id: b.id, title: "B" },
      ],
    });
    if (planConflicted(v2)) throw new Error("should edit");

    expect(v2.version).toBe(2);
    const view = readCurrentPlan(db, SESSION)!;
    expect(byTitle(view, "A renamed").id).toBe(a.id);
    expect(byTitle(view, "A1").id).toBe(a1.id);
    const a2 = byTitle(view, "A2");
    expect(a2.id).not.toBe(a1.id);
    expect(a2.status).toBe("not_started");

    // V1 is the old structure (old title, no A2); V2 is the new one.
    const history1 = readPlanVersion(db, OWNER, SESSION, 1)!;
    const history2 = readPlanVersion(db, OWNER, SESSION, 2)!;
    expect(JSON.stringify(history1.tree)).toContain("A");
    expect(JSON.stringify(history1.tree)).not.toContain("A2");
    expect(JSON.stringify(history2.tree)).toContain("A renamed");
    expect(JSON.stringify(history2.tree)).toContain("A2");
  });

  it("turns a dropped node into a tombstone: struck through now, absent from V2, present in V1", () => {
    const v1 = makePlan(db, SESSION, input(basicTree()));
    if (planConflicted(v1)) throw new Error("should create");
    const a = byTitle(v1, "A");
    const a1 = byTitle(v1, "A1");
    const b = byTitle(v1, "B");

    // B is dropped from the submitted tree.
    const v2 = makePlan(db, SESSION, {
      tree: [{ id: a.id, title: "A", children: [{ id: a1.id, title: "A1" }] }],
    });
    if (planConflicted(v2)) throw new Error("should edit");

    const view = readCurrentPlan(db, SESSION)!;
    const tombstone = byTitle(view, "B");
    expect(tombstone.status).toBe("deleted");
    expect(view.version).toBe(2);

    // The V2 snapshot carries only the alive tree; V1 still carries B.
    const history2 = readPlanVersion(db, OWNER, SESSION, 2)!;
    expect(JSON.stringify(history2.tree)).not.toContain(b.id);
    const history1 = readPlanVersion(db, OWNER, SESSION, 1)!;
    expect(JSON.stringify(history1.tree)).toContain(b.id);
  });

  it("refuses an unknown id and the reuse of a deleted node's id", () => {
    const v1 = makePlan(db, SESSION, input(basicTree()));
    if (planConflicted(v1)) throw new Error("should create");
    const a = byTitle(v1, "A");
    const a1 = byTitle(v1, "A1");
    const b = byTitle(v1, "B");

    expect(() =>
      makePlan(db, SESSION, {
        tree: [
          { id: a.id, title: "A", children: [{ id: a1.id, title: "A1" }] },
          { id: b.id, title: "B" },
          { id: "not-a-real-id", title: "X" },
        ],
      })
    ).toThrow(/not part of this plan/);

    // Delete B in V2 …
    makePlan(db, SESSION, {
      tree: [{ id: a.id, title: "A", children: [{ id: a1.id, title: "A1" }] }],
    });
    // … then attempt to reuse B's id in V3.
    expect(() =>
      makePlan(db, SESSION, {
        tree: [
          { id: a.id, title: "A", children: [{ id: a1.id, title: "A1" }] },
          { id: b.id, title: "B is back" },
        ],
      })
    ).toThrow(/deleted in an earlier version/);
  });
});

describe("forceMakePlan — the conflict's edit fork", () => {
  it("overwrites wholesale without ids: old nodes are tombstones, ids are fresh", () => {
    const v1 = makePlan(db, SESSION, input(basicTree()));
    if (planConflicted(v1)) throw new Error("should create");
    const oldIds = flatten(v1.tree).map((n) => n.id);

    const v2 = forceMakePlan(db, SESSION, { tree: [{ title: "Only this now" }] });
    const view = readCurrentPlan(db, SESSION)!;
    expect(view.version).toBe(2);
    const fresh = byTitle(view, "Only this now");
    expect(oldIds).not.toContain(fresh.id);
    // The old nodes remain as tombstones in the current view.
    for (const title of ["A", "A1", "B"]) {
      expect(byTitle(view, title).status).toBe("deleted");
    }
    // …and V2's snapshot contains nothing but the new tree.
    const history2 = readPlanVersion(db, OWNER, SESSION, 2)!;
    expect(history2.tree).toHaveLength(1);
  });
});

describe("applyProgress", () => {
  function seeded(): PlanView {
    const v1 = makePlan(db, SESSION, input(basicTree()));
    if (planConflicted(v1)) throw new Error("should create");
    return readCurrentPlan(db, SESSION)!;
  }

  it("moves the plan to in_progress when a node starts", () => {
    const view = seeded();
    const a1 = byTitle(view, "A1");
    const updated = applyProgress(db, SESSION, { nodes: [{ id: a1.id, status: "in_progress" }] }, "call_1");
    expect(updated.status).toBe("in_progress");
    expect(byTitle(updated, "A1").status).toBe("in_progress");
  });

  it("anchors the node's start: the in_progress call placed before the teaching content", () => {
    const view = seeded();
    const a1 = byTitle(view, "A1");
    const started = applyProgress(db, SESSION, { nodes: [{ id: a1.id, status: "in_progress" }] }, "call_start");
    expect(byTitle(started, "A1").anchorToolCallId).toBe("call_start");

    // Completing keeps the start anchor, so a click lands at where the node began — not its end.
    const done = applyProgress(db, SESSION, { nodes: [{ id: a1.id, status: "completed" }] }, "call_done");
    expect(byTitle(done, "A1").anchorToolCallId).toBe("call_start");

    // A repeat start cannot move it to a later turn.
    const again = applyProgress(db, SESSION, { nodes: [{ id: a1.id, status: "in_progress" }] }, "call_later");
    expect(byTitle(again, "A1").anchorToolCallId).toBe("call_start");
  });

  it("falls back to the completing call when a node was finished without a start call", () => {
    const view = seeded();
    const a1 = byTitle(view, "A1");
    const done = applyProgress(db, SESSION, { nodes: [{ id: a1.id, status: "completed" }] }, "call_done");
    expect(byTitle(done, "A1").anchorToolCallId).toBe("call_done");
  });

  it("keeps the start anchor when a started node is skipped, so it differs from one never begun", () => {
    const view = seeded();
    const a1 = byTitle(view, "A1");
    applyProgress(db, SESSION, { nodes: [{ id: a1.id, status: "in_progress" }] }, "call_start");
    const skipped = applyProgress(db, SESSION, { nodes: [{ id: a1.id, status: "skipped" }] }, "call_2");
    const skippedNode = byTitle(skipped, "A1");
    expect(skippedNode.anchorToolCallId).toBe("call_start");
    // A never-started node skipped the same way carries no anchor.
    const b = byTitle(view, "B");
    const skipped2 = applyProgress(db, SESSION, { nodes: [{ id: b.id, status: "skipped" }] }, "call_3");
    expect(byTitle(skipped2, "B").anchorToolCallId).toBeUndefined();
  });

  it("clears every marker when a node is explicitly reset to not-started", () => {
    const view = seeded();
    const a1 = byTitle(view, "A1");
    applyProgress(db, SESSION, { nodes: [{ id: a1.id, status: "in_progress" }] }, "call_start");
    const reset = applyProgress(db, SESSION, { nodes: [{ id: a1.id, status: "not_started" }] }, "call_2");
    expect(byTitle(reset, "A1").anchorToolCallId).toBeUndefined();
  });

  it("completes the plan when every live node is completed", () => {
    const view = seeded();
    const ids = flatten(view.tree).map((n) => n.id);
    const updated = applyProgress(
      db,
      SESSION,
      { nodes: ids.map((id) => ({ id, status: "completed" as const })) },
      "call_9"
    );
    expect(updated.status).toBe("completed");
  });

  it("rolls a completed leaf up through every ancestor and completes the plan", () => {
    const v1 = makePlan(
      db,
      SESSION,
      input([
        {
          title: "C",
          children: [
            { title: "C1", children: [{ title: "C1a" }, { title: "C1b" }] },
            { title: "C2" },
          ],
        },
        { title: "D" },
      ])
    );
    if (planConflicted(v1)) throw new Error("should create");
    const view = readCurrentPlan(db, SESSION)!;
    const leaves = ["C1a", "C1b", "C2", "D"].map((t) => byTitle(view, t).id);

    const updated = applyProgress(
      db,
      SESSION,
      { nodes: leaves.map((id) => ({ id, status: "completed" as const })) },
      "call_leaves"
    );

    // No container was named: C1 completed from its children, and C1's completion completed C.
    expect(byTitle(updated, "C1").status).toBe("completed");
    expect(byTitle(updated, "C").status).toBe("completed");
    expect(updated.status).toBe("completed");
    // Both rolled-up containers borrow their first jumpable child's marker — C1a's call here.
    expect(byTitle(updated, "C1").anchorToolCallId).toBe("call_leaves");
    expect(byTitle(updated, "C").anchorToolCallId).toBe("call_leaves");
  });

  it("borrows the first jumpable child's anchor in document order, not the last completion", () => {
    const v1 = makePlan(
      db,
      SESSION,
      input([{ title: "A", children: [{ title: "A1" }, { title: "A2" }, { title: "A3" }] }, { title: "B" }])
    );
    if (planConflicted(v1)) throw new Error("should create");
    const view = readCurrentPlan(db, SESSION)!;
    const planId = db.getPlanBySession(SESSION)!.id;
    // Straight to the rows, the way the pre-rollup writer left them. A1 finishes last in
    // wall-clock order; document order is what picks the chapter's marker.
    db.updatePlanNodeProgress(planId, byTitle(view, "A1").id, "completed", "call_a1", "2026-01-03T00:00:00.000Z");
    db.updatePlanNodeProgress(planId, byTitle(view, "A2").id, "completed", "call_a2", "2026-01-01T00:00:00.000Z");
    db.updatePlanNodeProgress(planId, byTitle(view, "A3").id, "completed", "call_a3", "2026-01-02T00:00:00.000Z");

    const reread = readCurrentPlan(db, SESSION)!;
    expect(byTitle(reread, "A").status).toBe("completed");
    expect(byTitle(reread, "A").anchorToolCallId).toBe("call_a1");
  });

  it("borrows through a derived container: a rolled-up ancestor reaches the deepest first child", () => {
    const v1 = makePlan(
      db,
      SESSION,
      input([{ title: "C", children: [{ title: "C1", children: [{ title: "C1a" }, { title: "C1b" }] }] }])
    );
    if (planConflicted(v1)) throw new Error("should create");
    const view = readCurrentPlan(db, SESSION)!;
    const planId = db.getPlanBySession(SESSION)!.id;
    // C1a is a start-then-complete so its stored anchor is the start call, not the completion.
    db.updatePlanNodeProgress(planId, byTitle(view, "C1a").id, "in_progress", "call_start", "2026-01-01T00:00:00.000Z");
    db.updatePlanNodeProgress(planId, byTitle(view, "C1a").id, "completed", "call_start", "2026-01-01T00:00:00.000Z");
    db.updatePlanNodeProgress(planId, byTitle(view, "C1b").id, "completed", "call_second", "2026-01-02T00:00:00.000Z");

    const reread = readCurrentPlan(db, SESSION)!;
    expect(byTitle(reread, "C1").status).toBe("completed");
    expect(byTitle(reread, "C1").anchorToolCallId).toBe("call_start");
    expect(byTitle(reread, "C").status).toBe("completed");
    expect(byTitle(reread, "C").anchorToolCallId).toBe("call_start");
  });

  it("persists the borrowed anchor, not the call that happened to trigger the scan", () => {
    const v1 = makePlan(
      db,
      SESSION,
      input([{ title: "A", children: [{ title: "A1" }, { title: "A2" }] }, { title: "B" }])
    );
    if (planConflicted(v1)) throw new Error("should create");
    const view = readCurrentPlan(db, SESSION)!;
    const a = byTitle(view, "A");
    const b = byTitle(view, "B");
    const planId = db.getPlanBySession(SESSION)!.id;
    // Rows from before the rollup existed: children completed, no marker on the chapter.
    db.updatePlanNodeProgress(planId, byTitle(view, "A1").id, "completed", "call_a1", "2026-01-01T00:00:00.000Z");
    db.updatePlanNodeProgress(planId, byTitle(view, "A2").id, "completed", "call_a2", "2026-01-02T00:00:00.000Z");

    // An unrelated progress write drives the full-plan rescan.
    const updated = applyProgress(db, SESSION, { nodes: [{ id: b.id, status: "in_progress" }] }, "call_trigger");

    expect(byTitle(updated, "A").status).toBe("completed");
    expect(byTitle(updated, "A").anchorToolCallId).toBe("call_a1");
    const stored = db.listPlanNodes(planId).find((r) => r.id === a.id)!;
    expect(stored.status).toBe("completed");
    expect(stored.anchorToolCallId).toBe("call_a1");
  });

  it("keeps a container's start anchor when it rolls up, and reopens it when a child reopens", () => {
    const view = seeded();
    const a = byTitle(view, "A");
    const a1 = byTitle(view, "A1");

    const started = applyProgress(db, SESSION, { nodes: [{ id: a.id, status: "in_progress" }] }, "call_start");
    expect(byTitle(started, "A").anchorToolCallId).toBe("call_start");

    const done = applyProgress(db, SESSION, { nodes: [{ id: a1.id, status: "completed" }] }, "call_done");
    expect(byTitle(done, "A").status).toBe("completed");
    expect(byTitle(done, "A").anchorToolCallId).toBe("call_start");

    const reopened = applyProgress(db, SESSION, { nodes: [{ id: a1.id, status: "in_progress" }] }, "call_again");
    expect(byTitle(reopened, "A").status).toBe("in_progress");
  });

  it("does not roll up while a skipped child is unfinished", () => {
    const v1 = makePlan(
      db,
      SESSION,
      input([{ title: "A", children: [{ title: "A1" }, { title: "A2" }] }, { title: "B" }])
    );
    if (planConflicted(v1)) throw new Error("should create");
    const view = readCurrentPlan(db, SESSION)!;
    const a1 = byTitle(view, "A1");
    const a2 = byTitle(view, "A2");

    const partial = applyProgress(
      db,
      SESSION,
      { nodes: [{ id: a1.id, status: "completed" }, { id: a2.id, status: "skipped" }] },
      "call_1"
    );
    expect(byTitle(partial, "A").status).not.toBe("completed");
  });

  it("an edit completes a container whose last unfinished child was dropped, and reopens one given a new child", () => {
    const v1 = makePlan(
      db,
      SESSION,
      input([{ title: "A", children: [{ title: "A1" }, { title: "A2" }] }, { title: "B" }])
    );
    if (planConflicted(v1)) throw new Error("should create");
    const view = readCurrentPlan(db, SESSION)!;
    const a = byTitle(view, "A");
    const a1 = byTitle(view, "A1");
    const b = byTitle(view, "B");
    applyProgress(db, SESSION, { nodes: [{ id: a1.id, status: "completed" }] }, "call_1");
    expect(byTitle(readCurrentPlan(db, SESSION)!, "A").status).not.toBe("completed");

    // Dropping the unfinished A2 leaves only a completed child: the edit completes A.
    const v2 = makePlan(db, SESSION, {
      tree: [
        { id: a.id, title: "A", children: [{ id: a1.id, title: "A1" }] },
        { id: b.id, title: "B" },
      ],
    });
    if (planConflicted(v2)) throw new Error("should edit");
    expect(byTitle(readCurrentPlan(db, SESSION)!, "A").status).toBe("completed");

    // A fresh not-started child reopens it.
    const v3 = makePlan(db, SESSION, {
      tree: [
        { id: a.id, title: "A", children: [{ id: a1.id, title: "A1" }, { title: "A3" }] },
        { id: b.id, title: "B" },
      ],
    });
    if (planConflicted(v3)) throw new Error("should edit");
    expect(byTitle(readCurrentPlan(db, SESSION)!, "A").status).toBe("in_progress");
  });

  it("derives container completion on read, so rows written before the rollup existed still render", () => {
    const view = seeded();
    const a = byTitle(view, "A");
    const a1 = byTitle(view, "A1");
    // Straight to the row, the way the pre-rollup writer left it: A's only child completed
    // while A itself still says not_started.
    db.updatePlanNodeProgress(
      db.getPlanBySession(SESSION)!.id,
      a1.id,
      "completed",
      "call_old",
      "2026-01-01T00:00:00.000Z"
    );

    const reread = readCurrentPlan(db, SESSION)!;
    expect(byTitle(reread, "A").status).toBe("completed");
    // …and it borrows A1's marker so the checked chapter is still a locate target.
    expect(byTitle(reread, "A").anchorToolCallId).toBe("call_old");
    // The derivation is display-only; the stored row is untouched.
    const stored = db.listPlanNodes(db.getPlanBySession(SESSION)!.id).find((r) => r.id === a.id)!;
    expect(stored.status).toBe("not_started");
    expect(stored.anchorToolCallId).toBeNull();
  });

  it("reads a container in_progress while a child is underway, borrowing that child's anchor", () => {
    const view = seeded();
    const a = byTitle(view, "A");
    const a1 = byTitle(view, "A1");
    // Straight to the row: a topic started, its chapter never named.
    db.updatePlanNodeProgress(
      db.getPlanBySession(SESSION)!.id,
      a1.id,
      "in_progress",
      "call_start",
      "2026-01-01T00:00:00.000Z"
    );

    const reread = readCurrentPlan(db, SESSION)!;
    expect(byTitle(reread, "A").status).toBe("in_progress");
    expect(byTitle(reread, "A").anchorToolCallId).toBe("call_start");
    // Display-only, as with a rolled-up completion.
    const stored = db.listPlanNodes(db.getPlanBySession(SESSION)!.id).find((r) => r.id === a.id)!;
    expect(stored.status).toBe("not_started");
  });

  it("persists a container promoted to in_progress by a started child, anchor and all", () => {
    const v1 = makePlan(
      db,
      SESSION,
      input([{ title: "A", children: [{ title: "A1" }, { title: "A2" }] }, { title: "B" }])
    );
    if (planConflicted(v1)) throw new Error("should create");
    const view = readCurrentPlan(db, SESSION)!;
    const a = byTitle(view, "A");
    const b = byTitle(view, "B");
    const planId = db.getPlanBySession(SESSION)!.id;
    db.updatePlanNodeProgress(planId, byTitle(view, "A1").id, "in_progress", "call_child", "2026-01-01T00:00:00.000Z");

    // An unrelated write drives the full-plan rescan and persists the derived status/anchor.
    const updated = applyProgress(db, SESSION, { nodes: [{ id: b.id, status: "in_progress" }] }, "call_trigger");
    expect(byTitle(updated, "A").status).toBe("in_progress");
    expect(byTitle(updated, "A").anchorToolCallId).toBe("call_child");
    const stored = db.listPlanNodes(planId).find((r) => r.id === a.id)!;
    expect(stored.status).toBe("in_progress");
    expect(stored.anchorToolCallId).toBe("call_child");
  });

  it("does not drag a container into in_progress from skipped children alone", () => {
    const v1 = makePlan(
      db,
      SESSION,
      input([{ title: "A", children: [{ title: "A1" }, { title: "A2" }] }])
    );
    if (planConflicted(v1)) throw new Error("should create");
    const view = readCurrentPlan(db, SESSION)!;
    const a1 = byTitle(view, "A1");
    const a2 = byTitle(view, "A2");

    const skipped = applyProgress(
      db,
      SESSION,
      { nodes: [{ id: a1.id, status: "skipped" }, { id: a2.id, status: "skipped" }] },
      "call_skip"
    );
    // A passed-over chapter stays playable; only a started/finished child makes it underway.
    expect(byTitle(skipped, "A").status).toBe("not_started");
  });

  it("treats skipped as underway, not completed", () => {
    const view = seeded();
    const b = byTitle(view, "B");
    const updated = applyProgress(db, SESSION, { nodes: [{ id: b.id, status: "skipped" }] }, "call_1");
    expect(updated.status).toBe("in_progress");
    expect(byTitle(updated, "B").status).toBe("skipped");
  });

  it("accepts an explicit plan status in a batch", () => {
    seeded();
    const updated = applyProgress(db, SESSION, { planStatus: "completed" }, "call_1");
    expect(updated.status).toBe("completed");
  });

  it("refuses progress on a missing plan, an unknown node, a tombstone, and the deleted status", () => {
    db.createSession({
      id: "s-empty",
      workspaceId: "w1",
      copilotId: null,
      copilotName: "",
      systemPrompt: "",
      allTools: true,
      tools: [],
      title: DEFAULT_SESSION_TITLE,
    });
    expect(() => applyProgress(db, "s-empty", { planStatus: "in_progress" }, "c")).toThrow(/no plan/);

    const view = seeded();
    expect(() => applyProgress(db, SESSION, { nodes: [{ id: "nope", status: "completed" }] }, "c")).toThrow(
      /not part of this plan/
    );

    const a = byTitle(view, "A");
    const a1 = byTitle(view, "A1");
    // Delete B.
    const edited = makePlan(db, SESSION, {
      tree: [{ id: a.id, title: "A", children: [{ id: a1.id, title: "A1" }] }],
    });
    if (planConflicted(edited)) throw new Error("should edit");
    const bId = byTitle(view, "B").id;
    expect(() => applyProgress(db, SESSION, { nodes: [{ id: bId, status: "completed" }] }, "c")).toThrow(
      /was deleted/
    );
    // `deleted` is reached only by editing the plan, never by a progress update.
    expect(() => applyProgress(db, SESSION, { nodes: [{ id: a1.id, status: "deleted" }] }, "c")).toThrow(
      /editing the plan/
    );
  });
});

describe("history ownership", () => {
  it("hides another account's plan versions", () => {
    makePlan(db, SESSION, input(basicTree()));
    db.createWorkspace({ userId: OTHER, id: "w2", name: "W2", slug: "w2", dirPath: join(root, "w2") });
    expect(readPlanVersion(db, OTHER, SESSION, 1)).toBeUndefined();
    expect(db.getPlanForSessionForUser(OTHER, SESSION)).toBeUndefined();
  });

  it("answers undefined for a version that never existed", () => {
    makePlan(db, SESSION, input(basicTree()));
    expect(readPlanVersion(db, OWNER, SESSION, 7)).toBeUndefined();
  });
});

describe("jumpToNode", () => {
  function seeded(): PlanView {
    const v1 = makePlan(db, SESSION, input(basicTree()));
    if (planConflicted(v1)) throw new Error("should create");
    return readCurrentPlan(db, SESSION)!;
  }

  it("keeps the start anchor of an in-progress node it skips, and records the message position", () => {
    const view = seeded();
    applyProgress(db, SESSION, { nodes: [{ id: byTitle(view, "A").id, status: "in_progress" }] }, "call_a");
    // The abandoned position: a user message, then the assistant message carrying the anchor.
    db.createMessage({ id: "m1", sessionId: SESSION, role: "user", content: "开始学 A" });
    db.createMessage({
      id: "m2",
      sessionId: SESSION,
      role: "assistant",
      content: "好的",
      toolCalls: [{ id: "call_a", name: "ila_update_plan_progress", input: "{}" }],
    });

    const result = jumpToNode(db, SESSION, byTitle(readCurrentPlan(db, SESSION)!, "B").id);

    expect(result.started).toBe(false);
    expect(result.startMessageId).toBeNull();
    expect(result.skippedMessageId).toBeNull();
    expect(result.skippedCount).toBe(2); // A and A1

    const after = flatten(result.view.tree);
    const skippedA = after.find((n) => n.title === "A")!;
    expect(skippedA.status).toBe("skipped");
    expect(skippedA.anchorToolCallId).toBe("call_a"); // half-studied marker kept
    expect(skippedA.skippedMessageId).toBe("m2"); // abandoned position
    expect(skippedA.skippedAt).toBeTruthy();
    const skippedA1 = after.find((n) => n.title === "A1")!;
    expect(skippedA1.status).toBe("skipped");
    expect(skippedA1.anchorToolCallId).toBeUndefined(); // never started
    expect(skippedA1.skippedMessageId).toBe("m2");
    expect(after.find((n) => n.title === "B")!.status).toBe("in_progress");
  });

  it("reports a started target on revisit and keeps its anchor while clearing skip facts", () => {
    const view = seeded();
    applyProgress(db, SESSION, { nodes: [{ id: byTitle(view, "A").id, status: "in_progress" }] }, "call_a");
    db.createMessage({ id: "m1", sessionId: SESSION, role: "user", content: "学 A" });
    db.createMessage({
      id: "m2",
      sessionId: SESSION,
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_a", name: "ila_update_plan_progress", input: "{}" }],
    });
    jumpToNode(db, SESSION, byTitle(readCurrentPlan(db, SESSION)!, "B").id);
    // The post-turn resolution the route runs: anchor call_a sits in m2.
    expect(resolvePlanStartMessages(db, OWNER, SESSION).starts).toBe(1);

    const back = jumpToNode(db, SESSION, byTitle(readCurrentPlan(db, SESSION)!, "A").id);
    expect(back.started).toBe(true);
    expect(back.startMessageId).toBe("m2");
    expect(back.skippedMessageId).toBe("m2");

    const reopened = byTitle(back.view, "A");
    expect(reopened.status).toBe("in_progress");
    expect(reopened.anchorToolCallId).toBe("call_a");
    expect(reopened.skippedAt).toBeUndefined();
    expect(reopened.skippedMessageId).toBeUndefined();
  });

  it("records a null message position when the session has no messages yet", () => {
    seeded();
    const result = jumpToNode(db, SESSION, byTitle(readCurrentPlan(db, SESSION)!, "B").id);
    expect(result.skippedCount).toBe(2);
    expect(byTitle(result.view, "A").skippedMessageId ?? null).toBeNull();
  });

  it("refuses a completed node and an unknown node", () => {
    const view = seeded();
    expect(() => jumpToNode(db, SESSION, "nope")).toThrow(/not a live node/);
    const done = applyProgress(
      db,
      SESSION,
      { nodes: [{ id: byTitle(view, "A1").id, status: "completed" }] },
      "call_1"
    );
    expect(() => jumpToNode(db, SESSION, byTitle(done, "A1").id)).toThrow(/already completed/);
  });
});

describe("resolvePlanStartMessages", () => {
  it("resolves an anchor to its message, idempotently", () => {
    const v1 = makePlan(db, SESSION, input(basicTree()));
    if (planConflicted(v1)) throw new Error("should create");
    applyProgress(db, SESSION, { nodes: [{ id: byTitle(v1, "A").id, status: "in_progress" }] }, "call_a");
    db.createMessage({ id: "m1", sessionId: SESSION, role: "user", content: "学 A" });
    db.createMessage({
      id: "m2",
      sessionId: SESSION,
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_a", name: "ila_update_plan_progress", input: "{}" }],
    });

    expect(resolvePlanStartMessages(db, OWNER, SESSION)).toEqual({ starts: 1, skips: 0 });
    expect(byTitle(readCurrentPlan(db, SESSION)!, "A").startMessageId).toBe("m2");
    expect(resolvePlanStartMessages(db, OWNER, SESSION)).toEqual({ starts: 0, skips: 0 });
  });

  it("resolves a turn's progress-tool skip to that turn's message, bounded by sinceIso", () => {
    const v1 = makePlan(db, SESSION, input(basicTree()));
    if (planConflicted(v1)) throw new Error("should create");
    const planId = db.getPlanBySession(SESSION)!.id;
    const a = byTitle(v1, "A");
    const b = byTitle(v1, "B");
    // An old skip on B, before the turn being finished.
    db.skipPlanNode(planId, b.id, "2020-01-01T00:00:00.000Z", null);

    const sinceIso = new Date().toISOString();
    applyProgress(db, SESSION, { nodes: [{ id: a.id, status: "skipped" }] }, "call_x");
    db.createMessage({ id: "m3", sessionId: SESSION, role: "assistant", content: "跳过 A" });

    const result = resolvePlanStartMessages(db, OWNER, SESSION, {
      assistantMessageId: "m3",
      sinceIso,
    });
    expect(result).toEqual({ starts: 0, skips: 1 });
    const reread = readCurrentPlan(db, SESSION)!;
    expect(byTitle(reread, "A").skippedMessageId).toBe("m3");
    // The old skip on B is untouched.
    expect(byTitle(reread, "B").skippedMessageId ?? null).toBeNull();
  });

  it("answers zero counts when the session has no plan", () => {
    expect(resolvePlanStartMessages(db, OWNER, SESSION)).toEqual({ starts: 0, skips: 0 });
  });
});

describe("renderChapterJumpGuidance", () => {
  const claim = (started: boolean) => ({
    nodeId: "n1",
    number: "1.1",
    title: "T",
    started,
    startMessageId: "m1",
    skippedMessageId: "m2",
  });

  it("names the range recovery in smart/started mode", () => {
    const text = renderChapterJumpGuidance(claim(true), true);
    expect(text).toContain("had already started");
    expect(text).toContain('mode: "range"');
    expect(text).toContain("m1");
    expect(text).toContain("m2");
  });

  it("says there is no earlier stretch in smart/fresh mode", () => {
    const text = renderChapterJumpGuidance(claim(false), true);
    expect(text).toContain("had not actually begun");
    expect(text).not.toContain("m1");
  });

  it("offers the range read in default/started mode", () => {
    const text = renderChapterJumpGuidance(claim(true), false);
    expect(text).toContain("had already started");
    expect(text).toContain('mode: "range"');
  });

  it("states the chapter had not begun in default/fresh mode", () => {
    expect(renderChapterJumpGuidance(claim(false), false)).toContain("had not begun");
  });
});
