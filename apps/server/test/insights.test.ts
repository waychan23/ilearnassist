import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  INSIGHT_BODY_MAX,
  INSIGHT_MAX_ITEMS,
  INSIGHT_TITLE_MAX,
  type Insight,
} from "@ilearnassist/shared";
import { DEFAULT_SESSION_TITLE, createDb, newId, type AppDb } from "../src/db.js";
import { forceMakePlan } from "../src/plans.js";
import { configureModelLog } from "../src/modelLog.js";
import { buildInsightPrompt, generateInsights, parseInsightItems } from "../src/insights.js";

/**
 * The insight pass. Two things here matter more than the rest, and both are about what happens
 * when something goes wrong: the parser must never turn a malformed answer into a *successful
 * empty* one, and a failed pass must leave the user's existing list byte-identical.
 */

let root: string;
let db: AppDb;
const OWNER = "u1";
const OTHER = "u2";
const SESSION = "s1";
/** A conversation with nothing derived in it yet — what the skip gate is about. */
const FRESH_SESSION = "s3";
const OTHER_SESSION = "s2";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gl-insights-"));
  db = createDb(join(root, "test.sqlite"));
  db.createUser({ id: OWNER, username: "tester", slug: "tester" });
  db.createUser({ id: OTHER, username: "other", slug: "other" });
  db.createWorkspace({ userId: OWNER, id: "w1", name: "W", slug: "w1", dirPath: join(root, "w1") });
  db.createWorkspace({ userId: OTHER, id: "w2", name: "W2", slug: "w2", dirPath: join(root, "w2") });
  for (const [id, workspaceId] of [
    [SESSION, "w1"],
    [FRESH_SESSION, "w1"],
    [OTHER_SESSION, "w2"],
  ] as const) {
    db.createSession({
      id,
      workspaceId,
      copilotId: null,
      copilotName: "",
      systemPrompt: "",
      allTools: true,
      tools: [],
      title: DEFAULT_SESSION_TITLE,
    });
  }
  /*
   * One note in `SESSION`, because a pass only runs when there is *something* to read: the
   * readable sources are all derived, so a bare conversation takes the skip path. Nearly every
   * case below is about the call and its aftermath, and without this they would all be asserting
   * the skip — the failure cases among them passing for entirely the wrong reason.
   *
   * `FRESH_SESSION` is the one that stays empty, so the skip has a subject of its own.
   */
  db.createNote({
    id: newId(),
    sessionId: SESSION,
    messageId: null,
    type: "idea",
    quote: "",
    occurrence: 0,
    content: "这里不太懂",
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

/** A generator that answers with one fixed string, or throws when given `throwError`. */
function generatorOf(answer: string) {
  return async (): Promise<string> => answer;
}
function throwingGenerator(message = "provider exploded") {
  return async (): Promise<string> => {
    throw new Error(message);
  };
}

/** Answer with the given items, as the model would. */
const itemsAnswer = (items: unknown[]) => JSON.stringify({ items });

/** Write one row straight to the store, bypassing a pass — for "it was already there". */
function seed(item: { type?: string; title: string; body?: string; adopted?: boolean }): Insight {
  const record = {
    id: newId(),
    sessionId: SESSION,
    type: (item.type ?? "advice") as Insight["type"],
    title: item.title,
    body: item.body ?? "",
    ordinal: 0,
  };
  db.replaceUnadoptedInsights(SESSION, [record]);
  if (item.adopted) {
    db.setInsightAdoptedForUser(OWNER, SESSION, record.id, true);
  }
  return db.getInsightForUser(OWNER, SESSION, record.id)!;
}

const generate = (answer: string) =>
  generateInsights(db, OWNER, SESSION, generatorOf(answer));

describe("parseInsightItems", () => {
  it("reads a fenced JSON object", () => {
    const parsed = parseInsightItems('```json\n{"items":[{"type":"difficulty","title":"递归","body":"反复出错"}]}\n```');
    expect(parsed).toEqual([{ type: "difficulty", title: "递归", body: "反复出错" }]);
  });

  it("reads through prose written around it", () => {
    // The commonest shape by far: models like to introduce their answer.
    const parsed = parseInsightItems(
      'Here are my observations:\n\n{"items":[{"type":"habit","title":"只看不练"}]}\n\nLet me know!'
    );
    expect(parsed).toEqual([{ type: "habit", title: "只看不练", body: "" }]);
  });

  it("accepts a bare array, which is not what was asked for", () => {
    const parsed = parseInsightItems('[{"type":"reading","title":"SICP 第一章"}]');
    expect(parsed).toEqual([{ type: "reading", title: "SICP 第一章", body: "" }]);
  });

  it("treats an empty list as a successful empty answer, not a failure", () => {
    // The distinction the panel depends on: `null` is "the pass failed, keep what you had",
    // `[]` is "it looked and found nothing". Conflating them makes a quiet pass read as broken.
    expect(parseInsightItems('{"items":[]}')).toEqual([]);
    expect(parseInsightItems("[]")).toEqual([]);
    expect(parseInsightItems("no json here at all")).toBeNull();
  });

  it("files a type it does not know as advice rather than dropping the item", () => {
    // A dropped item is work the model did that the user cannot see, and inventing a ninth type
    // is something a model does. `advice` is never *wrong* about an item, only vague.
    const parsed = parseInsightItems(itemsAnswer([{ type: "epiphany", title: "恍然大悟" }]));
    expect(parsed).toEqual([{ type: "advice", title: "恍然大悟", body: "" }]);
  });

  it("recovers a missing title from the body's opening words", () => {
    const parsed = parseInsightItems(
      itemsAnswer([{ type: "confusion", detail: "似乎没有理解闭包捕获的是变量而不是值" }])
    );
    expect(parsed?.[0]?.title).toBe("似乎没有理解闭包捕获的是变量而不是值");
    expect(parsed?.[0]?.body).toBe("似乎没有理解闭包捕获的是变量而不是值");
  });

  it("skips an item with no title and no body", () => {
    // A row the panel cannot draw is not worth a row.
    const parsed = parseInsightItems(itemsAnswer([{ type: "advice" }, { title: "x" }]));
    expect(parsed).toEqual([{ type: "advice", title: "x", body: "" }]);
  });

  it("skips entries that are not objects", () => {
    const parsed = parseInsightItems(itemsAnswer(["a string", 42, null, { title: "ok" }]));
    expect(parsed).toHaveLength(1);
  });

  it("caps the count and clips both fields", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ title: `t${i}` }));
    expect(parseInsightItems(itemsAnswer(many))).toHaveLength(INSIGHT_MAX_ITEMS);

    const long = parseInsightItems(itemsAnswer([{ title: "x".repeat(400), body: "y".repeat(3000) }]));
    expect(long?.[0]?.title.length).toBeLessThanOrEqual(INSIGHT_TITLE_MAX);
    expect(long?.[0]?.body.length).toBeLessThanOrEqual(INSIGHT_BODY_MAX);
  });

  it("returns null for JSON that is not a list of items", () => {
    expect(parseInsightItems('{"observations":[]}')).toBeNull();
    expect(parseInsightItems('{"items":"not an array"}')).toBeNull();
    expect(parseInsightItems("{not json}")).toBeNull();
  });
});

