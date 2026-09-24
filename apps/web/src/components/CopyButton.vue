<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import Icon from "./Icon.vue";
import { copyRich } from "../utils/clipboard";

/**
 * Copy a string to the clipboard, and say so.
 *
 * The confirmation is the point rather than decoration: this button sits next to a generated
 * password that is shown exactly once, and a copy that silently did nothing would be
 * discovered when the password has already been closed over. So the label changes for a
 * moment either way — to "copied" or to "copy failed" — because "nothing happened" is the one
 * outcome the user cannot act on.
 *
 * The write itself is `utils/clipboard.ts`'s, including the fallback for an origin with no
 * `navigator.clipboard` — the LAN address is one, and it is reachable in normal use rather than
 * theoretical.
 */

const props = defineProps<{
  value: string;
  testid?: string;
  /**
   * A tooltip for a copy that is not the whole thing.
   *
   * The file preview is where this exists: past the preview cap the server sends the head of the
   * file and says so in the body, and a button reading just 复制 would let someone take a
   * quarter of a log away believing it was all of it. Optional, because every other caller copies
   * exactly what it says it does.
   */
  hint?: string;
  /**
   * The same thing as markup, offered alongside the text.
   *
   * A table is where this exists, and the two flavours are for two targets rather than two
   * preferences: pasted into a document the reader wants the table, and pasted into a source file
   * or a chat box the markdown is what they want. So one press writes both and the *target*
   * decides — which is the behaviour every rich-text editor's clipboard already has, and the
   * reason this is not a second button.
   *
   * `write()` with a `ClipboardItem` needs a secure context and a browser that has `ClipboardItem`
   * at all; where it is missing, the text is what gets written, because a copy that half-worked is
   * worse than one that took the plainer of the two. `utils/clipboard.ts` is where that choice is
   * made, and where the origin with no clipboard API at all is answered.
   */
  html?: string;
}>();
const { t } = useI18n();

type State = "idle" | "copied" | "failed";
const state = ref<State>("idle");
let reset: ReturnType<typeof setTimeout> | null = null;

async function copy(): Promise<void> {
  try {
    await copyRich(props.value, props.html ?? null);
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
    :title="hint"
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
