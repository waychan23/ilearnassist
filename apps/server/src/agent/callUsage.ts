import type { AIMessage, AIMessageChunk } from "@langchain/core/messages";
import type { MessageUsage } from "@ilearnassist/shared";

/**
 * What one model response cost, read off the wire's own report.
 *
 * **The one place `usage_metadata` becomes a `MessageUsage`.** Six call sites need this — the
 * agent loop and the five out-of-band passes — and they arrive in two shapes: a buffered
 * `.invoke()` hands back a message, a `.stream()` hands back chunks. Two mappings would be two
 * chances for the ledger and the transcript to disagree about what a provider reported, and the
 * field names here are the provider's, not ours, which is exactly the kind of thing that drifts.
 *
 * Returns `null` when the provider reported nothing, rather than an all-zero object: "this
 * provider does not report usage" and "this call was free" are different claims, and only one of
 * them may be summed.
 */
export function usageOfMessage(message: AIMessage): MessageUsage | null {
  return fromMetadata(message.usage_metadata);
}

/**
 * The same, for a streamed call.
 *
 * Read from the **chunks** rather than from their concatenation, and that is not a stylistic
 * choice: `AIMessageChunk.concat` does not carry `usage_metadata` through its reduce (the loop's
 * own comment records the same finding), so a concatenated message always reports none. Providers
 * attach it to a dedicated final chunk, so the last one that has any is the answer.
 */
export function usageOfChunks(chunks: readonly AIMessageChunk[]): MessageUsage | null {
  for (let i = chunks.length - 1; i >= 0; i--) {
    const metadata = chunks[i]?.usage_metadata;
    if (metadata) return fromMetadata(metadata);
  }
  return null;
}

/** `usage_metadata` into the app's own shape, or null when there is nothing to read. */
function fromMetadata(metadata: AIMessage["usage_metadata"]): MessageUsage | null {
  if (!metadata) return null;
  const usage: MessageUsage = {
    inputTokens: metadata.input_tokens ?? 0,
    outputTokens: metadata.output_tokens ?? 0,
    totalTokens: metadata.total_tokens ?? 0,
    // A *subset* of the input, which is why it is recorded beside it rather than subtracted here:
    // the split is derived where it is read, so the two can never contradict each other.
    cachedInputTokens: metadata.input_token_details?.cache_read ?? 0,
    // Likewise a share of the output. `0` when a provider does not break it out, which the
    // ledger renders as "not reported" by being absent from every bucket it did report.
    reasoningTokens: metadata.output_token_details?.reasoning ?? 0,
  };
  return usage;
}
