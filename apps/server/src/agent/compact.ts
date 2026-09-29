import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { MessageUsage } from "@ilearnassist/shared";
import { usageOfMessage } from "./callUsage.js";
import type { ProviderRecord } from "../db.js";
import { renderPrompt } from "../prompts.js";

/**
 * Manual context compaction: turning the earlier half of a conversation into the summary that
 * stands in for it.
 *
 * Two halves, and the split is the same one `title.ts` makes. The **pure** half — transcript
 * rendering, chunking, and cutting a message list at a summary's point — is exported so it can
 * be tested without a model, and so the route can use `applyContextSummary` to decide what a
 * turn actually sends without calling anything. The **call** half folds the history through the
 * model chunk by chunk, because the conversation being compressed is by definition the one that
 * may not fit in one request: the first call summarizes the oldest chunk, and every later call
 * receives the running summary plus the next chunk.
 */

/** One message as the compactor reads it. Deliberately narrow: ids and timestamps are not read. */
export interface CompactMessage {
  role: string;
  content: string;
  /** The tool calls this message made, with their recorded outputs where there are any. */
  toolCalls?: readonly { name: string; output?: unknown }[];
}

/**
 * How much of any one message reaches a summarization call.
 *
 * The per-message cap is what keeps a single pasted document from owning a whole chunk; the
 * tool-output cap is tighter because a tool result is the model's own working material rather
 * than the conversation, and what a later turn needs from it — that a file was written, what a
 * command said — survives in a paragraph.
 */
export const COMPACT_MESSAGE_MAX_CHARS = 4_000;
export const COMPACT_TOOL_OUTPUT_MAX_CHARS = 600;

/**
 * The size one call's conversation side may reach, in characters.
 *
 * A character budget rather than a token count, for the reason the composer's estimate gives:
 * this is a bound on a call, not a billing figure. It is deliberately well under any model's
 * window even at two characters per token, because the provider is unknown and a failed
 * compaction is worse than a second call.
 */
export const COMPACT_CHUNK_CHARS = 48_000;

/**
 * Output budget. Generous for the reason `title.ts` documents at length: a reasoning model
 * spends output tokens on chain of thought first, and a tight cap produces an empty answer
 * with `finish_reason: "length"` rather than a short summary.
 */
const MAX_OUTPUT_TOKENS = 4_096;
const TIMEOUT_MS = 120_000;

/** Clip one message's body for the transcript. */
function clipForCompact(text: string, budget: number): string {
  const trimmed = text.trim();
  return trimmed.length > budget ? trimmed.slice(0, budget).trimEnd() + "…" : trimmed;
}

/**
 * One message, fenced under its role.
 *
 * The tags are the compaction prompt's contract (`summary.system` names them), and they carry a
 * second job beyond readability: a user's own words are inside `<user>`, so a sentence that
 * reads like an instruction is something the summarizer is told to treat as data.
 */
export function renderCompactMessage(message: CompactMessage): string {
  const body = clipForCompact(message.content, COMPACT_MESSAGE_MAX_CHARS);
  const tools = (message.toolCalls ?? [])
    .filter((tc) => typeof tc.output === "string" && (tc.output as string).trim().length > 0)
    .map(
      (tc) =>
        `<tool name="${tc.name}">\n${clipForCompact(
          tc.output as string,
          COMPACT_TOOL_OUTPUT_MAX_CHARS
        )}\n</tool>`
    )
    .join("\n");
  const inner = [body, tools].filter((part) => part.length > 0).join("\n");
  return inner ? `<${message.role}>\n${inner}\n</${message.role}>` : `<${message.role}></${message.role}>`;
}

/** The whole slice as the summarizer sees it, fenced so the text is data rather than a request. */
export function compactTranscript(messages: readonly CompactMessage[]): string {
  return messages.map(renderCompactMessage).join("\n");
}

/**
 * Cut a message list into call-sized chunks, in order.
 *
 * A message bigger than the budget gets a chunk of its own rather than being split: the message
 * is the unit the transcript tags, and `renderCompactMessage` has already clipped it, so one
 * oversized message is bounded rather than unbounded.
 */