describe("buildInsightPrompt", () => {
  const empty = {
    plan: undefined,
    questions: [],
    threads: { threads: [], unassigned: 0 },
    notes: [],
    diagrams: [],
    kept: [],
  };

  it("omits a section it has nothing for", () => {
    // An empty `<notes>` is a claim ("they wrote none") made at the cost of tokens and the
    // model's attention; omitting it says the same thing for free.
    const prompt = buildInsightPrompt(empty);
    expect(prompt).not.toContain("<notes");
    expect(prompt).not.toContain("<plan");
    expect(prompt).not.toContain("<already_kept");
  });

  it("tells the model what the learner already kept, and not to repeat it", () => {
    // The whole mechanism of a second pass: without it the model regenerates a near-duplicate
    // of the last answer and the feature reads as one that remembers nothing.
    const prompt = buildInsightPrompt({
      ...empty,
      kept: [{ id: "i1", type: "difficulty", title: "递归", body: "反复出错", adopted: true, createdAt: "" }],
    });
    expect(prompt).toContain("already_kept_by_the_learner");
    expect(prompt).toContain("Do not propose them again");
    expect(prompt).toContain("递归");
  });

  it("carries the plan, the questions, the notes and the diagrams", () => {
    const plan = forceMakePlan(db, SESSION, { tree: [{ title: "第一章" }, { title: "第二章" }] });
    const prompt = buildInsightPrompt({
      ...empty,
      plan: { ...plan, planId: "p", status: "in_progress", versions: [], createdAt: "", updatedAt: "" },
      questions: [
        {
          id: "q1",
          qid: "Q1",
          position: 1,
          header: "递归",
          question: "终止条件是什么？",
          multiSelect: false,
          options: [{ label: "A" }],
          status: "answered",
          verdict: "incorrect",
          feedback: "再看一遍基础情形",
          answer: { selected: ["B"] },
          nodeId: null,
          nodeTitle: null,
          toolCallId: "c1",
          createdAt: "",
          answeredAt: null,
          gradedAt: null,
        },
      ],
      notes: [{ type: "idea", quote: "栈溢出", content: "这里不太懂" }],
      diagrams: [{ name: "auth-flow.mmd", summary: "登录流程", threadTitle: null }],
    });

    // The node status is what makes the plan worth sending: a difficulty observation needs to
    // know what was attempted, not just what was planned.
    expect(prompt).toContain("1 [not_started] 第一章");
    expect(prompt).toContain("Q1 [answered/incorrect] 终止条件是什么？");
    expect(prompt).toContain("feedback: 再看一遍基础情形");
    expect(prompt).toContain("这里不太懂");
    expect(prompt).toContain("auth-flow.mmd: 登录流程");
  });
});

