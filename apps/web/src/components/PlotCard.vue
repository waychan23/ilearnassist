<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { ToolCall } from "../api/types";
import { canAnnotate, objectNoteRequest } from "../composables/notes";
import { requestNoteEditor } from "../composables/messageNotes";
import { useAppStore } from "../stores/app";
import PlotFigure from "./PlotFigure.vue";
import DiagramDialog from "./dialogs/DiagramDialog.vue";
import Icon from "./Icon.vue";

/**
 * `ila_plot`'s call, as a figure.
 *
 * `DiagramCard`'s twin, and it stays a card for the diagram's reason: the *drawing* is the
 * result, so the tool's own arguments are the wrong thing to show. It is not one of the
 * interactive cards and must never join `INTERACTIVE_TOOL_NAMES` — that list means "suspends the
 * turn", and this one does not — so it gets its own dispatch in `ToolCallCard` beside the
 * diagram's.
 *
 * Everything the card needs is in the call's own arguments, which `loop.ts` persists verbatim:
 * a reload replays the figure with no fetch and no row to keep in step with it.
 */

const props = defineProps<{ toolCall: ToolCall }>();

const { t, te } = useI18n();
const store = useAppStore();

/** The shared `tools.name.*` namespace, resolved the same way the generic card does. */
const label = computed(() => {
  const key = "tools.name." + props.toolCall.name;
  return te(key) ? t(key) : props.toolCall.name;
});

const done = computed(() => props.toolCall.output !== undefined);

/** The call's arguments, parsed once. Malformed JSON renders as nothing rather than throwing. */
const args = computed<{ name?: unknown; spec?: unknown; summary?: unknown }>(() => {
  try {
    return JSON.parse(props.toolCall.input) as {
      name?: unknown;
      spec?: unknown;
      summary?: unknown;
    };
  } catch {
    return {};
  }
});

const name = computed(() => (typeof args.value.name === "string" ? args.value.name : ""));
/** The spec as text: pretty-printed for the disclosure, and what the renderer parses back. */
const spec = computed(() =>
  args.value.spec === undefined ? "" : JSON.stringify(args.value.spec, null, 2)
);
const summary = computed(() =>
  typeof args.value.summary === "string" ? args.value.summary : ""
);

/** The tool refused the call (an invalid spec, an over-size one): show its own sentence. */
const failed = computed(() => (props.toolCall.output ?? "").startsWith("Tool error:"));

/** The spec disclosure. Closed by default: the drawing is what this card is for. */
const open = ref(false);
const viewing = ref(false);

/**
 * Ask about the figure this call drew.
 *
 * The name comes from the call's own arguments, passed **raw**, because the server normalises it
 * with `plotName` — the same function the writer used — so the model's spelling and the canonical
 * row name are one reference and this card does not have to know which it holds.
 */
function askAbout(): void {
  if (!name.value) return;
  store.stageReference({ kind: "plot", ref: name.value, label: name.value });
}

/** Write a note about the figure, from the call's own arguments — nothing is fetched. */
function noteAbout(): void {
  if (!name.value) return;
  const request = objectNoteRequest({
    kind: "plot",
    ref: name.value,
    label: name.value,
    summary: summary.value,
  });
  if (request) requestNoteEditor(request);
}
</script>

<template>
  <div class="plot-card" data-testid="plot-card" :data-tool-call-id="toolCall.id">
    <div class="plot-head" data-testid="plot-head" @click="open = !open">
      <Icon name="plot" class="mark" />
      <span class="name">{{ label }}</span>
      <span class="file truncate" :title="name">{{ name }}</span>
      <span class="status">{{ done ? t("tools.done") : t("tools.running") }}</span>
      <button
        v-if="!failed"
        class="icon-btn expand"
        data-testid="plot-expand"
        :title="t('diagram.expand')"
        :aria-label="t('diagram.expand')"
        @click.stop="viewing = true"
      >
        <Icon name="expand" />
      </button>
      <button
        v-if="!failed"
        class="icon-btn ask"
        data-testid="plot-ask"
        :title="t('turnRef.ask')"
        :aria-label="t('turnRef.ask')"
        @click.stop="askAbout"
      >
        <Icon name="link" />
      </button>
      <button
        v-if="!failed && canAnnotate"
        class="icon-btn note"
        data-testid="plot-note"
        :title="t('notes.annotate')"
        :aria-label="t('notes.annotate')"
        @click.stop="noteAbout"
      >
        <Icon name="marker" />
      </button>
      <Icon class="toggle" :name="open ? 'caret-down' : 'caret-right'" />
    </div>

    <div v-if="failed" class="plot-failed" data-testid="plot-failure">
      {{ props.toolCall.output }}
    </div>

    <template v-else>
      <!-- A bounded window onto the figure; the viewer is one click away for the whole thing. -->
      <div class="plot-window" data-testid="plot-window">
        <PlotFigure :spec="spec" />
      </div>

      <div v-if="open" class="plot-source">
        <div class="key">{{ t("diagram.source") }}</div>
        <pre><code>{{ spec }}</code></pre>
      </div>
    </template>

    <DiagramDialog
      v-if="viewing"
      :figure="name ? { kind: 'plot', ref: name, label: name } : undefined"
      :content="{ kind: 'plot', spec }"
      :name="name"
      :summary="summary"
      @close="viewing = false"
    />
  </div>
</template>

<style scoped>
.plot-card {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel);
  margin-bottom: var(--space-4);
  overflow: hidden;
}
.plot-head {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-5);
  cursor: pointer;
  color: var(--text-2);
  font-size: var(--fs-3);
}
.plot-head .mark {
  color: var(--accent);
  flex-shrink: 0;
}
.name {
  color: var(--text);
  font-weight: 500;
  white-space: nowrap;
}
.file {
  flex: 1;
  color: var(--text-3);
}
.status {
  font-size: var(--fs-2);
  white-space: nowrap;
}
.expand,
.ask,
.note,
.toggle {
  flex-shrink: 0;
}
.plot-window {
  border-top: 1px solid var(--border);
  padding: var(--space-4);
  max-height: 24rem;
  overflow: auto;
}
.plot-failed {
  border-top: 1px solid var(--border);
  padding: var(--space-5);
  color: var(--danger-text);
  font-size: var(--fs-2);
}
.plot-source {
  border-top: 1px solid var(--border);
  padding: var(--space-5);
}
.plot-source .key {
  color: var(--text-3);
  font-size: var(--fs-2);
  margin-bottom: var(--space-1);
}
.plot-source pre {
  background: var(--code-bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: var(--space-4);
  margin: 0;
  overflow-x: auto;
  font-size: var(--fs-2);
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--code-fg-2);
}
</style>
