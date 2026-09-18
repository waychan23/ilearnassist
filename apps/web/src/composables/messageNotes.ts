import { computed, ref } from "vue";
import type { NoteTargetKindChoice, NoteType, WidgetId } from "@ilearnassist/shared";
import type { NoteHighlightMark } from "../utils/noteAnchor";
import type { IconName } from "../utils/icons";

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
 * present constraint — with one notes widget in the registry,
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
  /**
   * Which button was pressed — the `SelectionAction.id` itself, passed through unchanged.
   *
   * A plain string, and the looseness is the honest shape rather than a shortcut: the ids belong
   * to whichever widget offered the buttons, so the host has no union to narrow to and *must not*
   * have one — a union here would be the message list learning a capability's vocabulary, and the
   * first widget with a third button would edit the message list. What narrows it is the
   * receiving side: `notes.ts` refuses an id it does not recognise, which is the same rule the
   * server applies to a request field it cannot interpret.
   */
  intent: string;
}

/** What the window shows before anything is edited. */
export interface NoteEditorDraft {
  /** Absent for a note that does not exist yet — what "save" turns into a create. */
  noteId?: string;
  /** The annotated text, shown read-only. Empty when there is no annotation. */
  quote: string;
  type: NoteType;
  content: string;
  /**
   * What the note is about, when it is an object rather than a passage.
   *
   * It sits beside `quote` rather than replacing it because the two are alternatives, not a
   * pair: a note names one thing, and which kind of thing that is decides which of these is
   * filled in. `label` is what the window shows — the object's name, already canonical, since
   * the server is what resolves a note's target and hands it back.
   */
  target?: NoteObjectNote;
}

/**
 * An object a note can be written about.
 *
 * Three kinds and one shape, because the three differ in how they are *resolved* and not in how
 * they are held: `kind` names the table to look in and `ref` is the handle the server stores, so
 * the two are one value travelling together — a ref without a kind cannot be resolved, since
 * `diagramFileName`, `tableName` and a resource lookup would each claim it.
 */
/**
 * The mark beside an object kind, wherever one is named.
 *
 * A `switch` with a `never` arm rather than a ternary, which is the lesson this union already
 * taught once: the template in `NoteEditor` compared against `"diagram"` and fell through to a
 * table icon for everything else, so widening the union to three kinds silently gave every
 * resource note a table's icon. A fourth kind is now a compile error at each site that names one.
 */
export function targetKindIcon(kind: NoteTargetKindChoice): IconName {
  switch (kind) {
    case "diagram":
      return "diagram";
    case "table":
      return "table";
    case "resource":
      return "file";
  }
}

export interface NoteObjectNote {
  kind: NoteTargetKindChoice;
  /** The handle: a figure's canonical name, or a resource's reference id. */
  ref: string;
  /** What the window and the panel row show. Display only. */
  label: string;
  /**
   * The object's own title or summary, when the caller has one to hand.
   *
   * Written into the note's 标注原文, which an object note otherwise has nothing to put there —
   * and a 标注 with nothing in that field is the shape `NoteEditor`'s type strip refuses to
   * offer. A snapshot: the panel prefers a live lookup while the target is still there, and
   * falls back to this once it is gone.
   */
  summary?: string;
  /**
   * The server says this object is gone — the note survives, the thing it names does not.
   *
   * Carried so the window can draw its 标注对象 as a **sentence** rather than a control: the two
   * read the same and mean opposite things, and only the note knows which. Absent means "there is
   * something to open", which is the honest default for a note being written.
   */
  missing?: boolean;
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
 * One button on the bar that floats over a selection.
 *
 * The bar belongs to the conversation and its buttons come from two sides: the message list's own
 * actions, which exist whether or not anything claimed the conversation, and the ones the
 * claiming widget offers. Both are this shape, deliberately — they are the same control with the
 * same behaviour, and a distinct type for each would be inventing a hierarchy the reader has no
 * reason to see.
 *
 * **`label` arrives translated, not as a key.** A widget that offers an action is a non-component
 * module, so it reaches the catalog through `i18n.global.t` and has to name its keys *literally*
 * there — a `labelKey` the host then resolved would be a key no scan can see, and
 * `catalog.test.ts` reports an unreachable key as dead, which is exactly what it is. The same
 * applies to `disabledReason`.
 */
export interface SelectionAction {
  /** Becomes the button's test id: `note-toolbar-${id}`. */
  id: string;
  /** The ready-to-render label. */
  label: string;
  icon: IconName;
  /**
   * Whether the action can be taken right now.
   *
   * Per action rather than per bar, and this is a correctness point rather than a nicety: the
   * notes widget's actions are refused while another client holds the conversation *and* the
   * host's own may be refused for a reason of its own, so one flag for the strip would have to
   * pick one of them and be wrong about the other.
   */
  disabled?: boolean;
  /** Why it is disabled, ready to render. Shown as the button's `title`. */
  disabledReason?: string;
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
  /**
   * The buttons this widget contributes to the selection bar, **asked for on every render**.
   *
   * A function rather than a list, and the difference is what an action's `disabled` means: the
   * notes widget derives it from its own writability, which changes while the claim stands — a
   * lease taken by another client, released, taken again. A list captured at claim time would
   * freeze the bar on whatever was true when the panel was installed.
   */
  actions(): SelectionAction[];
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

/**
 * What the claiming widget contributes to the bar over a selection, right now.
 *
 * A read of the claim rather than a subscription, the same shape `noteClaim` has and for the same
 * reason: the host composes the bar during render, so there is nothing to be told about and no
 * ordering to get wrong. Empty when nothing claimed — which is what makes the bar absent rather
 * than empty in a conversation no widget controls.
 */
export function currentSelectionActions(): SelectionAction[] {
  return claim.value?.controller.actions() ?? [];
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
