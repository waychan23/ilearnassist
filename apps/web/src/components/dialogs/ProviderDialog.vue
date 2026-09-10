<script setup lang="ts">
import { computed, reactive, watch } from "vue";
import { DEFAULT_CONTEXT_WINDOW } from "../../api/types";
import type { ProviderConfig } from "../../api/types";
import type { ProviderDraft } from "../../stores/app";

const CAPABILITIES = [
  { id: "vision", label: "图片输入" },
  { id: "reasoning", label: "推理模型" },
  { id: "tool_use", label: "工具调用" },
] as const;

const props = defineProps<{ provider: ProviderConfig | null }>();
const emit = defineEmits<{ close: []; save: [draft: ProviderDraft] }>();

interface ModelRow {
  id?: string;
  modelId: string;
  name: string;
  contextWindow: string;
  maxOutput: string;
  capabilities: string[];
}

const draft = reactive<{
  name: string;
  baseURL: string;
  apiKey: string;
  models: ModelRow[];
}>({ name: "", baseURL: "", apiKey: "", models: [] });

watch(
  () => props.provider,
  (p) => {
    draft.name = p?.name ?? "";
    draft.baseURL = p?.baseURL ?? "";
    // Never prefilled — the key is write-only from the client's point of view.
    draft.apiKey = "";
    draft.models = (p?.models ?? []).map((m) => ({
      id: m.id,
      modelId: m.modelId,
      name: m.name,
      contextWindow: m.contextWindow == null ? "" : String(m.contextWindow),
      maxOutput: m.maxOutput == null ? "" : String(m.maxOutput),
      capabilities: [...m.capabilities],
    }));
    if (draft.models.length === 0) addModel();
  },
  { immediate: true }
);

/**
 * No shipping model has a context window anywhere near this. Catching it matters because
 * an inflated value silently makes the composer's context-usage indicator read ~0%.
 */
const IMPLAUSIBLE_CONTEXT = 10_000_000;

function contextLooksWrong(row: ModelRow): boolean {
  const n = Number(row.contextWindow.trim());
  return row.contextWindow.trim() !== "" && Number.isFinite(n) && n > IMPLAUSIBLE_CONTEXT;
}

function addModel() {
  draft.models.push({
    modelId: "",
    name: "",
    contextWindow: "",
    maxOutput: "",
    capabilities: ["tool_use"],
  });
}

function removeModel(index: number) {
  draft.models.splice(index, 1);
}

function toggleCapability(row: ModelRow, cap: string) {
  const i = row.capabilities.indexOf(cap);
  if (i === -1) row.capabilities.push(cap);
  else row.capabilities.splice(i, 1);
}

const keyPlaceholder = computed(() =>
  props.provider?.hasApiKey ? "已配置（留空则不修改）" : "尚未配置"
);

const canSave = computed(
  () => !!draft.name.trim() && !!draft.baseURL.trim() && draft.models.some((m) => m.modelId.trim())
);

const num = (v: string): number | null => {
  const t = v.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

function save() {
  if (!canSave.value) return;
  emit("save", {
    id: props.provider?.id,
    name: draft.name,
    baseURL: draft.baseURL,
    apiKey: draft.apiKey.trim(),
    models: draft.models
      .filter((m) => m.modelId.trim())
      .map((m) => ({
        id: m.id,
        modelId: m.modelId,
        name: m.name,
        contextWindow: num(m.contextWindow),
        maxOutput: num(m.maxOutput),
        capabilities: [...m.capabilities],
      })),
  });
}
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')">
    <div class="modal wide">
      <div class="modal-head">
        <h3>{{ props.provider ? "编辑 Provider" : "新建 Provider" }}</h3>
        <button class="icon-btn" @click="emit('close')">✕</button>
      </div>
      <div class="modal-body">
        <div class="grid-2">
          <div class="field">
            <label>名称</label>
            <input v-model="draft.name" class="input" placeholder="例如：DeepSeek" />
          </div>
          <div class="field">
            <label>Base URL</label>
            <input v-model="draft.baseURL" class="input" placeholder="https://api.deepseek.com/v1" />
          </div>
        </div>

        <div class="field">
          <label>API Key</label>
          <input
            v-model="draft.apiKey"
            class="input"
            type="password"
            autocomplete="new-password"
            :placeholder="keyPlaceholder"
          />
          <div class="hint">
            出于安全考虑，服务端不会返回 Key 的内容。留空表示保持原值不变。
          </div>
        </div>

        <div class="models-head">
          <label>模型</label>
          <button class="btn small" @click="addModel">＋ 添加模型</button>
        </div>
        <div class="models-hint">
          上下文长度与最大输出均以 <strong>token</strong> 为单位（如 128000）。上下文长度只用于估算上下文
          占用比例，留空则按 {{ DEFAULT_CONTEXT_WINDOW.toLocaleString() }} 估算。
        </div>

        <div v-for="(m, i) in draft.models" :key="i" class="model-row">
          <div class="model-main">
            <div class="field">
              <label>模型 ID</label>
              <input v-model="m.modelId" class="input" placeholder="gpt-4o-mini" />
            </div>
            <div class="field">
              <label>显示名称</label>
              <input v-model="m.name" class="input" placeholder="留空则同模型 ID" />
            </div>
            <div class="field narrow-field">
              <label>上下文长度</label>
              <input v-model="m.contextWindow" class="input" placeholder="128000" />
              <div class="hint" :class="{ warn: contextLooksWrong(m) }">
                {{ contextLooksWrong(m) ? "数值异常，单位是 token 不是字符" : "单位 token" }}
              </div>
            </div>
            <div class="field narrow-field">
              <label>最大输出</label>
              <input v-model="m.maxOutput" class="input" placeholder="可留空" />
              <div class="hint">单位 token</div>
            </div>
            <button class="icon-btn danger" title="移除模型" @click="removeModel(i)">✕</button>
          </div>
          <div class="caps">
            <label v-for="c in CAPABILITIES" :key="c.id">
              <input
                type="checkbox"
                :checked="m.capabilities.includes(c.id)"
                @change="toggleCapability(m, c.id)"
              />
              {{ c.label }}
            </label>
          </div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn" @click="emit('close')">取消</button>
        <button class="btn primary" :disabled="!canSave" @click="save">保存</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal.wide {
  width: 720px;
}
.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1.4fr;
  gap: 0 12px;
}
.models-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 4px 0 8px;
  color: var(--text-2);
  font-size: 13px;
}
.model-row {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px 12px 4px;
  margin-bottom: 10px;
  background: var(--panel-2);
}
.model-main {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.model-main .field {
  flex: 1;
  min-width: 0;
}
.model-main .narrow-field {
  flex: 0 0 124px;
}
.models-hint {
  font-size: 12px;
  color: var(--text-3);
  margin-bottom: 10px;
  line-height: 1.6;
}
.model-main .hint.warn {
  color: var(--warning);
}
.models-hint strong {
  color: var(--text-2);
}
.model-main .icon-btn {
  margin-top: 24px;
}
.caps {
  display: flex;
  gap: 16px;
  padding-bottom: 6px;
}
.caps label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-3);
  cursor: pointer;
}
</style>
