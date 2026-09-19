<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { api } from "../api/client";
import type { QuizQuestionView, TurnReference } from "../api/types";
import { useAppStore } from "../stores/app";
import { isCompact } from "../composables/breakpoints";
import { useScrollFollow } from "../composables/scrollFollow";
import { expandToolGroup } from "../composables/toolCallGroups";
import { subscribeWidgetEvents } from "../composables/widgetEvents";
import {
  closeWidgetDrawer,
  openDrawer,
  openSessionSettings,
  openWidgetDrawer,
  uiState,
} from "../composables/ui";
import { buildMinimapAnchors, type MessageMinimapAnchor } from "../utils/minimap";
import {
  captureMessageNote,
  currentSelectionActions,
  isMessageNotesActive,
  noteClaim,
  openNoteFromHighlight,
  registerMessageNotesHost,
  type NoteEditorRequest,
  type NoteRevealTarget,
  type NoteSaveInput,
  type SelectionAction,
} from "../composables/messageNotes";
import { noteList, notesWritable } from "../composables/notes";
import { useMessageSelection } from "../composables/messageSelection";
import { useWidgetActivation } from "../composables/widgetActivation";
import { useSessionLock } from "../composables/sessionLock";
import { useFigureViewer } from "../composables/figureViewer";
import { NOTE_ROOT_ATTR, rangeForAnchor, type NoteHighlightMark } from "../utils/noteAnchor";
import { kindLabel, messageReference } from "../utils/turnRefs";
import MessageItem from "./MessageItem.vue";
import MessageMinimapRail from "./MessageMinimapRail.vue";
import MessageSelectionToolbar from "./MessageSelectionToolbar.vue";
import NoteEditor from "./NoteEditor.vue";
import Composer from "./Composer.vue";
import TopbarControls from "./TopbarControls.vue";
import DiagramDialog from "./dialogs/DiagramDialog.vue";
import NewSessionDialog from "./dialogs/NewSessionDialog.vue";
import Icon from "./Icon.vue";

const store = useAppStore();
const { t } = useI18n();
const showNewSession = ref(false);
const messagesEl = ref<HTMLElement | null>(null);

/**
 * The widget panel's topbar control, on a compact viewport only.
 *
 * One function rather than an open/close pair, matching `toggleSidebar`: the only control that
 * reaches it is a toggle, and a pair would put the "which one am I" question at the call site,
 * answered by reading the flag the button already renders from.
 */
function toggleWidgetDrawer(): void {
  if (uiState.widgetDrawerOpen) closeWidgetDrawer();
  else openWidgetDrawer();
}

/* ------------------------------- title editing ------------------------------- */
const editingTitle = ref(false);
const titleDraft = ref("");
const titleInput = ref<HTMLInputElement | null>(null);

function startTitleEdit() {
  if (!store.activeSession) return;
  titleDraft.value = store.activeSession.title;
  editingTitle.value = true;
  nextTick(() => {
    titleInput.value?.focus();
    titleInput.value?.select();
  });
}

async function commitTitle() {
  const id = store.activeSessionId;
  const title = titleDraft.value;
  editingTitle.value = false;
  if (!id || !title.trim()) return;
  if (title.trim() === store.activeSession?.title) return;
  await store.renameSession(id, title).catch(() => undefined);
}

function cancelTitleEdit() {
  editingTitle.value = false;
}

/* ------------------------------ minimap rail ------------------------------ */
/** One anchor per user turn, paired with the reply it produced. */
const minimapAnchors = computed(() => buildMinimapAnchors(store.messages));

// Hidden on narrow viewports, matching chatbox — the rail would crowd the messages and
// the preview card would have nowhere to go. `isCompact` is shared with the drawer, which
// needs the same breakpoint: two copies of "900" is how a drawer ends up opening on a
// screen whose toggle is hidden.
const showMinimap = computed(() => !isCompact.value && minimapAnchors.value.length > 0);

/**
 * Scroll the list so `rect` sits `offsetAbove` pixels down from the top of the pane.
 * Computed from rects rather than `offsetTop`, which is measured against whichever ancestor
 * happens to be positioned.
 *
 * Takes the rectangle rather than the element because one caller has no element to point at: a
 * reference to a *passage* is a `Range` inside a message, and the thing to bring on screen is
 * where the words are, not the block they are in.
 */
function scrollToRect(container: HTMLElement, rect: DOMRect, offsetAbove = 8): void {
  const containerRect = container.getBoundingClientRect();
  container.scrollTo({
    top: container.scrollTop + (rect.top - containerRect.top) - offsetAbove,
    behavior: "smooth",
  });
}

