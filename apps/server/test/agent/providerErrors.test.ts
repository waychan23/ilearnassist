import { describe, expect, it } from "vitest";
import { classifyProviderError } from "../../src/agent/providerErrors.js";

/**
 * The recogniser that turns a provider sentence into something the user can act on.
 *
 * It is deliberately narrow. A false positive replaces an accurate message with a
 * confident wrong one — telling someone to change a setting that was never the problem —
 * which is worse than the opaque sentence it replaced.
 */

describe("classifyProviderError", () => {
  it("recognises DeepSeek's missing reasoning echo", () => {
    // The sentence as it actually arrives, status prefix and backticks included: it is the
    // whole error the route is handed, not a fragment.
    const real =
      "400 The `reasoning_content` in the thinking mode must be passed back to the API.";

    expect(classifyProviderError(real)).toBe("REASONING_NOT_DECLARED");
  });

  it("does not care about case or wrapping", () => {
    // Providers restate their own errors, and LangChain wraps what it gets. Requiring the
    // exact sentence would make this fail the first time either of them is reworded.
    expect(
      classifyProviderError("Error: REASONING_CONTENT in the thinking mode MUST BE PASSED BACK")
    ).toBe("REASONING_NOT_DECLARED");
  });

  it("leaves a different complaint about the same field alone", () => {
    // The two halves are required for this reason: a 400 that merely names
    // `reasoning_content` is about the field, not about the capability being switched off,
    // and sending that user to a settings dialog wastes their time.
    expect(classifyProviderError("400 Unrecognized request argument: reasoning_content")).toBeUndefined();
  });

  it("leaves ordinary provider failures alone", () => {
    // The overwhelming majority of failures have no code, and the client shows the
    // provider's own words for them. This is the assertion that keeps it that way.
    expect(classifyProviderError("401 Incorrect API key provided")).toBeUndefined();
    expect(classifyProviderError("429 Rate limit reached for requests")).toBeUndefined();
    expect(classifyProviderError("no API key configured for this provider")).toBeUndefined();
    expect(classifyProviderError("")).toBeUndefined();
  });
});
