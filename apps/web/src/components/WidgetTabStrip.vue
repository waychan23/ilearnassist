<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { WidgetId } from "../api/types";
import { fitWidgetTabs, type WidgetTabGroup } from "../utils/widgetTabs";
import { widgetLabel } from "../widgets/registry";
import Icon from "./Icon.vue";

/**
 * The widget panel's tab strip: the two groups, a rule between them, and a "more" menu when they
 * do not all fit.
 *
 * ### Measuring rather than guessing
 *
 * Which tabs fit depends on the panel's width in pixels, which is the user's to drag — so it is
 * measured, not derived. Every tab is rendered and measured, and the ones that do not fit are
 * hidden with `v-show`. The measured sizes are then **kept**: a hidden tab reports zero, so a
 * re-measure that trusted `offsetWidth` for everything would shrink every overflowing tab to
 * nothing and re-show it. Keeping them is sound because a tab's size is a function of its label
 * and the font, not of the strip's width — which is also why the cache never needs invalidating
 * for the axis that matters.
 */
const props = defineProps<{
  groups: readonly WidgetTabGroup[];
  orientation: "horizontal" | "vertical";
  /** The open widget, so the tab can say so. `aria-selected` is what the styles key on. */
  active: WidgetId | null;
}>();

const emit = defineEmits<{ select: [id: WidgetId] }>();

const { t } = useI18n();

const strip = ref<HTMLElement | null>(null);
const moreButton = ref<HTMLElement | null>(null);
const menuOpen = ref(false);

/** Measured size per tab, along the strip's axis. */
const sizes = ref<Record<string, number>>({});
const tabEls = new Map<string, HTMLElement>();

/** `null` until the first measurement, which the fit treats as "everything fits". */
const containerSize = ref<number | null>(null);
const dividerSize = ref(0);
const moreSize = ref(0);

const GAP = 4;

function setTabEl(id: WidgetId, el: unknown): void {
  if (el instanceof HTMLElement) tabEls.set(id, el);
  else tabEls.delete(id);
}

/**
 * One frame's measurement of everything on screen.
 *
 * Two rules, and both are about not writing state this function does not need to:
 *
 * - **A tab reporting zero is skipped.** `v-show` leaves a hidden tab in the DOM with no box, and
 *   overwriting its remembered size with 0 would make it fit again on the next pass — a strip that
 *   oscillates between showing and hiding the same tab.
 * - **A value that has not changed is not assigned.** Measuring happens from a `ResizeObserver`,
 *   and the callback can be what caused the resize: writing a ref re-renders, which can resize the
 *   container, which notifies again. Comparing first breaks that circuit, and it is also what keeps
 *   a drag from queueing a reactive write per frame for numbers that did not move.
 */
function measure(): void {
  const horizontal = props.orientation === "horizontal";
  const next = { ...sizes.value };
  for (const [id, el] of tabEls) {
    const size = horizontal ? el.offsetWidth : el.offsetHeight;
    if (size > 0) next[id] = size;
  }
  if (Object.entries(next).some(([id, size]) => sizes.value[id] !== size)) sizes.value = next;

  if (strip.value) {
    const container = horizontal ? strip.value.clientWidth : strip.value.clientHeight;
    if (containerSize.value !== container) containerSize.value = container;
  }
  // The rule and the menu button are chrome whose cost the fit has to know about, and the axis
  // decides which dimension of each matters. Measured from the elements rather than assumed from
  // the stylesheet, so a padding change cannot silently break the arithmetic.
  const dividerEl = strip.value?.querySelector<HTMLElement>(".widget-tabs-divider");
  const divider = dividerEl ? (horizontal ? dividerEl.offsetWidth : dividerEl.offsetHeight) : 1;
  if (dividerSize.value !== divider) dividerSize.value = divider;
  const buttonEl = moreButton.value;
  const more = buttonEl ? (horizontal ? buttonEl.offsetWidth : buttonEl.offsetHeight) : 0;
  if (moreSize.value !== more) moreSize.value = more;
}

const fit = computed(() => {
  const flat = props.groups.flatMap((g) => g.ids);
  return fitWidgetTabs({
    groups: props.groups,
    sizes: flat.map((id) => sizes.value[id] ?? 0),
    // Before the first measurement, assume it all fits: showing every tab for one frame and then
    // collapsing the tail is calmer than showing a "more" menu that disappears.
    containerSize: containerSize.value ?? Number.MAX_SAFE_INTEGER,
    dividerSize: dividerSize.value,
    moreSize: moreSize.value,
    gap: GAP,
  });
});

