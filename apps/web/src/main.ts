import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { i18n } from "./i18n";
import { useLocale } from "./composables/locale";
import "highlight.js/styles/github-dark.css";
import "./style.css";

// Runs before mount so `<html lang>` and the i18n instance agree with storage (or with
// the browser) for the very first render. Not inject-dependent, so calling it here is
// safe — same as the inline script's `data-theme` counterpart.
useLocale();

createApp(App).use(createPinia()).use(i18n).mount("#app");