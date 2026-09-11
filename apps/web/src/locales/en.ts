import type MessageSchema from "./zh-CN";

/**
 * English — the fallback locale, and the language a visitor gets when their browser asks
 * for something we do not ship.
 *
 * Typed as the zh-CN schema, so `pnpm typecheck` fails on a missing *or* extra key here.
 * That is the first of two nets; `test/i18n/catalog.test.ts` is the second, and the one
 * that catches an untranslated copy-paste (a Chinese string left in this file).
 *
 * Plural messages use `|`; the zh-CN originals do not. Both catalogs are called the same
 * way — `t(key, count, { …params })` — so no component ever branches on the locale.
 */
const en: typeof MessageSchema = {
  app: {
    title: "guided-learning",
    configBanner: {
      before: "⚠ No API key is configured yet. Click",
      action: "⚙ Settings → Providers",
      after: "in the top right to add a Provider and its key; it takes effect as soon as you save.",
    },
  },

  // Autonyms: intentionally identical to the zh-CN catalog. See the note there.
  locale: {
    switchLabel: "Language",
    zhCN: "中文",
    en: "English",
  },

  theme: {
    light: "Light",
    dark: "Dark",
    auto: "Auto",
    autoCurrent: "Auto (currently {current})",
    toggleTitle: "Theme: {label} (click to switch)",
  },

  chat: {
    titleHint: "Titles are generated automatically and stop updating once you edit them",
  },
};

export default en;
