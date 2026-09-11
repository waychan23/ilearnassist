<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "../../stores/app";

const { t } = useI18n();
const store = useAppStore();
const emit = defineEmits<{ close: []; created: [] }>();

const name = ref("");
const saving = ref(false);

async function submit() {
  const n = name.value.trim();
  if (!n || saving.value) return;
  saving.value = true;
  try {
    await store.createWorkspace(n);
    emit("created");
  } catch (e) {
    store.setError(e instanceof Error ? e.message : String(e));
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')">
    <div class="modal">
      <div class="modal-head">
        <h3>{{ t("workspace.new.title") }}</h3>
        <button
        class="icon-btn"
        :title="t('common.close')"
        :aria-label="t('common.close')"
        @click="emit('close')"
      >✕</button>
      </div>
      <div class="modal-body">
        <div class="field">
          <label>{{ t("common.name") }}</label>
          <input
            v-model="name"
            class="input"
            :placeholder="t('workspace.new.namePlaceholder')"
            @keydown.enter="submit"
          />
          <div class="hint">{{ t("workspace.new.hint") }}</div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn" @click="emit('close')">{{ t("common.cancel") }}</button>
        <button class="btn primary" :disabled="!name.trim() || saving" @click="submit">
          {{ t("common.create") }}
        </button>
      </div>
    </div>
  </div>
</template>