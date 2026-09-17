import {
  DIAGRAM_TOOL_NAME,
  PLAN_PROGRESS_TOOL_NAME,
  TABLE_TOOL_NAME,
  planNodeNumbers,
  type GetSessionThreadsResponse,
  type Message,
  type PlanTreeNode,
  type PlanView,
  type ThreadBranch,
  type ThreadMessageView,
  type ThreadView,
  type ToolCall,
} from "@ilearnassist/shared";
import { readCurrentPlan } from "./plans.js";
import {
  newId,
  type AppDb,
  type DiagramRecord,
  type TableRecord,
  type ThreadRecord,
} from "./db.js";
import { logTimestamp, modelLog } from "./modelLog.js";
import { parseModelJson } from "./modelJson.js";
import { renderPrompt } from "./prompts.js";

/**
 * The thread widget's derived topic chains.
 *
 * The split mirrors `plans.ts` / `quizzes.ts`: this module owns every decision (what a turn
 * is, what the model is asked, how its answer is applied) and holds no HTTP. The model call
 * itself lives in `agent/threads.ts` — like the auto-titler, a small out-of-band completion —
 * and is injected, so this module is unit-testable with a fake classifier.
 */

/**
 * At most this many still-unassigned turns are classified by one model call. Five rather
 * than eight on purpose: each extra turn is more prompt AND more unseen reasoning, and a
 * reasoning model that exhausts its output budget emits an empty answer. Backfill simply
 * takes a couple more calls; the live path is always one turn.
 */
export const MAX_TURNS_PER_SYNC = 5;
/** Hard cap on messages read for one chunk; a pathological ask_user chain is the only overflow. */
const MAX_MESSAGES_PER_CHUNK = MAX_TURNS_PER_SYNC * 20;
/** How much of one message is shown to the classifier. */
const MAX_MESSAGE_CHARS = 350;
/** Classified messages shown before the new turns, so a chunk boundary reads continuously. */
const RECENT_TAIL = 3;
/** One-line leaf preview length. */
const PREVIEW_CHARS = 80;
/** A model-given thread title's cap. */
const TITLE_CHARS = 60;
/** How much of a diagram's summary the classifier is shown — one-line material. */
const DIAGRAM_SUMMARY_CHARS_IN_PROMPT = 240;
/**
 * At most this many diagrams are put to the model per chunk; any beyond this ride the
 * collapse rule and inherit their turn's thread, so none are ever stranded.
 */
const MAX_DIAGRAMS_PER_PROMPT = 12;

/**
 * The table cap, separate from the diagram one rather than shared.
 *
 * A shared counter would silently become "12 artifacts", so a conversation that recorded a dozen
 * tables would leave its diagrams unplaced — one kind starving the other. The number is lower
 * because a table's entry is a name and a summary like a diagram's, but a conversation with more
 * than eight tables worth classifying in one chunk is one whose turns are better served by the
 * order they arrived in. Past the cap a table collapses to its turn's thread, exactly as a
 * diagram does: none are stranded.
 */
const MAX_TABLES_PER_PROMPT = 8;

/* ---------------------------------- turns ---------------------------------- */

/**
 * One turn: a user message plus every assistant reply that follows it up to the next user
 * message. Turns, not messages, are classified — a reply is never a topic of its own, so an
 * exchange can never be split across two threads. An assistant-first run (the regenerate
 * case: the user message kept its thread and only the reply is new) is its own turn.
 */
export interface ThreadTurn {
  messages: Message[];
}

export function segmentTurns(messages: readonly Message[]): ThreadTurn[] {
  const turns: ThreadTurn[] = [];
  for (const message of messages) {
    if (message.role === "user" || turns.length === 0) {
      turns.push({ messages: [message] });
    } else {
      turns[turns.length - 1]?.messages.push(message);
    }
  }
  return turns;
}

/* --------------------------- deterministic signals -------------------------- */

function flatPlanNodes(plan: PlanView): Map<string, { number: string; node: PlanTreeNode }> {
  const out = new Map<string, { number: string; node: PlanTreeNode }>();
  const numbers = planNodeNumbers(plan.tree);
  const walk = (nodes: readonly PlanTreeNode[]): void => {
    for (const node of nodes) {
      out.set(node.id, { number: numbers.get(node.id) ?? "", node });
      if (node.children) walk(node.children);
    }
  };
  walk(plan.tree);
  return out;
}

/** The first live node currently `in_progress`, DFS in plan order. */
export function currentPlanNode(plan: PlanView | undefined): string | undefined {
  if (!plan) return undefined;
  let found: string | undefined;
  const walk = (nodes: readonly PlanTreeNode[]): void => {
    for (const node of nodes) {
      if (found) return;
      if (node.status === "in_progress") {
        found = node.id;
        return;
      }
      if (node.children) walk(node.children);
    }
  };
  walk(plan.tree);
  return found;
}

interface PlanProgressChange {
  id?: unknown;
  status?: unknown;
}

/**
 * The plan node a turn moved, read out of the turn's OWN `ila_update_plan_progress` calls.
 *
 * This precedence beats whatever the classifier says, and it has to: during a backfill the
 * plan's current status is today's, not history's, so "the current node" would be a lie about
 * an old turn. The call placed before the teaching is the marker — the node first named
 * `in_progress`, falling back to the first `completed` change (a node finished in one call).
 */
