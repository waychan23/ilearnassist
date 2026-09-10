<script setup lang="ts">
import { computed, reactive, watch } from "vue";
import { useAppStore } from "../../stores/app";
import type { SessionSettings } from "../../api/types";

const emit = defineEmits<{ close: [] }>();
const store = useAppStore();

/** `""` means "inherit" (from the Copilot's defaults, then the app default). */
interface Draft {
  providerId: string;
  modelId: string;
  temperature: string;
  topP: string;
  maxTokens: string;
  maxContextMessages: string;
  maxSteps: string;
}

const draft = reactive<Draft>({
  providerId: "",
  modelId: "",
  temperature: "",
  topP: "",
  maxTokens: "",
  maxContextMessages: "",
  maxSteps: "",
});

const str = (v: number | null | undefined): string => (v == null ? "" : String(v));

function load(s: SessionSettings) {
  draft.providerId = s.providerId ?? "";
  draft.modelId = s.modelId ?? "";
  draft.temperature = str(s.temperature);
  draft.topP = str(s.topP);
  draft.maxTokens = str(s.maxTokens);
  draft.maxContextMessages = str(s.maxContextMessages);
  draft.maxSteps = str(s.maxSteps);
}

// `sessionSettings` already falls back to the staged draft settings, so this works
// both for a live session and for the welcome screen.
watch(() => store.sessionSettings, load, { immediate: true, deep: true });

const providers = computed(() => store.config?.providers ?? []);
const models = computed(
  () => providers.value.find((p) => p.id === draft.providerId)?.models ?? []
);

watch(
  () => draft.providerId,
  (id, prev) => {
    if (prev !== undefined && id !== prev) draft.modelId = "";
  }
);

const num = (v: string): number | null => {
  const t = v.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

function save() {
  void store.updateSettings({
    providerId: draft.providerId || null,
    modelId: draft.modelId || null,
    temperature: num(draft.temperature),
    topP: num(draft.topP),
    maxTokens: num(draft.maxTokens),
    maxContextMessages: num(draft.maxContextMessages),
    maxSteps: num(draft.maxSteps),
  });
  emit("close");
}

function reset() {
  load({});
}

const scopeNote = computed(() =>
  store.activeSession
    ? "这些参数只作用于当前会话。"
    : "还没有会话，参数会应用于即将创建的新会话。"
);
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')">
    <div class="modal">
      <div class="modal-head">
        <h3>会话参数</h3>
        <button class="icon-btn" @click="emit('close')">✕</button>
      </div>
      <div class="modal-body">
        <div class="config-tip">
          {{ scopeNote }} 留空表示继承 Copilot 的默认值，再退回到全局默认。
        </div>

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
            <div class="hint">取值范围 0 ~ 2，数值越大回答越随机。</div>
          </div>
          <div class="field">
            <label>Top P</label>
            <input v-model="draft.topP" class="input" placeholder="继承默认" />
            <div class="hint">取值范围 0 ~ 1，通常与 Temperature 二选一调节。</div>
          </div>
          <div class="field">
            <label>最大输出</label>
            <input v-model="draft.maxTokens" class="input" placeholder="继承默认" />
            <div class="hint">单位 token，限制单次回复的最大长度。</div>
          </div>
          <div class="field">
            <label>最多携带历史消息</label>
            <input v-model="draft.maxContextMessages" class="input" placeholder="全部（不截断）" />
            <div class="hint">单位「条」，超出时从最早的消息开始丢弃。</div>
          </div>
          <div class="field">
            <label>最大工具轮数</label>
            <input v-model="draft.maxSteps" class="input" placeholder="15" />
            <div class="hint">单位「轮」，单轮回复中最多执行多少次「模型 → 工具」循环。</div>
          </div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn" @click="reset">重置</button>
        <button class="btn" @click="emit('close')">取消</button>
        <button class="btn primary" @click="save">保存</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 14px;
}
</style>
