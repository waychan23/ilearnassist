<script setup lang="ts">
import { ref } from "vue";
import { useAppStore } from "../../stores/app";

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
        <h3>新建工作区</h3>
        <button class="icon-btn" @click="emit('close')">✕</button>
      </div>
      <div class="modal-body">
        <div class="field">
          <label>名称</label>
          <input
            v-model="name"
            class="input"
            placeholder="例如：My Project"
            @keydown.enter="submit"
          />
          <div class="hint">将在工作区根目录自动创建对应的子目录。</div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn" @click="emit('close')">取消</button>
        <button class="btn primary" :disabled="!name.trim() || saving" @click="submit">
          创建
        </button>
      </div>
    </div>
  </div>
</template>