import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiErrorBody, Note, NoteType } from "@ilearnassist/shared";
import { ApiError } from "../../src/utils/apiError";

/**
 * The notes widget's data, against a mocked API client.
 *
 * What is worth pinning here is not the plumbing but the two decisions the panel is built
 * out of: which failures reach the reader and where, and what the window offers for a note in
 * each of its states. Both are the kind that fail silently — an action failure with nowhere
 * to appear is a button that does nothing, and a 定位 button on a note whose message was
 * deleted scrolls nowhere while looking exactly like one that works.
 */

const mocks = vi.hoisted(() => ({
  api: {
    listNotes: vi.fn(),
    createNote: vi.fn(),
    updateNote: vi.fn(),
    deleteNote: vi.fn(),
  },
}));

/*
 * The app store comes along with the module under test — `reportFailure` reaches for it to
 * raise the toast — so the mock has to carry the rest of the client's surface it touches at
 * setup time, or the store fails to construct and every assertion about it reads as
 * `undefined` rather than as a failure.
 */
vi.mock("../../src/api/client", () => ({
  ...mocks,
  setUnauthenticatedHandler: vi.fn(),
  streamAnswers: vi.fn(),
  streamChat: vi.fn(),
  streamRegenerate: vi.fn(),
  fileToBase64: vi.fn(),
}));

import { useAppStore } from "../../src/stores/app";
import {
  claimNotes,
  figureNoteRequest,
  noteList,
  notesClaimRefused,
  notesError,
  openNewNoteEditor,
  openNoteEditor,
  releaseNotes,
  resetNotes,
} from "../../src/composables/notes";
import {
  registerMessageNotesHost,
  resetMessageNotes,
  type NoteCapture,
  type NoteEditorRequest,
} from "../../src/composables/messageNotes";

const SESSION = "s1";

