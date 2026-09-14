<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "../stores/app";
import { isInteractiveTool, type Message, type ToolCall } from "../api/types";
import { confirm } from "../composables/confirm";
import { renderMarkdown } from "../utils/markdown";
import { formatTokens } from "../utils/format";
import ToolCallCard from "./ToolCallCard.vue";
import AttachmentChips from "./AttachmentChips.vue";
import ReasoningBlock from "./ReasoningBlock.vue";
import Icon from "./Icon.vue";

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
  /**
   * This is the conversation's last surviving message.
   *
   * Both tail actions hang off it, and it is passed in rather than derived here because the
   * component is also rendered for the transient streaming turn, which is in no array to be
   * the last of. `ChatView` is the one place that knows the order.
   */
  isLast?: boolean;
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

/**
 * Tool cards that belong above the reply, and the questions that belong below it.
 *
 * A question is not an action the agent took on the way to answering — it is the last thing
 * in the turn, and the sentence in front of it introduces it ("请先回答下面几个问题：").
 * Rendering it above that sentence put a card demanding an answer *before* the words
 * explaining it, and while streaming it read as though the message had already ended and
 * then started talking again.
 *
 * Grouped by the shared `isInteractiveTool` rather than a name comparison each, so a third
 * question tool lands on the right side of the reply without an edit here. A *failed*
 * question call is grouped the same way and renders as an ordinary card — see
 * `ToolCallCard` — which is right because it happened in the same step as the one that
 * suspended, so it is at the end of the turn either way.
 */
const actionToolCalls = computed(() => toolCalls.value.filter((tc) => !isInteractiveTool(tc.name)));
const questionToolCalls = computed(() => toolCalls.value.filter((tc) => isInteractiveTool(tc.name)));
const error = computed(() => props.streaming?.error ?? null);
/**
 * Whether the user cut this reply short.
 *
 * Only a persisted message can carry this — the live stream has no equivalent state, and
 * stopping is not an error, so it deliberately does not reuse `error`.
 */
const stopped = computed(() => props.message?.stopped === true);
/**
 * Submitted attachments, with the live parse state overlaid.
 *
 * The message carries the state the server recorded when it was sent, which is correct on
 * a fresh load but stale as soon as the user re-parses from the chip — the message row
 * itself never changes after the fact.
 */
