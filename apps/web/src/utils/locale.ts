/**
 * Locale tags, and turning the browser's preference list into one we support.
 *
 * Deliberately knows nothing about vue-i18n: `i18n.ts` needs detection at construction
 * time and `composables/locale.ts` needs the i18n instance to push changes into. If this
 * module imported either, the two would form a cycle that runs at module-evaluation time.
 *
 * The inline script in `index.html` duplicates a *dumbed-down* version of `matchLocale`
 * to set `<html lang>` before paint. It must stay in lock-step with the alias table
 * below — any divergence there is invisible, because `useLocale()` immediately overwrites
 * the attribute from this module.
 */

export const SUPPORTED_LOCALES = ["zh-CN", "en"] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** Where an unlisted language lands. Mirrors `fallbackLocale` in `i18n.ts`. */
export const FALLBACK_LOCALE: Locale = "en";

/**
 * Tags whose readers get a different catalog than their base language would suggest.
 *
 * Every Chinese variant maps to `zh-CN` for now, because Simplified is the only Chinese
 * catalog we ship and it is closer to a Traditional reader's expectation than English is.
 * Adding `zh-TW` later is: add the catalog file, add it to `SUPPORTED_LOCALES`, and move
 * the `zh-hant`/`zh-tw`/`zh-hk`/`zh-mo` rows to `"zh-TW"`.
 */
const ALIASES: Record<string, Locale> = {
  zh: "zh-CN",
  "zh-hans": "zh-CN",
  "zh-sg": "zh-CN",
  "zh-my": "zh-CN",
  "zh-hant": "zh-CN",
  "zh-tw": "zh-CN",
  "zh-hk": "zh-CN",
  "zh-mo": "zh-CN",
};

/** `"zh_Hans_CN"` / `" ZH-cn "` → `"zh-hans-cn"`. */
export function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/_/g, "-");
}

/**
 * Normalized tag → canonical locale, because comparison has to be case-insensitive:
 * the browser sends `zh-cn` and `zh-CN`, and only one of them is a valid `Locale`.
 */
const BY_NORMALIZED = new Map(SUPPORTED_LOCALES.map((locale) => [locale.toLowerCase(), locale]));

/** A supported locale under its own tag, or an alias of one. */
function resolve(tag: string): Locale | undefined {
  return BY_NORMALIZED.get(tag) ?? ALIASES[tag];
}

/**
 * The first tag that resolves to a supported locale, else the fallback.
 *
 * Iterating the *list* rather than reading a single tag is the point: a user whose
 * preferences are `["fr-FR", "zh-CN"]` gets Chinese, not English — their second choice is
 * one we speak. Resolution per tag is exact match → script/region alias → bare language.
 */
export function matchLocale(tags: readonly string[]): Locale {
  for (const raw of tags) {
    const tag = normalizeTag(raw);
    if (!tag) continue;

    // Exact tag first (`zh-CN`), then the bare language (`zh-Hans-CN` → `zh`), which is
    // what catches a script/region combination the alias table does not spell out.
    const direct = resolve(tag);
    if (direct) return direct;

    const base = resolve(tag.split("-")[0]!);
    if (base) return base;
  }
  return FALLBACK_LOCALE;
}

/** The locale to start in when nothing is stored: the browser's, or English. */
export function detectBrowserLocale(): Locale {
  if (typeof navigator === "undefined") return FALLBACK_LOCALE;
  const nav = navigator as Navigator & { languages?: readonly string[] };
  const tags = nav.languages?.length ? nav.languages : nav.language ? [nav.language] : [];
  return matchLocale(tags);
}