export function progressNodeForTurn(
  turn: ThreadTurn,
  nodes: Map<string, unknown>
): string | undefined {
  let completed: string | undefined;
  for (const message of turn.messages) {
    for (const call of message.toolCalls ?? []) {
      if (call.name !== PLAN_PROGRESS_TOOL_NAME) continue;
      let changes: PlanProgressChange[] = [];
      try {
        const parsed = JSON.parse(call.input) as { nodes?: PlanProgressChange[] };
        changes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
      } catch {
        continue;
      }
      for (const change of changes) {
        if (typeof change.id !== "string" || !nodes.has(change.id)) continue;
        if (change.status === "in_progress") return change.id;
        if (completed === undefined && change.status === "completed") completed = change.id;
      }
    }
  }
  return completed;
}

/* --------------------------------- prompt ---------------------------------- */

/** One diagram placed under the message whose call drew it, keyed by tool-call id. */
export interface DiagramPromptItem {
  ref: string;
  name: string;
  summary: string;
}

/**
 * One table, same shape and same place. Its own interface rather than a `kind` field on the one
 * above, because the two blocks are written under different wire keys (`<diagram>` / `<table>`,
 * `"diagrams"` / `"tables"`) and the prompt for a chunk holding only diagrams stays exactly what
 * it was — which is a pinned property of this file.
 */
export interface TablePromptItem {
  ref: string;
  name: string;
  summary: string;
}

export interface PromptInput {
  plan: PlanView | undefined;
  existing: ThreadRecord[];
  /** Last classified messages before this chunk, oldest first. */
  recent: ReadonlyArray<{ role: "user" | "assistant"; content: string }>;
  /** The e-number of the thread the `recent` tail ends in — what "continue" means. */
  currentThreadRef: string | undefined;
  turns: ThreadTurn[];
  /**
   * The diagrams the model is asked to place, keyed by the tool-call id that drew them.
   * Optional so a chunk with no diagrams produces a byte-identical prompt to before.
   */
  diagrams?: ReadonlyMap<string, DiagramPromptItem>;
  /** The tables the model is asked to place, keyed the same way. Absent produces the same
   *  prompt as before tables existed. */
  tables?: ReadonlyMap<string, TablePromptItem>;
}

/**
 * The classifier's system prompt, rendered from the catalog at call time.
 *
 * A function rather than a constant, and that is load-bearing: the catalog is patched by the
 * process entry point (`<dataRoot>/config.patch.json`), which runs *after* every module has been
 * evaluated. A module-level constant would be the bundled text forever, so a tuned prompt would
 * silently do nothing.
 */
export function threadSystemPrompt(): string {
  return renderPrompt("thread.system");
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max).trimEnd() + "…" : flat;
}

