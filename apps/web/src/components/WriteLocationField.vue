<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { FileLocation } from "../api/types";

/**
 * Where an unqualified file write lands — one control, three levels.
 *
 * The agent can write into a workspace's shared `workdir/` or into a conversation's own folder,
 * and which one a given file belongs in is genuinely the user's call. So it is a setting, and
 * the setting has three levels: a workspace's default, a Copilot's override, a conversation's
 * own. This is the *control* for all three, because they ask the same question with the same
 * three answers, and three copies would be three chances to word "inherit" differently.
 *
 * `inheritLabel` is the caller's, because what inheriting *means* differs by level: from a
 * conversation it is the workspace's default, from a workspace it is the built-in one. Only the
 * caller knows which, so the sentence is theirs to write.
 */

const props = defineProps<{
  /** `null` is "no opinion at this level". */
  modelValue: FileLocation | null | undefined;
  /** What this level inherits from, spelled out — the sentence under the select. */
  inheritLabel: string;
  testid: string;
}>();

const emit = defineEmits<{ "update:modelValue": [value: FileLocation | null] }>();

const { t } = useI18n();

/** The three states, as `<option>` values: the empty string is `null`. */
const value = computed({
  get: () => props.modelValue ?? "",
  set: (next: string) => emit("update:modelValue", next === "" ? null : (next as FileLocation)),
});
</script>

<template>
  <label class="field">
    <span>{{ t("settings.writeLocation.label") }}</span>
    <select v-model="value" class="input" :data-testid="testid">
      <option value="">{{ inheritLabel }}</option>
      <option value="workspace">{{ t("settings.writeLocation.workspace") }}</option>
      <option value="session">{{ t("settings.writeLocation.session") }}</option>
    </select>
    <span class="hint">{{ t("settings.writeLocation.hint") }}</span>
  </label>
</template>

<style scoped>
.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  font-size: var(--fs-3);
  color: var(--text-2);
}
.hint {
  color: var(--text-3);
  font-size: var(--fs-2);
  line-height: var(--lh-base);
}
</style>
