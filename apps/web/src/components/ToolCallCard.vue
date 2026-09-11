<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { ToolCall } from "../api/types";

const props = defineProps<{ toolCall: ToolCall }>();
const open = ref(false);
const { t, te } = useI18n();

/**
 * Labels come from the shared tools.name.* namespace, so this and the Copilot dialog's tool
 * list resolve the same key. Uses te() rather than a fallback operator: t() on a missing
 * key returns the key path itself, which would render as an internal identifier.
 */
const label = computed(() => {
  const key = "tools.name." + props.toolCall.name;
  return te(key) ? t(key) : props.toolCall.name;
});
const done = computed(() => props.toolCall.output !== undefined);

const arg = computed(() => {
  try {
    const obj = JSON.parse(props.toolCall.input) as Record<string, unknown>;
    for (const key of ["query", "url", "path", "content", "directory"]) {
      if (obj[key] !== undefined) {
        const s = String(obj[key]);
        return s.length > 80 ? s.slice(0, 80) + "…" : s;
      }
    }
    return "";
  } catch {
    return "";
  }
});

const prettyInput = computed(() => {
  try {
    return JSON.stringify(JSON.parse(props.toolCall.input), null, 2);
  } catch {
    return props.toolCall.input;
  }
});
</script>

<template>
  <div class="tool-card" data-testid="tool-call">
    <div class="tool-head" @click="open = !open">
      <span class="icon" :class="done ? 'ok' : 'run'">{{ done ? "✓" : "↻" }}</span>
      <span class="name">{{ label }}</span>
      <span class="arg">{{ arg }}</span>
      <span class="status">{{ done ? t("tools.done") : t("tools.running") }}</span>
      <span class="toggle">{{ open ? "▾" : "▸" }}</span>
    </div>
    <div v-if="open" class="tool-body">
      <div>
        <div class="key">{{ t("tools.args") }}</div>
        <pre>{{ prettyInput }}</pre>
      </div>
      <div v-if="done">
        <div class="key">{{ t("tools.result") }}</div>
        <pre>{{ props.toolCall.output }}</pre>
      </div>
    </div>
  </div>
</template>

<style scoped>
.name {
  color: var(--text);
  font-weight: 500;
  white-space: nowrap;
}
.arg {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-3);
}
.status {
  font-size: 12px;
  white-space: nowrap;
}
.icon.run {
  color: var(--accent);
  animation: spin 1s linear infinite;
  display: inline-block;
}
.icon.ok {
  color: #4cc38a;
}
.toggle {
  color: var(--text-3);
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>