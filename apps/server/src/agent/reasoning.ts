import type { ProviderRecord } from "../db.js";
import type { OutOfBandReasoningSetting } from "../config.js";

/**
 * The `thinking` body field for an out-of-band call, capability-gated.
 *
 * Shared by the thread classifier and the insight pass rather than written twice, because the
 * *gate* is the part that carries the risk and the two would drift on it: an unknown body field
 * is a 400 on a strict OpenAI-compatible endpoint, so the field may be sent only to a model whose
 * record declares the `reasoning` capability — the same gate `buildHistoryMessages` uses for
 * replaying `reasoning_content`, and the same shape as the two switches themselves.
 *
 * `auto` sends **nothing**, which is not the same as sending `enabled`: the provider's own
 * default then stands, and thinking is ON by default for DeepSeek V4. Forcing it on would be a
 * second opinion about what `auto` means.
 */
export function reasoningModelKwargs(
  provider: ProviderRecord | undefined,
  modelId: string,
  setting: OutOfBandReasoningSetting
): { thinking: { type: "disabled" | "enabled" } } | undefined {
  if (setting === "auto") return undefined;
  const model = modelId || provider?.models[0]?.modelId || "";
  const declaresReasoning = provider?.models.some(
    (m) => m.modelId === model && m.capabilities.includes("reasoning")
  );
  if (!declaresReasoning) return undefined;
  return { thinking: { type: setting === "off" ? "disabled" : "enabled" } };
}
