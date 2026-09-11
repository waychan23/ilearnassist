<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  getMinimapRenderRange,
  MINIMAP_ITEM_HEIGHT,
  normalizePreviewText,
  smoothstep,
  type MessageMinimapAnchor,
} from "../utils/minimap";

/**
 * A vertical rail of one anchor per conversation turn, following chatbox's
 * `MessageMinimapRail`: the bar nearest the pointer widens, hovering shows a preview of
 * the turn, and clicking jumps the message list to it.
 */
const props = defineProps<{ anchors: MessageMinimapAnchor[] }>();
const { t } = useI18n();
const emit = defineEmits<{ jump: [anchor: MessageMinimapAnchor] }>();

const BASE_LINE_WIDTH = 6;
const MAX_LINE_WIDTH = 24;
/** Distance, in content px, over which an anchor feels the pointer. */
const HOVER_DISTANCE = 60;
const HOVER_FALLOFF_POWER = 2;
/** Keeps the preview card from touching the rail's top/bottom edge. */
const PREVIEW_MARGIN = 28;

const scrollArea = ref<HTMLElement | null>(null);
const scrollTop = ref(0);
const viewportHeight = ref(0);
const scrollHeight = ref(0);
const pointerContentY = ref<number | null>(null);
const hoveredIndex = ref<number | null>(null);
const keyboardIndex = ref(0);

const anchorEls = new Map<number, HTMLButtonElement>();
let observer: ResizeObserver | null = null;
let pendingFocusIndex: number | null = null;

const contentHeight = computed(() => props.anchors.length * MINIMAP_ITEM_HEIGHT);

/**
 * When the anchors are shorter than the rail, centre them; otherwise they fill it and
 * the rail scrolls.
 */
const contentOffset = computed(() =>
  viewportHeight.value > contentHeight.value ? (viewportHeight.value - contentHeight.value) / 2 : 0
);

const renderRange = computed(() =>
  getMinimapRenderRange(props.anchors.length, scrollTop.value, viewportHeight.value)
);

const renderedAnchors = computed(() =>
  props.anchors
    .slice(renderRange.value.start, renderRange.value.end)
    .map((anchor, i) => ({ anchor, index: renderRange.value.start + i }))
);

const hasScrollableOverflow = computed(() => scrollHeight.value > viewportHeight.value + 1);
const showTopFade = computed(() => hasScrollableOverflow.value && scrollTop.value > 1);
const showBottomFade = computed(
  () => hasScrollableOverflow.value && scrollTop.value + viewportHeight.value < scrollHeight.value - 1
);

const hoveredAnchor = computed(() =>
  hoveredIndex.value === null ? null : props.anchors[hoveredIndex.value] ?? null
);

const previewTop = computed(() => {
  if (hoveredIndex.value === null || viewportHeight.value <= 0) return PREVIEW_MARGIN;
  const center = contentOffset.value + hoveredIndex.value * MINIMAP_ITEM_HEIGHT + MINIMAP_ITEM_HEIGHT / 2;
  const relative = center - scrollTop.value;
  return Math.min(
    Math.max(relative, PREVIEW_MARGIN),
    Math.max(PREVIEW_MARGIN, viewportHeight.value - PREVIEW_MARGIN)
  );
});

const hoveredText = computed(() =>
  hoveredAnchor.value ? normalizePreviewText(hoveredAnchor.value.text, t("minimap.empty")) : ""
);
const hoveredAssistantText = computed(() =>
  hoveredAnchor.value?.assistantText ? normalizePreviewText(hoveredAnchor.value.assistantText) : ""
);

/** Magnetic widening: the closer the pointer, the longer the bar. */
function lineWidth(index: number): number {
  const center = index * MINIMAP_ITEM_HEIGHT + MINIMAP_ITEM_HEIGHT / 2;
  const influenceCenterY =
    hoveredIndex.value !== null
      ? hoveredIndex.value * MINIMAP_ITEM_HEIGHT + MINIMAP_ITEM_HEIGHT / 2
      : pointerContentY.value;
  if (influenceCenterY === null) return BASE_LINE_WIDTH;

  const raw = Math.max(0, 1 - Math.abs(center - influenceCenterY) / HOVER_DISTANCE);
  const influence = smoothstep(raw) ** HOVER_FALLOFF_POWER;
  return Math.min(MAX_LINE_WIDTH, BASE_LINE_WIDTH + influence * (MAX_LINE_WIDTH - BASE_LINE_WIDTH));
}

