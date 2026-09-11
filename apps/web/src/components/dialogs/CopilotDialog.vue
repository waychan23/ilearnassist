<script setup lang="ts">
import { computed, reactive, watch } from "vue";
import { useI18n } from "vue-i18n";
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

const props = defineProps<{ copilot: Copilot | null }>();
const emit = defineEmits<{ close: []; save: [draft: CopilotDraft] }>();

const store = useAppStore();
const { t, te } = useI18n();

/** The tool list shares the tools.name.* namespace with the tool-call card. */
const toolLabel = (name: string): string => {
  const key = "tools.name." + name;
  return te(key) ? t(key) : name;
};

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
  <!--
    Teleported to `body`, and this is load-bearing rather than tidiness. On a compact
    viewport the sidebar is `position: fixed` inside a `transform`, and a fixed-position
    element whose ancestor is transformed is positioned against *that ancestor* — so a
    `.modal-overlay` left in place here would be laid out inside the off-canvas drawer and
    render off-screen. The palette still applies: the theme lives on `<html>` and custom
    properties cascade from there.
  -->
  <Teleport to="body">
    <div class="modal-overlay" @click.self="emit('close')">
      <div class="modal">
        <div class="modal-head">
          <h3>{{ props.copilot ? t("copilot.edit") : t("copilot.create") }}</h3>
          <button
          class="icon-btn"
          :title="t('common.close')"
          :aria-label="t('common.close')"
          @click="emit('close')"
        >✕</button>
        </div>
        <div class="modal-body">
          <div class="field">
            <label>{{ t("common.name") }}</label>
            <input v-model="draft.name" class="input" :placeholder="t('copilot.namePlaceholder')" />
          </div>
          <div class="field">
            <label>{{ t("copilot.description") }}</label>
            <input v-model="draft.description" class="input" :placeholder="t('copilot.descriptionPlaceholder')" />
          </div>
          <div class="field">
            <label>{{ t("copilot.systemPrompt") }}</label>
            <textarea
              v-model="draft.systemPrompt"
              class="textarea"
              :placeholder="t('copilot.systemPromptPlaceholder')"
            ></textarea>
            <div class="hint">{{ t("copilot.systemPromptHint") }}</div>
          </div>

          <div class="field">
            <label>{{ t("copilot.tools") }}</label>
            <div class="form-grid tool-checks">
              <label v-for="t in ALL_TOOLS" :key="t" class="check-row">
                <input type="checkbox" :checked="draft.tools.includes(t)" @change="toggleTool(t)" />
                {{ toolLabel(t) }}
              </label>
            </div>
          </div>

          <details class="defaults" :open="showDefaults">
            <summary>{{ t("copilot.defaults") }}</summary>

            <div class="form-grid">
              <div class="field">
                <label>Provider</label>
                <select v-model="draft.providerId" class="select">
                  <option value="">{{ t("copilot.inherit") }}</option>
                  <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}</option>
                </select>
              </div>
              <div class="field">
                <label>{{ t("copilot.model") }}</label>
                <select v-model="draft.modelId" class="select" :disabled="!draft.providerId">
                  <option value="">{{ t("copilot.inherit") }}</option>
                  <option v-for="m in models" :key="m.id" :value="m.modelId">{{ m.name }}</option>
                </select>
              </div>
              <div class="field">
                <label>Temperature</label>
                <input v-model="draft.temperature" class="input" :placeholder="t('copilot.inherit')" />
                <div class="hint">0 ~ 2</div>
              </div>
              <div class="field">
                <label>Top P</label>
                <input v-model="draft.topP" class="input" :placeholder="t('copilot.inherit')" />
                <div class="hint">0 ~ 1</div>
              </div>
              <div class="field">
                <label>{{ t("copilot.maxOutput") }}</label>
                <input v-model="draft.maxTokens" class="input" :placeholder="t('copilot.inherit')" />
                <div class="hint">{{ t("copilot.unitToken") }}</div>
              </div>
              <div class="field">
                <label>{{ t("copilot.maxHistory") }}</label>
                <input v-model="draft.maxContextMessages" class="input" :placeholder="t('copilot.all')" />
                <div class="hint">{{ t("copilot.unitMessages") }}</div>
              </div>
              <div class="field">
                <label>{{ t("copilot.maxSteps") }}</label>
                <input v-model="draft.maxSteps" class="input" placeholder="15" />
                <div class="hint">{{ t("copilot.unitSteps") }}</div>
              </div>
            </div>
          </details>
        </div>
        <div class="modal-foot">
          <button class="btn" @click="emit('close')">{{ t("common.cancel") }}</button>
          <button class="btn primary" :disabled="!draft.name.trim()" @click="save">{{ t("common.save") }}</button>
        </div>
      </div>
    </div>

  </Teleport>
</template>

<style scoped>
.defaults {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: var(--space-5) var(--space-6);
  background: var(--panel-2);
}
.defaults summary {
  cursor: pointer;
  font-size: var(--fs-3);
  color: var(--text-2);
}
.defaults[open] summary {
  margin-bottom: var(--space-6);
}
</style>