/** A model-given title, cleaned the same way conversation titles are. */
export function sanitizeThreadTitle(raw: string): string {
  let title = raw.trim();
  const firstLine = title.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  if (firstLine) title = firstLine;
  title = title
    .replace(/^["'“”‘’«]+|["'“”‘’»]+$/g, "")
    .replace(/[.。!！?？,，;；:：]+$/g, "")
    .trim();
  if (title.length > TITLE_CHARS) title = title.slice(0, TITLE_CHARS).trimEnd() + "…";
  return title;
}

/** Deterministic title for a thread the model would not name: the user's own opening words. */
function fallbackTitle(turn: ThreadTurn): string {
  const user = turn.messages.find((m) => m.role === "user");
  const source = (user?.content ?? turn.messages[0]?.content ?? "").trim();
  const flat = clip(source, 40);
  return flat || "…";
}

function toolNames(message: Message): string {
  const names = (message.toolCalls ?? []).map((c: ToolCall) => c.name).filter(Boolean);
  return names.length > 0 ? ` [tools: ${names.join(", ")}]` : "";
}

function renderTurn(
  message: Message,
  index: number,
  diagrams?: ReadonlyMap<string, DiagramPromptItem>,
  tables?: ReadonlyMap<string, TablePromptItem>
): string {
  const head = `${index + 1}. ${message.role}: ${clip(
    message.content || "(no text)",
    MAX_MESSAGE_CHARS
  )}${toolNames(message)}`;
  // The blocks sit under the message that drew them, inside <new_turns>, so the model sees a
  // diagram as part of its turn and the ref space is the prompt's own.
  const blocks: string[] = [];
  for (const call of message.toolCalls ?? []) {
    const diagram = diagrams?.get(call.id);
    if (diagram) {
      blocks.push(
        `   <diagram ref="${diagram.ref}" name="${diagram.name}">\n` +
          `   ${clip(diagram.summary, DIAGRAM_SUMMARY_CHARS_IN_PROMPT)}\n` +
          `   </diagram>`
      );
    }
    const table = tables?.get(call.id);
    if (table) {
      blocks.push(
        `   <table ref="${table.ref}" name="${table.name}">\n` +
          `   ${clip(table.summary, DIAGRAM_SUMMARY_CHARS_IN_PROMPT)}\n` +
          `   </table>`
      );
    }
  }
  return blocks.length > 0 ? [head, ...blocks].join("\n") : head;
}

export function buildThreadPrompt(input: PromptInput): string {
  const sections: string[] = [];

  if (input.plan) {
    const nodes = flatPlanNodes(input.plan);
    const lines: string[] = [];
    for (const { number, node } of nodes.values()) {
      const marker = node.status === "in_progress" ? "  ← current" : "";
      lines.push(`${number}. ${clip(node.title, 80)} [${node.status}]${marker}`);
    }
    sections.push(`<plan>\n${lines.join("\n")}\n</plan>`);
  } else {
    sections.push("<plan>\n(no plan yet — every turn is background)\n</plan>");
  }

  if (input.existing.length > 0) {
    const lines = input.existing.map((t, i) => {
      const where = t.branch === "plan" && t.planNodeId ? `plan node ${t.planNodeId}` : t.branch;
      return `e${i + 1}. [${where}] ${clip(t.title, 80)}`;
    });
    sections.push(`<existing_threads>\n${lines.join("\n")}\n</existing_threads>`);
  }

  if (input.recent.length > 0) {
    const lines = input.recent.map((m) => `- ${m.role}: ${clip(m.content || "(no text)", MAX_MESSAGE_CHARS)}`);
    const note = input.currentThreadRef
      ? ` ("continue" means thread ${input.currentThreadRef})`
      : "";
    sections.push(`<recently_classified>${note}\n${lines.join("\n")}\n</recently_classified>`);
  }

  const numbered = input.turns
    .flatMap((turn) => turn.messages)
    .map((m, i) => renderTurn(m, i, input.diagrams, input.tables));
  sections.push(
    `<new_turns>\n${numbered.join("\n")}\n</new_turns>\n\n` +
      `Classify the ${input.turns.length} turn(s). A turn is one user message with the assistant ` +
      `messages that follow it. Respond with the JSON object only.`
  );

  return sections.join("\n\n");
}

/* --------------------------------- parsing --------------------------------- */

export type ThreadDecision =
  | { kind: "continue" }
  | { kind: "existing"; ref: string }
  | { kind: "new"; branch: ThreadBranch; title: string; node?: string };

/**
 * The model's reply as an object, fence and surrounding prose stripped.
 *
 * Lives in `modelJson.ts` now that the insight pass needs the same treatment for an array: the
 * fence-and-bracket search is the part that must not be written twice, while what counts as a
 * *valid* answer stays here (the two parsers below disagree about how strict to be afterwards).
 */
const extractJsonObject = (raw: string): unknown | null => parseModelJson(raw, "object");

/**
 * Parse the model's turn-decision array. Returns null on ANY malformed answer — including a
 * count that does not match the turns, since that mismatch is the one failure that would
 * otherwise assign threads in the wrong order. The caller treats null as "leave unassigned".
 */
export function parseThreadDecisions(raw: string, expected: number): ThreadDecision[] | null {
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const decisions = (parsed as { decisions?: unknown }).decisions;
  if (!Array.isArray(decisions) || decisions.length !== expected) return null;

  const out: ThreadDecision[] = [];
  for (const item of decisions) {
    if (!item || typeof item !== "object") return null;
    const decision = item as { thread?: unknown; branch?: unknown; title?: unknown; node?: unknown };
    if (typeof decision.thread !== "string") return null;
    const thread = decision.thread.trim();

    if (thread === "continue") {
      out.push({ kind: "continue" });
    } else if (/^e\d+$/i.test(thread)) {
      out.push({ kind: "existing", ref: thread.toLowerCase() });
    } else if (thread === "new") {
      const branch: ThreadBranch = decision.branch === "plan" ? "plan" : "other";
      const title =
        typeof decision.title === "string" ? sanitizeThreadTitle(decision.title) : "";
      const node = typeof decision.node === "string" ? decision.node.trim() : undefined;
      out.push({ kind: "new", branch, title, node: node || undefined });
    } else {
      return null;
    }
  }
  return out;
}

/**
 * One artifact's placement — a diagram's or a table's: its own turn, or an existing thread.
 *
 * There is no "new" kind, and the reason is the same for both: an artifact has no messages of
 * its own, so a thread it started would hold nothing. It shares one type because the rule is one
 * rule; the two are kept apart in the prompt by their wire key and their ref prefix.
 */
export type ArtifactDecision =
  | { kind: "continue" }
  | { kind: "existing"; ref: string };

/** The name this had while diagrams were the only artifact. Kept so the diagram call sites read
 *  as what they are rather than as one case of a general mechanism. */
export type DiagramDecision = ArtifactDecision;

/**
 * Parse one of the optional artifact arrays (`diagrams` / `tables`). Deliberately permissive
 * where `parseThreadDecisions` is strict: the answer is a SECOND, ref-keyed array, so a
 * malformed entry can never shift a turn decision the way a wrong-length positional one would.
 * Unknown refs, duplicates, "new" and unparseable threads are dropped entry-by-entry — that
 * artifact then inherits its own turn's thread on write, which is the answer it would have got
 * most of the time. A missing/non-array field yields an empty map (every artifact collapses).
 */
export function parseDiagramDecisions(
  raw: string,
  allowedRefs: ReadonlySet<string>
): Map<string, DiagramDecision> {
  return parseRefDecisions(raw, "diagrams", allowedRefs);
}

/**
 * The same parse for tables: one implementation, two wire keys.
 *
 * Two keys rather than one array carrying a `kind` the model writes, and that is a decision
 * rather than a leftover from the diagram feature: a model-authored discriminant is a field the
 * model can get wrong, and this parser's whole permissiveness exists because per-entry failures
 * must be non-fatal. The ref prefix already *is* the discriminant — `d1` is a diagram, `t1` is a
 * table — so the answer needs no new field to be ambiguous about.
 */
export function parseTableDecisions(
  raw: string,
  allowedRefs: ReadonlySet<string>
): Map<string, DiagramDecision> {
  return parseRefDecisions(raw, "tables", allowedRefs);
}

function parseRefDecisions(
  raw: string,
  field: "diagrams" | "tables",
  allowedRefs: ReadonlySet<string>
): Map<string, ArtifactDecision> {
  const out = new Map<string, ArtifactDecision>();
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed !== "object") return out;
  const entries = (parsed as Record<string, unknown>)[field];
  if (!Array.isArray(entries)) return out;

  for (const item of entries) {
    if (!item || typeof item !== "object") continue;
    const entry = item as { ref?: unknown; thread?: unknown };
    if (typeof entry.ref !== "string" || typeof entry.thread !== "string") continue;
    const ref = entry.ref.trim();
    if (!allowedRefs.has(ref) || out.has(ref)) continue;
    const thread = entry.thread.trim();

    if (thread === "continue") {
      out.set(ref, { kind: "continue" });
    } else if (/^e\d+$/i.test(thread)) {
      out.set(ref, { kind: "existing", ref: thread.toLowerCase() });
    }
    // "new" and anything else: dropped. An artifact never opens a thread of its own.
  }
  return out;
}

/* ---------------------------------- sync ----------------------------------- */

/** The model call: system + human prompt in, raw text out. Implemented in `agent/threads.ts`. */
export type ThreadClassifier = (systemPrompt: string, userPrompt: string) => Promise<string>;

/** What kicked off a sync: the post-turn hook, or the panel/install-time POST route. */
export type ThreadSyncSource = "turn" | "sync";

export interface SyncResult {
  /** Turns classified by this call. */
  turns: number;
  /** Messages assigned to threads. */
  messages: number;
  /** Diagrams attached to a thread. */
  diagrams: number;
  /** Tables attached to a thread. */
  tables: number;
  /** Messages still unassigned afterwards (more chunks or a failure). */
  unassigned: number;
}

/**
 * One unit of classification work: the oldest ≤8 unassigned turns, one model call. Idempotent
 * — a no-op when nothing is unassigned — so the post-turn hook, a manual panel refresh and an
 * install-time backfill are the same call. Concurrent callers for one session join one
 * in-flight promise (the `refreshTokens` shape): two triggers at turn end must not create two
 * threads for the same turns.
 */
const inflight = new Map<string, Promise<SyncResult>>();

export function syncThreads(
  db: AppDb,
  sessionId: string,
  classify: ThreadClassifier,
  source: ThreadSyncSource = "turn",
  /** Which model the classifier calls — observation-log only. */
  model = ""
): Promise<SyncResult> {
  const joined = inflight.get(sessionId);
  if (joined) return joined;
  const run = runSync(db, sessionId, classify, source, model).finally(() => {
    inflight.delete(sessionId);
  });
  inflight.set(sessionId, run);
  return run;
}

/** A short turn label for the per-turn "判定" lines. */
function turnLabel(turn: ThreadTurn, index: number): string {
  const first = turn.messages.find((m) => m.role === "user") ?? turn.messages[0];
  return `轮次 ${index + 1}（${clip(first?.content ?? "", 30) || "(无文字)"}）`;
}

async function runSync(
  db: AppDb,
  sessionId: string,
  classify: ThreadClassifier,
  source: ThreadSyncSource,
  model: string
): Promise<SyncResult> {
  const pending = db.listPendingThreadMessages(sessionId, MAX_MESSAGES_PER_CHUNK);
  if (pending.length === 0) {
    return {
      turns: 0,
      messages: 0,
      diagrams: 0,
      tables: 0,
      unassigned: db.countPendingThreadMessages(sessionId),
    };
  }

  const totalPending = db.countPendingThreadMessages(sessionId);
  const allTurns = segmentTurns(pending);
  // Whole turns only. When the fetch window cut mid-turn (more messages exist than it
  // returned), leave the window's last turn for the next call so an exchange is never
  // half-assigned. A window that is one giant turn is classified anyway — deferring it would
  // starve forever; its tail later arrives as an assistant-first "continue" turn.
  const truncated = totalPending > pending.length;
  const turns: ThreadTurn[] = [];
  for (let i = 0; i < allTurns.length; i++) {
    if (turns.length >= MAX_TURNS_PER_SYNC) break;
    if (truncated && i === allTurns.length - 1 && allTurns.length > 1) break;
    turns.push(allTurns[i]!);
  }
  if (turns.length === 0) {
    return { turns: 0, messages: 0, diagrams: 0, tables: 0, unassigned: totalPending };
  }

  const plan = readCurrentPlan(db, sessionId);
  const planNodes = plan ? flatPlanNodes(plan) : new Map();
  const existing = db.listThreadsBySession(sessionId);
  const assignedMessages = db.listThreadMessagesBySession(sessionId);
  const recent = assignedMessages.slice(-RECENT_TAIL);
  const currentThreadId = assignedMessages.at(-1)?.threadId;
  let current = currentThreadId
    ? existing.find((t) => t.id === currentThreadId)
    : undefined;
  const currentIndex = currentThreadId
    ? existing.findIndex((t) => t.id === currentThreadId)
    : -1;
  const currentThreadRef = currentIndex >= 0 ? `e${currentIndex + 1}` : undefined;

  /*
   * Deterministic turns never reach the model: when a turn's own progress tool call names
   * a live plan node, its home is known. Only the remaining turns (background, digressions,
   * plain "继续") are sent for classification — one chapter lesson with a progress call used
   * to cost the model a 100-second reasoning run it had no business making.
   */
  const forcedNodeIds = turns.map((turn) => progressNodeForTurn(turn, planNodes));
  const modelTurns = turns
    .map((turn, i) => ({ turn, i }))
    .filter(({ i }) => !forcedNodeIds[i]);

  // Diagrams the pending turns drew, found by the call id on their row. One query for the
  // chunk; a revise moved the row's tool_call_id to the newest call and cleared its thread, so
  // matching here finds exactly the diagrams still unjudged.
  /**
   * The artifacts a turn produced, found by the call that produced them.
   *
   * One helper for both kinds, and that is not a tidiness: the *ordering* and the map lookup are
   * the whole of "which rows does this turn own", and two copies of that walk is two chances for
   * one kind to inherit a rule the other does not.
   */
  const artifactsOfTurn = <T extends { id: string }>(
    turn: ThreadTurn,
    toolName: string,
    byCallId: ReadonlyMap<string, T>
  ): T[] => {
    const found: T[] = [];
    for (const message of turn.messages) {
      for (const call of message.toolCalls ?? []) {
        if (call.name !== toolName) continue;
        const artifact = byCallId.get(call.id);
        if (artifact) found.push(artifact);
      }
    }
    return found;
  };

  const diagramByCallId = new Map<string, DiagramRecord>();
  for (const diagram of db.listDiagramsBySession(sessionId)) {
    if (diagram.toolCallId && diagram.threadId === null) {
      diagramByCallId.set(diagram.toolCallId, diagram);
    }
  }
  const diagramsOfTurn = (turn: ThreadTurn): DiagramRecord[] =>
    artifactsOfTurn(turn, DIAGRAM_TOOL_NAME, diagramByCallId);

  // The tables, the same work list built the same way: unjudged rows whose call is in this
  // chunk. `listTableBriefsBySession` rather than the full read, because the classifier is shown
  // a name and a summary and nothing here may look at the markdown.
  const tableByCallId = new Map<string, TableRecord>();
  for (const table of db.listTableBriefsBySession(sessionId)) {
    if (table.toolCallId && table.threadId === null) {
      tableByCallId.set(table.toolCallId, table);
    }
  }
  const tablesOfTurn = (turn: ThreadTurn): TableRecord[] =>
    artifactsOfTurn(turn, TABLE_TOOL_NAME, tableByCallId);

  // Refs d1.. for only the diagrams the model is asked about — those in turns it classifies.
  // A forced turn's diagrams never reach the prompt and ride the collapse rule instead. The
  // cap is a safety valve; diagrams past it also collapse, so none are stranded.
  /*
   * Refs `d1..` / `t1..` for only the artifacts the model is asked about — those in turns it
   * classifies. A forced turn's artifacts never reach the prompt and ride the collapse rule
   * instead, and that happens by *construction* here rather than by a second check: this is the
   * same loop for both kinds, over the same `modelTurns`, so a table cannot be placed by the
   * model while a diagram in the same turn is not, or the other way round. The caps are safety
   * valves; artifacts past one also collapse, so none are stranded.
   */
  const promptDiagrams = new Map<string, DiagramPromptItem>();
  const refByDiagram = new Map<string, string>();
  const promptTables = new Map<string, TablePromptItem>();
  const refByTable = new Map<string, string>();
  {
    let d = 0;
    let t = 0;
    for (const { turn } of modelTurns) {
      for (const diagram of diagramsOfTurn(turn)) {
        if (d >= MAX_DIAGRAMS_PER_PROMPT) break;
        d += 1;
        const ref = `d${d}`;
        if (diagram.toolCallId) {
          promptDiagrams.set(diagram.toolCallId, {
            ref,
            name: diagram.name,
            summary: diagram.summary,
          });
        }
        refByDiagram.set(diagram.id, ref);
      }
      for (const table of tablesOfTurn(turn)) {
        if (t >= MAX_TABLES_PER_PROMPT) break;
        t += 1;
        const ref = `t${t}`;
        if (table.toolCallId) {
          promptTables.set(table.toolCallId, {
            ref,
            name: table.name,
            summary: table.summary,
          });
        }
        refByTable.set(table.id, ref);
      }
    }
  }

  // Resolve "eN" against the list the model saw.
  const existingByRef = new Map(existing.map((t, i) => [`e${i + 1}`, t]));
  const numberToId = new Map<string, string>();
  if (plan) {
    for (const [id, { number }] of planNodes) numberToId.set(number, id);
  }

  // The observation log's shared context block, so a failure is debuggable from the same
  // information the model was given.
  const contextLines = (): string[] => {
    const lines: string[] = [];
    if (plan) {
      const currentId = currentPlanNode(plan);
      const currentNode = currentId ? planNodes.get(currentId) : undefined;
      lines.push(
        `计划：V${plan.version}（${plan.status}），${planNodes.size} 个节点` +
          (currentNode ? `，进行中 ${currentNode.number}「${clip(currentNode.node.title, 60)}」` : "")
      );
    } else {
      lines.push("计划：无");
    }
    if (existing.length > 0) {
      lines.push("已有脉络：");
      existing.forEach((t, i) => {
        const where =
          t.branch === "plan" && t.planNodeId
            ? `计划 ${planNodes.get(t.planNodeId)?.number ?? "?"}「${t.title}」`
            : `其他「${t.title}」`;
        lines.push(`  e${i + 1}. ${where}`);
      });
    } else {
      lines.push("已有脉络：无");
    }
    if (recent.length > 0) {
      lines.push(`最近已分类的消息（continue 指向 ${currentThreadRef ?? "—"}）：`);
      for (const m of recent) {
        lines.push(`  ${m.role}: ${clip(m.content || "(无文字)", MAX_MESSAGE_CHARS)}`);
      }
    }
    lines.push("本次轮次：");
    turns.forEach((turn, i) => {
      const forced = forcedNodeIds[i];
      const mark = forced
        ? `  → 由工具调用直接定位：计划 ${planNodes.get(forced)?.number ?? "?"}（无需模型）`
        : "";
      lines.push(`  ${turnLabel(turn, i)}${mark}`);
      for (const m of turn.messages) {
        lines.push(`    ${m.role}: ${clip(m.content || "(无文字)", MAX_MESSAGE_CHARS)}${toolNames(m)}`);
      }
      // What the model was shown about this turn's diagrams: name and the one-line summary.
      for (const diagram of diagramsOfTurn(turn)) {
        const ref = diagram.toolCallId ? refByDiagram.get(diagram.id) : undefined;
        lines.push(
          `    图${ref ? ` ${ref}` : ""}「${diagram.name}」：${clip(diagram.summary, DIAGRAM_SUMMARY_CHARS_IN_PROMPT)}`
        );
      }
    });
    return lines;
  };

  const startedAt = Date.now();
  const header = (): string[] => [
    "",
    `[${logTimestamp()}] 会话 ${sessionId} — ${
      source === "turn" ? "回合结束自动整理" : "面板/安装触发的同步"
    }`,
    `模型：${model || "(未知)"}｜待分类 ${totalPending} 条，本次处理 ${turns.length} 个轮次（${turns.reduce(
      (n, t) => n + t.messages.length,
      0
    )} 条消息），其中 ${modelTurns.length} 个需要模型判定`,
  ];

  // Ask the model only about the non-deterministic turns. A failed/empty/unusable answer
  // blocks just those: deterministic turns are still applied below, and the ambiguous ones
  // stay unassigned for the next sync — one model hiccup never stalls the whole backlog.
  let raw = "";
  let modelError: string | null = null;
  if (modelTurns.length > 0) {
    const prompt = buildThreadPrompt({
      plan,
      existing,
      recent,
      currentThreadRef,
      turns: modelTurns.map((m) => m.turn),
      diagrams: promptDiagrams,
      tables: promptTables,
    });
    try {
      raw = await classify(threadSystemPrompt(), prompt);
    } catch (err) {
      modelError = `${Date.now() - startedAt} ms：${err instanceof Error ? err.message : String(err)}`;
    }
  }
  // With zero model turns nothing was called: an empty answer is expected, not a failure.
  const parsed = modelError || modelTurns.length === 0 ? null : parseThreadDecisions(raw, modelTurns.length);
  if (modelTurns.length > 0 && !modelError && !parsed && raw.trim().length === 0) {
    modelError = `${Date.now() - startedAt} ms：模型返回为空（输出预算被思考链耗尽）`;
  } else if (modelTurns.length > 0 && !modelError && !parsed) {
    modelError = `模型返回无法解析（需要恰好 ${modelTurns.length} 个判定），原始返回：${
      clip(raw.trim(), 1_000) || "(空)"
    }`;
  }
  const decisionsByTurn = new Map<number, ThreadDecision>();
  parsed?.forEach((decision, j) => decisionsByTurn.set(modelTurns[j]!.i, decision));

  // The diagram answer never makes a turn fail: a missing/malformed entry simply leaves that
  // diagram to the collapse rule. Parsed even when a model call happened but the turn
  // decisions were unusable, because it is keyed independently by ref.
  const diagramDecisions =
    modelTurns.length > 0
      ? parseDiagramDecisions(raw, new Set([...promptDiagrams.values()].map((d) => d.ref)))
      : new Map<string, ArtifactDecision>();
  // Parsed independently, for the reason the two arrays exist at all: a malformed table entry
  // cannot touch a diagram's placement or a turn's, and vice versa.
  const tableDecisions =
    modelTurns.length > 0
      ? parseTableDecisions(raw, new Set([...promptTables.values()].map((t) => t.ref)))
      : new Map<string, ArtifactDecision>();

  let assigned = 0;
  let diagramsAssigned = 0;
  let tablesAssigned = 0;
  /** Human-readable per-turn resolution lines, collected inside the transaction. */
  const actions: string[] = [];
  const skipped: string[] = [];

  const writes = (): void => {
    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i]!;
      const messageIds = turn.messages.map((m) => m.id);
      const forcedNodeId = forcedNodeIds[i];
      const decision = decisionsByTurn.get(i);

      // Deterministic precedence: a turn whose own tool call moved the plan follows that node;
      // it never needed the model. Turns the model could not decide are left unassigned.
      if (!forcedNodeId && !decision) {
        skipped.push(`  ${turnLabel(turn, i)} → 保持未分类，等下次同步重试`);
        continue;
      }

      let thread: ThreadRecord | undefined;
      let outcome: string;
      // The guard above left a decision for every non-forced turn.
      const dec: ThreadDecision = decision!;
      if (forcedNodeId) {
        thread = ensurePlanThread(db, sessionId, forcedNodeId, planNodes);
        const number = planNodes.get(forcedNodeId)?.number ?? "?";
        outcome = `归入计划 ${number}「${thread.title}」（工具调用直接定位，无需模型）`;
      } else if (dec.kind === "existing") {
        // A ref that no longer resolves continues the live thread; with neither, the turn
        // starts its own "other" thread — resolution must always land so later turns keep a
        // tail to attach to.
        const target = existingByRef.get(dec.ref);
        thread = target ?? current ?? createOtherThread(db, sessionId, fallbackTitle(turn));
        outcome =
          target === thread
            ? `追加到已有脉络 ${dec.ref}「${thread.title}」`
            : `模型指向 ${dec.ref} 但已失效，改为${target === undefined && current ? "延续当前脉络" : "新建脉络"}「${thread.title}」`;
      } else if (dec.kind === "new") {
        if (dec.branch === "plan" && plan) {
          const nodeId =
            (dec.node ? numberToId.get(dec.node) : undefined) ?? currentPlanNode(plan);
          if (nodeId) {
            thread = ensurePlanThread(db, sessionId, nodeId, planNodes);
            outcome = `新建/归入计划脉络 ${planNodes.get(nodeId)?.number ?? "?"}「${thread.title}」`;
          } else {
            thread = createOtherThread(db, sessionId, dec.title || fallbackTitle(turn));
            outcome = "模型判定为计划脉络但没有可对应的节点，新建「其他」脉络「" + thread.title + "」";
          }
        } else {
          thread = createOtherThread(
            db,
            sessionId,
            dec.kind === "new" ? dec.title || fallbackTitle(turn) : fallbackTitle(turn)
          );
          outcome = `新建「其他」脉络「${thread.title}」`;
        }
      } else {
        // "continue": the thread of the recent tail / previous turn; with nowhere to continue
        // to, this background turn starts an "other" thread of its own.
        const startedHere = !current;
        thread = current ?? createOtherThread(db, sessionId, fallbackTitle(turn));
        outcome = startedHere
          ? `没有可延续的脉络，新建「其他」脉络「${thread.title}」`
          : `延续当前脉络「${thread.title}」`;
      }

      assigned += db.assignMessagesToThread(sessionId, messageIds, thread.id);
      current = thread;
      actions.push(`  ${turnLabel(turn, i)} → ${outcome}（${messageIds.length} 条消息）`);

      /*
       * The turn's artifacts land in the same thread unless the answer named an existing one.
       * Unanswered (and forced-turn) ones collapse to this turn's thread rather than staying
       * null — the work list is pending messages, so a turn already assigned is never revisited.
       * The `thread_id IS NULL` guard in each accessor keeps this idempotent.
       *
       * One helper for both kinds, so the collapse rule cannot hold for a diagram and fail for a
       * table: it is the same rule, and the two calls differ only in what they hand it.
       */
      const placedDiagrams = placeArtifacts({
        items: diagramsOfTurn(turn),
        refs: refByDiagram,
        decisions: diagramDecisions,
        thread,
        existingByRef,
        assign: (id, threadId) => db.assignDiagramToThread(sessionId, id, threadId),
        label: "图",
      });
      diagramsAssigned += placedDiagrams.assigned;
      actions.push(...placedDiagrams.lines);

      const placedTables = placeArtifacts({
        items: tablesOfTurn(turn),
        refs: refByTable,
        decisions: tableDecisions,
        thread,
        existingByRef,
        assign: (id, threadId) => db.assignTableToThread(sessionId, id, threadId),
        label: "表",
      });
      tablesAssigned += placedTables.assigned;
      actions.push(...placedTables.lines);
    }
  };
  db.raw.transaction(writes)();

  const unassigned = db.countPendingThreadMessages(sessionId);
  if (modelError) {
    modelLog("threads", () =>
      [
        ...header(),
        ...contextLines(),
        `✗ 模型判定失败（${modelError}）`,
        `确定性轮次照常归入；${modelTurns.length} 个需要判定的轮次保持未分类，将在下个回合或下次同步时重试。`,
        "判定：",
        ...actions,
        ...skipped,
        `结果：${assigned} 条消息、${diagramsAssigned} 张图、${tablesAssigned} 张表归入脉络，剩余未分类 ${unassigned} 条，耗时 ${
          Date.now() - startedAt
        } ms`,
      ].join("\n") + "\n"
    );
  } else {
    modelLog("threads", () =>
      [
        ...header(),
        ...contextLines(),
        ...(modelTurns.length > 0
          ? ["模型原始返回：", clip(raw.trim(), 2_000)]
          : ["模型调用：跳过（所有轮次均可由计划工具调用直接定位）"]),
        "判定：",
        ...actions,
        `结果：${assigned} 条消息、${diagramsAssigned} 张图、${tablesAssigned} 张表归入脉络，剩余未分类 ${unassigned} 条，耗时 ${
          Date.now() - startedAt
        } ms`,
      ].join("\n") + "\n"
    );
  }

  return {
    turns: turns.length,
    messages: assigned,
    diagrams: diagramsAssigned,
    tables: tablesAssigned,
    unassigned,
  };
}

