<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "../../stores/app";
import { confirm } from "../../composables/confirm";
import type {
  Copilot,
  DocumentParserConfig,
  DocumentParsePolicy,
  ProviderConfig,
} from "../../api/types";
import type { CopilotDraft, DocumentParserDraft, ProviderDraft } from "../../stores/app";
import ProviderDialog from "./ProviderDialog.vue";
import CopilotDialog from "./CopilotDialog.vue";
import DocumentParserDialog from "./DocumentParserDialog.vue";

const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();
const store = useAppStore();

const tab = ref<"providers" | "copilots" | "documents" | "defaults">("providers");
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

function openNew() {
  editing.value = null;
  showEditor.value = true;
}

function openEdit(p: ProviderConfig) {
  editing.value = p;
  showEditor.value = true;
}

async function onSave(draft: ProviderDraft) {
  try {
    await store.saveProvider(draft);
    showEditor.value = false;
  } catch (e) {
    store.setError(e instanceof Error ? e.message : String(e));
  }
}

async function onDelete(p: ProviderConfig) {
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

async function onDeleteModel(provider: ProviderConfig, modelId: string, name: string) {
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

/* ----------------------------- document parsers ----------------------------- */

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

function openNewParser() {
  editingParser.value = null;
  showParserEditor.value = true;
}

function openEditParser(p: DocumentParserConfig) {
  editingParser.value = p;
  showParserEditor.value = true;
}

async function onSaveParser(draft: DocumentParserDraft) {
  try {
    await store.saveDocumentParser(draft);
    showParserEditor.value = false;
  } catch (e) {
    store.setError(e instanceof Error ? e.message : String(e));
  }
}

async function onDeleteParser(p: DocumentParserConfig) {
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
async function onTestParser(p: DocumentParserConfig) {
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

async function onPolicyChange(policy: DocumentParsePolicy) {
  try {
    await store.setDocumentParsing({ policy });
  } catch (e) {
    store.setError(e instanceof Error ? e.message : String(e));
  }
}

async function onToggle(key: "localEnabled" | "fallbackEnabled", value: boolean) {
  try {
    await store.setDocumentParsing({ [key]: value });
  } catch (e) {
    store.setError(e instanceof Error ? e.message : String(e));
  }
}

/* --------------------------------- Copilots --------------------------------- */

const showCopilotEditor = ref(false);
const editingCopilot = ref<Copilot | null>(null);

function openNewCopilot() {
  editingCopilot.value = null;
  showCopilotEditor.value = true;
}

function openEditCopilot(c: Copilot) {
  editingCopilot.value = c;
  showCopilotEditor.value = true;
}

async function onSaveCopilot(draft: CopilotDraft) {
  try {
    await store.saveCopilot(draft);
    showCopilotEditor.value = false;
  } catch (e) {
    store.setError(e instanceof Error ? e.message : String(e));
  }
}

async function onDeleteCopilot(c: Copilot) {
  const ok = await confirm({
    title: t("settings.deleteCopilot.title"),
    message: t("settings.deleteCopilot.message", { name: c.name }),
    detail: t("settings.deleteCopilot.detail"),
    confirmText: t("common.delete"),
    danger: true,
  });
  if (!ok) return;
  try {
    await store.deleteCopilot(c.id);
  } catch (e) {
    store.setError(e instanceof Error ? e.message : String(e));
  }
}

/** One-line digest of what a Copilot changes, shown under its name. */
function copilotSummary(c: Copilot) {
  const bits: string[] = [];
  if (c.settings.modelId) bits.push(c.settings.modelId);
  if (c.settings.temperature != null) bits.push(`temperature ${c.settings.temperature}`);
  if (c.settings.maxSteps != null) {
    bits.push(t("settings.copilot.summarySteps", { count: c.settings.maxSteps }));
  }
  if (c.settings.maxContextMessages != null) {
    bits.push(
      t(
        "settings.copilot.summaryHistory",
        { count: c.settings.maxContextMessages },
        c.settings.maxContextMessages
      )
    );
  }
  bits.push(
    c.tools.length
      ? t("settings.copilot.summaryTools", { count: c.tools.length }, c.tools.length)
      : t("settings.copilot.summaryAllTools")
  );
  return bits.join(" · ");
}

function onDefaultProviderChange(e: Event) {
  const providerId = (e.target as HTMLSelectElement).value;
  const first = providers.value.find((p) => p.id === providerId)?.models[0]?.modelId;
  void store.setDefaults({ providerId, ...(first ? { modelId: first } : {}) });
}

function onDefaultModelChange(e: Event) {
  void store.setDefaults({ modelId: (e.target as HTMLSelectElement).value });
}
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')">
    <div class="modal wide">
      <div class="modal-head">
        <h3>{{ t("settings.title") }}</h3>
        <button class="icon-btn" @click="emit('close')">✕</button>
      </div>

      <div class="tabs">
        <button class="tab" :class="{ active: tab === 'providers' }" @click="tab = 'providers'">
          {{ t("settings.tabs.providers") }}
        </button>
        <button class="tab" :class="{ active: tab === 'copilots' }" @click="tab = 'copilots'">
          Copilots
          <span v-if="store.copilots.length" class="tab-count">{{ store.copilots.length }}</span>
        </button>
        <button
          class="tab"
          :class="{ active: tab === 'documents' }"
          data-testid="tab-documents"
          @click="tab = 'documents'"
        >
          {{ t("settings.tabs.documents") }}
          <span v-if="documentParsers.length" class="tab-count">{{ documentParsers.length }}</span>
        </button>
        <button class="tab" :class="{ active: tab === 'defaults' }" @click="tab = 'defaults'">
          {{ t("settings.tabs.copilot") }}
        </button>
      </div>

      <div class="modal-body">
        <template v-if="tab === 'providers'">
          <div class="config-tip">
            {{ t("settings.providers.noteBefore") }}<strong>{{ t("settings.providers.noteLive") }}</strong
            >{{ t("settings.providers.noteBetween") }}<code>{{
              t("settings.providers.noteConfigFile")
            }}</code
            >{{ t("settings.providers.noteAfter") }}
          </div>

          <div class="list-head">
            <span>{{
            t(
              "settings.providers.countConfigured",
              { count: providers.length },
              providers.length
            )
          }}</span>
            <button class="btn small" @click="openNew">{{ t("settings.providers.add") }}</button>
          </div>

          <div v-for="p in providers" :key="p.id" class="provider-row">
            <div class="info">
              <div class="name">
                {{ p.name }}
                <span v-if="p.id === defaultProvider" class="badge">{{ t("settings.providers.default") }}</span>
                <span class="key-state" :class="p.hasApiKey ? 'ok' : 'missing'">
                  {{ p.hasApiKey ? t("settings.providers.keySet") : t("settings.providers.keyMissing") }}
                </span>
              </div>
              <div class="mono url">{{ p.baseURL }}</div>
              <div class="models">
                <span v-for="m in p.models" :key="m.id" class="model-chip">
                  {{ m.name }}
                  <span v-if="m.capabilities.includes('vision')" :title="t('settings.providers.visionHint')">🖼</span>
                  <span v-if="m.capabilities.includes('reasoning')" :title="t('settings.providers.reasoningHint')">🧠</span>
                  <button
                    class="chip-x"
                    :title="t('settings.providers.deleteModel')"
                    @click.stop="onDeleteModel(p, m.id, m.name)"
                  >
                    ×
                  </button>
                </span>
                <span v-if="p.models.length === 0" class="no-models">{{ t("settings.providers.noModels") }}</span>
              </div>
            </div>
            <div class="row-actions">
              <button class="btn small" @click="openEdit(p)">{{ t("common.edit") }}</button>
              <button class="icon-btn danger" :title="t('common.delete')" @click="onDelete(p)">🗑</button>
            </div>
          </div>

          <div v-if="providers.length === 0" class="empty">
            {{ t("settings.providers.empty") }}
          </div>
        </template>

        <template v-else-if="tab === 'documents'">
          <div class="config-tip">
            {{ t("settings.documents.introBefore") }}<strong>{{
              t("settings.documents.introBuiltin")
            }}</strong>{{ t("settings.documents.introAfter") }}
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
            <label class="check">
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
            <label class="check">
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
              {{ t("settings.documents.addParser") }}
            </button>
          </div>

          <div v-if="documentParsers.length === 0" class="empty-note">
            {{ t("settings.documents.noParsers") }}
          </div>

          <div
            v-for="p in documentParsers"
            :key="p.id"
            class="parser-row"
            data-testid="parser-row"
          >
            <div class="parser-main">
              <div class="parser-name">
                {{ p.name }}
                <span class="badge" :class="{ off: !p.enabled }">
                  {{ p.enabled ? t("settings.documents.enabled") : t("settings.documents.disabled") }}
                </span>
                <span class="badge kind">{{ p.kind }}</span>
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
            <button
              class="btn small"
              :disabled="testingId === p.id"
              @click="onTestParser(p)"
            >
              {{ testingId === p.id ? t("settings.documents.testing") : t("settings.documents.test") }}
            </button>
            <button class="btn small" @click="openEditParser(p)">{{ t("common.edit") }}</button>
            <button class="icon-btn danger" :title="t('common.delete')" @click="onDeleteParser(p)">✕</button>
          </div>
        </template>

        <template v-else-if="tab === 'copilots'">
          <div class="config-tip">
            {{ t("settings.copilot.introBefore") }}<strong>{{ t("settings.copilot.introCopied") }}</strong
            >{{ t("settings.copilot.introAfter") }}
          </div>

          <div class="list-head">
            <span>{{
            t(
              "settings.copilot.countConfigured",
              { count: store.copilots.length },
              store.copilots.length
            )
          }}</span>
            <button class="btn small" @click="openNewCopilot">{{ t("settings.copilot.add") }}</button>
          </div>

          <div v-for="c in store.copilots" :key="c.id" class="copilot-row">
            <div class="info">
              <div class="name">
                <span class="dot"></span>
                {{ c.name }}
                <span v-if="c.id === store.activeCopilotId" class="badge">{{ t("settings.copilot.inUse") }}</span>
              </div>
              <div v-if="c.description" class="desc">{{ c.description }}</div>
              <div class="meta">{{ copilotSummary(c) }}</div>
            </div>
            <div class="row-actions">
              <button class="btn small" @click="openEditCopilot(c)">{{ t("common.edit") }}</button>
              <button class="icon-btn danger" :title="t('common.delete')" @click="onDeleteCopilot(c)">🗑</button>
            </div>
          </div>

          <div v-if="store.copilots.length === 0" class="empty">
            {{ t("settings.copilot.empty") }}
          </div>
        </template>

        <template v-else>
          <div class="field">
            <label>{{ t("settings.defaults.provider") }}</label>
            <select class="select" :value="defaultProvider" @change="onDefaultProviderChange">
              <option v-for="p in providers" :key="p.id" :value="p.id">{{ p.name }}</option>
            </select>
            <div class="hint">{{ t("settings.defaults.providerHint", { name: defaultProviderName }) }}</div>
          </div>

          <div class="field">
            <label>{{ t("settings.defaults.model") }}</label>
            <select class="select" :value="defaultModel" @change="onDefaultModelChange">
              <option v-for="m in defaultModelOptions" :key="m.id" :value="m.modelId">
                {{ m.name }}
              </option>
            </select>
            <div class="hint">{{
              t("settings.defaults.modelHint", {
                name: defaultModel || t("settings.defaults.modelUnset"),
              })
            }}</div>
          </div>

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
        </template>
      </div>

      <div class="modal-foot">
        <button class="btn primary" @click="emit('close')">{{ t("common.close") }}</button>
      </div>
    </div>

    <ProviderDialog
      v-if="showEditor"
      :provider="editing"
      @close="showEditor = false"
      @save="onSave"
    />
    <CopilotDialog
      v-if="showCopilotEditor"
      :copilot="editingCopilot"
      @close="showCopilotEditor = false"
      @save="onSaveCopilot"
    />
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
.modal.wide {
  width: 720px;
}
.mono {
  font-family: "SFMono-Regular", Menlo, Consolas, monospace;
  font-size: 12px;
}
.tabs {
  display: flex;
  gap: 4px;
  padding: 10px 20px 0;
  border-bottom: 1px solid var(--border);
}
.tab {
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-3);
  padding: 8px 12px;
  cursor: pointer;
  font-size: 13px;
  font-family: inherit;
}
.tab:hover {
  color: var(--text-2);
}
.tab.active {
  color: var(--text);
  border-bottom-color: var(--accent);
}
.tab-count {
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 8px;
  background: var(--panel-2);
  color: var(--text-3);
  font-size: 11px;
}
.tab.active .tab-count {
  color: var(--text-2);
}
.list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  color: var(--text-2);
  font-size: 13px;
  margin-bottom: 10px;
}
.check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-2);
  cursor: pointer;
}
.empty-note {
  color: var(--text-3);
  font-size: 12px;
  padding: 10px 12px;
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  margin-bottom: 10px;
}
.parser-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px;
  margin-bottom: 8px;
  background: var(--panel-2);
}
.parser-main {
  flex: 1;
  min-width: 0;
}
.parser-name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 500;
  flex-wrap: wrap;
}
.parser-row .badge {
  font-size: 11px;
  color: var(--accent);
  border: 1px solid var(--accent);
  border-radius: 10px;
  padding: 0 7px;
  font-weight: 400;
}
.parser-row .badge.off {
  color: var(--text-3);
  border-color: var(--border);
}
.parser-row .badge.kind {
  color: var(--text-3);
  border-color: var(--border);
}
.parser-url {
  color: var(--text-3);
  margin-top: 4px;
  font-size: 12px;
  word-break: break-all;
}
.parser-row .hint.warn {
  color: var(--warning);
}
.provider-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px;
  margin-bottom: 8px;
  background: var(--panel-2);
}
.provider-row .info {
  flex: 1;
  min-width: 0;
}
.provider-row .name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 500;
}
.provider-row .badge {
  font-size: 11px;
  color: var(--accent);
  border: 1px solid var(--accent);
  border-radius: 10px;
  padding: 0 7px;
  font-weight: 400;
}
.key-state {
  font-size: 12px;
  font-weight: 400;
}
.key-state.ok {
  color: var(--success);
}
.key-state.missing {
  /* `--danger-text`, not `--danger`: this is text, and the palette keeps a separate tone
     for it in each theme. */
  color: var(--danger-text);
}
.provider-row .url {
  color: var(--text-3);
  margin-top: 4px;
}
.provider-row .models {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
.model-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 2px 6px 2px 9px;
  font-size: 12px;
  color: var(--text-2);
}
.chip-x {
  background: transparent;
  border: none;
  color: var(--text-3);
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  padding: 0 2px;
  font-family: inherit;
}
.chip-x:hover {
  color: var(--danger);
}
.no-models {
  color: var(--text-3);
  font-size: 12px;
}
.row-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}
.copilot-row {
  display: flex;
  align-items: center;
  gap: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px 12px;
  margin-bottom: 8px;
  background: var(--panel-2);
}
.copilot-row .info {
  flex: 1;
  min-width: 0;
}
.copilot-row .name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 500;
}
.copilot-row .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
  flex-shrink: 0;
}
.copilot-row .badge {
  font-size: 11px;
  font-weight: 400;
  color: var(--accent);
  border: 1px solid var(--accent);
  border-radius: 10px;
  padding: 0 7px;
}
.copilot-row .desc {
  color: var(--text-2);
  font-size: 13px;
  margin-top: 2px;
}
.copilot-row .meta {
  color: var(--text-3);
  font-size: 12px;
  margin-top: 4px;
}
.empty {
  color: var(--text-3);
  font-size: 13px;
  padding: 12px 0;
}
.value {
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 8px 10px;
}
.hint.inline {
  margin-left: 6px;
}
</style>
