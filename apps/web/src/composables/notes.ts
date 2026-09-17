import { ref, watch } from "vue";
import type { CreateNoteInput, Note, NoteType } from "@ilearnassist/shared";
import { api } from "../api/client";
import { useAppStore } from "../stores/app";
import {
  claimMessageNotes,
  isMessageNotesActive,
  releaseMessageNotes,
  requestNoteEditor,
  setNoteHighlights,
  type ClaimResult,
  type NoteCapture,
} from "./messageNotes";
import type { NoteHighlightMark } from "../utils/noteAnchor";

/**
 * The notes widget's data: what the learner marked, and what they wrote about it.
 *
 * A module singleton rather than a Pinia store, on the `widgetPanel.ts` pattern, and for a
 * reason the widget's own component cannot satisfy: **the capability has to work while the
 * component is unmounted.** `WidgetPanel` mounts only the active tab (`:key="active"`), so a
 * learner reading the plan while they annotate would otherwise lose both the marks and the
 * handler that files them. The state therefore lives outside every component, and the
 * component is a view onto it.
 *
 * It is deliberately *not* a second store in `stores/`. `stores/app.ts` imports the widget
 * registry, which imports the widgets, which import the app store — a cycle that survives
 * only because every accessor is called lazily inside a function. `stores/app.ts` also
 * evaluates `defineStore` at module scope, so a sibling store entering that cycle would risk
 * reading it mid-initialisation. Nothing here executes a store call at module scope: the one
 * store import is inside `reportFailure`, which only runs on a failed user action.
 */

const notes = ref<Note[]>([]);
/** Which conversation the list belongs to — a reply that lands after a switch is dropped. */
const loadedSessionId = ref<string | null>(null);
const loading = ref(false);
/** The load failed. Distinct from "loaded and empty", which is the ordinary new panel. */
const failed = ref(false);

export const notesError = failed;

/** The live list, newest first — the order the server answers in. */
export const noteList = notes;

/** A claim that was refused, so the panel can say who holds it instead of silently not working. */
const claimRefusal = ref<ClaimResult | null>(null);
export const notesClaimRefused = claimRefusal;

/**
 * Whether the conversation on screen accepts writes from this client.
 *
 * **Told, not looked up.** It arrives as a parameter on the widget context
 * (`WidgetContext.writable`), set by the registry's `onActive`, and everything in this module and
 * the notes UI obeys it — the panel's add button, the editor's save and delete, the selection
 * toolbar. Nothing on this path reaches into the session's state to find out why, which is what
 * keeps a widget from having to know what a write lock is: the session decides, the widget is told,
 * the widget acts.
 *
 * Defaults to `true`, which is the honest reading of "nothing has told me otherwise yet" — the
 * brief window before the context arrives, where the alternative would be a panel that renders
 * disabled and then enables itself a tick later.
 */
const writable = ref(true);
export const notesWritable = writable;

/** What the widget context says about writing. Called from the registry, never from a component. */
export function setNotesWritable(next: boolean): void {
  writable.value = next;
}

/**
 * A failed user action goes to the toast, not to the panel.
 *
 * The panel is the wrong place for it twice over: the action may have been started from the
 * message list with the panel closed or on another tab, and a failure with nothing on screen
 * is indistinguishable from a button that does nothing. A *load* failure is the opposite
 * case — the user asked for the panel, the panel is where the answer belongs — so that one
 * is `failed` above and never reaches here.
 */
function reportFailure(err: unknown): void {
  useAppStore().setError(err instanceof Error ? err.message : String(err));
}

/* --------------------------------- the list --------------------------------- */

/**
 * Read the conversation's notes.
 *
 * A failure clears the list rather than keeping the old one: the two conversations' notes are
 * different lists, and leaving the previous one on screen under the new conversation's title
 * would be showing one conversation's work as another's.
 */
export async function loadNotes(sessionId: string): Promise<void> {
  loadedSessionId.value = sessionId;
  loading.value = true;
  failed.value = false;
  try {
    const res = await api.listNotes(sessionId);
    if (loadedSessionId.value !== sessionId) return;
    notes.value = res.notes;
  } catch {
    if (loadedSessionId.value !== sessionId) return;
    notes.value = [];
    failed.value = true;
  } finally {
    if (loadedSessionId.value === sessionId) loading.value = false;
  }
  pushHighlights();
}

/** Drop everything — signing out, or leaving the conversation. */
export function resetNotes(): void {
  notes.value = [];
  loadedSessionId.value = null;
  loading.value = false;
  failed.value = false;
  setNoteHighlights([]);
}

/* -------------------------------- the claim --------------------------------- */

/**
 * Take the conversation's marks. Called when the widget is installed for a session and again
 * on every session switch, so the claim follows the panel rather than the other way round.
 */
export function claimNotes(sessionId: string): void {
  // Moving to another conversation empties the list first: two conversations' notes are two
  // lists, and leaving one on screen under the other's title is showing work as somebody
  // else's. A re-claim of the same conversation keeps what is already there.
  if (loadedSessionId.value !== null && loadedSessionId.value !== sessionId) resetNotes();

  const result = claimMessageNotes("notes", sessionId, {
    capture: (capture) => void handleCapture(capture),
    // A clicked highlight is a note the reader already made, so the window opens on it in
    // its saved state rather than on a copy — editing what is there is the whole gesture.
    open: (noteId) => {
      const note = notes.value.find((candidate) => candidate.id === noteId);
      if (note) openNoteEditor(note);
    },
  });
  claimRefusal.value = result.ok ? null : result;
  if (result.ok && loadedSessionId.value !== sessionId) void loadNotes(sessionId);
}

