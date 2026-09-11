<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "../stores/app";
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

const { t } = useI18n();
const store = useAppStore();

const isUser = computed(() => props.message?.role === "user");
const isAssistant = computed(() => props.message?.role === "assistant" || !!props.streaming);

const content = computed(() =>
  props.streaming ? props.streaming.content : props.message?.content ?? ""
);
const toolCalls = computed(() =>
  props.streaming ? props.streaming.toolCalls : props.message?.toolCalls ?? []
);
const error = computed(() => props.streaming?.error ?? null);
/**
 * Submitted attachments, with the live parse state overlaid.
 *
 * The message carries the state the server recorded when it was sent, which is correct on
 * a fresh load but stale as soon as the user re-parses from the chip — the message row
 * itself never changes after the fact.
 */
const attachments = computed(() =>
  (props.message?.attachments ?? []).map((a) => {
    const live = store.parseStatus[a.id];
    if (!live) return a;
    return {
      ...a,
      parseStatus: live.status,
      parseError: live.error,
      parserId: live.parserId,
      parsedChars: live.parsedChars,
      pageCount: live.pageCount,
    };
  })
);

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
  // Labels, not plurals — the number is formatted by formatTokens, not by i18n.
  if (u.inputTokens) parts.push(t("message.usage.input") + " " + formatTokens(u.inputTokens));
  if (u.outputTokens) parts.push(t("message.usage.output") + " " + formatTokens(u.outputTokens));
  if (u.totalTokens) parts.push(t("message.usage.total") + " " + formatTokens(u.totalTokens));
  if (u.cachedInputTokens) {
    parts.push(t("message.usage.cached") + " " + formatTokens(u.cachedInputTokens));
  }
  return parts.join(" · ");
});
</script>

<template>
  <div v-if="isUser" class="msg user" data-testid="message-user" :data-message-id="props.message?.id">
    <div class="user-stack">
      <AttachmentChips
        v-if="attachments.length"
        :session-id="props.message?.sessionId ?? ''"
        :attachments="attachments"
      />
      <div v-if="content" class="bubble">{{ content }}</div>
      <div v-if="content && !props.streaming" class="actions">
        <button class="icon-btn act" :title="copied ? t('common.copied') : t('common.copy')" @click="copyMessage">
          {{ copied ? "✓ " + t("common.copied") : "⧉ " + t("common.copy") }}
        </button>
      </div>
    </div>
  </div>

  <div
    v-else-if="isAssistant"
    class="msg assistant"
    data-testid="message-assistant"
    :data-message-id="props.message?.id"
  >
    <div class="avatar">🤖</div>
    <div class="body">
      <div v-if="error" class="error-banner">{{ error }}</div>
      <ReasoningBlock
        :content="reasoning"
        :thinking="reasoningThinking"
        :duration-ms="reasoningMs"
      />
      <ToolCallCard v-for="tc in toolCalls" :key="tc.id" :tool-call="tc" />
      <div v-if="rendered" class="markdown" data-testid="message-content" v-html="rendered"></div>
      <div v-if="!props.streaming" class="actions">
        <button
          v-if="content"
          class="icon-btn act"
          :title="copied ? t('common.copied') : t('message.copyReply')"
          @click="copyMessage"
        >
          {{ copied ? "✓ " + t("common.copied") : "⧉ " + t("common.copy") }}
        </button>
        <span v-if="usageText" class="usage-line" :title="t('message.contextTokens', { count: formatTokens(usage?.contextTokens ?? 0) })">
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
  gap: var(--space-3);
  max-width: 78%;
}
.user-stack .bubble {
  max-width: 100%;
}
/* Actions stay out of the way until the message is hovered, as in chatbox. */
.actions {
  display: flex;
  align-items: center;
  gap: var(--space-5);
  margin-top: var(--space-2);
  min-height: 20px;
  opacity: 0;
  transition: opacity var(--dur-fast);
}
.msg:hover .actions,
.actions:focus-within {
  opacity: 1;
}
.user-stack .actions {
  justify-content: flex-end;
}
.act {
  font-size: var(--fs-1);
  padding: var(--space-1) var(--space-3);
  color: var(--text-3);
}
.usage-line {
  font-size: var(--fs-1);
  color: var(--text-3);
  cursor: default;
}
</style>
