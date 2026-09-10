<script setup lang="ts">
import { computed, ref } from "vue";
import type { Message, ToolCall } from "../api/types";
import { renderMarkdown } from "../utils/markdown";
import { formatTokens } from "../utils/format";
import ToolCallCard from "./ToolCallCard.vue";
import AttachmentChips from "./AttachmentChips.vue";
import ReasoningBlock from "./ReasoningBlock.vue";

interface StreamingState {
  active: boolean;
  content: string;
  reasoning: string;
  thinking: boolean;
  reasoningMs: number | null;
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
const attachments = computed(() => props.message?.attachments ?? []);

/**
 * Chain of thought. Live while streaming (with the timer), or from the persisted
 * message once the turn is done — the duration is only known while streaming, since it
 * is measured client-side rather than stored.
 */
const reasoning = computed(() =>
  props.streaming ? props.streaming.reasoning : props.message?.reasoning ?? ""
);
const reasoningThinking = computed(() => props.streaming?.thinking ?? false);
const reasoningMs = computed(() => (props.streaming ? props.streaming.reasoningMs : null));

const rendered = computed(() => {
  if (!content.value) return "";
  const html = renderMarkdown(content.value);
  return props.streaming ? html + '<span class="streaming-cursor"></span>' : html;
});

/** Token accounting for a finished assistant turn, when the provider reported it. */
/* ------------------------------- copy action ------------------------------- */
const copied = ref(false);

/** Copy the message's visible text (never the reasoning — that is a separate action). */
async function copyMessage() {
  if (!content.value) return;
  try {
    await navigator.clipboard.writeText(content.value);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    // Clipboard access can be denied; the text stays selectable by hand.
  }
}

const usage = computed(() => props.message?.usage ?? null);
const usageText = computed(() => {
  const u = usage.value;
  if (!u) return "";
  const parts: string[] = [];
  if (u.inputTokens) parts.push(`输入 ${formatTokens(u.inputTokens)}`);
  if (u.outputTokens) parts.push(`输出 ${formatTokens(u.outputTokens)}`);
  if (u.totalTokens) parts.push(`合计 ${formatTokens(u.totalTokens)}`);
  if (u.cachedInputTokens) parts.push(`缓存命中 ${formatTokens(u.cachedInputTokens)}`);
  return parts.join(" · ");
});
</script>

<template>
  <div v-if="isUser" class="msg user" :data-message-id="props.message?.id">
    <div class="user-stack">
      <AttachmentChips
        v-if="attachments.length"
        :session-id="props.message?.sessionId ?? ''"
        :attachments="attachments"
      />
      <div v-if="content" class="bubble">{{ content }}</div>
      <div v-if="content && !props.streaming" class="actions">
        <button class="icon-btn act" :title="copied ? '已复制' : '复制'" @click="copyMessage">
          {{ copied ? "✓ 已复制" : "⧉ 复制" }}
        </button>
      </div>
    </div>
  </div>

  <div v-else-if="isAssistant" class="msg assistant" :data-message-id="props.message?.id">
    <div class="avatar">🤖</div>
    <div class="body">
      <div v-if="error" class="error-banner">{{ error }}</div>
      <ReasoningBlock
        :content="reasoning"
        :thinking="reasoningThinking"
        :duration-ms="reasoningMs"
      />
      <ToolCallCard v-for="tc in toolCalls" :key="tc.id" :tool-call="tc" />
      <div v-if="rendered" class="markdown" v-html="rendered"></div>
      <div v-if="!props.streaming" class="actions">
        <button
          v-if="content"
          class="icon-btn act"
          :title="copied ? '已复制' : '复制回复'"
          @click="copyMessage"
        >
          {{ copied ? "✓ 已复制" : "⧉ 复制" }}
        </button>
        <span v-if="usageText" class="usage-line" :title="`本轮上下文 ${formatTokens(usage?.contextTokens ?? 0)} tokens`">
          {{ usageText }}
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.user-stack {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  max-width: 78%;
}
.user-stack .bubble {
  max-width: 100%;
}
/* Actions stay out of the way until the message is hovered, as in chatbox. */
.actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 4px;
  min-height: 20px;
  opacity: 0;
  transition: opacity 0.12s;
}
.msg:hover .actions,
.actions:focus-within {
  opacity: 1;
}
.user-stack .actions {
  justify-content: flex-end;
}
.act {
  font-size: 11px;
  padding: 2px 6px;
  color: var(--text-3);
}
.usage-line {
  font-size: 11px;
  color: var(--text-3);
  cursor: default;
}
</style>
