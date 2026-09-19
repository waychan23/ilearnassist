<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { WidgetId } from "../api/types";
import { useAppStore } from "../stores/app";
import { widgetPanel, WIDGET_MIN_WIDTH } from "../composables/widgetPanel";
import { uiState } from "../composables/ui";
import { isCompact } from "../composables/breakpoints";
import { WIDGET_MODULES } from "../widgets/registry";
import WidgetTabStrip from "./WidgetTabStrip.vue";
import Icon from "./Icon.vue";

/**
 * The right sidebar: the widget tabs, the open widget, and the chrome around them.
 *
 * Takes no props and emits nothing, like every other component in the shell — it reads the store
 * and `widgetPanel` directly, which is also what removes "which workspace am I showing" from its
 * own state. Whether it exists at all is `App.vue`'s decision.
 */
const { t } = useI18n();
const store = useAppStore();

/**
 * One group per level, in the order they are drawn, and only the non-empty ones.
 *
 * An empty group is not a group: passing it to the strip would spend a divider's width on a rule
 * with nothing on one side of it. **The workspace entry is empty today and that is the expected
 * state, not a bug** — nothing is installed at that level, so in practice the strip always draws
 * one group and no divider. It is kept because the level is still a level, and a workspace widget
 * would appear here without this expression changing.
 */
const groups = computed(() =>
  [
    { scope: "workspace" as const, ids: store.workspaceWidgetIds },
    { scope: "session" as const, ids: store.sessionWidgetIds },
  ].filter((g) => g.ids.length > 0)
);

const installed = computed<WidgetId[]>(() => groups.value.flatMap((g) => g.ids));

/**
 * The open widget.
 *
 * The remembered preference when it is installed, and otherwise the first one there is. Falling
 * back rather than trusting the preference is what stops uninstalling the open widget from
 * leaving an empty body; the preference itself is left alone, so installing that widget again
 * comes back to it.
 */
const active = computed<WidgetId | null>(() => {
  const ids = installed.value;
  if (ids.length === 0) return null;
  const remembered = widgetPanel.activeId.value;
  return ids.find((id) => id === remembered) ?? ids[0] ?? null;
});

const activeComponent = computed(() => (active.value ? WIDGET_MODULES[active.value].component : null));

function select(id: WidgetId): void {
  widgetPanel.setActive(id);
}

/* --------------------------------- chrome --------------------------------- */

/** The rail has no strip to toggle, so the control closes the drawer there instead. */
function onCollapse(): void {
  if (isCompact.value) {
    uiState.widgetDrawerOpen = false;
    return;
  }
  widgetPanel.toggleCollapsed();
}

/* ------------------------------- drag to resize ------------------------------- */

/*
 * Pointer events with capture, so a fast drag that leaves the handle keeps resizing it rather
 * than stopping the moment the cursor crosses out of an 8px strip. `delta` is inverted because
 * the handle is on the panel's *left* edge: dragging left widens the panel.
 */
let startX = 0;
let startWidth = 0;

function startResize(event: PointerEvent): void {
  (event.target as HTMLElement).setPointerCapture(event.pointerId);
  startX = event.clientX;
  startWidth = widgetPanel.effectiveWidth.value;
  window.addEventListener("pointermove", onResizeMove);
  window.addEventListener("pointerup", stopResize, { once: true });
}

function onResizeMove(event: PointerEvent): void {
  widgetPanel.setWidth(startWidth + (startX - event.clientX));
}

function stopResize(): void {
  window.removeEventListener("pointermove", onResizeMove);
}

/**
 * The keyboard's way to do what the drag does.
 *
 * A separator is a control, so it has to be operable without a pointer — a handle that could only
 * be dragged would be unreachable to anyone using a keyboard, and the width would be a preference
 * only some people could set.
 */
function onResizeKey(event: KeyboardEvent): void {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  widgetPanel.stepWidth((event.key === "ArrowLeft" ? 1 : -1) * 16);
}

/** Whether the width is at the narrowest the panel may be, for the handle's own affordance. */
const atMinimum = computed(() => widgetPanel.effectiveWidth.value <= WIDGET_MIN_WIDTH);
</script>

<template>
  <aside
    id="widget-panel"
    class="widget-panel"
    :class="{
      vertical: widgetPanel.orientation.value === 'vertical',
      collapsed: widgetPanel.collapsed.value,
      open: uiState.widgetDrawerOpen,
    }"
    :inert="isCompact && !uiState.widgetDrawerOpen"
    data-testid="widget-panel"
  >
    <!-- The strip as a rail inside the panel's left edge, when it is not at the top. -->
    <div v-if="widgetPanel.orientation.value === 'vertical'" class="widget-rail">
      <WidgetTabStrip
        :groups="groups"
        orientation="vertical"
        :active="active"
        @select="select"
      />
    </div>

    <div class="widget-column">
      <div class="widget-head">
        <WidgetTabStrip
          v-if="widgetPanel.orientation.value === 'horizontal'"
          :groups="groups"
          orientation="horizontal"
          :active="active"
          @select="select"
        />
        <!--
          The orientation toggle is not offered on a compact viewport: the panel is a fixed-width
          overlay there, so which edge its strip is on is not a decision with anything behind it.
        -->
        <button
          v-if="!isCompact"
          class="icon-btn"
          :title="
            widgetPanel.orientation.value === 'horizontal'
              ? t('widgets.panel.layoutLeft')
              : t('widgets.panel.layoutTop')
          "
          :aria-label="
            widgetPanel.orientation.value === 'horizontal'
              ? t('widgets.panel.layoutLeft')
              : t('widgets.panel.layoutTop')
          "
          data-testid="widget-layout-toggle"
          @click="widgetPanel.toggleOrientation()"
        >
          <Icon :name="widgetPanel.orientation.value === 'horizontal' ? 'tabs-left' : 'tabs-top'" />
        </button>
        <button
          class="icon-btn"
          :title="
            widgetPanel.collapsed.value ? t('widgets.panel.expand') : t('widgets.panel.collapse')
          "
          :aria-label="
            widgetPanel.collapsed.value ? t('widgets.panel.expand') : t('widgets.panel.collapse')
          "
          data-testid="widget-collapse"
          @click="onCollapse"
        >
          <Icon name="panel-right" />
        </button>
      </div>

      <div
        id="widget-body"
        class="widget-body"
        role="tabpanel"
        data-testid="widget-body"
      >
        <component :is="activeComponent" v-if="activeComponent" :key="active" />
      </div>
    </div>

    <!--
      The handle. `role="separator"` with `aria-orientation="vertical"` is what a resizable
      vertical divider is, and it is focusable so its arrow keys are reachable.
    -->
    <div
      v-if="!isCompact"
      class="widget-resize"
      :class="{ narrow: atMinimum }"
      role="separator"
      aria-orientation="vertical"
      tabindex="0"
      :aria-label="t('widgets.panel.resize')"
      data-testid="widget-resize"
      @pointerdown="startResize"
      @keydown="onResizeKey"
    ></div>
  </aside>
</template>
