import { ChatOpenAI } from "@langchain/openai";
import type { MessageModel, SessionSettings } from "@ilearnassist/shared";
import type { ProviderRecord } from "../db.js";

export interface BuiltModel {
  llm: ChatOpenAI;
  provider: ProviderRecord | undefined;
  modelId: string;
}

/** Keys providers use for chain-of-thought in the raw delta. */
const REASONING_KEYS = ["reasoning_content", "reasoning", "reasoning_text"] as const;

/**
 * The refusal that means "you did not pass the chain of thought back".
 *
 * Matched on the provider's own words, which are stable in a way its status code is not: the
 * condition is a property of the message it just received. `providerErrors.ts` recognises the
 * same sentence for the user-facing side.
 */
const REASONING_REQUIRED = /reasoning_content[\s\S]{0,80}?must be passed back/i;

/**
 * What is sent in place of a chain of thought that was never recorded.
 *
 * **The field has to be present *and* non-empty.** That second half was learned the hard way: the
 * first version sent `""` for a message with no reasoning of its own, on the belief that an empty
 * string is a value the provider sends too — and a make-up, whose answers are a call the *server*
 * wrote and so have no reasoning behind them, kept being refused with the same
 * `must be passed back` sentence even when the model was correctly declared as a reasoning model.
 * The rule is enforced on the value, not merely on the key.
 *
 * The text is never displayed and never read back as thought — every provider treats it as opaque
 * state from its own previous turn — so it says what it is rather than inventing a reason for a
 * call the server made.
 */
const FALLBACK_REASONING = "(no reasoning was recorded for this call)";

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
/**
 * Put `reasoning_content` back on the outgoing assistant messages.
 *
 * DeepSeek's thinking mode **requires** this: every assistant message in a replayed history must
 * carry the chain of thought that produced it, or the API answers
 * `400 The reasoning_content in the thinking mode must be passed back to the API`.
 *
 * **Every** assistant message, which is the part that cost the most to learn. The documented
 * reading — and the one both this function and the local fake were built on — is "the messages
 * that carry `tool_calls`", and it is wrong in a way that is invisible to any check that shares
 * it: a request whose *plain* replies lack the field is refused, and the refusal names the field
 * without saying which message. It was pinned down by capturing a real refused request and
 * bisecting it: dropping every assistant message without the field made it pass, dropping only the
 * tool-call ones did not, and adding the field to those 18 messages turned the same request into a
 * 200.
 *
 * `@langchain/openai` cannot send the field. Its outbound converter copies only
 * `function_call`, `tool_calls` and `audio` out of `additional_kwargs`, and it strips
 * `reasoning` / `reasoning_content` / `thinking` content blocks on purpose
 * (langchainjs#11175) because other strict providers reject them. So the only place left
 * is the wire — which is where this wrapper already lives, for the same fight on the way in.
 *
 * The value is what the turn actually produced, or `FALLBACK_REASONING` where nothing was
 * recorded. The two are matched by **position**: the nth assistant message in the payload belongs
 * to the nth entry of `assistantReasoning`, which `buildHistoryMessages` fills in the same order.
 * An id could key only messages that have a tool call; an index covers the messages that do not,
 * and is the only identity those have.
 */
function withReplayedReasoning(body: unknown, assistantReasoning: readonly string[]): unknown {
  if (typeof body !== "string") return body;

  let parsed: { messages?: unknown };
  try {
    parsed = JSON.parse(body) as { messages?: unknown };
  } catch {
    return body;
  }
  if (!Array.isArray(parsed.messages)) return body;

  let at = 0;
  let changed = false;
  for (const message of parsed.messages as Record<string, unknown>[]) {
    if (!message || message.role !== "assistant") continue;

    /*
     * Only the *replayed* assistant messages have an entry: the ones this turn produces arrive
     * after them in the payload, so the array runs out — and so does a history message the caller
     * did not describe. Both fall to the marker, which is the value the provider wants where there
     * is nothing to pass back.
     */
    const recorded = assistantReasoning[at++] ?? "";
    // Not the empty string, which is what the field *means* and what the provider refuses. See
    // `FALLBACK_REASONING`.
    message.reasoning_content = recorded.trim() ? recorded : FALLBACK_REASONING;
    changed = true;
  }

  return changed ? JSON.stringify(parsed) : body;
}

