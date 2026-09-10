<script setup lang="ts">
import { computed } from "vue";
import type { Message, ToolCall } from "../api/types";
import { renderMarkdown } from "../utils/markdown";
import ToolCallCard from "./ToolCallCard.vue";

interface StreamingState {
  active: boolean;
  content: string;
  toolCalls: ToolCall[];
  error: string | null;
}

const props = defineProps<{
  message?: Message;
  streaming?: StreamingState;
}>();

const isUser = computed(() => props.message?.role === "user");
const isAssistant = computed(() => props.message?.role === "assistant" || !!props.streaming);

const content = computed(() =>
  props.streaming ? props.streaming.content : props.message?.content ?? ""
);
const toolCalls = computed(() =>
  props.streaming ? props.streaming.toolCalls : props.message?.toolCalls ?? []
);
const error = computed(() => props.streaming?.error ?? null);

const rendered = computed(() => {
  if (!content.value) return "";
  const html = renderMarkdown(content.value);
  return props.streaming ? html + '<span class="streaming-cursor"></span>' : html;
});
</script>

<template>
  <div v-if="isUser" class="msg user">
    <div class="bubble">{{ content }}</div>
  </div>

  <div v-else-if="isAssistant" class="msg assistant">
    <div class="avatar">🤖</div>
    <div class="body">
      <div v-if="error" class="error-banner">{{ error }}</div>
      <ToolCallCard v-for="tc in toolCalls" :key="tc.id" :tool-call="tc" />
      <div v-if="rendered" class="markdown" v-html="rendered"></div>
    </div>
  </div>
</template>