function scrollRectIntoView(
  container: HTMLElement,
  target: HTMLElement,
  offsetAbove = 8
): void {
  scrollToRect(container, target.getBoundingClientRect(), offsetAbove);
}

/**
 * How far down the pane a located passage should land: about five lines of its own text.
 *
 * Measured from the element rather than fixed, because "five lines" is a property of the
 * text being pointed at — a heading is a different height from body copy, and a constant
 * would put a one-line note near the top of the pane in one message and halfway down it in
 * another. Pinning a passage to the very top instead reads as the message beginning there, which
 * is the thing a note about the middle of a paragraph must not look like. Two callers, one idea:
 * a note's 定位 flashes its mark and a reference chip scrolls to its quote.
 */
function landingOffset(target: HTMLElement): number {
  const lineHeight = parseFloat(getComputedStyle(target).lineHeight);
  return (Number.isFinite(lineHeight) ? lineHeight : 24) * 5;
}

/** Scroll one persisted message to the top of the list. Shared by the minimap and widgets. */
function scrollToMessage(messageId: string): void {
  const container = messagesEl.value;
  if (!container) return;
  const target = container.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
  if (!target) return;
  scrollRectIntoView(container, target);
}

function jumpToAnchor(anchor: MessageMinimapAnchor) {
  scrollToMessage(anchor.messageId);
}

/**
 * The card for one tool-call id, opening the collapsed run that is hiding it.
 *
 * A run of tool calls renders as one folded card, so its members are *not in the DOM* — and a
 * plan node's start anchor points at one of them. Before this, `定位` on a node that began
 * with bookkeeping calls did nothing at all, silently: the selector found no element and the
 * handler had nothing to scroll to. Turns shaped that way are the ordinary case, since the
 * plan guidance asks for the bookkeeping call before the prose.
 *
 * The group carries its members' ids for exactly this, and they are read out of `dataset`
 * rather than interpolated into a selector — an id is model- and provider-authored text, and
 * a value that reaches `querySelector` as syntax is a selector injection. The re-query has to
 * wait a tick, because the card does not exist until Vue has re-rendered after the expand.
 */
async function revealToolCall(container: HTMLElement, id: string): Promise<HTMLElement | null> {
  const attribute = (value: string): string => `[data-tool-call-id="${value}"]`;

  const direct = container.querySelector<HTMLElement>(attribute(id));
  if (direct) return direct;

  /*
   * A call that renders no card anchors on the message holding it instead — `ila_table`'s table
   * is in the reply, so the block to land on is that block. `~=` matches the id inside the
   * whitespace-separated list `MessageItem` writes, which keeps this to one selector rather than
   * a scan and a `split`.
   */
  const anchored = container.querySelector<HTMLElement>(`[data-tool-call-anchor~="${id}"]`);
  if (anchored) return anchored;

  for (const group of container.querySelectorAll<HTMLElement>("[data-tool-call-ids]")) {
    if (!group.dataset.toolCallIds?.split(" ").includes(id)) continue;
    expandToolGroup(group.dataset.groupKey ?? "");
    await nextTick();
    return container.querySelector<HTMLElement>(attribute(id));
  }
  return null;
}

/**
 * Put one tool-call card on screen, opening the folded run that is hiding it.
 *
 * Two callers, and they arrive by different routes: the widget bus, for a plan node's start
 * anchor or a thread's first message, and the reference chip in a user message, whose quiz
 * question is a call in this conversation. The card is the same card and the reveal is the same
 * work, so it is one function rather than two.
 */
function jumpToToolCall(toolCallId: string): void {
  const container = messagesEl.value;
  if (!container) return;
  // The attribute is on every tool-call card, persisted or currently streaming — but a card
  // inside a collapsed run is not rendered at all, which `revealToolCall` answers.
  void revealToolCall(container, toolCallId).then((target) => {
    if (target) scrollRectIntoView(container, target);
  });
}

// A plan node's start anchor jumps to the exact tool-call card (placed before the node's
// teaching content), which is more precise than scrolling the whole message to the top; a
// thread's heading jumps to its first message row. The widget cannot reach this scroll
// container, which is the one cross-component event the widget bus carries that is not about
// a turn.
onMounted(() => {
  unsubscribeFromWidgets = subscribeWidgetEvents((event) => {
    if (event.type === "chat.jump") {
      jumpToToolCall(event.toolCallId);
    } else if (event.type === "chat.jumpToMessage") {
      scrollToMessage(event.messageId);
    }
  });
});
onBeforeUnmount(() => {
  unsubscribeFromWidgets?.();
  unsubscribeFromWidgets = null;
});
let unsubscribeFromWidgets: (() => void) | null = null;

