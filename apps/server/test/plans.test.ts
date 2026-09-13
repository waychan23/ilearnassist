import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlanNodeInput, PlanTreeNode, PlanView } from "@ilearnassist/shared";
import { createDb, DEFAULT_SESSION_TITLE, type AppDb } from "../src/db.js";
import {
  applyProgress,
  forceMakePlan,
  makePlan,
  planConflicted,
  planTreeInputSchema,
  readCurrentPlan,
  readPlanVersion,
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

  it("records the completing tool call as the jump anchor, first one wins", () => {
    const view = seeded();
    const a1 = byTitle(view, "A1");
    const first = applyProgress(db, SESSION, { nodes: [{ id: a1.id, status: "completed" }] }, "call_1");
    expect(byTitle(first, "A1").doneToolCallId).toBe("call_1");

    const second = applyProgress(db, SESSION, { nodes: [{ id: a1.id, status: "completed" }] }, "call_2");
    expect(byTitle(second, "A1").doneToolCallId).toBe("call_1");
  });

  it("clears the anchor when the node leaves completed", () => {
    const view = seeded();
    const a1 = byTitle(view, "A1");
    applyProgress(db, SESSION, { nodes: [{ id: a1.id, status: "completed" }] }, "call_1");
    const updated = applyProgress(
      db,
      SESSION,
      { nodes: [{ id: a1.id, status: "in_progress" }] },
      "call_2"
    );
    expect(byTitle(updated, "A1").doneToolCallId).toBeUndefined();
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
