<script setup lang="ts">
import { computed, reactive, watch } from "vue";
import { useAppStore } from "../../stores/app";
import type { Copilot } from "../../api/types";
import type { CopilotDraft } from "../../stores/app";

const ALL_TOOLS = [
  "web_search",
  "web_fetch",
  "list_files",
  "read_file",
  "write_file",
  "create_directory",
  "delete_file",
] as const;

const TOOL_LABELS: Record<string, string> = {
  web_search: "网页搜索",
  web_fetch: "读取网页",
  list_files: "列出文件",
  read_file: "读取文件",
  write_file: "写入文件",
  create_directory: "创建目录",
  delete_file: "删除文件",
};

const props = defineProps<{ copilot: Copilot | null }>();
const emit = defineEmits<{ close: []; save: [draft: CopilotDraft] }>();

const store = useAppStore();

/** `""` means "inherit"; every numeric field uses the same convention. */
interface Draft {
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  providerId: string;
  modelId: string;
  temperature: string;
  topP: string;
  maxTokens: string;
  maxContextMessages: string;
  maxSteps: string;
}

const draft = reactive<Draft>({
  name: "",
  description: "",
  systemPrompt: "",
  tools: [],
  providerId: "",
  modelId: "",
  temperature: "",
  topP: "",
  maxTokens: "",
  maxContextMessages: "",
  maxSteps: "",
});

const str = (v: number | null | undefined): string => (v == null ? "" : String(v));

watch(
  () => props.copilot,
  (c) => {
    draft.name = c?.name ?? "";
    draft.description = c?.description ?? "";
    draft.systemPrompt = c?.systemPrompt ?? "";
    draft.tools = [...(c?.tools ?? [])];
    draft.providerId = c?.settings.providerId ?? "";
    draft.modelId = c?.settings.modelId ?? "";
    draft.temperature = str(c?.settings.temperature);
    draft.topP = str(c?.settings.topP);
    draft.maxTokens = str(c?.settings.maxTokens);
    draft.maxContextMessages = str(c?.settings.maxContextMessages);
    draft.maxSteps = str(c?.settings.maxSteps);
  },
  { immediate: true }
);

const providers = computed(() => store.config?.providers ?? []);
/** Models are scoped to a provider, so the picker follows the chosen provider. */
const models = computed(
  () => providers.value.find((p) => p.id === draft.providerId)?.models ?? []
);

const showDefaults = computed(
  () =>
    !!draft.providerId ||
    !!draft.modelId ||
    !!draft.temperature ||
    !!draft.topP ||
    !!draft.maxTokens ||
    !!draft.maxContextMessages ||
    !!draft.maxSteps
);

watch(
  () => draft.providerId,
  (id, prev) => {
    // A model id only means something within its provider; clear it on a switch.
    if (prev !== undefined && id !== prev) draft.modelId = "";
  }
);

function toggleTool(name: string) {
  const i = draft.tools.indexOf(name);
  if (i === -1) draft.tools.push(name);
  else draft.tools.splice(i, 1);
}

const num = (v: string): number | null => {
  const t = v.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

function save() {
  if (!draft.name.trim()) return;
  emit("save", {
    id: props.copilot?.id,
    name: draft.name.trim(),
    description: draft.description.trim(),
    systemPrompt: draft.systemPrompt,
    tools: [...draft.tools],
    settings: {
      providerId: draft.providerId || null,
      modelId: draft.modelId || null,
      temperature: num(draft.temperature),
      topP: num(draft.topP),
      maxTokens: num(draft.maxTokens),
      maxContextMessages: num(draft.maxContextMessages),
      maxSteps: num(draft.maxSteps),
    },
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
          <div class="hint">留空则使用内置的通用助手设定。</div>
        </div>

        <div class="field">
          <label>可用工具（留空 = 全部可用）</label>
          <div class="tool-checks">
            <label v-for="t in ALL_TOOLS" :key="t">
              <input type="checkbox" :checked="draft.tools.includes(t)" @change="toggleTool(t)" />
              {{ TOOL_LABELS[t] ?? t }}
            </label>
          </div>
        </div>

        <details class="defaults" :open="showDefaults">
          <summary>默认参数（新建会话时复制到会话中，之后可在会话里单独调整）</summary>

          <div class="grid">
            <div class="field">
              <label>Provider</label>
              <select v-model="draft.providerId" class="select">
                <option value="">继承默认</option>
                <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}</option>
              </select>
            </div>
            <div class="field">
              <label>模型</label>
              <select v-model="draft.modelId" class="select" :disabled="!draft.providerId">
                <option value="">继承默认</option>
                <option v-for="m in models" :key="m.id" :value="m.modelId">{{ m.name }}</option>
              </select>
            </div>
            <div class="field">
              <label>Temperature</label>
              <input v-model="draft.temperature" class="input" placeholder="继承默认" />
              <div class="hint">0 ~ 2</div>
            </div>
            <div class="field">
              <label>Top P</label>
              <input v-model="draft.topP" class="input" placeholder="继承默认" />
              <div class="hint">0 ~ 1</div>
            </div>
            <div class="field">
              <label>最大输出</label>
              <input v-model="draft.maxTokens" class="input" placeholder="继承默认" />
              <div class="hint">单位 token</div>
            </div>
            <div class="field">
              <label>最多携带历史消息</label>
              <input v-model="draft.maxContextMessages" class="input" placeholder="全部" />
              <div class="hint">单位「条」</div>
            </div>
            <div class="field">
              <label>最大工具轮数</label>
              <input v-model="draft.maxSteps" class="input" placeholder="15" />
              <div class="hint">单位「轮」</div>
            </div>
          </div>
        </details>
      </div>
      <div class="modal-foot">
        <button class="btn" @click="emit('close')">取消</button>
        <button class="btn primary" :disabled="!draft.name.trim()" @click="save">保存</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.defaults {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px 12px;
  background: var(--panel-2);
}
.defaults summary {
  cursor: pointer;
  font-size: 13px;
  color: var(--text-2);
}
.defaults[open] summary {
  margin-bottom: 12px;
}
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 12px;
}
</style>
