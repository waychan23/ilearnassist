<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "../api/client";
import { openSessionFiles } from "../composables/ui";
import { relativeTime } from "../composables/relativeTime";
import { useAppStore } from "../stores/app";
import { emitWidgetEvent, subscribeWidgetEvents } from "../composables/widgetEvents";
import { isDiagramFile, type FileEntry } from "../api/types";
import { diagramAnchors } from "../utils/diagramAnchors";
import Icon from "../components/Icon.vue";

/**
 * The conversation's diagrams, as a list.
 *
 * A **viewer**, with no tools and no records of its own. What it lists is the conversation's
 * own directory on disk — the `.mmd` files `ila_diagram` writes — read one level through the
 * same route the session file browser uses. There is no diagram table: the file *is* the
 * record, so a `.mmd` somebody dropped in by hand appears here exactly like one the model
 * drew, and a diagram revised in place does not leave a second row behind.
 *
 * Opening a row goes through the ordinary file preview, the same one the file tree and the
 * session file browser open. That is not a shortcut: the preview already renders a diagram,
 * already has the source toggle, already reports its own load failures, and already offers the
 * enlarged viewer. A dialog of this widget's own would be a fourth surface drawing the same
 * picture.
 *
 * The one thing the list adds over the folder is 定位 — the button that scrolls the
 * conversation back to the tool call that drew a diagram. It exists only where there *is* such
 * a call: the map is built from the conversation's own messages, so a file nobody drew here
 * simply has no button rather than one that goes nowhere.
 */

const { t } = useI18n();
const store = useAppStore();

const entries = ref<FileEntry[]>([]);
const failed = ref(false);

/**
 * Which files this conversation has a tool call for, and the id of the call. See
 * `utils/diagramAnchors.ts` for the join — it is derived from the messages on screen rather
 * than stored, so there is no third copy of a fact to keep in step.
 */
const anchors = computed(() => diagramAnchors(store.messages));

async function load(): Promise<void> {
  const sessionId = store.activeSessionId;
  if (!sessionId) {
    entries.value = [];
    failed.value = false;
    return;
  }
  try {
    const listing = await api.listSessionFiles(sessionId, "");
    // A switch mid-request must not list one conversation's diagrams under another's name.
    if (sessionId !== store.activeSessionId) return;
    entries.value = listing.entries
      .filter((entry) => entry.type === "file" && isDiagramFile(entry.name))
      // Newest first: with no search and no sorting control, "what did it just draw" is the
      // question this list is opened to answer.
      .sort((a, b) => (b.modifiedAt ?? "").localeCompare(a.modifiedAt ?? ""));
    failed.value = false;
  } catch {
    if (sessionId !== store.activeSessionId) return;
    failed.value = true;
  }
}

watch(
  () => store.activeSessionId,
  () => {
    entries.value = [];
    failed.value = false;
    void load();
  },
  { immediate: true }
);

let unsubscribe: (() => void) | null = null;
onMounted(() => {
  unsubscribe = subscribeWidgetEvents((event) => {
    // The change is on disk, so nothing local knows what the directory now holds: `turn.finished`
    // catches a diagram a later step drew, and `diagram.changed` the one this step did.
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
      <!-- The folder, not just the diagrams in it. The list above is the filtered view; this is
           the way to everything else the conversation has written. -->
      <div class="diagram-toolbar">
        <button class="btn small" data-testid="diagram-browse" @click="openSessionFiles">
          {{ t("widgets.diagram.browse") }}
        </button>
      </div>

      <div v-if="entries.length === 0" class="widget-empty" data-testid="diagram-empty">
        {{ t("widgets.diagram.empty") }}
      </div>

      <ul v-else class="diagram-list" data-testid="diagram-list">
        <li v-for="entry in entries" :key="entry.path" class="diagram-row">
          <!-- Two buttons in a row rather than one with a nested control: a button inside a
               button is not markup a browser will honour, and the second action is not the
               same action. -->
          <button
            class="diagram-open"
            data-testid="diagram-row"
            :title="entry.name"
            @click="store.openFile(entry.path, 'session')"
          >
            <span class="diagram-icon"><Icon name="diagram" /></span>
            <span class="diagram-meta">
              <span class="diagram-name truncate">{{ stem(entry.name) }}</span>
              <span class="diagram-when">
                {{ entry.modifiedAt ? relativeTime(entry.modifiedAt) : "" }}
              </span>
            </span>
          </button>
          <button
            v-if="anchors.get(entry.name)"
            class="icon-btn diagram-locate"
            data-testid="diagram-locate"
            :title="t('widgets.diagram.locate')"
            :aria-label="t('widgets.diagram.locate')"
            @click="emitWidgetEvent({ type: 'chat.jump', toolCallId: anchors.get(entry.name)! })"
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
  gap: var(--space-1);
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
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
  padding: var(--space-2) var(--space-3);
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.diagram-open:hover {
  background: var(--panel-2);
}
.diagram-icon {
  display: flex;
  flex: none;
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
.diagram-when {
  color: var(--text-3);
  font-size: var(--fs-2);
}
.diagram-locate {
  flex: none;
}
</style>
