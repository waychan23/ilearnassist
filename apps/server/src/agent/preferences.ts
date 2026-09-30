import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, SystemMessage, type AIMessageChunk } from "@langchain/core/messages";
import type { MessageUsage, UserPreference } from "@ilearnassist/shared";
import { usageOfChunks } from "./callUsage.js";
import { reasoningModelKwargs } from "./reasoning.js";
import type { ProviderRecord } from "../db.js";
import type { OutOfBandReasoningSetting } from "../config.js";
import { formatPreferences } from "../preferences.js";
import { renderPrompt } from "../prompts.js";

/**
 * The manual preference extraction's out-of-band call: the selection action "作为用户偏好" turns one
 * selected passage into one stored rule.
 *
 * A **direct structural copy of the insight pass's call** (`makeInsightGenerator`), because a
 * reasoning model is the same risk here as there: a non-streaming call buffers its whole thinking
 * run before the first byte, so the HTTP timeout would bound *thinking* rather than an idle
 * connection. Streaming with a generous backstop and a generous output budget is the shape that
 * survives a thinking model, and this call is small enough that the budget is only ever spent on
 * chain-of-thought.
 *
 * The prompt is `preference.system`; the caller parses the answer with `parseExtractedPreference`.
 * Transport only, like the other `agent/*` passes: which passages exist and what a saved answer
 * writes are `preferences.ts`'s business.
 */
const MAX_OUTPUT_TOKENS = 4_096;
const TIMEOUT_MS = 60_000;

export interface ExtractPreferenceInput {
  provider: ProviderRecord | undefined;
  modelId: string;
  /** The passage the user pointed at, verbatim. */
  text: string;
  /**
   * The preferences already stored for this conversation, so the model can decide what the new
   * rule supersedes. The same rows the injected block renders, ids included.
   */
  existing: readonly UserPreference[];
  /** Whether this call may run chain-of-thought — `ILA_PREFERENCE_REASONING`. See `reasoning.ts`. */
  reasoning?: OutOfBandReasoningSetting;
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

/** Run the extraction call and return the model's raw answer; the caller parses it. */
export async function extractPreference(input: ExtractPreferenceInput): Promise<string> {
  const { provider, modelId, reasoning = "auto" } = input;
  if (!provider) throw new Error("No provider configured.");
  const model = modelId || provider.models[0]?.modelId || "";
  if (!model) throw new Error("No model configured.");
  if (!provider.apiKey) throw new Error("Provider has no API key.");

  const modelKwargs = reasoningModelKwargs(provider, model, reasoning);
  const llm = new ChatOpenAI({
    model,
    apiKey: provider.apiKey,
    configuration: { baseURL: provider.baseURL },
    // Extraction is closer to classification than to writing: the rule should come out the same
    // way every time.
    temperature: 0.2,
    maxTokens: MAX_OUTPUT_TOKENS,
    maxRetries: 0,
    timeout: TIMEOUT_MS,
    streaming: true,
    ...(modelKwargs ? { modelKwargs } : {}),
  });

  const existing = input.existing.length
    ? formatPreferences(input.existing)
    : "(none stored yet)";
  const payload =
    `<passage>\n${input.text}\n</passage>\n\n` +
    `<existing_preferences>\n${existing}\n</existing_preferences>`;

  // Read at call time rather than captured in a module constant, so a
  // `<dataRoot>/config.patch.json` override takes effect — the patch is applied by the process
  // entry point, which runs after this module has been evaluated.
  const stream = await llm.stream([
    new SystemMessage(renderPrompt("preference.system")),
    new HumanMessage(payload),
  ]);

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
}
