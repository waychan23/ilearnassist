import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { needsSummary, summarizeImage } from "../../src/agent/mediaSummary.js";
import { startFakeLlm, type FakeLlm } from "../helpers/fakeLlm.js";
import type { ProviderRecord } from "../../src/db.js";

/**
 * The image summary: one line about a picture, written by the model that can see it.
 *
 * Driven against the fake LLM so the real `ChatOpenAI` path runs, and the assertions are about
 * the two things that decide whether the feature is worth having: the *request* carries the
 * image (a summary of something nothing looked at is a fabrication), and the *answer* is
 * cleaned into something a source row and a browser row can both use.
 *
 * The answer comes from `setTitle`, which is the fake's reply for **non-streaming** requests —
 * `llm.setTurns` scripts the streaming path a turn uses, and this call is not a turn.
 */

let llm: FakeLlm;

beforeAll(async () => {
  llm = await startFakeLlm();
});

afterAll(async () => {
  await llm.close();
});

afterEach(() => {
  llm.reset();
});

function provider(overrides: Partial<ProviderRecord> = {}): ProviderRecord {
  return {
    id: "fake",
    name: "Fake",
    baseURL: llm.baseURL,
    apiKey: "test-key",
    models: [{ id: "r1", modelId: "fake-model", name: "fake-model", capabilities: ["vision"] }],
    ...overrides,
  };
}

const DATA_URL = "data:image/png;base64,ZmFrZS1wbmc=";

/** The description the fake model will return, as a non-streaming reply. */
function answers(text: string): void {
  llm.setTitle(text);
}

describe("needsSummary", () => {
  it("asks for a summary of an image that has none", () => {
    expect(needsSummary({ category: "image" })).toBe(true);
    // An empty string is "nothing was written", the same as absent — a row whose summary was
    // cleared by hand should be described again rather than keep a blank label.
    expect(needsSummary({ category: "image", summary: "   " })).toBe(true);
  });

  it("leaves an image that has one alone", () => {
    // The rule that bounds the cost to one call per new image, and the one that keeps the
    // browser's summary from flipping between two readings of the same picture.
    expect(needsSummary({ category: "image", summary: "一张流程图" })).toBe(false);
  });

  it("does not ask for one about anything that leaves text behind", () => {
    // A PDF has its extracted text, and a page has its own. An image is the only source that
    // would otherwise be readable exactly once — in the turn it arrived in.
    for (const category of ["document", "text", "markdown", "diagram", "page", "other"] as const) {
      expect(needsSummary({ category }), category).toBe(false);
    }
  });
});

describe("summarizeImage", () => {
  it("sends the image and returns the model's description", async () => {
    answers("一张手绘流程图，标注了「登录」和「校验」两步。");

    const summary = await summarizeImage({
      provider: provider(),
      modelId: "fake-model",
      dataUrl: DATA_URL,
      sample: "帮我看看这张图",
    });

    expect(summary).toBe("一张手绘流程图，标注了「登录」和「校验」两步。");

    const sent = JSON.stringify(llm.requests()[0]);
    expect(sent).toContain("image_url");
    expect(sent).toContain("data:image/png;base64,");
    // The conversation's own words go with it, which is what makes the answer come back in the
    // language the user is reading.
    expect(sent).toContain("帮我看看这张图");
  });

  it("strips the quotes and preamble a model likes to add", async () => {
    // The same hygiene the titler does, and for the same reason: the output goes into a label.
    answers('"A screenshot of the settings page."');
    expect(
      await summarizeImage({
        provider: provider(),
        modelId: "fake-model",
        dataUrl: DATA_URL,
        sample: "x",
      })
    ).toBe("A screenshot of the settings page.");
  });

  it("caps a description that ran long rather than refusing it", async () => {
    answers("字".repeat(600));
    const summary = await summarizeImage({
      provider: provider(),
      modelId: "fake-model",
      dataUrl: DATA_URL,
      sample: "x",
    });
    expect(summary).toHaveLength(400);
    expect(summary!.endsWith("…")).toBe(true);
  });

  it("answers undefined when the model says nothing", async () => {
    // A blank description is not a summary, and writing one would make `needsSummary` false for
    // ever — the image would never be described again.
    answers("   ");
    expect(
      await summarizeImage({
        provider: provider(),
        modelId: "fake-model",
        dataUrl: DATA_URL,
        sample: "x",
      })
    ).toBeUndefined();
  });

  it("answers undefined rather than calling anything without a key or a model", async () => {
    expect(
      await summarizeImage({
        provider: provider({ apiKey: "" }),
        modelId: "fake-model",
        dataUrl: DATA_URL,
        sample: "x",
      })
    ).toBeUndefined();
    expect(
      await summarizeImage({
        provider: undefined,
        modelId: "fake-model",
        dataUrl: DATA_URL,
        sample: "x",
      })
    ).toBeUndefined();
    expect(
      await summarizeImage({
        provider: provider({ models: [] }),
        modelId: "",
        dataUrl: DATA_URL,
        sample: "x",
      })
    ).toBeUndefined();

    // Nothing was even attempted: the guard is before the request, not after it.
    expect(llm.requests()).toHaveLength(0);
  });
});