/**
 * Keeping the viewport at the end is a decision, not a reflex — see `scrollFollow`.
 *
 * It is released by any scroll away from the end, which is what stops a reply being written
 * from dragging a reader back down on every token. The release is also what the return
 * control below is rendered from, so there is always a way back to a moving end.
 */
const { following, onScroll, scrollToBottom, follow } = useScrollFollow(messagesEl);

/**
 * Every shape a growing turn takes: text, chain of thought, a tool call appearing, and a tool
 * call's *output* landing. The last is watched by size rather than by count on purpose —
 * `tool_end` fills in a card that is already in the array, so its length does not change and
 * a watcher on the length alone would sit out the tallest growth of a turn.
 *
 * Growing the list also covers both halves of an exchange arriving — the reader's own bubble,
 * and the persisted assistant message that replaces the streaming one.
 */
watch(
  () => [
    store.messages.length,
    store.streaming.content,
    store.streaming.reasoning,
    store.streaming.toolCalls.length,
    store.streaming.toolCalls.reduce((chars, call) => chars + (call.output?.length ?? 0), 0),
  ],
  () => follow()
);

/**
 * A turn starting is the reader having just sent something — a message, or an answer to a
 * question the agent asked — so go to the end for it even if they had scrolled away. Asking
 * and then not showing the answer would be the release working against the person it is for.
 */
watch(
  () => store.streaming.active,
  (active) => {
    if (active) scrollToBottom();
  }
);

/** Another conversation is a different list, and it opens at its end. */
watch(
  () => store.activeSessionId,
  () => scrollToBottom()
);

/**
 * Tell the installed widgets they are live — `WidgetModule.onActive`.
 *
 * Here rather than in the store because this component is what renders the panel, so its
 * lifetime *is* the answer to "is a widget on screen"; leaving the view is the one
 * transition the effect inside cannot see, and this scope is what reports it.
 */
useWidgetActivation();

/*
 * The session write lock, for as long as this view is on screen.
 *
 * Same reasoning as the line above and the same scope: this component is mounted exactly while a
 * conversation is open inside a workspace, so it is also the answer to "should this client be
 * holding a lock and watching the others" — and leaving is what releases it and stops every
 * check. See `composables/sessionLock.ts`.
 */
useSessionLock();

/* ---------------------------------- notes ---------------------------------- */
/*
 * The message list's half of the notes capability. Everything here is about the DOM — which
 * text is selected, where to draw a mark, where to scroll — and nothing about notes as
 * records: what a capture turns into, and what a window's buttons do, are the widget's, and
 * arrive through the bridge.
 *
 * This is the one place the reader can tell the capability is installed at all. The bridge's
 * claim names the conversation the *widget* controls, and this view is that conversation's
 * message list, so the two agreeing is what puts that widget's buttons in the bar.
 */
const notesActive = computed(() => noteClaim.value?.sessionId === store.activeSessionId);

/*
 * Noticing a selection is the *conversation's* capability, not any widget's: a reader can point at
 * a passage in any conversation, and what may then be done with it is what varies. So the
 * listeners are on whenever a conversation is open, and the bar is what the claim gates — see
 * `selectionActions`.
 */
const { selection, clear: clearSelection } = useMessageSelection(
  messagesEl,
  computed(() => !!store.activeSessionId)
);

/**
 * The buttons the bar carries: **this view's own first**, then whatever a claiming widget offers.
 *
 * The order is a decision rather than an accident. 追问 belongs to the conversation — it works in
 * every one of them, whether or not anything is installed — while a widget's actions are extra
 * things that capability makes possible. Putting the universal one first is what makes the bar
 * readable as "ask about this, or mark it up" rather than as a widget's toolbar that happens to
 * have something else on the left.
 *
 * The host's action is deliberately *not* part of the claim. A conversation with no widget
 * installed has no marking-up and still has 追问; asking the claim for it would make the one
 * universally available gesture disappear with the panel that is not about it.
 *
 * `currentSelectionActions` is a **function** read, so a widget whose own writability changed
 * while the claim stood is reflected here without anything telling this view about it.
 */
const selectionActions = computed<SelectionAction[]>(() => [
  {
    id: "ask",
    label: t("turnRef.ask"),
    icon: "link",
    /*
     * Gated on the session lease, not on `notesWritable`. Staging a reference and sending the turn
     * with it is a *write*, and the gate a write obeys is the server's lock — the flag the notes
     * widget carries means "the notes capability may write here", which is true by default and
     * only meaningful while that widget holds the claim.
     */
    disabled: store.isActiveSessionReadOnly,
    disabledReason: t("lock.other"),
  },
  ...currentSelectionActions(),
]);

/** The marks to draw, as the widget last reported them. */
const noteMarks = ref<readonly NoteHighlightMark[]>([]);

