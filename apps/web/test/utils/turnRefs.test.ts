import { describe, expect, it } from "vitest";
import type { Note } from "@ilearnassist/shared";
import {
  figureReference,
  messageReference,
  noteReference,
  referenceKey,
} from "../../src/utils/turnRefs";
import type { FigureRow } from "../../src/utils/figures";
import type { MessageSelection } from "../../src/composables/messageSelection";

/*
 * Turning "the thing the reader pointed at" into a reference.
 *
 * Five panels offer 追问 and they all go through here, so what is pinned is the *handle*: which
 * string the server and the agent will look the object up by. The label is display only and is
 * asserted where it has a rule — the fallback for a note with no body, and the clip.
 */

const selection = (overrides: Partial<MessageSelection> = {}): MessageSelection => ({
  messageId: "m1",
  anchor: { quote: "ATP 是细胞的能量货币。", occurrence: 0 },
  place: { right: 100, bottom: 200, top: 180, containerRight: 800 },
  ...overrides,
});

const row = (overrides: Partial<FigureRow> = {}): FigureRow => ({
  key: "diagram:d1",
  kind: "diagram",
  name: "auth-flow",
  summary: "登录流程",
  threadTitle: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
  toolCallId: "call-1",
  fileName: "auth-flow.mmd",
  content: null,
  fileMissing: false,
  ...overrides,
});

const note = (overrides: Partial<Note> = {}): Note => ({
  id: "n1",
  sessionId: "s1",
  messageId: null,
  type: "question",
  quote: "",
  occurrence: 0,
  content: "这里不太懂",
  targetKind: "text",
  targetRef: null,
  messageMissing: false,
  targetMissing: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("a selected passage", () => {
  it("carries the words, the message and which occurrence", () => {
    // All four are needed and none is redundant: the message id is what the server checks
    // ownership against, the quote is the only copy of the text anywhere, and the occurrence is
    // what makes "the second ATP" a different reference from the first.
    expect(messageReference(selection())).toEqual({
      kind: "message",
      ref: "m1",
      label: "ATP 是细胞的能量货币。",
      quote: "ATP 是细胞的能量货币。",
      occurrence: 0,
    });
  });

  it("labels with the passage, clipped, because a chip is not a paragraph", () => {
    const long = "很长的句子。".repeat(30);
    const ref = messageReference(selection({ anchor: { quote: long, occurrence: 0 } }));
    expect(ref.label.length).toBeLessThanOrEqual(60);
    expect(ref.label.endsWith("…")).toBe(true);
    // The *quote* is untouched: the label is what the chip shows, and the model gets the passage.
    expect(ref.quote).toBe(long);
  });

  it("folds a passage onto one line for the label", () => {
    const ref = messageReference(selection({ anchor: { quote: "第一行\n第二行", occurrence: 0 } }));
    expect(ref.label).toBe("第一行 第二行");
    expect(ref.quote).toBe("第一行\n第二行");
  });
});

describe("a figure", () => {
  it("names a diagram by its canonical file name, and labels it with the stem", () => {
    // The handle is what the server normalises to and what `ila_query` takes; the label is what
    // the panel drew the row with. Reusing the label as the handle would be the client asserting
    // that a diagram is called "auth-flow" when the file is `auth-flow.mmd`.
    expect(figureReference(row())).toEqual({
      kind: "diagram",
      ref: "auth-flow.mmd",
      label: "auth-flow",
    });
  });

  it("names a table by its slug, which is what it has instead of a file name", () => {
    // A table has no file, so `fileName` is null and the slug is the handle — the same one the
    // panel's row opens by and the one `ila_query` resolves.
    expect(
      figureReference(row({ kind: "table", name: "scores", fileName: null, key: "table:t1" }))
    ).toEqual({ kind: "table", ref: "scores", label: "scores" });
  });
});

describe("a note", () => {
  it("is addressed by its id, and labelled with what it says", () => {
    expect(noteReference(note())).toEqual({
      kind: "note",
      ref: "n1",
      label: "这里不太懂",
    });
  });

  it("falls back to the passage it marks when it has no body", () => {
    // A bare 标注 has no words of its own, so the quote is the only thing there is to show — the
    // same fallback the panel's own row makes, and for the same reason.
    expect(noteReference(note({ content: "", quote: "暗反应" })).label).toBe("暗反应");
  });
});

describe("the key that decides whether two references are one", () => {
  it("separates two passages in one message, by occurrence", () => {
    const first = messageReference(selection({ anchor: { quote: "ATP", occurrence: 0 } }));
    const second = messageReference(selection({ anchor: { quote: "ATP", occurrence: 1 } }));
    expect(referenceKey(first)).not.toBe(referenceKey(second));
  });

  it("separates the same words in two different messages", () => {
    expect(referenceKey(messageReference(selection()))).not.toBe(
      referenceKey(messageReference(selection({ messageId: "m2" })))
    );
  });

  it("collapses the same thing pointed at twice", () => {
    // Two rows of the panel, one diagram: one chip. The occurrence is deliberately not part of a
    // figure's key — a figure has no occurrences, and including the field would make two
    // references to one diagram differ whenever one of them happened to carry a stray zero.
    expect(referenceKey(figureReference(row()))).toBe(referenceKey(figureReference(row())));
    expect(referenceKey(noteReference(note()))).toBe(referenceKey(noteReference(note())));
  });

  it("does not confuse a diagram and a table that share a name", () => {
    const diagram = figureReference(row());
    const table = figureReference(row({ kind: "table", fileName: null, key: "table:t1" }));
    expect(referenceKey(diagram)).not.toBe(referenceKey(table));
  });
});
