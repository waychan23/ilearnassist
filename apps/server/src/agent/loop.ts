import {
  AIMessage,
  AIMessageChunk,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type {
  Attachment,
  ChatStreamEvent,
  Message,
  MessageUsage,
  SessionSettings,
  ToolCall,
  Workspace,
} from "@ilearnassist/shared";
import type { ProviderRecord } from "../db.js";
import type { UserLayout } from "../paths.js";
import { buildUserContent, type UserContentBlock } from "../attachments.js";
import { Suspension } from "../tools/suspension.js";
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
   * Extra system-prompt guidance for turns in a conversation with the plan widget
   * installed; absent in every other conversation.
   */
  planGuidance?: string;
  /** The same mechanism for the quiz widget: judge/record answers and recognise make-ups. */
  quizGuidance?: string;
  /** Whose sources tree the attachment bytes live in. Derived per request, never held. */
  user: UserLayout;
  sessionId: string;
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

function buildSystemPrompt(
  workspace: Workspace,
  systemPrompt: string,
  planGuidance?: string,
  quizGuidance?: string
): string {
  const base =
    systemPrompt.trim() ||
    "You are a helpful, precise AI assistant. You can use file tools to read and write files inside the user's active workspace, a web_search tool to look up current information, and a web_fetch tool to read the contents of a specific URL. When a choice is genuinely the user's to make — several defensible options and no way to tell which they want — use ask_user to put the options to them rather than guessing. Do the same once you have produced a plan or another substantial artifact: put it to them for confirmation rather than assuming it is accepted. Prefer giving the answer directly, and only use tools when they are genuinely needed.";

  // `workdirPath`, not `dirPath`: the sandbox is the workspace's `workdir/`, and naming the
  // parent here would tell the model that `sessions/` is inside the directory it may write
  // to — a claim the tools would then refuse to honour.
  const workspaceNote =
    `\n\nThe user is working inside a workspace located at:\n${workspace.workdirPath}\n` +
    `All file tools are sandboxed to this directory. Use paths relative to it ` +
    `(or absolute paths under it). Never attempt to access files outside this directory.`;

  // Present while the plan widget is installed, whether or not a plan exists yet — the
  // rhythm starts the moment one is made.
  const planNote = planGuidance ? `\n\n${planGuidance}` : "";
  // Likewise for the quiz widget: installed or not is the whole switch.
  const quizNote = quizGuidance ? `\n\n${quizGuidance}` : "";

  return base + workspaceNote + planNote + quizNote;
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
      const content = await buildUserContent(m.content, m.attachments, {
        user: input.user,
        vision: input.vision,
        toolUse: input.toolUse,
      });
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
      buildSystemPrompt(
        input.workspace,
        input.systemPrompt,
        input.planGuidance,
        input.quizGuidance
      )
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
      if (calls.length === 0) {
        // No tool calls: the model's final answer is this message's content.
        finalContent = chunkText(aiMessage) || lastUtterance;
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

        input.onEvent({ type: "tool_start", toolCall: { id, name, input: args } });

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

        toolCalls.push({ id, name, input: args, output });
        input.onEvent({ type: "tool_end", toolCall: { id, name, input: args, output } });

        messages.push(new ToolMessage({ tool_call_id: id, name, content: output }));
      }

      if (suspendedHere) {
        // The same rule the final answer gets: the message holds the model's most recent
        // words, not every step's. A question is introduced by the sentence just before it,
        // and the narration from earlier steps — which the live stream already showed — is
        // not part of it. Falling back to the utterance rather than to the accumulation is
        // what keeps a silent suspending step from re-joining everything after all.
        finalContent = lastUtterance || finalContent;
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
    finalContent = lastUtterance ? `${lastUtterance}\n\n${OUT_OF_STEPS}` : OUT_OF_STEPS;
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
