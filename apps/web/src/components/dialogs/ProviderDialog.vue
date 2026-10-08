<script setup lang="ts">
import { computed, reactive, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_PROVIDER_USER_AGENT,
  isValidProviderHeaderName,
  isValidProviderUserAgent,
} from "../../api/types";
import type { ProviderConfig } from "../../api/types";
import type { ProviderDraft } from "../../stores/app";
import Icon from "../Icon.vue";

const CAPABILITIES = [
  { id: "vision" },
  { id: "reasoning" },
  { id: "tool_use" },
] as const;

const props = defineProps<{ provider: ProviderConfig | null }>();
const emit = defineEmits<{ close: []; save: [draft: ProviderDraft] }>();
const { t } = useI18n();

interface ModelRow {
  id?: string;
  modelId: string;
  name: string;
  contextWindow: string;
  maxOutput: string;
  capabilities: string[];
}

/**
 * The request headers a provider may add, and the two the feature supports today.
 *
 * The list is the console's whole "scope of addition": the + control offers exactly these, and
 * a kind already present is not offered again. Adding one is what turns it on — an unconfigured
 * provider sends neither.
 */
type HeaderKind = "user-agent" | "session";
const HEADER_KINDS: readonly HeaderKind[] = ["user-agent", "session"];

interface HeaderRow {
  kind: HeaderKind;
  /** The User-Agent value, or the session header's name — whichever the kind edits. */
  value: string;
}

const draft = reactive<{
  name: string;
  baseURL: string;
  apiKey: string;
  headers: HeaderRow[];
  models: ModelRow[];
}>({ name: "", baseURL: "", apiKey: "", headers: [], models: [] });

watch(
  () => props.provider,
  (p) => {
    draft.name = p?.name ?? "";
    draft.baseURL = p?.baseURL ?? "";
    // Never prefilled — the key is write-only from the client's point of view.
    draft.apiKey = "";
    // Unlike the key these round-trip, and `null` means "not added": a stored value is a row.
    draft.headers = [];
    if (p?.userAgent) draft.headers.push({ kind: "user-agent", value: p.userAgent });
    if (p?.sessionHeader) draft.headers.push({ kind: "session", value: p.sessionHeader });
    draft.models = (p?.models ?? []).map((m) => ({
      id: m.id,
      modelId: m.modelId,
      name: m.name,
      contextWindow: m.contextWindow == null ? "" : String(m.contextWindow),
      maxOutput: m.maxOutput == null ? "" : String(m.maxOutput),
      capabilities: [...m.capabilities],
    }));
    if (draft.models.length === 0) addModel();
  },
  { immediate: true }
);

/**
 * No shipping model has a context window anywhere near this. Catching it matters because
 * an inflated value silently makes the composer's context-usage indicator read ~0%.
 */
const IMPLAUSIBLE_CONTEXT = 10_000_000;

function contextLooksWrong(row: ModelRow): boolean {
  const n = Number(row.contextWindow.trim());
  return row.contextWindow.trim() !== "" && Number.isFinite(n) && n > IMPLAUSIBLE_CONTEXT;
}

function addModel() {
  draft.models.push({
    modelId: "",
    name: "",
    contextWindow: "",
    maxOutput: "",
    capabilities: ["tool_use"],
  });
}

function removeModel(index: number) {
  draft.models.splice(index, 1);
}

function toggleCapability(row: ModelRow, cap: string) {
  const i = row.capabilities.indexOf(cap);
  if (i === -1) row.capabilities.push(cap);
  else row.capabilities.splice(i, 1);
}

const keyPlaceholder = computed(() =>
  props.provider?.hasApiKey ? t("providers.apiKeySet") : t("providers.apiKeyUnset")
);

/*
 * The + control's scope: the kinds not already on the form. One each — a provider has one
 * User-Agent and one session header, so offering a duplicate would be a second row that
 * silently overwrites the first.
 */
const addableKinds = computed(() =>
  HEADER_KINDS.filter((kind) => !draft.headers.some((h) => h.kind === kind))
);

/*
 * A `switch` of literal `t("…")` calls rather than a ternary: the catalog guard only counts a
 * key as referenced when it is the first argument of a translation call, and a conditional
 * expression there would leave both keys looking dead.
 */
function headerLabel(kind: HeaderKind): string {
  switch (kind) {
    case "user-agent":
      return t("providers.header.userAgent");
    case "session":
      return t("providers.header.session");
  }
}

/*
 * Read off the event rather than through a `v-model`, so the addition cannot depend on two
 * listeners on one `change` event firing in a particular order. The select's bound value is
 * `""`, so it snaps back to its placeholder as soon as the row renders.
 */
function addHeader(event: Event) {
  const kind = (event.target as HTMLSelectElement).value as HeaderKind | "";
  if (kind) draft.headers.push({ kind, value: "" });
}

