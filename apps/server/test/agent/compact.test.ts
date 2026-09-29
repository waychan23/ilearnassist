import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  applyContextSummary,
  compactTranscript,
  compactUserContent,
  COMPACT_MESSAGE_MAX_CHARS,
  renderCompactMessage,
  splitCompactChunks,
  summarizeContext,
  type CompactMessage,
} from "../../src/agent/compact.js";
import type { ProviderRecord } from "../../src/db.js";
import { startFakeLlm, type FakeLlm } from "../helpers/fakeLlm.js";

/**
 * Context compaction's two halves.
 *
 * The pure half is tested without a model at all — the arithmetic that decides what a turn
 * sends must be provable on its own, and it is the part a regression would silently corrupt.
 * The call half runs against the fake LLM, so the *real* `ChatOpenAI` path and the fold's
 * request shapes are what the assertions see.
 */

const said = (role: string, content: string): CompactMessage => ({ role, content });

describe("renderCompactMessage", () => {
  it("fences a message under its role", () => {
    expect(renderCompactMessage(said("user", "什么是递归"))).toBe("<user>\n什么是递归\n</user>");
  });

  it("keeps tool outputs under their own tag, clipped tighter than the message", () => {
    const rendered = renderCompactMessage({
      role: "assistant",
      content: "reading it",
      toolCalls: [{ name: "read_document", output: "x".repeat(2_000) }],
    });
    expect(rendered).toContain("<tool name=\"read_document\">");
    expect(rendered).toContain("…");
    expect(rendered.length).toBeLessThan(COMPACT_MESSAGE_MAX_CHARS + 100);
  });

  it("skips calls with no recorded output rather than claiming one", () => {
    const rendered = renderCompactMessage({
      role: "assistant",
      content: "",
      toolCalls: [{ name: "ask_user" }],
    });
    expect(rendered).not.toContain("ask_user");
    expect(rendered).toBe("<assistant></assistant>");
  });

  it("clips one enormous message so it cannot crowd out the rest", () => {
    const rendered = renderCompactMessage(said("user", "x".repeat(COMPACT_MESSAGE_MAX_CHARS * 3)));
    expect(rendered.length).toBeLessThan(COMPACT_MESSAGE_MAX_CHARS + 100);
    expect(rendered.endsWith("…\n</user>")).toBe(true);
  });
});

describe("compactTranscript", () => {
  it("keeps the order and fences the whole slice", () => {
    expect(compactTranscript([said("user", "q"), said("assistant", "a")])).toBe(
      "<user>\nq\n</user>\n<assistant>\na\n</assistant>"
    );
  });
});

describe("splitCompactChunks", () => {
  it("keeps everything in one chunk while it fits", () => {
    expect(splitCompactChunks([said("user", "q"), said("assistant", "a")], 1_000)).toHaveLength(1);
  });

  it("starts a new chunk when the next message would pass the budget", () => {
    const chunks = splitCompactChunks(
      [said("user", "a".repeat(600)), said("assistant", "b".repeat(600))],
      1_000
    );
    expect(chunks.map((c) => c.length)).toEqual([1, 1]);
  });

  it("gives an oversized message a chunk of its own", () => {
    // With the shipped caps a message can never *exceed* the chunk budget (the per-message cap
    // is far below it), so the call is exercised with a budget smaller than one rendered
    // message — the shape the guard exists for. Splitting a message would cut a tag in half.
    const oversized = said("user", "a".repeat(COMPACT_MESSAGE_MAX_CHARS * 2));
    const chunks = splitCompactChunks([oversized, said("assistant", "end")], 1_000);
    expect(chunks.map((c) => c.length)).toEqual([1, 1]);
  });
});

describe("compactUserContent", () => {
  it("omits the previous summary entirely on a first compression", () => {
    const content = compactUserContent("", "<conversation>x</conversation>");
    expect(content).not.toContain("previous_summary");
    expect(content).toContain("<conversation>");
  });

  it("folds a previous summary in, fenced as data", () => {
    const content = compactUserContent("earlier things", "<conversation>x</conversation>");
    expect(content).toContain("<previous_summary>\nearlier things\n</previous_summary>");
  });
});

describe("applyContextSummary", () => {
  const messages = [
    { id: "m1", createdAt: "2026-01-01T00:00:01.000Z" },
    { id: "m2", createdAt: "2026-01-01T00:00:02.000Z" },
    { id: "m3", createdAt: "2026-01-01T00:00:03.000Z" },
  ];

  it("returns the messages after the point, by id", () => {
    expect(
      applyContextSummary(messages, { throughMessageId: "m1", throughCreatedAt: messages[0]!.createdAt })
    ).toEqual([messages[1], messages[2]]);
  });

  it("returns nothing when the point is the last message", () => {
    expect(
      applyContextSummary(messages, { throughMessageId: "m3", throughCreatedAt: messages[2]!.createdAt })
    ).toEqual([]);
  });

  it("falls back to the timestamp when the point itself was deleted", () => {
    // The point is gone from the live list, which is exactly why the summary carries a time.
    expect(
      applyContextSummary(messages, {
        throughMessageId: "gone",
        throughCreatedAt: "2026-01-01T00:00:01.000Z",
      })
    ).toEqual([messages[1], messages[2]]);
  });

  it("excludes a message at exactly the point's instant when falling back", () => {
    expect(
      applyContextSummary([{ id: "other", createdAt: "2026-01-01T00:00:01.000Z" }], {
        throughMessageId: "gone",
        throughCreatedAt: "2026-01-01T00:00:01.000Z",
      })
    ).toEqual([]);
  });
});