function updatePointerPosition(event: MouseEvent) {
  const el = event.currentTarget as HTMLElement;
  const rect = el.getBoundingClientRect();
  const offset = Math.max(0, (el.clientHeight - props.anchors.length * MINIMAP_ITEM_HEIGHT) / 2);
  const y = event.clientY - rect.top + el.scrollTop - offset;
  const index = Math.round((y - MINIMAP_ITEM_HEIGHT / 2) / MINIMAP_ITEM_HEIGHT);

  pointerContentY.value = y;
  hoveredIndex.value = y >= 0 && y <= props.anchors.length * MINIMAP_ITEM_HEIGHT && props.anchors[index]
    ? index
    : null;
}

function onScroll(event: Event) {
  const el = event.currentTarget as HTMLElement;
  scrollTop.value = el.scrollTop;
  scrollHeight.value = el.scrollHeight;
}

function clearHover() {
  pointerContentY.value = null;
  hoveredIndex.value = null;
}

/** Scroll the rail itself so `index` is visible, then move focus to it. */
function focusAnchorAt(requested: number) {
  if (props.anchors.length === 0) return;
  const index = Math.min(props.anchors.length - 1, Math.max(0, requested));
  const el = scrollArea.value;

  if (el) {
    const effectiveViewport = el.clientHeight || viewportHeight.value;
    const itemTop = index * MINIMAP_ITEM_HEIGHT;
    const itemBottom = itemTop + MINIMAP_ITEM_HEIGHT;
    let next = el.scrollTop;

    if (itemTop < next) next = itemTop;
    else if (itemBottom > next + effectiveViewport) next = itemBottom - effectiveViewport;

    next = Math.min(Math.max(0, contentHeight.value - effectiveViewport), Math.max(0, next));
    if (next !== el.scrollTop) {
      el.scrollTop = next;
      scrollTop.value = next;
    }
  }

  pendingFocusIndex = index;
  keyboardIndex.value = index;
}

function onAnchorKeydown(event: KeyboardEvent, index: number) {
  let next: number | null = null;
  switch (event.key) {
    case "ArrowUp":
      next = index - 1;
      break;
    case "ArrowDown":
      next = index + 1;
      break;
    case "Home":
      next = 0;
      break;
    case "End":
      next = props.anchors.length - 1;
      break;
    default:
      return;
  }
  event.preventDefault();
  focusAnchorAt(next);
}

watch(
  () => props.anchors.length,
  (len) => {
    if (keyboardIndex.value > len - 1) keyboardIndex.value = Math.max(0, len - 1);
    if (hoveredIndex.value !== null && hoveredIndex.value > len - 1) clearHover();
  }
);

// Move focus after the render that a rail scroll triggered has settled.
watch(renderedAnchors, () => {
  if (pendingFocusIndex === null) return;
  const button = anchorEls.get(pendingFocusIndex);
  if (!button) return;
  pendingFocusIndex = null;
  button.focus();
});

function measure() {
  const el = scrollArea.value;
  if (!el) return;
  viewportHeight.value = el.clientHeight;
  scrollHeight.value = el.scrollHeight;
}

onMounted(() => {
  measure();
  if (typeof ResizeObserver !== "undefined" && scrollArea.value) {
    observer = new ResizeObserver(() => measure());
    observer.observe(scrollArea.value);
  }
});

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
  anchorEls.clear();
});
</script>

