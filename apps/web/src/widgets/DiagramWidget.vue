<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "../api/client";
import { relativeTime } from "../composables/relativeTime";
import { useAppStore } from "../stores/app";
import { emitWidgetEvent, subscribeWidgetEvents } from "../composables/widgetEvents";
import { requestNoteEditor } from "../composables/messageNotes";
import { canAnnotate, objectNoteRequest } from "../composables/notes";
import { figureReference } from "../utils/turnRefs";
import type { Diagram, Table } from "../api/types";
import {
  FIGURE_FILTERS,
  filterFigures,
  figureRows,
  presentKinds,
  type FigureFilter,
  type FigureKind,
  type FigureRow,
} from "../utils/figures";
import DiagramDialog from "../components/dialogs/DiagramDialog.vue";
import Icon from "../components/Icon.vue";

/**
 * The conversation's 图表: the diagrams it has drawn and the tables it has recorded, as rows.
 *
 * A **viewer** that brings no tools. Its data is the rows the two tools write — `ila_diagram`
 * writes a file plus a `session_diagrams` row, `ila_table` writes a `session_tables` row that
 * *is* the table. This is deliberately NOT a folder listing: the source browser is that, and a
 * `.mmd` copied into the folder by hand has no summary and no call, so it belongs there rather
 * than on this list.
 *
 * **Two kinds, two ways in, and the difference is not an inconsistency.** A diagram's row names a
 * file, so opening it goes through the ordinary preview — which already renders a diagram, offers
 * the source and has the enlarged view — exactly as the file tree opens it. A table has no file:
 * its row holds the markdown, so opening it hands that straight to the same enlarged viewer, with
 * no request and nothing for a preview to read. What both rows carry is 定位: the call that
 * produced them, which scrolls the conversation back to it.
 *
 * There is deliberately no "browse the whole folder" control here. This panel is the *filtered,
 * model-made* view, and the workspace's material is one control away in the sidebar's menu — a
 * second entry point to the same files, from a panel, was a duplicate rather than a shortcut.
 */

const { t } = useI18n();
const store = useAppStore();

const diagrams = ref<Diagram[]>([]);
const tables = ref<Table[]>([]);
const failed = ref(false);
const filter = ref<FigureFilter>("");
/** The table this panel is showing enlarged, if any. A diagram opens the file preview instead. */
const viewing = ref<FigureRow | null>(null);

const rows = computed(() => figureRows(diagrams.value, tables.value));
const visible = computed(() => filterFigures(rows.value, filter.value));
const kinds = computed(() => presentKinds(rows.value));

async function load(): Promise<void> {
  const sessionId = store.activeSessionId;
  if (!sessionId) {
    diagrams.value = [];
    tables.value = [];
    failed.value = false;
    return;
  }
  try {
    /*
     * Both reads at once, because the panel shows one list: two sequential requests would be two
     * loading states for one screen, and the second would be waiting on nothing.
     *
     * A conversation can hold one kind and not the other, so neither empty answer is an error —
     * the panel's empty state is "this conversation has made nothing", which is the two lists
     * being empty together.
     */
    const [drawn, recorded] = await Promise.all([
      api.listSessionDiagrams(sessionId),
      api.listSessionTables(sessionId),
    ]);
    // A switch mid-request must not list one conversation's figures under another's.
    if (sessionId !== store.activeSessionId) return;
    diagrams.value = drawn.diagrams;
    tables.value = recorded.tables;
    failed.value = false;
  } catch {
    if (sessionId !== store.activeSessionId) return;
    failed.value = true;
  }
}

watch(
  () => store.activeSessionId,
  () => {
    diagrams.value = [];
    tables.value = [];
    failed.value = false;
    viewing.value = null;
    void load();
  },
  { immediate: true }
);

let unsubscribe: (() => void) | null = null;
onMounted(() => {
  unsubscribe = subscribeWidgetEvents((event) => {
    // The rows are written by the tools mid-turn, so their own events refresh immediately;
    // `turn.finished` catches one a later step wrote. A thread title arrives with the best-effort
    // classifier after that, and shows on the next load.
    if (event.type === "diagram.changed" || event.type === "table.changed" || event.type === "turn.finished") {
      if (event.sessionId === store.activeSessionId) void load();
    }
  });
});
onBeforeUnmount(() => {
  unsubscribe?.();
  unsubscribe = null;
});

/**
 * What a kind is called in the filter's own menu.
 *
 * A `switch` over the closed union with a literal key per case, rather than
 * `` t(`widgets.diagram.kinds.${kind}`) `` — the choice `widgetLabel` in the widget registry and
 * `formatLabel` in the figure viewer both make, and for the same reason: a template literal would
 * force a bare `widgets.diagram.kinds.` entry into `catalog.test.ts`'s allowlist of dynamic
 * prefixes, and a prefix that broad is where a typo hides.
 */
function kindLabel(kind: FigureKind): string {
  switch (kind) {
    case "diagram":
      return t("widgets.diagram.kinds.diagram");
    case "table":
      return t("widgets.diagram.kinds.table");
  }
}

/** Open a row: a diagram through the file preview, a table through the viewer. */
function openRow(row: FigureRow): void {
  if (row.kind === "diagram") {
    if (row.fileName && !row.fileMissing) void store.openFile(row.fileName, "session");
    return;
  }
  viewing.value = row;
}