function removeHeader(index: number) {
  draft.headers.splice(index, 1);
}

/*
 * Client-side validation, using the *server's own* functions so a value this form accepts is
 * a value the route accepts.
 *
 * The two rows differ on purpose, because only one of them has something to fall back on. An
 * empty User-Agent is legal and saves as `DEFAULT_PROVIDER_USER_AGENT`; the session header has
 * no default and no derived value, so an empty name is a row that could not be sent at all and
 * is refused. In both cases removing the row is what turns the header off, and the × is there.
 */
function headerValid(row: HeaderRow): boolean {
  if (row.kind === "user-agent") {
    return !row.value.trim() || isValidProviderUserAgent(row.value);
  }
  return isValidProviderHeaderName(row.value);
}

function headerHint(row: HeaderRow): string {
  if (row.kind === "user-agent") {
    return headerValid(row)
      ? t("providers.header.userAgentHint", { value: DEFAULT_PROVIDER_USER_AGENT })
      : t("providers.header.userAgentInvalid");
  }
  return headerValid(row) ? t("providers.header.sessionHint") : t("providers.header.sessionInvalid");
}

const canSave = computed(
  () =>
    !!draft.name.trim() &&
    !!draft.baseURL.trim() &&
    draft.models.some((m) => m.modelId.trim()) &&
    draft.headers.every(headerValid)
);

