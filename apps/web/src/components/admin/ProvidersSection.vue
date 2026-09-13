<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "../../stores/app";
import { confirm } from "../../composables/confirm";
import type { ProviderConfig } from "../../api/types";
import type { ProviderDraft } from "../../stores/app";
import ProviderDialog from "../dialogs/ProviderDialog.vue";
import Icon from "../Icon.vue";

/**
 * The installation's model providers, and which of them is the default.
 *
 * A section of the platform console rather than a tab of Settings, and that is the permission
 * model rather than a move for tidiness: a provider's `baseURL` is where every conversation's
 * prompts and completions go, so an account that can add one — and point the defaults at it —
 * reads everybody's traffic. An administrator configures the models; an ordinary account
 * chooses among them, from the picker in the composer.
 *
 * The defaults live here with the list rather than in a section of their own because they are
 * the same question asked twice: which providers exist, and which one a new conversation starts
 * on. Splitting them would mean a screen that lists models and a different screen that names
 * one of them.
 */

const store = useAppStore();
const { t } = useI18n();

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

function openNew(): void {
  editing.value = null;
  showEditor.value = true;
}

function openEdit(p: ProviderConfig): void {
  editing.value = p;
  showEditor.value = true;
}

async function onSave(draft: ProviderDraft): Promise<void> {
  try {
    await store.saveProvider(draft);
    showEditor.value = false;
  } catch (e) {
    store.setError(e instanceof Error ? e.message : String(e));
  }
}

async function onDelete(p: ProviderConfig): Promise<void> {
  const ok = await confirm({
    title: t("settings.deleteProvider.title"),
    message: t("settings.deleteProvider.message", { name: p.name }),
    detail: t("settings.deleteProvider.detail", { count: p.models.length }, p.models.length),
    confirmText: t("common.delete"),
    danger: true,
  });
  if (!ok) return;
  try {
    await store.deleteProvider(p.id);
  } catch (e) {
    store.setError(e instanceof Error ? e.message : String(e));
  }
}

