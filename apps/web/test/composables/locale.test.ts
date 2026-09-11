import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The locale composable is the only stateful bit of the i18n feature — it owns the
 * `localStorage` key, `<html lang>`, and the push into `i18n.global.locale` — so it is
 * unit tested in jsdom while the components that consume it are left to Playwright.
 *
 * The module reads storage and the browser language at import time, so every scenario
 * needs a fresh import (`vi.resetModules()`), exactly like `theme.test.ts`.
 */

type LocaleApi = ReturnType<typeof import("../../src/composables/locale").useLocale>;

/** Import the composable and its i18n instance fresh, under a given stored/browser state. */
async function loadLocale(options: {
  stored?: string | null;
  languages?: string[];
  storageThrows?: boolean;
}) {
  vi.resetModules();
  localStorage.clear();

  if (options.stored != null) localStorage.setItem("gl-locale", options.stored);
  if (options.storageThrows) {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {
        throw new Error("storage disabled");
      },
    });
  }
  vi.stubGlobal("navigator", {
    languages: options.languages ?? ["en-US"],
    language: (options.languages ?? ["en-US"])[0],
  });

  const i18nModule = await import("../../src/i18n");
  const localeModule = await import("../../src/composables/locale");
  return { api: localeModule.useLocale() as LocaleApi, i18n: i18nModule.i18n };
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  document.documentElement.lang = "";
});

describe("useLocale", () => {
  it("starts from the browser language when nothing is stored", async () => {
    const { api, i18n } = await loadLocale({ stored: null, languages: ["zh-CN"] });

    expect(api.locale.value).toBe("zh-CN");
    expect(i18n.global.locale.value).toBe("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
  });

  it("falls back to English for an unsupported browser language", async () => {
    const { api, i18n } = await loadLocale({ stored: null, languages: ["fr-FR"] });

    expect(api.locale.value).toBe("en");
    expect(i18n.global.locale.value).toBe("en");
    expect(document.documentElement.lang).toBe("en");
  });

  it("lets a stored choice win over the browser language", async () => {
    const { api } = await loadLocale({ stored: "en", languages: ["zh-CN"] });

    expect(api.locale.value).toBe("en");
  });

  it("ignores a stored value that is not a supported locale", async () => {
    const { api } = await loadLocale({ stored: "de-DE", languages: ["zh-CN"] });

    expect(api.locale.value).toBe("zh-CN");
  });

  it("survives storage being unavailable", async () => {
    // Private browsing / disabled cookies: detection is a fine fallback, a crash is not.
    const { api } = await loadLocale({ stored: null, languages: ["zh-CN"], storageThrows: true });

    expect(api.locale.value).toBe("zh-CN");
  });

  it("setLocale persists, applies and drives the i18n instance", async () => {
    const { api, i18n } = await loadLocale({ stored: null, languages: ["en-US"] });
    expect(api.locale.value).toBe("en");

    api.setLocale("zh-CN");

    expect(api.locale.value).toBe("zh-CN");
    expect(localStorage.getItem("gl-locale")).toBe("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(i18n.global.locale.value).toBe("zh-CN");
  });

  it("exposes the supported locales for the switcher", async () => {
    const { api } = await loadLocale({ stored: null });
    expect([...api.available]).toEqual(["zh-CN", "en"]);
  });

  it("is idempotent across calls", async () => {
    const { api } = await loadLocale({ stored: null, languages: ["zh-CN"] });

    const second = (await import("../../src/composables/locale")).useLocale();

    expect(second.locale.value).toBe("zh-CN");
    // Same module-level ref, not a second copy of the state.
    expect(second.locale).toBe(api.locale);
  });
});
