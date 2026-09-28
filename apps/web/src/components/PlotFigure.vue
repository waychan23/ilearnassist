<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import { useTheme } from "../composables/theme";
import { renderPlot } from "../utils/plot";
import { parsePlotSpec } from "../utils/plotSpec";

/**
 * A math figure, drawn.
 *
 * The `MermaidDiagram` shape one renderer over: a `data-render-state` lifecycle (so a spec is
 * assertable without guessing at an `<svg>`), a theme that flips and redraws, and a failure that
 * is *shown* — the spec stays on screen beside the complaint, because "this cannot be drawn"
 * with nothing next to it leaves the reader with nothing at all.
 *
 * What it exposes is what the viewer needs and nothing else: the serialised SVG string and the
 * figure's own size, the same pair `MermaidDiagram` exposes, so `DiagramDialog`'s zoom, fit and
 * download machinery works unchanged for the third kind.
 */

const props = defineProps<{
  /** The JSON spec, verbatim as stored or as the tool call carried it. */
  spec: string;
}>();

const { t } = useI18n();
const theme = useTheme();

type State = "rendering" | "ready" | "failed";

const state = ref<State>("rendering");
const svg = ref("");
/** The renderer's own sentence, untranslated dynamic text — mermaid's `detail` rule. */
const detail = ref("");
const size = ref<{ width: number; height: number } | null>(null);

defineExpose({ svg, size });

/** Which render may write the state; a stale resolve must not overwrite a newer drawing. */
let token = 0;
/** Set on unmount: the refs outlive the DOM, so a resolve has nothing left to write into. */
let disposed = false;

async function run(): Promise<void> {
  const mine = ++token;
  const spec = props.spec;

  if (!spec.trim()) {
    state.value = "failed";
    detail.value = "The figure's spec is empty.";
    svg.value = "";
    size.value = null;
    return;
  }

  state.value = "rendering";
  detail.value = "";
  try {
    // The palette is read from the live stylesheet inside the renderer, so a theme change is a
    // redraw rather than a variable — the mermaid rule, and why the watcher below includes it.
    const drawn = await renderPlot(parsePlotSpec(spec));
    if (mine !== token || disposed) return;
    svg.value = drawn.svg;
    size.value = drawn.size;
    state.value = "ready";
  } catch (err) {
    if (mine !== token || disposed) return;
    svg.value = "";
    size.value = null;
    detail.value = err instanceof Error ? err.message : String(err);
    state.value = "failed";
  }
}

watch([() => props.spec, theme.resolved], run, { immediate: true });

onBeforeUnmount(() => {
  disposed = true;
});
</script>

<template>
  <div
    class="plot-figure"
    data-testid="plot"
    :data-render-state="state"
    :aria-busy="state === 'rendering'"
  >
    <!--
      `v-html` of *our* serialiser's output, not of the model's text: labels pass through the
      library's `text()` (which escapes) and the serialiser strips scripts, foreignObjects and
      event attributes before the string reaches here. This is a genuinely different risk
      profile from `renderMarkdown`, and it is why that stripping is a boundary rather than
      tidiness.
    -->
    <div v-if="state === 'ready'" class="plot-stage" v-html="svg"></div>

    <p v-else-if="state === 'rendering'" class="note" data-testid="plot-rendering">
      {{ t("plot.rendering") }}
    </p>

    <div v-else class="note error">
      <p class="reason" data-testid="plot-error">{{ t("plot.failed") }}</p>
      <code v-if="detail" class="detail">{{ detail }}</code>
      <!-- The spec, in the failure case, is the whole of what there is to show — without it
           "this cannot be drawn" leaves the reader with nothing. -->
      <pre class="source"><code>{{ spec }}</code></pre>
    </div>
  </div>
</template>

<style scoped>
.plot-figure {
  min-width: 0;
}
/* The figure is drawn at a fixed size and shrinks to its container here, exactly as the message
   card expects; the viewer overrides `max-width` for its own zoom. */
.plot-stage :deep(svg) {
  display: block;
  max-width: 100%;
  height: auto;
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
/* Wrapping, unlike the file preview's `<pre>`: a broken spec is read, not lined up. */
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
