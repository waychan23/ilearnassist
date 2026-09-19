<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { ToolCall } from "../api/types";
import { canAnnotate, objectNoteRequest } from "../composables/notes";
import { requestNoteEditor } from "../composables/messageNotes";
import { useAppStore } from "../stores/app";
import MermaidDiagram from "./MermaidDiagram.vue";
import DiagramDialog from "./dialogs/DiagramDialog.vue";
import Icon from "./Icon.vue";

/**
 * `ila_diagram`'s call, as a picture.
 *
 * A card of its own rather than a branch of `ToolCallCard`'s generic args-and-result
 * disclosure, because the point of the tool is that the *drawing* is the result: showing the
 * model the source it wrote is what the tool exists to stop being necessary.
 *
 * It is **not** one of the interactive cards, and must never be added to
 * `INTERACTIVE_TOOL_NAMES` to get here. That list means "suspends the turn": the server routes
 * submitted answers by it, and `MessageItem` groups calls by it to put a question below the
 * reply rather than above it. The diagram tool does neither — it is an ordinary tool call, and
 * it gets its own dispatch in `ToolCallCard` beside that one.
 *
 * The source comes out of the call's own arguments, which is why there is nothing to fetch:
 * `loop.ts` persists a non-suspending tool's `args` verbatim, so a reload replays the diagram
 * from `messages.tool_calls` with no server round trip and no diagram record to keep in step
 * with the file. See `DiagramDialog` for why the enlarged view is a dialog of its own.
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
const args = computed<{ name?: unknown; source?: unknown; summary?: unknown }>(() => {
  try {
    return JSON.parse(props.toolCall.input) as { name?: unknown; source?: unknown; summary?: unknown };
  } catch {
    return {};
  }
});

const fileName = computed(() => (typeof args.value.name === "string" ? args.value.name : ""));
const source = computed(() => (typeof args.value.source === "string" ? args.value.source : ""));
// Free from the call's arguments: the card renders with no fetch, and a reload replays it.
const summary = computed(() =>
  typeof args.value.summary === "string" ? args.value.summary : ""
);

/**
 * Whether the call itself failed.
 *
 * The tool refuses an empty source and one past the cap, and the loop writes both as
 * `Tool error: …` in the output. There is no diagram to draw in that case and no `source`
 * worth showing, so the card shows the model's own refusal — which is the sentence a reader
 * needs, since the alternative is an empty frame where a picture should be.
 */
const failed = computed(() => (props.toolCall.output ?? "").startsWith("Tool error:"));

/** The source disclosure. Closed by default: the drawing is what this card is for. */
const open = ref(false);
const viewing = ref(false);

/**
 * Ask about the diagram this call drew.
 *
 * The name comes from the call's own arguments rather than from a fetch, which is the same reason
 * the card needs no request to render: it is already here. Passed **raw**, because the server
 * normalises it with `diagramFileName` — the same function the writer used — so the model's
 * spelling and the canonical file name are one reference, and this card does not have to know
 * which of the two it is holding.
 */
function askAbout(): void {
  if (!fileName.value) return;
  // The label is the diagram's own name, not the card's `label` — that one names the *tool*
  // ("ila_diagram"), which is not what the chip should say the question is about.
  store.stageReference({ kind: "diagram", ref: fileName.value, label: fileName.value });
}

/**
 * Write a note about the diagram this call drew.
 *
 * Nothing is fetched and nothing is closed, which is the difference from the same button in
 * `DiagramDialog`: the card is *in* the conversation, so the note window floats over a page it is
 * annotating rather than behind an overlay. Everything it needs — the name and the model's own
 * summary — is in the call's arguments, which is why the card renders with no request at all.
 *
 * Passed raw like the reference above, and for the same reason: the server normalises the name
 * with `diagramFileName`, so the model's spelling and the canonical one are one target.
 */
function noteAbout(): void {
  if (!fileName.value) return;
  const request = objectNoteRequest({
    kind: "diagram",
    ref: fileName.value,
    label: fileName.value,
    summary: summary.value,
  });
  if (request) requestNoteEditor(request);
}
</script>

