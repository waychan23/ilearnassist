<script setup lang="ts">
import { computed, reactive, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { DocumentParserConfig, DocumentParserKind, DriverInfo } from "../../api/types";
import type { DocumentParserDraft } from "../../stores/app";

/**
 * Add/edit one cloud document parser.
 *
 * Deliberately a near-twin of `ProviderDialog.vue`, including the write-only API key: the
 * server never returns a stored key, so the field is never prefilled and leaving it blank
 * means "keep what is there".
 */

const props = defineProps<{
  parser: DocumentParserConfig | null;
  kinds: DriverInfo[];
  /** Pre-selected when opened from the empty state with only one kind available. */
  defaultKind?: DocumentParserKind;
}>();

const emit = defineEmits<{ close: []; save: [draft: DocumentParserDraft] }>();
const { t } = useI18n();

const draft = reactive<{
  name: string;
  kind: DocumentParserKind;
  baseURL: string;
  apiKey: string;
  enabled: boolean;
}>({ name: "", kind: "sync", baseURL: "", apiKey: "", enabled: true });

watch(
  () => props.parser,
  (p) => {
    draft.name = p?.name ?? "";
    draft.kind = p?.kind ?? props.defaultKind ?? "sync";
    draft.baseURL = p?.baseURL ?? "";
    // Never prefilled — the key is write-only from the client's point of view.
    draft.apiKey = "";
    draft.enabled = p?.enabled ?? true;
  },
  { immediate: true }
);

const selectedKind = computed(() => props.kinds.find((k) => k.kind === draft.kind));

/** Fill the endpoint for a kind the user has just switched to, if it is still blank. */
watch(
  () => draft.kind,
  (kind) => {
    const info = props.kinds.find((k) => k.kind === kind);
    if (info?.defaultBaseURL && !draft.baseURL.trim()) draft.baseURL = info.defaultBaseURL;
    if (!draft.name.trim() && info) draft.name = info.label;
  }
);

const keyRequired = computed(() => !!selectedKind.value?.requiresApiKey);
const keyPlaceholder = computed(() =>
  props.parser?.hasApiKey
    ? t("parsers.apiKeySet")
    : keyRequired.value
      ? t("parsers.apiKeyRequired")
      : t("parsers.apiKeyOptionalValue")
);

const canSave = computed(() => {
  if (!draft.name.trim() || !draft.baseURL.trim()) return false;
  // A key is only demanded on create; an edit may legitimately leave it as-is.
  if (keyRequired.value && !props.parser?.hasApiKey && !draft.apiKey.trim()) return false;
  return true;
});

function save() {
  if (!canSave.value) return;
  emit("save", {
    id: props.parser?.id,
    name: draft.name,
    kind: draft.kind,
    baseURL: draft.baseURL,
    apiKey: draft.apiKey.trim(),
    enabled: draft.enabled,
  });
}
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')">
    <div class="modal">
      <div class="modal-head">
        <h3>{{ props.parser ? t("parsers.edit") : t("parsers.create") }}</h3>
        <button
        class="icon-btn"
        :title="t('common.close')"
        :aria-label="t('common.close')"
        @click="emit('close')"
      >✕</button>
      </div>
      <div class="modal-body">
        <div class="field">
          <label>{{ t("parsers.kind") }}</label>
          <select v-model="draft.kind" class="input" data-testid="parser-kind">
            <option v-for="k in props.kinds" :key="k.kind" :value="k.kind">{{ k.label }}</option>
          </select>
          <div class="hint">
            {{ t("parsers.kindHint") }}
          </div>
        </div>

        <div class="field">
          <label>{{ t("common.name") }}</label>
          <input v-model="draft.name" class="input" :placeholder="t('parsers.namePlaceholder')" />
        </div>

        <div class="field">
          <label>Base URL</label>
          <input
            v-model="draft.baseURL"
            class="input"
            :placeholder="selectedKind?.defaultBaseURL ?? 'http://127.0.0.1:5001/v1/convert/file'"
          />
          <div class="hint" v-if="selectedKind?.helpURL">
            {{ t("parsers.credentialsBefore") }}<a
              :href="selectedKind.helpURL"
              target="_blank"
              rel="noreferrer"
              >{{ selectedKind.helpURL }}</a
            >
          </div>
        </div>

        <div class="field">
          <label>{{ t("parsers.apiKey") }}{{ keyRequired ? "" : t("parsers.apiKeyOptional") }}</label>
          <input
            v-model="draft.apiKey"
            class="input"
            type="password"
            autocomplete="new-password"
            :placeholder="keyPlaceholder"
            data-testid="parser-api-key"
          />
          <div class="hint">
            {{ t("parsers.apiKeyNote") }}
          </div>
        </div>

        <div class="field">
          <label class="check-row">
            <input v-model="draft.enabled" type="checkbox" />
            {{ t("parsers.enabled") }}
          </label>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn" @click="emit('close')">{{ t("common.cancel") }}</button>
        <button class="btn primary" :disabled="!canSave" @click="save" data-testid="parser-save">
          {{ t("common.save") }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.field {
  margin-bottom: var(--space-6);
}
.hint a {
  color: var(--accent);
  word-break: break-all;
}
</style>
