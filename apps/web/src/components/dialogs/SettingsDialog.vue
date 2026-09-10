<script setup lang="ts">
import { computed, ref } from "vue";
import { useAppStore } from "../../stores/app";
import { confirm } from "../../composables/confirm";
import type { Copilot, ProviderConfig } from "../../api/types";
import type { CopilotDraft, ProviderDraft } from "../../stores/app";
import ProviderDialog from "./ProviderDialog.vue";
import CopilotDialog from "./CopilotDialog.vue";

const emit = defineEmits<{ close: [] }>();
const store = useAppStore();

const tab = ref<"providers" | "copilots" | "defaults">("providers");
const showEditor = ref(false);
const editing = ref<ProviderConfig | null>(null);

const providers = computed(() => store.config?.providers ?? []);
const defaultProvider = computed(() => store.config?.defaultProvider ?? "");
const defaultModel = computed(() => store.config?.defaultModel ?? "");

/** Models available under the currently-chosen default provider. */
const defaultModelOptions = computed(
  () => providers.value.find((p) => p.id === defaultProvider.value)?.models ?? []
);

const defaultProviderName = computed(
  () => providers.value.find((p) => p.id === defaultProvider.value)?.name ?? defaultProvider.value
);

function openNew() {
  editing.value = null;
  showEditor.value = true;
}

function openEdit(p: ProviderConfig) {
  editing.value = p;
  showEditor.value = true;
}

async function onSave(draft: ProviderDraft) {
  try {
    await store.saveProvider(draft);
    showEditor.value = false;
  } catch (e) {
    store.setError(e instanceof Error ? e.message : String(e));
  }
}

async function onDelete(p: ProviderConfig) {
  const ok = await confirm({
    title: "删除 Provider",
    message: `确定删除「${p.name}」吗？`,
    detail: `它的 ${p.models.length} 个模型配置会一并删除，使用它的会话将回退到默认 Provider。`,
    confirmText: "删除",
    danger: true,
  });
  if (!ok) return;
  try {
    await store.deleteProvider(p.id);
  } catch (e) {
    store.setError(e instanceof Error ? e.message : String(e));
  }
}

async function onDeleteModel(provider: ProviderConfig, modelId: string, name: string) {
  const ok = await confirm({
    title: "删除模型",
    message: `从「${provider.name}」中删除模型「${name}」？`,
    detail: "仍在引用它的会话会回退到该 Provider 下的第一个模型。",
    confirmText: "删除",
    danger: true,
  });
  if (!ok) return;
  try {
    await store.deleteModel(provider.id, modelId);
  } catch (e) {
    store.setError(e instanceof Error ? e.message : String(e));
  }
}

/* --------------------------------- Copilots --------------------------------- */

const showCopilotEditor = ref(false);
const editingCopilot = ref<Copilot | null>(null);

function openNewCopilot() {
  editingCopilot.value = null;
  showCopilotEditor.value = true;
}

function openEditCopilot(c: Copilot) {
  editingCopilot.value = c;
  showCopilotEditor.value = true;
}

async function onSaveCopilot(draft: CopilotDraft) {
  try {
    await store.saveCopilot(draft);
    showCopilotEditor.value = false;
  } catch (e) {
    store.setError(e instanceof Error ? e.message : String(e));
  }
}

async function onDeleteCopilot(c: Copilot) {
  const ok = await confirm({
    title: "删除 Copilot",
    message: `确定删除 Copilot「${c.name}」吗？`,
    detail: "使用它的会话不会被删除，但会失去这层设定。",
    confirmText: "删除",
    danger: true,
  });
  if (!ok) return;
  try {
    await store.deleteCopilot(c.id);
  } catch (e) {
    store.setError(e instanceof Error ? e.message : String(e));
  }
}

/** One-line digest of what a Copilot changes, shown under its name. */
function copilotSummary(c: Copilot) {
  const bits: string[] = [];
  if (c.settings.modelId) bits.push(c.settings.modelId);
  if (c.settings.temperature != null) bits.push(`temperature ${c.settings.temperature}`);
  if (c.settings.maxSteps != null) bits.push(`最多 ${c.settings.maxSteps} 轮工具`);
  if (c.settings.maxContextMessages != null) bits.push(`历史 ${c.settings.maxContextMessages} 条`);
  bits.push(c.tools.length ? `${c.tools.length} 个工具` : "全部工具");
  return bits.join(" · ");
}