<template>
  <div class="diagram-card" data-testid="diagram-card" :data-tool-call-id="toolCall.id">
    <div class="diagram-head" data-testid="diagram-head" @click="open = !open">
      <Icon name="diagram" class="mark" />
      <span class="name">{{ label }}</span>
      <span class="file truncate" :title="fileName">{{ fileName }}</span>
      <span class="status">{{ done ? t("tools.done") : t("tools.running") }}</span>
      <!-- In the head rather than floating over the picture: an overlay control would sit on
           top of the diagram it is offering to enlarge. `.stop` so it does not also toggle
           the source disclosure underneath it. -->
      <button
        v-if="!failed"
        class="icon-btn expand"
        data-testid="diagram-expand"
        :title="t('diagram.expand')"
        :aria-label="t('diagram.expand')"
        @click.stop="viewing = true"
      >
        <Icon name="expand" />
      </button>
      <!--
        Ask about *this* diagram. In the head for the reason the expand button is, and `.stop` for
        the reason that one is too: the head toggles the source disclosure, and a press aimed at
        this is not a press aimed at that.
      -->
      <button
        v-if="!failed"
        class="icon-btn ask"
        data-testid="diagram-ask"
        :title="t('turnRef.ask')"
        :aria-label="t('turnRef.ask')"
        @click.stop="askAbout"
      >
        <Icon name="link" />
      </button>
      <!-- Beside the ask control, under the same rule the dialog's twin follows: absent rather
           than disabled where no widget would render the window, since a control that does
           nothing reads as broken. -->
      <button
        v-if="!failed && canAnnotate"
        class="icon-btn note"
        data-testid="diagram-note"
        :title="t('notes.annotate')"
        :aria-label="t('notes.annotate')"
        @click.stop="noteAbout"
      >
        <Icon name="marker" />
      </button>
      <Icon class="toggle" :name="open ? 'caret-down' : 'caret-right'" />
    </div>

    <div v-if="failed" class="diagram-failed" data-testid="diagram-failure">
      {{ props.toolCall.output }}
    </div>

    <template v-else>
      <!-- A bounded window onto the drawing. The whole thing is one click away in the viewer,
           which is the difference between a diagram that pushes a reply off the screen and one
           that sits in it. -->
      <div class="diagram-window" data-testid="diagram-window">
        <MermaidDiagram :source="source" />
      </div>

      <div v-if="open" class="diagram-source">
        <div class="key">{{ t("diagram.source") }}</div>
        <pre><code>{{ source }}</code></pre>
      </div>
    </template>

    <DiagramDialog
      v-if="viewing"
      :figure="fileName ? { kind: 'diagram', ref: fileName, label: fileName } : undefined"
      :content="{ kind: 'diagram', source }"
      :name="fileName"
      :summary="summary"
      @close="viewing = false"
    />
  </div>
</template>

<style scoped>
.diagram-card {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel);
  margin-bottom: var(--space-4);
  overflow: hidden;
}
.diagram-head {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-4) var(--space-5);
  cursor: pointer;
  color: var(--text-2);
  font-size: var(--fs-3);
}
.diagram-head .mark {
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
.expand {
  flex-shrink: 0;
}
.toggle {
  flex-shrink: 0;
}
/* The window: as tall as a diagram is worth taking out of a conversation, and no taller. */
.diagram-window {
  border-top: 1px solid var(--border);
  padding: var(--space-4);
  max-height: 24rem;
  overflow: auto;
}
.diagram-failed {
  border-top: 1px solid var(--border);
  padding: var(--space-5);
  color: var(--danger-text);
  font-size: var(--fs-2);
}
.diagram-source {
  border-top: 1px solid var(--border);
  padding: var(--space-5);
}
.diagram-source .key {
  color: var(--text-3);
  font-size: var(--fs-2);
  margin-bottom: var(--space-1);
}
.diagram-source pre {
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
