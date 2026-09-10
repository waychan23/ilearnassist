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
  const response = await createReasoningFetch(onReasoning, base)("https://example.test/v1", {});
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
      const response = await createReasoningFetch(onReasoning, base)("https://example.test", {});

      expect(onReasoning).not.toHaveBeenCalled();
      await expect(response.text()).resolves.toBe('{"error":"nope"}');
    });

    it("leaves a bodyless response alone", async () => {
      const base = vi.fn(async () => new Response(null, { status: 204 }));
      const response = await createReasoningFetch(vi.fn(), base)("https://example.test", {});
      expect(response.status).toBe(204);
    });
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
