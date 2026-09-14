import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, afterEach } from "vitest";
import {
  PLAN_PROGRESS_TOOL_NAME,
  type Message,
  type ToolCall,
} from "@ilearnassist/shared";
import { createDb, DEFAULT_SESSION_TITLE, newId, type AppDb } from "../src/db.js";
import { forceMakePlan, readCurrentPlan } from "../src/plans.js";
import {
  buildThreadPrompt,
  buildThreadViews,
  parseThreadDecisions,
  progressNodeForTurn,
  segmentTurns,
  syncThreads,
  type ThreadTurn,
} from "../src/threads.js";
import { planNodeNumbers } from "@ilearnassist/shared";
import { configureThreadLog } from "../src/threadLog.js";

let root: string;
let db: AppDb;
const OWNER = "u1";
const SESSION = "s1";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gl-threads-"));
  db = createDb(join(root, "test.sqlite"));
  db.createUser({ id: OWNER, username: "tester", slug: "tester" });
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
  configureThreadLog(null);
  try {
    db.raw.close();
  } catch {
    /* already closed */
  }
  rmSync(root, { recursive: true, force: true });
});

function userMessage(content: string): Message {
  return db.createMessage({ id: newId(), sessionId: SESSION, role: "user", content });
}
function assistantMessage(content: string, toolCalls?: ToolCall[]): Message {
  return db.createMessage({
    id: newId(),
    sessionId: SESSION,
    role: "assistant",
    content,
    ...(toolCalls ? { toolCalls } : {}),
  });
}

describe("segmentTurns", () => {
  it("groups a user message with every assistant reply up to the next user", () => {
    const turns = segmentTurns([
      { role: "user" },
      { role: "assistant" },
      { role: "assistant" },
      { role: "user" },
      { role: "assistant" },
    ] as Message[]);
    expect(turns.map((t) => t.messages.length)).toEqual([3, 2]);
  });

  it("treats an assistant-first run as its own turn (the regenerate case)", () => {
    const turns = segmentTurns([{ role: "assistant" }] as Message[]);
    expect(turns).toHaveLength(1);
  });
});

describe("parseThreadDecisions", () => {
  it("parses the three arms", () => {
    const raw =
      'Here you go:\n```json\n{"decisions":[{"thread":"continue"},' +
      '{"thread":"new","branch":"plan","node":"1.1","title":"可数集"},' +
      '{"thread":"e2"}]}\n```';
    const decisions = parseThreadDecisions(raw, 3);
    expect(decisions).toEqual([
      { kind: "continue" },
      { kind: "new", branch: "plan", node: "1.1", title: "可数集" },
      { kind: "existing", ref: "e2" },
    ]);
  });

  it("defaults a malformed branch to other", () => {
    const decisions = parseThreadDecisions('{"decisions":[{"thread":"new","title":"x"}]}', 1);
    expect(decisions?.[0]).toMatchObject({ kind: "new", branch: "other" });
  });

  it("rejects a count that does not match the turns", () => {
    expect(parseThreadDecisions('{"decisions":[{"thread":"continue"}]}', 2)).toBeNull();
  });

  it("rejects garbage and unknown arms", () => {
    expect(parseThreadDecisions("no json here", 1)).toBeNull();
    expect(parseThreadDecisions('{"decisions":[{"thread":"wat"}]}', 1)).toBeNull();
  });
});

describe("progressNodeForTurn", () => {
  function call(input: unknown): ToolCall {
    return { id: newId(), name: PLAN_PROGRESS_TOOL_NAME, input: JSON.stringify(input) };
  }

  it("prefers the node put in_progress", () => {
    const turn: ThreadTurn = {
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [
            call({ nodes: [{ id: "a", status: "completed" }, { id: "b", status: "in_progress" }] }),
          ],
        } as Message,
      ],
    };
    const nodes = new Map([
      ["a", {}],
      ["b", {}],
    ]);
    expect(progressNodeForTurn(turn, nodes)).toBe("b");
  });

  it("falls back to a completed node, and ignores ids the plan does not know", () => {
    const turn: ThreadTurn = {
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [call({ nodes: [{ id: "ghost", status: "in_progress" }, { id: "a", status: "completed" }] })],
        } as Message,
      ],
    };
    expect(progressNodeForTurn(turn, new Map([["a", {}]]))).toBe("a");
  });
});

describe("buildThreadPrompt", () => {
  it("shows the plan outline, existing threads and the new turns", () => {
    const prompt = buildThreadPrompt({
      plan: undefined,
      existing: [{ id: "t1", sessionId: SESSION, branch: "other", title: "考试安排", planNodeId: null, createdAt: "", updatedAt: "" }],
      recent: [{ role: "user", content: "上一条" }],
      currentThreadRef: "e1",
      turns: [
        {
          messages: [
            { role: "user", content: "什么是可数集？" },
            { role: "assistant", content: "可数集是…", toolCalls: [] },
          ] as Message[],
        },
      ],
    });
    expect(prompt).toContain("no plan yet");
    expect(prompt).toContain("[other] 考试安排");
    expect(prompt).toContain('"continue" means thread e1');
    expect(prompt).toContain("<recently_classified>");
    expect(prompt).toContain("什么是可数集？");
    expect(prompt).toContain("<new_turns>");
  });
});

