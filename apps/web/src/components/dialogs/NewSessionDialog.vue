<script setup lang="ts">
import { ref } from "vue";
import { useAppStore } from "../../stores/app";

const emit = defineEmits<{ close: [] }>();
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
        <h3>新建会话</h3>
        <button class="icon-btn" @click="emit('close')">✕</button>
      </div>
      <div class="modal-body">
        <div class="field">
          <label>标题（可选）</label>
          <input v-model="title" class="input" placeholder="留空则为「新会话」" />
        </div>

        <div class="field">
          <label>Copilot</label>
          <div class="copilot-list">
            <label class="copilot-option" :class="{ active: copilotId === null }">
              <input v-model="copilotId" type="radio" :value="null" />
              <div>
                <div class="name">不使用 Copilot</div>
                <div class="desc">使用内置的通用助手设定与默认参数。</div>
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
            还没有 Copilot。可在「设置 → Copilots」中创建。
          </div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn" @click="emit('close')">取消</button>
        <button class="btn primary" :disabled="saving" @click="create">创建</button>
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
  gap: 8px;
}
.copilot-option {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px 12px;
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
  font-size: 13px;
  font-weight: 500;
}
.copilot-option .desc {
  font-size: 12px;
  color: var(--text-3);
  margin-top: 2px;
}
.copilot-option .desc.preview {
  font-style: italic;
}
</style>
