import { ref } from "vue";
import { i18n, LOCALE_STORAGE_KEY } from "../i18n";
import { detectBrowserLocale, SUPPORTED_LOCALES, type Locale } from "../utils/locale";

/**
 * Language selection.
 *
 * Deliberately a *sibling* of `theme.ts`, not an abstraction over it — do not "refactor
 * for consistency". The two look alike but are not the same shape: theme validates a
 * three-value enum and drives an attribute CSS keys off; this validates a locale tag,
 * drives `<html lang>`, and pushes into a third-party instance (`i18n.global.locale`).
 * A shared `persistedPreference<T>()` would need a generic validator plus a side-effect
 * hook, which is more code than the six lines it saves. Revisit if a third persisted
 * preference appears.
 *
 * There is no `"auto"` value, unlike the theme. Dark/light is a preference people toggle
 * back and forth; language is chosen once. So *absence* of the storage key means "detect
 * from the browser", and the first explicit choice is permanent. If a "follow system"
 * action is ever wanted it is a `localStorage.removeItem`, not a third stored value.
 *
 * The key and the value set here MUST match the inline pre-paint script in `index.html`,
 * which sets `<html lang>` before the bundle loads.
 */

function readStored(): Locale | null {
  try {
    const value = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (value && (SUPPORTED_LOCALES as readonly string[]).includes(value)) return value as Locale;
  } catch {
    // Storage can be unavailable (private browsing, disabled cookies). Falling back to
    // detection is strictly better than crashing over a preference.
  }
  return null;
}

/* ------------------------------ reactive state ------------------------------ */

/** Module-level so the switcher, the store and the confirm defaults all agree. */
const locale = ref<Locale>(readStored() ?? detectBrowserLocale());

function apply(next: Locale): void {
  i18n.global.locale.value = next;
  document.documentElement.lang = next;
}

let applied = false;

export function useLocale() {
  // Apply once. The inline script has already set `lang` pre-paint; this keeps the
  // i18n instance and the attribute in lock-step with the same source of truth.
  if (!applied) {
    apply(locale.value);
    applied = true;
  }

  function setLocale(next: Locale): void {
    locale.value = next;
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      // Persistence is best-effort; the in-memory choice still applies this session.
    }
    apply(next);
  }

  return { locale, setLocale, available: SUPPORTED_LOCALES };
}