function note(overrides: Partial<Note> = {}): Note {
  return {
    id: "n1",
    sessionId: SESSION,
    messageId: "m1",
    type: "annotation" as NoteType,
    quote: "energy currency",
    occurrence: 0,
    content: "",
    targetKind: "text",
    targetRef: null,
    messageMissing: false,
    targetMissing: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** A stand-in for the message list, recording what the widget asked it to draw. */
function host() {
  const record = {
    marks: [] as Array<readonly { noteId: string; messageId: string }[]>,
    reveals: [] as unknown[],
    editors: [] as NoteEditorRequest[],
    setHighlights(marks: readonly { noteId: string; messageId: string }[]) {
      record.marks.push(marks);
    },
    reveal(target: unknown) {
      record.reveals.push(target);
    },
    openEditor(request: NoteEditorRequest) {
      record.editors.push(request);
    },
  };
  return record;
}

let list: ReturnType<typeof host>;

beforeEach(() => {
  setActivePinia(createPinia());
  resetMessageNotes();
  resetNotes();
  vi.clearAllMocks();
  mocks.api.listNotes.mockResolvedValue({ notes: [] });
  list = host();
  registerMessageNotesHost(list as never);
});

const capture = (overrides: Partial<NoteCapture> = {}): NoteCapture => ({
  sessionId: SESSION,
  messageId: "m1",
  quote: "energy currency",
  occurrence: 0,
  // The button's own id, which is what the host passes through — see `NoteCapture.intent`.
  intent: "annotate",
  ...overrides,
});

/** A claimed, loaded conversation. */
async function claimed(notes: Note[] = []) {
  mocks.api.listNotes.mockResolvedValue({ notes });
  claimNotes(SESSION);
  await vi.waitFor(() => expect(noteList.value.length).toBe(notes.length));
}

describe("claiming", () => {
  it("takes the conversation and reads its notes", async () => {
    await claimed([note()]);
    expect(mocks.api.listNotes).toHaveBeenCalledWith(SESSION);
    expect(notesClaimRefused.value).toBeNull();
    // Every annotated note became a mark for the message list, carried with the message it
    // belongs to so the same words in another message cannot be marked by mistake.
    const marks = list.marks.at(-1)!;
    expect(marks).toEqual([
      { noteId: "n1", messageId: "m1", anchor: { quote: "energy currency", occurrence: 0 } },
    ]);
  });

  it("hands nothing to the message list for a note with no place on screen", async () => {
    await claimed([
      note({ id: "n1" }),
      // No annotation: nothing was selected, so there is nothing to mark.
      note({ id: "n2", messageId: null, quote: "" }),
      // Annotated, but the message was deleted — the quote would otherwise be searched for
      // in whatever text happens to match it.
      note({ id: "n3", messageMissing: true }),
    ]);
    expect(list.marks.at(-1)).toEqual([
      { noteId: "n1", messageId: "m1", anchor: { quote: "energy currency", occurrence: 0 } },
    ]);
  });

  it("gives the conversation up cleanly", async () => {
    await claimed([note()]);
    releaseNotes();
    expect(noteList.value).toEqual([]);
    expect(list.marks.at(-1)).toEqual([]);
  });

  it("reports a load failure in the panel, and not as a toast", async () => {
    // The reader asked for the panel, so the panel is where the answer belongs. The toast is
    // for an action they asked for that failed with nowhere else to appear.
    mocks.api.listNotes.mockRejectedValue(new ApiError("SESSION_NOT_FOUND", "gone", 404));
    claimNotes(SESSION);

    await vi.waitFor(() => expect(notesError.value).toBe(true));
    expect(useAppStore().error).toBeNull();
  });
});

describe("a selection", () => {
  it("files 标注 straight off, with no window", async () => {
    await claimed();
    mocks.api.createNote.mockResolvedValue(note());

    const { captureMessageNote } = await import("../../src/composables/messageNotes");
    captureMessageNote(capture());
    await vi.waitFor(() => expect(noteList.value).toHaveLength(1));

    // The quick action's whole point is that it costs one click: a window would cost three.
    expect(list.editors).toHaveLength(0);
    expect(mocks.api.createNote).toHaveBeenCalledWith(SESSION, {
      messageId: "m1",
      quote: "energy currency",
      occurrence: 0,
      type: "annotation",
    });
    // And the mark appears behind it as the confirmation, rather than a toast.
    await vi.waitFor(() => expect(list.marks.at(-1)).toHaveLength(1));
  });

  it("opens the window for 笔记, and only writes when it is saved", async () => {
    await claimed();
    const { captureMessageNote } = await import("../../src/composables/messageNotes");
    captureMessageNote(capture({ intent: "note" }));

    expect(list.editors).toHaveLength(1);
    expect(mocks.api.createNote).not.toHaveBeenCalled();

    const request = list.editors[0]!;
    expect(request.draft).toMatchObject({ quote: "energy currency", content: "" });
    // Nothing to locate yet: the note does not exist, and the mark is not on screen.
    expect(request.locate).toBeNull();

    mocks.api.createNote.mockResolvedValue(note({ type: "question", content: "why?" }));
    await expect(request.save({ type: "question", content: "why?" })).resolves.toBe(true);
    expect(mocks.api.createNote).toHaveBeenCalledWith(SESSION, {
      messageId: "m1",
      quote: "energy currency",
      occurrence: 0,
      type: "question",
      content: "why?",
    });
  });

  it("reports a failed save as a toast, because the window is not the only entry point", async () => {
    await claimed();
    mocks.api.createNote.mockRejectedValue(new ApiError("INVALID_FIELD", "too long", 400));

    const { captureMessageNote } = await import("../../src/composables/messageNotes");
    captureMessageNote(capture());
    await vi.waitFor(() => expect(useAppStore().error).toBe("too long"));
    expect(noteList.value).toEqual([]);
  });
});

describe("the window over an existing note", () => {
  it("offers 定位 when the message is there", async () => {
    await claimed([note()]);
    openNoteEditor(note());
    expect(list.editors[0]!.locate).toEqual({ noteId: "n1", messageId: "m1" });
    expect(list.editors[0]!.draft).toMatchObject({ noteId: "n1", quote: "energy currency" });
  });

  it("offers no 定位 when there is nowhere to go, for either reason", async () => {
    await claimed([note({ id: "n1", messageId: null, quote: "" }), note({ id: "n2", messageMissing: true })]);
    // A note the user typed has no message; one whose message was deleted has lost it. Both
    // are "no button" rather than a button that scrolls nowhere.
    openNoteEditor(note({ id: "n1", messageId: null, quote: "" }));
    expect(list.editors[0]!.locate).toBeNull();

    openNoteEditor(note({ id: "n2", messageMissing: true }));
    expect(list.editors[1]!.locate).toBeNull();
  });

  it("saves an edit in place, keeping the list order", async () => {
    await claimed([note({ id: "n2" }), note({ id: "n1" })]);
    mocks.api.updateNote.mockResolvedValue(note({ id: "n2", content: "revised" }));

    openNoteEditor(note({ id: "n2" }));
    await expect(list.editors[0]!.save({ type: "idea", content: "revised" })).resolves.toBe(true);

    expect(mocks.api.updateNote).toHaveBeenCalledWith(SESSION, "n2", {
      type: "idea",
      content: "revised",
    });
    // An edit does not move a note: the order is by creation, which the edit did not change.
    expect(noteList.value.map((n) => n.id)).toEqual(["n2", "n1"]);
    expect(noteList.value[0]!.content).toBe("revised");
  });

  it("opens the window when its highlight is clicked, on the saved note", async () => {
    await claimed([note()]);
    const { openNoteFromHighlight } = await import("../../src/composables/messageNotes");
    openNoteFromHighlight("n1");

    // Editing what is there is the whole gesture, so the window opens on the stored note
    // rather than on a copy of the quote it happens to be showing.
    expect(list.editors).toHaveLength(1);
    expect(list.editors[0]!.draft).toMatchObject({ noteId: "n1", content: "" });
    expect(list.editors[0]!.remove).toBeTypeOf("function");
  });

  it("ignores a highlight whose note is not in the list", async () => {
    await claimed([]);
    const { openNoteFromHighlight } = await import("../../src/composables/messageNotes");
    openNoteFromHighlight("n-gone");
    expect(list.editors).toHaveLength(0);
  });

  it("removes a note and its mark together", async () => {
    await claimed([note()]);
    mocks.api.deleteNote.mockResolvedValue({ ok: true });

    openNoteEditor(note());
    await expect(list.editors[0]!.remove!()).resolves.toBe(true);

    expect(mocks.api.deleteNote).toHaveBeenCalledWith(SESSION, "n1");
    expect(noteList.value).toEqual([]);
    expect(list.marks.at(-1)).toEqual([]);
  });
});

describe("a note with no annotation", () => {
  it("is created from the list's own button, defaulting to 其他", async () => {
    await claimed();
    openNewNoteEditor();

    const request = list.editors[0]!;
    // Nothing is selected, so the window has no quote and no 定位.
    expect(request.draft).toMatchObject({ quote: "", type: "other", content: "" });
    expect(request.locate).toBeNull();
    // And no remove: there is nothing to remove until it is saved.
    expect(request.remove).toBeUndefined();

    mocks.api.createNote.mockResolvedValue(note({ id: "n9", messageId: null, quote: "", type: "other" }));
    await expect(request.save({ type: "other", content: "revise this" })).resolves.toBe(true);
    expect(mocks.api.createNote).toHaveBeenCalledWith(SESSION, {
      type: "other",
      content: "revise this",
    });
  });
});

/**
 * A note about a 图 or a 表, whose window is built from the figure rather than from a selection.
 *
 * Three things are the entity's rules rather than incidental plumbing: the pair travels together
 * to the API, the kind starts at a stance rather than at 标注 (there is no passage to mark), and
 * there is nothing to locate — a figure note names no message, so a 定位 button would scroll
 * nowhere while looking exactly like one that works.
 */
describe("a note about a figure", () => {
  it("sends the target pair, and offers no 定位", async () => {
    await claimed();
    const request = figureNoteRequest({
      kind: "diagram",
      ref: "auth-flow.mmd",
      label: "auth-flow",
    })!;

    expect(request.draft).toMatchObject({
      quote: "",
      type: "idea",
      content: "",
      target: { kind: "diagram", ref: "auth-flow.mmd", label: "auth-flow" },
    });
    expect(request.locate).toBeNull();

    mocks.api.createNote.mockResolvedValue(
      note({ id: "n10", messageId: null, quote: "", targetKind: "diagram", targetRef: "auth-flow.mmd" })
    );
    await expect(request.save({ type: "idea", content: "这一步没看懂" })).resolves.toBe(true);
    expect(mocks.api.createNote).toHaveBeenCalledWith(SESSION, {
      targetKind: "diagram",
      targetRef: "auth-flow.mmd",
      type: "idea",
      content: "这一步没看懂",
    });
  });

  it("carries a table the same way, with the kind that says which table to look in", async () => {
    await claimed();
    const request = figureNoteRequest({ kind: "table", ref: "scores", label: "scores" })!;
    mocks.api.createNote.mockResolvedValue(note({ id: "n11", targetKind: "table", targetRef: "scores" }));
    await request.save({ type: "question", content: "第二列是什么？" });
    expect(mocks.api.createNote).toHaveBeenCalledWith(
      SESSION,
      expect.objectContaining({ targetKind: "table", targetRef: "scores" })
    );
  });

  it("hands the editor the target when an existing figure note is opened, and nothing for a text note", async () => {
    // The window has to keep showing what the note is about — it is the one place that would
    // otherwise have forgotten, since the note's own row is behind the card.
    await claimed([
      note({ id: "n12", messageId: null, quote: "", targetKind: "table", targetRef: "scores" }),
      note({ id: "n13", messageId: null, quote: "", targetKind: "text", targetRef: null }),
    ]);

    openNoteEditor(noteList.value.find((n) => n.id === "n12")!);
    expect(list.editors.at(-1)!.draft.target).toMatchObject({ kind: "table", ref: "scores" });

    // And a text note gets none, so the window draws no 标注对象 field for a note that has no
    // figure — the absence is the field, not a value saying "text".
    openNoteEditor(noteList.value.find((n) => n.id === "n13")!);
    expect(list.editors.at(-1)!.draft.target).toBeUndefined();
  });

  it("builds no window at all when there is no conversation loaded", () => {
    /*
     * `figureNoteRequest` reads the loaded session, so a figure row drawn before a conversation
     * is on screen — which the panel renders for a moment on every switch — cannot file a note
     * against whichever conversation happens to be loaded next. Null is the caller's answer not
     * to offer the control.
     */
    resetNotes();
    expect(figureNoteRequest({ kind: "diagram", ref: "x.mmd", label: "x" })).toBeNull();
  });
});
