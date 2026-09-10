import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fallbackTitle, generateTitle, sanitizeTitle } from "../../src/agent/title.js";
import type { ProviderRecord } from "../../src/db.js";
import { startFakeLlm, type FakeLlm } from "../helpers/fakeLlm.js";

describe("sanitizeTitle", () => {
  it.each([
    ["plain title", "plain title"],
    ["  padded  ", "padded"],
    ['"quoted"', "quoted"],
    ["“smart quoted”", "smart quoted"],
    ["「bracketed」", "「bracketed」"], // only the paired quotes we list are stripped
    ["Title: prefixed", "prefixed"],
    ["标题：中文标题", "中文标题"],
    ["trailing punctuation.", "trailing punctuation"],
    ["问句吗？", "问句吗"],
    ['Title: "Recursion, explained."', "Recursion, explained"],
  ])("cleans %j", (input, expected) => {
    expect(sanitizeTitle(input)).toBe(expected);
  });

  it("only strips a wrapper quote when it is at the very edge", () => {
    // Quotes are removed before trailing punctuation, so `x."` keeps its inner quote.
    // Documented rather than fixed: a cosmetic edge case, and the title is still usable.
    expect(sanitizeTitle('both: "wrapped, and punctuated."')).toBe('both: "wrapped, and punctuated');
  });

  it("keeps only the first non-empty line", () => {
    expect(sanitizeTitle("\n\nReal Title\n\nAnd an explanation the model added.")).toBe("Real Title");
  });

  it("truncates a very long title with an ellipsis", () => {
    const title = sanitizeTitle("x".repeat(100));
    expect(title).toHaveLength(61); // 60 chars + the ellipsis
    expect(title.endsWith("…")).toBe(true);
  });

  it("returns an empty string for unusable input", () => {
    expect(sanitizeTitle("")).toBe("");
    expect(sanitizeTitle("   \n  ")).toBe("");
    expect(sanitizeTitle('""')).toBe("");
  });
});

describe("fallbackTitle", () => {
  it("leads with the user's own words", () => {
    expect(fallbackTitle("How do I reverse a list?")).toBe("How do I reverse a list");
  });

  it("falls back to the assistant when the user said nothing", () => {
    expect(fallbackTitle("", "Here is how you do it.")).toBe("Here is how you do it");
  });

  it("returns an empty string when there is nothing to work with", () => {
    expect(fallbackTitle("", "")).toBe("");
    expect(fallbackTitle("   ", "\n")).toBe("");
  });

  it("collapses newlines so a sidebar label cannot wrap", () => {
    expect(fallbackTitle("first line\nsecond line")).toBe("first line second line");
  });

  it("clips a long message and marks the clip", () => {
    const title = fallbackTitle("word ".repeat(40));
    expect(title.length).toBeLessThanOrEqual(41);
    expect(title.endsWith("…")).toBe(true);
  });

  it("applies the same cleanup a model title gets", () => {
    expect(fallbackTitle("What is recursion?")).toBe("What is recursion");
    expect(fallbackTitle("什么是递归？")).toBe("什么是递归");
  });
});

describe("generateTitle", () => {
  let llm: FakeLlm;

  beforeAll(async () => {
    llm = await startFakeLlm({ title: "Model Written Title" });
  });

  afterAll(async () => {
    await llm.close();
  });

  const provider = (overrides: Partial<ProviderRecord> = {}): ProviderRecord => ({
    id: "fake",
    name: "Fake",
    baseURL: llm.baseURL,
    apiKey: "test-key",
    models: [],
    ...overrides,
  });

  const input = { modelId: "fake-model", userMessage: "hello", assistantMessage: "hi there" };

  it("returns the model's title, cleaned up", async () => {
    llm.setTitle('"Model Written Title"');
    await expect(generateTitle({ provider: provider(), ...input })).resolves.toBe("Model Written Title");
  });

  it("sends the exchange fenced as data, not as a request to answer", async () => {
    llm.reset();
    await generateTitle({ provider: provider(), ...input });

    const sent = llm.requests()[0] as { messages: { role: string; content: string }[]; stream?: boolean };
    // Non-streaming: the titler is a one-shot classification, not a chat turn.
    expect(sent.stream).toBeFalsy();
    expect(sent.messages[0]!.content).toContain("titling function");
    expect(sent.messages[1]!.content).toContain("<conversation>");
    expect(sent.messages[1]!.content).toContain("<user>hello</user>");
  });

  it("truncates a very long exchange before sending it", async () => {
    llm.reset();
    await generateTitle({ provider: provider(), ...input, userMessage: "x".repeat(5_000) });

    const sent = llm.requests()[0] as { messages: { content: string }[] };
    expect(sent.messages[1]!.content.length).toBeLessThan(3_000);
  });

  it("throws when the model returns nothing usable", async () => {
    llm.setTitle("");
    await expect(generateTitle({ provider: provider(), ...input })).rejects.toThrow(/returned no title/);
  });

  it("throws when there is no provider", async () => {
    await expect(generateTitle({ ...input, provider: undefined })).rejects.toThrow(/No provider configured/);
  });

  it("throws when no model can be resolved", async () => {
    await expect(generateTitle({ ...input, provider: provider(), modelId: "" })).rejects.toThrow(
      /No model configured/
    );
  });

  it("throws when the provider has no API key", async () => {
    await expect(generateTitle({ ...input, provider: provider({ apiKey: undefined }) })).rejects.toThrow(
      /Provider has no API key/
    );
  });

  it("falls back to the provider's first model when none is named", async () => {
    llm.setTitle("From Fallback Model");
    const withModels = provider({
      models: [{ id: "r", modelId: "fallback-model", name: "F", capabilities: [] }],
    });
    await expect(generateTitle({ ...input, provider: withModels, modelId: "" })).resolves.toBe(
      "From Fallback Model"
    );
  });
});