describe("syncThreads", () => {
  const newOther = (title: string) =>
    JSON.stringify({ decisions: [{ thread: "new", branch: "other", title }] });

  it("is a no-op (no classifier call) when nothing is unassigned", async () => {
    let called = 0;
    const result = await syncThreads(db, SESSION, async () => {
      called += 1;
      return "";
    });
    expect(called).toBe(0);
    expect(result).toEqual({ turns: 0, messages: 0, unassigned: 0 });
  });

  it("classifies turns into threads and assigns both messages of each", async () => {
    userMessage("先聊聊我的考试时间");
    assistantMessage("好的，什么时候？");
    userMessage("什么是可数集？");
    assistantMessage("可数集是能和自然数一一对应的集合。");

    await syncThreads(
      db,
      SESSION,
      async () =>
        JSON.stringify({
          decisions: [
            { thread: "new", branch: "other", title: "考试安排" },
            { thread: "new", branch: "other", title: "可数集" },
          ],
        })
    );

    const view = buildThreadViews(db, OWNER, SESSION);
    expect(view.unassigned).toBe(0);
    expect(view.threads).toHaveLength(2);
    expect(view.threads.map((t) => [t.branch, t.title, t.messages.length])).toEqual([
      ["other", "考试安排", 2],
      ["other", "可数集", 2],
    ]);
    // Previews are one line; the full text rides along for the tooltip.
    const leaf = view.threads[1]!.messages[0]!;
    expect(leaf.preview).toBe("什么是可数集？");
    expect(leaf.content).toBe("什么是可数集？");
  });

  it("appends a returning topic to its existing thread instead of duplicating", async () => {
    userMessage("考试在周五");
    assistantMessage("好的");
    await syncThreads(db, SESSION, async () => newOther("考试安排"));

    userMessage("考试改到周一了");
    assistantMessage("明白");
    await syncThreads(db, SESSION, async () =>
      JSON.stringify({ decisions: [{ thread: "e1" }] })
    );

    const view = buildThreadViews(db, OWNER, SESSION);
    expect(view.threads).toHaveLength(1);
    expect(view.threads[0]!.messages).toHaveLength(4);
  });

  it("forces a turn that moved the plan onto that node, whatever the model said", async () => {
    forceMakePlan(db, SESSION, {
      tree: [{ title: "第一章 集合", children: [{ title: "可数集" }] }],
    });
    const plan = readCurrentPlan(db, SESSION)!;
    const leafNode = plan.tree[0]!.children![0]!;
    const number = planNodeNumbers(plan.tree).get(leafNode.id)!;
    expect(number).toBe("1.1");

    userMessage("开始学 1.1");
    assistantMessage("", [
      {
        id: newId(),
        name: PLAN_PROGRESS_TOOL_NAME,
        input: JSON.stringify({ nodes: [{ id: leafNode.id, status: "in_progress" }] }),
      },
    ]);
    assistantMessage("我们先看定义…");

    // The model wrongly calls this background; the tool call wins.
    await syncThreads(db, SESSION, async () =>
      JSON.stringify({ decisions: [{ thread: "new", branch: "other", title: "闲聊" }] })
    );

    const view = buildThreadViews(db, OWNER, SESSION);
    expect(view.threads).toHaveLength(1);
    expect(view.threads[0]).toMatchObject({
      branch: "plan",
      planNodeId: leafNode.id,
      title: "可数集",
    });
    expect(view.threads[0]!.messages).toHaveLength(3);
  });

  it("keeps one thread per plan node across two syncs (idempotent)", async () => {
    forceMakePlan(db, SESSION, { tree: [{ title: "第一章" }] });
    const nodeId = readCurrentPlan(db, SESSION)!.tree[0]!.id;
    const progress = (): ToolCall[] => [
      {
        id: newId(),
        name: PLAN_PROGRESS_TOOL_NAME,
        input: JSON.stringify({ nodes: [{ id: nodeId, status: "in_progress" }] }),
      },
    ];

    userMessage("学第一章");
    assistantMessage("", progress());
    await syncThreads(db, SESSION, async () =>
      JSON.stringify({ decisions: [{ thread: "continue" }] })
    );

    userMessage("继续第一章");
    assistantMessage("接着说…", progress());
    await syncThreads(db, SESSION, async () =>
      JSON.stringify({ decisions: [{ thread: "continue" }] })
    );

    const view = buildThreadViews(db, OWNER, SESSION);
    expect(view.threads).toHaveLength(1);
    expect(view.threads[0]!.messages).toHaveLength(4);
  });

  it("leaves every message unassigned but does not throw when the answer is unusable", async () => {
    // A bad model answer blocks only the ambiguous turns: deterministic progress still lands,
    // the call resolves, and the next sync retries the same messages.
    userMessage("你好");
    assistantMessage("你好");
    let called = 0;
    const result = await syncThreads(db, SESSION, async () => {
      called += 1;
      return "garbage";
    });
    expect(called).toBe(1);
    expect(result.messages).toBe(0);
    expect(result.unassigned).toBe(2);
    expect(buildThreadViews(db, OWNER, SESSION).threads).toHaveLength(0);
  });

  it("never calls the model when every turn is deterministically placed", async () => {
    forceMakePlan(db, SESSION, { tree: [{ title: "第一章" }] });
    const nodeId = readCurrentPlan(db, SESSION)!.tree[0]!.id;
    userMessage("学第一章");
    assistantMessage("", [
      {
        id: newId(),
        name: PLAN_PROGRESS_TOOL_NAME,
        input: JSON.stringify({ nodes: [{ id: nodeId, status: "in_progress" }] }),
      },
    ]);

    let called = 0;
    const result = await syncThreads(db, SESSION, async () => {
      called += 1;
      return "{}";
    });

    expect(called).toBe(0);
    expect(result.messages).toBe(2);
    expect(result.unassigned).toBe(0);
    expect(buildThreadViews(db, OWNER, SESSION).threads[0]).toMatchObject({
      branch: "plan",
      planNodeId: nodeId,
    });
  });

  it("still applies deterministic turns when the model fails mid-backfill", async () => {
    forceMakePlan(db, SESSION, { tree: [{ title: "第一章" }] });
    const nodeId = readCurrentPlan(db, SESSION)!.tree[0]!.id;
    // A deterministic plan turn, followed by an ambiguous digression.
    userMessage("学第一章");
    assistantMessage("", [
      {
        id: newId(),
        name: PLAN_PROGRESS_TOOL_NAME,
        input: JSON.stringify({ nodes: [{ id: nodeId, status: "in_progress" }] }),
      },
    ]);
    userMessage("对了考试周几");
    assistantMessage("周一");

    const result = await syncThreads(db, SESSION, async () => {
      throw new Error("Request timed out.");
    });

    // The plan turn landed; the digression waits for the next sync.
    expect(result.messages).toBe(2);
    expect(result.unassigned).toBe(2);
    const view = buildThreadViews(db, OWNER, SESSION);
    expect(view.threads).toHaveLength(1);
    expect(view.threads[0]).toMatchObject({ branch: "plan", planNodeId: nodeId });
  });
});

