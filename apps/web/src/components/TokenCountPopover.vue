<script setup lang="ts">
import { computed, ref } from "vue";
import { useAppStore } from "../stores/app";
import { estimateTokens, formatTokens } from "../utils/format";
import { DEFAULT_CONTEXT_WINDOW } from "../api/types";

const props = defineProps<{ pendingText: string }>();

const store = useAppStore();
const open = ref(false);

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
  <div class="token-wrap" @mouseenter="open = true" @mouseleave="open = false">
    <button class="token-btn" :class="level" @click="open = !open">
      <span class="ring" :style="{ '--pct': `${ratio * 100}%` }"></span>
      {{ label }}
    </button>

    <div v-if="open" class="popover">
      <div class="row">
        <span>已用上下文</span>
        <span class="num">{{ formatTokens(used) }}</span>
      </div>
      <div class="row">
        <span>待发送输入（估算）</span>
        <span class="num">{{ pending ? `+${formatTokens(pending)}` : "—" }}</span>
      </div>
      <div class="row total">
        <span>预计占用</span>
        <span class="num">{{ formatTokens(projected) }}</span>
      </div>

      <div class="bar">
        <div class="fill" :class="level" :style="{ width: `${ratio * 100}%` }"></div>
      </div>
      <div class="bar-label">
        <span>{{ (ratio * 100).toFixed(1) }}% of {{ formatTokens(limit) }}</span>
        <span v-if="usingFallbackLimit" class="approx" title="模型未配置上下文长度，使用默认估算值">
          估算上限
        </span>
      </div>

      <div class="row">
        <span>上下文消息</span>
        <span class="num">
          {{ messageCount }}<template v-if="messageLimit"> / {{ messageLimit }}</template>
        </span>
      </div>
      <div class="row">
        <span>最大工具轮数</span>
        <span class="num">{{ store.sessionSettings.maxSteps ?? 15 }}</span>
      </div>

      <div class="note">
        「已用上下文」来自上一轮的 token 统计；「待发送输入」按字符数估算，仅供预览。
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
  display: flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 14px;
  color: var(--text-3);
  font-size: 11px;
  font-family: inherit;
  padding: 4px 10px;
  cursor: pointer;
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
  background: conic-gradient(var(--ring, #4cc38a) var(--pct), var(--border) 0);
}
.token-btn.ok {
  --ring: #4cc38a;
}
.token-btn.warn {
  --ring: #e6b33c;
}
.token-btn.high {
  --ring: var(--danger);
}
.popover {
  position: absolute;
  bottom: calc(100% + 8px);
  right: 0;
  width: 260px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
  z-index: 60;
  font-size: 12px;
}
.row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  color: var(--text-3);
  padding: 2px 0;
}
.row .num {
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
.row.total {
  border-top: 1px solid var(--border);
  margin-top: 4px;
  padding-top: 6px;
  color: var(--text);
}
.row.total .num {
  color: var(--text);
}
.bar {
  height: 4px;
  border-radius: 2px;
  background: var(--border);
  overflow: hidden;
  margin: 8px 0 4px;
}
.fill {
  height: 100%;
  border-radius: 2px;
  transition: width 0.2s;
}
.fill.ok {
  background: #4cc38a;
}
.fill.warn {
  background: #e6b33c;
}
.fill.high {
  background: var(--danger);
}
.bar-label {
  display: flex;
  justify-content: space-between;
  color: var(--text-3);
  font-size: 11px;
  margin-bottom: 6px;
}
.approx {
  font-style: italic;
}
.note {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
  color: var(--text-3);
  font-size: 11px;
  line-height: 1.5;
}
</style>
