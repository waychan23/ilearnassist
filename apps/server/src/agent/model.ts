import { ChatOpenAI } from "@langchain/openai";
import type { SessionSettings } from "@guided-learning/shared";
import type { ProviderRecord } from "../db.js";

export interface BuiltModel {
  llm: ChatOpenAI;
  provider: ProviderRecord | undefined;
  modelId: string;
}

/** Keys providers use for chain-of-thought in the raw delta. */
const REASONING_KEYS = ["reasoning_content", "reasoning", "reasoning_text"] as const;

/**
 * Wrap `fetch` so we can read chain-of-thought straight off the wire.
 *
 * LangChain's `ChatOpenAI` **silently drops** `reasoning_content`: it appears in neither
 * `chunk.content` nor `chunk.additional_kwargs`, so there is nothing to read after
 * parsing. The server-sent events are the only place the text still exists, so we pass
 * the body through untouched and scrape the frames on the way past.
 *
 * Only `text/event-stream` responses are touched, and every byte is forwarded unchanged —
 * this observer cannot alter what the model client sees.
 */
export function createReasoningFetch(
  onReasoning: (delta: string) => void,
  baseFetch: typeof fetch = fetch
): typeof fetch {
  return async (input, init) => {
    const response = await baseFetch(input as RequestInfo | URL, init as RequestInit);
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.body || !contentType.includes("text/event-stream")) return response;

    const decoder = new TextDecoder();
    let buffer = "";

    const tapped = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(chunk);

          buffer += decoder.decode(chunk, { stream: true });
          let newline: number;
          while ((newline = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line.startsWith("data:")) continue;

            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
              const frame = JSON.parse(payload) as {
                choices?: { delta?: Record<string, unknown> }[];
              };
              const delta = frame.choices?.[0]?.delta;
              if (!delta) continue;
              for (const key of REASONING_KEYS) {
                const value = delta[key];
                if (typeof value === "string" && value) onReasoning(value);
              }
            } catch {
              // A partial frame or a non-JSON keepalive; the next chunk completes it.
            }
          }
        },
      })
    );

    return new Response(tapped, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

/**
 * Build an OpenAI-compatible ChatOpenAI instance from a resolved provider record.
 * `baseURL` + `apiKey` make this work with OpenAI, DeepSeek, Moonshot, Ollama,
 * LM Studio, vLLM or any compatible `/v1` endpoint.
 *
 * Generation parameters come from the session's settings. Each one is only passed
 * through when explicitly set, so unset values keep ChatOpenAI's own defaults rather
 * than being forced to a hardcoded value.
 */
export interface BuildModelHooks {
  /** Called with each chain-of-thought delta as it arrives off the wire. */
  onReasoning?: (delta: string) => void;
}

export function buildModel(
  provider: ProviderRecord | undefined,
  modelId: string,
  params: SessionSettings = {},
  hooks: BuildModelHooks = {}
): BuiltModel {
  if (!provider) throw new Error("No provider configured.");

  const model = modelId || provider.models[0]?.modelId || "";
  if (!model) throw new Error("No model configured.");

  if (!provider.apiKey) {
    throw new Error(
      `Provider "${provider.id}" has no API key configured. ` +
        `Add one in Settings → Providers (or config/config.yaml), then retry.`
    );
  }

  const llm = new ChatOpenAI({
    model,
    apiKey: provider.apiKey,
    configuration: {
      baseURL: provider.baseURL,
      ...(hooks.onReasoning ? { fetch: createReasoningFetch(hooks.onReasoning) } : {}),
    },
    streaming: true,
    ...(params.temperature != null ? { temperature: params.temperature } : {}),
    ...(params.topP != null ? { topP: params.topP } : {}),
    ...(params.maxTokens != null ? { maxTokens: params.maxTokens } : {}),
  });

  return { llm, provider, modelId: model };
}
