<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useTheme } from "../composables/theme";
import { MAX_DIAGRAM_CHARS } from "../api/types";
import { diagramTooLarge, renderMermaid, svgSize, type SvgSize } from "../utils/mermaid";

/**
 * A diagram, drawn.
 *
 * A component rather than a step in `renderMarkdown`, because mermaid is **async** and
 * `renderMarkdown` is deliberately a synchronous `string → string` — see `utils/mermaid.ts`.
 * So this owns a lifecycle the markdown path does not need: a source that changes, a theme
 * that flips, and a component that unmounts while a render is still in flight.
 *
 * A failure is *shown*, never swallowed and never blank. The source is model-authored, so a
 * syntax error is an ordinary outcome, and the one thing that must not happen is a reply whose
 * diagram silently disappeared — the reader would have no way to tell that from a diagram that
 * was never asked for. The sentence and the source both stay on screen. This is the same
 * decision as KaTeX's `throwOnError: false`, one renderer over.
 *
 * `data-render-state` is not decoration: it is what makes an async render assertable. A spec
 * that waited on an `<svg>` appearing could not tell "still drawing" from "drew nothing" from
 * "refused"; waiting on `ready` can.
 */

const props = defineProps<{
  /** The mermaid source. */
  source: string;
}>();

const { t } = useI18n();
const theme = useTheme();

type State = "rendering" | "ready" | "failed" | "tooLarge";

const state = ref<State>("rendering");
const svg = ref("");
/** Mermaid's own message, which is untranslated dynamic text — see the note in the template. */
const detail = ref("");
/**
 * The drawing's own size, as its `viewBox` declares it. Null until it is drawn, and null for a
 * drawing that declares none — see `svgSize`, which is also where the argument for reading this
 * rather than measuring the element lives.
 */
const size = ref<SvgSize | null>(null);

/**
 * The drawn SVG and its size, for the two callers that need them.
 *
 * `DiagramDialog` is both: it scales the drawing by the size it declares (the whole reason a
 * zoom works there), and it exports it (the SVG string *is* the file). Exposed rather than
 * emitted, because both are read at render time rather than in response to an event — the
 * dialog's sizing is a computed over `size`, and it must follow a redraw.
 */
defineExpose({ svg, size });

/**
 * Which render is allowed to write the state.
 *
 * Bumped by every run, so a resolve that arrives after a newer one — a changed source, a
 * flipped theme — is dropped instead of overwriting the newer drawing with the older one.
 * Mermaid offers no cancellation, so this guard *is* the mechanism rather than a nicety.
 */
let token = 0;
/** Set on unmount: there is nothing left to write into, and the refs outlive the DOM. */
let disposed = false;

/** Why it is not drawn. Both reasons end in the source being shown, so both are one panel. */
const reason = computed(() =>
  state.value === "tooLarge"
    ? t("diagram.tooLarge", { size: MAX_DIAGRAM_CHARS })
    : t("diagram.failed")
);

async function run(): Promise<void> {
  const mine = ++token;
  const source = props.source;

  if (!source.trim()) {
    state.value = "failed";
    detail.value = "";
    svg.value = "";
    size.value = null;
    return;
  }
  if (diagramTooLarge(source)) {
    state.value = "tooLarge";
    detail.value = "";
    svg.value = "";
    size.value = null;
    return;
  }

  state.value = "rendering";
  detail.value = "";
  try {
    const drawn = await renderMermaid(source, theme.resolved.value);
    if (mine !== token || disposed) return;
    svg.value = drawn;
    size.value = svgSize(drawn);
    state.value = "ready";
  } catch (err) {
    if (mine !== token || disposed) return;
    // Whatever was drawn before is dropped rather than left up: it belongs to the old source.
    svg.value = "";
    size.value = null;
    detail.value = err instanceof Error ? err.message : String(err);
    state.value = "failed";
  }
}

/*
 * `immediate`, because the common case is a card that mounts with its source already in hand —
 * it is replayed from a persisted tool call. Watching the theme too, because mermaid's theme is
 * module-global and a diagram drawn for the light palette is wrong the moment it flips;
 * `theme.ts` writes `data-theme` synchronously, so by the time this runs the computed styles
 * `MermaidDiagram` reads are the new ones.
 */
watch([() => props.source, theme.resolved], run, { immediate: true });

onBeforeUnmount(() => {
  disposed = true;
});
</script>

<template>
  <div
    class="mermaid-diagram"
    data-testid="mermaid"
    :data-render-state="state"
    :aria-busy="state === 'rendering'"
  >
    <!--
      `v-html` of *mermaid's* output, not of the model's HTML. The model writes mermaid source;
      mermaid sanitizes under `securityLevel: "strict"` before anything reaches here. A
      genuinely different risk profile from `renderMarkdown`, and the reason the security level
      in `utils/mermaid.ts` is a boundary rather than a preference.
    -->
    <div v-if="state === 'ready'" class="diagram-stage" v-html="svg"></div>

    <p v-else-if="state === 'rendering'" class="note" data-testid="mermaid-rendering">
      {{ t("diagram.rendering") }}
    </p>

    <div v-else class="note error">
      <p class="reason" data-testid="mermaid-error">{{ reason }}</p>
      <!-- Mermaid's own sentence, which is dynamic English with no code to key on — the same
           treatment a provider's raw failure gets. It is what tells the reader *where* the
           diagram broke, so it is worth the untranslated line. -->
      <code v-if="detail" class="detail">{{ detail }}</code>
      <!-- The source, in the failure case, is the whole of what there is to show: without it
           "this cannot be drawn" leaves the reader with nothing at all. -->
      <pre class="source"><code>{{ source }}</code></pre>
    </div>
  </div>
</template>

<style scoped>
.mermaid-diagram {
  min-width: 0;
}
.note {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin: 0;
  color: var(--text-3);
  font-size: var(--fs-2);
}
.note.error {
  color: var(--danger-text);
}
.reason {
  margin: 0;
}
.detail {
  color: var(--text-3);
  font-size: var(--fs-2);
}
/* Wrapping, unlike the file preview's `<pre>`: a broken diagram is read, not lined up, and a
   horizontal scrollbar over the reason it is broken hides the reason. */
.source {
  margin: 0;
  padding: var(--space-4);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--code-bg);
  color: var(--code-fg-2);
  font-size: var(--fs-2);
  white-space: pre-wrap;
  word-break: break-word;
  overflow-x: auto;
}
</style>
