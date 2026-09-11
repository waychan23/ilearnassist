<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

/**
 * The model's chain of thought, following chatbox's reasoning row (which in turn mirrors
 * DeepSeek's harness): a collapsed one-line header that previews the reasoning while it
 * streams, expanding to the full text.
 */
const props = defineProps<{
  content: string;
  /** Still arriving — drives the label, the animated dots and the timer. */
  thinking?: boolean;
  /** Elapsed thinking time in ms, when it was measured (streaming only). */
  durationMs?: number | null;
}>();

const { t } = useI18n();
const expanded = ref(false);
const copied = ref(false);

const hasDetail = computed(() => props.content.trim().length > 0);

const label = computed(() =>
  props.thinking ? t("message.reasoning.thinking") : t("message.reasoning.done")
);

const durationText = computed(() => {
  const ms = props.durationMs;
  if (!ms || ms < 500) return "";
  return `${(ms / 1000).toFixed(1)}s`;
});

/**
 * Which line to preview. While thinking, the *last* line — that is where the model is
 * right now. Once finished, the *first* line, which is a stable summary and stops the
 * row from looking like it is still moving.
 */
const summary = computed(() => {
  const text = props.content.trimEnd();
  if (!text) return "";
  if (props.thinking) {
    const i = text.lastIndexOf("\n");
    return i === -1 ? text : text.slice(i + 1);
  }
  const i = text.indexOf("\n");
  return i === -1 ? text : text.slice(0, i);
});

async function copy() {
  try {
    await navigator.clipboard.writeText(props.content);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    // Clipboard access can be denied; the panel is still selectable by hand.
  }
}
</script>

<template>
  <div v-if="hasDetail" class="reasoning" :class="{ thinking: props.thinking }" data-testid="reasoning">
    <div class="head" @click="expanded = !expanded">
      <span class="dot" :class="props.thinking ? 'live' : 'done'">💡</span>
      <span class="label">{{ label }}</span>
      <span v-if="props.thinking" class="dots"><i></i><i></i><i></i></span>
      <span v-if="durationText" class="time">{{ t("message.reasoning.duration", { duration: durationText }) }}</span>
      <span v-if="!expanded" class="summary">{{ summary }}</span>
      <button
        v-if="expanded"
        class="icon-btn copy"
        :title="copied ? t('common.copied') : t('message.reasoning.copy')"
        @click.stop="copy"
      >
        {{ copied ? "✓" : "⧉" }}
      </button>
      <span class="chevron" :class="{ open: expanded }">▾</span>
    </div>

    <div v-if="expanded" class="body">{{ props.content }}</div>
  </div>
</template>

<style scoped>
.reasoning {
  margin: 0 0 10px;
}

.head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  cursor: pointer;
  user-select: none;
  padding: 2px 0;
}

.dot {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
}
.dot.live {
  background: rgba(76, 139, 245, 0.16);
}
.dot.done {
  background: rgba(230, 179, 60, 0.14);
}

.label {
  flex-shrink: 0;
  font-size: 13px;
  font-weight: 500;
  color: var(--warning);
}
.reasoning.thinking .label {
  color: var(--accent);
}

.time {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

/* The live preview is single-line and clipped, so a long thought never reflows the row. */
.summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 12px;
  color: var(--text-3);
}

.copy {
  flex-shrink: 0;
  font-size: 11px;
  padding: 2px 4px;
}

.chevron {
  flex-shrink: 0;
  color: var(--text-3);
  font-size: 11px;
  transition: transform 0.15s;
}
.chevron.open {
  transform: rotate(180deg);
}

.body {
  margin: 6px 0 2px;
  padding-left: 12px;
  border-left: 2px solid var(--warning);
  max-height: 400px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-3);
}

.dots {
  display: inline-flex;
  gap: 3px;
  flex-shrink: 0;
}
.dots i {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--accent);
  animation: reasoning-blink 1.2s infinite ease-in-out;
}
.dots i:nth-child(2) {
  animation-delay: 0.2s;
}
.dots i:nth-child(3) {
  animation-delay: 0.4s;
}
@keyframes reasoning-blink {
  0%,
  80%,
  100% {
    opacity: 0.25;
  }
  40% {
    opacity: 1;
  }
}
</style>
