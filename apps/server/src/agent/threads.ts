import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { ProviderRecord } from "../db.js";
import type { ThreadClassifier } from "../threads.js";

/**
 * Output budget. The answer is one tiny JSON object per turn, but a reasoning model spends
 * the budget on chain-of-thought FIRST — observed on a real five-turn backfill: 2048 tokens
 * bought 27s of thinking and zero content (`finish_reason: length`, empty answer). So this
 * has to cover a long unseen reasoning run plus the JSON, even though the JSON itself is
 * tiny. Kept finite so a runaway thinker is still cut.
 */
const MAX_OUTPUT_TOKENS = 8_192;

/**
 * Request timeout.
 *
 * Sixty seconds rather than the titler's twenty for a concrete reason observed in
 * `threads.log`: a non-streaming call to a reasoning model buffers its whole thinking run
 * before the first byte, and healthy-but-slow responses were already taking 14–18s before
 * provider congestion pushed every call past 20s. Streaming (below) makes the timeout
 * effectively time-to-first-chunk rather than time-to-full-answer; this is the backstop.
 */
const TIMEOUT_MS = 60_000;

export interface ThreadModelInput {
  provider: ProviderRecord | undefined;
  modelId: string;
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
 * Build the out-of-band classifier call for one session, reusing the conversation's resolved
 * provider/model (the same inputs the auto-titler gets). Best-effort and a failure only
 * leaves messages unassigned for the next sync — it must never fail a chat turn.
 *
 * **Streaming, unlike the titler.** The main loop streams for the reason a buffered call
 * dies here: a reasoning model emits chain-of-thought chunks for a long time before the
 * answer, and the HTTP client's timeout bounds an idle connection rather than a thinking
 * run once bytes keep arriving. The answer is still assembled into one string — callers
 * cannot tell the mode apart.
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
      timeout: TIMEOUT_MS,
      streaming: true,
    });

    // Fenced so the conversation excerpt is data, never instructions.
    const stream = await llm.stream([
      new SystemMessage(systemPrompt),
      new HumanMessage(`<conversation>\n${userPrompt}\n</conversation>`),
    ]);

    let text = "";
    for await (const chunk of stream) {
      text += chunkText(chunk);
    }
    return text;
  };
}