/**
 * Whether a note can be written here at all.
 *
 * The notes panel is what owns notes-as-records, and it announces itself through the message
 * list's claim — so a conversation that never installed it has nothing to file a note into, and
 * this button is not drawn rather than drawn and refused. `canAnnotate` is the same gate the
 * message list uses for its own marking-up, which is what keeps the two from disagreeing about
 * whether notes exist in this conversation.
 */
const canNote = canAnnotate;

/**
 * Write a note about this figure.
 *
 * The request is built by `notes.ts` and shown by the message list's host, which is the same
 * window, the same save path and the same writability as a note made from a selection — this
 * panel knows only which figure the reader pointed at and where they pointed at it. A figure
 * whose file is missing is still offered: the note is *about the figure*, and the figure's row
 * is what both the note and the chip need — the file it cannot render is a separate problem the
 * row already reports.
 */
function noteAbout(row: FigureRow, event: MouseEvent): void {
  const ref = row.fileName ?? row.name;
  const rect = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect();
  const request = objectNoteRequest(
    // The row's summary travels as the 标注原文 — the same sentence the panel draws, so the note
    // and the row it came from cannot describe the figure differently.
    { kind: row.kind, ref, label: row.name, summary: row.summary },
    rect ? { x: rect.right, y: rect.top + rect.height / 2 } : null
  );
  if (request) requestNoteEditor(request);
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
      <!--
        The strip appears only once there is something to narrow, and it offers only the kinds
        that are there: an option that can only ever produce the empty state is a control that
        does nothing. The count is the same one `ResourcesWidget` carries, for the same reason —
        it is what makes a filter honest about what it is hiding.
      -->
      <div v-if="rows.length > 0 && kinds.length > 1" class="figure-filter">
        <select
          v-model="filter"
          class="input figure-kind"
          data-testid="figure-filter"
          :aria-label="t('widgets.diagram.filterKind')"
        >
          <option v-for="option in FIGURE_FILTERS" :key="option" :value="option">
            {{ option === "" ? t("widgets.diagram.allKinds") : kindLabel(option) }}
          </option>
        </select>
        <span class="badge muted" data-testid="figure-count">{{ visible.length }}</span>
      </div>

      <div v-if="rows.length === 0" class="widget-empty" data-testid="diagram-empty">
        {{ t("widgets.diagram.empty") }}
      </div>
      <!-- A filter that matches nothing is a different sentence from a list that is empty. -->
      <div v-else-if="visible.length === 0" class="widget-empty" data-testid="figure-no-match">
        {{ t("widgets.diagram.noMatch") }}
      </div>

      <ul v-else class="diagram-list" data-testid="diagram-list">
        <li v-for="row in visible" :key="row.key" class="diagram-row" :data-kind="row.kind">
          <button
            class="diagram-open"
            :class="{ 'is-missing': row.fileMissing }"
            data-testid="diagram-row"
            type="button"
            :disabled="row.fileMissing"
            :title="row.fileName ?? row.name"
            @click="openRow(row)"
          >
            <span class="diagram-icon">
              <Icon :name="row.kind === 'diagram' ? 'diagram' : 'table'" />
            </span>
            <span class="diagram-meta">
              <span class="diagram-name truncate">{{ row.name }}</span>
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
          <!--
            Asking about a figure. Offered in every conversation, unlike the note control below
            it: a reference to a figure is resolved by the agent's own tools, so it needs no
            panel to hold it — the chip is the whole of the state.
          -->
          <button
            class="icon-btn diagram-ask"
            data-testid="diagram-row-ask"
            :title="t('turnRef.ask')"
            :aria-label="t('turnRef.ask')"
            @click="store.stageReference(figureReference(row))"
          >
            <Icon name="link" />
          </button>
          <!--
            Writing a note about a figure, a sibling of the locate button rather than part of the
            row button: one opens the figure, the other files something about it, and neither
            modifies the other. Not drawn where notes have no home — see `canNote`.
          -->
          <button
            v-if="canNote"
            class="icon-btn diagram-note"
            data-testid="diagram-note"
            :title="t('widgets.diagram.note')"
            :aria-label="t('widgets.diagram.note')"
            @click="noteAbout(row, $event)"
          >
            <Icon name="note" />
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

    <!-- The table's own viewer, at panel level rather than per row: one dialog, and the row it
         shows is a value rather than a position. A diagram has no equivalent here — it opens the
         file preview, which is the same dialog the file tree uses. -->
    <DiagramDialog
      v-if="viewing?.content"
      :content="{ kind: 'table', markdown: viewing.content }"
      :name="viewing.name"
      :summary="viewing.summary"
      :figure="figureReference(viewing)"
      @close="viewing = null"
    />
  </div>
</template>

<style scoped>
.diagram-widget {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.figure-filter {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: 0 0 var(--space-3);
}
.figure-kind {
  flex: 1;
  min-width: 0;
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
/* A table's mark is the other half of the panel's idea, so it is the quieter of the two — the
   drawing is the thing the panel was built for and the table is what joined it. */
.diagram-row[data-kind="table"] .diagram-icon {
  color: var(--text-3);
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
.diagram-locate,
.diagram-note,
.diagram-ask {
  flex: none;
}
</style>
