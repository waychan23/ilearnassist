<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "../../stores/app";
import { confirm } from "../../composables/confirm";
import type { DocumentParserConfig, DocumentParsePolicy } from "../../api/types";
import type { DocumentParserDraft } from "../../stores/app";
import DocumentParserDialog from "../dialogs/DocumentParserDialog.vue";
import Icon from "../Icon.vue";

/**
 * How the installation turns documents into text.
 *
 * Installation-wide, like the models: a cloud parser is an account the operator pays for and a
 * `baseURL` the **server** fetches (which is why `POST /api/document-parsers/:id/test` is the
 * same capability `web_fetch` needs an SSRF guard for). So it is the platform console's, not a
 * user's Settings — an ordinary account uploads a file and reads the parse state of it, which
 * is all it needs to do.
 */

const store = useAppStore();
const { t } = useI18n();

/** The order the policy picker offers; labels and hints come from the catalog by id. */
const POLICY_IDS: DocumentParsePolicy[] = ["local-only", "local-first", "cloud-first", "cloud-only"];
const policyLabel = (id: DocumentParsePolicy): string => t("settings.policy." + id + ".label");

const showParserEditor = ref(false);
const editingParser = ref<DocumentParserConfig | null>(null);
const testingId = ref<string | null>(null);
const testResult = ref<Record<string, { ok: boolean; message: string }>>({});

const documentParsers = computed(() => store.config?.documentParsers ?? []);
const documentParsing = computed(() => store.config?.documentParsing);

// The form is built from the kinds the server implements, so a new driver needs no UI change.
void store.loadParserKinds().catch(() => undefined);

const policyHint = computed(() => {
  const policy = documentParsing.value?.policy;
  return policy ? t("settings.policy." + policy + ".hint") : "";
});

function openNewParser(): void {
  editingParser.value = null;
  showParserEditor.value = true;
}

function openEditParser(p: DocumentParserConfig): void {
  editingParser.value = p;
  showParserEditor.value = true;
}

async function onSaveParser(draft: DocumentParserDraft): Promise<void> {
  try {
    await store.saveDocumentParser(draft);
    showParserEditor.value = false;
  } catch (e) {
    store.setError(e instanceof Error ? e.message : String(e));
  }
}

async function onDeleteParser(p: DocumentParserConfig): Promise<void> {
  const ok = await confirm({
    title: t("settings.deleteParser.title"),
    message: t("settings.deleteParser.message", { name: p.name }),
    detail: t("settings.deleteParser.detail"),
    confirmText: t("common.delete"),
    danger: true,
  });
  if (!ok) return;
  try {
    await store.deleteDocumentParser(p.id);
  } catch (e) {
    store.setError(e instanceof Error ? e.message : String(e));
  }
}

/** Round-trip a throwaway document through the service and report what came back. */
async function onTestParser(p: DocumentParserConfig): Promise<void> {
  testingId.value = p.id;
  testResult.value = { ...testResult.value, [p.id]: { ok: true, message: t("settings.documents.testing") } };
  try {
    await store.testDocumentParser(p.id);
    testResult.value = { ...testResult.value, [p.id]: { ok: true, message: t("settings.documents.testOk") } };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    testResult.value = { ...testResult.value, [p.id]: { ok: false, message } };
  } finally {
    testingId.value = null;
  }
}

async function onPolicyChange(policy: DocumentParsePolicy): Promise<void> {
  try {
    await store.setDocumentParsing({ policy });
  } catch (e) {
    store.setError(e instanceof Error ? e.message : String(e));
  }
}

async function onToggle(key: "localEnabled" | "fallbackEnabled", value: boolean): Promise<void> {
  try {
    await store.setDocumentParsing({ [key]: value });
  } catch (e) {
    store.setError(e instanceof Error ? e.message : String(e));
  }
}
</script>