async function onDeleteModel(provider: ProviderConfig, modelId: string, name: string): Promise<void> {
  const ok = await confirm({
    title: t("settings.deleteModel.title"),
    message: t("settings.deleteModel.message", { provider: provider.name, model: name }),
    detail: t("settings.deleteModel.detail"),
    confirmText: t("common.delete"),
    danger: true,
  });
  if (!ok) return;
  try {
    await store.deleteModel(provider.id, modelId);
  } catch (e) {
    store.setError(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Changing the default provider moves the default model with it.
 *
 * A model belongs to exactly one provider, so keeping the old default here would leave a pair
 * that names a model the chosen provider does not have — and the composer resolves the model
 * through the provider. The first model of the new provider is the only sensible starting
 * point, and it is what the operator would pick by hand a moment later.
 */
function onDefaultProviderChange(e: Event): void {
  const providerId = (e.target as HTMLSelectElement).value;
  const first = providers.value.find((p) => p.id === providerId)?.models[0]?.modelId;
  void store.setDefaults({ providerId, ...(first ? { modelId: first } : {}) });
}

function onDefaultModelChange(e: Event): void {
  void store.setDefaults({ modelId: (e.target as HTMLSelectElement).value });
}
</script>

<template>
  <div>
    <div class="config-tip">
      {{ t("settings.providers.noteBefore") }}<strong>{{ t("settings.providers.noteLive") }}</strong
      >{{ t("settings.providers.noteBetween") }}<code>{{ t("settings.providers.noteConfigFile") }}</code
      >{{ t("settings.providers.noteAfter") }}
    </div>

    <div class="list-head">
      <span>{{
        t("settings.providers.countConfigured", { count: providers.length }, providers.length)
      }}</span>
      <button class="btn small" data-testid="admin-add-provider" @click="openNew">
        <Icon name="plus" /> {{ t("settings.providers.add") }}
      </button>
    </div>

    <div v-for="p in providers" :key="p.id" class="list-row provider-row" data-testid="admin-provider-row">
      <div class="info">
        <div class="name">
          {{ p.name }}
          <span v-if="p.id === defaultProvider" class="badge">{{ t("settings.providers.default") }}</span>
          <span class="key-state" :class="p.hasApiKey ? 'ok' : 'missing'">
            <Icon :name="p.hasApiKey ? 'check' : 'cross'" />
            {{ p.hasApiKey ? t("settings.providers.keySet") : t("settings.providers.keyMissing") }}
          </span>
        </div>
        <div class="mono url">{{ p.baseURL }}</div>
        <div class="models">
          <span v-for="m in p.models" :key="m.id" class="model-chip">
            {{ m.name }}
            <span v-if="m.capabilities.includes('vision')" :title="t('settings.providers.visionHint')"><Icon name="image" /></span>
            <span v-if="m.capabilities.includes('reasoning')" :title="t('settings.providers.reasoningHint')"><Icon name="bulb" /></span>
            <button
              class="chip-x"
              :title="t('settings.providers.deleteModel')"
              :aria-label="t('settings.providers.deleteModel')"
              @click.stop="onDeleteModel(p, m.id, m.name)"
            >
              <Icon name="close" />
            </button>
          </span>
          <span v-if="p.models.length === 0" class="no-models">{{ t("settings.providers.noModels") }}</span>
        </div>
      </div>
      <div class="row-actions">
        <button class="btn small" @click="openEdit(p)">{{ t("common.edit") }}</button>
        <button class="icon-btn danger" :title="t('common.delete')" @click="onDelete(p)"><Icon name="trash" /></button>
      </div>
    </div>

    <div v-if="providers.length === 0" class="empty">
      {{ t("settings.providers.empty") }}
    </div>

    <!--
      The app defaults, which are the other half of the same question: the list above is which
      models exist, this is which one a new conversation starts on. Every account reads both —
      the composer resolves a turn through them — and only an administrator may set them.
    -->
    <h3 class="section-head">{{ t("settings.defaults.appSection") }}</h3>

    <div class="field">
      <label>{{ t("settings.defaults.provider") }}</label>
      <select
        class="select"
        :value="defaultProvider"
        data-testid="admin-default-provider"
        @change="onDefaultProviderChange"
      >
        <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}</option>
      </select>
      <div class="hint">{{ t("settings.defaults.providerHint", { name: defaultProviderName }) }}</div>
    </div>

    <div class="field">
      <label>{{ t("settings.defaults.model") }}</label>
      <select
        class="select"
        :value="defaultModel"
        data-testid="admin-default-model"
        @change="onDefaultModelChange"
      >
        <option v-for="m in defaultModelOptions" :key="m.id" :value="m.modelId">
          {{ m.name }}
        </option>
      </select>
      <div class="hint">{{
        t("settings.defaults.modelHint", { name: defaultModel || t("settings.defaults.modelUnset") })
      }}</div>
    </div>

    <!-- Read-only, and stated because they are the two things an operator is most often asked
         about and neither has a control anywhere: where the files go, and who answers a search. -->
    <div class="field">
      <label>{{ t("settings.defaults.workspaceRoot") }}</label>
      <div class="value mono">{{ store.config?.workspacesRootDir }}</div>
    </div>

    <div class="field">
      <label>{{ t("settings.defaults.webSearch") }}</label>
      <div class="value">
        {{ store.config?.webSearchProvider }}
        <span class="hint inline">{{ t("settings.defaults.webSearchHint") }}</span>
      </div>
    </div>

    <ProviderDialog v-if="showEditor" :provider="editing" @close="showEditor = false" @save="onSave" />
  </div>
</template>

<style scoped>
/*
 * The list styles moved here with the markup they belong to. They used to be scoped to
 * `SettingsDialog`, which is why the console would otherwise render an unstyled list — and
 * `style.test.ts` insists spacing comes from tokens rather than literals.
 */
.list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--text-2);
  font-size: var(--fs-3);
  margin-bottom: var(--space-5);
}

.section-head {
  margin: var(--space-10) 0 var(--space-6);
  font-size: var(--fs-5);
  font-weight: 600;
  color: var(--text);
}

.mono {
  font-family: "SFMono-Regular", Menlo, Consolas, monospace;
  font-size: var(--fs-2);
}

.provider-row .info {
  flex: 1;
  min-width: 0;
}

.provider-row .name {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  font-weight: 500;
  flex-wrap: wrap;
}

.key-state {
  font-size: var(--fs-2);
  font-weight: 400;
}

.key-state.ok {
  color: var(--success);
}

.key-state.missing {
  /* `--danger-text`, not `--danger`: this is text, and the palette keeps a separate tone for it
     in each theme. */
  color: var(--danger-text);
}

.provider-row .url {
  color: var(--text-3);
  margin-top: var(--space-2);
}

.provider-row .models {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  margin-top: var(--space-4);
}

.model-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: var(--space-1) var(--space-3) var(--space-1) 9px;
  font-size: var(--fs-2);
  color: var(--text-2);
}

.chip-x {
  background: transparent;
  border: none;
  color: var(--text-3);
  cursor: pointer;
  font-size: var(--fs-3);
  line-height: 1;
  padding: 0 var(--space-1);
  font-family: inherit;
}

.chip-x:hover {
  color: var(--danger);
}

.no-models {
  color: var(--text-3);
  font-size: var(--fs-2);
}

.empty {
  color: var(--text-3);
  font-size: var(--fs-3);
  padding: var(--space-6) 0;
}

.value {
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: var(--space-4) var(--space-5);
}

.hint.inline {
  margin-left: var(--space-3);
}
</style>
