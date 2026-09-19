import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { MessageUsage } from "@ilearnassist/shared";
import { usageOfMessage } from "./callUsage.js";
import type { ProviderRecord } from "../db.js";
import { renderPrompt } from "../prompts.js";

/** Titles longer than this are truncated rather than rejected. */
const MAX_TITLE_CHARS = 60;
/** How much of any one message is shown to the titler. */
const MAX_EXCHANGE_CHARS = 1_200;
/** How many of the most recent messages are shown, over and above the opening one. */
const MAX_EXCERPT_MESSAGES = 8;
/** Cap for the whole excerpt, so naming a long conversation is still a bounded call. */
const MAX_EXCERPT_CHARS = 6_000;
/** Cap for the fallback derived from the user's own words. */
const FALLBACK_TITLE_CHARS = 40;

/**
 * Output budget. Deliberately generous: reasoning models (`deepseek-v4-pro`,
 * `deepseek-reasoner`, o-series) spend the budget on chain-of-thought *before* emitting
 * any content, so a tight cap produces `finish_reason: "length"` with an empty answer and
 * no title at all — which is exactly how this silently failed the first time.
 */
const MAX_OUTPUT_TOKENS = 512;


/**
 * One thing that was said, in the order it was said. Deliberately not `Message`: the titler has no
 * use for ids, timestamps or tool calls, and taking only the two fields it does read is what lets
 * the excerpt below be a pure function with a test of its own.
 */
export interface TitleMessage {
  role: string;
  content: string;
}

export interface GenerateTitleInput {
  provider: ProviderRecord | undefined;
  modelId: string;
  /**
   * The conversation so far, oldest first — what the titler reads and what the fallback quotes.
   *
   * The whole conversation rather than the first exchange, because the titler is now asked on
   * every turn until it produces a name: a conversation that opens with a greeting has its
   * substance in turn two, and an excerpt frozen at turn one could never see it.
   */
  messages: readonly TitleMessage[];
  /**
   * Handed this call's token usage, once, when the provider reported any.
   *
   * Optional because the ledger is observability rather than behaviour: a caller that does not
   * record usage still gets its answer. Called at most once, and never with a null — a provider
   * that reports nothing produces no call at all, so the callback cannot be confused about the
   * difference between "free" and "unreported".
   */
  /**
   * `durationMs` is the call's own wall-clock time, measured here rather than by the caller: the
   * caller does not know when the request left, and a figure that included its own bookkeeping
   * would be a latency nobody experienced. Zero means nobody timed it — the ledger stores NULL for
   * that, which is a different claim from "it was instant".
   */
  onUsage?: (usage: MessageUsage, durationMs: number) => void;
}

/**
 * The answer that means **nothing to name yet**.
 *
 * A sentinel rather than a second call: the judgement and the naming are one question, and the
 * model already has the conversation in hand. What that costs is a parse, and the parse is
 * deliberately one-directional — a *title* read as a decline costs nothing but another turn, since
 * the conversation stays the titler's to name and the next turn asks again, while a decline read
 * as a title would be written to the row and marked done. So the match is loose (case-insensitive,
 * `NO_TITLE` or `NO TITLE`) and the token itself is one no real title carries.
 */
export const NO_TITLE = "NO_TITLE";

/** Whether a title the model produced is really the "nothing to name yet" answer. See `NO_TITLE`. */
export function isDeclined(title: string): boolean {
  return /^no[_\s-]?title$/i.test(title);
}

/**
 * Clip one message for the excerpt. No flattening: the model is reading this rather than measuring
 * it, and a code block kept on its own lines reads the way it was written.
 */
function clipExcerpt(text: string, budget: number): string {
  const flat = text.trim();
  return flat.length > budget ? flat.slice(0, budget).trimEnd() : flat;
}

/**
 * The conversation as the titler sees it: fenced, so the text inside is data rather than a request
 * to answer.
 *
 * Two ends rather than a window, because those are what name a conversation: the question it
 * opened with, and what was last said about it. The budget is spent from the newest message
 * backwards, so what a long conversation costs is its **middle** — a turn from last week is far
 * better evidence of what this is about than the fourth message of the first hour.
 *
 * Pure, and it decides nothing: the caller is the one that knows whether there is anything here
 * worth a call at all.
 */
