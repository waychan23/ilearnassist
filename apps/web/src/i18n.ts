import { createI18n } from "vue-i18n";
import { catalogs } from "./locales";
import { detectBrowserLocale } from "./utils/locale";

/**
 * The vue-i18n instance.
 *
 * Both catalogs are bundled rather than lazy-loaded. zh-CN is the language of every
 * string this app started with, so it would be in the initial chunk regardless, and en is
 * the same key set — a few KB next to `highlight.js` and `markdown-it`. Lazy-loading
 * would buy nothing and add an async gap between mount and first render, which is a *real*
 * flash of the wrong language. Revisit above roughly three locales, at which point
 * `setLocale` becomes `await loadMessages(next)` and `main.ts` awaits it before `mount()`.
 *
 * `legacy: false` is required for `useI18n()`; `globalInjection` provides `$t` in the
 * templates that do not import it. `i18n.global.locale` is a `WritableComputedRef` under
 * this mode, which is what `composables/locale.ts` writes to.
 */

/** Read by `composables/locale.ts` and by the pre-paint script in `index.html`. */
export const LOCALE_STORAGE_KEY = "gl-locale";

export const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: detectBrowserLocale(),
  fallbackLocale: "en",
  messages: catalogs,
  // A key missing from `en` falling back to `zh-CN` is expected while a catalog is being
  // extended, so warning about it is noise. A *missing key* is a real defect — and it is
  // caught by the type system and `test/i18n/catalog.test.ts`, not by a runtime warning.
  fallbackWarn: false,
  missingWarn: import.meta.env.DEV,
  // No message may contain HTML — the one template that needs markup splits it across
  // three keys instead. See the note in CLAUDE.md.
  warnHtmlMessage: false,
  missing: import.meta.env.DEV
    ? (_locale: string, key: string) => {
        console.warn(`[i18n] missing key: ${key}`);
      }
    : undefined,
  // No datetimeFormats / numberFormats yet: nothing formats a date, and the numeric
  // formatting in `utils/format.ts` is deliberate (SI unit symbols, not words).
});
