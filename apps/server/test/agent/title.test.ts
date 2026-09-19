import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  fallbackTitle,
  generateTitle,
  conversationExcerpt,
  isDeclined,
  sanitizeTitle,
  type TitleMessage,
} from "../../src/agent/title.js";
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

describe("isDeclined", () => {
  it("recognises the titler's nothing-to-name answer, however it is spelled", () => {
    // Loose on purpose, and one-directionally: a *title* read as a decline costs one more turn,
    // while a decline read as a title would be written down and marked done — see `NO_TITLE`.
    expect(isDeclined("NO_TITLE")).toBe(true);
    expect(isDeclined("no title")).toBe(true);
    expect(isDeclined("No-Title")).toBe(true);
    expect(isDeclined("NO_TITLES_YET")).toBe(false);
  });

  it("is handed a cleaned title, so punctuation around the sentinel never reaches it", () => {
    expect(sanitizeTitle("NO_TITLE.")).toBe("NO_TITLE");
    expect(isDeclined(sanitizeTitle('  "NO_TITLE."  '))).toBe(true);
  });

  it("does not mistake a real title for it", () => {
    // What the loose match is bought with: a conversation *about* the word is still nameable.
    expect(isDeclined("None 的用法")).toBe(false);
    expect(isDeclined("Untitled Session")).toBe(false);
    expect(isDeclined("")).toBe(false);
  });
});

describe("conversationExcerpt", () => {
  const said = (role: string, content: string): TitleMessage => ({ role, content });

  it("fences what was said, oldest first, so the text is data rather than a request", () => {
    expect(
      conversationExcerpt([said("user", "什么是递归"), said("assistant", "递归是…")])
    ).toBe("<conversation>\n<user>什么是递归</user>\n<assistant>递归是…</assistant>\n</conversation>");
  });

  it("keeps the opening question and the latest messages, and drops the middle", () => {
    /*
     * The whole reason the excerpt is not a window: the two things that name a conversation are the
     * question it opened with and what was last said about it, and a long conversation has a lot of
     * messages in between that say neither.
     */
    const middle = Array.from({ length: 12 }, (_, i) => said("user", `filler ${i}`));
    const excerpt = conversationExcerpt([
      said("user", "opening question"),
      ...middle,
      said("assistant", "the latest answer"),
    ]);

    expect(excerpt).toContain("<user>opening question</user>");
    expect(excerpt).toContain("the latest answer");
    // The oldest filler went first: the ones nearest the end are the better evidence.
    expect(excerpt).not.toContain("filler 0");
    expect(excerpt).toContain("filler 11");
    expect(excerpt.split("\n").length).toBeLessThanOrEqual(11);
  });

  it("says nothing rather than something empty", () => {
    expect(conversationExcerpt([])).toBe("");
    // A tool-only turn leaves an assistant message with no content, and an empty tag would read
    // as a thing that was said.
    expect(conversationExcerpt([said("assistant", "  \n ")])).toBe("");
  });

  it("clips one enormous message so one turn cannot crowd out the rest", () => {
    const excerpt = conversationExcerpt([said("user", "x".repeat(5_000)), said("assistant", "end")]);
    expect(excerpt).toContain("end");
    expect(excerpt.length).toBeLessThan(2_000);
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

  const input = {
    modelId: "fake-model",
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ],
  };

  it("returns the model's title, cleaned up", async () => {
    llm.setTitle('"Model Written Title"');
    await expect(generateTitle({ provider: provider(), ...input })).resolves.toBe("Model Written Title");
  });

  it("answers null when the model says there is nothing to name yet", async () => {
    /*
     * The distinct third answer, and the whole of the new behaviour: this is not a failure, so the
     * caller writes no title and leaves the conversation on its placeholder. `rejects` would be the
     * wrong shape for it and a title would be wrong in the other direction.
     */
    llm.setTitle("NO_TITLE");
    await expect(generateTitle({ provider: provider(), ...input })).resolves.toBeNull();
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
    await generateTitle({
      provider: provider(),
      ...input,
      messages: [{ role: "user", content: "x".repeat(5_000) }, ...input.messages.slice(1)],
    });

    const sent = llm.requests()[0] as { messages: { content: string }[] };
    expect(sent.messages[1]!.content.length).toBeLessThan(3_000);
  });

  it("throws when the model returns nothing usable", async () => {
    // An *empty* answer is a failure rather than a decline — `fallbackTitle` is what stands in for
    // it, and a model that said nothing at all is not a model that judged the conversation empty.
    llm.setTitle("");
    await expect(generateTitle({ provider: provider(), ...input })).rejects.toThrow(/returned no title/);
  });

  it("throws when there is nothing to send", async () => {
    await expect(
      generateTitle({ provider: provider(), modelId: "fake-model", messages: [] })
    ).rejects.toThrow(/Nothing to title/);
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
