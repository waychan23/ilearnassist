import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ModelCapability, ProviderModel } from "@ilearnassist/shared";
import { makeThreadClassifier } from "../../src/agent/threads.js";
import { THREAD_SYSTEM_PROMPT } from "../../src/threads.js";
import type { ProviderRecord } from "../../src/db.js";
import type { ThreadReasoningSetting } from "../../src/config.js";
import { startFakeLlm, type FakeLlm } from "../helpers/fakeLlm.js";

/**
 * The classifier's reasoning switch. DeepSeek V4 has thinking ON by default and takes
 * `thinking: {"type": "disabled" | "enabled"}` in the request body; the fake LLM records
 * exactly the body LangChain sent, which is what these tests assert on.
 */
describe("makeThreadClassifier", () => {
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

  async function classify(
    provider: ProviderRecord,
    modelId = "fake-reasoner",
    reasoning?: ThreadReasoningSetting
  ): Promise<void> {
    await makeThreadClassifier({ provider, modelId, reasoning })(THREAD_SYSTEM_PROMPT, "1. user: hi");
  }

  /** The thinking field on the most recent request body, if any. */
  function sentThinking(): unknown {
    const sent = llm.requests().at(-1) as Record<string, unknown>;
    return sent.thinking;
  }

  it("sends thinking:disabled when reasoning is switched off for a reasoning model", async () => {
    await classify(reasoner, "fake-reasoner", "off");
    expect(sentThinking()).toEqual({ type: "disabled" });
  });

  it("sends thinking:enabled when reasoning is switched on for a reasoning model", async () => {
    await classify(reasoner, "fake-reasoner", "on");
    expect(sentThinking()).toEqual({ type: "enabled" });
  });

  it("sends no thinking field in auto mode, leaving the provider's default in force", async () => {
    await classify(reasoner, "fake-reasoner", "auto");
    expect(sentThinking()).toBeUndefined();
  });

  it("defaults to auto when no setting is passed", async () => {
    await classify(reasoner);
    expect(sentThinking()).toBeUndefined();
  });

  it("never sends the field to a model without the reasoning capability, even when forced", async () => {
    // An unknown `thinking` field is a 400 on strict OpenAI-compatible endpoints; the
    // capability flag is the gate, so an explicit override cannot reach a model the
    // installation has not declared as a reasoning model.
    await classify(plain, "fake-model", "off");
    expect(sentThinking()).toBeUndefined();
    await classify(plain, "fake-model", "on");
    expect(sentThinking()).toBeUndefined();
  });

  it("gates on the resolved model, not another model on the same provider", async () => {
    const mixed = providerWith(
      model("fake-reasoner", ["reasoning"]),
      model("fake-model", [])
    );
    await classify(mixed, "fake-model", "off");
    expect(sentThinking()).toBeUndefined();
    await classify(mixed, "fake-reasoner", "off");
    expect(sentThinking()).toEqual({ type: "disabled" });
  });

  it("still streams and returns the assembled answer with the switch on", async () => {
    const text = await makeThreadClassifier({ provider: reasoner, modelId: "fake-reasoner", reasoning: "off" })(
      THREAD_SYSTEM_PROMPT,
      "1. user: hi"
    );
    const sent = llm.requests().at(-1) as Record<string, unknown>;
    expect(sent.stream).toBe(true);
    expect(text).toBe("ok"); // the fake LLM's default streamed turn
  });

  it("rejects a missing provider, model or API key", async () => {
    const run = makeThreadClassifier({ provider: undefined, modelId: "x" });
    await expect(run(THREAD_SYSTEM_PROMPT, "x")).rejects.toThrow(/No provider configured/);

    await expect(
      makeThreadClassifier({ provider: providerWith(), modelId: "" })(THREAD_SYSTEM_PROMPT, "x")
    ).rejects.toThrow(/No model configured/);

    const keyless: ProviderRecord = { ...reasoner, apiKey: undefined };
    await expect(
      makeThreadClassifier({ provider: keyless, modelId: "fake-reasoner", reasoning: "off" })(
        THREAD_SYSTEM_PROMPT,
        "x"
      )
    ).rejects.toThrow(/API key/);
  });
});
