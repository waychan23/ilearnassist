<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import Icon from "../Icon.vue";

/**
 * One text field, for the two file-manager actions that need a name.
 *
 * "New folder" and "rename or move" ask the same question — *what should this be called, and
 * where* — and differ only in their labels, so they share a dialog rather than each growing
 * their own. The value is a **path relative to the workspace root**, so a rename and a move are
 * the same edit: typing `notes/a.md` into a file's field moves it there and renames it in one
 * step, which is what the field's label says and what `POST …/files/move` does.
 *
 * The parent owns the outcome: this emits the value and closes nothing, so a failure can be
 * reported in the panel behind it without the dialog having decided the action was over. That
 * is the same split the other dialogs use — the form collects, the host acts.
 */

const props = defineProps<{
  title: string;
  label: string;
  /** Pre-filled value, and the empty string for a creation. */
  initial: string;
  confirmLabel: string;
}>();

const emit = defineEmits<{ close: []; submit: [value: string] }>();

const { t } = useI18n();
const value = ref(props.initial);
const input = ref<HTMLInputElement | null>(null);

function onEscape() {
  emit("close");
}

/**
 * Focus and select on open.
 *
 * Selecting rather than just focusing, because the field is pre-filled with the whole path for
 * a rename: someone who wants to rename `report-v2-final.md` should not have to clear it first,
 * and someone who wants to move it types over the selection in one motion.
 */
watch(
  () => props.initial,
  async () => {
    value.value = props.initial;
    await nextTick();
    input.value?.focus();
    input.value?.select();
  },
  { immediate: true }
);

function submit() {
  const trimmed = value.value.trim();
  if (!trimmed) return;
  emit("submit", trimmed);
}
</script>

<template>
  <Teleport to="body">
    <div class="modal-overlay" @click.self="emit('close')">
      <div class="modal" role="dialog" aria-modal="true" data-testid="file-path-dialog">
        <div class="modal-head">
          <h3>{{ title }}</h3>
          <button
            class="icon-btn"
            :title="t('common.close')"
            :aria-label="t('common.close')"
            data-testid="file-path-cancel"
            @click="emit('close')"
          >
            <Icon name="close" />
          </button>
        </div>
        <div class="modal-body">
          <label class="field">
            <span>{{ label }}</span>
            <input
              ref="input"
              v-model="value"
              class="input"
              data-testid="file-path-input"
              @keydown.enter.prevent="submit"
              @keydown.esc.prevent="onEscape"
            />
          </label>
        </div>
        <div class="modal-foot">
          <button class="btn" data-testid="file-path-cancel-foot" @click="emit('close')">
            {{ t("common.cancel") }}
          </button>
          <button
            class="btn primary"
            :disabled="!value.trim()"
            data-testid="file-path-submit"
            @click="submit"
          >
            {{ confirmLabel }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  font-size: var(--fs-3);
  color: var(--text-2);
}
</style>