export interface ReasoningFetchOptions {
  /** Called with each chain-of-thought delta as it arrives off the wire. */
  onReasoning: (delta: string) => void;
  /**
   * Reasoning to replay, **in assistant-message order** — the nth entry belongs to the nth
   * assistant message of the request.
   *
   * Absent means "do not touch the request" — which is the case for every model without
   * the `reasoning` capability, so a provider that never used the field never sees it.
   */
  replayReasoning?: readonly string[];
  baseFetch?: typeof fetch;
}

export function createReasoningFetch(options: ReasoningFetchOptions): typeof fetch {
  const { onReasoning, replayReasoning, baseFetch = fetch } = options;

  /*
   * Set the first time a provider refuses a request for this reason. The replay itself is gated on
   * the model record declaring the `reasoning` capability, and that gate is right — a provider
   * without the field rejects an unknown argument. But the gate can be *wrong about a particular
   * provider*: thinking-on-by-default models exist (DeepSeek V4) whose ids `guessCapabilities`
   * does not recognise, and the cost of that misconfiguration is every turn that replays history,
   * not a missing nicety. So a refusal teaches this wrapper what the record did not say, and the
   * rest of the turn stops paying for the failed request.
   */
  let passbackRequired = false;

  return async (input, init) => {
    let outgoing = init as RequestInit;

    const replay = (reasoning: readonly string[]): RequestInit => {
      const body = withReplayedReasoning(outgoing?.body, reasoning);
      if (body === outgoing?.body) return outgoing;
      // The body grew, so any length the SDK computed is now wrong. Dropping the header
      // lets the runtime measure the new one instead of sending a mismatched request.
      const headers = new Headers(outgoing.headers);
      headers.delete("content-length");
      return { ...outgoing, body: body as BodyInit, headers };
    };

    if (replayReasoning || passbackRequired) {
      // An empty list is the recovery's shape: every assistant message gets the field, with the
      // marker where nothing was recorded.
      outgoing = replay(replayReasoning ?? []);
    }

    let response = await baseFetch(input as RequestInfo | URL, outgoing);

    if (response.status === 400 && !passbackRequired && !replayReasoning) {
      const refusal = await response.clone().text();
      if (REASONING_REQUIRED.test(refusal)) {
        /*
         * One retry, and only of this request. The refusal names a property of the body rather
         * than of the moment, so the same request with the field echoed is the request that
         * should have gone out — and the failed one cost no tokens, because a 400 is answered
         * before the model runs.
         */
        passbackRequired = true;
        const retried = replay([]);
        if (retried !== outgoing) response = await baseFetch(input as RequestInfo | URL, retried);
      }
    }
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
  /**
   * Reasoning to put back on the replayed assistant messages, in their own order. Only supplied
   * when the model is configured with the `reasoning` capability — see `withReplayedReasoning`.
   */
  replayReasoning?: readonly string[];
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
      ...(hooks.onReasoning || hooks.replayReasoning
        ? {
            fetch: createReasoningFetch({
              onReasoning: hooks.onReasoning ?? (() => {}),
              replayReasoning: hooks.replayReasoning,
            }),
          }
        : {}),
    },
    streaming: true,
    ...(params.temperature != null ? { temperature: params.temperature } : {}),
    ...(params.topP != null ? { topP: params.topP } : {}),
    ...(params.maxTokens != null ? { maxTokens: params.maxTokens } : {}),
  });

  return { llm, provider, modelId: model };
}

/**
 * Which model a call is about to use, as a record — the one place the two names are resolved.
 *
 * `modelId` here is the **wire** name (`ModelDef.modelId`), because that is what identifies a
 * model to a provider and what every call site already carries. The *display* name lives beside
 * it in the provider record, and both writers that need this — a message's provenance and a usage
 * ledger row — take it from here so the two can never disagree about which model ran.
 *
 * A model the provider record no longer lists keeps its wire name as its display name rather than
 * becoming blank: a turn that ran against a since-deleted model is exactly the kind of thing a
 * transcript should still be able to say.
 */
export function describeModel(
  provider: ProviderRecord | undefined,
  modelId: string
): MessageModel | undefined {
  if (!provider || !modelId) return undefined;
  const known = provider.models.find((m) => m.modelId === modelId);
  return {
    providerId: provider.id,
    providerName: provider.name,
    modelId,
    modelName: known?.name || modelId,
  };
}