/** The open window, and where it floats. */
const editorRequest = ref<NoteEditorRequest | null>(null);
const editorAnchor = ref<{ x: number; y: number } | null>(null);
const editorBusy = ref(false);

/** The note window's 标注对象 opens through here — see `onEditorOpenTarget`. */
const { viewing, open: openFigure, close: closeFigure } = useFigureViewer();
/**
 * Where the window should open, set by the toolbar just before the capture is routed.
 *
 * A ref rather than an argument because the window is opened *by the widget* — choosing 笔记
 * hands the selection over and the answer comes back through `openEditor`, which is what
 * keeps this view from having to know which intent produced it.
 */
const pendingAnchor = ref<{ x: number; y: number } | null>(null);

function closeEditor(): void {
  editorRequest.value = null;
  editorAnchor.value = null;
}

/** How long the flash runs, in step with the animation in `style.css` (`0.7s × 3` + slack). */
const NOTE_FLASH_MS = 2400;

/**
 * Which flash owns the class, so that locating twice in a row does not have the first
 * timer strip the class off a second flash that is still running.
 */
let flashGeneration = 0;

/**
 * Scroll to a note's *words* and flash them.
 *
 * The mark rather than the message, which is the difference between "this note is somewhere
 * in this reply" and "this note is about this phrase". The message is the fallback, and it is
 * a real one rather than an error path: a quote stops resolving the moment the message it was
 * taken from is rewritten or deleted, and 定位 must still visibly do something.
 */
function revealNote(target: NoteRevealTarget): void {
  const container = messagesEl.value;
  if (!container) return;

  const marks = [...container.querySelectorAll<HTMLElement>(`mark[data-note-id="${target.noteId}"]`)];
  const first = marks[0];
  if (!first) {
    scrollToMessage(target.messageId);
    return;
  }

  scrollRectIntoView(container, first, landingOffset(first));

  const generation = ++flashGeneration;
  for (const mark of marks) mark.classList.add("note-flash");
  setTimeout(() => {
    // A later 定位 restarted the flash; that one's timer owns the class now.
    if (generation !== flashGeneration) return;
    for (const mark of marks) mark.classList.remove("note-flash");
  }, NOTE_FLASH_MS);
}

/**
 * A button on the bar was pressed.
 *
 * Two halves, split by who owns the button. `ask` is this view's own — it stages the passage as a
 * reference for the next turn, which is the conversation's gesture and needs no widget. Everything
 * else is **passed through, not interpreted**: which actions a widget offers and what they mean is
 * that widget's business, and this view's part is to name the selection and say which button was
 * pressed on it. A `switch` over a widget's own ids would be the message list learning a
 * capability's vocabulary one case at a time.
 *
 * What this view does own for both is the *place*: the note window opens off the bar's own corner —
 * the selection's bottom-right vertex, where the reader's eye already is — because that is a fact
 * about the layout, and the widget has never seen the selection's rectangle.
 */
function onToolbarPick(id: string): void {
  const current = selection.value;
  const sessionId = store.activeSessionId;
  if (!current || !sessionId) return;

  if (id === "ask") {
    store.stageReference(messageReference(current));
    // No `pendingAnchor`: nothing opens. The composer takes the caret on its own when a
    // reference arrives — see the watcher there, which every 追问 entry point shares.
    clearSelection();
    return;
  }

  pendingAnchor.value = { x: current.place.right, y: current.place.bottom };
  captureMessageNote({
    sessionId,
    messageId: current.messageId,
    quote: current.anchor.quote,
    occurrence: current.anchor.occurrence,
    intent: id,
  });
  clearSelection();
}

async function onEditorSave(input: NoteSaveInput): Promise<void> {
  const request = editorRequest.value;
  if (!request) return;
  editorBusy.value = true;
  try {
    // Kept open on failure: the words are only in the window, and a failed save is exactly
    // when throwing them away costs the most.
    if (await request.save(input)) closeEditor();
  } finally {
    editorBusy.value = false;
  }
}

async function onEditorRemove(): Promise<void> {
  const request = editorRequest.value;
  if (!request?.remove) return;
  editorBusy.value = true;
  try {
    if (await request.remove()) closeEditor();
  } finally {
    editorBusy.value = false;
  }
}

/** 定位 leaves the window open: the point of it is to read the note against its message. */
function onEditorLocate(): void {
  const request = editorRequest.value;
  if (request?.locate) revealNote(request.locate);
}

