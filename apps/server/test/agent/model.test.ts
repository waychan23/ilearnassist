import { describe, expect, it, vi } from "vitest";
import { buildModel, createReasoningFetch } from "../../src/agent/model.js";
import type { ProviderRecord } from "../../src/db.js";

/**
 * `createReasoningFetch` is an observer bolted onto the wire, so it has two jobs: pull
 * chain-of-thought out of the raw frames, and change nothing about what the model client
 * sees. Both are asserted here.
 */

function sseResponse(chunks: string[], contentType = "text/event-stream"): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": contentType } });
}

function frame(delta: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`;
}

/** Run the tap over the given chunks and return what it collected plus the forwarded body. */
async function tap(chunks: string[], contentType?: string) {
  const onReasoning = vi.fn();
  const base = vi.fn(async () => sseResponse(chunks, contentType));
  const response = await createReasoningFetch({ onReasoning, baseFetch: base })("https://example.test/v1", {});
  const body = await response.text(); // consuming drives the transform
  return { onReasoning, body, response };
}

describe("createReasoningFetch", () => {
  it("reports reasoning_content deltas", async () => {
    const { onReasoning } = await tap([frame({ reasoning_content: "think " }), frame({ reasoning_content: "more" })]);
    expect(onReasoning.mock.calls.map((c) => c[0])).toEqual(["think ", "more"]);
  });

  it.each(["reasoning", "reasoning_text"])("reports the %s delta key", async (key) => {
    const { onReasoning } = await tap([frame({ [key]: "quiet" })]);
    expect(onReasoning).toHaveBeenCalledWith("quiet");
  });

  it("reports every reasoning key present in one frame", async () => {
    const { onReasoning } = await tap([frame({ reasoning_content: "a", reasoning: "b" })]);
    expect(onReasoning.mock.calls.map((c) => c[0])).toEqual(["a", "b"]);
  });

  it("ignores frames that carry no reasoning", async () => {
    const { onReasoning } = await tap([frame({ content: "just an answer" })]);
    expect(onReasoning).not.toHaveBeenCalled();
  });

  describe("framing", () => {
    it("reassembles a frame split across chunks", async () => {
      const whole = frame({ reasoning_content: "split" });
      const { onReasoning } = await tap([whole.slice(0, 12), whole.slice(12)]);
      expect(onReasoning).toHaveBeenCalledWith("split");
    });

    it("handles several frames in one chunk", async () => {
      const { onReasoning } = await tap([frame({ reasoning_content: "a" }) + frame({ reasoning_content: "b" })]);
      expect(onReasoning.mock.calls.map((c) => c[0])).toEqual(["a", "b"]);
    });

    it("ignores the [DONE] sentinel and keepalives", async () => {
      const { onReasoning } = await tap([
        ": keepalive\n\n",
        "data: [DONE]\n\n",
        "data: \n\n",
        "event: done\n\n",
        frame({ reasoning_content: "after" }),
      ]);
      expect(onReasoning).toHaveBeenCalledTimes(1);
      expect(onReasoning).toHaveBeenCalledWith("after");
    });

    it("survives a malformed JSON frame", async () => {
      const { onReasoning } = await tap(["data: {not json}\n\n", frame({ reasoning_content: "still here" })]);
      expect(onReasoning).toHaveBeenCalledWith("still here");
    });

    it("ignores a frame with no choices", async () => {
      const { onReasoning } = await tap(['data: {"usage":{"total_tokens":1}}\n\n']);
      expect(onReasoning).not.toHaveBeenCalled();
    });
  });

  describe("transparency", () => {
    it("forwards the response body byte for byte", async () => {
      const chunks = [frame({ reasoning_content: "x" }), "data: [DONE]\n\n"];
      const { body } = await tap(chunks);
      // The observer must not alter what the model client parses.
      expect(body).toBe(chunks.join(""));
    });

    it("wraps the response in an equivalent one", async () => {
      const { response } = await tap([frame({ content: "hi" })]);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
    });

    it("leaves a non-SSE response completely untouched", async () => {
      const base = vi.fn(async () => new Response('{"error":"nope"}', { headers: { "content-type": "application/json" } }));
      const onReasoning = vi.fn();
      const response = await createReasoningFetch({ onReasoning, baseFetch: base })("https://example.test", {});

      expect(onReasoning).not.toHaveBeenCalled();
      await expect(response.text()).resolves.toBe('{"error":"nope"}');
    });

    it("leaves a bodyless response alone", async () => {
      const base = vi.fn(async () => new Response(null, { status: 204 }));
      const response = await createReasoningFetch({ onReasoning: vi.fn(), baseFetch: base })("https://example.test", {});
      expect(response.status).toBe(204);
    });
  });
});

describe("replaying reasoning_content", () => {
  /** The body the wrapper actually sends on, as parsed JSON. */
  async function sendThrough(
    body: string,
    replayReasoning?: Map<string, string>
  ): Promise<Record<string, unknown>> {
    const base = vi.fn(async (_url: unknown, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(null, { status: 204 });
    });
    let captured: Record<string, unknown> = {};
    await createReasoningFetch({ onReasoning: vi.fn(), replayReasoning, baseFetch: base as unknown as typeof fetch })(
      "https://example.test/v1",
      { method: "POST", body, headers: { "content-type": "application/json", "content-length": "1" } }
    );
    return captured;
  }

  const request = JSON.stringify({
    messages: [
      { role: "system", content: "s" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "先问一句。", tool_calls: [{ id: "call_ask", type: "function" }] },
      { role: "tool", content: "{}", tool_call_id: "call_ask" },
    ],
  });

  it("puts the recorded chain of thought back on a tool-call message", async () => {
    // DeepSeek's thinking mode answers 400 without it. LangChain cannot send the field at
    // all, so this wrapper is the only place it can be put back.
    const sent = await sendThrough(request, new Map([["call_ask", "the thinking"]]))

    const messages = sent.messages as Record<string, unknown>[];
    expect(messages[2]).toMatchObject({ reasoning_content: "the thinking" });
    // A plain turn needs nothing, and must not be given anything.
    expect(messages[1]).not.toHaveProperty("reasoning_content");
    expect(messages[0]).not.toHaveProperty("reasoning_content");
  });

  it("sends an empty string when the turn recorded no reasoning", async () => {
    // The field has to be *present*: an empty string is a value DeepSeek sends itself, and
    // "no reasoning recorded" is not the same as "do not send the field".
    const sent = await sendThrough(request, new Map());

    expect((sent.messages as Record<string, unknown>[])[2]).toMatchObject({ reasoning_content: "" });
  });

  it("does not touch the request when the model is not a reasoning model", async () => {
    // No map means no rewrite, which is how a provider that never used the field is kept
    // from ever seeing it.
    const sent = await sendThrough(request, undefined);

    expect(sent).toEqual(JSON.parse(request));
  });

  it("drops the stale content-length, which the rewrite would invalidate", async () => {
    const headers: Headers[] = [];
    const base = vi.fn(async (_url: unknown, init?: RequestInit) => {
      headers.push(new Headers(init?.headers));
      return new Response(null, { status: 204 });
    });
    await createReasoningFetch({
      onReasoning: vi.fn(),
      replayReasoning: new Map([["call_ask", "x".repeat(200)]]),
      baseFetch: base as unknown as typeof fetch,
    })("https://example.test/v1", { method: "POST", body: request, headers: { "content-length": "1" } });

    expect(headers[0]!.get("content-length")).toBeNull();
  });

  it("forwards a body it cannot parse rather than dropping the turn", async () => {
    const base = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.body).toBe("not json");
      return new Response(null, { status: 204 });
    });
    await createReasoningFetch({
      onReasoning: vi.fn(),
      replayReasoning: new Map([["call_ask", "x"]]),
      baseFetch: base as unknown as typeof fetch,
    })("https://example.test/v1", { method: "POST", body: "not json" });

    expect(base).toHaveBeenCalled();
  });
});

describe("buildModel", () => {
  const provider: ProviderRecord = {
    id: "p",
    name: "P",
    baseURL: "https://api.example.test/v1",
    apiKey: "k",
    models: [],
  };

  it("rejects a missing provider", () => {
    expect(() => buildModel(undefined, "m")).toThrow(/No provider configured/);
  });

  it("rejects a provider with no API key", () => {
    expect(() => buildModel({ ...provider, apiKey: undefined }, "m")).toThrow(/no API key configured/);
  });

  it("rejects when there is no model to use", () => {
    expect(() => buildModel(provider, "")).toThrow(/No model configured/);
  });

  it("falls back to the provider's first model", () => {
    const built = buildModel(
      { ...provider, models: [{ id: "r1", modelId: "fallback-model", name: "F", capabilities: [] }] },
      ""
    );
    expect(built.modelId).toBe("fallback-model");
  });

  it("applies only the generation parameters that were set", () => {
    // Unset values must keep ChatOpenAI's own defaults rather than being forced.
    const bare = buildModel(provider, "m");
    expect(bare.llm.temperature).toBeUndefined();
    expect(bare.llm.maxTokens).toBeUndefined();

    const tuned = buildModel(provider, "m", { temperature: 0.4, topP: 0.9, maxTokens: 256 });
    expect(tuned.llm.temperature).toBe(0.4);
    expect(tuned.llm.topP).toBe(0.9);
    expect(tuned.llm.maxTokens).toBe(256);
  });

  it("installs the reasoning fetch only when a hook is supplied", () => {
    expect(() => buildModel(provider, "m")).not.toThrow();
    expect(() => buildModel(provider, "m", {}, { onReasoning: vi.fn() })).not.toThrow();
  });
});
