<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import Icon from "./Icon.vue";

/**
 * Copy a string to the clipboard, and say so.
 *
 * The confirmation is the point rather than decoration: this button sits next to a generated
 * password that is shown exactly once, and a copy that silently did nothing would be
 * discovered when the password has already been closed over. So the label changes for a
 * moment either way — to "copied" or to "copy failed" — because "nothing happened" is the one
 * outcome the user cannot act on.
 *
 * `navigator.clipboard` is absent outside a secure context (and in jsdom), so the failure
 * branch is reachable in normal use rather than theoretical.
 */

const props = defineProps<{ value: string; testid?: string }>();
const { t } = useI18n();

type State = "idle" | "copied" | "failed";
const state = ref<State>("idle");
let reset: ReturnType<typeof setTimeout> | null = null;

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.value);
    state.value = "copied";
  } catch {
    state.value = "failed";
  }
  if (reset) clearTimeout(reset);
  reset = setTimeout(() => (state.value = "idle"), 2000);
}
</script>

<template>
  <button
    class="btn small copy-btn"
    type="button"
    :data-testid="testid"
    :data-copy-state="state"
    @click="copy"
  >
    <Icon :name="state === 'copied' ? 'check' : 'copy'" />
    <span>{{
      state === "copied"
        ? t("common.copied")
        : state === "failed"
          ? t("common.copyFailed")
          : t("common.copy")
    }}</span>
  </button>
</template>

<style scoped>
.copy-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}
</style>
