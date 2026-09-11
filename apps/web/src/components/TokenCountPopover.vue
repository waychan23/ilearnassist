<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "../stores/app";
import { estimateTokens, formatTokens } from "../utils/format";
import { DEFAULT_CONTEXT_WINDOW } from "../api/types";
import { isCoarsePointer } from "../composables/breakpoints";

const props = defineProps<{ pendingText: string }>();

const { t } = useI18n();
const store = useAppStore();
const open = ref(false);
const rootEl = ref<HTMLElement | null>(null);

/**
 * Open on hover, but only where hover exists.
 *
 * This used to be an unconditional `@mouseenter` beside the click toggle, and on a touch
 * device a tap fires both: `mouseenter` set `open` true and the `click` immediately set it
 * back to false. The popover opened and shut on every tap and could never stay up, because
 * there is no `mouseleave` on a touch screen to reset it either.
 */
function onHoverEnter() {
  if (!isCoarsePointer.value) open.value = true;
}

function onHoverLeave() {
  if (!isCoarsePointer.value) open.value = false;
}

/** Tapping anywhere else dismisses it — the touch equivalent of moving the mouse away. */
function onDocumentPointerDown(event: PointerEvent) {
  if (rootEl.value && !rootEl.value.contains(event.target as Node)) open.value = false;
}

watch(open, (isOpen) => {
  if (isOpen) document.addEventListener("pointerdown", onDocumentPointerDown, true);
  else document.removeEventListener("pointerdown", onDocumentPointerDown, true);
});

onBeforeUnmount(() => document.removeEventListener("pointerdown", onDocumentPointerDown, true));

/** Tokens the *next* turn will roughly add, on top of the existing context. */
const pending = computed(() => estimateTokens(props.pendingText));

/** Size of the conversation as of the last completed turn. */
const used = computed(() => store.contextTokens);

const limit = computed(() => store.contextWindow ?? DEFAULT_CONTEXT_WINDOW);
const usingFallbackLimit = computed(() => store.contextWindow == null);

const projected = computed(() => used.value + pending.value);
const ratio = computed(() => Math.min(projected.value / limit.value, 1));

const messageLimit = computed(() => store.sessionSettings.maxContextMessages ?? null);
const messageCount = computed(() => store.messages.length);

const level = computed(() => (ratio.value > 0.9 ? "high" : ratio.value > 0.7 ? "warn" : "ok"));

/** Compact label always visible on the button. */
const label = computed(() => {
  if (used.value === 0 && pending.value === 0) return "—";
  return `${formatTokens(projected.value)} / ${formatTokens(limit.value)}`;
});
</script>

<template>
  <div ref="rootEl" class="token-wrap" @mouseenter="onHoverEnter" @mouseleave="onHoverLeave">
    <button class="pill token-btn" :class="level" :aria-expanded="open" @click="open = !open">
      <span class="ring" :style="{ '--pct': `${ratio * 100}%` }"></span>
      {{ label }}
    </button>

    <div v-if="open" class="overlay-popover popover">
      <div class="row">
        <span>{{ t("tokens.used") }}</span>
        <span class="num">{{ formatTokens(used) }}</span>
      </div>
      <div class="row">
        <span>{{ t("tokens.pending") }}</span>
        <span class="num">{{ pending ? `+${formatTokens(pending)}` : "—" }}</span>
      </div>
      <div class="row total">
        <span>{{ t("tokens.projected") }}</span>
        <span class="num">{{ formatTokens(projected) }}</span>
      </div>

      <div class="bar">
        <div class="fill" :class="level" :style="{ width: `${ratio * 100}%` }"></div>
      </div>
      <div class="bar-label">
        <span>{{ (ratio * 100).toFixed(1) }}% of {{ formatTokens(limit) }}</span>
        <span v-if="usingFallbackLimit" class="approx" :title="t('tokens.limitHint')">
          {{ t("tokens.estimatedLimit") }}
        </span>
      </div>

      <div class="row">
        <span>{{ t("tokens.messages") }}</span>
        <span class="num">
          {{ messageCount }}<template v-if="messageLimit"> / {{ messageLimit }}</template>
        </span>
      </div>
      <div class="row">
        <span>{{ t("tokens.maxSteps") }}</span>
        <span class="num">{{ store.sessionSettings.maxSteps ?? 15 }}</span>
      </div>

      <div class="note">
        {{ t("tokens.note") }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.token-wrap {
  position: relative;
  display: flex;
  align-items: center;
}
.token-btn {
  background: transparent;
  color: var(--text-3);
  font-size: var(--fs-1);
  padding: var(--space-2) var(--space-5);
  cursor: pointer;
  /* `nowrap` with no cap: the counter is a fixed-width figure, so the only thing that can
     grow it is the label, and on a narrow screen it must not take the row. */
  max-width: 40vw;
  overflow: hidden;
  white-space: nowrap;
}
.token-btn:hover {
  color: var(--text-2);
  border-color: var(--text-3);
}
.ring {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: conic-gradient(var(--ring, var(--success)) var(--pct), var(--border) 0);
}
.token-btn.ok {
  --ring: var(--success);
}
.token-btn.warn {
  --ring: var(--warning);
}
.token-btn.high {
  --ring: var(--danger);
}
/* The surface, anchor and elevation come from `.overlay-popover`; only the size is ours. */
.popover {
  width: 260px;
  padding: var(--space-6);
  font-size: var(--fs-2);
}

/* See the note in `ModelSelector.vue`: a scoped width outranks the sheet's narrow rule. */
@media (max-width: 560px) {
  .popover {
    width: auto;
  }
}

.row {
  display: flex;
  justify-content: space-between;
  gap: var(--space-6);
  color: var(--text-3);
  padding: var(--space-1) 0;
}
.row .num {
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
.row.total {
  border-top: 1px solid var(--border);
  margin-top: var(--space-2);
  padding-top: var(--space-3);
  color: var(--text);
}
.row.total .num {
  color: var(--text);
}
.bar {
  height: 4px;
  border-radius: var(--radius-2xs);
  background: var(--border);
  overflow: hidden;
  margin: var(--space-4) 0 var(--space-2);
}
.fill {
  height: 100%;
  border-radius: var(--radius-2xs);
  transition: width var(--dur-base);
}
.fill.ok {
  background: var(--success);
}
.fill.warn {
  background: var(--warning);
}
.fill.high {
  background: var(--danger);
}
.bar-label {
  display: flex;
  justify-content: space-between;
  color: var(--text-3);
  font-size: var(--fs-1);
  margin-bottom: var(--space-3);
}
.approx {
  font-style: italic;
}
.note {
  margin-top: var(--space-4);
  padding-top: var(--space-4);
  border-top: 1px solid var(--border);
  color: var(--text-3);
  font-size: var(--fs-1);
  line-height: 1.5;
}
</style>
