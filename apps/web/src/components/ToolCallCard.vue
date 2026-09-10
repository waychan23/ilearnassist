<script setup lang="ts">
import { computed, ref } from "vue";
import type { ToolCall } from "../api/types";

const props = defineProps<{ toolCall: ToolCall }>();
const open = ref(false);

const LABELS: Record<string, string> = {
  web_search: "网页搜索",
  web_fetch: "读取网页",
  list_files: "列出文件",
  read_file: "读取文件",
  write_file: "写入文件",
  create_directory: "创建目录",
  delete_file: "删除文件",
};

const label = computed(() => LABELS[props.toolCall.name] ?? props.toolCall.name);
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
  <div class="tool-card">
    <div class="tool-head" @click="open = !open">
      <span class="icon" :class="done ? 'ok' : 'run'">{{ done ? "✓" : "↻" }}</span>
      <span class="name">{{ label }}</span>
      <span class="arg">{{ arg }}</span>
      <span class="status">{{ done ? "完成" : "运行中" }}</span>
      <span class="toggle">{{ open ? "▾" : "▸" }}</span>
    </div>
    <div v-if="open" class="tool-body">
      <div>
        <div class="key">参数</div>
        <pre>{{ prettyInput }}</pre>
      </div>
      <div v-if="done">
        <div class="key">结果</div>
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