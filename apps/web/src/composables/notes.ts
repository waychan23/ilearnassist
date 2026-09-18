import { computed, ref, watch } from "vue";
import type { CreateNoteInput, Note, NoteType } from "@ilearnassist/shared";
import { NOTE_QUOTE_MAX } from "@ilearnassist/shared";
import { api } from "../api/client";
import { i18n } from "../i18n";
import { useAppStore } from "../stores/app";
import {
  claimMessageNotes,
  isMessageNotesActive,
  releaseMessageNotes,
  requestNoteEditor,
  setNoteHighlights,
  type ClaimResult,
  type NoteCapture,
  type NoteEditorRequest,
  type NoteObjectNote,
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
 * Whether a note can be filed at all from where the reader is standing.
 *
 * The capability has two owners: `notes.ts` holds the records, but the **window** that writes them
 * is rendered by `ChatView` — so with the notes widget not installed there is no host, and
 * `requestNoteEditor` is a no-op. Every control outside the panel that offers 标注/笔记 therefore
 * has to ask this first, or it is a button that renders and does nothing, which is the failure this
 * repository names most often.
 *
 * A `computed` reading a module singleton rather than a store value, so a control gated on it
 * appears and disappears with the install without anything having to be re-rendered by hand.
 */
export const canAnnotate = computed(() => isMessageNotesActive(useAppStore().activeSessionId));

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
 * What a bar button says.
 *
 * A `switch` over the closed pair with a literal `t("…")` per case, the shape `registry.ts`'s
 * `widgetLabel` and `DiagramWidget`'s `kindLabel` follow, and it is the *only* shape that works
 * here: this is a non-component module, so it translates through `i18n.global`, and
 * `catalog.test.ts` finds the keys a module uses by scanning for `t("…")`. Returning a key for
 * the host to resolve would leave both keys referenced by nothing the scan can see, and it would
 * report them as dead — correctly, since nothing would be naming them.
 */
function toolbarLabel(action: "annotate" | "note"): string {
  switch (action) {
    case "annotate":
      return i18n.global.t("notes.toolbar.annotate");
    case "note":
      return i18n.global.t("notes.toolbar.note");
  }
}

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
    /*
     * What this widget adds to the bar over a selection — the two things a marked passage can
     * become, which is what the capability *is*.
     *
     * A function, and it reads `writable` each time it is called: the flag changes while the claim
     * stands (another client takes the lease, releases it, takes it again), so a list frozen at
     * claim time would leave both buttons live in a conversation this client cannot write to — and
     * the press would fail with nothing on screen to say why. `disabledReason` rather than a bare
     * disable, so the reason is in the button's title, the same "say which reason it is" the
     * panel's own add button follows.
     */
    actions: () => [
      {
        id: "annotate",
        label: toolbarLabel("annotate"),
        icon: "marker",
        disabled: !writable.value,
        disabledReason: i18n.global.t("lock.other"),
      },
      {
        id: "note",
        label: toolbarLabel("note"),
        icon: "note",
        disabled: !writable.value,
        disabledReason: i18n.global.t("lock.other"),
      },
    ],
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
 *
 * The `intent` is matched against this widget's **own** action ids and an unknown one is refused
 * rather than falling through to the default. That refusal is the whole reason the field is a
 * string: the host passes the id through without interpreting it, so this is the only place that
 * knows which ids exist — and a fall-through would file a 标注 for a button this widget never
 * drew, which is a note the reader did not ask for.
 */
async function handleCapture(capture: NoteCapture): Promise<void> {
  if (capture.intent === "note") {
    openEditorForCapture(capture);
    return;
  }
  if (capture.intent !== "annotate") return;
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
    draft: {
      noteId: note.id,
      quote: note.quote,
      type: note.type,
      content: note.content,
      // Read-only context, not an editable field: `update` sends only the type and the body, so
      // a note that has been saved always still points at what it was written about. Showing it
      // is what keeps the window from being the one place that has forgotten.
      ...(note.targetKind !== "text" && note.targetRef !== null
        ? {
            target: {
              kind: note.targetKind as NoteObjectNote["kind"],
              ref: note.targetRef,
              label: note.targetRef,
            },
          }
        : {}),
    },
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

/**
 * The window over an object — a 图, a 表, or the material the conversation works from.
 *
 * Built here rather than by the caller because an object note is a *note* — it goes through the
 * same `create`, the same claim and the same writability as any other — and the panel that draws
 * the object should not have to know how one is stored. What the caller supplies is the only
 * thing it knows and this module does not: which object the reader pointed at, what it is called,
 * and where on screen they pointed at it.
 *
 * `type` starts at `annotation`, which is what the button that opens this window is called: a
 * note made by pressing 标注/笔记 on an object *is* a mark on that object, the same act as
 * dragging over a sentence. (It started at `idea` while 图 and 表 were the only targets and the
 * window's strip dropped 标注 for them; both halves of that moved together.)
 *
 * `quote` carries the object's title or summary, which is what the 标注原文 holds. It is a
 * snapshot — the panel prefers a live lookup while the object is still there — and it is what
 * makes the note readable on its own. `locate` is null on purpose and for the opposite reason: an
 * object note has no message to scroll to, so 定位 is not offered rather than offered and refused.
 */
export function objectNoteRequest(
  target: NoteObjectNote,
  anchor?: { x: number; y: number } | null
): NoteEditorRequest | null {
  const sessionId = loadedSessionId.value;
  if (!sessionId) return null;
  return {
    draft: { quote: quoteFor(target), type: "annotation", content: "", target },
    locate: null,
    anchor: anchor ?? null,
    save: (input) =>
      create(sessionId, {
        targetKind: target.kind,
        targetRef: target.ref,
        quote: quoteFor(target),
        type: input.type,
        content: input.content,
      }),
  };
}

/**
 * What goes in an object note's 标注原文.
 *
 * The summary first, the title second, because a summary says more about the object than its
 * name does and the field is the one the reader sees beside the note. Clipped to the server's own
 * cap rather than trusted: a summary is model-written prose of no particular length, and a note
 * refused at the create for being too long is a button that does nothing.
 */
function quoteFor(target: NoteObjectNote): string {
  const text = target.summary?.trim() || target.label;
  return text.slice(0, NOTE_QUOTE_MAX);
}

// A claim that moves to another conversation must stop marking the old one's messages, and
// an install while the chat view is unmounted has pushed nothing yet. Watching the loaded
// conversation covers both, and covers nothing that the explicit pushes above already do.
watch(loadedSessionId, () => pushHighlights());
