import {
  AIMessage,
  AIMessageChunk,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import {
  QUIZ_REVIEW_TOOL_NAME,
  TABLE_TOOL_NAME,
  QUIZ_TOOL_NAME,
  type Attachment,
  type ChatStreamEvent,
  type FileLocation,
  type Message,
  type MessageUsage,
  type SessionSettings,
  type ToolCall,
  type Workspace,
} from "@ilearnassist/shared";
import type { ProviderRecord } from "../db.js";
import { renderPrompt } from "../prompts.js";
import type { UserLayout } from "../paths.js";
import { buildUserContent, type UserContentBlock } from "../attachments.js";
import type { ResolvedReference } from "../turnReferences.js";
import { Suspension } from "../tools/suspension.js";
import { redactQuizInput } from "../tools/quiz.js";
import type { TurnClock } from "./clock.js";
import { buildModel } from "./model.js";

/** Fallback ReAct step budget when a session does not set one. */
const DEFAULT_MAX_STEPS = 15;

/**
 * Persisted into the conversation when the step budget runs out, so the model on the next
 * turn knows it was cut off. Untranslated like the `⚠️ ` prefix: it is content that is
 * replayed into history, not chrome.
 */
const OUT_OF_STEPS =
  "The assistant ran out of steps while working on this task. Please ask a follow-up to continue.";

export interface RunAgentResult {
  content: string;
  /** Chain of thought, when the provider exposed one. Display-only. */
  reasoning: string;
  toolCalls: ToolCall[];
  usage: MessageUsage;
  /**
   * True when the turn stopped early because the model called `ask_user`.
   *
   * The call is in `toolCalls` with `status: "awaiting"` and **no `output`**, which is
   * what keeps it out of history until the user answers (see `buildHistoryMessages`).
   * Callers persist the message and close the stream; the turn resumes from the answers
   * route, as a fresh run whose history already ends in the matching tool result.
   */
  awaiting: boolean;
  /**
   * The turn was cut short by `signal` rather than finishing. `content` holds only what
   * had streamed by then — possibly nothing — and `usage` is empty, because a half-step
   * cannot be billed to the context.
   *
   * Mutually exclusive with `awaiting`: a suspension only ends a step whose stream ran to
   * completion, and that step breaks the loop, so there is no later step for an abort to
   * interrupt.
   */
  stopped?: boolean;
}

export interface RunAgentInput {
  /** Undefined when the resolved provider no longer exists — `buildModel` rejects it. */
  provider: ProviderRecord | undefined;
  modelId: string;
  workspace: Workspace;
  /**
   * The conversation's own system prompt. Empty falls back to the built-in assistant text.
   *
   * A Copilot is deliberately not passed: the session copied everything a Copilot contributes
   * when it was created, so consulting the Copilot here is what used to make editing one rewrite
   * every conversation using it.
   */
  systemPrompt: string;
  /** Resolved per-session generation parameters (temperature, maxSteps, …). */
  settings: SessionSettings;
  /**
   * What time it is where the user is. Required rather than defaulted here: `agent/clock.ts`
   * needs the browser's zone to be right about anything but the server's own, and a call site
   * that forgot to pass one would be a turn with a subtly wrong clock rather than an error.
   */
  clock: TurnClock;
  /**
   * Extra system-prompt guidance for turns in a conversation with the plan widget
   * installed; absent in every other conversation.
   */
  planGuidance?: string;
  /** The same mechanism for the quiz widget: judge/record answers and recognise make-ups. */
  quizGuidance?: string;
  /**
   * The same mechanism again for keeping a web page, on turns where `ila_collect_page` is
   * assembled — the tool exists in every conversation with web fetching on, and this is what
   * says when to reach for it.
   */
  collectPageGuidance?: string;
  /** `ila_table`'s positive half — see `tableGuidance`. */
  tableGuidance?: string;
  /**
   * What the user opened to this conversation with `@`, on turns where `ila_explore` is
   * assembled. Absent on every ordinary conversation, and it does more than add a paragraph —
   * see `SystemPromptInput.exploreGuidance`.
   */
  exploreGuidance?: string;
  /**
   * The quiz make-up turn's grading key, appended to THIS turn's system prompt only: the
   * question's reference answer and explanation, which never travel to the client. Absent
   * on every ordinary turn.
   */
  quizMakeupNote?: string;
  /** The account's own description of itself — see `SystemPromptInput.about`. */
  about?: string;
  /**
   * What this turn's own message pointed at — the 追问 chips, resolved by the caller.
   *
   * Absent on every ordinary turn. Separate from `historicalReferences` because the live user
   * message is not yet in `history` — the route reads history *before* persisting the new turn, so
   * it isn't replayed twice — and the two therefore have no shared key to be found under.
   */
  references?: readonly ResolvedReference[];
  /**
   * The stored references of every earlier message that has any, by message id.
   *
   * Built by the caller exactly as `sourcePaths` is, and for the same reason: resolving one is a
   * database read, and both places below build user content — the live turn and every replayed
   * one — would otherwise repeat it per message. Replayed rather than skipped, because
   * `/regenerate` rebuilds a turn from history and would otherwise lose what it was about.
   */
  historicalReferences?: ReadonlyMap<string, readonly ResolvedReference[]>;
  /** Whose sources tree the attachment bytes live in. Derived per request, never held. */
  user: UserLayout;
  sessionId: string;
  /**
   * The conversation's own directory, named in the prompt so the model can see both of the
   * folders it may write into. Derived the same way `turnContext` derives it for the file
   * tools, and passed rather than recomputed because the prompt and the tools disagreeing
   * about a path is a model that writes somewhere it was not told about.
   */
  sessionDirPath: string;
  /** Where an unqualified write goes, resolved down the settings chain before the turn. */
  writeLocation: FileLocation;
  /**
   * The filesystem path of every source this run might read, by id.
   *
   * Built by the caller because resolving one is a database read plus a sandbox check, and both
   * callers of `buildUserContent` in here — the live turn and every replayed one — would
   * otherwise repeat it per message. An id absent from the map falls back to the upload
   * derivation, which is what an attachment has always been.
   *
   * It has to cover *history* as well as this turn: a file referenced three turns ago is
   * replayed on every turn after it, and its path is not derivable from its id.
   */
  sourcePaths?: ReadonlyMap<string, string>;
  /** Whether the selected model accepts image input. */
  vision: boolean;
  /**
   * Whether the selected model can call tools. Used only to decide how to explain a
   * truncated document: pointing a model at `read_document` when it cannot call tools
   * would leave it believing the rest of the file is retrievable when it is not.
   */
  toolUse: boolean;
  /** Prior persisted user/assistant messages (oldest first). */
  history: Message[];
  /**
   * The new user turn, or `null` when resuming a suspended `ask_user` call.
   *
   * A resumed run has nothing for the user to have typed: its history already ends in the
   * assistant's `tool_calls` block followed by the matching tool result, which is a valid
   * request on its own. Appending a synthetic `HumanMessage` there would have to say
   * *something*, and anything it said would be words the user never wrote.
   */
  userMessage: string | null;
  attachments?: Attachment[];
  tools: StructuredToolInterface[];
  onEvent: (event: ChatStreamEvent) => void;
  /**
   * A tool call the model made resolved without throwing, handed the tool's name.
   *
   * Called **before** the `tool_end` event for that call, and the ordering is the contract: the
   * one consumer installs the widget a tool belongs to (`installWidgetForToolUse`), and a client
   * that reacts to `tool_end` by re-reading the conversation's widgets must find the install
   * already written.
   *
   * A call that threw reports nothing. A suspension is not a call that committed anything, and
   * neither is a validation error — both land in the catch arms below.
   */
  onToolUsed?: (toolName: string) => void;
  /**
   * Aborts the turn: the in-flight provider request and any running tool see it, so a
   * stop costs no further tokens. Aborting is not an error — the call resolves with
   * `stopped: true` and whatever text had already streamed.
   */
  signal?: AbortSignal;
}

/** Content-block types that carry chain-of-thought rather than the answer. */
const REASONING_BLOCK_TYPES = new Set(["reasoning", "thinking", "reasoning_content"]);

function isReasoningBlock(block: object): boolean {
  const type = (block as { type?: unknown }).type;
  return typeof type === "string" && REASONING_BLOCK_TYPES.has(type);
}

/**
 * Turn a chunk's `content` (string OR complex content blocks) into the *answer* text.
 * Reasoning blocks are skipped: providers that surface chain-of-thought as a content
 * block would otherwise have it concatenated straight into the visible reply.
 */
function chunkText(chunk: AIMessageChunk): string {
  const c = chunk.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((block) => {
        if (typeof block === "string") return block;
        if (
          block &&
          typeof block === "object" &&
          !isReasoningBlock(block) &&
          "text" in block &&
          typeof block.text === "string"
        ) {
          return block.text;
        }
        return "";
      })
      .join("");
  }
  return "";
}