const attachments = computed(() =>
  (props.message?.attachments ?? []).map((a) => {
    // The message's own snapshot is a *source* — the server reassembled it when the turn was
    // sent — so the live overlay is the same object, later. `status` used to be the field
    // name; there is no trimming step any more, which is why this reads `parseStatus`.
    const live = store.parseStatus[a.id];
    if (!live) return a;
    return {
      ...a,
      parseStatus: live.parseStatus,
      parseError: live.parseError,
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

/**
 * Whether this reply is one the model can be asked to write again.
 *
 * A reply still waiting on an answer is not: the question card below it owns that state, and
 * regenerating would discard the very question the user is in the middle of answering. The
 * server refuses the same case, so this is the button agreeing with the route.
 */
const awaitingAnswer = computed(() =>
  (props.message?.toolCalls ?? []).some((tc) => isInteractiveTool(tc.name) && tc.status === "awaiting")
);

const canRegenerate = computed(
  () =>
    !!props.message &&
    props.isLast === true &&
    props.message.role === "assistant" &&
    !props.streaming &&
    !store.streaming.active &&
    !awaitingAnswer.value
);

/**
 * Whether the delete control belongs on this message.
 *
 * Both roles, last message only — deleting the tail and then the tail that emerges is the one
 * deletion that cannot leave a reply hanging over a question that is gone. A middle message
 * would be exactly that, so nothing is offered there rather than offered and refused.
 */
const canDelete = computed(
  () => !!props.message && props.isLast === true && !props.streaming && !store.streaming.active
);

async function deleteMessage(): Promise<void> {
  const message = props.message;
  if (!message) return;
  const ok = await confirm({
    title: t("message.delete.title"),
    message: t("message.delete.message"),
    detail: t("message.delete.detail"),
    confirmText: t("message.delete.action"),
    danger: true,
  });
  if (ok) await store.deleteMessage(message.id);
}

async function regenerate(): Promise<void> {
  const ok = await confirm({
    title: t("message.regenerate.title"),
    message: t("message.regenerate.message"),
    detail: t("message.regenerate.detail"),
    confirmText: t("message.regenerate.action"),
    danger: true,
  });
  if (ok) await store.regenerateLastMessage();
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
        :attachments="attachments"
      />
      <div v-if="content" class="bubble">{{ content }}</div>
      <div v-if="content && !props.streaming" class="actions">
        <button class="icon-btn act" :title="copied ? t('common.copied') : t('common.copy')" @click="copyMessage">
          <Icon :name="copied ? 'check' : 'copy'" /> {{ copied ? t("common.copied") : t("common.copy") }}
        </button>
        <button
          v-if="canDelete"
          class="icon-btn act danger"
          data-testid="message-delete"
          :title="t('message.delete.action')"
          :aria-label="t('message.delete.action')"
          @click="deleteMessage"
        >
          <Icon name="trash" />
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
    <div class="avatar"><Icon name="robot" /></div>
    <div class="body">
      <div v-if="error" class="error-banner">{{ error }}</div>
      <ReasoningBlock
        :content="reasoning"
        :thinking="reasoningThinking"
        :duration-ms="reasoningMs"
      />
      <ToolCallCard v-for="tc in actionToolCalls" :key="tc.id" :tool-call="tc" />
      <div v-if="rendered" class="markdown" data-testid="message-content" v-html="rendered"></div>
      <!-- Outside the content block above: a stop pressed before any text arrived leaves
           an empty reply, and that one still needs to say why it is empty. -->
      <div v-if="stopped" class="stopped-note" data-testid="message-stopped">
        {{ t("message.stopped") }}
      </div>
      <ToolCallCard v-for="tc in questionToolCalls" :key="tc.id" :tool-call="tc" />
      <div v-if="!props.streaming" class="actions">
        <button
          v-if="content"
          class="icon-btn act"
          :title="copied ? t('common.copied') : t('message.copyReply')"
          @click="copyMessage"
        >
          <Icon :name="copied ? 'check' : 'copy'" /> {{ copied ? t("common.copied") : t("common.copy") }}
        </button>
        <button
          v-if="canRegenerate"
          class="icon-btn act"
          data-testid="message-regenerate"
          :title="t('message.regenerate.action')"
          :aria-label="t('message.regenerate.action')"
          @click="regenerate"
        >
          <Icon name="retry" />
        </button>
        <button
          v-if="canDelete"
          class="icon-btn act danger"
          data-testid="message-delete"
          :title="t('message.delete.action')"
          :aria-label="t('message.delete.action')"
          @click="deleteMessage"
        >
          <Icon name="trash" />
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

/*
 * A device with no hover never fires the rule above, so the actions would be permanently
 * invisible — including the copy button, which is the only way to get a reply's text out.
 *
 * Keyed on the pointer rather than on a width. A 1024px tablet has no narrow-layout problem
 * and cannot hover either, so a `max-width` query here would leave it broken.
 *
 * No layout shift when this fires: `.actions` already reserves `min-height`, so only the
 * opacity changes.
 */
@media (hover: none) {
  .actions {
    opacity: 1;
  }
}

/* A finger is not a mouse pointer, so the target grows where it is the only input. 32px is
   deliberately between WCAG 2.5.8's 24px and iOS's 44px — a 44px copy button under every
   message is visually heavy, and the primary actions get the larger target. */
@media (pointer: coarse) {
  .act {
    min-height: 32px;
    padding: var(--space-3) var(--space-4);
  }
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
