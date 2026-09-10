<script setup lang="ts">
import { reactive, watch } from "vue";
import type { Copilot } from "../../api/types";
import type { CopilotDraft } from "../../stores/app";

const ALL_TOOLS = [
  "web_search",
  "list_files",
  "read_file",
  "write_file",
  "create_directory",
  "delete_file",
] as const;

const props = defineProps<{ copilot: Copilot | null }>();
const emit = defineEmits<{ close: []; save: [draft: CopilotDraft] }>();

const draft = reactive<{
  name: string;
  description: string;
  systemPrompt: string;
  model: string;
  tools: string[];
}>({
  name: "",
  description: "",
  systemPrompt: "",
  model: "",
  tools: [],
});

watch(
  () => props.copilot,
  (c) => {
    draft.name = c?.name ?? "";
    draft.description = c?.description ?? "";
    draft.systemPrompt = c?.systemPrompt ?? "";
    draft.model = c?.model ?? "";
    draft.tools = c?.tools ?? [];
  },
  { immediate: true }
);

function toggleTool(name: string) {
  const i = draft.tools.indexOf(name);
  if (i === -1) draft.tools.push(name);
  else draft.tools.splice(i, 1);
}

function save() {
  if (!draft.name.trim()) return;
  emit("save", {
    id: props.copilot?.id,
    name: draft.name.trim(),
    description: draft.description.trim(),
    systemPrompt: draft.systemPrompt,
    model: draft.model.trim() || null,
    tools: [...draft.tools],
  });
}
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')">
    <div class="modal">
      <div class="modal-head">
        <h3>{{ props.copilot ? "编辑 Copilot" : "新建 Copilot" }}</h3>
        <button class="icon-btn" @click="emit('close')">✕</button>
      </div>
      <div class="modal-body">
        <div class="field">
          <label>名称</label>
          <input v-model="draft.name" class="input" placeholder="例如：代码助手" />
        </div>
        <div class="field">
          <label>描述</label>
          <input v-model="draft.description" class="input" placeholder="一句话说明它的用途" />
        </div>
        <div class="field">
          <label>System Prompt（设定）</label>
          <textarea
            v-model="draft.systemPrompt"
            class="textarea"
            placeholder="定义这个 Copilot 的角色、能力与行为约束…"
          ></textarea>
        </div>
        <div class="field">
          <label>模型（可选，留空则使用默认）</label>
          <input v-model="draft.model" class="input" placeholder="例如：deepseek-chat" />
        </div>
        <div class="field">
          <label>可用工具（留空 = 全部可用）</label>
          <div class="tool-checks">
            <label v-for="t in ALL_TOOLS" :key="t">
              <input type="checkbox" :checked="draft.tools.includes(t)" @change="toggleTool(t)" />
              {{ t }}
            </label>
          </div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn" @click="emit('close')">取消</button>
        <button class="btn primary" :disabled="!draft.name.trim()" @click="save">保存</button>
      </div>
    </div>
  </div>
</template>