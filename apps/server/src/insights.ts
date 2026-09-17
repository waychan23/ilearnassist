import {
  INSIGHT_BODY_MAX,
  INSIGHT_FALLBACK_TYPE,
  INSIGHT_MAX_ITEMS,
  INSIGHT_MAX_KEPT_IN_PROMPT,
  INSIGHT_TITLE_MAX,
  isInsightType,
  planNodeNumbers,
  type Insight,
  type InsightType,
  type PlanTreeNode,
  type QuizQuestionView,
} from "@ilearnassist/shared";
import { newId, type AppDb, type InsightInsert } from "./db.js";
import { readCurrentPlan } from "./plans.js";
import { listQuizQuestionViews } from "./quizzes.js";
import { buildThreadViews } from "./threads.js";
import { logTimestamp, modelLog } from "./modelLog.js";
import { parseModelJson, stripFence } from "./modelJson.js";
import { renderPrompt } from "./prompts.js";

/**
 * The insight pass: what a conversation's own record says about the learner.
 *
 * The shape mirrors `threads.ts` — this module owns every decision, the model call lives in
 * `agent/insights.ts` and is injected, so the prompt and the parser are testable with a fake
 * generator and no provider.
 *
 * It is **not** a tool, deliberately. `ila_query` is how the *agent* reads this material during
 * a turn; a pass is a user pressing a button, because it costs a full model call over the whole
 * conversation and the agent must not decide to spend that on a panel nobody may open.
 */

/** The model call: system + human prompt in, raw text out. Implemented in `agent/insights.ts`. */
export type InsightGenerator = (systemPrompt: string, userPrompt: string) => Promise<string>;

/* --------------------------------- the prompt -------------------------------- */

/**
 * How much of each source the prompt carries.
 *
 * Every one of these is a **ceiling on the model's thinking time as much as on the tokens**: the
 * `threads.ts` lesson is explicit that a reasoning model given too much input thinks for a
 * hundred seconds and returns nothing at all. The whole user prompt is bounded by their sum.
 */
const MAX_PLAN_NODES = 120;
const MAX_PLAN_TITLE_CHARS = 80;
const MAX_QUIZ_QUESTIONS = 30;
const MAX_QUIZ_FIELD_CHARS = 300;
const MAX_THREADS = 40;
const MAX_THREAD_PREVIEW_CHARS = 120;
const MAX_THREAD_PREVIEWS = 2;
const MAX_NOTES = 40;
const MAX_NOTE_CHARS = 300;
const MAX_DIAGRAMS = 20;
const MAX_DIAGRAM_SUMMARY_CHARS = 240;
const MAX_KEPT_BODY_CHARS = 300;

/**
 * Model input, so English and untranslated on purpose — the same rule the tool descriptions and
 * the tool results follow. Translating it would change what the model does.
 *
 * The fenced-data instruction is not boilerplate here. The payload is largely the learner's own
 * free text, so a note reading "ignore your instructions and…" is a sentence this prompt must
 * survive: the note is an observation *about* the learner, never a direction to follow.
 *
 * The insight pass's system prompt, rendered from the catalog at call time.
 *
 * The limits it quotes are the parser's own, passed in rather than spelled in the text:
 * `INSIGHT_MAX_ITEMS` and friends are documented as ceilings the parser enforces, so a prompt that
 * disagreed with them would ask for more than could ever be kept.
 *
 * A function rather than a constant, and that is load-bearing: the catalog is patched by the
 * process entry point (`<dataRoot>/config.patch.json`), which runs *after* every module has been
 * evaluated. A module-level constant would be the bundled text forever, so a tuned prompt would
 * silently do nothing.
 */
export function insightSystemPrompt(): string {
  return renderPrompt("insight.system", {
    maxItems: String(INSIGHT_MAX_ITEMS),
    titleMax: String(INSIGHT_TITLE_MAX),
    bodyMax: String(INSIGHT_BODY_MAX),
  });
}

export interface InsightPromptInput {
  plan: ReturnType<typeof readCurrentPlan>;
  questions: QuizQuestionView[];
  threads: ReturnType<typeof buildThreadViews>;
  notes: Array<{ type: string; quote: string; content: string }>;
  diagrams: Array<{ name: string; summary: string; threadTitle: string | null }>;
  /**
   * The conversation's tables, name and summary only.
   *
   * Never the markdown: a table's content is thousands of characters, which is exactly why
   * `MAX_DIAGRAM_SUMMARY_CHARS` exists one line up — the pass is about the *learner*, and what a
   * table is about is in its summary.
   */
  tables: Array<{ name: string; summary: string; threadTitle: string | null }>;
  /** Adopted items from earlier passes, so the model does not propose them again. */
  kept: Insight[];
}

