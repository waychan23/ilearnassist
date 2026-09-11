<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "../stores/app";
import type { ProviderConfig, ProviderModel } from "../api/types";

/**
 * Model picker for the composer toolbar, following chatbox's `ModelSelectorV2` placement.
 *
 * Only *available* models are offered: a provider must both be configured with an API key
 * and have at least one model. The one exception is the provider of the model currently in
 * force — hiding it would make the button disagree with the conversation's actual setting.
 */
const emit = defineEmits<{ manage: [] }>();
const { t } = useI18n();
const store = useAppStore();

const open = ref(false);
const rootEl = ref<HTMLElement | null>(null);

interface Group {
  providerId: string;
  providerName: string;
  available: boolean;
  models: ProviderModel[];
}

const groups = computed<Group[]>(() => {
  const providers = store.config?.providers ?? [];
  const currentProviderId = store.currentProviderId;

  return providers
    .filter((p) => p.id === currentProviderId || (p.hasApiKey && p.models.length > 0))
    .filter((p) => p.models.length > 0)
    .map((p: ProviderConfig) => ({
      providerId: p.id,
      providerName: p.name,
      available: p.hasApiKey,
      models: p.models,
    }));
});

const hasAnyAvailable = computed(() =>
  (store.config?.providers ?? []).some((p) => p.hasApiKey && p.models.length > 0)
);

const buttonLabel = computed(() => store.effectiveModel?.name || t("modelSelector.choose"));

function isCurrent(providerId: string, modelId: string) {
  return store.currentProviderId === providerId && store.effectiveModelId === modelId;
}

function choose(providerId: string, modelId: string) {
  open.value = false;
  // Provider and model are stored together: a model id only means something within its own
  // provider, so switching model must also pin the provider.
  store.setProviderAndModel(providerId, modelId);
}

function onDocumentPointerDown(event: PointerEvent) {
  if (rootEl.value && !rootEl.value.contains(event.target as Node)) open.value = false;
}

watch(open, (isOpen) => {
  if (isOpen) document.addEventListener("pointerdown", onDocumentPointerDown, true);
  else document.removeEventListener("pointerdown", onDocumentPointerDown, true);
});

onBeforeUnmount(() => document.removeEventListener("pointerdown", onDocumentPointerDown, true));
</script>

<template>
  <div ref="rootEl" class="model-picker">
    <button
      class="model-btn"
      :title="hasAnyAvailable ? t('modelSelector.chooseTitle') : t('modelSelector.noModelsTitle')"
      @click="open = !open"
    >
      <span class="dot" :class="{ off: !store.effectiveModel }"></span>
      <span class="label">{{ buttonLabel }}</span>
      <span class="caret" :class="{ open }">▾</span>
    </button>

    <div v-if="open" class="menu">
      <template v-for="group in groups" :key="group.providerId">
        <div class="group-head">
          {{ group.providerName }}
          <span v-if="!group.available" class="warn">{{ t("modelSelector.keyMissing") }}</span>
        </div>
        <button
          v-for="m in group.models"
          :key="m.id"
          class="item"
          :class="{ active: isCurrent(group.providerId, m.modelId) }"
          @click="choose(group.providerId, m.modelId)"
        >
          <span class="check">{{ isCurrent(group.providerId, m.modelId) ? "✓" : "" }}</span>
          <span class="name">{{ m.name }}</span>
          <span class="caps">
            <span v-if="m.capabilities.includes('vision')" :title="t('providers.capabilities.vision')">🖼</span>
            <span v-if="m.capabilities.includes('reasoning')" :title="t('providers.capabilities.reasoning')">🧠</span>
          </span>
        </button>
      </template>

      <div v-if="groups.length === 0" class="empty">
        {{ t("modelSelector.empty") }}
      </div>

      <button class="foot" @click="open = false; emit('manage')">{{ t("modelSelector.manage") }}</button>
    </div>
  </div>
</template>

<style scoped>
.model-picker {
  position: relative;
  display: flex;
  align-items: center;
}

.model-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 220px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 8px;
  color: var(--text-3);
  font-size: 12px;
  font-family: inherit;
  padding: 4px 8px;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.12s, color 0.12s;
}
.model-btn:hover {
  background: var(--panel);
  color: var(--text-2);
}
.model-btn .label {
  overflow: hidden;
  text-overflow: ellipsis;
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--success);
  flex-shrink: 0;
}
.dot.off {
  background: var(--text-3);
}
.caret {
  font-size: 10px;
  transition: transform 0.15s;
}
.caret.open {
  transform: rotate(180deg);
}

.menu {
  position: absolute;
  bottom: calc(100% + 8px);
  right: 0;
  z-index: 60;
  width: 280px;
  max-height: 340px;
  overflow-y: auto;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 6px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
}

.group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 8px 4px;
  font-size: 11px;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.group-head .warn {
  color: var(--warning);
  text-transform: none;
  letter-spacing: 0;
}

.item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-2);
  font-size: 13px;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}
.item:hover {
  background: var(--panel-2);
  color: var(--text);
}
.item.active {
  color: var(--text);
}
.item .check {
  width: 12px;
  flex-shrink: 0;
  color: var(--accent);
  font-size: 11px;
}
.item .name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.item .caps {
  flex-shrink: 0;
  font-size: 11px;
}

.empty {
  padding: 10px 8px;
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.6;
}

.foot {
  width: 100%;
  margin-top: 4px;
  padding: 8px;
  border: 0;
  border-top: 1px solid var(--border);
  border-radius: 0 0 6px 6px;
  background: transparent;
  color: var(--accent);
  font-size: 12px;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}
.foot:hover {
  background: var(--panel-2);
}
</style>
