import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { MessageUsage } from "@ilearnassist/shared";
import { usageOfMessage } from "./callUsage.js";
import type { ProviderRecord } from "../db.js";
import { renderPrompt } from "../prompts.js";

/**
 * One line about an image, written by the model that can see it.
 *
 * The requirement's last unbuilt piece: *"after the model recognises a multimodal attachment's
 * content, the summary is added to the source"*. The shape of that sentence is the shape of
 * this file — an image is the one kind of material a conversation can hold that leaves **no
 * text behind at all**, so without this a picture is readable exactly once, in the turn it
 * arrived in, and for every turn afterwards it is a name in a chip.
 *
 * Three decisions are load-bearing:
 *
 * - **Out of band, after the turn.** Summarising is a model call, and a model call on the turn
 *   path is a turn that can fail for a reason the user did not cause. This runs in `finishTurn`,
 *   fire-and-forget, exactly like the auto-titler — and every failure is swallowed, for the same
 *   reason: a conversation that worked must not report a problem because a side call could not
 *   finish.
 * - **Once per source, not once per turn.** The source is deduped by content, so the second
 *   conversation to attach the same screenshot finds it summarised. `needsSummary` is that
 *   check, and it is what bounds the cost to one call per *new* image.
 * - **The same provider and model as the turn.** It is the model the user chose, it is already
 *   paid for, and it is the one whose capability decided that the image could be read at all —
 *   a second model would be a second key, a second bill and a second answer.
 *
 * The output is used in two places on purpose: the `summary` column, which the browser and the
 * `@` picker show; and `parsed/<id>.txt`, which is what `read_document` and the prompt builder
 * read. A summary that lived only in the column would be a file the model still could not read.
 */

/** Long enough for a paragraph, short enough to be a label. */
const MAX_SUMMARY_CHARS = 400;
/** Output budget, generous for `generateTitle`'s reason: a reasoning model spends it thinking. */
const MAX_OUTPUT_TOKENS = 512;


export interface SummarizeImageInput {
  provider: ProviderRecord | undefined;
  modelId: string;
  dataUrl: string;
  /**
   * A line of the conversation, so the description comes back in the language being read.
   *
   * Cheaper and more reliable than a locale tag: the model already has the sentence, and "write
   * in this language" needs no table mapping `zh-CN` to 中文.
   */
  sample: string;
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
 * Whether a source still needs a summary.
 *
 * Exported because it is the *rule*, and the caller is the one that knows which sources a turn
 * touched: a summary already there is the user's or a previous pass's, and overwriting it would
 * make the browser's summary flip between two readings of the same picture.
 */
export function needsSummary(source: { summary?: string; category: string }): boolean {
  return source.category === "image" && !source.summary?.trim();
}

export async function summarizeImage(input: SummarizeImageInput): Promise<string | undefined> {
  const { provider } = input;
  if (!provider?.apiKey) return undefined;
  const model = input.modelId || provider.models[0]?.modelId || "";
  if (!model) return undefined;

  const llm = new ChatOpenAI({
    model,
    apiKey: provider.apiKey,
    configuration: { baseURL: provider.baseURL },
    temperature: 0.2,
    maxTokens: MAX_OUTPUT_TOKENS,
    maxRetries: 0,
    timeout: 30_000,
  });

  // Read here rather than captured in a module constant, so a `<dataRoot>/config.patch.json`
  // override takes effect: the patch is applied by the process entry point, which runs after this
  // module has been evaluated.
  const systemPrompt = renderPrompt("mediaSummary.system");
  const startedAt = Date.now();
  const response = await llm.invoke([
    new SystemMessage(systemPrompt),
    new HumanMessage({
      content: [
        {
          type: "text",
          text:
            "The conversation this image belongs to reads like this:\n" +
            `<sample>${input.sample.slice(0, 400)}</sample>\n\n` +
            "Describe the image in that language.",
        },
        { type: "image_url", image_url: { url: input.dataUrl } },
      ],
    }),
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

  const summary = text.trim().replace(/^["“”']+|["“”']+$/g, "").trim();
  if (!summary) return undefined;
  return summary.length > MAX_SUMMARY_CHARS
    ? `${summary.slice(0, MAX_SUMMARY_CHARS - 1)}…`
    : summary;
}