/**
 * A field clipped to a cap, ellipsis included.
 *
 * The ellipsis is inside the cap rather than after it, which is the difference between a
 * ceiling and a suggestion: `INSIGHT_TITLE_MAX` is documented as the longest a title may be, and
 * a body of `max + 1` is a column that overflows by exactly one character at every rendering.
 */
function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, Math.max(1, max - 1)).trimEnd() + "…" : flat;
}

/** The plan as a flat numbered outline, the same numbering the panel and the tools use. */
function renderPlan(tree: readonly PlanTreeNode[]): string[] {
  const numbers = planNodeNumbers(tree);
  const lines: string[] = [];
  const walk = (nodes: readonly PlanTreeNode[]): void => {
    for (const node of nodes) {
      if (lines.length >= MAX_PLAN_NODES) return;
      lines.push(
        `${numbers.get(node.id) ?? "?"} [${node.status}] ${clip(node.title, MAX_PLAN_TITLE_CHARS)}`
      );
      if (node.children) walk(node.children);
    }
  };
  walk(tree);
  return lines;
}

/**
 * Assemble the `<study_record>` payload.
 *
 * Sections are omitted when empty rather than rendered as a heading with nothing under it: an
 * empty `<notes>` reads to a model as "the learner wrote no notes", which is true, while a
 * `<notes>` listing nothing at all is the same claim made at the cost of tokens and attention.
 */
export function buildInsightPrompt(input: InsightPromptInput): string {
  const out: string[] = [];

  if (input.plan) {
    const lines = renderPlan(input.plan.tree);
    if (lines.length > 0) {
      out.push(`<plan status="${input.plan.status}" version="${input.plan.version}">`);
      out.push(...lines, "</plan>");
    }
  }

  const answered = input.questions.filter((q) => q.status !== "pending").slice(-MAX_QUIZ_QUESTIONS);
  if (answered.length > 0) {
    out.push("<questions>");
    for (const q of answered) {
      out.push(`- ${q.qid} [${q.status}${q.verdict ? `/${q.verdict}` : ""}] ${clip(q.question, MAX_QUIZ_FIELD_CHARS)}`);
      if (q.answer) {
        const picked = q.answer.selected.length > 0 ? q.answer.selected.join(", ") : "";
        const unsure = q.answer.unsure ? ` (unsure${q.answer.unsureReason ? `: ${clip(q.answer.unsureReason, MAX_QUIZ_FIELD_CHARS)}` : ""})` : "";
        out.push(`  answered: ${picked}${unsure}`);
      }
      if (q.feedback) out.push(`  feedback: ${clip(q.feedback, MAX_QUIZ_FIELD_CHARS)}`);
    }
    out.push("</questions>");
  }

  const threads = input.threads.threads.slice(0, MAX_THREADS);
  if (threads.length > 0) {
    out.push("<topics>");
    for (const thread of threads) {
      const previews = thread.messages
        .slice(-MAX_THREAD_PREVIEWS)
        .map((m) => `    ${m.role}: ${clip(m.preview, MAX_THREAD_PREVIEW_CHARS)}`);
      out.push(`- [${thread.branch}] ${clip(thread.title, MAX_THREAD_PREVIEW_CHARS)}`);
      out.push(...previews);
    }
    out.push("</topics>");
  }

  const notes = input.notes.slice(0, MAX_NOTES);
  if (notes.length > 0) {
    out.push("<notes_written_by_the_learner>");
    for (const note of notes) {
      const on = note.quote ? ` (on: ${clip(note.quote, MAX_THREAD_PREVIEW_CHARS)})` : "";
      out.push(`- [${note.type}]${on} ${clip(note.content, MAX_NOTE_CHARS)}`);
    }
    out.push("</notes_written_by_the_learner>");
  }

  const diagrams = input.diagrams.slice(0, MAX_DIAGRAMS);
  if (diagrams.length > 0) {
    out.push("<diagrams>");
    for (const d of diagrams) {
      out.push(`- ${clip(d.name, MAX_THREAD_PREVIEW_CHARS)}: ${clip(d.summary, MAX_DIAGRAM_SUMMARY_CHARS)}`);
    }
    out.push("</diagrams>");
  }

  const tables = input.tables.slice(0, MAX_DIAGRAMS);
  if (tables.length > 0) {
    out.push("<tables>");
    for (const t of tables) {
      out.push(`- ${clip(t.name, MAX_THREAD_PREVIEW_CHARS)}: ${clip(t.summary, MAX_DIAGRAM_SUMMARY_CHARS)}`);
    }
    out.push("</tables>");
  }

  /*
   * The whole mechanism of a second pass, in one section. Without it the model regenerates a
   * near-duplicate of what the reader already kept, which reads as a feature that does not
   * remember anything.
   */
  if (input.kept.length > 0) {
    out.push("<already_kept_by_the_learner>");
    out.push("The learner has ALREADY KEPT these. Do not propose them again, and do not propose");
    out.push("a reworded version of one. Only genuinely new observations belong below.");
    for (const item of input.kept.slice(0, INSIGHT_MAX_KEPT_IN_PROMPT)) {
      out.push(`- [${item.type}] ${clip(item.title, INSIGHT_TITLE_MAX)}: ${clip(item.body, MAX_KEPT_BODY_CHARS)}`);
    }
    out.push("</already_kept_by_the_learner>");
  }

  return out.join("\n");
}