export function conversationExcerpt(messages: readonly TitleMessage[]): string {
  const usable = messages.filter((m) => m.content.trim().length > 0);
  const opening = usable[0];
  if (!opening) return "";

  const openingText = clipExcerpt(opening.content, MAX_EXCHANGE_CHARS);
  let budget = Math.max(0, MAX_EXCERPT_CHARS - openingText.length);

  const recent: TitleMessage[] = [];
  for (let i = usable.length - 1; i >= 0; i -= 1) {
    const message = usable[i]!;
    if (message === opening) continue;
    if (recent.length >= MAX_EXCERPT_MESSAGES || budget <= 0) break;
    const text = clipExcerpt(message.content, Math.min(MAX_EXCHANGE_CHARS, budget));
    budget -= text.length;
    recent.unshift({ role: message.role, content: text });
  }

  const lines = [{ role: opening.role, content: openingText }, ...recent].map(
    (m) => `<${m.role}>${m.content}</${m.role}>`
  );
  return `<conversation>\n${lines.join("\n")}\n</conversation>`;
}

/**
 * Clean up whatever the model returned into something usable as a sidebar label.
 * Models like to wrap titles in quotes or prefix them despite instructions, so this
 * strips the common shapes rather than trusting the output.
 */
export function sanitizeTitle(raw: string): string {
  let title = raw.trim();

  // Keep only the first non-empty line — some models add a trailing explanation.
  const firstLine = title.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  if (firstLine) title = firstLine;

  title = title
    .replace(/^(?:title|标题)\s*[:：]\s*/i, "")
    .replace(/^["'“”‘’«]+|["'“”‘’»]+$/g, "")
    .replace(/[.。!！?？,，;；:：]+$/g, "")
    .trim();

  if (title.length > MAX_TITLE_CHARS) {
    title = title.slice(0, MAX_TITLE_CHARS).trimEnd() + "…";
  }
  return title;
}

/**
 * Deterministic last resort: lead with the user's own words. Always succeeds, so a conversation is
 * never left showing the create-time placeholder merely because the titler could not *run* (no key,
 * rate limit, a reasoning model that spends its whole budget thinking) — which is a different
 * situation from the model looking and declining, where the placeholder is the honest answer.
 */
export function fallbackTitle(userMessage: string, assistantMessage = ""): string {
  const source = userMessage.trim() || assistantMessage.trim();
  // Collapse to a single line so the sidebar label cannot wrap or break.
  const flat = source.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const clipped =
    flat.length > FALLBACK_TITLE_CHARS
      ? flat.slice(0, FALLBACK_TITLE_CHARS).trimEnd() + "…"
      : flat;
  // Same cleanup a model title gets, so "什么是递归？" becomes "什么是递归".
  return sanitizeTitle(clipped);
}

/**
 * Ask the model to name a conversation, or to say there is nothing to name yet.
 *
 * Deliberately a separate, minimal call: no streaming and `maxRetries: 0`, so a slow or
 * failing titler can only ever cost a moment. The caller falls back to `fallbackTitle()`
 * on any **throw**, and leaves the conversation on its placeholder for a `null` — those are
 * different answers, and the difference is the whole point of the second one.
 *
 * @returns the title, or `null` when the model declined because the conversation has nothing in it
 *   yet. A reply that is neither a title nor the sentinel still throws.
 */
export async function generateTitle(input: GenerateTitleInput): Promise<string | null> {
  const { provider, modelId } = input;
  if (!provider) throw new Error("No provider configured.");
  const model = modelId || provider.models[0]?.modelId || "";
  if (!model) throw new Error("No model configured.");
  if (!provider.apiKey) throw new Error("Provider has no API key.");
  const excerpt = conversationExcerpt(input.messages);
  if (!excerpt) throw new Error("Nothing to title.");

  const llm = new ChatOpenAI({
    model,
    apiKey: provider.apiKey,
    configuration: { baseURL: provider.baseURL },
    // Naming a conversation is a classification task; determinism beats creativity.
    temperature: 0.2,
    maxTokens: MAX_OUTPUT_TOKENS,
    maxRetries: 0,
    timeout: 20_000,
  });

  // `conversationExcerpt` fences it, so the model treats the conversation as data, not as a
  // request to answer.
  const exchange = `${excerpt}\n\nTitle:`;

  // Read here rather than captured in a module constant, so a `<dataRoot>/config.patch.json`
  // override takes effect: the patch is applied by the process entry point, which runs after this
  // module has been evaluated.
  const systemPrompt = renderPrompt("title.system");
  const startedAt = Date.now();
  const response = await llm.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage(exchange),
  ]);
  const usage = usageOfMessage(response);
  if (usage) input.onUsage?.(usage, Date.now() - startedAt);

  const text =
    typeof response.content === "string"
      ? response.content
      : Array.isArray(response.content)
        ? response.content
            .map((b) => (b && typeof b === "object" && "text" in b ? String(b.text) : ""))
            .join("")
        : "";

  const title = sanitizeTitle(text);
  if (isDeclined(title)) return null;
  if (!title) {
    const finish = (response.response_metadata as { finish_reason?: string })?.finish_reason;
    throw new Error(
      `The model returned no title${finish ? ` (finish_reason: ${finish})` : ""}.`
    );
  }
  return title;
}
