import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ModelCapability, ProviderModel } from "@ilearnassist/shared";
import { makeInsightGenerator } from "../../src/agent/insights.js";
import { insightSystemPrompt } from "../../src/insights.js";
import type { ProviderRecord } from "../../src/db.js";
import type { OutOfBandReasoningSetting } from "../../src/config.js";
import { startFakeLlm, type FakeLlm } from "../helpers/fakeLlm.js";

/**
 * The insight pass's model call, which is the classifier's shape with different numbers.
 *
 * What these pin is deliberately narrow and mostly about the *request*: the fake LLM records
 * exactly the body LangChain sent, so the reasoning gate, the streaming flag and the fence are
 * assertable without a provider. The pass's own behaviour — the prompt's content and what
 * happens to the rows — is `test/insights.test.ts`, which needs no network at all.
 */
describe("makeInsightGenerator", () => {
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
    return makeInsightGenerator({ provider, modelId, reasoning })(
      insightSystemPrompt(),
      "<plan>…</plan>"
    );
  }

  const lastRequest = (): Record<string, unknown> => llm.requests().at(-1)!;

  it("streams, which is the difference between a timeout on thinking and a timeout on silence", async () => {
    await run(reasoner);
    expect(lastRequest().stream).toBe(true);
  });

  it("sends the record fenced, so the learner's own words are data", async () => {
    // Not boilerplate here: the payload is largely notes the learner wrote for themselves, so a
    // note that reads like an instruction has to arrive as material *about* them.
    await run(reasoner);
    const body = JSON.stringify(lastRequest());
    expect(body).toContain("study_record");
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
    await run(reasoner);
    expect(lastRequest().thinking).toBeUndefined();
  });

  it("never sends the field to a model without the reasoning capability, even when forced", async () => {
    // An unknown `thinking` body field is a 400 on strict OpenAI-compatible endpoints. This is
    // the same gate the classifier's call uses, from `agent/reasoning.ts`.
    await run(plain, "fake-model", "off");
    expect(lastRequest().thinking).toBeUndefined();
    await run(plain, "fake-model", "on");
    expect(lastRequest().thinking).toBeUndefined();
  });

  it("gates on the resolved model, not on another model of the same provider", async () => {
    const mixed = providerWith(model("fake-reasoner", ["reasoning"]), model("fake-model", []));
    await run(mixed, "fake-model", "on");
    expect(lastRequest().thinking).toBeUndefined();
    await run(mixed, "fake-reasoner", "on");
    expect(lastRequest().thinking).toEqual({ type: "enabled" });
  });

  it("rejects a missing provider, model or API key", async () => {
    await expect(
      makeInsightGenerator({ provider: undefined, modelId: "x" })(insightSystemPrompt(), "x")
    ).rejects.toThrow(/No provider configured/);

    await expect(
      makeInsightGenerator({ provider: providerWith(), modelId: "" })(insightSystemPrompt(), "x")
    ).rejects.toThrow(/No model configured/);

    const keyless: ProviderRecord = { ...reasoner, apiKey: undefined };
    await expect(
      makeInsightGenerator({ provider: keyless, modelId: "fake-reasoner" })(
        insightSystemPrompt(),
        "x"
      )
    ).rejects.toThrow(/API key/);
  });
});