const num = (v: string): number | null => {
  const t = v.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

function save() {
  if (!canSave.value) return;
  const userAgentRow = draft.headers.find((h) => h.kind === "user-agent");
  emit("save", {
    id: props.provider?.id,
    name: draft.name,
    baseURL: draft.baseURL,
    apiKey: draft.apiKey.trim(),
    // An absent row is the empty string, which the store sends as "no such header". A row left
    // blank is not absent: it saves as the built-in default, so the header is still sent.
    userAgent: userAgentRow
      ? userAgentRow.value.trim() || DEFAULT_PROVIDER_USER_AGENT
      : "",
    sessionHeader: draft.headers.find((h) => h.kind === "session")?.value.trim() ?? "",
    models: draft.models
      .filter((m) => m.modelId.trim())
      .map((m) => ({
        id: m.id,
        modelId: m.modelId,
        name: m.name,
        contextWindow: num(m.contextWindow),
        maxOutput: num(m.maxOutput),
        capabilities: [...m.capabilities],
      })),
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
      <div class="modal lg">
        <div class="modal-head">
          <h3>{{ props.provider ? t("providers.edit") : t("providers.create") }}</h3>
          <button
            class="icon-btn"
            data-testid="provider-close"
            :title="t('common.close')"
            :aria-label="t('common.close')"
            @click="emit('close')"
          >
            <Icon name="close" />
          </button>
        </div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="field">
              <label>{{ t("common.name") }}</label>
              <input
                v-model="draft.name"
                class="input"
                data-testid="provider-name"
                :placeholder="t('providers.namePlaceholder')"
              />
            </div>
            <div class="field">
              <label>Base URL</label>
              <input
                v-model="draft.baseURL"
                class="input"
                data-testid="provider-base-url"
                placeholder="https://api.deepseek.com/v1"
              />
            </div>
          </div>

          <div class="field">
            <label>API Key</label>
            <input
              v-model="draft.apiKey"
              class="input"
              type="password"
              autocomplete="new-password"
              :placeholder="keyPlaceholder"
            />
            <div class="hint">
              {{ t("providers.apiKeyNote") }}
            </div>
          </div>

          <!--
            The request headers, added one at a time. No rows is the ordinary state and sends
            nothing of ours: the SDK's own headers go out exactly as they did before this
            feature existed. The select is the whole scope of addition, and it disappears once
            every kind it offers is on the form — an add control with nothing left to add is a
            button that can only do nothing.
          -->
          <div class="headers-head">
            <label>{{ t("providers.requestHeaders") }}</label>
            <select
              v-if="addableKinds.length > 0"
              class="select header-add"
              data-testid="provider-header-add"
              :value="''"
              @change="addHeader"
            >
              <option value="">{{ t("providers.addHeader") }}</option>
              <option v-for="kind in addableKinds" :key="kind" :value="kind">
                {{ headerLabel(kind) }}
              </option>
            </select>
          </div>
          <div class="headers-hint">{{ t("providers.requestHeadersHint") }}</div>

          <div v-for="(h, i) in draft.headers" :key="h.kind" class="header-row">
            <div class="field">
              <label>{{ headerLabel(h.kind) }}</label>
              <input
                v-model="h.value"
                class="input"
                :data-testid="
                  h.kind === 'user-agent' ? 'provider-user-agent' : 'provider-session-header'
                "
                :placeholder="h.kind === 'user-agent' ? DEFAULT_PROVIDER_USER_AGENT : undefined"
              />
              <div class="hint" :class="{ warn: !headerValid(h) }">{{ headerHint(h) }}</div>
            </div>
            <button
              class="icon-btn danger header-remove"
              data-testid="provider-header-remove"
              :title="t('providers.removeHeader')"
              :aria-label="t('providers.removeHeader')"
              @click="removeHeader(i)"
            >
              <Icon name="close" />
            </button>
          </div>

          <div class="models-head">
            <label>{{ t("providers.models") }}</label>
            <button class="btn small" @click="addModel">
              <Icon name="plus" /> {{ t("providers.addModel") }}
            </button>
          </div>
          <div class="models-hint">
            {{ t("providers.modelNoteBefore") }}<strong>{{ t("providers.modelNoteToken") }}</strong
            >{{ t("providers.modelNoteAfter", { fallback: DEFAULT_CONTEXT_WINDOW.toLocaleString() }) }}
          </div>

          <div v-for="(m, i) in draft.models" :key="i" class="model-row">
            <div class="model-main">
              <div class="field">
                <label>{{ t("providers.modelId") }}</label>
                <input v-model="m.modelId" class="input" data-testid="model-id" placeholder="gpt-4o-mini" />
              </div>
              <div class="field">
                <label>{{ t("providers.displayName") }}</label>
                <input v-model="m.name" class="input" :placeholder="t('providers.displayNamePlaceholder')" />
              </div>
              <div class="field narrow-field">
                <label>{{ t("providers.contextLength") }}</label>
                <input v-model="m.contextWindow" class="input" placeholder="128000" />
                <div class="hint" :class="{ warn: contextLooksWrong(m) }">
                  {{ contextLooksWrong(m) ? t("providers.contextWrong") : t("providers.unitToken") }}
                </div>
              </div>
              <div class="field narrow-field">
                <label>{{ t("providers.maxOutput") }}</label>
                <input v-model="m.maxOutput" class="input" :placeholder="t('providers.optional')" />
                <div class="hint">{{ t("providers.unitToken") }}</div>
              </div>
              <button
                class="icon-btn danger"
                :title="t('providers.removeModel')"
                :aria-label="t('providers.removeModel')"
                @click="removeModel(i)"
              >
                <Icon name="close" />
              </button>
            </div>
            <div class="caps">
              <label v-for="c in CAPABILITIES" :key="c.id" class="check-row sm">
                <input
                  type="checkbox"
                  :checked="m.capabilities.includes(c.id)"
                  @change="toggleCapability(m, c.id)"
                />
                {{ t("providers.capabilities." + c.id) }}
              </label>
            </div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn" @click="emit('close')">{{ t("common.cancel") }}</button>
          <button
            class="btn primary"
            data-testid="provider-save"
            :disabled="!canSave"
            @click="save"
          >
            {{ t("common.save") }}
          </button>
        </div>
      </div>
    </div>

  </Teleport>
</template>

<style scoped>
.models-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: var(--space-2) 0 var(--space-4);
  color: var(--text-2);
  font-size: var(--fs-3);
}
.model-row {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: var(--space-5) var(--space-6) var(--space-2);
  margin-bottom: var(--space-5);
  background: var(--panel-2);
}
.model-main {
  display: flex;
  align-items: flex-start;
  gap: var(--space-4);
}
.model-main .field {
  flex: 1;
  min-width: 0;
}
.model-main .narrow-field {
  flex: 0 0 124px;
}
.models-hint {
  font-size: var(--fs-2);
  color: var(--text-3);
  margin-bottom: var(--space-5);
  line-height: var(--lh-base);
}
.hint.warn,
.model-main .hint.warn {
  color: var(--warning);
}
.models-hint strong {
  color: var(--text-2);
}
.model-main .icon-btn {
  margin-top: var(--space-9);
}
.headers-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: var(--space-2) 0 var(--space-3);
  color: var(--text-2);
  font-size: var(--fs-3);
}
.header-add {
  width: auto;
}
.headers-hint {
  font-size: var(--fs-2);
  color: var(--text-3);
  margin-bottom: var(--space-4);
  line-height: var(--lh-base);
}
.header-row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-4);
}
.header-row .field {
  flex: 1;
  min-width: 0;
}
.header-row .header-remove {
  margin-top: var(--space-9);
}
/*
 * The model row is a flex line — a name field, a narrow context-window field and a delete
 * button. At phone width it wraps, and the fields take the full line rather than each other's
 * space. The icon button's top offset only made sense against the two-column alignment.
 */
@media (max-width: 560px) {
  .model-main {
    flex-wrap: wrap;
  }
  .model-main .narrow-field {
    flex: 1 1 auto;
  }
  .model-main .icon-btn {
    margin-top: 0;
  }
}
.caps {
  display: flex;
  gap: var(--space-7);
  padding-bottom: var(--space-3);
}
</style>