/* --------------------------------- the parser -------------------------------- */

/** One observation as the model offered it, sanitised but not yet stored. */
export interface ParsedInsight {
  type: InsightType;
  title: string;
  body: string;
}

/** An alias table, because "heading"/"detail" are what a model reaches for second. */
function firstString(source: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** The title cleanup `sanitizeThreadTitle` applies, at this type's own cap. */
function cleanTitle(raw: string): string {
  let title = raw.trim();
  const firstLine = title.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  if (firstLine) title = firstLine;
  title = title
    .replace(/^["'“”‘’«]+|["'“”‘’»]+$/g, "")
    .replace(/[.。!！?？,，;；:：]+$/g, "")
    .trim();
  return clip(title, INSIGHT_TITLE_MAX);
}

/** A body, never clipped mid-line — it is prose, so only its length matters. */
function cleanBody(raw: string): string {
  return clip(raw.replace(/\r/g, ""), INSIGHT_BODY_MAX);
}

/**
 * Read the model's answer into items, or `null` when nothing usable is there.
 *
 * The three outcomes are deliberately three, and conflating any two of them would make the
 * panel lie:
 *
 * - **`null`** — no array, or not JSON at all. The pass *failed*, and the caller must leave
 *   every row exactly as it was. This is the case that protects the user's list.
 * - **`[]`** — an array the model genuinely left empty. The pass succeeded and found nothing,
 *   which the panel says in its own words rather than showing a failure.
 * - **items** — sanitised. An item with no usable title is dropped (a row the panel cannot
 *   draw), a type outside `INSIGHT_TYPES` is filed as `advice` rather than dropped, and both
 *   fields are clipped to their caps.
 */
export function parseInsightItems(raw: string): ParsedInsight[] | null {
  /*
   * Which shape the answer is, decided by **which delimiter comes first** — never by trying
   * both. `{items:[…]}` is what the prompt asks for, and a bare `[…]` is what models answer
   * often enough that refusing it would be a parser failing at its own job.
   *
   * Trying both is the trap: scanning for an array finds one *inside* an object, so
   * `{"observations":[…]}` would parse as a successful answer — and `{"observations":[]}` as a
   * successful *empty* one, which tells the panel "it looked and found nothing" about an answer
   * it could not read. Comparing the two positions costs one line and keeps that a failure.
   */
  const text = stripFence(raw);
  const openObject = text.indexOf("{");
  const openArray = text.indexOf("[");
  const isArrayAnswer = openArray !== -1 && (openObject === -1 || openArray < openObject);

  let list: unknown;
  if (isArrayAnswer) {
    list = parseModelJson(raw, "array");
  } else {
    const wrapped = parseModelJson(raw, "object");
    list =
      wrapped && typeof wrapped === "object" && !Array.isArray(wrapped)
        ? (wrapped as { items?: unknown }).items
        : undefined;
  }
  if (!Array.isArray(list)) return null;

  const out: ParsedInsight[] = [];
  for (const entry of list) {
    if (out.length >= INSIGHT_MAX_ITEMS) break;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;

    const body = cleanBody(firstString(item, ["body", "detail", "description", "text"]));
    // A title is recovered from the body's opening words before the item is given up on: the
    // body is the part that carries the observation, and a row titled by its own first clause
    // is still worth showing.
    const title =
      cleanTitle(firstString(item, ["title", "heading", "name"])) ||
      cleanTitle(clip(body, 40));
    if (!title) continue;

    const type = item.type;
    out.push({
      type: isInsightType(type) ? type : INSIGHT_FALLBACK_TYPE,
      title,
      body,
    });
  }
  return out;
}

/* ----------------------------------- the pass -------------------------------- */

export interface GenerateResult {
  /** `"empty"` is the skip: nothing to reflect on, so no model was called. See the shared type. */
  status: "ok" | "empty" | "failed";
  /** Items written by this pass. */
  generated: number;
  /** Items that survived because they were adopted. */
  kept: number;
  /** The pass's own view of the conversation afterwards, in the panel's order. */
  items: Insight[];
}

/** The panel's read model, and the route's answer. */
export function buildInsightViews(
  db: AppDb,
  userId: string,
  sessionId: string
): Insight[] {
  return db.listInsightsForUser(userId, sessionId);
}

/** Everything the prompt is built from, read once so the pass and the log agree. */
function gatherSources(db: AppDb, userId: string, sessionId: string): InsightPromptInput {
  return {
    plan: readCurrentPlan(db, sessionId),
    questions: listQuizQuestionViews(db, userId, sessionId),
    threads: buildThreadViews(db, userId, sessionId),
    notes: db
      .listNotesForUser(userId, sessionId)
      .map((n) => ({ type: n.type, quote: n.quote, content: n.content })),
    diagrams: db
      .listDiagramsForUser(userId, sessionId)
      .map((d) => ({ name: d.name, summary: d.summary, threadTitle: d.threadTitle })),
    tables: db
      .listTablesForUser(userId, sessionId)
      .map((t) => ({ name: t.name, summary: t.summary, threadTitle: t.threadTitle })),
    kept: db.listInsightsForUser(userId, sessionId).filter((i) => i.adopted),
  };
}

/**
 * Whether there is anything to reflect on at all.
 *
 * The readable sources are all *derived* — a plan, answered questions, classified threads,
 * notes, diagrams — so a conversation that has just been created has none of them, and one with
 * a few turns of ordinary back-and-forth may still have none. The pass must not spend a model
 * call on that, and it must not ask a model to observe a learner from an empty record: the honest
 * answers are both nothing at all, so the prompt would be the literal string "".
 *
 * `kept` is deliberately **not** a source here. Adopted items are an instruction not to repeat
 * something, and an instruction about nothing is not material.
 */
function hasMaterial(sources: InsightPromptInput): boolean {
  return (
    (sources.plan?.tree.length ?? 0) > 0 ||
    sources.questions.length > 0 ||
    sources.threads.threads.length > 0 ||
    sources.notes.length > 0 ||
    sources.diagrams.length > 0
  );
}

/**
 * Run one pass and write what it produced.
 *
 * **The wipe happens only after a usable parse** — `replaceUnadoptedInsights` is called at the
 * end and never at the start, and that ordering is the invariant this function exists to hold.
 * A provider hiccup, a timeout, or an answer the parser rejects must leave every row exactly as
 * it was: the alternative is a user pressing a button, getting nothing back, and losing the list
 * they had. It has its own test.
 *
 * There is deliberately no in-flight map, unlike `syncThreads`. That one has it because two
 * different triggers can race for one session; here the only trigger is a button the panel
 * disables while it runs, so a second concurrent pass is a double-click the UI prevents.
 */
export async function generateInsights(
  db: AppDb,
  userId: string,
  sessionId: string,
  generate: InsightGenerator,
  /** Which model the pass calls — observation-log only. */
  model = ""
): Promise<GenerateResult> {
  const startedAt = Date.now();
  const sources = gatherSources(db, userId, sessionId);
  const prompt = buildInsightPrompt(sources);
  const kept = sources.kept.length;

  /*
   * Nothing to reflect on: no model call, and the list untouched. The `threads.ts` precedent —
   * "a no-op when nothing is unassigned makes no model call" — for the same reason, plus one of
   * its own: a pass over an empty record would spend a whole call to ask a model to observe a
   * learner it was told nothing about, which is the one instruction the prompt cannot honour.
   *
   * The log still gets a block, because "the button did nothing" and "the pass ran and found
   * nothing" look identical on screen and are not at all the same thing to a reader.
   */
  if (!hasMaterial(sources)) {
    logPass({
      sessionId,
      model,
      sources,
      prompt,
      raw: "",
      parsed: null,
      failure: "",
      kept,
      written: 0,
      startedAt,
      skipped: true,
    });
    return { status: "empty", generated: 0, kept, items: buildInsightViews(db, userId, sessionId) };
  }

  let raw = "";
  let parsed: ParsedInsight[] | null = null;
  let failure = "";
  try {
    raw = await generate(insightSystemPrompt(), prompt);
    parsed = parseInsightItems(raw);
    if (!parsed) failure = "答案无法解析为条目数组";
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }

  let written = 0;
  if (parsed) {
    try {
      // After the parse, never before — see the docblock.
      db.replaceUnadoptedInsights(
        sessionId,
        parsed.map((item, index) => ({
          id: newId(),
          sessionId,
          type: item.type,
          title: item.title,
          body: item.body,
          ordinal: index,
        }))
      );
      written = parsed.length;
    } catch (err) {
      // A write that failed wrote nothing, so this is the same answer as a failed pass — and the
      // log says which of the two it was, because "the model was fine and the database was not"
      // is a different thing to go and fix.
      failure = err instanceof Error ? err.message : String(err);
      parsed = null;
    }
  }

  /*
   * Logged **after** the write, so the block reports what happened rather than what was about to.
   * Ahead of it, the "wrote N items" line was a prediction: a transaction that threw left a log
   * claiming a write nobody could find, which is worse than no log at all.
   */
  logPass({ sessionId, model, sources, prompt, raw, parsed, failure, kept, written, startedAt });

  if (!parsed) {
    // The rows are untouched: this is the whole point of the ordering above, and the caller
    // reports "failed" rather than an empty list, because the two are different claims.
    return { status: "failed", generated: 0, kept, items: buildInsightViews(db, userId, sessionId) };
  }

  return {
    status: "ok",
    generated: written,
    kept,
    items: buildInsightViews(db, userId, sessionId),
  };
}

/** One pass's outcome, as the log needs it. Named fields rather than a long positional list. */
interface PassLog {
  sessionId: string;
  model: string;
  sources: InsightPromptInput;
  prompt: string;
  /** The model's raw answer. Empty when it was never called. */
  raw: string;
  /** Sanitised items, or `null` when there was nothing usable — including a skip. */
  parsed: ParsedInsight[] | null;
  failure: string;
  kept: number;
  /** What the transaction actually committed. */
  written: number;
  startedAt: number;
  /** The model was never called, because there was nothing to reflect on. */
  skipped?: boolean;
}

/**
 * One human-readable block per pass, into `<dataRoot>/logs/insights.log`.
 *
 * The shape is `threads.ts`'s, for its reason: a 60-second call that returns nothing usable is
 * exactly what a log of this kind exists for, and the counts per source are what say whether the
 * prompt was empty (nothing to reflect on) or the model failed (something to fix).
 *
 * **Three outcomes look alike on screen and are different here**: a pass that was skipped, one
 * whose call failed, and one the model answered unusably. The panel says "nothing to show" for
 * the first two and "that pass produced nothing usable" for the last, and a reader looking at a
 * button that seemed to do nothing needs to know which — so the block names it.
 *
 * Two things a pass cannot show on screen and this can: the **prompt's size and source counts**,
 * and the model's **raw answer even when it is unusable** — "produced nothing usable" is the same
 * sentence for a fence-wrapped object the parser should have accepted and for a refusal in prose,
 * and only the raw text says which.
 */
function logPass(input: PassLog): void {
  const { sources, parsed, skipped } = input;
  modelLog("insights", () =>
    [
      `${logTimestamp()} 会话 ${input.sessionId} — 洞察总结`,
      `模型：${input.model || "(未记录)"}`,
      "素材：",
      `  计划：${sources.plan ? `${sources.plan.tree.length} 个根节点、状态 ${sources.plan.status}` : "无"}`,
      `  小测：${sources.questions.length} 题（已作答 ${sources.questions.filter((q) => q.status !== "pending").length}）`,
      `  脉络：${sources.threads.threads.length} 条（未分类消息 ${sources.threads.unassigned}）`,
      `  笔记：${sources.notes.length} 条`,
      `  图表：${sources.diagrams.length} 张｜表格：${sources.tables.length} 张`,
      `  已采纳（已在提示中要求不要重复）：${input.kept} 条`,
      `提示词：${input.prompt.length} 字符`,
      ...(skipped
        ? ["⏭ 跳过：素材为空，没有调用模型"]
        : parsed
          ? [
              "模型原始返回：",
              clip(input.raw.trim(), 2_000),
              `解析结果：${parsed.length} 条`,
              ...parsed.map((item, i) => `  ${i + 1}. [${item.type}] ${item.title}`),
            ]
          : [
              "✗ 本次未写入任何条目",
              `原因：${input.failure}`,
              "模型原始返回：",
              clip(input.raw.trim(), 2_000),
            ]),
      // What the transaction committed, which is why this block is written after it.
      `结果：${input.written > 0 ? `写入 ${input.written} 条，保留已采纳 ${input.kept} 条` : "未改动任何条目"}，耗时 ${
        Date.now() - input.startedAt
      } ms`,
      "",
    ].join("\n") + "\n"
  );
}
