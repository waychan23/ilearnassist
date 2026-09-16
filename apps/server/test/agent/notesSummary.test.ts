import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ModelCapability, ProviderModel } from "@ilearnassist/shared";
import { makeNoteSummarizer } from "../../src/agent/notesSummary.js";
import { NOTE_SUMMARY_SYSTEM_PROMPT } from "../../src/notesExport.js";
import type { ProviderRecord } from "../../src/db.js";
import type { OutOfBandReasoningSetting } from "../../src/config.js";
import { startFakeLlm, type FakeLlm } from "../helpers/fakeLlm.js";

/**
 * The note export's summary call — the third out-of-band call, and the classifier's shape with
 * its own numbers.
 *
 * Narrow on purpose, and mostly about the *request*: the fake LLM records exactly the body
 * LangChain sent, so the reasoning gate, the streaming flag and the fence are assertable without
 * a provider. What the run then does with the answer is `test/note-sync-routes.test.ts`'s.
 */
describe("makeNoteSummarizer", () => {
  let llm: FakeLlm;

  beforeAll(async () => {
    llm = await startFakeLlm();
  });

  afterAll(async () => {
    await llm.close();
  });

  beforeEach(() => {
    llm.reset();
  });

  const model = (modelId: string, capabilities: ModelCapability[] = []): ProviderModel => ({
    id: modelId,
    modelId,
    name: modelId,
    capabilities,
  });

  const providerWith = (...models: ProviderModel[]): ProviderRecord => ({
    id: "fake",
    name: "Fake",
    baseURL: llm.baseURL,
    apiKey: "test-key",
    models,
  });

  let reasoner: ProviderRecord;
  let plain: ProviderRecord;

  beforeAll(async () => {
    // Built after the fake LLM is listening: the record carries its port.
    reasoner = providerWith(model("fake-reasoner", ["tool_use", "reasoning"]));
    plain = providerWith(model("fake-model", ["tool_use"]));
  });

  async function run(
    provider: ProviderRecord,
    modelId = "fake-reasoner",
    reasoning?: OutOfBandReasoningSetting
  ): Promise<string> {
    return makeNoteSummarizer({ provider, modelId, reasoning })(
      NOTE_SUMMARY_SYSTEM_PROMPT,
      "user: 递归怎么写\nassistant: 先想基准情形"
    );
  }

  const lastRequest = (): Record<string, unknown> => llm.requests().at(-1)!;

  it("streams, which is the difference between a timeout on thinking and a timeout on silence", async () => {
    await run(reasoner);
    expect(lastRequest().stream).toBe(true);
  });

  it("sends the transcript fenced, so the learner's own words are data", async () => {
    // Not boilerplate: the payload is what the learner typed, so a message that reads like an
    // instruction has to arrive as material *about* the conversation.
    await run(reasoner);
    expect(JSON.stringify(lastRequest())).toContain("session_transcript");
  });

  it("uses its own wrapper, so one call's scripted answer cannot fire for another", async () => {
    // The fake LLM resolves body-keyed scripts by substring, and all three out-of-band calls go
    // through it. A wrapper two of them shared would make a test pass while asserting about the
    // wrong call — which is why this call's is neither `<conversation>` nor `<study_record>`.
    await run(reasoner);
    const body = JSON.stringify(lastRequest());
    expect(body).not.toContain("study_record");
  });

  it("sends thinking:disabled when the switch is off, for a reasoning model", async () => {
    await run(reasoner, "fake-reasoner", "off");
    expect(lastRequest().thinking).toEqual({ type: "disabled" });
  });

  it("sends thinking:enabled when the switch is on, for a reasoning model", async () => {
    await run(reasoner, "fake-reasoner", "on");
    expect(lastRequest().thinking).toEqual({ type: "enabled" });
  });

  it("sends no thinking field in auto, leaving the provider's own default in force", async () => {
    await run(reasoner, "fake-reasoner", "auto");
    expect(lastRequest().thinking).toBeUndefined();
  });

  it("never sends the field to a model without the reasoning capability, even when forced", async () => {
    // An unknown `thinking` body field is a 400 on strict OpenAI-compatible endpoints — the gate
    // `agent/reasoning.ts` provides, shared with the classifier and the insight pass.
    await run(plain, "fake-model", "off");
    expect(lastRequest().thinking).toBeUndefined();
    await run(plain, "fake-model", "on");
    expect(lastRequest().thinking).toBeUndefined();
  });

  it("reports a missing provider rather than sending a request", async () => {
    // The export settles this as `failed`, which is a fact about the call — the route does not
    // turn it into an HTTP error, and the message is what the panel shows.
    await expect(
      makeNoteSummarizer({ provider: undefined, modelId: "x" })(NOTE_SUMMARY_SYSTEM_PROMPT, "…")
    ).rejects.toThrow(/No provider/);
    expect(llm.requests()).toHaveLength(0);
  });

  it("reports a keyless provider rather than sending the request unauthenticated", async () => {
    const keyless = { ...providerWith(model("fake-model")), apiKey: "" };
    await expect(
      makeNoteSummarizer({ provider: keyless, modelId: "fake-model" })(
        NOTE_SUMMARY_SYSTEM_PROMPT,
        "…"
      )
    ).rejects.toThrow(/API key/);
    expect(llm.requests()).toHaveLength(0);
  });
});
