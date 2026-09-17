<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import Icon from "./Icon.vue";
import {
  noteToolbarPosition,
  toolbarSize,
  type NoteToolbarAnchor,
} from "../utils/noteToolbar";
import type { SelectionAction } from "../composables/messageNotes";

/**
 * What a selection in a message can become, floating beside it.
 *
 * **The bar belongs to the conversation, not to any one widget.** The actions are a prop, and
 * whoever owns the selection composes them: the message list contributes its own, and whichever
 * widget holds the conversation's marking-up capability contributes the rest. That is what lets a
 * second capability be offered here without this component learning about it, and what keeps the
 * numbering of the buttons out of the layout — each button is a row of a `v-for`, so a strip of
 * two and a strip of four differ only in width.
 *
 * **The `mousedown` guard is load-bearing.** Pressing a button collapses the browser's selection —
 * the press moves the caret before the click arrives — so a handler that read the selection would
 * find it empty and the action would be taken against nothing. It is invisible in every test that
 * does not press the button with a real pointer, which is why it is a comment rather than a
 * subtlety.
 *
 * Where the bar goes is `utils/noteToolbar.ts`; this component hands it the anchor, the viewport
 * and its own size, and draws the answer. It is teleported to `body` rather than positioned inside
 * the message list, which scrolls and would carry the bar away with it.
 *
 * The element and test ids keep the `note-` prefix they were born with even though the bar is no
 * longer the notes widget's. `messageSelection.ts` skips a `mouseup` on `[data-testid="note-toolbar"]`
 * — without it the bar is dismissed by the press that was meant to use it — and the browser suite
 * reaches for the same ids. A rename would be three silent ways to break a working control in
 * exchange for a word.
 */
const props = defineProps<{
  /** The selection's bottom-right vertex, and the message list's right edge. Viewport coords. */
  anchor: NoteToolbarAnchor;
  /**
   * The buttons, in order: the host's own first, then whatever the claiming widget offers.
   *
   * A list rather than a set of named slots because the two are not distinguishable kinds of
   * thing — they are the same control with the same behaviour, and drawing them differently would
   * be inventing a hierarchy the user has no reason to see.
   */
  actions: readonly SelectionAction[];
}>();

const emit = defineEmits<{ pick: [id: string] }>();

const { t } = useI18n();

const size = computed(() => toolbarSize(props.actions.length));

const position = computed(() =>
  noteToolbarPosition(
    props.anchor,
    { width: window.innerWidth, height: window.innerHeight },
    size.value
  )
);
</script>

<template>
  <Teleport to="body">
    <div
      class="note-toolbar"
      data-testid="note-toolbar"
      role="toolbar"
      :aria-label="t('notes.toolbar.label')"
      :style="{
        left: `${position.left}px`,
        top: `${position.top}px`,
        width: `${size.width}px`,
        height: `${size.height}px`,
      }"
      @mousedown.prevent
    >
      <button
        v-for="action in actions"
        :key="action.id"
        type="button"
        class="note-toolbar-btn"
        :data-testid="`note-toolbar-${action.id}`"
        :disabled="action.disabled"
        :title="action.disabled ? (action.disabledReason ?? '') : ''"
        @click="emit('pick', action.id)"
      >
        <Icon :name="action.icon" />
        <span>{{ action.label }}</span>
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.note-toolbar {
  position: fixed;
  z-index: var(--z-popover);
  /*
   * The width and the height come from `utils/noteToolbar.ts` as an inline style, because they are
   * derived from how many actions there are and that number is not this component's to know. The
   * clamping there computes with the same size it hands back, so the bar cannot be laid out at one
   * width and dodging edges at another — which is the failure a second copy of the number would
   * produce, visible only at one window width.
   */
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
  /* A label longer than the button's derived width is clipped rather than widening the strip,
     which would put the bar off the edge it just computed its way inside of. */
  overflow: hidden;
  white-space: nowrap;
}
.note-toolbar-btn span {
  overflow: hidden;
  text-overflow: ellipsis;
}
.note-toolbar-btn:hover {
  background: var(--panel-2);
  color: var(--text);
}
.note-toolbar-btn:disabled {
  cursor: default;
  opacity: 0.5;
}
.note-toolbar-btn:disabled:hover {
  background: transparent;
  color: var(--text-2);
}
</style>