/**
 * Place one turn's artifacts, and describe what happened for the log.
 *
 * A free function rather than a closure inside `runThreadSync`, because it needs nothing from the
 * sync but its arguments — and it is the one place the *collapse* rule lives, which is the rule
 * that matters: an artifact the model did not answer for, or answered with a stale `eN` for,
 * lands in its own turn's thread. Leaving it null would strand it, since the work list is pending
 * messages and a turn already assigned is never revisited.
 */
function placeArtifacts(input: {
  items: readonly { id: string; name: string; toolCallId: string | null }[];
  refs: ReadonlyMap<string, string>;
  decisions: ReadonlyMap<string, ArtifactDecision>;
  thread: ThreadRecord;
  /** What an `eN` answer resolves against. Required: a caller that omitted it would silently
   *  collapse every model-named placement, which is a failure nothing would report. */
  existingByRef: ReadonlyMap<string, ThreadRecord>;
  assign: (itemId: string, threadId: string) => number;
  label: string;
}): { assigned: number; lines: string[] } {
  let assigned = 0;
  const lines: string[] = [];
  for (const item of input.items) {
    let target = input.thread;
    let byModel = false;
    const ref = item.toolCallId ? input.refs.get(item.id) : undefined;
    const decision = ref ? input.decisions.get(ref) : undefined;
    if (decision?.kind === "existing") {
      const named = input.existingByRef.get(decision.ref);
      if (named) {
        target = named;
        byModel = true;
      }
      // A stale e-number falls back to the turn's thread, like a stale turn decision.
    }
    assigned += input.assign(item.id, target.id);
    lines.push(
      `    ${input.label}「${item.name}」→「${target.title}」${byModel ? "（模型指定）" : "（随本回合）"}`
    );
  }
  return { assigned, lines };
}

