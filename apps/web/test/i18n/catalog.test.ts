import { describe, expect, it } from "vitest";
import { API_ERROR_CODES, PARSE_ERROR_CODES } from "@ilearnassist/shared";
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
 * Keys built at runtime (`` t(`theme.${mode}`) ``, `` t(`parseErrors.${code}`) ``), which
 * the static scan cannot see. Kept as narrow as possible — a broad prefix here is how a
 * typo hides.
 */
const DYNAMIC_PREFIXES = [
  "theme.",
  /* `t(`roles.${role}`)` in the console and the account page, over the closed `UserRole`
     union. Narrow on purpose: a broad prefix is where a typo hides. */
  "roles.",
  "errors.",
  "parseErrors.",
  "tools.name.",
  "providers.capabilities.",
  "settings.policy.",
  /* `t(`admin.nav.${id}`)`, the console's left menu, over the closed section-id union. */
  "admin.nav.",
];

const isDynamic = (key: string): boolean => DYNAMIC_PREFIXES.some((p) => key.startsWith(p));

/**
 * A *partial* key, from a concatenation like `t("settings.policy." + id + ".label")`. The
 * scan cannot evaluate the expression, so it captures the literal prefix and it ends in a
 * dot — which no real key does. Such captures are neither checked nor counted as usage.
 */
const isPartial = (key: string): boolean => key.endsWith(".");

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

describe("server error codes", () => {
  it("has a message for every ApiErrorCode in both catalogs", () => {
    // Iterating the shared union is the point of declaring it as a runtime list: a code
    // added to the server without a message here fails this test rather than rendering
    // the raw code at a user.
    const missing = API_ERROR_CODES.filter(
      (code) => !(`errors.${code}` in zh) || !(`errors.${code}` in enFlat)
    );
    expect(missing).toEqual([]);
  });

  it("has a message for every ParseErrorCode in both catalogs", () => {
    const missing = PARSE_ERROR_CODES.filter(
      (code) => !(`parseErrors.${code}` in zh) || !(`parseErrors.${code}` in enFlat)
    );
    expect(missing).toEqual([]);
  });
});

describe("catalog usage", () => {
  it("resolves every statically-written key in the source tree", () => {
    const missing = translationCallSites()
      .filter(({ key }) => !isPartial(key) && !(key in zh))
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
