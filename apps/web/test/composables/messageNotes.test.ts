import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureMessageNote,
  claimMessageNotes,
  currentSelectionActions,
  isMessageNotesActive,
  noteClaim,
  openNoteFromHighlight,
  registerMessageNotesHost,
  releaseMessageNotes,
  requestNoteEditor,
  resetMessageNotes,
  revealNote,
  setNoteHighlights,
  type MessageNotesController,
  type MessageNotesHost,
  type NoteCapture,
  type SelectionAction,
} from "../../src/composables/messageNotes";

/**
 * The one rule this module exists to enforce: a conversation's marks belong to exactly one
 * widget at a time.
 *
 * The rule is future-proofing rather than a live constraint — one notes widget exists and it
 * is off by default, so a second claimant cannot happen today. That is exactly why it is
 * worth pinning: the machinery reads as removable to anyone who only counts the claimants of
 * the moment, and the thing it buys is that a second widget is *told* rather than silently
 * drawing over the first.
 *
 * The other half of the contract is order independence. The widget claims on install and the
 * message list registers when the chat view mounts, and those two happen in either order —
 * so the host reads the claim rather than being told about it, and a claim made while nothing
 * was on screen is found when the chat comes back.
 */

const HOST_WIDGET = "notes";
const RIVAL_WIDGET = "quiz";

function host(): MessageNotesHost & { marks: unknown[]; reveals: unknown[]; editors: unknown[] } {
  const record = {
    marks: [] as unknown[],
    reveals: [] as unknown[],
    editors: [] as unknown[],
    setHighlights(marks: readonly unknown[]) {
      record.marks.push(marks);
    },
    reveal(target: unknown) {
      record.reveals.push(target);
    },
    openEditor(request: unknown) {
      record.editors.push(request);
    },
  };
  return record as never;
}

/**
 * The widget's side, as the bridge sees it.
 *
 * `actions` defaults to a stub rather than to a fixed pair: what the bar carries is each widget's
 * business, and a case that cares about the buttons asks for its own — see the cases below.
 */
function controller(actions: SelectionAction[] = []): MessageNotesController {
  return { capture: vi.fn(), open: vi.fn(), actions: () => actions };
}

const capture = (sessionId: string): NoteCapture => ({
  sessionId,
  messageId: "m1",
  quote: "energy currency",
  occurrence: 0,
  intent: "annotation",
});

beforeEach(() => {
  resetMessageNotes();
});

describe("claiming a conversation", () => {
  it("accepts a claim and reports the session as active", () => {
    expect(claimMessageNotes(HOST_WIDGET, "s1", controller())).toEqual({ ok: true });
    expect(noteClaim.value).toEqual({ widgetId: HOST_WIDGET, sessionId: "s1" });
    expect(isMessageNotesActive("s1")).toBe(true);
    expect(isMessageNotesActive("s2")).toBe(false);
    expect(isMessageNotesActive(null)).toBe(false);
  });

  it("refuses a second widget, and says which one holds it", () => {
    claimMessageNotes(HOST_WIDGET, "s1", controller());

    const refused = claimMessageNotes(RIVAL_WIDGET, "s1", controller());
    expect(refused).toEqual({ ok: false, heldBy: HOST_WIDGET });
    // Still the first one's, which is the half that matters: a refusal that took the claim
    // anyway would pass an assertion on the result alone.
    expect(noteClaim.value?.widgetId).toBe(HOST_WIDGET);
  });

  it("lets the holder move the claim to another conversation", () => {
    claimMessageNotes(HOST_WIDGET, "s1", controller());
    expect(claimMessageNotes(HOST_WIDGET, "s2", controller())).toEqual({ ok: true });

    // A claim that named only the widget would go on offering the toolbar in the first
    // conversation, whose panel may not even be installed.
    expect(isMessageNotesActive("s2")).toBe(true);
    expect(isMessageNotesActive("s1")).toBe(false);
  });

  it("ignores a release from anyone but the holder", () => {
    claimMessageNotes(HOST_WIDGET, "s1", controller());
    releaseMessageNotes(RIVAL_WIDGET);
    expect(noteClaim.value?.widgetId).toBe(HOST_WIDGET);

    releaseMessageNotes(HOST_WIDGET);
    expect(noteClaim.value).toBeNull();
    expect(isMessageNotesActive("s1")).toBe(false);
  });
});

