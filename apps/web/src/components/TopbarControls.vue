<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useTheme } from "../composables/theme";
import { useLocale } from "../composables/locale";
import type { Locale } from "../utils/locale";
import Icon from "./Icon.vue";

/**
 * The language picker and the theme button, as one unit.
 *
 * Extracted when the workspace home arrived. Both views need them — a visitor whose first
 * screen is the workspace list has to be able to reach the theme *before* entering a
 * workspace, or the only way to change it is to walk into a workspace and out again — and
 * the theme trio's labels, its icon map and the `data-testid`s the specs select on would
 * otherwise have been copied into a second header that drifts from this one.
 *
 * The labels stay here rather than in `chat.*` for the same reason: the control belongs to
 * neither view.
 */
const { t } = useI18n();
const theme = useTheme();
const { locale, setLocale, available } = useLocale();

/** Icons are not translatable — only the labels are. */
const THEME_ICON = { light: "sun", dark: "moon", auto: "monitor" } as const;

const themeIcon = computed(() => THEME_ICON[theme.mode.value]);
/** "自动（当前浅色）" reads clearer than just "自动" when the OS is doing the deciding. */
const themeLabel = computed(() =>
  theme.mode.value === "auto"
    ? t("theme.autoCurrent", { current: t(`theme.${theme.resolved.value}`) })
    : t(`theme.${theme.mode.value}`)
);

function onLocaleChange(event: Event): void {
  setLocale((event.target as HTMLSelectElement).value as Locale);
}
</script>

<template>
  <div class="topbar-actions">
    <!-- A select, not a cycle button: N locales on one icon is not legible, and the
         labels are autonyms so they stay readable in either language. -->
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
    <button
      class="icon-btn theme-toggle"
      :title="t('theme.toggleTitle', { label: themeLabel })"
      data-testid="theme-toggle"
      @click="theme.cycle()"
    >
      <Icon :name="themeIcon" />
    </button>
  </div>
</template>

<style scoped>
.topbar-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-shrink: 0;
}
.theme-toggle {
  font-size: var(--fs-5);
  padding: var(--space-2) var(--space-4);
}
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
