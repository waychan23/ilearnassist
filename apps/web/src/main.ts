import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { useAppStore } from "./stores/app";
import { i18n } from "./i18n";
import { router } from "./router";
import { installGuards } from "./router/guards";
import { useLocale } from "./composables/locale";
// The highlight.js theme is not imported here: syntax colours have to follow the resolved
// theme, so `composables/theme.ts` swaps the matching stylesheet in (and importing one
// here as well would leave a second, unscoped copy fighting it).
//
// KaTeX's sheet is the opposite case and is imported outright: there is one of it, and its
// glyphs carry no `color` of their own, so they inherit `--text` and follow the theme with
// nothing to swap. It goes *first* so that `style.css` still wins any tie — Vite keeps
// import order in the bundle, so the two agree in dev (both injected at module evaluation)
// and in a build (both concatenated in this order).
import "katex/dist/katex.min.css";
import "./style.css";

// Runs before mount so `<html lang>` and the i18n instance agree with storage (or with
// the browser) for the very first render. Not inject-dependent, so calling it here is
// safe — same as the inline script's `data-theme` counterpart.
useLocale();

const pinia = createPinia();

/*
 * The guards go on **before** the router is installed, and that order is the whole of "a
 * reload lands where you were": installing a router is what starts the first navigation, so a
 * guard registered afterwards would miss it — and the first navigation is the one that decides
 * which page this tab opens on.
 *
 * The store is built here rather than reached for inside the guards because Pinia's store has
 * to be active to be looked up, and the app is not mounted yet. Same store either way: this is
 * the instance every component will resolve to.
 */
installGuards(router, useAppStore(pinia));

createApp(App).use(pinia).use(i18n).use(router).mount("#app");