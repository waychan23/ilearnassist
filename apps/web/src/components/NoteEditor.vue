<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { NoteType } from "@ilearnassist/shared";
import { NOTE_TYPES } from "@ilearnassist/shared";
import { confirm } from "../composables/confirm";
import type { NoteEditorDraft } from "../composables/messageNotes";
import Icon from "./Icon.vue";

/**
 * The note window: one annotation, one body, and the actions on them.
 *
 * Not a modal, deliberately. A dialog with a scrim would take the conversation away to ask
 * about a sentence in it — the annotated text is the context for what is being written, so it
 * has to stay readable and the message list behind stays live. It floats near whatever it was
 * opened from (the selection, or the row in the panel) and is clamped to the viewport rather
 * than centred, which is what makes "near the thing you pointed at" survive a card that is
 * taller than the space below it.
 *
 * It owns no data and knows nothing about notes as records: `save` and `remove` are handed in
 * with the draft. That is what lets the message list render it without knowing that a notes
 * widget exists, and lets one component serve both entry points.
 *
 * **Rendered by `ChatView`, once.** Its two entry points are the panel's list and the
 * floating bar over a selection, and they are the same window — a second copy would be a
 * second place for the type selector to be spelled differently.
 */
const props = defineProps<{
  draft: NoteEditorDraft;
  /** Where 定位 goes, or null when there is nowhere to go. */
  locate: { noteId: string; messageId: string } | null;
  /** Where to float, in viewport coordinates. Absent docks it to the bottom-right. */
  anchor?: { x: number; y: number } | null;
  /** A save is in flight — the buttons are held, not disabled away. */
  busy?: boolean;
}>();

const emit = defineEmits<{
  save: [input: { type: NoteType; content: string }];
  remove: [];
  locate: [];
  close: [];
}>();

const { t } = useI18n();

const type = ref<NoteType>(props.draft.type);
const content = ref(props.draft.content);
const card = ref<HTMLElement | null>(null);

/** Whether the note exists yet. A create has nothing to delete until it is saved. */
const existing = computed(() => !!props.draft.noteId);

/**
 * Whether there is anything to lose by closing.
 *
 * Every close path goes through this — the X, Escape, and the panel switching away — because
 * a typed body lost by a stray click is worse than one extra question.
 */
const dirty = computed(
  () => type.value !== props.draft.type || content.value !== props.draft.content
);

/* -------------------------------- placement -------------------------------- */

const position = ref<{ left: number; top: number } | null>(null);

/**
 * Float near the anchor, or dock to the corner.
 *
 * Measured rather than assumed: the card's height depends on how long the quote and the body
 * are, and flipping a card up because it *would* have overflowed is only possible once it has
 * a height. A first paint at the un-flipped spot is therefore corrected in the same tick,
 * before the browser has painted, so nothing flickers.
 */
function place(): void {
  const el = card.value;
  if (!el) return;
  const gap = 12;
  const { offsetWidth: width, offsetHeight: height } = el;
  const anchor = props.anchor;

  if (!anchor) {
    position.value = {
      left: Math.max(gap, window.innerWidth - width - gap),
      top: Math.max(gap, window.innerHeight - height - gap),
    };
    return;
  }

  const left =
    anchor.x + gap + width > window.innerWidth - gap
      ? Math.max(gap, anchor.x - width - gap)
      : anchor.x + gap;
  const top =
    anchor.y + gap + height > window.innerHeight - gap
      ? Math.max(gap, anchor.y - height - gap)
      : anchor.y + gap;
  position.value = { left, top };
}

watch(
  () => [props.anchor, props.draft],
  () => void nextTick(place),
  { immediate: true }
);

function onResize(): void {
  place();
}

onMounted(() => {
  window.addEventListener("resize", onResize);
  // Both of these need the element, which the `immediate` placement watcher ran too early to
  // have: without the second `place` the card would keep `position: null` and render at the
  // top-left of the page rather than near anything.
  void nextTick(() => {
    place();
    // Focus the body: the window exists because there is something to write, and the type
    // selector is already at its default.
    card.value?.querySelector("textarea")?.focus();
  });
});
onBeforeUnmount(() => window.removeEventListener("resize", onResize));

/* --------------------------------- actions --------------------------------- */

function submit(): void {
  emit("save", { type: type.value, content: content.value });
}

async function close(): Promise<void> {
  if (dirty.value) {
    const ok = await confirm({
      title: t("notes.editor.discardTitle"),
      message: t("notes.editor.discardMessage"),
      confirmText: t("notes.editor.discardAction"),
      danger: true,
    });
    if (!ok) return;
  }
  emit("close");
}

