import type { Note, QuizQuestionView, TurnReference, TurnReferenceKind } from "@ilearnassist/shared";
import { i18n } from "../i18n";
import type { MessageSelection } from "../composables/messageSelection";
import type { FigureRow } from "./figures";

/**
 * Turning "the thing the reader pointed at" into a reference.
 *
 * Pure and separate from every call site for the reason `noteToolbar.ts` is: five different
 * panels offer 追问, and the one thing they must not each decide for themselves is what a
 * reference *is*. They share the composer's chip, the message row's block and the server's
 * `ref` field, so a second implementation of `figureReference` would be a second answer to
 * "which name does this diagram have" — and the two would disagree exactly when a name was
 * awkward.
 *
 * Everything here is a *label* and a *handle*, and the split is deliberate: the handle is what
 * the server and the model use, the label is what the reader saw. Nothing here reads the content
 * of anything, which is what keeps a reference small enough to attach four of.
 */

/**
 * What a reference kind is called on a chip.
 *
 * A `switch` over the closed union with a literal `t("…")` per case, the shape `registry.ts`'s
 * widget labels use — see `figureKindLabel` in `NotesWidget` for why the literal has to be inside
 * the `t()` call rather than returned as a key.
 */
export function kindLabel(kind: TurnReferenceKind): string {
  switch (kind) {
    case "message":
      return i18n.global.t("turnRef.kind.message");
    case "diagram":
      return i18n.global.t("turnRef.kind.diagram");
    case "table":
      return i18n.global.t("turnRef.kind.table");
    case "note":
      return i18n.global.t("turnRef.kind.note");
    case "quiz":
      return i18n.global.t("turnRef.kind.quiz");
    case "resource":
      return i18n.global.t("turnRef.kind.resource");
  }
}

/**
 * A stable identity for a staged reference, so the same thing cannot be attached twice.
 *
 * The `occurrence` is part of it for a passage and only for a passage: the same words twice in one
 * message are two different passages, and the same words in two messages are two different
 * references — which the message id already separates. For a figure or a note the handle alone is
 * the identity, so asking about the same diagram twice from two different rows is one chip.
 */
export function referenceKey(ref: TurnReference): string {
  return ref.kind === "message"
    ? `${ref.kind}:${ref.ref}:${ref.occurrence ?? 0}`
    : `${ref.kind}:${ref.ref}`;
}

/**
 * A reference to a figure, which is the only thing a figure row or a viewer can make.
 *
 * Narrowed on the outside so a call site that has a figure does not have to re-test that it has
 * one — the figure panels and the enlarged viewer all need "a diagram or a table", and handing
 * them a reference that might be a note would be a check every one of them had to repeat.
 */
export type FigureTurnReference = TurnReference & { kind: "diagram" | "table" };

/** A passage the reader selected. The only kind whose content travels. */
export function messageReference(selection: MessageSelection): TurnReference {
  return {
    kind: "message",
    ref: selection.messageId,
    label: clipLabel(selection.anchor.quote),
    quote: selection.anchor.quote,
    occurrence: selection.anchor.occurrence,
  };
}

/**
 * A 图 or a 表, from a row of the figure panel.
 *
 * The handle is the **canonical file name for a diagram** (`auth-flow.mmd`) and the **slug for a
 * table**, which is what `FigureRow` already carries in `fileName`/`name`. Both are what the
 * server normalises to and what `ila_query` takes; the label is the stem the panel shows.
 */
export function figureReference(row: FigureRow): FigureTurnReference {
  return {
    kind: row.kind,
    ref: row.fileName ?? row.name,
    label: row.name,
  };
}

/** One of the learner's own notes. The handle is its id, which `ila_query` can now take. */
export function noteReference(note: Note): TurnReference {
  return {
    kind: "note",
    ref: note.id,
    // A note with no body is a bare 标注, so the passage it marks is the only thing there is to
    // show — the same fallback `NotesWidget.rowText` makes, and for the same reason.
    label: clipLabel(note.content.trim() || note.quote),
  };
}

/**
 * A question the reader was asked, and is now asking about.
 *
 * The handle is the **global** id — not the `Qn` the reader sees, which is scoped to one
 * conversation and is not what `ila_review_quiz` takes. The label is the question itself: a chip
 * reading "Q3" would say nothing about what is being asked, and the reader is looking at the
 * question at the moment they press the button.
 */
export function quizReference(question: QuizQuestionView): TurnReference {
  return {
    kind: "quiz",
    ref: question.id,
    label: clipLabel(question.question),
  };
}

/** A label is a chip, not a paragraph. Long ones are cut where the chip would cut them anyway. */
function clipLabel(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 59)}…` : oneLine;
}
