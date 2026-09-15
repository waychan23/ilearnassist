<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import MermaidDiagram from "../MermaidDiagram.vue";
import Icon from "../Icon.vue";

/**
 * One diagram, larger.
 *
 * A dialog of its own rather than a mode of `FilePreviewDialog`, even though both end up
 * drawing the same component. `FilePreviewDialog` is bound to a *file the store has open* — it
 * renders `store.fileContent` — and the card in the conversation has no file open: the source
 * is already in the tool call it is rendering. Hosting this there would mean either a round
 * trip to open the conversation's file before enlarging something already in hand, or a second
 * mode inside that dialog. So: two entry points, one viewer, one zoom implementation.
 *
 * Native scroll is the pan. It needs no JavaScript, it works with a trackpad and on touch, it
 * is keyboard-reachable, and it is what a reader already expects a big picture in a box to do.
 * Drag-to-pan is a control with real edge cases (pointer capture, touch, reduced motion) for
 * something nobody has asked for.
 *
 * Zoom is the CSS `zoom` property rather than a `transform: scale`. A transform does not change
 * layout, so a scroll container would not grow with the picture and a zoomed diagram would
 * simply overflow its box invisibly; `zoom` scales the box and its contents together, which is
 * what a scroll container needs. At 1× nothing is overridden: mermaid caps the drawing at its
 * natural width and lets it shrink to fit whatever box it lands in, which is why "fit" is the
 * same as "back to 1".
 */

const props = defineProps<{
  /** The mermaid source to draw. */
  source: string;
  /** Shown in the header, so the dialog names what it is showing. */
  name?: string;
  /** The model's one-line description, shown above the drawing. */
  summary?: string;
}>();

const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const STEP = 1.25;

const zoom = ref(1);

const canZoomIn = computed(() => zoom.value < MAX_ZOOM);
const canZoomOut = computed(() => zoom.value > MIN_ZOOM);

function zoomIn(): void {
  zoom.value = Math.min(MAX_ZOOM, zoom.value * STEP);
}

function zoomOut(): void {
  zoom.value = Math.max(MIN_ZOOM, zoom.value / STEP);
}

function fit(): void {
  zoom.value = 1;
}

function onKeydown(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  e.preventDefault();
  emit("close");
}

onMounted(() => window.addEventListener("keydown", onKeydown));
onUnmounted(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <!-- Teleported to `body` for the reason every overlay here is: a fixed-position element
       whose ancestor is transformed is positioned against that ancestor, and on a compact
       viewport the drawer is. See `ConfirmDialog`. -->
  <Teleport to="body">
    <div class="modal-overlay" data-testid="diagram-viewer" @click.self="emit('close')">
      <div class="modal lg">
        <div class="modal-head">
          <h3 class="truncate">{{ props.name || t("diagram.viewTitle") }}</h3>

          <div class="viewer-controls">
            <button
              class="icon-btn"
              data-testid="diagram-zoom-out"
              :disabled="!canZoomOut"
              :title="t('diagram.zoomOut')"
              :aria-label="t('diagram.zoomOut')"
              @click="zoomOut"
            >
              <Icon name="zoom-out" />
            </button>
            <span class="viewer-zoom" data-testid="diagram-zoom">{{ Math.round(zoom * 100) }}%</span>
            <button
              class="icon-btn"
              data-testid="diagram-zoom-in"
              :disabled="!canZoomIn"
              :title="t('diagram.zoomIn')"
              :aria-label="t('diagram.zoomIn')"
              @click="zoomIn"
            >
              <Icon name="zoom-in" />
            </button>
            <button class="btn small" data-testid="diagram-fit" @click="fit">
              {{ t("diagram.fit") }}
            </button>
          </div>

          <button
            class="icon-btn"
            data-testid="diagram-viewer-close"
            :title="t('common.close')"
            :aria-label="t('common.close')"
            @click="emit('close')"
          >
            <Icon name="close" />
          </button>
        </div>

        <p v-if="props.summary" class="viewer-summary" data-testid="diagram-summary">
          <span class="viewer-summary-label">{{ t("diagram.summary") }}</span>
          {{ props.summary }}
        </p>

        <div class="modal-body viewer-body" data-testid="diagram-viewer-body">
          <!-- The scaled box is *inside* the scroll container, so zooming up gives the
               container something wider to scroll and zooming down gives it something narrower
               to centre. `zoom` on the container itself would have scaled the scrollbars too.

               The scale is passed as a *string*: Vue appends `px` to a bare number for every
               property it does not know to be unitless, and `zoom: 1.25px` is not a
               declaration any browser applies — a silently missing zoom, which is how this
               was first written. -->
          <div class="viewer-scaled" :style="{ zoom: String(zoom) }">
            <MermaidDiagram :source="props.source" />
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.viewer-summary {
  margin: 0;
  padding: 0 var(--space-8) var(--space-4);
  color: var(--text-2);
  font-size: var(--fs-3);
  line-height: 1.5;
  border-bottom: 1px solid var(--border);
}
.viewer-summary-label {
  color: var(--text-3);
  margin-right: var(--space-2);
}
.viewer-body {
  overflow: auto;
  max-height: 70vh;
}
.viewer-scaled {
  /* `zoom` is set inline; this is only the centring at ≤ 1×, where the box is narrower than
     the container. At > 1× it overflows and the scroll takes over. */
  margin: 0 auto;
}
/* Pushed to the end of the head, beside the close button — the same layout nudge the file
   preview's segmented control carries, and for the same reason: where it sits is this
   dialog's business, not the shared control's. */
.viewer-controls {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-left: auto;
  flex-shrink: 0;
}
.viewer-zoom {
  min-width: 3.5em;
  color: var(--text-3);
  font-size: var(--fs-2);
  font-variant-numeric: tabular-nums;
  text-align: center;
}
</style>
