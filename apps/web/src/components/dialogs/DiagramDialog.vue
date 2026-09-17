<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { isNarrow } from "../../composables/breakpoints";
import { useAppStore } from "../../stores/app";
import type { FigureTurnReference } from "../../utils/turnRefs";
import { renderMarkdown } from "../../utils/markdown";
import { tableHtmlForClipboard } from "../../utils/tableClipboard";
import {
  FIGURE_FORMATS,
  FIGURE_RASTER_SCALE,
  downloadName,
  rasterBlob,
  rasterSize,
  saveBlob,
  svgBlob,
  type FigureFormat,
} from "../../utils/figureExport";
import type { SvgSize } from "../../utils/mermaid";
import MermaidDiagram from "../MermaidDiagram.vue";
import CopyButton from "../CopyButton.vue";
import Icon from "../Icon.vue";

/**
 * One figure, larger — a diagram drawn, or a table rendered.
 *
 * A dialog of its own rather than a mode of `FilePreviewDialog`, even though both end up drawing
 * the same component. `FilePreviewDialog` is bound to a *file the store has open* — it renders
 * `store.fileContent` — and a figure in the conversation has no file open: a diagram's source is
 * already in the tool call it is rendering, and a table's is a row rather than a file at all.
 * Hosting this there would mean either a round trip to open a file before enlarging something
 * already in hand, or a second mode inside that dialog. So: two entry points, one viewer.
 *
 * ## Zoom
 *
 * The scale is applied as `transform: scale()` to an inner element held at the figure's **own**
 * size, inside a box given the *scaled* size in pixels. The old arrangement — the CSS `zoom`
 * property on a full-width wrapper — is worth stating exactly, because the way it failed is the
 * reason for both halves of this one.
 *
 * `zoom` multiplies lengths, so the wrapper's own width came back out at its container's; the
 * drawing inside it is `width="100%"` with an inline `max-width` (mermaid's `useMaxWidth` default,
 * which the message card needs), which left its rendered size at `min(container, natural × zoom)`.
 * So it *could* move a small drawing by a small factor — and it could **not** enlarge anything past
 * the width of the box it was in, which for a diagram that already fills that box (the case
 * `useMaxWidth` makes normal) meant no effect at any factor. `e2e/diagram.spec.ts` measures both
 * claims: the drawing grows, and the drawing grows *past* the window with the container able to
 * scroll to all of it.
 *
 * The replacement, and the two things that make it work where the old one could not:
 *
 * - The inner element's size comes from the drawing, never from the box. A diagram declares its
 *   size in its `viewBox` (`svgSize`); a table's is what it lays out at, and its element is
 *   `max-content` so that is a property of the table rather than of this dialog. `transform` does
 *   not change layout — the objection the old code raised against it — and the sized box is what
 *   answers that: its width and height *are* the scaled size, so the scroll container has something
 *   real to scroll.
 * - `max-width` is defeated by `!important` on the way in. Mermaid writes `max-width: <natural>px`
 *   inline, and a zoom that cannot exceed the drawing's own width is not a zoom — but it is the
 *   right behaviour in the message bubble, so the rule is scoped to this dialog's canvas rather
 *   than changed at the renderer.
 *
 * "Fit" is the base state and needs no button: a diagram scales down to the box at 100 %, exactly
 * as it does in the conversation, and a table simply starts at 1:1 and scrolls if it is wide. The
 * percentage readout is the control that returns there.
 */

/**
 * What the viewer is showing.
 *
 * A discriminated pair rather than two optional props, so a third kind is a `vue-tsc` error at
 * every site that has to care — the lesson `FilePreviewDialog`'s `view` switch learned when a new
 * `FileContentKind` compiled cleanly and rendered as something else.
 */
export type FigureContent =
  | { kind: "diagram"; source: string }
  | { kind: "table"; markdown: string };

const props = defineProps<{
  content: FigureContent;
  /** Shown in the header, so the dialog names what it is showing. */
  name?: string;
  /** The model's one-line description, shown above the figure. */
  summary?: string;
  /**
   * The figure this dialog is showing, when there is a row behind it to refer to.
   *
   * Absent for one that is merely a *file* — a `.mmd` opened from the file tree has no
   * `session_diagrams` row, so it has no name the agent could look up and the 追问 control is not
   * drawn. That is the same distinction the panel makes throughout: a diagram the conversation
   * *drew* is addressable, a `.mmd` somebody copied in is a file.
   */
  figure?: FigureTurnReference;
}>();

