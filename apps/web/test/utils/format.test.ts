import { describe, expect, it } from "vitest";
import { estimateTokens, formatBytes, formatTokens } from "../../src/utils/format.js";

describe("formatBytes", () => {
  it("shows raw bytes below 1 KB", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("switches to KB at 1024", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
  });

  it("keeps one decimal below 10 units and rounds above", () => {
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(10 * 1024)).toBe("10 KB");
    expect(formatBytes(999 * 1024)).toBe("999 KB");
  });

  it("steps up through MB and GB", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0 GB");
  });

  it("stops at GB rather than inventing a unit", () => {
    expect(formatBytes(5 * 1024 ** 4)).toBe("5120 GB");
  });
});

describe("formatTokens", () => {
  it("shows small counts verbatim", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
  });

  it("abbreviates thousands, with a decimal under 10k", () => {
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(12_345)).toBe("12k");
  });

  it("abbreviates millions", () => {
    expect(formatTokens(1_500_000)).toBe("1.5M");
  });
});

describe("estimateTokens", () => {
  it("returns 0 for empty text", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("estimates roughly a token per four English characters", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });

  it("counts CJK as roughly one token per character", () => {
    // Under-counting is deliberate: this only drives a pre-send preview.
    expect(estimateTokens("递归")).toBe(2);
    expect(estimateTokens("什么是递归")).toBe(5);
  });

  it("mixes scripts without losing the non-CJK remainder", () => {
    // 4 CJK chars + 8 latin chars → 4 + 2
    expect(estimateTokens("递归算法abcdefgh")).toBe(6);
  });

  it("rounds up a partial token", () => {
    expect(estimateTokens("ab")).toBe(1);
  });
});