async function remove(): Promise<void> {
  const ok = await confirm({
    title: t("notes.remove.title"),
    message: t("notes.remove.message"),
    detail: t("notes.remove.detail"),
    confirmText: t("notes.remove.action"),
    danger: true,
  });
  if (ok) emit("remove");
}

/**
 * Escape closes, but only when this card holds the focus.
 *
 * Three overlays listen for Escape; the other two already assert their own claim to it, and
 * a window-level listener that closed this card from anywhere would make Escape ambiguous
 * whenever a dialog is open on top.
 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
  if (!card.value?.contains(document.activeElement)) return;
  event.stopPropagation();
  void close();
}

/** The four type labels. Literal keys per case, the `widgetLabel` discipline. */
function typeLabel(candidate: NoteType): string {
  switch (candidate) {
    case "annotation":
      return t("notes.types.annotation");
    case "idea":
      return t("notes.types.idea");
    case "question":
      return t("notes.types.question");
    case "other":
      return t("notes.types.other");
  }
}
</script>

<template>
  <Teleport to="body">
    <div
      ref="card"
      class="note-editor"
      data-testid="note-editor"
      role="group"
      :aria-label="t('notes.editor.title')"
      :style="position ? { left: `${position.left}px`, top: `${position.top}px` } : undefined"
      @keydown="onKeydown"
    >
      <div class="note-editor-head">
        <span class="note-editor-title" data-testid="note-editor-title">
          {{ existing ? t("notes.editor.editTitle") : t("notes.editor.newTitle") }}
        </span>
        <button
          type="button"
          class="icon-btn"
          data-testid="note-editor-close"
          :title="t('common.close')"
          :aria-label="t('common.close')"
          @click="close"
        >
          <Icon name="close" />
        </button>
      </div>

      <!-- Only when something was annotated: a note the user typed has no original. -->
      <div v-if="draft.quote" class="field">
        <label>{{ t("notes.editor.quoteLabel") }}</label>
        <p class="note-quote clamp-4" data-testid="note-editor-quote">{{ draft.quote }}</p>
      </div>

      <div class="field">
        <label for="note-editor-content">{{ t("notes.editor.contentLabel") }}</label>
        <textarea
          id="note-editor-content"
          v-model="content"
          class="input note-body"
          data-testid="note-editor-content"
          rows="5"
          :placeholder="t('notes.editor.contentPlaceholder')"
        ></textarea>
      </div>

      <div class="field">
        <label>{{ t("notes.editor.typeLabel") }}</label>
        <div class="segmented" role="group" :aria-label="t('notes.editor.typeLabel')">
          <button
            v-for="candidate in NOTE_TYPES"
            :key="candidate"
            type="button"
            class="segment"
            :aria-pressed="type === candidate"
            :data-testid="`note-type-${candidate}`"
            @click="type = candidate"
          >
            {{ typeLabel(candidate) }}
          </button>
        </div>
      </div>

      <div class="note-editor-actions">
        <button
          type="button"
          class="btn primary"
          data-testid="note-editor-save"
          :disabled="busy"
          @click="submit"
        >
          {{ busy ? t("notes.editor.saving") : t("notes.editor.save") }}
        </button>
        <button
          v-if="locate"
          type="button"
          class="btn"
          data-testid="note-editor-locate"
          @click="emit('locate')"
        >
          <Icon name="target" /> {{ t("notes.editor.locate") }}
        </button>
        <button
          v-if="existing"
          type="button"
          class="btn danger"
          data-testid="note-editor-remove"
          @click="remove"
        >
          <Icon name="trash" />
        </button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/*
 * A floating card, not a modal: no scrim, `--z-popover` (above the page, below every dialog
 * and the mobile drawer), and `position: fixed` so the coordinates the placement math works
 * in are the ones it is drawn in.
 */
.note-editor {
  position: fixed;
  z-index: var(--z-popover);
  width: 340px;
  max-width: calc(100vw - var(--space-8) * 2);
  /* Capped rather than scrollable as a whole: the body field scrolls, so the actions stay
     reachable however long the note gets. */
  max-height: calc(100vh - var(--space-8) * 2);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  padding: var(--space-6);
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-popover);
}
.note-editor-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
}
.note-editor-title {
  font-size: var(--fs-3);
  color: var(--text-2);
}
.note-quote {
  margin: 0;
  padding: var(--space-3) var(--space-4);
  background: var(--panel-2);
  border-radius: var(--radius-sm);
  border-left: 2px solid var(--accent);
  font-size: var(--fs-3);
  color: var(--text-2);
}
/* The body grows, the card follows: a long note is written in a long box. */
.note-body {
  font-family: inherit;
  resize: vertical;
  min-height: 5.5em;
}
.note-editor-actions {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}
.note-editor-actions .btn.danger {
  margin-left: auto;
}
</style>