/**
 * Pull chain-of-thought out of a chunk when it arrives as a **content block**
 * (`reasoning` / `thinking` / `reasoning_content`), which some providers use instead of
 * a delta field.
 *
 * Deliberately does NOT read `additional_kwargs`: as of `@langchain/openai` 1.5.x the
 * parser does surface `reasoning_content` there, and `createReasoningFetch` already
 * reports every delta-bearing key off the raw wire. Reading both would emit each
 * reasoning delta twice — once from the tap, once from here — and double what gets
 * persisted on the message. The tap is the single source of truth for those fields;
 * this function only catches the block-shaped variant the tap cannot see.
 */
function chunkReasoning(chunk: AIMessageChunk): string {
  const parts: string[] = [];

  const c = chunk.content;
  if (Array.isArray(c)) {
    for (const block of c) {
      if (!block || typeof block !== "object" || !isReasoningBlock(block)) continue;
      const b = block as Record<string, unknown>;
      for (const key of ["reasoning", "thinking", "text", "reasoning_content"]) {
        const value = b[key];
        if (typeof value === "string" && value) {
          parts.push(value);
          break;
        }
      }
    }
  }

  return parts.join("");
}

function safeParseArgs(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * The prompt, as one object rather than five positional arguments.
 *
 * It was four optional strings appended in a fixed order; a fifth is where a caller starts
 * passing them in the wrong order and nothing complains, because they are all `string`. The
 * named form costs a few lines at three call sites and makes the next addition free.
 */
export interface SystemPromptInput {
  workspace: Workspace;
  /**
   * What time it is where the user is, as of this turn.
   *
   * An input rather than a `new Date()` call inside, so the prompt's wording is testable at a
   * pinned instant and so "the turn's clock" has one definition — `agent/clock.ts`.
   */
  clock: TurnClock;
  /** The conversation's own directory: `<workspaceRoot>/sessions/<sessionId>`. */
  sessionDirPath: string;
  /** Where an unqualified write goes, already resolved down the settings chain. */
  writeLocation: FileLocation;
  persona: string;
  /**
   * The account's own description of itself, or `""` when it has not written one.
   *
   * A property of the *user*, not of the conversation, which is why it arrives from the route
   * rather than from the session: changing it changes every conversation at once, which is what
   * "in my profile" means to the person who wrote it.
   */
  about?: string;
  planGuidance?: string;
  quizGuidance?: string;
  collectPageGuidance?: string;
  /** `ila_table`'s positive half — see `tableGuidance`. */
  tableGuidance?: string;
  /**
   * What the user has opened to this conversation with `@`.
   *
   * Its **presence** is the switch, the `collectPageGuidance` rule: the route asks the assembled
   * tool array, so a Copilot whose allow-list excludes the tool is never told about a call it
   * cannot make. It also changes one sentence of the workspace note below, because a model told
   * to read across workspaces while being told to never read outside two folders has been given
   * two instructions and will follow the louder one.
   */
  exploreGuidance?: string;
  quizMakeupNote?: string;
}

/**
 * The turn's system prompt: the catalog's skeleton, with each block rendered into it.
 *
 * The **text** is all in `prompts.json` — `chat.system` is the skeleton, and each `{{name}}` in it
 * is another entry in that file. This function holds only the **conditions**: which blocks apply
 * to this turn, and which of the two sandbox sentences the workspace block gets. That split is the
 * whole point — a reader can see and reorder the entire prompt without opening this file, and a
 * deployment can rewrite any block through `<dataRoot>/config.patch.json` without a rebuild.
 *
 * Two rules worth knowing when editing either side:
 *
 * - **A block is prefixed with its own blank line here, not in the catalog.** A patch written by
 *   hand is then plain prose with no separator to remember, and an absent block takes its
 *   separator with it — which is what keeps a turn with no widgets byte-identical to one written
 *   with the blocks inline.
 * - **A block's condition is never in the catalog**, because a catalog entry is text and a
 *   condition is not. The clock's unconditional presence, for instance, is deliberate rather than
 *   incidental: the failure it fixes is a model that does not know it should have asked for the
 *   date, so it cannot be conditioned on the question being about time.
 */
export function buildSystemPrompt(input: SystemPromptInput): string {
  /** A block, with the blank line that separates it from whatever precedes it. */
  const block = (text: string | undefined): string => (text ? `\n\n${text}` : "");

  // The session's own prompt when it has one, the catalog's default persona otherwise.
  const persona = input.persona.trim() || renderPrompt("chat.system.persona");

  /*
   * Who the learner is, when they have said. Placed here rather than at the end with the other
   * optional blocks: who the assistant is and who the person is belong together, and both come
   * before facts about the world. The block is fenced and labelled in the catalog — the text is
   * the user's own, so a sentence in it that reads like a command has to arrive as something they
   * wrote rather than as an instruction.
   */
  const about = block(input.about ? renderPrompt("chat.system.about", { about: input.about }) : "");

  const clock = block(
    renderPrompt("chat.system.clock", { local: input.clock.local, zone: input.clock.zone })
  );

  /*
   * The sandbox sentence changes when the user has opened other workspaces, and it changes by
   * *half*: the read prohibition stops being true, the write one does not. A sentence that simply
   * vanished would read as "the sandbox is gone", and one left alone would have the model refusing
   * a tool it was just handed — so the pair is stated together and explicitly, which is the only
   * form that cannot be read as either. Both variants are catalog entries; the *choice* is here.
   */
  const rule = renderPrompt(
    input.exploreGuidance !== undefined ? "chat.system.grantedRead" : "chat.system.noEscape"
  );
  const workspace = block(
    renderPrompt("chat.system.workspace", {
      workdirPath: input.workspace.workdirPath,
      sessionDirPath: input.sessionDirPath,
      writeLocation:
        input.writeLocation === "workspace" ? "shared workspace folder" : "conversation folder",
      rule,
    })
  );

  // The plan block is present while the plan widget is installed, whether or not a plan exists
  // yet — the rhythm starts the moment one is made. The quiz block's switch is installation too.
  // The next three are not widgets: their switch is whether the *tool* survived assembly, which
  // is what "an installation with web fetching off" looks like from here.
  const plan = block(input.planGuidance);
  const quiz = block(input.quizGuidance);
  const collectPage = block(input.collectPageGuidance);
  const table = block(input.tableGuidance);
  // The `@` grant, which qualifies the workspace block above it.
  const explore = block(input.exploreGuidance);
  // One make-up turn's answer key, last: the most specific instruction in the prompt.
  const makeup = block(input.quizMakeupNote);

  return renderPrompt("chat.system", {
    persona,
    about,
    clock,
    workspace,
    plan,
    quiz,
    collectPage,
    table,
    explore,
    makeup,
  });
}

/**
 * Rebuild prior turns into LangChain messages.
 *
 * Assistant messages that completed tool calls are replayed *with* those calls and their
 * `ToolMessage` results, so the model keeps the thread of earlier tool use. (Dropping them
 * previously left the model reasoning about a tool result it could no longer see.)
 * Only calls with a recorded output are replayed — OpenAI rejects a `tool_calls` block
 * whose results are missing.
 */
async function buildHistoryMessages(
  input: RunAgentInput,
  history: Message[]
): Promise<{ messages: BaseMessage[]; reasoningByToolCall: Map<string, string> }> {
  const out: BaseMessage[] = [];
  /**
   * Chain of thought for each replayed tool-call message, keyed by its first tool call's
   * id. LangChain will not carry it (see `withReplayedReasoning`), so it leaves the run
   * through this side channel and is put back on the wire by the fetch wrapper.
   */
  const reasoningByToolCall = new Map<string, string>();

  for (const m of history) {
    if (m.role === "user") {
      /*
       * References are replayed with attachments, because to the model the two are the same
       * thing: material this turn is about. They are two columns rather than one so the *chips*
       * can say which is which — a file the user uploaded for this turn, or one they pointed
       * at — and that distinction is the client's, not the model's.
       */
      const content = await buildUserContent(
        m.content,
        [...(m.attachments ?? []), ...(m.sources ?? [])],
        {
          user: input.user,
          vision: input.vision,
          toolUse: input.toolUse,
          sourcePaths: input.sourcePaths,
          // Resolved by the caller from the message's stored refs — see the field's note. A turn
          // that pointed at a diagram is rebuilt with that pointer in it, which is the whole
          // reason `/regenerate` can ask the same question twice.
          references: input.historicalReferences?.get(m.id),
        }
      );
      out.push(new HumanMessage(content as string | UserContentBlock[]));
      continue;
    }

    const completed = (m.toolCalls ?? []).filter((tc) => typeof tc.output === "string");
    if (completed.length === 0) {
      out.push(new AIMessage(m.content));
      continue;
    }

    // Recorded whether or not this message has reasoning of its own: a thinking-mode
    // provider wants the field *present* on a tool-call message, and an empty string is a
    // value it sends itself, so "none recorded" is a value to replay rather than a reason
    // to skip it.
    reasoningByToolCall.set(completed[0]!.id, m.reasoning ?? "");

    out.push(
      new AIMessage({
        content: m.content,
        tool_calls: completed.map((tc) => ({
          id: tc.id,
          name: tc.name,
          args: safeParseArgs(tc.input),
          type: "tool_call" as const,
        })),
      })
    );
    for (const tc of completed) {
      out.push(new ToolMessage({ tool_call_id: tc.id, name: tc.name, content: tc.output as string }));
    }
  }

  return { messages: out, reasoningByToolCall };
}

/**
 * Trim history to the session's `maxContextMessages`, measured in messages. After slicing
 * we drop any leading assistant message so the window always opens on a user turn.
 */
/**
 * Whether the configured model declares chain of thought.
 *
 * The gate on replaying `reasoning_content` (see `withReplayedReasoning`): only a model
 * that uses the field can need it back, and a provider that never used it must never be
 * sent it. Read from the model record rather than sniffed from the base URL, so the user's
 * own configuration is what decides.
 */
function isReasoningModel(provider: ProviderRecord | undefined, modelId: string): boolean {
  const id = modelId || provider?.models[0]?.modelId;
  return !!provider?.models.find((m) => m.modelId === id)?.capabilities.includes("reasoning");
}

function trimHistory(history: Message[], settings: SessionSettings): Message[] {
  const max = settings.maxContextMessages;
  if (!max || max <= 0 || history.length <= max) return history;
  let trimmed = history.slice(-max);
  let i = 0;
  while (i < trimmed.length && trimmed[i]!.role !== "user") i++;
  trimmed = trimmed.slice(i);
  return trimmed;
}

/**
 * The tools whose artifact **is the text the model streams beside the call**.
 *
 * The distinction the persistence rule turns on. Text beside an ordinary tool call is narration —
 * "I will write that file now" — and replacing it with the final step's answer is what keeps a
 * message to one utterance. These two are the other case, and each is the other case for its own
 * reason that lands in the same place:
 *
 * - `ila_review_quiz` streams the per-question verdict walkthrough, which *is* the turn's answer.
 * - `ila_table` renders nothing at all. Its whole contract is that the table is written into the
 *   reply as ordinary Markdown, so the prose beside the call is the artifact — and the step after
 *   it is typically a closing question ("需要展开哪一项？"), which used to replace the table
 *   wholesale. The table streamed live and then vanished at `message_done`, which is the one
 *   thing the feature exists to prevent.
 *
 * Deliberately **not** `ila_diagram`, and the difference is the same one: a diagram's artifact is
 * the drawing, rendered from the tool call itself, so its prose really is narration.
 *
 * The exception is the utterance *beside* the call, and that is as far as it goes: a table written
 * in an earlier step that made no call is narration by the general rule and is dropped with it.
 * That ordering is the one the guidance rules out — it tells the model to record the table it is
 * writing — and `ila_table`'s own result covers the remainder by asking for the inline copy "if you
 * have not already", so the model is told rather than the loop guessing. The second layer is not a
 * substitute for the first: this rule is what makes the shape a real model produces deterministic.
 */
const ANSWER_BEARING_TOOLS: ReadonlySet<string> = new Set([QUIZ_REVIEW_TOOL_NAME, TABLE_TOOL_NAME]);

/**
 * Put the utterances that carried an answer back in front of the turn's last utterance.
 *
 * An utterance the last step already repeats verbatim is dropped rather than shown twice; with
 * nothing preserved this is the identity function, so every other turn keeps the last-utterance
 * rule exactly.
 */
function composeWithAnswerUtterances(answerUtterances: string[], last: string): string {
  const prior = answerUtterances.filter((u) => u.trim() && !last.includes(u));
  if (prior.length === 0) return last;
  return last.trim() ? `${prior.join("\n\n")}\n\n${last}` : prior.join("\n\n");
}

/**
 * A basic, bounded ReAct agent loop over LangChain primitives:
 *   model/stream (token streaming) -> tool calls -> tool execution -> repeat.
 * Emits `text`, `tool_start` and `tool_end` events as it runs, then a final `usage` event.
 */
export async function runAgentStream(input: RunAgentInput): Promise<RunAgentResult> {
  let reasoning = "";

  // Rebuilt first: the reasoning it collects has to be in the model's hands before the
  // first request goes out, because only the fetch wrapper can put it on the wire.
  const { messages: history, reasoningByToolCall } = await buildHistoryMessages(
    input,
    trimHistory(input.history, input.settings)
  );

  // Chain of thought is read off the raw SSE frames (see `createReasoningFetch`) because
  // LangChain discards `reasoning_content` while parsing.
  const { llm, modelId } = buildModel(input.provider, input.modelId, input.settings, {
    onReasoning: (delta) => {
      reasoning += delta;
      input.onEvent({ type: "reasoning", delta });
    },
    // Only for a model that declares chain of thought. A provider that never used
    // `reasoning_content` must never be sent it.
    ...(isReasoningModel(input.provider, input.modelId)
      ? { replayReasoning: reasoningByToolCall }
      : {}),
  });
  const modelWithTools = llm.bindTools(input.tools);
  const maxSteps = input.settings.maxSteps ?? DEFAULT_MAX_STEPS;

  const messages: BaseMessage[] = [
    new SystemMessage(
      buildSystemPrompt({
        workspace: input.workspace,
        clock: input.clock,
        sessionDirPath: input.sessionDirPath,
        writeLocation: input.writeLocation,
        persona: input.systemPrompt,
        about: input.about,
        planGuidance: input.planGuidance,
        quizGuidance: input.quizGuidance,
        collectPageGuidance: input.collectPageGuidance,
        tableGuidance: input.tableGuidance,
        exploreGuidance: input.exploreGuidance,
        quizMakeupNote: input.quizMakeupNote,
      })
    ),
    ...history,
  ];

  // No user turn means this is a resume: `history` already ends in the tool result the
  // model asked for, and that is the whole request.
  if (input.userMessage !== null) {
    const userContent = await buildUserContent(input.userMessage, input.attachments, {
      user: input.user,
      vision: input.vision,
      toolUse: input.toolUse,
      sourcePaths: input.sourcePaths,
      references: input.references,
    });
    messages.push(new HumanMessage(userContent as string | UserContentBlock[]));
  }

  const toolByName = new Map<string, StructuredToolInterface>(input.tools.map((t) => [t.name, t]));
  const toolCalls: ToolCall[] = [];
  let finalContent = "";
  /**
   * The model's most recent utterance — the text of the last step that said anything.
   *
   * `finalContent` is an *accumulation*: every step's text is appended to it as it streams.
   * A turn that ends on a plain answer never keeps that pile, because the branch below
   * replaces it with the final step's text. A turn that ends on a tool call does not reach
   * that branch, so without this it would persist every step's narration run together with
   * no separator — which is what `ask_user` made reachable, being the first way a turn can
   * legitimately end by asking rather than answering.
   */
  let lastUtterance = "";
  /**
   * Text streamed beside `ila_review_quiz` calls, in step order. Unlike ordinary tool
   * narration it survives the last-utterance replacement — see `composeWithAnswerUtterances`.
   */
  const answerUtterances: string[] = [];
  /** Set when a step asked the user something; the turn ends once the step finishes. */
  let awaiting = false;
  /**
   * Whether the loop stopped for a reason of its own — an answer, a question, or a provider
   * that sent nothing. False means the budget ran out with the model still working, which is
   * a different outcome and has to be reported as one.
   */
  let ended = false;

  // Summed across steps — what the provider actually billed for this turn.
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let cachedInputTokens = 0;
  // The final step's input+output — how big the context had grown by the end of the turn.
  let contextTokens = 0;
  let sawUsage = false;
  /** The turn was cut short by `input.signal`; see `RunAgentResult.stopped`. */
  let stopped = false;

  // Only the step loop is guarded. Everything before it — reading the history, building the
  // model — must keep throwing normally, so a missing provider is still a failed turn.
  try {
    for (let step = 0; step < maxSteps; step++) {
      const chunks: AIMessageChunk[] = [];
      let stepText = "";
      const stream = await modelWithTools.stream(messages, { signal: input.signal });

      for await (const chunk of stream) {
        chunks.push(chunk);

        const thought = chunkReasoning(chunk);
        if (thought) {
          reasoning += thought;
          input.onEvent({ type: "reasoning", delta: thought });
        }

        const text = chunkText(chunk);
        if (text) {
          stepText += text;
          finalContent += text;
          input.onEvent({ type: "text", delta: text });
        }
      }

      if (chunks.length === 0) {
        ended = true;
        break;
      }
      const aiMessage = chunks.reduce((acc, c) => acc.concat(c) as AIMessageChunk);
      messages.push(aiMessage);

      // Providers report usage on a dedicated chunk at the end of the step. Read it from the
      // chunks rather than from `aiMessage`: `AIMessageChunk.concat` does *not* carry
      // `usage_metadata` through the reduce, so the reduced message always reports none.
      const stepUsage = chunks.reduce<AIMessageChunk["usage_metadata"] | undefined>(
        (acc, c) => c.usage_metadata ?? acc,
        undefined
      );
      if (stepUsage) {
        sawUsage = true;
        inputTokens += stepUsage.input_tokens ?? 0;
        outputTokens += stepUsage.output_tokens ?? 0;
        totalTokens += stepUsage.total_tokens ?? 0;
        cachedInputTokens += stepUsage.input_token_details?.cache_read ?? 0;
        contextTokens = (stepUsage.input_tokens ?? 0) + (stepUsage.output_tokens ?? 0);
      }

      if (stepText) lastUtterance = stepText;

      const calls = aiMessage.tool_calls ?? [];

      // Text streamed alongside a call whose artifact *is* that text is answer content, not
      // narration: keep it even when a later step only moves the plan or asks what is next.
      // See `ANSWER_BEARING_TOOLS`.
      if (
        calls.some((c) => ANSWER_BEARING_TOOLS.has(c.name)) &&
        stepText.trim() &&
        !answerUtterances.includes(stepText)
      ) {
        answerUtterances.push(stepText);
      }

      if (calls.length === 0) {
        // No tool calls: the model's final answer is this message's content.
        finalContent = composeWithAnswerUtterances(
          answerUtterances,
          chunkText(aiMessage) || lastUtterance
        );
        ended = true;
        break;
      }

      // A suspending tool (`ask_user`, `quiz`) ends the turn, so a step that contains one
      // must run its *other* calls first and suspend after them. Dropping them instead would
      // leave the model's own tool_calls block holding calls nobody ever answered, and the
      // model with no record that it had asked for them — so nothing the model asked for is
      // ever silently lost.
      let suspendedHere = false;

      for (const call of calls) {
        const id = call.id ?? `call_${step}_${toolCalls.length}`;
        const name = call.name ?? "unknown";
        const args = JSON.stringify(call.args ?? {});
        // The quiz tool's model-authored args may carry the answer key; every other tool's
        // input is what the card renders. The suspending arm stores its own redacted record,
        // but a call that fails validation lands on the ordinary path below.
        const clientInput = name === QUIZ_TOOL_NAME ? redactQuizInput(args) : args;

        input.onEvent({ type: "tool_start", toolCall: { id, name, input: clientInput } });

        let output = "";
        const t = toolByName.get(name);
        if (t) {
          try {
            // `configurable.toolCallId` is how a tool (ila_update_plan_progress) records the
            // jump anchor for a node it completes: the provider's call id, the same id the
            // UI later finds the message by.
            const result = await t.invoke(call.args ?? {}, {
              signal: input.signal,
              configurable: { toolCallId: id },
            });
            output = typeof result === "string" ? result : JSON.stringify(result);
            /*
             * The call committed, so an `auto-install` widget's install happens now — before the
             * `tool_end` below, so a client that reacts to that event by re-reading the
             * conversation's widgets finds the write already there.
             *
             * Guarded so a failing side effect can never be reported as a failing *tool*: the
             * arm below turns a throw into `Tool error: …`, which would tell the model its
             * successful call broke and send it looking for another way. A widget that did not
             * install is a missing panel, not a failed call. Swallowed here rather than logged
             * because the loop has no logger and the caller's closure is where a failure is
             * observable.
             */
            try {
              input.onToolUsed?.(name);
            } catch {
              // Deliberately ignored — see above.
            }
          } catch (err) {
            // A suspension is not an error and must not be reported as one: the model would
            // be told its own question failed. Caught before the generic arm below, and by
            // base class rather than by tool name so a new suspending tool needs no change
            // here.
            if (err instanceof Suspension) {
              if (awaiting) {
                // One suspension per step. Answering two sets of questions at once is a
                // state the UI has no way to present, and the model can simply ask again.
                output = "Tool error: only one question tool call is allowed per step.";
              } else {
                awaiting = true;
                suspendedHere = true;
                // Recorded without an `output` on purpose: `buildHistoryMessages` replays
                // only calls that have one, which is exactly what keeps a pending question
                // out of the model's context until the user has answered it.
                //
                // `recordedInput` rather than `args`, because a tool may have added
                // something the model could not — a `quiz` numbers its questions from a
                // counter, and those ids have to be in the record the card is re-rendered
                // from. The `tool_start` above keeps the model's own args; the live card
                // renders a placeholder until `message_done` replaces it with this.
                toolCalls.push({
                  id,
                  name,
                  input: JSON.stringify(err.recordedInput ?? call.args ?? {}),
                  status: "awaiting",
                });
                // Note the deliberate absence of a `tool_end` event to match the
                // `tool_start` above — there is no result to report yet.
                continue;
              }
            } else if (input.signal?.aborted) {
              // A stop is not a tool failure either. Reporting it as `Tool error: …` would
              // look like the tool broke and would carry the loop into another step, so it
              // unwinds to the handler below instead. Ordered after the suspension arm, not
              // before it: a suspending tool never consults the signal, so an aborted signal
              // must not be allowed to relabel a suspension as a stop.
              throw err;
            } else {
              output = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
            }
          }
        } else {
          output = `Unknown tool "${name}".`;
        }

        toolCalls.push({ id, name, input: clientInput, output });
        input.onEvent({ type: "tool_end", toolCall: { id, name, input: clientInput, output } });

        messages.push(new ToolMessage({ tool_call_id: id, name, content: output }));
      }

      if (suspendedHere) {
        // The same rule the final answer gets: the message holds the model's most recent
        // words, not every step's. A question is introduced by the sentence just before it,
        // and the narration from earlier steps — which the live stream already showed — is
        // not part of it. Falling back to the utterance rather than to the accumulation is
        // what keeps a silent suspending step from re-joining everything after all. A
        // verdict walkthrough from an earlier grading call is answer content, so it survives.
        finalContent =
          composeWithAnswerUtterances(answerUtterances, lastUtterance) || finalContent;
        ended = true;
        break;
      }
    }
  } catch (err) {
    // Stopping is not failing: the turn resolves with whatever had streamed, and the route
    // persists that as a partial reply. Every other throw keeps its meaning — swallowing
    // them here would turn any provider failure into a silent, empty "stopped" turn.
    if (!input.signal?.aborted) throw err;
    stopped = true;
  }

  // The budget ran out with the model still working. Its last utterance is kept — it is the
  // most recent thing it said — and the truncation is stated after it, because a turn that
  // stops mid-work and reads as a finished answer is worse than one that admits it. The
  // sentence is always present, not only when the model said nothing: that used to be the
  // rule, and it meant every truncated turn that had narrated anything looked complete.
  //
  // A stopped turn never gets the note: an empty reply there is legitimate, because the
  // user asked for the turn to end there.
  if (!ended && !stopped) {
    const kept = lastUtterance
      ? composeWithAnswerUtterances(answerUtterances, lastUtterance)
      : "";
    finalContent = kept ? `${kept}\n\n${OUT_OF_STEPS}` : OUT_OF_STEPS;
  }

  // Empty (rather than all-zeros) when the provider reported nothing, so callers can tell
  // "not reported" apart from "reported zero". A stopped turn reports nothing at all: the
  // figures it has cover a half-finished step, which is not worth showing or summing.
  const usage: MessageUsage =
    sawUsage && !stopped
      ? { inputTokens, outputTokens, totalTokens, cachedInputTokens, contextTokens }
      : {};

  if (sawUsage && !stopped) input.onEvent({ type: "usage", usage });

  return { content: finalContent, reasoning: reasoning.trim(), toolCalls, usage, awaiting, stopped };
}

/** Re-exported for clarity at the call site. */
export { buildModel } from "./model.js";
