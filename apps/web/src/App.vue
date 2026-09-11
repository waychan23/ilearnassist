<script setup lang="ts">
import { onMounted } from "vue";
import { useAppStore } from "./stores/app";
import Sidebar from "./components/Sidebar.vue";
import ChatView from "./components/ChatView.vue";
import ConfirmDialog from "./components/dialogs/ConfirmDialog.vue";
import SettingsDialog from "./components/dialogs/SettingsDialog.vue";
import { closeSettings, uiState } from "./composables/ui";

const store = useAppStore();

onMounted(() => {
  store.init().catch((e) => store.setError(e instanceof Error ? e.message : String(e)));
});
</script>

<template>
  <div class="app">
    <Sidebar />
    <ChatView />
    <!-- Hosted once so every `confirm()` call from anywhere lands in the same prompt. -->
    <ConfirmDialog />
    <!-- Reachable from the sidebar footer and the composer's model picker. -->
    <SettingsDialog v-if="uiState.settingsOpen" @close="closeSettings" />
    <Transition name="fade">
      <div v-if="store.error" class="toast">
        <span>{{ store.error }}</span>
        <button class="icon-btn" @click="store.setError(null)">✕</button>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.toast {
  position: fixed;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--panel);
  border: 1px solid var(--danger-border);
  color: var(--danger-text);
  padding: 10px 16px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  gap: 12px;
  max-width: 80vw;
  z-index: 200;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.4);
  font-size: 13px;
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>