describe("generateInsights", () => {
  it("writes what the pass produced", async () => {
    const result = await generate(
      itemsAnswer([
        { type: "difficulty", title: "递归", body: "两次答错" },
        { type: "reading", title: "SICP" },
      ])
    );

    expect(result.status).toBe("ok");
    expect(result.generated).toBe(2);
    expect(result.items.map((i) => i.title)).toEqual(["递归", "SICP"]);
    // Nothing was adopted, so nothing is.
    expect(result.items.every((i) => !i.adopted)).toBe(true);
  });

  it("keeps the adopted items and replaces everything else", async () => {
    const kept = seed({ type: "habit", title: "只看不练", adopted: true });
    seed({ title: "上一轮的临时条目" });

    const result = await generate(itemsAnswer([{ type: "advice", title: "新建议" }]));

    expect(result.status).toBe("ok");
    expect(result.kept).toBe(1);
    // The adopted one survives, the unadopted one from the previous pass is gone.
    expect(result.items.map((i) => i.title)).toEqual(["只看不练", "新建议"]);
    expect(result.items[0]!.id).toBe(kept.id);
  });

  it("puts the adopted items first, which is the panel's order", async () => {
    seed({ title: "临时" });
    const kept = seed({ title: "留着的", adopted: true });
    const result = await generate(itemsAnswer([{ title: "新的" }]));
    expect(result.items[0]!.id).toBe(kept.id);
  });

  it("leaves every row exactly as it was when the model throws", async () => {
    /*
     * The invariant this whole module is arranged around. `replaceUnadoptedInsights` runs at the
     * END of the handler and never at the start, so a provider outage cannot cost the user the
     * list they had — which is what pressing a button and getting an empty panel would be.
     */
    seed({ title: "已有条目 A" });
    seed({ title: "已有的采纳条目", adopted: true });
    const before = db.listInsightsForUser(OWNER, SESSION);

    const result = await generateInsights(db, OWNER, SESSION, throwingGenerator());

    expect(result.status).toBe("failed");
    expect(result.generated).toBe(0);
    expect(db.listInsightsForUser(OWNER, SESSION)).toEqual(before);
  });

  it("leaves every row exactly as it was when the answer cannot be parsed", async () => {
    // The same invariant against the other failure: the call succeeded and said nothing usable.
    seed({ title: "已有条目 A" });
    const before = db.listInsightsForUser(OWNER, SESSION);

    const result = await generate("I could not find anything to say about this conversation.");

    expect(result.status).toBe("failed");
    expect(db.listInsightsForUser(OWNER, SESSION)).toEqual(before);
  });

  it("reports a genuinely empty answer as ok, with the previous rows still gone", async () => {
    // `ok` with zero items is "it looked and found nothing", which is a different claim from
    // `failed` — and the wipe still applies, because the pass *did* run and did answer.
    seed({ title: "上一轮" });
    const result = await generate('{"items":[]}');
    expect(result.status).toBe("ok");
    expect(result.generated).toBe(0);
    expect(result.items).toEqual([]);
  });

  it("sends the already-adopted items back to the model", async () => {
    seed({ title: "留着的", adopted: true });
    let seen = "";
    await generateInsights(db, OWNER, SESSION, async (_system, user) => {
      seen = user;
      return itemsAnswer([]);
    });
    expect(seen).toContain("already_kept_by_the_learner");
    expect(seen).toContain("留着的");
  });

  it("does not touch another conversation's rows", async () => {
    db.replaceUnadoptedInsights(OTHER_SESSION, [
      { id: newId(), sessionId: OTHER_SESSION, type: "advice", title: "别人的", body: "", ordinal: 0 },
    ]);
    await generate(itemsAnswer([{ title: "我的" }]));
    expect(db.listInsightsForUser(OTHER, OTHER_SESSION).map((i) => i.title)).toEqual(["别人的"]);
  });
});