/**
 * Ask about the note the window is showing.
 *
 * The reference is built from the *request* rather than from a note row, because the window holds
 * a draft and this view has never seen the note as a record — the whole point of
 * `NoteEditorRequest` is that the message list can show a note window without knowing what a note
 * is. What the draft does carry is the id, and an id is what a note reference is.
 *
 * **Staging only — the window closes itself.** `NoteEditor` emits `ask` and then runs its own
 * guarded `close()`, which is where the discard confirm for unsaved writing lives; routing that
 * through here would be a second close path in a component that has exactly one, and the guard is
 * what keeps a half-written note from being the price of asking a question. The order is
 * deliberate on that side too: the reference is staged before the prompt, so cancelling it leaves
 * the question intact.
 */
function onEditorAsk(): void {
  const request = editorRequest.value;
  const noteId = request?.draft.noteId;
  if (!request || !noteId) return;
  // The same fallback the panel's row makes: a bare 标注 has no body, so the passage it marks is
  // the only thing there is to show.
  store.stageReference({
    kind: "note",
    ref: noteId,
    label: request.draft.content.trim() || request.draft.quote,
  });
}

/**
 * Show the object the note being edited is about.
 *
 * The **window floats and this view owns the viewer**, which is the split the note window's own
 * docblock describes: it knows a draft and nothing about what a figure, a table or a reference
 * *is*, so it emits and this decides. The viewer is the notes panel's own — `useFigureViewer`
 * answers "how do I show one of these" once, and a second answer here would be a second place
 * for the next kind to be forgotten.
 *
 * The window is **not** closed, unlike the one a dialog opens: this is a card over the
 * conversation, so a preview or a table dialog opening behind it is a dialog the reader asked
 * for and can dismiss, with the note still on screen beside it.
 */
function onEditorOpenTarget(): void {
  const target = editorRequest.value?.draft.target;
  if (!target) return;
  void openFigure(target.kind, target.ref, target.label, target.summary);
}

/* --------------------------- opening a reference --------------------------- */

/**
 * Open the detail of something a sent message was about.
 *
 * The `msg-refs` block is a record of the 追问 gesture, and the reader who comes back to it is
 * asking the question the chip could not answer while it was a `div`: *show me that thing*. So
 * every kind has a home, and this view is where they meet — the scroll container (a passage, a
 * question's card), the figure viewer (a diagram's file, a table's markdown, a reference's bytes)
 * and the note window's host. `MessageItem` emits the reference unchanged and knows none of it.
 *
 * **A kind that cannot be opened says so, and only where that is reachable.** A note is the one
 * object a reader can delete out from under a chip (and the one kind whose panel may not be
 * installed in this conversation), so its arm reports both. Every other arm either cannot fail —
 * a message's row, a table's row and a diagram's row all outlive the message naming them — or
 * fails through a viewer that already reports it: a missing diagram file opens the preview saying
 * so, and a reference whose row is gone is the figure viewer's own reported lookup.
 */
async function openReference(reference: TurnReference): Promise<void> {
  switch (reference.kind) {
    case "message":
      revealPassage(reference);
      return;
    case "note":
      openReferencedNote(reference);
      return;
    case "quiz":
      await revealQuizQuestion(reference);
      return;
    case "diagram":
    case "table":
    case "resource":
      // The three that have a viewer go through the one implementation of "how do I show one of
      // these" — the notes panel's chip and the note window call the same function, so a fourth
      // kind is answered there and reaches this chip for free.
      await openFigure(reference.kind, reference.ref, reference.label);
      return;
    default: {
      // `reference.kind` rather than `reference`: this is one interface with a union for its
      // discriminant, not a union of interfaces, so only the field narrows to `never`. It is the
      // same guard either way — a seventh kind is a compile error here rather than a chip that
      // offers a control doing nothing.
      const unhandled: never = reference.kind;
      return unhandled;
    }
  }
}

/** A referenced object this conversation no longer holds. Never a press that did nothing. */
function reportGone(reference: TurnReference): void {
  store.setError(t("turnRef.gone", { kind: kindLabel(reference.kind) }));
}

/**
 * Scroll to the passage a reference quoted.
 *
 * The passage and not the message, for `revealNote`'s reason: "somewhere in this reply" and
 * "this phrase in it" are different answers, and a chip is always about the phrase. The quote was
 * measured over the message's *rendered* text by the tab that made it and the server never
 * verified it — see the note on `TurnReference.quote` — so it is re-resolved through the same
 * `rangeForAnchor` a note's anchor goes through, and a quote that no longer resolves falls back
 * to the message rather than to nothing.
 */
