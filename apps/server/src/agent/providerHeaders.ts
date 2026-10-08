import type { ProviderRecord } from "../db.js";

/**
 * The HTTP headers a provider's requests carry, as the provider configured them.
 *
 * Both are **opt-in**, and each answers a requirement rather than a preference:
 *
 * - **`user-agent`** identifies the client. It exists because OpenCode Go's docs ask a coding
 *   agent to name itself rather than arrive as a generic SDK — but only when the provider asks
 *   for it: a provider with no `userAgent` sends no header of ours at all, and the SDK's own
 *   name goes out exactly as it did before this existed.
 * - **The configured session header** carries the conversation's provider-facing id, which is
 *   what lets a gateway route and cache per conversation. The *name* is the provider's; the
 *   value comes from `sessions.provider_session_id` (`AppDb.providerSessionIdFor`), so the same
 *   conversation presents the same id on every request, and two conversations never share one.
 *
 * A provider with no id at hand (a call with no conversation behind it) omits the session
 * header rather than inventing one. An empty map means "do not touch the request's headers".
 */
export function providerRequestHeaders(
  provider: ProviderRecord | undefined,
  providerSessionId?: string
): Record<string, string> {
  const headers: Record<string, string> = {};
  const userAgent = provider?.userAgent?.trim();
  if (userAgent) headers["user-agent"] = userAgent;
  const sessionHeader = provider?.sessionHeader?.trim();
  if (sessionHeader && providerSessionId) headers[sessionHeader] = providerSessionId;
  return headers;
}

/**
 * Overwrite the given headers on every request the client makes, then delegate.
 *
 * **A `fetch` wrapper rather than `configuration.defaultHeaders`, and that is not a
 * preference.** `@langchain/openai` runs its `defaultHeaders` through
 * `getHeadersWithUserAgent`, which *replaces* any supplied User-Agent with its own library
 * string (`langchainjs-openai/…`) — the lookup is on a capitalised key after `new Headers()`
 * has lowercased every name, so a provider's override is silently dropped and a generic SDK
 * name is what the other end sees. The docs on the other end explicitly ask for the opposite,
 * and the wire is the only layer below that rewrite.
 *
 * The wrapper is where the session header is set too, so one mechanism writes both: a header
 * on some requests and not others is exactly the routing problem the id exists to avoid.
 * Anything the SDK computed in `init` is preserved — only the named headers are replaced.
 * With nothing to set it returns the base untouched, so a provider with no headers configured
 * keeps the client it would have had anyway.
 */
export function withProviderHeaders(
  headers: Record<string, string>,
  baseFetch: typeof fetch = fetch
): typeof fetch {
  if (Object.keys(headers).length === 0) return baseFetch;
  return async (input, init) => {
    const merged = new Headers(init?.headers);
    for (const [name, value] of Object.entries(headers)) merged.set(name, value);
    return baseFetch(input, { ...init, headers: merged });
  };
}

/**
 * What `ChatOpenAI`'s `configuration` needs from a provider record.
 *
 * Structural on purpose: `openai`'s `ClientOptions` is not a dependency of this app, and the
 * object is consumed by a structural position (`configuration?: ClientOptions`), so a named
 * local shape keeps the dependency direction right while still being checked at every call
 * site. `fetch` is present exactly when something has to ride it — a configured header, or the
 * caller's own wrapper (the reasoning tap, in the main loop) — so an unconfigured provider
 * sends the request the SDK would have sent on its own.
 */
export interface ProviderClientOptions {
  baseURL: string;
  fetch?: typeof fetch;
}

export interface ProviderClientOptionsInput {
  /** The conversation's provider-facing id, from `AppDb.providerSessionIdFor`. */
  providerSessionId?: string;
  /** A wrapper the headers are applied *over* (the reasoning tap). */
  fetch?: typeof fetch;
}

/**
 * The one place a provider record becomes OpenAI client options.
 *
 * Every model construction in the app goes through this — the main loop via `buildModel`, and
 * the seven out-of-band passes directly — because headers sent on some of a conversation's
 * requests and not others is worse than none: the gateway's routing would see one conversation
 * as two. A new pass that builds `new ChatOpenAI` by hand should take this too.
 */
export function providerClientOptions(
  provider: ProviderRecord,
  input: ProviderClientOptionsInput = {}
): ProviderClientOptions {
  const headers = providerRequestHeaders(provider, input.providerSessionId);
  if (input.fetch === undefined && Object.keys(headers).length === 0) {
    return { baseURL: provider.baseURL };
  }
  return {
    baseURL: provider.baseURL,
    fetch: withProviderHeaders(headers, input.fetch),
  };
}
