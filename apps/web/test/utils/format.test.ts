import { describe, expect, it } from "vitest";
import {
  estimateTokens,
  formatBytes,
  formatRelativeTime,
  formatTokens,
} from "../../src/utils/format.js";

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

describe("formatRelativeTime", () => {
  const now = Date.parse("2026-09-11T12:00:00.000Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it("calls anything under a minute 'now'", () => {
    expect(formatRelativeTime(ago(0), now)).toEqual({ kind: "now" });
    expect(formatRelativeTime(ago(59_000), now)).toEqual({ kind: "now" });
  });

  it("steps through minutes, hours and days", () => {
    expect(formatRelativeTime(ago(60_000), now)).toEqual({ kind: "minutes", count: 1 });
    expect(formatRelativeTime(ago(59 * 60_000), now)).toEqual({ kind: "minutes", count: 59 });
    expect(formatRelativeTime(ago(60 * 60_000), now)).toEqual({ kind: "hours", count: 1 });
    expect(formatRelativeTime(ago(23 * 3_600_000), now)).toEqual({ kind: "hours", count: 23 });
    expect(formatRelativeTime(ago(24 * 3_600_000), now)).toEqual({ kind: "days", count: 1 });
    expect(formatRelativeTime(ago(6 * 86_400_000), now)).toEqual({ kind: "days", count: 6 });
  });

  it("falls back to the date at a week, where a count stops being readable", () => {
    // "7 days ago" is still a number the reader has to convert; the date is not.
    expect(formatRelativeTime(ago(7 * 86_400_000), now)).toEqual({
      kind: "date",
      value: "2026-09-04",
    });
  });

  it("clamps a timestamp from the future to 'now' rather than reporting a negative age", () => {
    // Browser and server share a machine in every supported setup, but a card must not be
    // able to render "-3 minutes".
    expect(formatRelativeTime(new Date(now + 120_000).toISOString(), now)).toEqual({ kind: "now" });
  });

  it("shows an unparseable timestamp rather than inventing an age for it", () => {
    // A server bug, not a user-facing state — and "just now" would be a lie dressed as one.
    expect(formatRelativeTime("not a date", now)).toEqual({ kind: "date", value: "not a date" });
  });
});