function onDefaultProviderChange(e: Event) {
  const providerId = (e.target as HTMLSelectElement).value;
  const first = providers.value.find((p) => p.id === providerId)?.models[0]?.modelId;
  void store.setDefaults({ providerId, ...(first ? { modelId: first } : {}) });
}

function onDefaultModelChange(e: Event) {
  void store.setDefaults({ modelId: (e.target as HTMLSelectElement).value });
}
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')">
    <div class="modal wide">
      <div class="modal-head">
        <h3>设置</h3>
        <button class="icon-btn" @click="emit('close')">✕</button>
      </div>

      <div class="tabs">
        <button class="tab" :class="{ active: tab === 'providers' }" @click="tab = 'providers'">
          Providers / 模型
        </button>
        <button class="tab" :class="{ active: tab === 'copilots' }" @click="tab = 'copilots'">
          Copilots
          <span v-if="store.copilots.length" class="tab-count">{{ store.copilots.length }}</span>
        </button>
        <button class="tab" :class="{ active: tab === 'defaults' }" @click="tab = 'defaults'">
          默认与工具
        </button>
      </div>

      <div class="modal-body">
        <template v-if="tab === 'providers'">
          <div class="config-tip">
            Provider 与模型保存在数据库中，配置<strong>即时生效</strong>，无需重启服务。
            <code>config.yaml</code> 仅作为首次启动的初始数据。API Key 只写不读回。
          </div>

          <div class="list-head">
            <span>已配置 {{ providers.length }} 个 Provider</span>
            <button class="btn small" @click="openNew">＋ 新建 Provider</button>
          </div>

          <div v-for="p in providers" :key="p.id" class="provider-row">
            <div class="info">
              <div class="name">
                {{ p.name }}
                <span v-if="p.id === defaultProvider" class="badge">默认</span>
                <span class="key-state" :class="p.hasApiKey ? 'ok' : 'missing'">
                  {{ p.hasApiKey ? "✓ Key 已配置" : "✗ 未配置 Key" }}
                </span>
              </div>
              <div class="mono url">{{ p.baseURL }}</div>
              <div class="models">
                <span v-for="m in p.models" :key="m.id" class="model-chip">
                  {{ m.name }}
                  <span v-if="m.capabilities.includes('vision')" title="支持图片输入">🖼</span>
                  <span v-if="m.capabilities.includes('reasoning')" title="推理模型">🧠</span>
                  <button
                    class="chip-x"
                    title="删除该模型"
                    @click.stop="onDeleteModel(p, m.id, m.name)"
                  >
                    ×
                  </button>
                </span>
                <span v-if="p.models.length === 0" class="no-models">尚未配置模型</span>
              </div>
            </div>
            <div class="row-actions">
              <button class="btn small" @click="openEdit(p)">编辑</button>
              <button class="icon-btn danger" title="删除" @click="onDelete(p)">🗑</button>
            </div>
          </div>

          <div v-if="providers.length === 0" class="empty">
            还没有 Provider，点击「新建 Provider」添加一个 OpenAI 兼容的接口。
          </div>
        </template>

        <template v-else-if="tab === 'copilots'">
          <div class="config-tip">
            Copilot 定义一段系统设定（System Prompt）、可用工具与默认生成参数。新建会话时选择一个
            Copilot，它的设定会注入该对话，默认参数会被<strong>复制</strong>到会话中 —— 之后
            修改 Copilot 不会影响已开始的对话。
          </div>

          <div class="list-head">
            <span>已配置 {{ store.copilots.length }} 个 Copilot</span>
            <button class="btn small" @click="openNewCopilot">＋ 新建 Copilot</button>
          </div>

          <div v-for="c in store.copilots" :key="c.id" class="copilot-row">
            <div class="info">
              <div class="name">
                <span class="dot"></span>
                {{ c.name }}
                <span v-if="c.id === store.activeCopilotId" class="badge">当前会话使用中</span>
              </div>
              <div v-if="c.description" class="desc">{{ c.description }}</div>
              <div class="meta">{{ copilotSummary(c) }}</div>
            </div>
            <div class="row-actions">
              <button class="btn small" @click="openEditCopilot(c)">编辑</button>
              <button class="icon-btn danger" title="删除" @click="onDeleteCopilot(c)">🗑</button>
            </div>
          </div>

          <div v-if="store.copilots.length === 0" class="empty">
            还没有 Copilot，点击「新建 Copilot」创建一个。
          </div>
        </template>

        <template v-else>
          <div class="field">
            <label>默认 Provider</label>
            <select class="select" :value="defaultProvider" @change="onDefaultProviderChange">
              <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}</option>
            </select>
            <div class="hint">新建会话未指定 Provider 时使用。当前：{{ defaultProviderName }}</div>
          </div>

          <div class="field">
            <label>默认模型</label>
            <select class="select" :value="defaultModel" @change="onDefaultModelChange">
              <option v-for="m in defaultModelOptions" :key="m.id" :value="m.modelId">
                {{ m.name }}
              </option>
            </select>
            <div class="hint">新建会话未指定模型时使用。当前：{{ defaultModel || "未设置" }}</div>
          </div>

          <div class="field">
            <label>工作区根目录</label>
            <div class="value mono">{{ store.config?.workspacesRootDir }}</div>
          </div>

          <div class="field">
            <label>网页搜索 Provider</label>
            <div class="value">
              {{ store.config?.webSearchProvider }}
              <span class="hint inline">（在 config.yaml 的 tools.webSearch 中修改）</span>
            </div>
          </div>
        </template>
      </div>

      <div class="modal-foot">
        <button class="btn primary" @click="emit('close')">关闭</button>
      </div>
    </div>

    <ProviderDialog
      v-if="showEditor"
      :provider="editing"
      @close="showEditor = false"
      @save="onSave"
    />
    <CopilotDialog
      v-if="showCopilotEditor"
      :copilot="editingCopilot"
      @close="showCopilotEditor = false"
      @save="onSaveCopilot"
    />
  </div>
