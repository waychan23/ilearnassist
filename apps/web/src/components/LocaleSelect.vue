<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { useLocale } from "../composables/locale";
import type { Locale } from "../utils/locale";

/**
 * The language picker, on its own.
 *
 * Extracted from `TopbarControls` so the signed-out screen can offer it too: the login page is
 * the first thing a browser-language mismatch sees, and a form whose labels you cannot read
 * has no other place to switch them. The labels are autonyms so they stay readable in either
 * language — the same option says 中文 or English by language, not by name.
 */
const { t } = useI18n();
const { locale, setLocale, available } = useLocale();

function onLocaleChange(event: Event): void {
  setLocale((event.target as HTMLSelectElement).value as Locale);
}
</script>

<template>
  <!-- A select, not a cycle button: N locales on one icon is not legible. -->
  <select
    class="locale-select"
    :value="locale"
    :title="t('locale.switchLabel')"
    :aria-label="t('locale.switchLabel')"
    data-testid="locale-select"
    @change="onLocaleChange"
  >
    <option v-for="l in available" :key="l" :value="l">
      {{ l === "zh-CN" ? t("locale.zhCN") : t("locale.en") }}
    </option>
  </select>
</template>

<style scoped>
.locale-select {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-2);
  font-size: var(--fs-2);
  padding: 3px var(--space-2);
  cursor: pointer;
}
.locale-select:hover {
  color: var(--text);
}
</style>