const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const store = useAppStore();

/**
 * Ask about the figure on screen — and get out of the way of the answer.
 *
 * The dialog is where a reader is when they have a question about what they are looking at, and
 * the card that opened it is behind this overlay — so the same control has to exist here or the
 * enlarged view is the one place a question cannot be asked.
 *
 * **It closes**, which it did not at first, and the reason it must is the one the quiz dialog
 * already gives: the composer is behind this overlay, so a chip staged underneath it is a chip the
 * reader cannot see, and the field that has just taken the caret is covered by the thing that put
 * it there. A full-screen overlay cannot move aside — there is nowhere to move to — so dismissing
 * is the only way it can stop being in the way, and it is the shape every other 追问 source
 * already has.
 *
 * What closes is the *viewer*, not the question: the figure is in the reference now, where the
 * agent reads it, and the chip names it. Nothing is lost but a second copy of the subject.
 */
function askAbout(): void {
  if (!props.figure) return;
  store.stageReference(props.figure);
  emit("close");
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const STEP = 1.25;

const zoom = ref(1);
const maximized = ref(false);

const isDiagram = computed(() => props.content.kind === "diagram");

/*
 * Two whole `t()` calls rather than one with the key chosen inside it, and that is a requirement
 * rather than a style: `catalog.test.ts` finds the keys a component uses by scanning the source for
 * `t("…")` with a literal, so a key that only ever appears as the *result* of a conditional is a
 * key nothing resolves — and the guard reports it as dead, which is what happened here first.
 */
const title = computed(() =>
  props.name || (isDiagram.value ? t("diagram.viewTitle") : t("diagram.tableTitle"))
);

/**
 * What a format is called in the menu.
 *
 * A `switch` over the closed union with a literal key per case, rather than
 * `` t(`diagram.formats.${format}`) `` — the same choice `widgetLabel` makes in the widget
 * registry, and for the same reason: a template literal would force a bare `diagram.formats.`
 * entry into `catalog.test.ts`'s allowlist of dynamic prefixes, and a prefix that broad is where
 * a typo hides.
 */
function formatLabel(format: FigureFormat): string {
  switch (format) {
    case "png":
      return t("diagram.formats.png");
    case "jpg":
      return t("diagram.formats.jpg");
    case "svg":
      return t("diagram.formats.svg");
  }
}

/* ---------------------------------- zoom ---------------------------------- */

/** The drawn diagram, for its SVG and the size it declares. */
const diagram = ref<InstanceType<typeof MermaidDiagram> | null>(null);

/** The element the figure is drawn in, and the one scrolled — measured, never assumed. */
const viewport = ref<HTMLElement | null>(null);
const viewportWidth = ref(0);

/**
 * A table's own size, measured once it is laid out.
 *
 * This is the `max-content` element itself — the table, not the box around it — which is what
 * keeps the measurement a property of the table rather than of this dialog: `max-content` does not
 * depend on the containing block, so measuring it cannot feed back into the width this dialog
 * gives it. `transform` is not part of `offsetWidth` either, so the answer stays the *un*scaled
 * size however far the zoom goes.
 */
const measured = ref<SvgSize | null>(null);
const canvas = ref<HTMLElement | null>(null);

/**
 * The figure's own size, whichever kind it is.
 *
 * A diagram's is read from the SVG text, so it is known before the element exists; a table's can
 * only be measured. Null means "not known yet", and every computed below is inert until it is —
 * which is also the honest answer for a drawing whose `viewBox` cannot be read, and the reason the
 * zoom controls are disabled rather than misleading in that case.
 */
const natural = computed<SvgSize | null>(() =>
  isDiagram.value ? (diagram.value?.size ?? null) : measured.value
);

/**
 * How much of the box's width the figure is allowed to take.
 *
 * Only for a diagram, and only downwards: mermaid's own behaviour is to shrink a drawing that is
 * wider than its container, and 100 % has to keep meaning what it means in the conversation or the
 * viewer opens on a different picture from the one that was clicked. A *table* is not scaled down
 * — text at 60 % of its size is worse than a scrollbar, and a table is a thing people read — so it
 * starts at 1:1 and overflows, which is what a wide table does everywhere else too.
 */
const fitScale = computed(() => {
  const size = natural.value;
  if (!isDiagram.value || !size || !viewportWidth.value) return 1;
  return Math.min(1, viewportWidth.value / size.width);
});

const scale = computed(() => zoom.value * fitScale.value);

/** True while nothing can be scaled — no size to scale it by. */
const scalable = computed(() => natural.value !== null);

const canZoomIn = computed(() => scalable.value && zoom.value < MAX_ZOOM);
const canZoomOut = computed(() => scalable.value && zoom.value > MIN_ZOOM);

function zoomIn(): void {
  zoom.value = Math.min(MAX_ZOOM, zoom.value * STEP);
}

function zoomOut(): void {
  zoom.value = Math.max(MIN_ZOOM, zoom.value / STEP);
}

/**
 * The box that gives the scroll container its extents, and the element the scale is applied to.
 *
 * Two styles rather than one because they mean different things: the box is the *result* (the
 * figure at the current scale) and the inner element is the figure's own size with a transform on
 * it. Setting the width on the inner element is what pins it — for a diagram the SVG inside is
 * `width: 100%` of whatever box it lands in, so a box of exactly the drawing's width is
 * `100% = natural`.
 */
const boxStyle = computed(() => {
  const size = natural.value;
  if (!size) return undefined;
  return {
    width: `${size.width * scale.value}px`,
    height: `${size.height * scale.value}px`,
  };
});

const innerStyle = computed(() => {
  const size = natural.value;
  if (!size) return undefined;
  // The width is pinned for both kinds, and that is what makes the transform's extent exact: the
  // element being scaled is the figure's own box, so `natural × scale` is the box below it. For a
  // diagram it is also what the SVG reads its `100%` against.
  return { width: `${size.width}px`, transform: `scale(${scale.value})` };
});

function resetZoom(): void {
  zoom.value = 1;
}

let observer: ResizeObserver | null = null;

function onResize(): void {
  viewportWidth.value = viewport.value?.clientWidth ?? 0;
  const element = canvas.value;
  if (!isDiagram.value && element) {
    measured.value = { width: element.offsetWidth, height: element.offsetHeight };
  }
}

/*
 * One observer on both elements, and the reason it is not only on the viewport: a table's
 * max-content width moves when the *font* lands, which is after the first paint in a browser that
 * swaps a webfont in, and a scale computed against a pre-swap measurement would be wrong from then
 * on. Observing the table catches that; observing the viewport catches the maximise toggle.
 *
 * Re-created on a change of content, because the table's element is a different one — `v-if` gives
 * each kind its own.
 */
function observe(): void {
  if (typeof ResizeObserver === "undefined") return;
  observer?.disconnect();
  observer = new ResizeObserver(onResize);
  if (viewport.value) observer.observe(viewport.value);
  if (canvas.value) observer.observe(canvas.value);
  onResize();
}

watch(
  () => props.content,
  async () => {
    resetZoom();
    // The table's element does not exist until the new content has rendered, and a diagram's size
    // arrives a tick later still — `size` is exposed by the child, and a `watch` on this component
    // does not fire for the child's own state, so the observer's first callback is what picks it
    // up. `ResizeObserver` fires once on `observe`, which is why the diagram needs no second path.
    await nextTick();
    observe();
  },
  { immediate: true }
);

onBeforeUnmount(() => observer?.disconnect());

/* --------------------------------- download -------------------------------- */

const menuOpen = ref(false);
const menuRoot = ref<HTMLElement | null>(null);
const downloadError = ref(false);
const busy = ref(false);

/** What the download control needs to have in hand: the SVG text. */
const svg = computed(() => diagram.value?.svg ?? "");

const canDownload = computed(() => isDiagram.value && !!svg.value && !busy.value);

function onDocumentPointerDown(event: PointerEvent) {
  if (menuRoot.value && !menuRoot.value.contains(event.target as Node)) menuOpen.value = false;
}

watch(menuOpen, (open) => {
  if (open) document.addEventListener("pointerdown", onDocumentPointerDown, true);
  else document.removeEventListener("pointerdown", onDocumentPointerDown, true);
});
onBeforeUnmount(() => document.removeEventListener("pointerdown", onDocumentPointerDown, true));

/**
 * The surface colour the drawing sits on, read at the moment it is needed.
 *
 * Read from the palette rather than from a theme object, and read *here* rather than watched:
 * this is used once, at the moment a file is written, and the token in force then is the answer —
 * a value captured at mount would be wrong for a download taken after a theme flip, which is a
 * thing a reader does (the same reason mermaid re-initialises on a flip).
 */
function surfaceColour(): string {
  return getComputedStyle(document.documentElement).getPropertyValue("--panel").trim();
}

/**
 * Write the drawing out, in the format that was picked.
 *
 * The raster path needs a background for JPG — the format has no alpha channel, and left alone it
 * paints black where the drawing has no ink. It is the theme's own surface rather than white: the
 * colours in the picture were chosen for a palette, and a dark-palette diagram on a white field is
 * illegible rather than merely different. PNG keeps its transparency, which is what the format is
 * asked for when someone picks it.
 */
async function download(format: FigureFormat): Promise<void> {
  menuOpen.value = false;
  const text = svg.value;
  if (!text) return;

  busy.value = true;
  downloadError.value = false;
  try {
    const blob =
      format === "svg"
        ? svgBlob(text)
        : await rasterBlob(
            text,
            format,
            rasterSize(natural.value ?? { width: 0, height: 0 }, FIGURE_RASTER_SCALE),
            format === "jpg" ? surfaceColour() : undefined
          );
    saveBlob(blob, downloadName(props.name, format));
  } catch {
    // Reported rather than swallowed: a download that produced nothing looks exactly like one
    // that worked until the file is looked for, and by then the dialog is closed.
    downloadError.value = true;
  } finally {
    busy.value = false;
  }
}

/* ---------------------------------- table ---------------------------------- */

/** The words `renderMarkdown` bakes into a code block's copy control. */
const markdownLabels = computed(() => ({
  copy: t("common.copy"),
  copied: t("common.copied"),
}));

/**
 * A table, rendered by the **same** function the conversation uses.
 *
 * Not a second renderer and not a second stylesheet: the panel's table and the reply's must not
 * be two drawings of one thing, and `renderMarkdown` already renders GFM tables with the app's
 * `.markdown table` rules.
 */
const tableHtml = computed(() =>
  props.content.kind === "table" ? renderMarkdown(props.content.markdown, markdownLabels.value) : ""
);

const tableMarkdown = computed(() => (props.content.kind === "table" ? props.content.markdown : ""));

/**
 * The same table, with the styles a pasted one needs written onto it.
 *
 * `CopyButton` falls back to the plain text when there is nothing here, which is the right answer
 * for a row whose content turned out not to hold a table after all: copying the markdown is still
 * the table, and copying nothing is not.
 */
const tableForClipboard = computed(() => tableHtmlForClipboard(tableHtml.value) ?? tableMarkdown.value);

/* --------------------------------- closing --------------------------------- */

const canMaximize = computed(() => !isNarrow.value);

function onKeydown(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  // The format menu first, so one press does not close the dialog out from under a menu the
  // reader opened — the same order every nested overlay in this app dismisses in.
  if (menuOpen.value) {
    e.preventDefault();
    menuOpen.value = false;
    return;
  }
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
      <div class="modal lg" :class="{ maximized }">
        <div class="modal-head">
          <h3 class="truncate">{{ title }}</h3>

          <div class="viewer-controls">
            <!--
              First in the row: it is the one control here that is about the *conversation* rather
              than about the drawing, and the ones after it are a reader adjusting what they see.
            -->
            <button
              v-if="figure"
              class="icon-btn"
              data-testid="diagram-viewer-ask"
              :title="t('turnRef.ask')"
              :aria-label="t('turnRef.ask')"
              @click="askAbout"
            >
              <Icon name="link" />
            </button>
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
            <!-- The readout is the control that returns to 100 %, which is the job the "fit
                 to window" button used to do — and the state the number already names, so it
                 needs no third control beside two arrows. -->
            <button
              class="viewer-zoom"
              data-testid="diagram-zoom"
              :disabled="!scalable"
              :title="t('diagram.fit')"
              :aria-label="t('diagram.fit')"
              @click="resetZoom"
            >
              {{ Math.round(zoom * 100) }}%
            </button>
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

            <!-- The drawing's own control, and only a diagram has one: a table leaves by the
                 clipboard, which is the format it exists in. -->
            <div v-if="isDiagram" ref="menuRoot" class="viewer-menu">
              <button
                class="icon-btn"
                data-testid="diagram-download"
                :disabled="!canDownload"
                aria-haspopup="menu"
                :aria-expanded="menuOpen"
                :title="t('diagram.download')"
                :aria-label="t('diagram.download')"
                @click="menuOpen = !menuOpen"
              >
                <Icon name="download" />
              </button>
              <div
                v-if="menuOpen"
                class="overlay-popover figure-menu"
                role="menu"
                data-testid="diagram-download-menu"
              >
                <button
                  v-for="format in FIGURE_FORMATS"
                  :key="format"
                  class="menu-item"
                  role="menuitem"
                  :data-testid="`diagram-download-${format}`"
                  @click="download(format)"
                >
                  {{ formatLabel(format) }}
                </button>
              </div>
            </div>

            <CopyButton
              v-if="content.kind === 'table'"
              testid="table-copy"
              :value="tableMarkdown"
              :html="tableForClipboard"
              :hint="t('diagram.copyHint')"
            />

            <button
              v-if="canMaximize"
              class="icon-btn"
              data-testid="diagram-viewer-maximize"
              :aria-pressed="maximized"
              :title="maximized ? t('diagram.restore') : t('diagram.maximize')"
              :aria-label="maximized ? t('diagram.restore') : t('diagram.maximize')"
              @click="maximized = !maximized"
            >
              <Icon :name="maximized ? 'collapse' : 'expand'" />
            </button>

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
        </div>

        <p v-if="summary" class="viewer-summary" data-testid="diagram-summary">
          <span class="viewer-summary-label">{{ t("diagram.summary") }}</span>
          {{ summary }}
        </p>

        <p v-if="downloadError" class="viewer-error" data-testid="diagram-download-error">
          {{ t("diagram.downloadFailed") }}
        </p>

        <div class="modal-body viewer-body" ref="viewport" data-testid="diagram-viewer-body">
          <!--
            The scaled box is *inside* the scroll container, so zooming up gives the container
            something wider to scroll and zooming down gives it something narrower to centre.
            Its size is the figure's own times the scale, which is what a `transform` alone
            would not provide — see the docblock.
          -->
          <div class="figure-box" :style="boxStyle" data-testid="figure-box">
            <div class="figure-inner" :style="innerStyle">
              <MermaidDiagram v-if="content.kind === 'diagram'" ref="diagram" :source="content.source" />
              <div v-else ref="canvas" class="markdown table-canvas" v-html="tableHtml"></div>
            </div>
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
.viewer-error {
  margin: 0;
  padding: var(--space-4) var(--space-8);
  color: var(--danger-text);
  font-size: var(--fs-3);
  border-bottom: 1px solid var(--border);
}
.viewer-body {
  overflow: auto;
  max-height: 70vh;
}
/* Maximised: the dialog fills the viewport and the body takes the room that is left. Three-deep
   for the reason `FilePreviewDialog`'s is: the global sheet's `.modal.lg` sets the width at the
   same specificity as two classes, so this has to outrank it rather than depend on which
   stylesheet the bundler put last. */
.modal.lg.maximized {
  width: 100vw;
  height: 100dvh;
  max-width: none;
  max-height: none;
  border-radius: 0;
}
.modal.lg.maximized .viewer-body {
  max-height: none;
  flex: 1;
  min-height: 0;
}
.viewer-body {
  display: flex;
  flex-direction: column;
}
/* The centring at ≤ 1×, where the box is narrower than the container. At > 1× it overflows and
   the scroll takes over. */
.figure-box {
  margin: 0 auto;
  flex-shrink: 0;
}
.figure-inner {
  transform-origin: top left;
}
/*
 * The drawing is pinned to its own width, and mermaid's inline `max-width` is what has to go.
 *
 * `useMaxWidth: true` — the setting the message card depends on — makes every SVG `width="100%"`
 * with `style="max-width: <natural>px"`. The first is exactly what this wants (the element's box
 * *is* the drawing's width); the second caps the drawing at its own size, which is the one thing
 * a zoom must be able to exceed, and it is written inline, so nothing but `!important` outranks
 * it. Scoped to this canvas rather than changed in `utils/mermaid.ts`: in the conversation, that
 * cap is the behaviour.
 */
.figure-inner :deep(svg) {
  max-width: none !important;
  height: auto;
}
/* A table keeps its own size — `max-content` keeps the measurement in `measure()` a property of
   the table rather than of whatever box it is in, which is what stops the scale feeding back into
   itself. */
.table-canvas {
  width: max-content;
  max-width: none;
}
.viewer-menu {
  position: relative;
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
  padding: var(--space-2) var(--space-3);
  border: 1px solid transparent;
  border-radius: var(--radius-xs);
  background: none;
  color: var(--text-3);
  font-size: var(--fs-2);
  font-variant-numeric: tabular-nums;
  text-align: center;
  cursor: pointer;
}
.viewer-zoom:hover:not(:disabled) {
  border-color: var(--border);
  color: var(--text);
}
</style>