</template>

<style scoped>
.modal.wide {
  width: 720px;
}
.mono {
  font-family: "SFMono-Regular", Menlo, Consolas, monospace;
  font-size: 12px;
}
.tabs {
  display: flex;
  gap: 4px;
  padding: 10px 20px 0;
  border-bottom: 1px solid var(--border);
}
.tab {
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-3);
  padding: 8px 12px;
  cursor: pointer;
  font-size: 13px;
  font-family: inherit;
}
.tab:hover {
  color: var(--text-2);
}
.tab.active {
  color: var(--text);
  border-bottom-color: var(--accent);
}
.tab-count {
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 8px;
  background: var(--panel-2);
  color: var(--text-3);
  font-size: 11px;
}
.tab.active .tab-count {
  color: var(--text-2);
}
.list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--text-2);
  font-size: 13px;
  margin-bottom: 10px;
}
.provider-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px;
  margin-bottom: 8px;
  background: var(--panel-2);
}
.provider-row .info {
  flex: 1;
  min-width: 0;
}
.provider-row .name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 500;
}
.provider-row .badge {
  font-size: 11px;
  color: var(--accent);
  border: 1px solid var(--accent);
  border-radius: 10px;
  padding: 0 7px;
  font-weight: 400;
}
.key-state {
  font-size: 12px;
  font-weight: 400;
}
.key-state.ok {
  color: #4cc38a;
}
.key-state.missing {
  color: #e5534b;
}
.provider-row .url {
  color: var(--text-3);
  margin-top: 4px;
}
.provider-row .models {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.model-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 2px 6px 2px 9px;
  font-size: 12px;
  color: var(--text-2);
}
.chip-x {
  background: transparent;
  border: none;
  color: var(--text-3);
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  padding: 0 2px;
  font-family: inherit;
}
.chip-x:hover {
  color: var(--danger);
}
.no-models {
  color: var(--text-3);
  font-size: 12px;
}
.row-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}
.copilot-row {
  display: flex;
  align-items: center;
  gap: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px 12px;
  margin-bottom: 8px;
  background: var(--panel-2);
}
.copilot-row .info {
  flex: 1;
  min-width: 0;
}
.copilot-row .name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 500;
}
.copilot-row .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  flex-shrink: 0;
}
.copilot-row .badge {
  font-size: 11px;
  font-weight: 400;
  color: var(--accent);
  border: 1px solid var(--accent);
  border-radius: 10px;
  padding: 0 7px;
}
.copilot-row .desc {
  color: var(--text-2);
  font-size: 13px;
  margin-top: 2px;
}
.copilot-row .meta {
  color: var(--text-3);
  font-size: 12px;
  margin-top: 4px;
}
.empty {
  color: var(--text-3);
  font-size: 13px;
  padding: 12px 0;
}
.value {
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 8px 10px;
}
.hint.inline {
  margin-left: 6px;
}
</style>