describe("the observation log", () => {
  const logFile = () => join(root, "logs", "threads.log");

  it("appends a block describing the sync and stays silent when unconfigured", async () => {
    expect(existsSync(logFile())).toBe(false);
    userMessage("什么是可数集？");
    assistantMessage("可数集是…");

    await syncThreads(
      db,
      SESSION,
      async () =>
        JSON.stringify({ decisions: [{ thread: "new", branch: "other", title: "可数集" }] }),
      "sync"
    );
    // No file unless the process (here, the test) configured one.
    expect(existsSync(logFile())).toBe(false);

    configureThreadLog(logFile());
    userMessage("考试什么时候？");
    assistantMessage("周五。");
    await syncThreads(
      db,
      SESSION,
      async () =>
        JSON.stringify({ decisions: [{ thread: "new", branch: "other", title: "考试安排" }] }),
      "turn"
    );

    const text = readFileSync(logFile(), "utf8");
    expect(text).toContain("回合结束自动整理");
    expect(text).toContain("本次处理 1 个轮次");
    expect(text).toContain("已有脉络：");
    expect(text).toContain("e1. 其他「可数集」");
    expect(text).toContain("什么是可数集？");
    expect(text).toContain("模型原始返回：");
    expect(text).toContain("新建「其他」脉络「考试安排」");
    expect(text).toMatch(/剩余未分类 0 条，耗时 \d+ ms/);
  });

  it("records the deterministic tool-call precedence and an unusable answer", async () => {
    forceMakePlan(db, SESSION, { tree: [{ title: "第一章" }] });
    const nodeId = readCurrentPlan(db, SESSION)!.tree[0]!.id;
    configureThreadLog(logFile());

    userMessage("学第一章");
    assistantMessage("", [
      {
        id: newId(),
        name: PLAN_PROGRESS_TOOL_NAME,
        input: JSON.stringify({ nodes: [{ id: nodeId, status: "in_progress" }] }),
      },
    ]);
    await syncThreads(
      db,
      SESSION,
      async () =>
        JSON.stringify({ decisions: [{ thread: "new", branch: "other", title: "闲聊" }] })
    );
    let text = readFileSync(logFile(), "utf8");
    expect(text).toContain("工具调用直接定位");
    expect(text).toContain("归入计划 1「第一章」");
    expect(text).toContain("模型调用：跳过");

    userMessage("再聊聊");
    assistantMessage("好");
    await syncThreads(db, SESSION, async () => "not json");
    text = readFileSync(logFile(), "utf8");
    expect(text).toContain("模型判定失败");
    expect(text).toContain("模型返回无法解析");
    expect(text).toContain("保持未分类");
  });
});