describe("a pass with nothing to reflect on", () => {
  it("makes no model call at all", async () => {
    /*
     * The readable sources are all *derived*, so a conversation that has just been created has
     * none of them. Spending a whole model call to ask about an empty record would be paying for
     * the one instruction the prompt cannot honour — "say what you actually see" — and the
     * `threads.ts` precedent is the same rule: a no-op makes no model call.
     *
     * A real server's log line `提示词：0 字符` is what surfaced this.
     */
    let called = 0;
    const result = await generateInsights(db, OWNER, FRESH_SESSION, async () => {
      called += 1;
      return itemsAnswer([{ title: "凭空捏造" }]);
    });

    expect(called).toBe(0);
    // Not `"ok"`: zero new items is also what a pass that looked and found nothing returns, and
    // the two ask the reader for opposite things.
    expect(result.status).toBe("empty");
    expect(result.generated).toBe(0);
    expect(db.listInsightsForUser(OWNER, FRESH_SESSION)).toEqual([]);
  });

  it("leaves an adopted list exactly as it was", async () => {
    // Skipping is not a wipe. The button does nothing to what is already there.
    const kept = seed({ title: "留着的", adopted: true });
    const result = await generateInsights(db, OWNER, SESSION, throwingGenerator());
    expect(result.items).toEqual([kept]);
  });

  it("runs once there is one thing to read", async () => {
    // The gate is "any source at all", not a threshold, and the fixture's one note is enough —
    // which is also the assertion: `SESSION` differs from `FRESH_SESSION` by nothing else.
    let called = 0;
    const result = await generateInsights(db, OWNER, SESSION, async () => {
      called += 1;
      return itemsAnswer([{ title: "条目" }]);
    });
    expect(called).toBe(1);
    expect(result.generated).toBe(1);

    // And the same generator against the conversation with no note never gets there.
    let freshCalled = 0;
    await generateInsights(db, OWNER, FRESH_SESSION, async () => {
      freshCalled += 1;
      return itemsAnswer([{ title: "条目" }]);
    });
    expect(freshCalled).toBe(0);
  });

  it("says in the log that it skipped rather than that it failed", async () => {
    // "The button did nothing" and "the pass ran and found nothing" look identical on screen and
    // are not the same thing to a reader, so the block names which one it was.
    const logFile = () => join(root, "logs", "insights.log");
    configureModelLog({ insights: logFile() });

    await generateInsights(db, OWNER, FRESH_SESSION, throwingGenerator("never called"));

    const text = readFileSync(logFile(), "utf8");
    expect(text).toContain("⏭ 跳过：素材为空，没有调用模型");
    expect(text).toContain("提示词：0 字符");
    expect(text).toContain("结果：未改动任何条目");
    // Not the failure block: nothing failed.
    expect(text).not.toContain("✗ 本次未写入任何条目");
  });
});

describe("the insight store", () => {
  it("answers nothing for another account's conversation", async () => {
    seed({ title: "我的" });
    expect(db.listInsightsForUser(OTHER, SESSION)).toEqual([]);
    expect(db.getInsightForUser(OTHER, SESSION, "anything")).toBeUndefined();
  });

  it("refuses to adopt or delete a row that is not this account's", () => {
    const mine = seed({ title: "我的" });
    expect(db.setInsightAdoptedForUser(OTHER, SESSION, mine.id, true)).toBeUndefined();
    expect(db.deleteInsightForUser(OTHER, SESSION, mine.id)).toBe(false);
    // And the row is untouched by either attempt.
    expect(db.getInsightForUser(OWNER, SESSION, mine.id)?.adopted).toBe(false);
  });

  it("releases an adopted row, which the next pass then replaces", async () => {
    // Adopt is a toggle rather than a one-way door: a mis-click otherwise has no undo that is
    // not "delete", and deleting is a different statement.
    const item = seed({ title: "留着的", adopted: true });
    expect(db.setInsightAdoptedForUser(OWNER, SESSION, item.id, false)?.adopted).toBe(false);

    const result = await generate(itemsAnswer([{ title: "新的" }]));
    expect(result.items.map((i) => i.title)).toEqual(["新的"]);
  });

  it("orders a pass by the model's own sequence, not by a shared timestamp", () => {
    // One transaction, so every row shares `created_at` to the millisecond — `ordinal` is what
    // keeps the model's order, and without it the list would come back in insertion-arbitrary
    // order on a busy database.
    db.replaceUnadoptedInsights(
      SESSION,
      ["一", "二", "三"].map((title, ordinal) => ({
        id: newId(),
        sessionId: SESSION,
        type: "advice" as const,
        title,
        body: "",
        ordinal,
      }))
    );
    expect(db.listInsightsForUser(OWNER, SESSION).map((i) => i.title)).toEqual(["一", "二", "三"]);
  });
});

