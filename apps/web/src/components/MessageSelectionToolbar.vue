<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import Icon from "./Icon.vue";

/**
 * The two things a selection can become, floating over it.
 *
 * **The `mousedown` guard is load-bearing.** Pressing a button collapses the browser's
 * selection — the press moves the caret before the click arrives — so a handler that read the
 * selection would find it empty and the note would be filed against nothing. It is invisible
 * in every test that does not press the button with a real pointer, which is why it is a
 * comment rather than a subtlety.
 *
 * Above the selection by preference, below it when there is no room, and clamped
 * horizontally: the anchor is a point in the viewport and the card must be wholly in it. It
 * is teleported to `body` rather than positioned inside the message list, which scrolls and
 * would carry the toolbar away with it.
 */
const props = defineProps<{
  /** The selection's horizontal midpoint, and the top of its first line. Viewport coords. */
  anchor: { x: number; top: number };
}>();

const emit = defineEmits<{ pick: [intent: "annotation" | "note"] }>();

const { t } = useI18n();

const HEIGHT = 34;
const GAP = 8;
const EDGE = 8;
/** Enough for the two labels and their icons; the CSS width is the same number. */
const WIDTH = 172;

const position = computed(() => {
  const left = Math.min(
    Math.max(EDGE, props.anchor.x - WIDTH / 2),
    Math.max(EDGE, window.innerWidth - WIDTH - EDGE)
  );
  const above = props.anchor.top - HEIGHT - GAP;
  // Below only when above would be off-screen — the selection's own line then sits between
  // the toolbar and the text it belongs to, which reads as the toolbar having detached.
  const top = above < EDGE ? props.anchor.top + 24 : above;
  return { left, top };
});
</script>

<template>
  <Teleport to="body">
    <div
      class="note-toolbar"
      data-testid="note-toolbar"
      role="toolbar"
      :aria-label="t('notes.toolbar.label')"
      :style="{ left: `${position.left}px`, top: `${position.top}px` }"
      @mousedown.prevent
    >
      <button
        type="button"
        class="note-toolbar-btn"
        data-testid="note-toolbar-annotate"
        @click="emit('pick', 'annotation')"
      >
        <Icon name="marker" />
        <span>{{ t("notes.toolbar.annotate") }}</span>
      </button>
      <button
        type="button"
        class="note-toolbar-btn"
        data-testid="note-toolbar-note"
        @click="emit('pick', 'note')"
      >
        <Icon name="note" />
        <span>{{ t("notes.toolbar.note") }}</span>
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.note-toolbar {
  position: fixed;
  z-index: var(--z-popover);
  width: 172px;
  height: 34px;
  display: flex;
  align-items: stretch;
  gap: var(--space-1);
  padding: var(--space-1);
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-popover);
  /* The toolbar is chrome over a selection, so a drag starting on it must not extend the
     selection underneath. The handler's `preventDefault` handles the press; this keeps the
     text from being picked up by a double click. */
  user-select: none;
}
.note-toolbar-btn {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  border: 0;
  background: transparent;
  color: var(--text-2);
  border-radius: var(--radius-sm);
  font-family: inherit;
  font-size: var(--fs-2);
  cursor: pointer;
  transition: background var(--dur-fast), color var(--dur-fast);
}
.note-toolbar-btn:hover {
  background: var(--panel-2);
  color: var(--text);
}
</style>
