import { describe, expect, it } from "vitest";
import { PARSE_ERROR_CODES } from "@guided-learning/shared";
import {
  ParseError,
  describeParseError,
  parseErrorCodeOf,
  parseErrorDetail,
} from "../../src/documents/errors.js";

/**
 * The code is what the client renders now, and `describeParseError` is only the fallback
 * sentence — so the two must never disagree about what went wrong. These tests pin the
 * agreement, and pin which codes carry a provider-supplied detail.
 */

describe("parseErrorCodeOf", () => {
  it("reads the code off a ParseError", () => {
    expect(parseErrorCodeOf(new ParseError("no_text_layer", "empty"))).toBe("no_text_layer");
  });

  it("treats a non-ParseError throw as corrupt", () => {
    // Anything unexpected — a provider SDK throwing, a TypeError — is classified the same
    // way `asParseError` classifies it.
    expect(parseErrorCodeOf(new Error("boom"))).toBe("corrupt");
    expect(parseErrorCodeOf("a string")).toBe("corrupt");
    expect(parseErrorCodeOf(undefined)).toBe("corrupt");
  });

  it("returns a member of the shared union for every code", () => {
    for (const code of PARSE_ERROR_CODES) {
      expect(PARSE_ERROR_CODES).toContain(parseErrorCodeOf(new ParseError(code, "x")));
    }
  });
});

describe("parseErrorDetail", () => {
  it("passes the provider's words through for the two codes that need them", () => {
    expect(parseErrorDetail(new ParseError("cloud_failed", "HTTP 502"))).toBe("HTTP 502");
    expect(parseErrorDetail(new Error("unreadable"))).toBe("unreadable"); // → corrupt
  });

  it("withholds a detail for codes whose message stands alone", () => {
    // A detail here would put raw exception text in front of a user for no reason.
    expect(parseErrorDetail(new ParseError("no_text_layer", "empty"))).toBeUndefined();
    expect(parseErrorDetail(new ParseError("password_protected", "encrypted"))).toBeUndefined();
    expect(parseErrorDetail(new ParseError("timeout", "took too long"))).toBeUndefined();
  });
});

describe("describeParseError", () => {
  it("produces a sentence for every code in the taxonomy", () => {
    for (const code of PARSE_ERROR_CODES) {
      const message = describeParseError(new ParseError(code, "detail here"));
      expect(message.trim(), code).not.toBe("");
    }
  });

  it("interpolates the detail where the code calls for it", () => {
    expect(describeParseError(new ParseError("cloud_failed", "HTTP 502"))).toContain("HTTP 502");
    // …and leaves it out where it does not.
    expect(describeParseError(new ParseError("no_text_layer", "HTTP 502"))).not.toContain("HTTP 502");
  });
});
