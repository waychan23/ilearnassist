<script setup lang="ts">
import { onMounted } from "vue";
import { useAppStore } from "./stores/app";
import Sidebar from "./components/Sidebar.vue";
import ChatView from "./components/ChatView.vue";

const store = useAppStore();

onMounted(() => {
  store.init().catch((e) => store.setError(e instanceof Error ? e.message : String(e)));
});
</script>

<template>
  <div class="app">
    <Sidebar />
    <ChatView />
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
  background: #3a1d1b;
  border: 1px solid rgba(229, 83, 75, 0.5);
  color: #f2a19c;
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