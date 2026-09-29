<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { useAppStore } from "../../stores/app";
import { confirm } from "../../composables/confirm";
import { relativeTime } from "../../composables/relativeTime";
import Icon from "../Icon.vue";

/**
 * What the next turn will actually send, and the two writes that change it.
 *
 * The requirement's "preview" and "restore" live here together because they are the same
 * question seen twice: the dialog shows which context is in force — the full history, or a
 * summary plus the messages after its point — and the restore control is only meaningful
 * beside the summary it would replace. Compression is offered here too, so the dialog is
 * self-sufficient once the reader is in it.
 */
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();
const store = useAppStore();

const state = computed(() => store.contextState);
const summary = computed(() => state.value?.summary ?? null);

/**
 * Refresh on open rather than trusting what was loaded with the conversation.
 *
 * Another client may have compressed or restored since — the point of the preview is to say
 * what is in force *now*. A failure is swallowed: the dialog keeps showing the last state it
 * had, and a read that failed is not a write the reader needs warned about.
 */
onMounted(() => {
  void store.loadContextState().catch(() => undefined);
});

const compactable = computed(
  () => (state.value?.totalMessages ?? 0) > 0 && !store.hasPendingQuestion
);

async function runCompact(): Promise<void> {
  const ok = await confirm({
    title: t("context.compact"),
    message: t("context.compactConfirm", { count: state.value?.totalMessages ?? 0 }),
    detail: t("context.compactConfirmDetail"),
    confirmText: t("context.compact"),
  });
  if (ok) await store.compactContext();
}

async function runRestore(): Promise<void> {
  const ok = await confirm({
    title: t("context.restore"),
    message: t("context.restoreConfirm"),
    detail: t("context.restoreConfirmDetail"),
    confirmText: t("context.restore"),
  });
  if (ok) await store.restoreContext();
}
</script>

<template>
  <Teleport to="body">
    <div class="modal-overlay" @click.self="emit('close')">
      <div class="modal" data-testid="context-preview">
        <div class="modal-head">
          <h3>{{ t("context.title") }}</h3>
          <button
            class="icon-btn"
            :title="t('common.close')"
            :aria-label="t('common.close')"
            data-testid="context-preview-close"
            @click="emit('close')"
          >
            <Icon name="close" />
          </button>
        </div>
        <div class="modal-body">
          <div v-if="!state" class="hint">{{ t("context.loading") }}</div>

          <template v-else>
            <div class="row mode" data-testid="context-preview-mode">
              <span>{{ t("context.modeLabel") }}</span>
              <span class="value" :class="{ compacted: summary }">
                {{ summary ? t("context.modeCompacted") : t("context.modeFull") }}
              </span>
            </div>
            <div class="hint">
              {{
                summary
                  ? t("context.compactedNote", { count: state.tailMessages })
                  : t("context.fullNote", { count: state.totalMessages })
              }}
            </div>

            <template v-if="summary">
              <div class="row">
                <span>{{ t("context.covered") }}</span>
                <span class="value">{{ t("context.coveredValue", { count: summary.messageCount }) }}</span>
              </div>
              <div class="row">
                <span>{{ t("context.through") }}</span>
                <span class="value">{{ relativeTime(summary.throughCreatedAt) }}</span>
              </div>
              <div class="row">
                <span>{{ t("context.compactedAt") }}</span>
                <span class="value">{{ relativeTime(summary.createdAt) }}</span>
              </div>

              <div class="summary-label">{{ t("context.summary") }}</div>
              <!-- Plain text rather than rendered markdown: this is a stored record the
                   reader is inspecting, and rendering it would make it look like a reply. -->
              <pre class="summary-text" data-testid="context-preview-summary">{{ summary.content }}</pre>
            </template>
            <div v-else-if="state.totalMessages === 0" class="hint" data-testid="context-preview-empty">
              {{ t("context.empty") }}
            </div>

            <!-- The one state compression cannot cross: a card waiting on an answer lives on
                 the last message, which is where the point would land. -->
            <div v-if="store.hasPendingQuestion" class="hint pending" data-testid="context-pending">
              {{ t("context.pendingQuestion") }}
            </div>
          </template>
        </div>
        <div class="modal-foot">
          <button
            v-if="compactable"
            class="btn primary"
            :disabled="store.compacting || store.streaming.active"
            data-testid="context-preview-compact"
            @click="runCompact"
          >
            <Icon v-if="store.compacting" name="sync" class="spin" />
            {{ store.compacting ? t("context.compacting") : t("context.compact") }}
          </button>
          <button
            v-if="summary"
            class="btn"
            :disabled="store.compacting"
            data-testid="context-preview-restore"
            @click="runRestore"
          >
            {{ t("context.restore") }}
          </button>
          <button class="btn" data-testid="context-preview-done" @click="emit('close')">
            {{ t("common.close") }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.row {
  display: flex;
  justify-content: space-between;
  gap: var(--space-6);
  padding: var(--space-2) 0;
  color: var(--text-3);
}
.row .value {
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
.row.mode {
  color: var(--text);
  padding-top: var(--space-4);
}
.row.mode .value {
  color: var(--text);
  font-weight: 600;
}
.row.mode .value.compacted {
  color: var(--accent);
}
.summary-label {
  margin-top: var(--space-6);
  color: var(--text-3);
  font-size: var(--fs-1);
}
.hint.pending {
  margin-top: var(--space-5);
  color: var(--warning);
}
.summary-text {
  margin: var(--space-3) 0 0;
  padding: var(--space-5);
  max-height: 40vh;
  overflow: auto;
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text-2);
  font-family: inherit;
  font-size: var(--fs-2);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
/* An action in flight: the icon turns rather than the button disappearing. The `spin`
   keyframes are the global ones the tool cards use. */
.spin {
  animation: spin 1s linear infinite;
}
</style>