function ensurePlanThread(
  db: AppDb,
  sessionId: string,
  nodeId: string,
  nodes: Map<string, { number: string; node: PlanTreeNode }>
): ThreadRecord {
  const found = db.getThreadByPlanNode(sessionId, nodeId);
  if (found) return found;
  const title = nodes.get(nodeId)?.node.title ?? nodeId;
  return db.insertThread({ id: newId(), sessionId, branch: "plan", title, planNodeId: nodeId });
}

function createOtherThread(db: AppDb, sessionId: string, title: string): ThreadRecord {
  return db.insertThread({ id: newId(), sessionId, branch: "other", title });
}

/* ---------------------------------- views ---------------------------------- */

function previewOf(message: { content: string }): string {
  const flat = message.content.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  return flat.length > PREVIEW_CHARS ? flat.slice(0, PREVIEW_CHARS).trimEnd() + "…" : flat;
}

/** The panel's read model: threads with their one-line message leaves, plus the backlog count. */
export function buildThreadViews(
  db: AppDb,
  userId: string,
  sessionId: string
): GetSessionThreadsResponse {
  const records = db.listThreadsForUser(userId, sessionId);
  const messages = db.listThreadMessagesForUser(userId, sessionId);

  const byThread = new Map<string, ThreadMessageView[]>();
  for (const message of messages) {
    const list = byThread.get(message.threadId) ?? [];
    list.push({
      id: message.id,
      role: message.role,
      preview: previewOf(message),
      content: message.content,
      createdAt: message.createdAt,
    });
    byThread.set(message.threadId, list);
  }

  const threads: ThreadView[] = records.map((record) => ({
    id: record.id,
    branch: record.branch,
    title: record.title,
    ...(record.planNodeId ? { planNodeId: record.planNodeId } : {}),
    messages: byThread.get(record.id) ?? [],
  }));

  return {
    threads,
    unassigned: db.countPendingThreadMessagesForUser(userId, sessionId),
  };
}