describe("summarizeContext", () => {
  let llm: FakeLlm;

  beforeAll(async () => {
    llm = await startFakeLlm({ title: "A compressed summary." });
  });

  afterAll(async () => {
    await llm.close();
  });

  afterEach(() => {
    llm.reset();
    llm.setTitle("A compressed summary.");
  });

  const provider = (overrides: Partial<ProviderRecord> = {}): ProviderRecord => ({
    id: "fake",
    name: "Fake",
    baseURL: llm.baseURL,
    apiKey: "test-key",
    models: [],
    ...overrides,
  });

  it("sends the fenced conversation to the compactor prompt and returns its answer", async () => {
    const summary = await summarizeContext({
      provider: provider(),
      modelId: "fake-model",
      messages: [said("user", "什么是递归"), said("assistant", "递归是…")],
    });
    expect(summary).toBe("A compressed summary.");

    const sent = llm.requests()[0] as {
      stream?: boolean;
      messages: { role: string; content: string }[];
    };
    expect(sent.stream).toBeFalsy();
    expect(sent.messages[0]!.content).toContain("context-compression function");
    expect(sent.messages[1]!.content).toContain("<conversation>");
    expect(sent.messages[1]!.content).toContain("<user>\n什么是递归\n</user>");
  });

  it("folds a previous summary into the first call", async () => {
    await summarizeContext({
      provider: provider(),
      modelId: "fake-model",
      messages: [said("user", "one more thing")],
      previous: "what came before",
    });
    const sent = llm.requests()[0] as { messages: { content: string }[] };
    expect(sent.messages[1]!.content).toContain("<previous_summary>\nwhat came before\n</previous_summary>");
  });

  it("feeds each chunk the running summary", async () => {
    // Each message is clipped to `COMPACT_MESSAGE_MAX_CHARS`, so passing the chunk budget takes
    // enough of them: the first chunk fills, and the rest starts a second call.
    const big = "x".repeat(COMPACT_MESSAGE_MAX_CHARS);
    const messages = Array.from({ length: 14 }, () => said("user", big));
    messages.push(said("user", "the newest words"));

    const summary = await summarizeContext({
      provider: provider(),
      modelId: "fake-model",
      messages,
    });

    expect(llm.requests()).toHaveLength(2);
    expect(summary).toBe("A compressed summary.");
    const first = llm.requests()[0] as { messages: { content: string }[] };
    const second = llm.requests()[1] as { messages: { content: string }[] };
    expect(first.messages[1]!.content).not.toContain("previous_summary");
    // The second call starts from the first call's answer, not from the raw messages alone.
    expect(second.messages[1]!.content).toContain(
      "<previous_summary>\nA compressed summary.\n</previous_summary>"
    );
    expect(second.messages[1]!.content).toContain("the newest words");
  });

  it("reports one call's usage at a time", async () => {
    const seen: { inputTokens?: number; outputTokens?: number; durationMs: number }[] = [];
    await summarizeContext({
      provider: provider(),
      modelId: "fake-model",
      messages: [said("user", "q")],
      onUsage: (usage, durationMs) => {
        seen.push({ ...usage, durationMs });
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.inputTokens).toBe(20);
    expect(seen[0]!.outputTokens).toBe(4);
    expect(seen[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("throws on an empty answer rather than storing one", async () => {
    llm.setTitle("");
    await expect(
      summarizeContext({ provider: provider(), modelId: "fake-model", messages: [said("user", "q")] })
    ).rejects.toThrow(/returned no summary/);
  });

  it("throws when there is nothing to compress", async () => {
    await expect(
      summarizeContext({ provider: provider(), modelId: "fake-model", messages: [] })
    ).rejects.toThrow(/nothing to compact/);
  });

  it("throws without a provider, a model or a key", async () => {
    await expect(
      summarizeContext({ provider: undefined, modelId: "fake-model", messages: [said("user", "q")] })
    ).rejects.toThrow(/No provider configured/);
    await expect(
      summarizeContext({ provider: provider(), modelId: "", messages: [said("user", "q")] })
    ).rejects.toThrow(/No model configured/);
    await expect(
      summarizeContext({
        provider: provider({ apiKey: undefined }),
        modelId: "fake-model",
        messages: [said("user", "q")],
      })
    ).rejects.toThrow(/Provider has no API key/);
  });

  it("falls back to the provider's first model when none is named", async () => {
    await expect(
      summarizeContext({
        provider: provider({
          models: [
            { id: "m1", modelId: "fallback-model", name: "F", capabilities: [] },
          ],
        }),
        modelId: "",
        messages: [said("user", "q")],
      })
    ).resolves.toBe("A compressed summary.");
  });
});
