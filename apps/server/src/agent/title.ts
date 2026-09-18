import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { MessageUsage } from "@ilearnassist/shared";
import { usageOfMessage } from "./callUsage.js";
import type { ProviderRecord } from "../db.js";
import { renderPrompt } from "../prompts.js";

/** Titles longer than this are truncated rather than rejected. */
const MAX_TITLE_CHARS = 60;
/** How much of each side of the exchange is shown to the titler. */
const MAX_EXCHANGE_CHARS = 1_200;
/** Cap for the fallback derived from the user's own words. */
const FALLBACK_TITLE_CHARS = 40;

/**
 * Output budget. Deliberately generous: reasoning models (`deepseek-v4-pro`,
 * `deepseek-reasoner`, o-series) spend the budget on chain-of-thought *before* emitting
 * any content, so a tight cap produces `finish_reason: "length"` with an empty answer and
 * no title at all — which is exactly how this silently failed the first time.
 */
const MAX_OUTPUT_TOKENS = 512;


export interface GenerateTitleInput {
  provider: ProviderRecord | undefined;
  modelId: string;
  userMessage: string;
  assistantMessage: string;
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
 * Deterministic last resort: lead with the user's own words. Always succeeds, so a first
 * turn is never left showing the create-time placeholder even when the titler cannot run
 * (no key, rate limit, a reasoning model that spends its whole budget thinking).
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
 * Ask the model for a short title for a brand-new conversation.
 *
 * Deliberately a separate, minimal call: no streaming and `maxRetries: 0`, so a slow or
 * failing titler can only ever cost a moment. The caller falls back to `fallbackTitle()`
 * on any throw.
 */
export async function generateTitle(input: GenerateTitleInput): Promise<string> {
  const { provider, modelId } = input;
  if (!provider) throw new Error("No provider configured.");
  const model = modelId || provider.models[0]?.modelId || "";
  if (!model) throw new Error("No model configured.");
  if (!provider.apiKey) throw new Error("Provider has no API key.");

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

  // Fenced so the model treats the conversation as data, not as a request to answer.
  const exchange =
    "<conversation>\n" +
    `<user>${input.userMessage.slice(0, MAX_EXCHANGE_CHARS)}</user>\n` +
    `<assistant>${input.assistantMessage.slice(0, MAX_EXCHANGE_CHARS)}</assistant>\n` +
    "</conversation>\n\nTitle:";

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
  if (!title) {
    const finish = (response.response_metadata as { finish_reason?: string })?.finish_reason;
    throw new Error(
      `The model returned no title${finish ? ` (finish_reason: ${finish})` : ""}.`
    );
  }
  return title;
}
