import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage, type AIMessageChunk } from "@langchain/core/messages";
import { usageOfChunks } from "./callUsage.js";
import type { MessageUsage } from "@ilearnassist/shared";
import type { ProviderRecord } from "../db.js";
import type { OutOfBandReasoningSetting } from "../config.js";
import type { NoteSummarizer } from "../notesExport.js";
import { reasoningModelKwargs } from "./reasoning.js";

/**
 * The note export's summary call — the third out-of-band call, after the thread classifier and
 * the insight pass. A direct structural copy of `makeInsightGenerator`.
 *
 * The numbers are repeated here rather than shared because each was learned rather than chosen,
 * and a later change to one should be judged on its own reasons:
 *
 * - **Streaming**, which the auto-titler is not. A non-streaming call to a reasoning model
 *   buffers its whole thinking run before the first byte, so the HTTP timeout would bound
 *   *thinking* rather than an idle connection.
 * - **A generous output budget**, because a reasoning model spends it on chain-of-thought FIRST.
 * - **Sixty seconds**, a backstop for a runaway thinker rather than a working limit.
 *
 * `temperature: 0.2`, the insight pass's value rather than the classifier's 0.1: this is faithful
 * writing about a transcript that is handed over in full, so there is nothing to be decisive
 * about — but it is still a summary, not a piece of prose with a voice.
 */
const MAX_OUTPUT_TOKENS = 8_192;
const TIMEOUT_MS = 60_000;

export interface NoteSummaryModelInput {
  provider: ProviderRecord | undefined;
  modelId: string;
  /**
   * Whether this call may run chain-of-thought. Defaults to `auto` — see
   * `OutOfBandReasoningSetting`. Its own switch (`ILA_NOTE_SYNC_REASONING`) rather than a share,
   * because each switch changes its own call alone; this is arguably the one of the three that
   * wants thinking least, since it is describing material it was given in full.
   */
  reasoning?: OutOfBandReasoningSetting;
  /**
   * Handed this call's token usage, once, when the provider reported any.
   *
   * Optional because the ledger is observability rather than behaviour: a caller that does not
   * record usage still gets its answer, and the five passes are wired one at a time rather than
   * through a shared base class. Called at most once, and never with a null — a provider that
   * reports nothing produces no call at all, so the callback cannot be confused about the
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

function chunkText(chunk: { content: unknown }): string {
  const content = chunk.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (block && typeof block === "object" && "text" in block ? String(block.text) : ""))
      .join("");
  }
  return "";
}

/**
 * Build the call for one export, reusing the conversation's resolved provider/model — the same
 * inputs the classifier, the titler and the insight pass get.
 *
 * The `modelKwargs` gate is shared (`reasoning.ts`) because the risk is: an unknown `thinking`
 * body field is a 400 on a strict OpenAI-compatible endpoint, so the field goes only to a model
 * whose record declares the `reasoning` capability.
 *
 * The human message's wrapper is `<session_transcript>`, deliberately neither the classifier's
 * `<conversation>` nor the insight pass's `<study_record>`. The fake LLM resolves body-keyed
 * scripts by substring, so a wrapper two calls share would let one call's scripted answer fire
 * for the other — a test that passes while asserting about the wrong call.
 */
export function makeNoteSummarizer(input: NoteSummaryModelInput): NoteSummarizer {
  const { provider, modelId, reasoning = "auto" } = input;
  return async (systemPrompt: string, userPrompt: string): Promise<string> => {
    if (!provider) throw new Error("No provider configured.");
    const model = modelId || provider.models[0]?.modelId || "";
    if (!model) throw new Error("No model configured.");
    if (!provider.apiKey) throw new Error("Provider has no API key.");

    const modelKwargs = reasoningModelKwargs(provider, model, reasoning);

    const llm = new ChatOpenAI({
      model,
      apiKey: provider.apiKey,
      configuration: { baseURL: provider.baseURL },
      temperature: 0.2,
      maxTokens: MAX_OUTPUT_TOKENS,
      maxRetries: 0,
      timeout: TIMEOUT_MS,
      streaming: true,
      ...(modelKwargs ? { modelKwargs } : {}),
    });

    // Fenced so the transcript is data, never instructions. Not theoretical here either: the
    // payload is largely what the learner typed.
    const stream = await llm.stream([
      new SystemMessage(systemPrompt),
      new HumanMessage(`<session_transcript>\n${userPrompt}\n</session_transcript>`),
    ]);

    /*
     * The chunks are kept rather than only their text: a provider reports usage on a dedicated
     * final chunk, and `concat` does not carry it through — see `usageOfChunks`.
     */
    const chunks: AIMessageChunk[] = [];
    let text = "";
    const startedAt = Date.now();
    for await (const chunk of stream) {
      chunks.push(chunk);
      text += chunkText(chunk);
    }
    const usage = usageOfChunks(chunks);
    if (usage) input.onUsage?.(usage, Date.now() - startedAt);
    return text;
  };
}
