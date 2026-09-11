<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "../stores/app";
import type { ProviderConfig, ProviderModel } from "../api/types";
import Icon from "./Icon.vue";

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
      class="btn ghost model-btn"
      :title="hasAnyAvailable ? t('modelSelector.chooseTitle') : t('modelSelector.noModelsTitle')"
      @click="open = !open"
    >
      <span class="status-dot ok" :class="{ off: !store.effectiveModel }"></span>
      <span class="label truncate">{{ buttonLabel }}</span>
      <Icon class="caret" :class="{ open }" name="caret-down" />
    </button>

    <div v-if="open" class="overlay-popover menu">
      <template v-for="group in groups" :key="group.providerId">
        <div class="group-head">
          {{ group.providerName }}
          <span v-if="!group.available" class="warn">{{ t("modelSelector.keyMissing") }}</span>
        </div>
        <button
          v-for="m in group.models"
          :key="m.id"
          class="menu-item"
          :class="{ active: isCurrent(group.providerId, m.modelId) }"
          @click="choose(group.providerId, m.modelId)"
        >
          <span class="check-mark">
            <Icon v-if="isCurrent(group.providerId, m.modelId)" name="check" />
          </span>
          <span class="name truncate">{{ m.name }}</span>
          <span class="caps">
            <span v-if="m.capabilities.includes('vision')" :title="t('providers.capabilities.vision')"><Icon name="image" /></span>
            <span v-if="m.capabilities.includes('reasoning')" :title="t('providers.capabilities.reasoning')"><Icon name="bulb" /></span>
          </span>
        </button>
      </template>

      <div v-if="groups.length === 0" class="empty">
        {{ t("modelSelector.empty") }}
      </div>

      <button class="menu-item foot" @click="open = false; emit('manage')">{{ t("modelSelector.manage") }}</button>
    </div>
  </div>
</template>

<style scoped>
.model-picker {
  position: relative;
  display: flex;
  align-items: center;
}

/*
 * The chrome, the hover and the transition come from `.btn.ghost`. Its hover steps to
 * `--panel-2`, where this button's own used to fill with `--panel` — the composer's own
 * background, so the hover was invisible.
 */
.model-btn {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  /* The `45vw` half only binds on a narrow screen, where the model name is the widest thing
     in the toolbar and has to yield to the controls beside it. */
  max-width: min(220px, 45vw);
  font-size: var(--fs-2);
  padding: var(--space-2) var(--space-4);
  white-space: nowrap;
}

.caret {
  font-size: var(--fs-1);
  transition: transform var(--dur-fast);
}
.caret.open {
  transform: rotate(180deg);
}

/* The surface, anchor and elevation come from `.overlay-popover`; only the size is ours. */
.menu {
  width: 280px;
  max-height: 340px;
  overflow-y: auto;
  padding: var(--space-3);
}

/*
 * A scoped declaration outranks the sheet's narrow-screen rule on specificity, not on order,
 * so the width has to be released here rather than there. The sheet still owns where it ends
 * up; this only says it stops insisting on 280px.
 */
@media (max-width: 560px) {
  .menu {
    width: auto;
  }
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

.menu-item.active {
  color: var(--text);
}
/* A tick gutter, so the model names line up whether or not one is current. */
.menu-item .check-mark {
  width: 12px;
  flex-shrink: 0;
  color: var(--accent);
  font-size: var(--fs-1);
}
.menu-item .name {
  flex: 1;
}
.menu-item .caps {
  flex-shrink: 0;
  /* `--fs-2`, matching the capability marks in the settings chip. At `--fs-1` an `<Icon>`
   * is exactly 11px, where the emoji it replaced rendered optically larger than its font
   * size — so the same token would have made these visibly smaller than before. */
  font-size: var(--fs-2);
}

.empty {
  padding: var(--space-5) var(--space-4);
  font-size: var(--fs-2);
  color: var(--text-3);
  line-height: var(--lh-base);
}

</style>