function revealPassage(reference: TurnReference): void {
  const container = messagesEl.value;
  if (!container) return;
  // Scanned rather than interpolated into a selector: an id is server-authored text, and a value
  // that reaches `querySelector` as syntax is a selector injection — the rule `revealToolCall`
  // follows. The row is always there: the message list holds every live message, and the one
  // carrying this chip is one of them.
  const row = [...container.querySelectorAll<HTMLElement>("[data-message-id]")].find(
    (element) => element.dataset.messageId === reference.ref
  );
  if (!row) return;
  const root = row.querySelector<HTMLElement>(`[${NOTE_ROOT_ATTR}]`);
  const range =
    root && reference.quote
      ? rangeForAnchor(root, {
          quote: reference.quote,
          occurrence: reference.occurrence ?? 0,
        })
      : null;
  if (range && root) {
    scrollToRect(container, range.getBoundingClientRect(), landingOffset(root));
    return;
  }
  scrollRectIntoView(container, row);
}

/**
 * Open the note a message pointed at, in the window the notes capability writes through.
 *
 * Two ways this can come to nothing, and both are **said out loud**: the note may have been
 * deleted, and the panel that holds the records may not be installed in this conversation at all.
 * A chip is a record of a gesture made in an earlier tab, so unlike the panel's own chip it cannot
 * check either in advance — which is exactly when a press that did nothing reads as a broken app.
 * `openNoteFromHighlight` is the panel's own route by id, so the window opens with the note in its
 * saved state and with the panel's writability, and this view stays out of what a note *is*.
 */
function openReferencedNote(reference: TurnReference): void {
  if (!isMessageNotesActive(store.activeSessionId)) {
    store.setError(t("turnRef.noNotesPanel"));
    return;
  }
  if (!noteList.value.some((note) => note.id === reference.ref)) {
    reportGone(reference);
    return;
  }
  openNoteFromHighlight(reference.ref);
}

/**
 * Put a referenced quiz question's card on screen.
 *
 * The **card**, not a dialog, because that is the shape a question has in this app: a pending one
 * is answered there — which is where the quiz panel's own row sends the reader — and a settled one
 * shows the question, the recorded answer and the verdict. A dialog would be a second surface for
 * something the conversation already draws, and it would exist only while the quiz panel happened
 * to be installed.
 *
 * The lookup is what turns the handle into the call: a reference stores the question's *global*
 * id, the one `ila_review_quiz` takes, and the card is anchored by the tool call that drew it,
 * which is nowhere in the message. A failure here is reported rather than swallowed — the reader
 * pressed a control this app drew.
 */
async function revealQuizQuestion(reference: TurnReference): Promise<void> {
  const sessionId = store.activeSessionId;
  if (!sessionId) return;
  let questions: QuizQuestionView[];
  try {
    ({ questions } = await api.listQuizQuestions(sessionId));
  } catch (e) {
    store.setError(e instanceof Error ? e.message : String(e));
    return;
  }
  // A switch mid-request must not scroll the conversation the reader has moved to.
  if (sessionId !== store.activeSessionId) return;
  const question = questions.find((candidate) => candidate.id === reference.ref);
  if (!question) return;
  jumpToToolCall(question.toolCallId);
}

/**
 * Register the host while this view is up.
 *
 * Deregistering on unmount leaves the claim alone — the widget is still installed, and the
 * messages it marks are still there; what is gone is the DOM to draw them in. A claim made
 * while this view was unmounted is found when it comes back, because the host reads the
 * claim rather than being told about it.
 */
let unregisterNotesHost: (() => void) | null = null;
onMounted(() => {
  unregisterNotesHost = registerMessageNotesHost({
    setHighlights(marks) {
      noteMarks.value = marks;
    },
    reveal: revealNote,
    openEditor(request) {
      editorRequest.value = request;
      // The opener's own anchor wins: a window opened from the panel knows its row, and the
      // selection anchor here is only ever the answer for a capture.
      editorAnchor.value = request.anchor ?? pendingAnchor.value;
      pendingAnchor.value = null;
    },
  });
});
onBeforeUnmount(() => {
  unregisterNotesHost?.();
  unregisterNotesHost = null;
});
</script>

