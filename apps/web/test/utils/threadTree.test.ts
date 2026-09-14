import { describe, expect, it } from "vitest";
import type { PlanTreeNode, ThreadMessageView, ThreadView } from "@ilearnassist/shared";
import {
  buildThreadTree,
  flattenThreadTree,
  OTHER_ROOT,
  PLAN_ROOT,
} from "../../src/utils/threadTree";

let seq = 0;
function msg(overrides: Partial<ThreadMessageView> = {}): ThreadMessageView {
  seq += 1;
  return {
    id: `m${seq}`,
    role: "user",
    preview: `消息 ${seq}`,
    content: `消息 ${seq}`,
    createdAt: `2026-01-0${Math.min(seq, 9)}T00:00:00.000Z`,
    ...overrides,
  };
}

function thread(overrides: Partial<ThreadView>): ThreadView {
  return {
    id: `t${Math.random().toString(36).slice(2, 7)}`,
    branch: "other",
    title: "话题",
    messages: [msg()],
    ...overrides,
  };
}

function node(overrides: Partial<PlanTreeNode> & { id: string; title: string }): PlanTreeNode {
  return {
    status: "not_started",
    ...overrides,
  };
}

describe("buildThreadTree", () => {
  it("nests plan threads by the live plan hierarchy, keeping container chapters", () => {
    const tree: PlanTreeNode[] = [
      node({
        id: "c1",
        title: "第一章",
        children: [node({ id: "c1-1", title: "可数集" })],
      }),
    ];
    const leafThread = thread({ branch: "plan", planNodeId: "c1-1", title: "可数集" });

    const built = buildThreadTree([leafThread], tree);
    // Chapter 1 survives as a container even though it has no thread of its own.
    expect(built.plan).toHaveLength(1);
    expect(built.plan[0]).toMatchObject({ id: "c1", number: "1" });
    expect(built.plan[0]!.children[0]).toMatchObject({ id: "c1-1", number: "1.1" });
    expect(built.plan[0]!.children[0]!.thread?.id).toBe(leafThread.id);
  });

  it("keeps a thread whose plan node was deleted, as a missing folder", () => {
    const orphan = thread({ branch: "plan", planNodeId: "gone", title: "旧章节" });
    const built = buildThreadTree([orphan], []);
    expect(built.plan[0]).toMatchObject({ id: "missing:gone", missing: true, title: "旧章节" });
  });

  it("lists other threads flat, in the order given", () => {
    const a = thread({ title: "a" });
    const b = thread({ title: "b" });
    const built = buildThreadTree([a, b], null);
    expect(built.other.map((t) => t.id)).toEqual([a.id, b.id]);
    expect(built.plan).toEqual([]);
  });
});

describe("flattenThreadTree", () => {
  it("renders only non-empty branches, plan first", () => {
    const built = buildThreadTree([thread({ title: "背景" })], null);
    const rows = flattenThreadTree(built);
    expect(rows[0]).toMatchObject({ kind: "branch", id: OTHER_ROOT });
    expect(rows.some((r) => r.kind === "branch" && r.id === PLAN_ROOT)).toBe(false);
  });

  it("puts message leaves under their node and reports branch counts", () => {
    const tree: PlanTreeNode[] = [node({ id: "c1", title: "第一章", children: [node({ id: "c1-1", title: "1.1" })] })];
    const leaf = thread({
      branch: "plan",
      planNodeId: "c1-1",
      messages: [msg({ id: "first" }), msg({ role: "assistant", id: "second" })],
    });
    const background = thread({ messages: [msg({ id: "bg" })] });

    const rows = flattenThreadTree(buildThreadTree([leaf, background], tree));

    const branch = rows.find((r) => r.kind === "branch" && r.id === PLAN_ROOT)!;
    expect(branch).toMatchObject({ kind: "branch", messageCount: 2 });
    // node 1 (container) → node 1.1 → two leaves
    const c1 = rows.find((r) => r.kind === "node" && r.id === "c1")!;
    const c11 = rows.find((r) => r.kind === "node" && r.id === "c1-1")!;
    expect(c1).toMatchObject({ kind: "node", messageCount: 2 });
    expect("firstMessageId" in c1).toBe(false);
    expect(c11).toMatchObject({ kind: "node", firstMessageId: "first", messageCount: 2 });
    const leafIds = rows.filter((r) => r.kind === "message").map((r) => r.id);
    expect(leafIds).toEqual(["first", "second", "bg"]);
  });

  it("hides a collapsed node's descendants but not the node itself", () => {
    const tree: PlanTreeNode[] = [node({ id: "c1", title: "一" })];
    const leaf = thread({ branch: "plan", planNodeId: "c1" });
    const rows = flattenThreadTree(buildThreadTree([leaf], tree), new Set(["c1"]));
    expect(rows.some((r) => r.kind === "message")).toBe(false);
    expect(rows.some((r) => r.kind === "node" && r.id === "c1")).toBe(true);
  });
});
