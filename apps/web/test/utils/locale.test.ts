import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectBrowserLocale,
  matchLocale,
  normalizeTag,
  SUPPORTED_LOCALES,
} from "../../src/utils/locale";

/**
 * Locale detection is pure and is the one piece of the i18n feature with real branching,
 * so it is table-driven here rather than exercised through a browser.
 *
 * The rule under test: pick the first entry of the browser's preference *list* that we
 * speak, and only fall back to English when none of them is supported.
 */

describe("normalizeTag", () => {
  it.each([
    ["zh_Hans_CN", "zh-hans-cn"],
    ["ZH-cn", "zh-cn"],
    ["  en  ", "en"],
    ["", ""],
  ])("normalizes %j to %j", (input, expected) => {
    expect(normalizeTag(input)).toBe(expected);
  });
});

describe("matchLocale", () => {
  it.each([
    // Exact hits.
    [["zh-CN"], "zh-CN"],
    [["en"], "en"],
    // Region and script variants resolve through the alias table.
    [["zh-Hans-CN"], "zh-CN"],
    [["zh-Hans"], "zh-CN"],
    [["zh-SG"], "zh-CN"],
    [["zh-TW"], "zh-CN"],
    [["zh-Hant-HK"], "zh-CN"],
    [["zh"], "zh-CN"],
    // Bare language of a supported tag.
    [["en-US"], "en"],
    [["en-GB"], "en"],
    [["EN_us"], "en"],
    // Unsupported → English, not Chinese.
    [["fr-FR"], "en"],
    [["ja"], "en"],
    [["de-DE"], "en"],
    // Junk and emptiness.
    [[] as string[], "en"],
    [[""], "en"],
    [["   "], "en"],
  ])("maps %j to %j", (tags, expected) => {
    expect(matchLocale(tags)).toBe(expected);
  });

  it("honours order of preference rather than the first tag alone", () => {
    // The whole reason detection walks the list: a French-first user who also reads
    // Chinese gets Chinese, because their second choice is one we ship.
    expect(matchLocale(["fr-FR", "zh-CN"])).toBe("zh-CN");
    expect(matchLocale(["fr-FR", "en-GB"])).toBe("en");
    expect(matchLocale(["fr-FR", "de-DE", "ja", "en"])).toBe("en");
  });

  it("returns a locale that is actually in SUPPORTED_LOCALES", () => {
    // Guards against an alias table entry pointing at a locale no catalog covers.
    for (const tags of [["zh-TW"], ["zh-HK"], ["zh-Hant"], ["fr"], ["en-US"]]) {
      expect(SUPPORTED_LOCALES).toContain(matchLocale(tags));
    }
  });
});

describe("detectBrowserLocale", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("prefers the languages list", () => {
    vi.stubGlobal("navigator", { languages: ["fr-FR", "zh-CN"], language: "fr-FR" });
    expect(detectBrowserLocale()).toBe("zh-CN");
  });

  it("falls back to the single language when languages is absent", () => {
    vi.stubGlobal("navigator", { language: "zh-CN" });
    expect(detectBrowserLocale()).toBe("zh-CN");
  });

  it("falls back to the single language when languages is empty", () => {
    vi.stubGlobal("navigator", { languages: [], language: "en-GB" });
    expect(detectBrowserLocale()).toBe("en");
  });

  it("returns English when the browser offers nothing usable", () => {
    vi.stubGlobal("navigator", { languages: [], language: "" });
    expect(detectBrowserLocale()).toBe("en");
  });

  it("returns English for an unsupported language", () => {
    vi.stubGlobal("navigator", { languages: ["ko-KR"], language: "ko-KR" });
    expect(detectBrowserLocale()).toBe("en");
  });
});
