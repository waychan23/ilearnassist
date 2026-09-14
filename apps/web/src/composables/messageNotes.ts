import { computed, ref } from "vue";
import type { NoteType, WidgetId } from "@ilearnassist/shared";
import type { NoteHighlightMark } from "../utils/noteAnchor";

/**
 * The contract between the message list and whichever widget is allowed to mark it up.
 *
 * The two sides are deliberately ignorant of each other. The message list knows how to
 * notice a selection, draw a highlight and show a window — and nothing about notes as
 * records, the API, or even the id of the widget that wants them. The widget knows about
 * notes as records and nothing about `Range`, `<mark>` or the editor's markup. This module
 * is the whole of what they share, and it is a module singleton rather than a store for the
 * reason `widgetEvents.ts` is: nothing here belongs to `stores/app.ts`, and importing it
 * would put a second Pinia store in the middle of an import cycle that already exists.
 *
 * **Only one widget controls the message list at a time.** That is a rule rather than a
 * present constraint — with one notes widget in the registry and `DEFAULT_WIDGET_IDS` empty,
 * two claimants cannot exist today — and it is kept as a claim with a refusal so that a
 * second one gets told, rather than the two of them racing to draw over each other.
 *
 * The claim is per **session**, not per widget: the message list on screen belongs to one
 * conversation, while the same widget is installed in a different set of them. A claim that
 * said only "notes controls this" would offer the toolbar in a conversation whose panel was
 * never installed.
 *
 * Registration order does not matter. The host registers on mount and the widget claims on
 * install, in whichever order those happen, because the host reads the claim rather than
 * being told about it — see `noteClaim`.
 */

/** Where a selection was made, and what to do with it. */
export interface NoteCapture {
  sessionId: string;
  messageId: string;
  /** The selected text, verbatim, as the message renders it. */
  quote: string;
  /** Which occurrence of that text, counted over the message's visible content. */
  occurrence: number;
  /** The quick action marks it straight off; the other opens the window first. */
  intent: "annotation" | "note";
}

/** What the window shows before anything is edited. */
export interface NoteEditorDraft {
  /** Absent for a note that does not exist yet — what "save" turns into a create. */
  noteId?: string;
  /** The annotated text, shown read-only. Empty when there is no annotation. */
  quote: string;
  type: NoteType;
  content: string;
}

/** Where the window's 定位 goes. */
export interface NoteRevealTarget {
  noteId: string;
  messageId: string;
}

/** The two fields the window edits. */
export interface NoteSaveInput {
  type: NoteType;
  content: string;
}

/**
 * One open window, plus what its buttons do.
 *
 * The actions travel with the request rather than being looked up by the host, because the
 * host is the message list: it renders the window without knowing that notes are stored
 * anywhere, let alone how.
 */
export interface NoteEditorRequest {
  draft: NoteEditorDraft;
  /** Null when there is nowhere to go back to — no annotation, or a message since deleted. */
  locate: NoteRevealTarget | null;
  /**
   * Where to float, in viewport coordinates — supplied by whoever opened the window, because
   * only they know: the message list has the selection's rect, the panel has the row's.
   * Absent or null docks the card to the corner, which is what the panel's own "new note"
   * button gets, having nothing it was pointed at.
   */
  anchor?: { x: number; y: number } | null;
  /**
   * Persist the edit. **Resolves whether it worked**, and the host closes the window on
   * `true` and keeps it open on `false` — a failure means the words are still only in the
   * window, so closing it would throw them away at the exact moment they are most wanted.
   */
  save(input: NoteSaveInput): Promise<boolean>;
  /** Absent for a note that does not exist yet. Same true/false contract as `save`. */
  remove?(): Promise<boolean>;
}

/**
 * What the message list must be able to do, implemented by `ChatView.vue`.
 *
 * `setHighlights` replaces the whole set rather than adding to it: the panel recomputes from
 * its list on every change, and an incrementally-updated DOM is how marks survive a delete.
 */
