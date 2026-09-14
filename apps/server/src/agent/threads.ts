import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { ProviderRecord } from "../db.js";
import type { ThreadClassifier } from "../threads.js";

/**
 * Output budget. The answer is one tiny JSON object per turn, so this is generous on purpose —
 * the same lesson as `agent/title.ts`: reasoning models spend the budget on chain-of-thought
 * before emitting anything, and a tight cap answers with `finish_reason: "length"` and no JSON.
 */
const MAX_OUTPUT_TOKENS = 2_048;

export interface ThreadModelInput {
  provider: ProviderRecord | undefined;
  modelId: string;
}

/**
 * Build the out-of-band classifier call for one session, reusing the conversation's resolved
 * provider/model (the same inputs the auto-titler gets). Non-streaming, no retries, a short
 * timeout: classification is best-effort and a failure only leaves messages unassigned for the
 * next sync — it must never fail a chat turn.
 */
export function makeThreadClassifier(input: ThreadModelInput): ThreadClassifier {
  const { provider, modelId } = input;
  return async (systemPrompt: string, userPrompt: string): Promise<string> => {
    if (!provider) throw new Error("No provider configured.");
    const model = modelId || provider.models[0]?.modelId || "";
    if (!model) throw new Error("No model configured.");
    if (!provider.apiKey) throw new Error("Provider has no API key.");

    const llm = new ChatOpenAI({
      model,
      apiKey: provider.apiKey,
      configuration: { baseURL: provider.baseURL },
      // Classification: determinism beats creativity.
      temperature: 0.1,
      maxTokens: MAX_OUTPUT_TOKENS,
      maxRetries: 0,
      timeout: 20_000,
    });

    const response = await llm.invoke([
      new SystemMessage(systemPrompt),
      // Fenced so the conversation excerpt is data, never instructions.
      new HumanMessage(`<conversation>\n${userPrompt}\n</conversation>`),
    ]);

    return typeof response.content === "string"
      ? response.content
      : Array.isArray(response.content)
        ? response.content
            .map((b) => (b && typeof b === "object" && "text" in b ? String(b.text) : ""))
            .join("")
        : "";
  };
}
