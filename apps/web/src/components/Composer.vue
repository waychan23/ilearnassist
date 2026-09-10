<script setup lang="ts">
import { ref } from "vue";
import { useAppStore } from "../stores/app";

const store = useAppStore();
const text = ref("");

function send() {
  const t = text.value.trim();
  if (!t) return;
  text.value = "";
  store.sendMessage(t);
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
}
</script>

<template>
  <div class="composer">
    <div class="inner">
      <textarea
        v-model="text"
        rows="1"
        :placeholder="store.streaming.active ? 'Agent 正在思考…' : '输入消息，Enter 发送，Shift+Enter 换行'"
        @keydown="onKeydown"
      ></textarea>
      <button
        class="btn primary"
        :disabled="store.streaming.active || !text.trim()"
        @click="send"
      >
        发送
      </button>
    </div>
  </div>
</template>