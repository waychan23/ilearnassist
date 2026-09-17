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
 * **A floating card by default, and a modal only when asked.** Not a dialog, deliberately: one
 * with a scrim would take the conversation away to ask about a sentence in it — the annotated
 * text is the context for what is being written, so it has to stay readable and the message list
 * behind stays live. It floats near whatever it was opened from (the selection, or the row in the
 * panel) and is clamped to the viewport rather than centred, which is what makes "near the thing
 * you pointed at" survive a card that is taller than the space below it.
 *
 * **Landscape, because the note is about the text beside it.** The card is wider than it is tall in
 * both its sizes, and that is a reading of what it is for rather than a taste: the quote, the type
 * and the body are three short things stacked, so height is the dimension that runs out first and
 * width is the one that goes to waste. A portrait card also has to grow downward past the passage
 * it is annotating, which is the one thing it must not cover.
 *
 * The second size is the reader's own choice and is the one case where it *does* cover the page:
 * a note can be long, and a window you deliberately grew is one you asked to give your attention
 * to. So it is the same card in two sizes rather than two components — the type selector, the
 * quote, the body and the actions are identical in both, and a second component would be a second
 * place for all of it to be spelled differently.
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
  /**
   * The conversation is being written to from another client, so this note cannot be saved.
   *
   * A prop rather than something this component works out, on the same rule the notes widget
   * follows: whoever knows about write locks says so, and the component obeys. The window can also
   * be *already open* when a lease changes hands, which is why its buttons react rather than the
   * window being closed from underneath the reader — a draft half-written is not something to
   * throw away because somebody else opened the conversation.
   */
  readOnly?: boolean;
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
 * What kind this note may be — which is not always the whole list.
 *
 * 标注 means "this marks a passage", so offering it for a note with nothing marked is offering a
 * kind that cannot be true of the note being written. The window is opened with no quote in
 * exactly one case — the panel's own 新建笔记 — and that is the case this excludes it from. The
 * four that remain are stances on the material, and none of them needs a passage to be about.
 *
 * The second clause is for a row this window did not create: a note that *is* a 标注 keeps its own
 * kind in the strip even with an empty quote. Only the API can produce that (the server defaults
 * a missing type to `annotation`), and without the clause the strip would show nothing pressed —
 * which reads as a note of no kind rather than as one this window cannot name. A note's own kind
 * being hidden from it would be the worse of the two.
 */
const offeredTypes = computed(() =>
  props.draft.quote || props.draft.type === "annotation"
    ? NOTE_TYPES
    : NOTE_TYPES.filter((candidate) => candidate !== "annotation")
);

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
 * Whether the window has been grown to fill the screen.
 *
 * The card is a floating popover by default, and that is the right default — the annotated text is
 * the context for what is being written, so it stays readable behind the card. But a note can be
 * long, and the floating size is a deliberate compromise rather than a place to write several
 * paragraphs. So the same window has a second size, and this is it: centred, over a scrim, at the
 * **source browser's own width**, because that is the box this app already uses for "a window you
 * read or write a lot in".
 *
 * Not a separate modal component: the two are one window in two sizes, and the type selector, the
 * quote, the body and the actions are identical in both. A second component would be a second
 * place for all of that to be spelled differently.
 */
const maximized = ref(false);

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
  // Nothing to re-place while it is centred: a viewport change moves a maximised window not at
  // all, and `place()` would derive coordinates from the grown box and overwrite the ones the
  // restore is supposed to put back.
  if (maximized.value) return;
  place();
}

/**
 * Restoring re-places rather than merely un-clipping.
 *
 * The coordinates are remembered, so "back where it was" is the default — but the note may have
 * grown while it was large, and a card that no longer fits below its anchor has to flip above it,
 * which is the whole job `place()` does and the reason it measures instead of assuming.
 */
watch(maximized, (on) => {
  if (!on) void nextTick(place);
});

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
  /*
   * Escape backs out one level, which is what it does to anything that has a full-screen state:
   * a maximised note is still being written, and losing the paragraph to a discard prompt because
   * the reader wanted their screen back is the wrong reading of the same key. A second press —
   * now that it is small again — closes.
   */
  if (maximized.value) {
    maximized.value = false;
    return;
  }
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
    case "opinion":
      return t("notes.types.opinion");
    case "other":
      return t("notes.types.other");
  }
}
</script>