<template>
  <main class="main">
    <header class="topbar">
      <!--
        Only on a compact viewport, which also means no desktop spec can click it by
        accident. `aria-expanded` conveys the state without a second string; `aria-controls`
        needs the id the sidebar carries.
      -->
      <button
        v-if="isCompact"
        class="icon-btn nav-toggle"
        data-testid="nav-toggle"
        :title="t('sidebar.openNav')"
        :aria-label="t('sidebar.openNav')"
        :aria-expanded="uiState.drawerOpen"
        aria-controls="app-sidebar"
        @click="openDrawer"
      >
        <Icon name="menu" />
      </button>

      <div class="title-block">
        <div v-if="editingTitle" class="title-edit">
          <input
            ref="titleInput"
            v-model="titleDraft"
            class="input title-input"
            :placeholder="t('chat.titlePlaceholder')"
            data-testid="chat-title-input"
            @keydown.enter.prevent="commitTitle"
            @keydown.esc.prevent="cancelTitleEdit"
            @blur="commitTitle"
          />
          <span v-if="store.activeSession?.titleSource === 'auto'" class="title-hint">
            {{ t("chat.titleHint") }}
          </span>
        </div>

        <template v-else>
          <div class="title-row">
            <span
              class="title"
              data-testid="session-title"
              :class="{ editable: !!store.activeSession }"
              :title="store.activeSession ? t('chat.editTitleHint') : undefined"
              @click="startTitleEdit"
            >
              {{ store.activeSession?.title || store.activeWorkspace?.name || t("app.title") }}
            </span>
            <!--
              The title *is* the rename control — clicking it opens the inline editor — so
              there is no pencil button beside it. The pencil was a second entry to the same
              editor on the bar's most crowded spot, and the title's own tooltip
              (`chat.editTitleHint`) is where the gesture is taught.

              The parameters button is icon-only, with its word for a screen reader and a
              tooltip, which is where a one-word control belongs.
            -->
            <button
              v-if="store.activeSession"
              class="icon-btn"
              data-testid="chat-session-settings"
              :title="t('sessionSettings.open')"
              :aria-label="t('sessionSettings.open')"
              @click="openSessionSettings()"
            >
              <Icon name="sliders" />
            </button>
            <span
              v-if="store.activeSession?.titleSource === 'auto'"
              class="badge muted"
              :title="t('chat.autoBadgeTitle')"
            >
              AI
            </span>
          </div>
          <!-- Read from the conversation's snapshot, not from the Copilot list: it keeps
               naming the persona after that Copilot is renamed or deleted. -->
          <div
            v-if="store.activeCopilotName"
            class="subtitle truncate"
            :title="store.activeSystemPrompt"
          >
            <Icon name="diamond" /> {{ store.activeCopilotName }}
          </div>
        </template>
      </div>

      <!-- The title block takes the free space, so the actions land on the right. -->
      <TopbarControls />

      <!--
        The widget panel's only way in on a compact viewport, since it is off-canvas there — and
        the last thing in the row rather than beside the nav toggle, because the two drawers are
        at opposite edges of the screen: the sidebar's toggle stays on the left, next to the way
        out, and this one sits where the panel it opens actually appears.
      -->
      <button
        v-if="isCompact && store.enabledWidgetIds.length > 0"
        class="icon-btn widget-toggle"
        data-testid="widget-toggle"
        :title="t('widgets.open')"
        :aria-label="t('widgets.open')"
        :aria-expanded="uiState.widgetDrawerOpen"
        aria-controls="widget-panel"
        @click="toggleWidgetDrawer"
      >
        <Icon name="panel-right" />
      </button>
    </header>

    <!-- Split into three keys rather than one message with <strong> in it: no message
         carries HTML, so there is nothing for `v-html` to inject. -->
    <div v-if="!store.isConfigured" class="config-banner">
      <Icon name="warning" />
      {{ t("app.configBanner.before") }}
      <strong><Icon name="gear" /> {{ t("app.configBanner.action") }}</strong>
      {{ t("app.configBanner.after") }}
    </div>

    <!--
      Somebody else holds this conversation, so this client reads it and cannot write to it.
      Stated as a banner and not merely a disabled button, because a disabled control with no
      explanation is indistinguishable from a broken one — and the two banners can both be up at
      once, which is why this one is its own class and its own colour rather than a second
      `.config-banner` (a locator that matched both would be ambiguous, and the reader would have
      two identical-looking warnings about unrelated things).
    -->
    <div v-if="store.isActiveSessionReadOnly" class="readonly-banner" data-testid="readonly-banner">
      <Icon name="lock" />
      {{ t("lock.other") }}
    </div>

    <!-- The rail is a sibling of the scroller, not a child: inside it would scroll away. -->
    <div class="messages-wrap">
      <div
        ref="messagesEl"
        class="messages"
        data-testid="messages"
        :class="{ 'with-rail': showMinimap }"
        @scroll.passive="onScroll"
      >
        <div v-if="store.messages.length === 0 && !store.streaming.active" class="empty-state">
          <h2>{{ store.activeCopilotName ?? t("chat.start") }}</h2>
          <p>{{ t("chat.startHint") }}</p>
          <button class="btn" @click="showNewSession = true">
            <Icon name="plus" /> {{ t("chat.startAction") }}
          </button>
        </div>
        <!-- `isLast` is what puts the tail actions (delete, regenerate) on one message and
             nobody else; the streaming bubble is not in the array, so it is never last. -->
        <MessageItem
          v-for="(m, i) in store.messages"
          :key="m.id"
          :message="m"
          :note-marks="noteMarks"
          :is-last="i === store.messages.length - 1"
          @open-ref="openReference"
        />
        <!-- The streaming bubble gets no marks: an annotation needs a message row to be filed
             against, and this one has none yet. It draws none for the same reason. -->
        <MessageItem v-if="store.streaming.active" :streaming="store.streaming" />
      </div>
      <MessageMinimapRail
        v-if="showMinimap"
        :anchors="minimapAnchors"
        @jump="jumpToAnchor"
      />

      <!--
        Only while the end has been let go of. Shown by the position rather than by the turn
        being live: a reader who has scrolled up into a finished conversation wants the same
        thing, and gating it on `streaming.active` would take the control away at the moment
        the reply they were reading was finally complete.
      -->
      <button
        v-if="!following"
        class="btn jump-to-latest"
        data-testid="jump-to-latest"
        :title="t('chat.jumpToLatest')"
        :aria-label="t('chat.jumpToLatest')"
        @click="scrollToBottom"
      >
        <Icon name="arrow-down" /> <span>{{ t("chat.jumpToLatest") }}</span>
      </button>
    </div>

    <Composer />

    <!--
      The two marks of the notes capability, both teleported to `body` by the components
      themselves: the toolbar follows a selection in the viewport, and the window floats near
      whatever opened it. Inside `.messages-wrap` they would be clipped by the scroller and
      carried away by its scroll.
    -->
    <MessageSelectionToolbar
      v-if="selection && selectionActions.length > 0"
      :anchor="selection.place"
      :actions="selectionActions"
      @pick="onToolbarPick"
    />
    <NoteEditor
      v-if="editorRequest"
      :draft="editorRequest.draft"
      :locate="editorRequest.locate"
      :anchor="editorAnchor"
      :busy="editorBusy"
      :read-only="!notesWritable"
      @save="onEditorSave"
      @remove="onEditorRemove"
      @locate="onEditorLocate"
      @ask="onEditorAsk"
      @open-target="onEditorOpenTarget"
      @close="closeEditor"
    />

    <!-- What still needs a dialog: a table. A diagram and a reference open in the file preview,
         which is a dialog of its own — see `useFigureViewer`. -->
    <DiagramDialog
      v-if="viewing"
      :content="viewing.content"
      :name="viewing.name"
      :summary="viewing.summary"
      :figure="viewing.figure"
      @close="closeFigure"
    />

    <NewSessionDialog v-if="showNewSession" @close="showNewSession = false" />
  </main>
