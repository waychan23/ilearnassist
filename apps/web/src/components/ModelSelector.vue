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
  gap: var(--space-3);
  max-width: 220px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius);
  color: var(--text-3);
  font-size: var(--fs-2);
  font-family: inherit;
  padding: var(--space-2) var(--space-4);
  cursor: pointer;
  white-space: nowrap;
  transition: background var(--dur-fast), color var(--dur-fast);
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
  font-size: var(--fs-1);
  transition: transform var(--dur-fast);
}
.caret.open {
  transform: rotate(180deg);
}

.menu {
  position: absolute;
  bottom: calc(100% + 8px);
  right: 0;
  z-index: var(--z-popover);
  width: 280px;
  max-height: 340px;
  overflow-y: auto;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: var(--space-3);
  box-shadow: var(--shadow-popover);
}

.group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-4) var(--space-2);
  font-size: var(--fs-1);
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
  gap: var(--space-4);
  width: 100%;
  padding: 7px var(--space-4);
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-2);
  font-size: var(--fs-3);
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
  font-size: var(--fs-1);
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
  font-size: var(--fs-1);
}

.empty {
  padding: var(--space-5) var(--space-4);
  font-size: var(--fs-2);
  color: var(--text-3);
  line-height: var(--lh-base);
}

.foot {
  width: 100%;
  margin-top: var(--space-2);
  padding: var(--space-4);
  border: 0;
  border-top: 1px solid var(--border);
  border-radius: 0 0 var(--radius-sm) var(--radius-sm);
  background: transparent;
  color: var(--accent);
  font-size: var(--fs-2);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}
.foot:hover {
  background: var(--panel-2);
}
</style>
