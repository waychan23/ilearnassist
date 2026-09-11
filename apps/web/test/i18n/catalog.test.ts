import { describe, expect, it } from "vitest";
import zhCN from "../../src/locales/zh-CN";
import en from "../../src/locales/en";
import { flatten, placeholders, textOf, translationCallSites } from "../helpers/catalog";

/**
 * The catalog guards.
 *
 * `en.ts` being typed as the zh-CN schema already makes a *missing* key a `vue-tsc` error.
 * These tests cover what the type system cannot see: an untranslated copy-paste, a
 * placeholder that drifted between the two catalogs, a typo'd key at a call site, and a
 * key that nothing references any more.
 */

const zh = flatten(zhCN as unknown as Record<string, unknown>);
const enFlat = flatten(en as unknown as Record<string, unknown>);

/**
 * The one legitimate CJK value outside `zh-CN.ts`: a language picker labels each option in
 * its own language, or it is unusable to exactly the people it is for.
 */
const CJK_ALLOWED_IN_EN = new Set(["locale.zhCN"]);

/**
 * Keys built at runtime (`` t(`theme.${mode}`) ``), which the static scan cannot see.
 * Kept as narrow as possible — a broad prefix here is how a typo hides.
 */
const DYNAMIC_PREFIXES = ["theme."];

const isDynamic = (key: string): boolean => DYNAMIC_PREFIXES.some((p) => key.startsWith(p));

describe("catalog completeness", () => {
  it("has the same keys in both catalogs", () => {
    // Both directions: a missing translation *and* an orphaned key.
    expect(Object.keys(enFlat).sort()).toEqual(Object.keys(zh).sort());
  });

  it("has no empty messages", () => {
    for (const [key, leaf] of [...Object.entries(zh), ...Object.entries(enFlat)]) {
      expect(textOf(leaf).trim(), key).not.toBe("");
    }
  });

  it("leaves no untranslated Chinese in the English catalog", () => {
    // The likeliest extraction mistake by far: the Chinese string pasted straight across.
    const leaked = Object.entries(enFlat)
      .filter(([key]) => !CJK_ALLOWED_IN_EN.has(key))
      .filter(([, leaf]) => /[一-鿿]/.test(textOf(leaf)))
      .map(([key]) => key);

    expect(leaked).toEqual([]);
  });

  it("keeps the same placeholders in both catalogs", () => {
    for (const key of Object.keys(zh)) {
      const zhLeaf = zh[key]!;
      const enLeaf = enFlat[key];
      if (!enLeaf) continue;

      // A plural message is `one | other`; compare against the union of its branches so a
      // placeholder that appears in only one branch is not reported as drift.
      const enNames = new Set(
        textOf(enLeaf)
          .split("|")
          .flatMap((branch) => [...placeholders(branch)]),
      );
      expect(enNames, key).toEqual(placeholders(textOf(zhLeaf)));
    }
  });
});

describe("catalog usage", () => {
  it("resolves every statically-written key in the source tree", () => {
    const missing = translationCallSites()
      .filter(({ key }) => !(key in zh))
      .map(({ file, key }) => `${file.replace(/.*\/src\//, "src/")}: ${key}`);

    expect(missing).toEqual([]);
  });

  it("has no dead keys once dynamic prefixes are accounted for", () => {
    // The noisiest guard, so it is last and the allowlist is explicit: a key is dead only
    // if nothing statically references it AND it is not under a runtime-built prefix.
    const referenced = new Set(translationCallSites().map((s) => s.key));
    const dead = Object.keys(zh).filter((key) => !referenced.has(key) && !isDynamic(key));

    expect(dead).toEqual([]);
  });
});
