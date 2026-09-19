import { describe, expect, it } from "vitest";
import { ALL_TOOL_NAMES, API_ERROR_CODES, PARSE_ERROR_CODES } from "@ilearnassist/shared";
import { ADMIN_SECTIONS } from "../../src/router/index.js";
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
  /*
   * `t(`usage.purpose.${key}`)` in the stats panel, over the closed `USAGE_PURPOSES` union in
   * `packages/shared`. The id is the *server's* — it arrives on a ledger row — so unlike every
   * other label on that page there is nothing to spell literally, and a `switch` would be six
   * `t()` calls whose only job is to name six purposes correctly.
   */
  "usage.purpose.",
  /* `t(`widgets.insight.types.${type}`)` in the insight panel, over the closed `INSIGHT_TYPES`
     union. Five segments for eight kinds: the alternative is a `switch` with eight literal keys
     whose only job would be to spell eight strings correctly, and this prefix cannot hide a typo
     in any key outside the insight panel's type list. */
  "widgets.insight.types.",
  /*
   * The closed `FileCategory` union, reached by a value the server sent. A key per value with a
   * literal `switch` would be seven `t("…")` calls to spell out the same sentence path, and the
   * guard that matters — every member has a message — is what the symmetry check above already
   * proves for the other catalog.
   *
   * `sources.origin.` used to be here beside it. It went with the origin filter: a row's origin
   * is not a value in v4 — a reference names the entity it points at, and a file's own
   * `sourceType` is not a filter the library draws.
   */
  "sources.category.",
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

  it("escapes every @ that is not a linked message", () => {
    /*
     * vue-i18n reads a bare `@` as its *linked-message* syntax (`@:key`), and a message it cannot
     * compile throws **at render time** — taking down the whole component the message is in.
     *
     * This guard exists because that is exactly what happened: a placeholder ending "…输入 @
     * 可引用资料" compiled fine in this suite, passed the type checker, and left the composer
     * blank in a real browser. A raw `@` is therefore never product copy: it is either a mistake
     * or an escape, and the message says which.
     */
    const raw = /(?<!\{'\})@/;
    for (const [key, leaf] of [...Object.entries(zh), ...Object.entries(enFlat)]) {
      const text = textOf(leaf);
      // `{'@'}` is the escape; strip the well-formed ones and anything left is bare.
      const stripped = text.replaceAll("{'@'}", "");
      expect(raw.test(stripped), `${key} contains a bare @`).toBe(false);
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

describe("tool display names", () => {
  it("has a name for every tool in both catalogs", () => {
    /*
     * `tools.name.*` is in `DYNAMIC_PREFIXES` — the key is built as `"tools.name." + name` —
     * and that exemption was the whole of what looked after it. Nothing checked that the keys
     * *exist*, and a missing one does not fail loudly: `ToolCallCard` and `DiagramCard` both
     * fall back to the raw tool name rather than rendering a key path, and
     * `CopilotDialog`'s tool checklist resolves the same namespace. So `ila_diagram` shipped
     * with its card head reading `ila_diagram`, and the only reason it was noticed is that a
     * screenshot showed it.
     *
     * Iterating the shared list is the point of declaring `ALL_TOOL_NAMES` as a runtime list,
     * exactly as the two error-code cases above iterate theirs.
     */
    const missing = ALL_TOOL_NAMES.filter(
      (name) => !(`tools.name.${name}` in zh) || !(`tools.name.${name}` in enFlat)
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

/**
 * Every console section has both of its sentences.
 *
 * The `admin.nav.` prefix is allowlisted for the dynamic lookup, and a prefix says "any key under
 * here is fine" — so a section added to `ADMIN_SECTIONS` without its catalog entries passes the
 * dead-key scan and then says so *on screen*. It did exactly that: `admin.nav.stats` rendered as
 * the literal key, in the menu and as the section's own title. This closes the gap for the next one.
 */
describe("the console's sections", () => {
  it("names each one, and describes it, in both catalogs", () => {
    const zh = flatten(zhCN as unknown as Record<string, unknown>);
    const en_ = flatten(en as unknown as Record<string, unknown>);
    for (const section of ADMIN_SECTIONS) {
      for (const key of [`admin.nav.${section}`, `admin.subtitle.${section}`]) {
        // A missing leaf is `undefined`; an empty one would pass a truthiness check.
        expect(zh[key], `${key} is missing from zh-CN`).toBeTruthy();
        expect(en_[key], `${key} is missing from en`).toBeTruthy();
      }
    }
  });

  /*
   * A message may not send the reader to a screen that does not exist.
   *
   * `Settings → Providers` and `Settings → Document parsing` lived in a global settings dialog
   * that the console replaced. Six messages kept pointing at it — including the banner a fresh
   * install shows when no API key is set, which is the first thing a new user reads, and the
   * `REASONING_NOT_DECLARED` error, which names where to fix the very thing it is complaining
   * about. A wrong destination is worse than no destination: the reader concludes the feature
   * is missing rather than that the sentence is stale.
   *
   * Matched on the *path*, not on the word, so these remain writable: "in Settings" is vague
   * but harmless, and `settings.providers.*` is a live namespace.
   */
  it("sends nobody to the retired settings dialog", () => {
    const RETIRED = ["设置 → ", "Settings → "];
    for (const [name, catalog] of [
      ["zh-CN", zh],
      ["en", enFlat],
    ] as const) {
      for (const [key, value] of Object.entries(catalog)) {
        for (const path of RETIRED) {
          expect(value, `${name} ${key} points at the retired dialog`).not.toContain(path);
        }
      }
    }
  });
});
