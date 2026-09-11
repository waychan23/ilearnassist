<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "../../stores/app";

const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();
const store = useAppStore();

const title = ref("");
const copilotId = ref<string | null>(store.activeCopilotId);
const saving = ref(false);

async function create() {
  if (saving.value) return;
  saving.value = true;
  try {
    const session = await store.createSession(copilotId.value);
    if (session && title.value.trim()) {
      await store.renameSession(session.id, title.value);
    }
    emit("close");
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')">
    <div class="modal narrow">
      <div class="modal-head">
        <h3>{{ t("session.new.title") }}</h3>
        <button class="icon-btn" @click="emit('close')">✕</button>
      </div>
      <div class="modal-body">
        <div class="field">
          <label>{{ t("session.new.titleLabel") }}</label>
          <input
            v-model="title"
            class="input"
            data-testid="session-title-input"
            :placeholder="t('session.new.titlePlaceholder', { fallback: t('session.fallbackTitle') })"
          />
        </div>

        <div class="field">
          <label>Copilot</label>
          <div class="copilot-list">
            <label class="copilot-option" :class="{ active: copilotId === null }">
              <input v-model="copilotId" type="radio" :value="null" />
              <div>
                <div class="name">{{ t("session.new.noCopilot") }}</div>
                <div class="desc">{{ t("session.new.noCopilotDesc") }}</div>
              </div>
            </label>

            <label
              v-for="c in store.copilots"
              :key="c.id"
              class="copilot-option"
              :class="{ active: copilotId === c.id }"
            >
              <input v-model="copilotId" type="radio" :value="c.id" />
              <div>
                <div class="name">{{ c.name }}</div>
                <div v-if="c.description" class="desc">{{ c.description }}</div>
                <div v-else-if="c.systemPrompt" class="desc preview">
                  {{ c.systemPrompt.slice(0, 80) }}{{ c.systemPrompt.length > 80 ? "…" : "" }}
                </div>
              </div>
            </label>
          </div>
          <div v-if="store.copilots.length === 0" class="hint">
            {{ t("session.new.noCopilots") }}
          </div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn" @click="emit('close')">{{ t("common.cancel") }}</button>
        <button class="btn primary" data-testid="create-session" :disabled="saving" @click="create">
          {{ t("common.create") }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal.narrow {
  width: 460px;
}
.copilot-list {
  display: grid;
  gap: var(--space-4);
}
.copilot-option {
  display: flex;
  align-items: flex-start;
  gap: var(--space-5);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: var(--space-5) var(--space-6);
  cursor: pointer;
  background: var(--panel-2);
}
.copilot-option.active {
  border-color: var(--accent);
}
.copilot-option input {
  margin-top: 3px;
}
.copilot-option .name {
  font-size: var(--fs-3);
  font-weight: 500;
}
.copilot-option .desc {
  font-size: var(--fs-2);
  color: var(--text-3);
  margin-top: var(--space-1);
}
.copilot-option .desc.preview {
  font-style: italic;
}
</style>
