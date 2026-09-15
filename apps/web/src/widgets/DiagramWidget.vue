<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "../api/client";
import { openSessionFiles } from "../composables/ui";
import { relativeTime } from "../composables/relativeTime";
import { useAppStore } from "../stores/app";
import { emitWidgetEvent, subscribeWidgetEvents } from "../composables/widgetEvents";
import type { Diagram } from "../api/types";
import Icon from "../components/Icon.vue";

/**
 * The conversation's diagrams, as rows.
 *
 * A **viewer** that brings no tools. Its data is the `session_diagrams` rows `ila_diagram`
 * writes beside each file — name, the model's summary, the call that drew it, and the
 * thread it belongs to. This is deliberately NOT the folder listing: the conversation-files
 * dialog is that, and a `.mmd` copied into the folder by hand has no summary and no call, so
 * it belongs there rather than on this list.
 *
 * Opening a row goes through the ordinary file preview (the row's `name` is the canonical
 * file name), the same one the file tree and the session-files dialog open — it already
 * renders a diagram and offers the enlarged viewer. The one thing this panel adds is
 * 定位, scrolling the conversation to the call; the row carries that id, so there is no
 * client-side join.
 */

const { t } = useI18n();
const store = useAppStore();

const rows = ref<Diagram[]>([]);
const failed = ref(false);

async function load(): Promise<void> {
  const sessionId = store.activeSessionId;
  if (!sessionId) {
    rows.value = [];
    failed.value = false;
    return;
  }
  try {
    const res = await api.listSessionDiagrams(sessionId);
    // A switch mid-request must not list one conversation's diagrams under another's.
    if (sessionId !== store.activeSessionId) return;
    rows.value = res.diagrams;
    failed.value = false;
  } catch {
    if (sessionId !== store.activeSessionId) return;
    failed.value = true;
  }
}

watch(
  () => store.activeSessionId,
  () => {
    rows.value = [];
    failed.value = false;
    void load();
  },
  { immediate: true }
);

let unsubscribe: (() => void) | null = null;
onMounted(() => {
  unsubscribe = subscribeWidgetEvents((event) => {
    // The row is written by the tool mid-turn, so `diagram.changed` refreshes immediately;
    // `turn.finished` catches a diagram a later step drew. Its thread title arrives with the
    // best-effort classifier after that, and shows on the next load.
    if (event.type === "diagram.changed" || event.type === "turn.finished") {
      if (event.sessionId === store.activeSessionId) void load();
    }
  });
});
onBeforeUnmount(() => {
  unsubscribe?.();
  unsubscribe = null;
});

/** `flow.mmd` → `flow`. The extension is the one thing every row shares. */
function stem(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}
</script>

<template>
  <div class="diagram-widget" data-testid="widget-diagram">
    <div v-if="!store.activeSession" class="widget-empty">
      {{ t("widgets.diagram.noSession") }}
    </div>

    <div v-else-if="failed" class="widget-error">
      <span>{{ t("widgets.diagram.failed") }}</span>
      <button class="btn small" data-testid="widget-retry" @click="load">
        {{ t("widgets.retry") }}
      </button>
    </div>

    <template v-else>
      <!-- The whole folder, not just the rows: this is the filtered, model-drawn view. -->
      <div class="diagram-toolbar">
        <button class="btn small" data-testid="diagram-browse" @click="openSessionFiles">
          {{ t("widgets.diagram.browse") }}
        </button>
      </div>

      <div v-if="rows.length === 0" class="widget-empty" data-testid="diagram-empty">
        {{ t("widgets.diagram.empty") }}
      </div>

      <ul v-else class="diagram-list" data-testid="diagram-list">
        <li v-for="row in rows" :key="row.id" class="diagram-row">
          <button
            class="diagram-open"
            :class="{ 'is-missing': row.fileMissing }"
            data-testid="diagram-row"
            type="button"
            :disabled="row.fileMissing"
            :title="row.name"
            @click="store.openFile(row.name, 'session')"
          >
            <span class="diagram-icon"><Icon name="diagram" /></span>
            <span class="diagram-meta">
              <span class="diagram-name truncate">{{ stem(row.name) }}</span>
              <span class="diagram-summary">{{ row.summary }}</span>
              <span class="diagram-when">
                <span>{{ relativeTime(row.updatedAt) }}</span>
                <span v-if="row.threadTitle" class="diagram-thread">
                  · {{ t("widgets.diagram.inThread", { title: row.threadTitle }) }}
                </span>
                <span v-if="row.fileMissing" class="diagram-missing">
                  · {{ t("widgets.diagram.missing") }}
                </span>
              </span>
            </span>
          </button>
          <button
            v-if="row.toolCallId"
            class="icon-btn diagram-locate"
            data-testid="diagram-locate"
            :title="t('widgets.diagram.locate')"
            :aria-label="t('widgets.diagram.locate')"
            @click="emitWidgetEvent({ type: 'chat.jump', toolCallId: row.toolCallId! })"
          >
            <Icon name="target" />
          </button>
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.diagram-widget {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.diagram-toolbar {
  display: flex;
  justify-content: flex-end;
  padding-bottom: var(--space-3);
}
.diagram-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.diagram-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.diagram-open {
  display: flex;
  flex: 1;
  align-items: flex-start;
  gap: var(--space-3);
  min-width: 0;
  padding: var(--space-2) var(--space-3);
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
}
.diagram-open:disabled {
  /* The "missing" text carries the disabled state; keep the row readable. */
  opacity: 1;
}
.diagram-open:not(.is-missing) {
  cursor: pointer;
}
.diagram-open:not(.is-missing):hover {
  background: var(--panel-2);
}
.diagram-icon {
  display: flex;
  flex: none;
  margin-top: 1px;
  color: var(--accent);
}
.diagram-meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: var(--space-1);
}
.diagram-name {
  color: var(--text);
}
.diagram-summary {
  color: var(--text-2);
  font-size: var(--fs-2);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.diagram-when {
  display: flex;
  flex-wrap: wrap;
  gap: 0 var(--space-2);
  color: var(--text-3);
  font-size: var(--fs-2);
}
.diagram-missing {
  color: var(--danger-text);
}
.diagram-locate {
  flex: none;
}
</style>
