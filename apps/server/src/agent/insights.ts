import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage, type AIMessageChunk } from "@langchain/core/messages";
import { usageOfChunks } from "./callUsage.js";
import type { MessageUsage } from "@ilearnassist/shared";
import type { ProviderRecord } from "../db.js";
import type { OutOfBandReasoningSetting } from "../config.js";
import type { InsightGenerator } from "../insights.js";
import { reasoningModelKwargs } from "./reasoning.js";

/**
 * The insight pass's out-of-band call, a direct structural copy of `makeThreadClassifier`.
 *
 * The three numbers are the classifier's, and each was learned rather than chosen — they are
 * repeated here with their reasons so a later change to one can be judged on the same grounds:
 *
 * - **Streaming**, which the titler is not. A non-streaming call to a reasoning model buffers
 *   its whole thinking run before the first byte, so the HTTP timeout bounds *thinking* rather
 *   than an idle connection; healthy 14–18s responses were already dying at a 20s timeout.
 * - **A generous output budget**, because a reasoning model spends it on chain-of-thought
 *   FIRST: 2048 tokens bought 27 seconds of thinking and an empty answer on the classifier.
 *   An insight pass thinks more than a classifier does, so it is the last place to be tight.
 * - **Sixty seconds**, which is a backstop for a runaway thinker rather than a working limit.
 *
 * `temperature: 0.2` is higher than the classifier's 0.1 and lower than the titler's: this is
 * not a classification — the same record can honestly yield different phrasings — but it is
 * still an observation about evidence rather than a piece of writing.
 */
const MAX_OUTPUT_TOKENS = 8_192;
const TIMEOUT_MS = 60_000;

export interface InsightModelInput {
  provider: ProviderRecord | undefined;
  modelId: string;
  /**
   * Whether this call may run chain-of-thought. Defaults to `auto` — see
   * `OutOfBandReasoningSetting`. Its own switch (`ILA_INSIGHT_REASONING`) rather than the
   * classifier's, because the two want different answers: a classification is a judgement, while
   * a reflection pass is the kind of thinking that benefits from time.
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
      .map((b) => (b && typeof b === "object" && "text" in b ? String(b.text) : ""))
      .join("");
  }
  return "";
}

/**
 * Build the call for one pass, reusing the conversation's resolved provider/model — the same
 * inputs the classifier and the auto-titler get.
 *
 * The `modelKwargs` gate is shared with the classifier (`reasoning.ts`) because the risk is
 * shared: an unknown `thinking` body field is a 400 on a strict OpenAI-compatible endpoint, so
 * the field goes only to a model whose record declares the `reasoning` capability.
 */
export function makeInsightGenerator(input: InsightModelInput): InsightGenerator {
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

    // Fenced so the record is data, never instructions — and here that is not theoretical: the
    // payload is largely the learner's own notes, which is free text they wrote for themselves.
    const stream = await llm.stream([
      new SystemMessage(systemPrompt),
      new HumanMessage(`<study_record>\n${userPrompt}\n</study_record>`),
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
