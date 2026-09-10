<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { useAppStore } from "../stores/app";
import MessageItem from "./MessageItem.vue";
import Composer from "./Composer.vue";
import SettingsDialog from "./dialogs/SettingsDialog.vue";

const store = useAppStore();
const showSettings = ref(false);
const messagesEl = ref<HTMLElement | null>(null);

function onProviderChange(e: Event) {
  store.setProvider((e.target as HTMLSelectElement).value);
}

function onModelChange(e: Event) {
  store.setModel((e.target as HTMLSelectElement).value);
}

function scrollToBottom() {
  nextTick(() => {
    if (messagesEl.value) messagesEl.value.scrollTop = messagesEl.value.scrollHeight;
  });
}

watch(
  () => [store.messages.length, store.streaming.content, store.streaming.toolCalls.length],
  () => scrollToBottom()
);
</script>

<template>
  <main class="main">
    <header class="topbar">
      <div class="title">
        {{ store.activeSession?.title || store.activeWorkspace?.name || "guided-learning" }}
      </div>

      <select
        class="select provider"
        :value="store.currentProviderId"
        @change="onProviderChange"
      >
        <option v-for="p in store.config?.providers ?? []" :key="p.id" :value="p.id">
          {{ p.name }}
        </option>
      </select>

      <select
        class="select model"
        :value="store.effectiveModelId"
        :disabled="store.modelOptions.length === 0"
        @change="onModelChange"
      >
        <option v-for="m in store.modelOptions" :key="m.id" :value="m.id">{{ m.name }}</option>
      </select>

      <button class="icon-btn" title="设置" @click="showSettings = true">⚙</button>
    </header>

    <div v-if="!store.isConfigured" class="config-banner">
      ⚠ 尚未配置可用的 API Key，请在根目录 <code>config.yaml</code> / <code>.env</code> 中配置后重启服务。
    </div>

    <div ref="messagesEl" class="messages">
      <div v-if="store.messages.length === 0 && !store.streaming.active" class="empty-state">
        <h2>{{ store.activeCopilot?.name ?? "开始对话" }}</h2>
        <p>在下方输入消息，Agent 将按需调用工具。</p>
      </div>
      <MessageItem v-for="m in store.messages" :key="m.id" :message="m" />
      <MessageItem v-if="store.streaming.active" :streaming="store.streaming" />
    </div>

    <Composer />

    <SettingsDialog v-if="showSettings" @close="showSettings = false" />
  </main>
</template>

<style scoped>
.topbar .select {
  width: 150px;
}
.topbar .select.model {
  width: 210px;
}
.config-banner {
  margin: 0;
  padding: 8px 16px;
  background: rgba(230, 179, 60, 0.12);
  border-bottom: 1px solid rgba(230, 179, 60, 0.35);
  color: #e6c06a;
  font-size: 13px;
  flex-shrink: 0;
}
.config-banner code {
  background: var(--code-bg);
  padding: 1px 5px;
  border-radius: 4px;
}
</style>