export function splitCompactChunks(
  messages: readonly CompactMessage[],
  budget = COMPACT_CHUNK_CHARS
): CompactMessage[][] {
  const chunks: CompactMessage[][] = [];
  let current: CompactMessage[] = [];
  let size = 0;
  for (const message of messages) {
    const rendered = renderCompactMessage(message).length;
    if (current.length > 0 && size + rendered > budget) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(message);
    size += rendered;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * What one fold step sends: the running summary when there is one, then this chunk.
 *
 * `previous` is omitted rather than sent empty on the first call, so the prompt's own
 * instructions about folding are not answering a question nobody asked.
 */
export function compactUserContent(previous: string, transcript: string): string {
  const prior = previous.trim()
    ? `<previous_summary>\n${previous.trim()}\n</previous_summary>\n\n`
    : "";
  return `${prior}<conversation>\n${transcript}\n</conversation>\n\nSummary:`;
}

/**
 * The messages a turn still sends verbatim after a compaction, given the whole live list.
 *
 * The point is found **by id first**, which is exact, and by timestamp only as a fallback: the
 * message a summary covers through can be deleted afterwards, and a summary that could no
 * longer find its own point would silently send the whole history — the failure this feature
 * exists to prevent. The timestamp fallback is strictly greater, so a lingering copy of the
 * through message (another row with the same instant) is still excluded.
 */
export function applyContextSummary<T extends { id: string; createdAt: string }>(
  messages: readonly T[],
  point: { throughMessageId: string; throughCreatedAt: string }
): T[] {
  const index = messages.findIndex((m) => m.id === point.throughMessageId);
  if (index >= 0) return messages.slice(index + 1);
  return messages.filter((m) => m.createdAt > point.throughCreatedAt);
}

export interface SummarizeContextInput {
  provider: ProviderRecord | undefined;
  modelId: string;
  /** The effective history being compressed: the previous summary's tail, oldest first. */
  messages: readonly CompactMessage[];
  /** The summary this compaction supersedes, folded into the new one when present. */
  previous?: string;
  /**
   * One call's usage, handed over when the provider reported any — the `title.ts` contract,
   * called at most once per call and never with a null.
   */
  onUsage?: (usage: MessageUsage, durationMs: number) => void;
}

/** Pull the text out of a model response that may be a string or content blocks. */
function responseText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block && typeof block === "object" && "text" in block ? String(block.text) : ""))
    .join("");
}

/**
 * Ask the model to compress the conversation, folding chunk over chunk.
 *
 * Throws on anything that leaves no usable summary — no provider, no key, an empty answer —
 * and the route turns that into a refusal rather than a half-written row. Nothing here touches
 * the database: deciding what the summary is and deciding to keep it are deliberately two
 * steps, which is what makes a failed call leave the previous state exactly as it was.
 */
export async function summarizeContext(input: SummarizeContextInput): Promise<string> {
  const { provider, modelId } = input;
  if (!provider) throw new Error("No provider configured.");
  const model = modelId || provider.models[0]?.modelId || "";
  if (!model) throw new Error("No model configured.");
  if (!provider.apiKey) throw new Error("Provider has no API key.");

  const chunks = splitCompactChunks(input.messages);
  if (chunks.length === 0) throw new Error("There is nothing to compact.");

  const llm = new ChatOpenAI({
    model,
    apiKey: provider.apiKey,
    configuration: { baseURL: provider.baseURL },
    // Summarizing is a faithful-restatement task; determinism beats creativity, as in the titler.
    temperature: 0.2,
    maxTokens: MAX_OUTPUT_TOKENS,
    maxRetries: 0,
    timeout: TIMEOUT_MS,
  });

  // Read at call time rather than captured in a module constant, so a
  // `<dataRoot>/config.patch.json` override takes effect — see `prompts.ts`.
  const systemPrompt = renderPrompt("summary.system");
  let summary = input.previous?.trim() ?? "";

  for (const chunk of chunks) {
    const startedAt = Date.now();
    const response = await llm.invoke([
      new SystemMessage(systemPrompt),
      new HumanMessage(compactUserContent(summary, compactTranscript(chunk))),
    ]);
    const usage = usageOfMessage(response);
    if (usage) input.onUsage?.(usage, Date.now() - startedAt);

    const text = responseText(response.content).trim();
    if (!text) {
      const finish = (response.response_metadata as { finish_reason?: string })?.finish_reason;
      throw new Error(
        `The model returned no summary${finish ? ` (finish_reason: ${finish})` : ""}.`
      );
    }
    summary = text;
  }

  return summary;
}
