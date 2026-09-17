<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { chartKit, type ChartConfig, type ChartHandle } from "../../utils/charts";

/**
 * A canvas, and Chart.js behind it.
 *
 * This component owns the async half: the library arrives on demand, the chart is built once, and
 * it is updated when `config` changes. Everything with no DOM in it lives in `utils/charts.ts`,
 * which is what lets the palette mapping be unit-tested — jsdom applies no stylesheet, so a
 * component test could only ever assert that *something* was drawn.
 *
 * **A theme flip arrives as a new `config`, not as a second signal.** Chart.js paints concrete
 * colours onto a canvas, so there is nothing to cascade: the only way a dark-mode chart stops being
 * drawn in light-mode colours is for the whole configuration to be rebuilt from the new palette.
 * That is the caller's job — its `config` is a computed that reads the theme — and it is why this
 * component watches one thing. A second watcher on the theme would be a second cause for one
 * effect, and the two would eventually disagree about what the chart shows.
 */

const props = defineProps<{ config: ChartConfig; testid?: string }>();

const canvas = ref<HTMLCanvasElement | null>(null);
let handle: ChartHandle | null = null;

function build(): void {
  const el = canvas.value;
  if (!el) return;
  if (handle) {
    handle.update(props.config);
    return;
  }
  // The guard inside is the whole concurrency story: the component may have unmounted, or a
  // previous build may have finished first, while this chunk was loading.
  void chartKit().then((kit) => {
    if (!canvas.value || handle) return;
    handle = kit.draw(canvas.value, props.config);
  });
}

onMounted(build);

// Deep, because a caller rebuilds the whole config object on a data *or* theme change and the
// arrays inside it are what actually differ.
watch(() => props.config, build, { deep: true });

onBeforeUnmount(() => {
  handle?.destroy();
  handle = null;
});
</script>

<template>
  <canvas ref="canvas" class="usage-chart" :data-testid="props.testid ?? 'usage-chart'" />
</template>

<style scoped>
/* The container's height is the parent's to decide — `maintainAspectRatio: false` means the canvas
 * takes exactly this box, so a chart in a narrow column and one on a full page are sized by the
 * layout rather than by a number repeated in three places. */
.usage-chart {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
