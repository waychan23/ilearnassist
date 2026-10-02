import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage, type AIMessageChunk } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { MessageUsage } from "@ilearnassist/shared";
import { usageOfChunks } from "./callUsage.js";
import type { ProviderRecord } from "../db.js";
import type { OutOfBandReasoningSetting } from "../config.js";
import { reasoningModelKwargs } from "./reasoning.js";

/**
 * The missing-artifact repair pass's out-of-band call.
 *
 * One call per marker an assistant reply left unanswered, with **only the artifact tool the
 * marker names bound** — a single tool, so the model has nothing else to reach for and the
 * system prompt's "call the tool and nothing else" is the whole instruction.
 *
 * **`tool_choice` is deliberately not forced, and that is not a preference.** Forcing the
 * named function (and even `"required"`) is a 400 on DeepSeek's thinking mode — `Thinking
 * mode does not support this tool_choice` — and DeepSeek V4 defaults thinking ON, so the
 * first version of this pass failed every repair against the product's default provider
 * while looking correct in the fake-LLM tests, which ignore the field. Binding the one tool
 * and leaving the choice at the provider's default is the shape that works everywhere: the
 * probe against `deepseek-flash` called the tool on every attempt without it. A model that
 * answers with prose anyway is handled one level up (`repairArtifactMarker` retries once,
 * and the marker simply stays dangling if both attempts fail).
 *
 * The three numbers are the classifier's and the insight pass's, repeated with their reasons
 * (see `agent/insights.ts`): **streaming**, because a non-streaming reasoning call buffers its
 * whole thinking run before the first byte and a healthy 14–18s answer dies at a short HTTP
 * timeout; **8,192 output tokens**, because a reasoning model spends output budget on
 * chain-of-thought first; **60 seconds**, a backstop for a runaway thinker rather than a
 * working limit. `temperature: 0.3` is a touch above the insight pass's 0.2: this is a
 * reconstruction of content the reply already described, so there is a little room for the
 * artifact's own shape, but it is not a creative pass.
 */
const MAX_OUTPUT_TOKENS = 8_192;
const TIMEOUT_MS = 60_000;

export interface ArtifactRepairModelInput {
  provider: ProviderRecord | undefined;
  modelId: string;
  /**
   * Whether this call may run chain-of-thought. Defaults to `auto` — see
   * `OutOfBandReasoningSetting`. Its own switch (`ILA_ARTIFACT_REASONING`) rather than the
   * classifier's, because a repair is a generation: the thinking budget is where a mermaid
   * source or a plot spec gets worked out.
   */
  reasoning?: OutOfBandReasoningSetting;
  /**
   * The turn's abort signal, when there is one. Stop after the loop has returned still has
   * to stop paying for the repair it started.
   */
  signal?: AbortSignal;
  /** Handed this call's token usage, once, when the provider reported any. */
  onUsage?: (usage: MessageUsage, durationMs: number) => void;
}

/**
 * Produce the arguments for one missing artifact, or `null` when the model refused to call
 * the tool at all. Throws for provider/configuration failures, which the caller swallows.
 */
export type ArtifactRepairer = (
  systemPrompt: string,
  userPrompt: string,
  tool: StructuredToolInterface
) => Promise<Record<string, unknown> | null>;

export function makeArtifactRepairer(input: ArtifactRepairModelInput): ArtifactRepairer {
  const { provider, modelId, reasoning = "auto" } = input;

  return async (systemPrompt, userPrompt, tool) => {
    if (!provider) throw new Error("No provider configured.");
    const model = modelId || provider.models[0]?.modelId || "";
    if (!model) throw new Error("No model configured.");
    if (!provider.apiKey) throw new Error("Provider has no API key.");

    const modelKwargs = reasoningModelKwargs(provider, model, reasoning);

    const llm = new ChatOpenAI({
      model,
      apiKey: provider.apiKey,
      configuration: { baseURL: provider.baseURL },
      temperature: 0.3,
      maxTokens: MAX_OUTPUT_TOKENS,
      maxRetries: 0,
      timeout: TIMEOUT_MS,
      streaming: true,
      ...(modelKwargs ? { modelKwargs } : {}),
    });

    // One tool, unforced — see the docblock: forcing is a 400 on a thinking-mode provider.
    const bound = llm.bindTools([tool]);

    const stream = await bound.stream(
      [new SystemMessage(systemPrompt), new HumanMessage(userPrompt)],
      { signal: input.signal }
    );

    const chunks: AIMessageChunk[] = [];
    const startedAt = Date.now();
    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    const usage = usageOfChunks(chunks);
    if (usage) input.onUsage?.(usage, Date.now() - startedAt);

    const ai = chunks.reduce((acc, c) => acc.concat(c) as AIMessageChunk);
    const args = ai.tool_calls?.[0]?.args;
    if (!args || typeof args !== "object" || Array.isArray(args)) return null;
    return args as Record<string, unknown>;
  };
}
