<script setup lang="ts">
import { computed, reactive, watch } from "vue";
import { useI18n } from "vue-i18n";
import { DEFAULT_CONTEXT_WINDOW } from "../../api/types";
import type { ProviderConfig } from "../../api/types";
import type { ProviderDraft } from "../../stores/app";

const CAPABILITIES = [
  { id: "vision" },
  { id: "reasoning" },
  { id: "tool_use" },
] as const;

const props = defineProps<{ provider: ProviderConfig | null }>();
const emit = defineEmits<{ close: []; save: [draft: ProviderDraft] }>();
const { t } = useI18n();

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
  props.provider?.hasApiKey ? t("providers.apiKeySet") : t("providers.apiKeyUnset")
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
    <div class="modal lg">
      <div class="modal-head">
        <h3>{{ props.provider ? t("providers.edit") : t("providers.create") }}</h3>
        <button class="icon-btn" @click="emit('close')">✕</button>
      </div>
      <div class="modal-body">
        <div class="form-grid">
          <div class="field">
            <label>{{ t("common.name") }}</label>
            <input v-model="draft.name" class="input" :placeholder="t('providers.namePlaceholder')" />
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
            {{ t("providers.apiKeyNote") }}
          </div>
        </div>

        <div class="models-head">
          <label>{{ t("providers.models") }}</label>
          <button class="btn small" @click="addModel">{{ t("providers.addModel") }}</button>
        </div>
        <div class="models-hint">
          {{ t("providers.modelNoteBefore") }}<strong>{{ t("providers.modelNoteToken") }}</strong
          >{{ t("providers.modelNoteAfter", { fallback: DEFAULT_CONTEXT_WINDOW.toLocaleString() }) }}
        </div>

        <div v-for="(m, i) in draft.models" :key="i" class="model-row">
          <div class="model-main">
            <div class="field">
              <label>{{ t("providers.modelId") }}</label>
              <input v-model="m.modelId" class="input" placeholder="gpt-4o-mini" />
            </div>
            <div class="field">
              <label>{{ t("providers.displayName") }}</label>
              <input v-model="m.name" class="input" :placeholder="t('providers.displayNamePlaceholder')" />
            </div>
            <div class="field narrow-field">
              <label>{{ t("providers.contextLength") }}</label>
              <input v-model="m.contextWindow" class="input" placeholder="128000" />
              <div class="hint" :class="{ warn: contextLooksWrong(m) }">
                {{ contextLooksWrong(m) ? t("providers.contextWrong") : t("providers.unitToken") }}
              </div>
            </div>
            <div class="field narrow-field">
              <label>{{ t("providers.maxOutput") }}</label>
              <input v-model="m.maxOutput" class="input" :placeholder="t('providers.optional')" />
              <div class="hint">{{ t("providers.unitToken") }}</div>
            </div>
            <button class="icon-btn danger" :title="t('providers.removeModel')" @click="removeModel(i)">✕</button>
          </div>
          <div class="caps">
            <label v-for="c in CAPABILITIES" :key="c.id">
              <input
                type="checkbox"
                :checked="m.capabilities.includes(c.id)"
                @change="toggleCapability(m, c.id)"
              />
              {{ t("providers.capabilities." + c.id) }}
            </label>
          </div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn" @click="emit('close')">{{ t("common.cancel") }}</button>
        <button class="btn primary" :disabled="!canSave" @click="save">{{ t("common.save") }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.models-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: var(--space-2) 0 var(--space-4);
  color: var(--text-2);
  font-size: var(--fs-3);
}
.model-row {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: var(--space-5) var(--space-6) var(--space-2);
  margin-bottom: var(--space-5);
  background: var(--panel-2);
}
.model-main {
  display: flex;
  align-items: flex-start;
  gap: var(--space-4);
}
.model-main .field {
  flex: 1;
  min-width: 0;
}
.model-main .narrow-field {
  flex: 0 0 124px;
}
.models-hint {
  font-size: var(--fs-2);
  color: var(--text-3);
  margin-bottom: var(--space-5);
  line-height: var(--lh-base);
}
.model-main .hint.warn {
  color: var(--warning);
}
.models-hint strong {
  color: var(--text-2);
}
.model-main .icon-btn {
  margin-top: var(--space-9);
}
.caps {
  display: flex;
  gap: var(--space-7);
  padding-bottom: var(--space-3);
}
.caps label {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  font-size: var(--fs-2);
  color: var(--text-3);
  cursor: pointer;
}
</style>
