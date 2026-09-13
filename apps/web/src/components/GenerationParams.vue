<script setup lang="ts">
import { computed, reactive } from "vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "../stores/app";
import type { SessionSettings } from "../api/types";

/**
 * The seven generation parameters, as a form — one definition, three surfaces.
 *
 * It was three copies waiting to happen: the Copilot editor's defaults, a conversation's own
 * parameters, and the advanced section of the new-session dialog all show this same set. The
 * third copy is where the drift would have started, because "all session parameters" would then
 * be three lists to keep in agreement and the one that was forgotten would be the one nobody
 * edited — silently missing the field a later change added.
 *
 * ### Why `commit()` rather than `v-model`
 *
 * The draft is held here as strings and parsed on `commit()`, which is what both original
 * dialogs already did, and the reason is a typing bug rather than a taste: emitting a parsed
 * number on every keystroke cannot represent a half-typed value — `Number("0.")` is `0`, so the
 * parent would write `0` back and the draft would reload as `"0"`, deleting the decimal point as
 * it was typed. Parsing once, when the form is done, is the shape that has no such state.
 *
 * So the parent calls `commit()` when *it* saves, which is also what lets the three surfaces
 * differ: two commit on their own Save button, and the new-session dialog commits when the
 * conversation is created.
 */
const emit = defineEmits<{ change: [] }>();
const { t } = useI18n();
const store = useAppStore();

/** `""` means "inherit" — the next level up, or the app default. */
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

/** Load a settings object into the draft. Also what a caller's "reset" is. */
function load(s: SessionSettings): void {
  draft.providerId = s.providerId ?? "";
  draft.modelId = s.modelId ?? "";
  draft.temperature = str(s.temperature);
  draft.topP = str(s.topP);
  draft.maxTokens = str(s.maxTokens);
  draft.maxContextMessages = str(s.maxContextMessages);
  draft.maxSteps = str(s.maxSteps);
}

load({});

const providers = computed(() => store.config?.providers ?? []);
const models = computed(() => providers.value.find((p) => p.id === draft.providerId)?.models ?? []);

function onProviderChange(): void {
  // A model id is only meaningful inside its own provider, so changing one clears the other
  // rather than leaving a pair the provider cannot serve.
  draft.modelId = "";
  emit("change");
}

const num = (v: string): number | null => {
  const trimmed = v.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
};

/** The draft as the wire shape. `null` is "inherit", which is what an empty field means. */
function commit(): SessionSettings {
  return {
    providerId: draft.providerId || null,
    modelId: draft.modelId || null,
    temperature: num(draft.temperature),
    topP: num(draft.topP),
    maxTokens: num(draft.maxTokens),
    maxContextMessages: num(draft.maxContextMessages),
    maxSteps: num(draft.maxSteps),
  };
}

/** Whether anything has been chosen at all — a caller may want to send nothing instead of `{}`. */
const isDirty = computed(() =>
  Object.values(commit()).some((v) => v != null)
);

defineExpose({ commit, load, isDirty });
</script>

<template>
  <div class="form-grid">
    <div class="field">
      <label>{{ t("params.provider") }}</label>
      <select
        v-model="draft.providerId"
        class="select"
        data-testid="param-provider"
        @change="onProviderChange"
      >
        <option value="">{{ t("params.inherit") }}</option>
        <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}</option>
      </select>
    </div>
    <div class="field">
      <label>{{ t("params.model") }}</label>
      <select
        v-model="draft.modelId"
        class="select"
        data-testid="param-model"
        :disabled="!draft.providerId"
      >
        <option value="">{{ t("params.inherit") }}</option>
        <option v-for="m in models" :key="m.id" :value="m.modelId">{{ m.name }}</option>
      </select>
    </div>
    <div class="field">
      <label>{{ t("params.temperature") }}</label>
      <input
        v-model="draft.temperature"
        class="input"
        data-testid="param-temperature"
        :placeholder="t('params.inherit')"
      />
      <div class="hint">{{ t("params.temperatureHint") }}</div>
    </div>
    <div class="field">
      <label>{{ t("params.topP") }}</label>
      <input
        v-model="draft.topP"
        class="input"
        data-testid="param-top-p"
        :placeholder="t('params.inherit')"
      />
      <div class="hint">{{ t("params.topPHint") }}</div>
    </div>
    <div class="field">
      <label>{{ t("params.maxOutput") }}</label>
      <input
        v-model="draft.maxTokens"
        class="input"
        data-testid="param-max-tokens"
        :placeholder="t('params.inherit')"
      />
      <div class="hint">{{ t("params.maxOutputHint") }}</div>
    </div>
    <div class="field">
      <label>{{ t("params.maxHistory") }}</label>
      <input
        v-model="draft.maxContextMessages"
        class="input"
        data-testid="param-max-history"
        :placeholder="t('params.maxHistoryAll')"
      />
      <div class="hint">{{ t("params.maxHistoryHint") }}</div>
    </div>
    <div class="field">
      <label>{{ t("params.maxSteps") }}</label>
      <input v-model="draft.maxSteps" class="input" data-testid="param-max-steps" placeholder="15" />
      <div class="hint">{{ t("params.maxStepsHint") }}</div>
    </div>
  </div>
</template>
