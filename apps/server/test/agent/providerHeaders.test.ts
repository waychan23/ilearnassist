import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROVIDER_USER_AGENT,
  isValidProviderHeaderName,
  isValidProviderUserAgent,
  MAX_PROVIDER_USER_AGENT_LENGTH,
} from "@ilearnassist/shared";
import {
  providerClientOptions,
  providerRequestHeaders,
  withProviderHeaders,
} from "../../src/agent/providerHeaders.js";
import type { ProviderRecord } from "../../src/db.js";

function provider(overrides: Partial<ProviderRecord> = {}): ProviderRecord {
  return {
    id: "p1",
    name: "P",
    baseURL: "https://api.example.test/v1",
    apiKey: "k",
    models: [],
    ...overrides,
  };
}

describe("providerRequestHeaders", () => {
  it("sends nothing of ours when the provider configured nothing", () => {
    // The SDK's own headers go out untouched — sending a User-Agent is opt-in.
    expect(providerRequestHeaders(provider())).toEqual({});
  });

  it("sends nothing of ours even with no provider at all", () => {
    expect(providerRequestHeaders(undefined)).toEqual({});
  });

  it("sends the provider's User-Agent, trimmed", () => {
    expect(providerRequestHeaders(provider({ userAgent: "  my-agent/1.0  " }))).toEqual({
      "user-agent": "my-agent/1.0",
    });
  });

  it("sends no user-agent for a whitespace-only override", () => {
    expect(providerRequestHeaders(provider({ userAgent: "   " }))).toEqual({});
  });

  it("adds the session header with the conversation's id", () => {
    expect(
      providerRequestHeaders(provider({ sessionHeader: "x-opencode-session" }), "ext-1")
    ).toEqual({ "x-opencode-session": "ext-1" });
  });

  it("carries both when both are configured", () => {
    expect(
      providerRequestHeaders(
        provider({ userAgent: "my-agent/1.0", sessionHeader: "x-session" }),
        "ext-1"
      )
    ).toEqual({ "user-agent": "my-agent/1.0", "x-session": "ext-1" });
  });

  it("omits the session header when no id is at hand", () => {
    const headers = providerRequestHeaders(provider({ sessionHeader: "x-opencode-session" }));
    expect(headers).not.toHaveProperty("x-opencode-session");
  });

  it("omits the session header when no name is configured", () => {
    const headers = providerRequestHeaders(provider(), "ext-1");
    expect(headers).not.toHaveProperty("ext-1");
    expect(Object.keys(headers)).toEqual([]);
  });
});

describe("withProviderHeaders", () => {
  it("returns the base fetch untouched when there is nothing to set", () => {
    const base = (() => Promise.resolve(new Response())) as typeof fetch;
    expect(withProviderHeaders({}, base)).toBe(base);
  });
});

describe("providerClientOptions", () => {
  it("assembles baseURL and a fetch that sets the headers on the wire", async () => {
    const sent: { url: unknown; headers: Headers }[] = [];
    const base = (async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ url: input, headers: new Headers(init?.headers) });
      return new Response();
    }) as typeof fetch;

    const options = providerClientOptions(
      provider({ userAgent: DEFAULT_PROVIDER_USER_AGENT, sessionHeader: "x-session" }),
      { providerSessionId: "ext-9", fetch: base }
    );
    expect(options.baseURL).toBe("https://api.example.test/v1");
    expect(options.fetch).toBeDefined();

    await options.fetch!("https://x.test/chat/completions", {
      headers: { "content-type": "application/json" },
    });

    const headers = sent[0]!.headers;
    expect(headers.get("user-agent")).toBe(DEFAULT_PROVIDER_USER_AGENT);
    expect(headers.get("x-session")).toBe("ext-9");
    // Whatever the SDK computed is preserved — only the named headers are replaced.
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("installs a wrapper when a header is configured and the caller has no fetch of its own", () => {
    expect(typeof providerClientOptions(provider({ userAgent: "agent/1" })).fetch).toBe("function");
    expect(
      typeof providerClientOptions(provider({ sessionHeader: "x-session" }), {
        providerSessionId: "ext-1",
      }).fetch
    ).toBe("function");
  });

  it("installs no wrapper for a session header with no id at hand", () => {
    // Nothing to send, so the request is the SDK's own.
    expect(
      providerClientOptions(provider({ sessionHeader: "x-session" }))
    ).not.toHaveProperty("fetch");
  });

  it("omits fetch when there is nothing to set and no base wrapper", () => {
    // An unconfigured provider gets the client the SDK would have built on its own.
    expect(providerClientOptions(provider())).not.toHaveProperty("fetch");
    expect(providerClientOptions(provider(), { providerSessionId: "ext-1" })).not.toHaveProperty(
      "fetch"
    );
  });

  it("keeps the caller's base fetch when there is nothing to set", () => {
    const base = (() => Promise.resolve(new Response())) as typeof fetch;
    expect(providerClientOptions(provider(), { fetch: base }).fetch).toBe(base);
  });
});

describe("isValidProviderHeaderName", () => {
  it("accepts ordinary token names, case-insensitively", () => {
    expect(isValidProviderHeaderName("x-opencode-session")).toBe(true);
    expect(isValidProviderHeaderName("X-Conversation-Id")).toBe(true);
    expect(isValidProviderHeaderName("x_session_1")).toBe(true);
  });

  it("trims before judging", () => {
    expect(isValidProviderHeaderName("  x-session  ")).toBe(true);
  });

  it.each(["", "   ", "x session", "x-session\n", "session:id", "会话"])(
    "refuses %j",
    (name) => {
      expect(isValidProviderHeaderName(name)).toBe(false);
    }
  );

  it.each(["authorization", "Authorization", "content-type", "host", "user-agent", "cookie"])(
    "refuses the reserved name %s",
    (name) => {
      expect(isValidProviderHeaderName(name)).toBe(false);
    }
  );
});

describe("isValidProviderUserAgent", () => {
  it("accepts a single reasonable line", () => {
    expect(isValidProviderUserAgent("ilearnassist/1.0")).toBe(true);
    expect(isValidProviderUserAgent("my-agent/2.0 (extra; info)")).toBe(true);
  });

  it("refuses an empty value — callers treat blank as 'clear the override'", () => {
    expect(isValidProviderUserAgent("")).toBe(false);
    expect(isValidProviderUserAgent("   ")).toBe(false);
  });

  it("refuses a value that spans lines", () => {
    expect(isValidProviderUserAgent("a\r\nx-evil: 1")).toBe(false);
    expect(isValidProviderUserAgent("a\nb")).toBe(false);
  });

  it("refuses a value past the cap", () => {
    expect(isValidProviderUserAgent("a".repeat(MAX_PROVIDER_USER_AGENT_LENGTH))).toBe(true);
    expect(isValidProviderUserAgent("a".repeat(MAX_PROVIDER_USER_AGENT_LENGTH + 1))).toBe(false);
  });
});