/** Give up the marks and forget the list. */
export function releaseNotes(): void {
  releaseMessageNotes("notes");
  claimRefusal.value = null;
  // Back to the default, because nothing is installed to be forbidden: a read-only flag left
  // standing after the capability went would be a control disabled for no reason.
  writable.value = true;
  resetNotes();
}

/* ------------------------------- highlighting ------------------------------- */

/**
 * Hand the marks to the message list.
 *
 * Every note with an annotation is a mark; everything else about it — the type, the body,
 * whether the message still exists — is the panel's business and not the message list's. A
 * note whose message was deleted is left out: there is nothing to mark on screen, and the
 * quote would otherwise be searched for in whatever text happens to match it.
 */
function pushHighlights(): void {
  const sessionId = loadedSessionId.value;
  if (!sessionId || !isMessageNotesActive(sessionId)) {
    setNoteHighlights([]);
    return;
  }
  setNoteHighlights(
    notes.value
      .filter((note) => note.messageId !== null && !note.messageMissing && note.quote !== "")
      .map<NoteHighlightMark>((note) => ({
        noteId: note.id,
        messageId: note.messageId as string,
        anchor: { quote: note.quote, occurrence: note.occurrence },
      }))
  );
}

/* --------------------------------- writing --------------------------------- */

function replace(updated: Note): void {
  // Newest-first order is the server's and is not affected by an edit, so the note is
  // swapped where it sits rather than re-sorted.
  notes.value = notes.value.map((note) => (note.id === updated.id ? updated : note));
}

async function create(sessionId: string, input: CreateNoteInput): Promise<boolean> {
  try {
    const created = await api.createNote(sessionId, input);
    if (loadedSessionId.value === sessionId) notes.value = [created, ...notes.value];
    else notes.value = [created];
    pushHighlights();
    return true;
  } catch (err) {
    reportFailure(err);
    return false;
  }
}

async function update(
  sessionId: string,
  noteId: string,
  input: { type: NoteType; content: string }
): Promise<boolean> {
  try {
    replace(await api.updateNote(sessionId, noteId, input));
    pushHighlights();
    return true;
  } catch (err) {
    reportFailure(err);
    return false;
  }
}

async function remove(sessionId: string, noteId: string): Promise<boolean> {
  try {
    await api.deleteNote(sessionId, noteId);
    notes.value = notes.value.filter((note) => note.id !== noteId);
    pushHighlights();
    return true;
  } catch (err) {
    reportFailure(err);
    return false;
  }
}

/* --------------------------------- the flows -------------------------------- */

/**
 * The two things a selection can ask for.
 *
 * 标注 files the mark straight off — the whole point of the quick action is that it costs one
 * click, and a window would cost three. 笔记 opens the window first, because the reason to
 * choose it over the quick action is that there is something to say.
 */
async function handleCapture(capture: NoteCapture): Promise<void> {
  if (capture.intent === "note") {
    openEditorForCapture(capture);
    return;
  }
  await create(capture.sessionId, {
    messageId: capture.messageId,
    quote: capture.quote,
    occurrence: capture.occurrence,
    type: "annotation",
  });
}

/**
 * The window over a fresh annotation, before the note exists.
 *
 * `locate` is null because there is nothing to go back to yet — the note is saved first, and
 * the mark appearing behind the window is its own confirmation. Saving closes it.
 */
function openEditorForCapture(capture: NoteCapture): void {
  requestNoteEditor({
    draft: { quote: capture.quote, type: "annotation", content: "" },
    locate: null,
    save: (input) =>
      create(capture.sessionId, {
        messageId: capture.messageId,
        quote: capture.quote,
        occurrence: capture.occurrence,
        type: input.type,
        content: input.content,
      }),
  });
}

/**
 * The window over a note the user picked out of the list, in either state.
 *
 * `anchor` is the row the reader clicked, so the window opens beside the thing that was
 * pointed at rather than somewhere of its own choosing — the same rule the capture flow
 * follows, with the selection in place of the row.
 */
export function openNoteEditor(note: Note, anchor?: { x: number; y: number } | null): void {
  const sessionId = loadedSessionId.value;
  if (!sessionId) return;
  requestNoteEditor({
    draft: { noteId: note.id, quote: note.quote, type: note.type, content: note.content },
    anchor: anchor ?? null,
    // 定位 exists only when there is a place to go: an unanchored note never had one, and a
    // note whose message was deleted has lost it. Both are "no button" rather than a button
    // that does nothing.
    locate:
      note.messageId !== null && !note.messageMissing
        ? { noteId: note.id, messageId: note.messageId }
        : null,
    save: (input) => update(sessionId, note.id, input),
    remove: () => remove(sessionId, note.id),
  });
}

/** The window over a note with no annotation — the list's own "add" button. */
export function openNewNoteEditor(): void {
  const sessionId = loadedSessionId.value;
  if (!sessionId) return;
  requestNoteEditor({
    draft: { quote: "", type: "other", content: "" },
    locate: null,
    // Nothing was pointed at, so the card docks to the corner rather than inventing a place.
    anchor: null,
    save: (input) =>
      create(sessionId, { type: input.type, content: input.content }),
  });
}

// A claim that moves to another conversation must stop marking the old one's messages, and
// an install while the chat view is unmounted has pushed nothing yet. Watching the loaded
// conversation covers both, and covers nothing that the explicit pushes above already do.
watch(loadedSessionId, () => pushHighlights());
