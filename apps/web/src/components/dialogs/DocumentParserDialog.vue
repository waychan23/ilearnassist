<script setup lang="ts">
import { computed, reactive, watch } from "vue";
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
  props.parser?.hasApiKey ? "已配置（留空则不修改）" : keyRequired.value ? "必填" : "可留空"
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
        <h3>{{ props.parser ? "编辑解析服务" : "新建解析服务" }}</h3>
        <button class="icon-btn" @click="emit('close')">✕</button>
      </div>
      <div class="modal-body">
        <div class="field">
          <label>协议类型</label>
          <select v-model="draft.kind" class="input" data-testid="parser-kind">
            <option v-for="k in props.kinds" :key="k.kind" :value="k.kind">{{ k.label }}</option>
          </select>
          <div class="hint">
            协议决定怎么跟服务通信，端点与密钥由下面的字段决定。同一个协议可以建多条记录
            （例如 MinerU 云端与自建各一条）。
          </div>
        </div>

        <div class="field">
          <label>名称</label>
          <input v-model="draft.name" class="input" placeholder="例如：Docling（本机）" />
        </div>

        <div class="field">
          <label>Base URL</label>
          <input
            v-model="draft.baseURL"
            class="input"
            :placeholder="selectedKind?.defaultBaseURL ?? 'http://127.0.0.1:5001/v1/convert/file'"
          />
          <div class="hint" v-if="selectedKind?.helpURL">
            端点需要与所选协议匹配。申请凭据：<a
              :href="selectedKind.helpURL"
              target="_blank"
              rel="noreferrer"
              >{{ selectedKind.helpURL }}</a
            >
          </div>
        </div>

        <div class="field">
          <label>API Key {{ keyRequired ? "" : "（可选）" }}</label>
          <input
            v-model="draft.apiKey"
            class="input"
            type="password"
            autocomplete="new-password"
            :placeholder="keyPlaceholder"
            data-testid="parser-api-key"
          />
          <div class="hint">
            出于安全考虑，服务端不会返回 Key 的内容。留空表示保持原值不变。
          </div>
        </div>

        <div class="field">
          <label class="check">
            <input v-model="draft.enabled" type="checkbox" />
            启用（关闭后解析时会跳过这一条）
          </label>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn" @click="emit('close')">取消</button>
        <button class="btn primary" :disabled="!canSave" @click="save" data-testid="parser-save">
          保存
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.field {
  margin-bottom: 14px;
}
.check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-2);
  cursor: pointer;
}
.hint a {
  color: var(--accent);
  word-break: break-all;
}
</style>