describe("the observation log", () => {
  const logFile = () => join(root, "logs", "insights.log");

  beforeEach(() => {
    // Unconfigured by default, like every other test in the file: the log is a process-entry
    // concern and a test that did not ask for one must not write a file.
    configureModelLog({ insights: null });
  });

  it("writes nothing until the process configures a file", async () => {
    expect(existsSync(logFile())).toBe(false);
    await generate(itemsAnswer([{ title: "条目" }]));
    expect(existsSync(logFile())).toBe(false);
  });

  it("appends a block describing the pass and what it wrote", async () => {
    configureModelLog({ insights: logFile() });
    forceMakePlan(db, SESSION, { tree: [{ title: "第一章" }] });
    // The fixture's single note is the only one, so the count below is a count and not a sum.
    seed({ title: "上一轮留下来的", adopted: true });

    const result = await generateInsights(
      db,
      OWNER,
      SESSION,
      generatorOf(itemsAnswer([{ type: "difficulty", title: "递归", body: "反复出错" }])),
      "fake-model"
    );
    expect(result.status).toBe("ok");

    const text = readFileSync(logFile(), "utf8");
    expect(text).toContain("洞察总结");
    // Which model ran it, because a pass that behaves differently after a model change is the
    // first thing a reader wants to rule in or out.
    expect(text).toContain("模型：fake-model");
    // The source counts, which are what tell "nothing to reflect on" apart from "the model failed".
    expect(text).toContain("计划：1 个根节点");
    expect(text).toContain("笔记：1 条");
    expect(text).toContain("已采纳（已在提示中要求不要重复）：1 条");
    expect(text).toMatch(/提示词：\d+ 字符/);
    // The model's answer and how it was read, item by item.
    expect(text).toContain("模型原始返回：");
    expect(text).toContain("解析结果：1 条");
    expect(text).toContain("1. [difficulty] 递归");
    expect(text).toMatch(/结果：写入 1 条，保留已采纳 1 条，耗时 \d+ ms/);
  });

  it("keeps the raw answer when it could not be used", async () => {
    /*
     * The one thing the panel cannot say. "That pass produced nothing usable" is the same
     * sentence for a fence-wrapped object the parser should have accepted and for a refusal in
     * prose, and only the raw text tells them apart — which is the whole reason this log exists
     * for an on-demand call.
     */
    configureModelLog({ insights: logFile() });
    const result = await generate("I am not able to help with that request.");

    expect(result.status).toBe("failed");
    const text = readFileSync(logFile(), "utf8");
    expect(text).toContain("✗ 本次未写入任何条目");
    expect(text).toContain("原因：答案无法解析为条目数组");
    expect(text).toContain("I am not able to help with that request.");
    expect(text).toContain("结果：未改动任何条目");
  });

  it("records a provider failure with its own message", async () => {
    configureModelLog({ insights: logFile() });
    await generateInsights(db, OWNER, SESSION, throwingGenerator("provider exploded"));

    const text = readFileSync(logFile(), "utf8");
    expect(text).toContain("✗ 本次未写入任何条目");
    expect(text).toContain("原因：provider exploded");
  });

  it("reports the write rather than predicting it", async () => {
    /*
     * The block is written *after* the transaction, so its counts are facts. Emitted before, the
     * "wrote N items" line was a prediction, and a transaction that threw left a log claiming a
     * write that nobody could find — worse than no log at all, because it says the opposite of
     * the truth about the one thing the log is there to record.
     */
    configureModelLog({ insights: logFile() });
    const replace = db.replaceUnadoptedInsights;
    let calls = 0;
    db.replaceUnadoptedInsights = () => {
      calls += 1;
      throw new Error("database is locked");
    };
    try {
      const result = await generateInsights(
        db,
        OWNER,
        SESSION,
        generatorOf(itemsAnswer([{ title: "条目" }]))
      );

      // A write that failed wrote nothing, so it answers like a failed pass...
      expect(calls).toBe(1);
      expect(result.status).toBe("failed");
      expect(result.generated).toBe(0);
      // ...and the log says which of the two failures it was, because "the model was fine and
      // the database was not" is a different thing to go and fix.
      const text = readFileSync(logFile(), "utf8");
      expect(text).toContain("原因：database is locked");
      expect(text).toContain("结果：未改动任何条目");
      expect(text).not.toContain("写入 1 条");
    } finally {
      db.replaceUnadoptedInsights = replace;
    }
  });
});