<template>
  <Teleport to="body">
    <!--
      The scrim exists only while the window is grown, and it is a *sibling* rather than a parent
      so the card is one element in both sizes: a parent would have to be added and removed around
      it, which re-creates the card and takes the caret with it.

      Clicking it backs out one level, the same reading of the same gesture Escape gets.
    -->
    <div
      v-if="maximized"
      class="note-editor-scrim"
      data-testid="note-editor-scrim"
      aria-hidden="true"
      @click="maximized = false"
    />

    <div
      ref="card"
      class="note-editor"
      :class="{ maximized }"
      data-testid="note-editor"
      role="group"
      :aria-label="t('notes.editor.title')"
      :aria-modal="maximized || undefined"
      :style="
        !maximized && position
          ? { left: `${position.left}px`, top: `${position.top}px` }
          : undefined
      "
      @keydown="onKeydown"
    >
      <div class="note-editor-head">
        <span class="note-editor-title" data-testid="note-editor-title">
          {{ existing ? t("notes.editor.editTitle") : t("notes.editor.newTitle") }}
        </span>
        <!-- The window's pair, in the order the file preview's uses: grow, then dismiss. -->
        <div class="note-editor-window">
          <button
            type="button"
            class="icon-btn"
            data-testid="note-editor-maximize"
            :aria-pressed="maximized"
            :title="maximized ? t('notes.editor.restore') : t('notes.editor.maximize')"
            :aria-label="maximized ? t('notes.editor.restore') : t('notes.editor.maximize')"
            @click="maximized = !maximized"
          >
            <Icon :name="maximized ? 'collapse' : 'expand'" />
          </button>
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
      </div>

      <!-- Kind first: it is the one answer the window wants before the words, and the quote
           and the body below it are both about *this* note, so the label that names what kind
           of note it is belongs above them rather than between them. -->
      <div class="field">
        <label>{{ t("notes.editor.typeLabel") }}</label>
        <div class="segmented" role="group" :aria-label="t('notes.editor.typeLabel')">
          <button
            v-for="candidate in offeredTypes"
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

      <!--
        Only when something was annotated: a note the user typed has no original.

        A quoted passage is bounded and scrolls rather than being clamped. Clamping was the
        original shape and it is the wrong one here: the quote is what the note is *about*, so a
        passage whose end is cut off is the one part of this window the reader most needs and
        cannot reach. The body has its own box and its own scrollbar, so the two do not compete.
      -->
      <div v-if="draft.quote" class="field">
        <label>{{ t("notes.editor.quoteLabel") }}</label>
        <p class="note-quote" data-testid="note-editor-quote">{{ draft.quote }}</p>
      </div>

      <!-- `field-grow` is what takes the room the card's floor and its larger size add: the field
           is the flex item, so growing the textarea inside it would do nothing on its own. -->
      <div class="field field-grow">
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

      <!--
        Delete furthest from the two that keep what is written. The order is what puts the
        destructive control at the far left of a right-aligned row, and the gap after it is
        what makes it not the next thing under the pointer when someone aims at the locate
        button — a mis-click on a dialog that does not close is cheap, and one on delete
        is not.
      -->
      <div class="note-editor-actions">
        <button
          v-if="existing"
          type="button"
          class="btn danger"
          data-testid="note-editor-remove"
          :disabled="readOnly"
          :title="readOnly ? t('lock.other') : t('notes.remove.action')"
          @click="remove"
        >
          <Icon name="trash" />
        </button>
        <span v-if="existing && locate" class="between-danger" aria-hidden="true"></span>
        <!--
          Locate is *not* gated: it scrolls to the message, which is a read. A read-only reader
          still wants to find what they marked.
        -->
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
          type="button"
          class="btn primary"
          data-testid="note-editor-save"
          :disabled="busy || readOnly"
          :title="readOnly ? t('lock.other') : ''"
          @click="submit"
        >
          {{ busy ? t("notes.editor.saving") : t("notes.editor.save") }}
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
  /*
   * Landscape, and the width is the source browser's own rather than a new number: it is the box
   * this app already uses for a window with a body of text in it, and the two are read side by side
   * often enough that agreeing is worth more than a bespoke measurement.
   */
  width: min(560px, calc(100vw - var(--space-8) * 2));
  /*
   * A *floor*, which is what makes this landscape before anything has been typed. The card's rows
   * are a fixed stack of short things — head, kind, quote, body, actions — and their sum is a
   * portrait box that the body field then has to share. The floor is above that sum, so the
   * surplus lands on the body and stays there as the reader types.
   *
   * Not a definite `height`, which would be the same arithmetic at the wrong moment: an empty note
   * would get a tall empty box, and the card's whole premise is that it floats beside the passage
   * rather than over it.
   */
  min-height: min(400px, calc(100vh - var(--space-8) * 2));
  /* The ceiling, and the one that keeps "landscape" true at the far end of the range. */
  max-height: min(520px, calc(100vh - var(--space-8) * 2));
  /*
   * Kept as the last resort rather than removed. It does not engage in the ordinary case — the
   * quote is bounded and the body is the flex item that absorbs the slack — but on a viewport too
   * short to hold the card's own floor it is the only way the actions row stays reachable, and
   * clipping them is the failure that would leave the window with no way out.
   */
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
/* The window's own two, as a pair set apart from the title — the file preview's `.window-actions`
   shape, which is where this app already puts maximise and close. */