</template>

<style scoped>
.title-block {
  flex: 1;
  min-width: 0;
}
/* The language picker and the theme button moved to `TopbarControls.vue` when the
   workspace home needed the same pair; their rules went with them. */
.title-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}
/*
 * Sizes to its text (`flex: 0 1 auto`), so the edit button and the AI badge sit right
 * after the title instead of being pushed to the far edge of the header. `min-width`
 * gives a short title a stable floor — otherwise a two-character name would put the
 * button under the cursor and it would jump around from conversation to conversation.
 */
.topbar .title {
  flex: 0 1 auto;
  min-width: 15ch;
  max-width: 100%;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.topbar .title.editable {
  cursor: text;
  border-radius: var(--radius-xs);
}
.topbar .title.editable:hover {
  color: var(--accent);
}
.title-edit {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.title-input {
  padding: var(--space-2) var(--space-4);
  font-size: var(--fs-4);
  font-weight: 600;
}
.title-hint {
  font-size: var(--fs-1);
  color: var(--text-3);
}
.subtitle {
  font-size: var(--fs-1);
  color: var(--text-3);
}
.config-banner {
  margin: 0;
  padding: var(--space-4) var(--space-7);
  background: var(--warning-bg);
  border-bottom: 1px solid var(--warning-border);
  color: var(--warning);
  font-size: var(--fs-3);
  flex-shrink: 0;
}

/*
 * The other client is editing this conversation, so this one is read-only.
 *
 * The same banner shape as the config warning, and deliberately not the same colours: this one
 * keeps the neutral surface and lets `--lock-held` carry the meaning, because nothing here needs
 * the reader's attention the way an unconfigured app does — it is a statement of who may write.
 * A tinted surface would make the two banners look like one message when both are up.
 */
.readonly-banner {
  margin: 0;
  padding: var(--space-4) var(--space-7);
  background: var(--panel);
  border-bottom: 1px solid var(--border);
  color: var(--lock-held);
  font-size: var(--fs-3);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.empty-state button {
  margin-top: var(--space-4);
}
</style>