<template>
  <div>
    <div class="config-tip">
      {{ t("settings.documents.introBefore") }}<strong>{{ t("settings.documents.introBuiltin") }}</strong
      >{{ t("settings.documents.introAfter") }}
    </div>

    <div class="field">
      <label>{{ t("settings.documents.policy") }}</label>
      <select
        class="select"
        :value="documentParsing?.policy"
        data-testid="parse-policy"
        @change="onPolicyChange(($event.target as HTMLSelectElement).value as DocumentParsePolicy)"
      >
        <option v-for="id in POLICY_IDS" :key="id" :value="id">{{ policyLabel(id) }}</option>
      </select>
      <div class="hint">{{ policyHint }}</div>
    </div>

    <div class="field">
      <label class="check-row">
        <input
          type="checkbox"
          :checked="documentParsing?.localEnabled"
          data-testid="parse-local-enabled"
          @change="onToggle('localEnabled', ($event.target as HTMLInputElement).checked)"
        />
        {{ t("settings.documents.localEnabled") }}
      </label>
      <div class="hint">
        {{ t("settings.documents.localHint") }}
      </div>
    </div>

    <div class="field">
      <label class="check-row">
        <input
          type="checkbox"
          :checked="documentParsing?.fallbackEnabled"
          data-testid="parse-fallback"
          @change="onToggle('fallbackEnabled', ($event.target as HTMLInputElement).checked)"
        />
        {{ t("settings.documents.fallback") }}
      </label>
      <div class="hint">
        {{ t("settings.documents.fallbackHint") }}
      </div>
    </div>

    <div class="models-head">
      <label>{{ t("settings.documents.cloudParsers") }}</label>
      <button class="btn small" @click="openNewParser" data-testid="add-parser">
        <Icon name="plus" /> {{ t("settings.documents.addParser") }}
      </button>
    </div>

    <div v-if="documentParsers.length === 0" class="empty-note">
      {{ t("settings.documents.noParsers") }}
    </div>

    <div
      v-for="p in documentParsers"
      :key="p.id"
      class="list-row parser-row"
      data-testid="parser-row"
    >
      <div class="parser-main">
        <div class="parser-name">
          {{ p.name }}
          <span class="badge" :class="{ muted: !p.enabled }">
            {{ p.enabled ? t("settings.documents.enabled") : t("settings.documents.disabled") }}
          </span>
          <span class="badge muted">{{ p.kind }}</span>
          <span v-if="p.hasApiKey" class="badge">{{ t("settings.documents.keySet") }}</span>
        </div>
        <div class="parser-url mono">{{ p.baseURL }}</div>
        <div
          v-if="testResult[p.id]"
          class="hint"
          :class="{ warn: !testResult[p.id]!.ok }"
          data-testid="parser-test-result"
        >
          {{ testResult[p.id]!.message }}
        </div>
      </div>
      <button class="btn small" :disabled="testingId === p.id" @click="onTestParser(p)">
        {{ testingId === p.id ? t("settings.documents.testing") : t("settings.documents.test") }}
      </button>
      <button class="btn small" @click="openEditParser(p)">{{ t("common.edit") }}</button>
      <button class="icon-btn danger" :title="t('common.delete')" @click="onDeleteParser(p)"><Icon name="trash" /></button>
    </div>

    <DocumentParserDialog
      v-if="showParserEditor"
      :parser="editingParser"
      :kinds="store.parserKinds"
      @close="showParserEditor = false"
      @save="onSaveParser"
    />
  </div>
</template>

<style scoped>
.mono {
  font-family: "SFMono-Regular", Menlo, Consolas, monospace;
  font-size: var(--fs-2);
}

/* A label and its action on one line. Written here rather than shared: `ProviderDialog` has an
   identical rule inside a *dialog*, and a global class for two call sites in different shells
   would be a third thing to keep in step. */
.models-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: var(--space-8) 0 var(--space-4);
  color: var(--text-2);
  font-size: var(--fs-3);
}

.empty-note {
  color: var(--text-3);
  font-size: var(--fs-2);
  padding: var(--space-5) var(--space-6);
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  margin-bottom: var(--space-5);
}

/* `.list-row` carries the box; this row's contents sit closer together than a provider's. */
.parser-row {
  gap: var(--space-4);
}

.parser-main {
  flex: 1;
  min-width: 0;
}

.parser-name {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  font-weight: 500;
  flex-wrap: wrap;
}

.parser-url {
  color: var(--text-3);
  margin-top: var(--space-2);
  font-size: var(--fs-2);
  word-break: break-all;
}

.parser-row .hint.warn {
  color: var(--warning);
}
</style>