.note-editor-window {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
}

/*
 * Grown: the source browser's own box, which is the width this app already uses for a window you
 * read or write a lot in. Centred by the `left/top` + `translate` recipe rather than by the modal
 * overlays' flex centring, because this element is a floating card in its other size and the
 * inline `left`/`top` that positions *it* has to be dropped for a class rule to take over — which
 * is why the binding above goes to `undefined` while maximised.
 *
 * `transform` on a body-teleported element is safe here: the caveat in CLAUDE.md is about giving
 * it to `.app`, which would become the containing block for every `position: fixed` descendant.
 */
.note-editor.maximized {
  width: min(880px, calc(100vw - 2 * var(--space-6)));
  /*
   * A *definite* height, not a `max-height`. The card is a content-sized column, so a maximum
   * gives the body field nothing to grow into — `flex: 1` below has no free space to claim, and
   * the "grown" window comes out the same height it was, with a five-line box in it. This is the
   * source browser's own height for the same reason it uses one.
   */
  height: min(660px, calc(100dvh - 120px));
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  /*
   * Above the mobile drawer (80) so a grown window is not covered by a rail the reader opened
   * before it, and below `--z-confirm` (110) — which is the one that matters, because this
   * window's own Delete button raises a confirmation over it.
   */
  z-index: var(--z-overlay);
}
/*
 * The body gets the room: the card's floor is above the sum of its rows, and this is what claims
 * the difference — in the floating size and in the grown one alike.
 *
 * Both halves are needed. The field is the flex *item* of the card's column, so it is the one
 * that has to claim the free space — `flex: 1` on the textarea alone leaves the space collecting
 * after the actions row, because its parent stayed content-sized. `min-height: 0` is the standard
 * companion: without it a flex item refuses to shrink below its content and the note would push
 * the actions off the bottom instead of scrolling.
 */
.field-grow {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.field-grow .note-body {
  flex: 1;
}
.note-editor-scrim {
  position: fixed;
  inset: 0;
  background: var(--scrim);
  /* One below the grown card, and above the page — the drawer backdrop's own pairing. */
  z-index: var(--z-backdrop);
}
.note-editor-title {
  font-size: var(--fs-3);
  color: var(--text-2);
}
/*
 * Bounded and scrollable, where it used to be clamped to four lines.
 *
 * 7.5em is five lines of `--fs-3` at the body's own line height, rounded to the line: a quote
 * shorter than that is shown whole, and a longer one scrolls rather than losing its end. The same
 * figure `--lh-*` gives a five-line textarea, so the two boxes the window is made of are capped at
 * the same storey count rather than at two numbers that happen to sit near each other.
 */
.note-quote {
  margin: 0;
  padding: var(--space-3) var(--space-4);
  background: var(--panel-2);
  border-radius: var(--radius-sm);
  border-left: 2px solid var(--accent);
  font-size: var(--fs-3);
  color: var(--text-2);
  max-height: 7.5em;
  overflow-y: auto;
  /*
   * A quote is a run of text lifted out of a message, and it arrives with whatever the message
   * had — a URL, a long identifier, a code token. `anywhere` because a single unbreakable run is
   * exactly what would otherwise push the card wider than its own `width`.
   */
  overflow-wrap: anywhere;
}
/*
 * The body's box is set by the card, not by the reader.
 *
 * `resize: vertical` is gone rather than kept: the field above is the flex item that claims the
 * card's free height and the textarea fills it, so a dragged height loses to `flex-basis: 0%` —
 * the handle would move and the box would not. That was already true in the grown size, and
 * promoting the flex pair to the base rule extends it to every size. A control that renders and
 * does nothing is worse than no control, and the maximise button is this window's way to ask for
 * more room.
 */
.note-body {
  font-family: inherit;
  resize: none;
  min-height: 5.5em;
}
.note-editor-actions {
  display: flex;
  align-items: center;
  /* Right-aligned, so the primary action sits where the eye ends and the destructive one is
     as far from it as the row allows. */
  justify-content: flex-end;
  gap: var(--space-4);
}
/* A button's worth of nothing between delete and locate. Its width is the two labelled
   buttons beside it (an icon plus a two-character label at `--fs-3`, plus a button's own
   padding) rounded to the spacing scale, rather than a measured value that would go stale the
   moment a label is translated. */
.note-editor-actions .between-danger {
  width: calc(var(--space-10) * 2);
}
</style>