const visible = computed(() => new Set(fit.value.visible));
const overflow = computed(() => new Set(fit.value.overflow));

let observer: ResizeObserver | null = null;

let frame = 0;

/**
 * Measure on the next frame rather than inside the notification.
 *
 * A `ResizeObserver` callback that re-renders anything in the observed tree is the documented way
 * to earn "ResizeObserver loop completed with undelivered notifications" — the browser has already
 * finished its layout pass by the time the callback runs, so a change it causes cannot be
 * delivered until the next one. Deferring costs a frame and makes the measurement settle instead
 * of racing its own consequences.
 */
function scheduleMeasure(): void {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    measure();
  });
}

onMounted(async () => {
  await nextTick();
  measure();
  if (typeof ResizeObserver !== "undefined" && strip.value) {
    observer = new ResizeObserver(scheduleMeasure);
    observer.observe(strip.value);
  }
  // A font that lands late changes every label's width, and nothing fires a resize for it.
  document.fonts?.ready.then(() => scheduleMeasure()).catch(() => undefined);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  document.removeEventListener("keydown", onKeydown);
});

/** Re-measure when the set of tabs changes, and rebuild the popover's listeners with it. */
watch(
  () => props.groups.map((g) => g.ids.join(",")).join("|"),
  async () => {
    await nextTick();
    measure();
  }
);

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") menuOpen.value = false;
}

async function toggleMenu(): Promise<void> {
  menuOpen.value = !menuOpen.value;
  if (!menuOpen.value) return;
  await nextTick();
  measure();
  document.addEventListener("keydown", onKeydown);
}

function pickFromMenu(id: WidgetId): void {
  menuOpen.value = false;
  emit("select", id);
}

/**
 * Arrow keys move between tabs, which `role="tablist"` promises and a row of plain buttons does
 * not deliver. Scoped to the visible ones, because a tab inside the "more" menu cannot take focus
 * and would otherwise be a stop that goes nowhere.
 */
function onArrowKey(event: KeyboardEvent): void {
  const step =
    event.key === (props.orientation === "vertical" ? "ArrowDown" : "ArrowRight")
      ? 1
      : event.key === (props.orientation === "vertical" ? "ArrowUp" : "ArrowLeft")
        ? -1
        : 0;
  if (step === 0) return;
  const ids = props.groups.flatMap((g) => g.ids).filter((id) => visible.value.has(id));
  if (ids.length === 0) return;
  event.preventDefault();
  const at = props.active ? ids.indexOf(props.active) : -1;
  // Wraps, which is what a tablist does at both ends.
  const next = ids[(at + step + ids.length) % ids.length];
  if (next) {
    emit("select", next);
    tabEls.get(next)?.focus();
  }
}
</script>

<template>
  <div
    ref="strip"
    class="widget-tabs"
    :class="{ vertical: orientation === 'vertical' }"
    role="tablist"
    :aria-orientation="orientation"
    data-testid="widget-tabs"
    @keydown="onArrowKey"
  >
    <template v-for="group in groups" :key="group.scope">
      <button
        v-for="id in group.ids"
        :key="id"
        :ref="(el) => setTabEl(id, el)"
        v-show="visible.has(id)"
        class="widget-tab"
        role="tab"
        :aria-selected="props.active === id"
        aria-controls="widget-body"
        :data-testid="`widget-tab-${id}`"
        :title="widgetLabel(id, t)"
        @click="emit('select', id)"
      >
        <span class="truncate">{{ widgetLabel(id, t) }}</span>
      </button>

      <!--
        The rule between the two levels, and only where both sides have a visible tab — a rule
        whose right-hand side sits inside the "more" menu would be separating a tab from a button.
      -->
      <span
        v-if="group.ids[group.ids.length - 1] === fit.dividerAfter"
        class="widget-tabs-divider"
        aria-hidden="true"
        data-testid="widget-tabs-divider"
      ></span>
    </template>

    <div v-if="fit.overflow.length > 0" class="widget-more">
      <button
        ref="moreButton"
        class="icon-btn"
        :title="t('widgets.panel.more')"
        :aria-label="t('widgets.panel.more')"
        :aria-expanded="menuOpen"
        data-testid="widget-more"
        @click="toggleMenu"
      >
        <Icon name="caret-down" />
      </button>
      <div v-if="menuOpen" class="widget-menu overlay-popover" data-testid="widget-more-menu">
        <button
          v-for="id in fit.overflow"
          :key="id"
          class="menu-item"
          :data-testid="`widget-more-item-${id}`"
          @click="pickFromMenu(id)"
        >
          {{ widgetLabel(id, t) }}
        </button>
      </div>
    </div>
  </div>
</template>