<template>
  <div v-if="props.anchors.length > 0" class="minimap-rail">
    <div
      ref="scrollArea"
      class="minimap-scroll"
      @mouseenter="updatePointerPosition"
      @mousemove="updatePointerPosition"
      @mouseleave="clearHover"
      @scroll="onScroll"
    >
      <div
        class="minimap-track"
        :style="{ height: `${contentHeight}px`, transform: `translateY(${contentOffset}px)` }"
      >
        <button
          v-for="{ anchor, index } in renderedAnchors"
          :key="anchor.messageId"
          :ref="(el) => {
            const button = el as HTMLButtonElement | null;
            if (button) anchorEls.set(index, button);
            else anchorEls.delete(index);
          }"
          type="button"
          class="minimap-anchor"
          :style="{ top: `${index * MINIMAP_ITEM_HEIGHT}px` }"
          :aria-label="t('minimap.jumpTo', { n: index + 1 })"
          aria-keyshortcuts="ArrowUp ArrowDown Home End"
          :title="normalizePreviewText(anchor.text, t('minimap.empty'))"
          :tabindex="index === keyboardIndex ? 0 : -1"
          @mouseenter="hoveredIndex = index"
          @focus="focusAnchorAt(index)"
          @blur="clearHover"
          @keydown="onAnchorKeydown($event, index)"
          @click="emit('jump', anchor)"
        >
          <span
            aria-hidden="true"
            class="minimap-line"
            :class="{ active: hoveredIndex === index }"
            :style="{ width: `${lineWidth(index)}px` }"
          ></span>
        </button>
      </div>
    </div>

    <div v-if="showTopFade" class="minimap-fade top" aria-hidden="true"></div>
    <div v-if="showBottomFade" class="minimap-fade bottom" aria-hidden="true"></div>

    <div v-if="hoveredAnchor" class="minimap-preview" :style="{ top: `${previewTop}px` }">
      <div class="preview-user">{{ hoveredText }}</div>
      <div v-if="hoveredAssistantText" class="preview-assistant truncate">{{ hoveredAssistantText }}</div>
    </div>
  </div>
</template>

<style scoped>
.minimap-rail {
  position: absolute;
  left: 8px;
  top: 46%;
  transform: translateY(-50%);
  height: 42vh;
  min-height: 96px;
  max-height: 360px;
  width: 20px;
  z-index: var(--z-rail);
  /* The rail must not eat clicks on the messages behind it; only the anchors do. */
  pointer-events: none;
  overflow: visible;
}

.minimap-scroll {
  pointer-events: auto;
  height: 100%;
  width: 20px;
  margin-right: auto;
  overflow-y: auto;
  overflow-x: visible;
  padding: var(--space-2) 0;
  scrollbar-width: none;
}
.minimap-scroll::-webkit-scrollbar {
  display: none;
}

.minimap-track {
  position: relative;
}

.minimap-anchor {
  position: absolute;
  left: 0;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  height: 12px;
  width: 20px;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
}
/*
 * The rail's anchors sit close together, so the global ring's 2px offset would overlap the
 * neighbouring anchor. Only the offset is tightened — the colour and width still come from
 * the one global rule, which is what `:where()`'s zero specificity is for.
 */
.minimap-anchor:focus-visible {
  outline-offset: -2px;
  border-radius: var(--radius-xs);
}

.minimap-line {
  display: block;
  height: 2px;
  border-radius: 999px;
  background: var(--text-3);
  opacity: 0.35;
  transition: width var(--dur-fast) ease-out, height var(--dur-fast) ease-out, opacity var(--dur-fast) ease-out,
    background-color var(--dur-fast) ease-out;
  will-change: width, opacity;
}
.minimap-line.active {
  height: 2.5px;
  opacity: 0.95;
  background: var(--text);
}

.minimap-fade {
  position: absolute;
  left: 0;
  width: 20px;
  height: 32px;
  pointer-events: none;
  z-index: var(--z-rail);
  backdrop-filter: blur(1px);
}
.minimap-fade.top {
  top: 0;
  background: linear-gradient(to bottom, var(--bg), transparent);
}
.minimap-fade.bottom {
  bottom: 0;
  background: linear-gradient(to top, var(--bg), transparent);
}

.minimap-preview {
  position: absolute;
  left: 48px;
  z-index: var(--z-rail-card);
  width: 360px;
  max-width: min(360px, calc(100vw - 96px));
  transform: translateY(-50%);
  pointer-events: none;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel);
  padding: var(--space-4) var(--space-6);
  box-shadow: var(--shadow-popover);
}
.preview-user {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  overflow: hidden;
  font-size: var(--fs-3);
  line-height: 1.45;
  color: var(--text);
}
.preview-assistant {
  margin-top: var(--space-2);
  font-size: var(--fs-2);
  color: var(--text-3);
}
</style>
