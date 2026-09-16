<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { Note, NoteType } from "@ilearnassist/shared";
import { useAppStore } from "../stores/app";
import {
  claimNotes,
  loadNotes,
  noteList,
  notesClaimRefused,
  notesError,
  openNewNoteEditor,
  openNoteEditor,
} from "../composables/notes";
import Icon from "../components/Icon.vue";

/**
 * The session-scoped notes (笔记) widget.
 *
 * The list half of the feature: everything the learner marked or wrote, newest first, each
 * row opening the same window the message list opens. The list itself is the *only* thing
 * this component owns — the records, the marking-up of messages and the claim on the
 * conversation all live in `composables/notes.ts`, because they have to keep working while
 * another tab is in front and this component is unmounted.
 *
 * A load failure is reported here, with a retry; a failure of something the reader *did* —
 * a save, a delete — goes to the toast instead, since it may have been started from the
 * message list with this panel closed.
 */
const { t } = useI18n();
const store = useAppStore();

const notes = noteList;

const hasSession = computed(() => !!store.activeSession);

/**
 * Whether something else holds the conversation.
 *
 * A boolean rather than the refusal itself, because the message deliberately does not name
 * the other widget: an id is not a word, and reaching for its label would mean importing the
 * registry that imports this component.
 */
const claimed = computed(() => notesClaimRefused.value !== null);

/**
 * A row's text: the note if there is one, otherwise what was annotated.
 *
 * The order is the feature. A bare 标注 has no words of its own, so showing the quote is the
 * only way the row says anything at all; once there *is* a body, that is what the reader is
 * looking for and the quote is context they can get by opening it.
 */
function rowText(note: Note): string {
  return note.content.trim() || note.quote || t("notes.untitled");
}

function typeLabel(type: NoteType): string {
  switch (type) {
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

/**
 * Open a row's note, anchored to the row.
 *
 * The coordinates come from the click rather than from the panel's own box: the window floats
 * beside what was pointed at, and only the event knows where that was. Its clamping puts the
 * card to the *left* of the panel, since there is no room to the right of it.
 */
function openRow(note: Note, event: MouseEvent): void {
  const rect = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect();
  openNoteEditor(note, rect ? { x: rect.left, y: rect.top + rect.height / 2 } : null);
}

function retry(): void {
  const sessionId = store.activeSessionId;
  if (sessionId) void loadNotes(sessionId);
}

/** Re-take the conversation after a refusal — the other widget may since have let go. */
function retryClaim(): void {
  const sessionId = store.activeSessionId;
  if (sessionId) claimNotes(sessionId);
}
</script>

<template>
  <div class="notes-widget" data-testid="widget-notes">
    <div v-if="!hasSession" class="widget-empty">{{ t("widgets.notes.noSession") }}</div>

    <!--
      The claim was refused: something else is marking up this conversation. Said out loud
      rather than shown as an empty list, which is what a silent refusal looks like — and an
      empty list is indistinguishable from "you have not written anything".
    -->
    <div v-else-if="claimed" class="widget-error" data-testid="notes-claimed">
      <span>{{ t("notes.claimedByOther") }}</span>
      <button class="btn small" data-testid="notes-reclaim" @click="retryClaim">
        {{ t("widgets.retry") }}
      </button>
    </div>

    <div v-else-if="notesError" class="widget-error" data-testid="notes-load-error">
      <span>{{ t("widgets.loadFailed") }}</span>
      <button class="btn small" data-testid="notes-retry" @click="retry">
        {{ t("widgets.retry") }}
      </button>
    </div>

    <template v-else>
      <div class="notes-bar">
        <span class="notes-count" data-testid="notes-count">
          {{ t("notes.count", { count: notes.length }, notes.length) }}
        </span>
        <button
          type="button"
          class="icon-btn"
          data-testid="notes-add"
          :title="t('notes.add')"
          :aria-label="t('notes.add')"
          @click="openNewNoteEditor"
        >
          <Icon name="plus" />
        </button>
      </div>

      <div v-if="notes.length === 0" class="widget-empty" data-testid="notes-empty">
        {{ t("notes.empty") }}
      </div>

      <ul v-else class="notes-list" data-testid="notes-list">
        <li v-for="note in notes" :key="note.id">
          <button
            type="button"
            class="note-row"
            :data-testid="`note-row-${note.id}`"
            :title="t('notes.open')"
            @click="openRow(note, $event)"
          >
            <span class="note-row-head">
              <span class="badge" :class="{ muted: note.type === 'other' }">
                {{ typeLabel(note.type) }}
              </span>
              <!--
                A marker for the rows that can be found again. Shown on the row because that is
                the question the reader has before opening one; the action itself lives in the
                window, where there is room to say what it will do.
              -->
              <span
                v-if="note.messageId && !note.messageMissing"
                class="note-locatable"
                :title="t('notes.editor.locate')"
              >
                <Icon name="target" />
              </span>
            </span>
            <span class="note-row-text clamp-2">{{ rowText(note) }}</span>
          </button>
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.notes-widget {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}
.notes-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3) var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--border);
}
.notes-count {
  font-size: var(--fs-2);
  color: var(--text-3);
}
.notes-list {
  list-style: none;
  margin: 0;
  padding: var(--space-3);
  display: grid;
  gap: var(--space-2);
  overflow-y: auto;
  min-height: 0;
}
.note-row {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  width: 100%;
  text-align: left;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: var(--space-3) var(--space-4);
  background: var(--panel-2);
  cursor: pointer;
  font-family: inherit;
  transition: border-color var(--dur-fast), background var(--dur-fast);
}
.note-row:hover {
  border-color: var(--accent);
}
.note-row-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.note-locatable {
  display: inline-flex;
  font-size: var(--fs-2);
  color: var(--text-3);
}
.note-row-text {
  font-size: var(--fs-3);
  color: var(--text);
  line-height: var(--lh-base);
  /* Long unbroken runs — a URL, a formula, a pasted paragraph — must not widen the panel. */
  overflow-wrap: anywhere;
}
</style>
