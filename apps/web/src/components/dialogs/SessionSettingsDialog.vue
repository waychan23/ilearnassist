<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "../../stores/app";
import type { SessionSettings } from "../../api/types";
import Icon from "../Icon.vue";

const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();
const store = useAppStore();

/**
 * The conversation's own persona.
 *
 * Its own control rather than one more generation parameter, because it is a different kind of
 * thing: this is what the conversation *is*, and it is the affordance that replaced switching
 * Copilot mid-thread. Editing it leaves the Copilot it was copied from untouched.
 */
const prompt = ref("");
watch(
  () => store.activeSession?.systemPrompt ?? "",
  (v) => {
    prompt.value = v;
  },
  { immediate: true }
);

/** `""` means "inherit" — the app default, now that no Copilot tier sits in between. */
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
  if (store.activeSession) void store.updateSessionPrompt(prompt.value);
  emit("close");
}

function reset() {
  load({});
  // Empty means the built-in assistant prompt, which is the same "inherit" the fields above
  // express — there is nothing above the conversation left to inherit a persona from.
  prompt.value = "";
}

const scopeNote = computed(() =>
  store.activeSession
    ? t("sessionSettings.scopeExisting")
    : t("sessionSettings.scopeNew")
);
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
          <h3>{{ t("sessionSettings.title") }}</h3>
          <button
            class="icon-btn"
            :title="t('common.close')"
            :aria-label="t('common.close')"
            @click="emit('close')"
          >
            <Icon name="close" />
          </button>
        </div>
        <div class="modal-body">
          <div class="config-tip">
            {{ scopeNote }}{{ t("sessionSettings.scopeSuffix") }}
          </div>

          <!-- Only for a conversation that exists: there is nothing to hold a prompt before
               one does, and the Copilot picked at creation supplies it until then. -->
          <div v-if="store.activeSession" class="field">
            <label>{{ t("sessionSettings.systemPrompt") }}</label>
            <textarea
              v-model="prompt"
              class="textarea"
              data-testid="session-prompt"
              :placeholder="t('sessionSettings.systemPromptPlaceholder')"
            ></textarea>
            <div class="hint">{{ t("sessionSettings.systemPromptHint") }}</div>
          </div>

          <div class="form-grid">
            <div class="field">
              <label>Provider</label>
              <select v-model="draft.providerId" class="select">
                <option value="">{{ t("sessionSettings.inherit") }}</option>
                <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}</option>
              </select>
            </div>
            <div class="field">
              <label>{{ t("sessionSettings.model") }}</label>
              <select v-model="draft.modelId" class="select" :disabled="!draft.providerId">
                <option value="">{{ t("sessionSettings.inherit") }}</option>
                <option v-for="m in models" :key="m.id" :value="m.modelId">{{ m.name }}</option>
              </select>
            </div>
            <div class="field">
              <label>Temperature</label>
              <input v-model="draft.temperature" class="input" :placeholder="t('sessionSettings.inherit')" />
              <div class="hint">{{ t("sessionSettings.temperatureHint") }}</div>
            </div>
            <div class="field">
              <label>Top P</label>
              <input v-model="draft.topP" class="input" :placeholder="t('sessionSettings.inherit')" />
              <div class="hint">{{ t("sessionSettings.topPHint") }}</div>
            </div>
            <div class="field">
              <label>{{ t("sessionSettings.maxOutput") }}</label>
              <input v-model="draft.maxTokens" class="input" :placeholder="t('sessionSettings.inherit')" />
              <div class="hint">{{ t("sessionSettings.maxOutputHint") }}</div>
            </div>
            <div class="field">
              <label>{{ t("sessionSettings.maxHistory") }}</label>
              <input v-model="draft.maxContextMessages" class="input" :placeholder="t('sessionSettings.maxHistoryAll')" />
              <div class="hint">{{ t("sessionSettings.maxHistoryHint") }}</div>
            </div>
            <div class="field">
              <label>{{ t("sessionSettings.maxSteps") }}</label>
              <input v-model="draft.maxSteps" class="input" placeholder="15" />
              <div class="hint">{{ t("sessionSettings.maxStepsHint") }}</div>
            </div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn" @click="reset">{{ t("sessionSettings.reset") }}</button>
          <button class="btn" @click="emit('close')">{{ t("common.cancel") }}</button>
          <button class="btn primary" @click="save">{{ t("common.save") }}</button>
        </div>
      </div>
    </div>

  </Teleport>
</template>