describe("routing a capture", () => {
  it("hands it to the holder when the conversation matches", () => {
    const notes = controller();
    claimMessageNotes(HOST_WIDGET, "s1", notes);

    const selected = capture("s1");
    captureMessageNote(selected);
    expect(notes.capture).toHaveBeenCalledWith(selected);
  });

  it("drops one for a conversation the claim does not name", () => {
    // A selection outlives a session switch by a tick. Filing it against whichever
    // conversation is now on screen would be filing it in the wrong place.
    const notes = controller();
    claimMessageNotes(HOST_WIDGET, "s1", notes);
    captureMessageNote(capture("s2"));
    expect(notes.capture).not.toHaveBeenCalled();
  });

  it("hands a clicked highlight over by id", () => {
    // The other thing a reader can do to a marked-up message, and the reason the bridge
    // carries an id rather than a note: the message list draws `data-note-id` and knows
    // nothing else about what it points at.
    const notes = controller();
    claimMessageNotes(HOST_WIDGET, "s1", notes);
    openNoteFromHighlight("n1");
    expect(notes.open).toHaveBeenCalledWith("n1");
  });

  it("drops one with no claim at all", () => {
    expect(() => captureMessageNote(capture("s1"))).not.toThrow();
    expect(() => openNoteFromHighlight("n1")).not.toThrow();
  });
});

describe("the message list's side", () => {
  it("reaches the host, and stops when the host goes away", () => {
    const list = host();
    const deregister = registerMessageNotesHost(list);

    setNoteHighlights([{ noteId: "n1", messageId: "m1", anchor: { quote: "a", occurrence: 0 } }]);
    revealNote({ noteId: "n1", messageId: "m1" });
    requestNoteEditor({ draft: { quote: "", type: "other", content: "" }, locate: null, save: vi.fn() });
    expect(list.marks).toHaveLength(1);
    expect(list.reveals).toHaveLength(1);
    expect(list.editors).toHaveLength(1);

    deregister();
    setNoteHighlights([]);
    expect(list.marks).toHaveLength(1);
  });

  it("does nothing at all with no host, rather than throwing", () => {
    // The ordinary case: the widget is installed on the workspace home, or the chat view is
    // unmounted because the reader went back to the workspace list.
    expect(() => {
      setNoteHighlights([]);
      revealNote({ noteId: "n1", messageId: "m1" });
      requestNoteEditor({ draft: { quote: "", type: "other", content: "" }, locate: null, save: vi.fn() });
    }).not.toThrow();
  });

  it("keeps a claim made while nothing was on screen", () => {
    // Install order does not have to be registration order. The widget claims from the
    // session settings dialog while the chat view is up, but the same install can be the
    // first thing that happens on a reload with the app on the workspace home.
    claimMessageNotes(HOST_WIDGET, "s1", controller());
    const list = host();
    registerMessageNotesHost(list);

    expect(noteClaim.value).toEqual({ widgetId: HOST_WIDGET, sessionId: "s1" });
    setNoteHighlights([{ noteId: "n1", messageId: "m1", anchor: { quote: "a", occurrence: 0 } }]);
    expect(list.marks).toHaveLength(1);
  });
});

/**
 * The bar over a selection, which is the conversation's and not the widget's.
 *
 * The host composes it, so what this module has to answer is only *what the claiming widget
 * contributes* — and the two properties that matter are that nothing claimed contributes nothing
 * (so the bar is absent rather than empty) and that the question is re-asked rather than answered
 * once, because an action's availability changes while the claim stands.
 */
describe("the selection bar's actions", () => {
  const action = (id: string): SelectionAction => ({ id, label: "Mark", icon: "marker" });

  it("is empty when nothing has claimed the conversation", () => {
    // The bar is hidden on this, which is what keeps a conversation with no marking-up capability
    // from showing a strip of nothing.
    expect(currentSelectionActions()).toEqual([]);
  });

  it("is whatever the claim holder offers", () => {
    claimMessageNotes(HOST_WIDGET, "s1", controller([action("annotate"), action("note")]));
    expect(currentSelectionActions().map((a) => a.id)).toEqual(["annotate", "note"]);
  });

  it("goes back to empty when the claim is given up", () => {
    claimMessageNotes(HOST_WIDGET, "s1", controller([action("annotate")]));
    releaseMessageNotes(HOST_WIDGET);
    expect(currentSelectionActions()).toEqual([]);
  });

  it("asks again every time, so an action can change while the claim stands", () => {
    /*
     * The reason `actions` is a function rather than a list. The notes widget derives its `disabled`
     * from its own writability, and that changes under a claim that never moves — another client
     * takes the conversation's lease, or gives it back. A list captured at claim time would leave
     * both buttons live in a conversation this client cannot write to, and the press would fail
     * with nothing on screen to explain it.
     */
    let disabled = false;
    claimMessageNotes(HOST_WIDGET, "s1", {
      capture: vi.fn(),
      open: vi.fn(),
      actions: () => [{ ...action("annotate"), disabled }],
    });

    expect(currentSelectionActions()[0]!.disabled).toBe(false);
    disabled = true;
    expect(currentSelectionActions()[0]!.disabled).toBe(true);
  });
});