export interface MessageNotesHost {
  setHighlights(marks: readonly NoteHighlightMark[]): void;
  reveal(target: NoteRevealTarget): void;
  openEditor(request: NoteEditorRequest): void;
}

/**
 * What the message list tells the widget about.
 *
 * Two ways in, and they are the two things a reader can do to a marked-up message: act on a
 * selection, or click a highlight they already made. Both arrive here rather than being
 * resolved by the message list, which is what keeps it from knowing that a highlight is a
 * note at all — it knows a `data-note-id` and hands it over.
 */
export interface MessageNotesController {
  capture(capture: NoteCapture): void;
  /** The reader clicked an existing highlight. */
  open(noteId: string): void;
}

/** A claim that was refused, naming the widget that got there first. */
export interface ClaimRefusal {
  ok: false;
  heldBy: WidgetId;
}

export type ClaimResult = { ok: true } | ClaimRefusal;

interface Claim {
  widgetId: WidgetId;
  sessionId: string;
  controller: MessageNotesController;
}

let host: MessageNotesHost | null = null;
const claim = ref<Claim | null>(null);

/**
 * The claim, as a reactive value.
 *
 * The host reads this to decide whether its marking-up UI exists at all, which is what makes
 * the two orders equivalent: a widget that claimed while the chat view was unmounted (the
 * session settings dialog, or the app starting on the workspace home) is found by the host
 * when it mounts, and one that mounts first is told by this ref changing.
 */
export const noteClaim = computed(() =>
  claim.value ? { widgetId: claim.value.widgetId, sessionId: claim.value.sessionId } : null
);

/** Whether the notes capability is live for a conversation. */
export function isMessageNotesActive(sessionId: string | null | undefined): boolean {
  return !!sessionId && claim.value?.sessionId === sessionId;
}

/** Hand the message list's side of the contract over. Returns the way to take it back. */
export function registerMessageNotesHost(next: MessageNotesHost): () => void {
  host = next;
  return () => {
    if (host === next) host = null;
  };
}

/**
 * Take control of the message list for one conversation.
 *
 * Re-claiming as the same widget is how a session switch moves the claim: the widget owns
 * its own claim, so the rule to enforce is only that nobody else's is taken from them.
 */
export function claimMessageNotes(
  widgetId: WidgetId,
  sessionId: string,
  controller: MessageNotesController
): ClaimResult {
  if (claim.value && claim.value.widgetId !== widgetId) {
    return { ok: false, heldBy: claim.value.widgetId };
  }
  claim.value = { widgetId, sessionId, controller };
  return { ok: true };
}

/** Give it up. A release from anyone but the holder does nothing. */
export function releaseMessageNotes(widgetId: WidgetId): void {
  if (claim.value?.widgetId === widgetId) claim.value = null;
}

/**
 * Route a selection's action to whoever claimed the conversation.
 *
 * Refused rather than queued when the capture is for a conversation the claim does not name:
 * the selection outlives the session switch by a tick, and a note filed against whichever
 * conversation is now on screen is one filed in the wrong place.
 */
export function captureMessageNote(capture: NoteCapture): void {
  const current = claim.value;
  if (!current || current.sessionId !== capture.sessionId) return;
  current.controller.capture(capture);
}

/**
 * A click on an existing highlight.
 *
 * Unlike a capture this carries no session — a highlight is only ever drawn for a
 * conversation the claim covers, so the id already came from the right one.
 */
export function openNoteFromHighlight(noteId: string): void {
  claim.value?.controller.open(noteId);
}

/* ------------------------------- host operations ------------------------------ */

/** Replace the message list's highlights. A no-op with no host — nobody is on screen. */
export function setNoteHighlights(marks: readonly NoteHighlightMark[]): void {
  host?.setHighlights(marks);
}

/** Scroll to a note's message and flash it. */
export function revealNote(target: NoteRevealTarget): void {
  host?.reveal(target);
}

/** Show the note window. */
export function requestNoteEditor(request: NoteEditorRequest): void {
  host?.openEditor(request);
}

/** Test seam: drop the host and the claim. */
export function resetMessageNotes(): void {
  host = null;
  claim.value = null;
}
