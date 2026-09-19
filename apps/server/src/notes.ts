import { z } from "zod";
import {
  NOTE_CONTENT_MAX,
  NOTE_QUOTE_MAX,
  NOTE_TARGET_REF_MAX,
  isNoteType,
  type ApiErrorCode,
  type Note,
  type NoteTargetKind,
  type NoteTargetKindChoice,
  type NoteType,
} from "@ilearnassist/shared";
import { newId, type AppDb } from "./db.js";
import { diagramFileName } from "./diagrams.js";
import { tableName } from "./tables.js";

/**
 * The notes widget's records.
 *
 * Mirrors `plans.ts` and `quizzes.ts`: the SQL lives in `db.ts`, this module owns the
 * decisions — what a body must contain before it may become a note, and what a later edit is
 * allowed to change. Those two are different questions because the entity has two halves: a
 * note's `messageId` and its anchor are what it *was*, settled at creation, while its `type`
 * and `content` are what the user is still saying. Hence a create that validates an anchor
 * against a real message, and an update that cannot mention one at all.
 *
 * Nothing here reads the model's conversation, and nothing here writes on the model's behalf:
 * every function is reached from a route the learner's own click triggered. A note is the
 * learner's own writing, so no turn may ever rewrite one.
 *
 * It is *readable* by the model since `ila_query` — `kind: "note"` — which was a deliberate
 * reversal of the rule that used to stand here ("no tool can reach it"). The read is ordinary
 * rather than bound to the notes widget, so a conversation that never installed the panel
 * still has its notes visible to the agent that is helping with them.
 */

/** A refusal the route turns straight into `reply.code(status).send(apiError(code, …))`. */
export interface NoteRefusal {
  ok: false;
  status: number;
  code: ApiErrorCode;
}

export type NoteWriteResult = { ok: true; note: Note } | NoteRefusal;
export type NoteDeleteResult = { ok: true } | NoteRefusal;

/**
 * Whether the body names a type this build does not know.
 *
 * Checked ahead of the schema, and not by it, because the two refusals are different
 * sentences: an unknown type is `NOTE_TYPE_INVALID` ("that is not a kind of note"), while
 * every other malformed field is `INVALID_FIELD` ("that is not the right shape"). A single
 * `safeParse` failure cannot tell them apart, and the client renders the code, not the
 * server's message.
 *
 * Absent is not a problem — the quick action sends a selection and nothing else, and
 * `annotation` is what that means.
 */
function namesUnknownType(body: unknown): boolean {
  const type = (body as { type?: unknown } | null | undefined)?.type;
  return type !== undefined && !isNoteType(type);
}

/**
 * A note's body as it arrives.
 *
 * `occurrence` is validated as a non-negative integer rather than clamped: an anchor that
 * says "the -1st match" is a client bug, and rounding it to 0 would hide it behind a
 * highlight in the wrong place.
 */
const createNoteSchema = z
  .object({
    messageId: z.string().min(1).nullish(),
    quote: z.string().max(NOTE_QUOTE_MAX).optional(),
    occurrence: z.number().int().min(0).optional(),
    content: z.string().max(NOTE_CONTENT_MAX).optional(),
    targetKind: z.enum(["diagram", "table", "resource"]).optional(),
    targetRef: z.string().min(1).max(NOTE_TARGET_REF_MAX).optional(),
  })
  .superRefine((value, ctx) => {
    const anchored = (value.quote ?? "").length > 0;
    // The anchor is one thing, so half of it is refused rather than completed: a note with a
    // message but no quote has nothing to put back on screen, and an occurrence with no
    // quote is an offset into nothing.
    if (value.messageId && !anchored) {
      ctx.addIssue({ code: "custom", message: "an anchored note needs the annotated text" });
    }
    if (!anchored && (value.occurrence ?? 0) > 0) {
      ctx.addIssue({ code: "custom", message: "an occurrence needs a quote to count in" });
    }

    // The figure pair travels together for the same reason, and each half without the other is
    // worse than either: a kind with no name is a note about nothing in particular, and a name
    // with no kind cannot be looked for — `diagramFileName` and `tableName` would each claim it.
    if ((value.targetKind === undefined) !== (value.targetRef === undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "a figure target needs both targetKind and targetRef",
      });
    }
    /*
     * And a note has exactly one anchor. A 图 has no passage in it, so a request carrying both a
     * figure and a *passage* is a client that assembled two different notes — refused rather
     * than resolved, because either reading would throw away half of what was sent.
     *
     * The test is the `messageId` and the `occurrence`, not the quote, and the difference is the
     * whole of what an object note is: it has a 标注原文 with no passage in it, holding the
     * object's own title, so `quote` alone is a title rather than an anchor. Refusing that was
     * refusing the only thing an object note can put in the field the reader sees.
     */
    if (value.targetKind !== undefined && (value.messageId || (value.occurrence ?? 0) > 0)) {
      ctx.addIssue({ code: "custom", message: "a figure target cannot also be a passage" });
    }
  });

/** The edit shape: no anchor, no message — see the note on the module. */
const updateNoteSchema = z.object({
  content: z.string().max(NOTE_CONTENT_MAX).optional(),
});

function readType(body: unknown, fallback: NoteType): NoteType {
  const type = (body as { type?: unknown } | null | undefined)?.type;
  return isNoteType(type) ? type : fallback;
}

/**
 * The handle to store for a target, or null when this conversation cannot anchor to it.
 *
 * Three arms, and **the switch is exhaustive on purpose**. The function used to fall through to
 * `tableName` for anything that was not a diagram, which was correct while there were two kinds
 * and became a silent 404 for every note about a resource the moment there were three: a
 * `target_ref` that is a uuid would be run through the table slug rule, match nothing, and read
 * as `FIGURE_NOT_FOUND` with no type error anywhere. The `never` arm is what makes the next kind
 * a compile error rather than that.
 *
 * A figure's handle is its **canonical name**, normalised through the *same* function the writer
 * used — so a caller that opened a dialog with `"Auth Flow.mmd"` and one that read
 * `auth-flow.mmd` off the panel are asking about one figure, and the chip a note shows and the
 * string a follow-up hands the model are the same string. A resource's is its **id**, which is
 * already canonical and is not a name at all.
 *
 * The scope differs by arm, and that difference is deliberate. A figure is looked up in this
 * conversation's own list, so a name from elsewhere simply is not in it. A resource is looked up
 * **owner-scoped**, because a note about the material a conversation is working from is a note
 * about *the account's* material: the same reference may be held by another workspace, and the
 * `@` picker offers exactly that. Session-scoping it would refuse the references the feature
 * exists for.
 */
function canonicalTarget(
  db: AppDb,
  userId: string,
  sessionId: string,
  kind: NoteTargetKindChoice,
  ref: string
): string | null {
  switch (kind) {
    case "diagram": {
      const wanted = diagramFileName(ref);
      return db.listDiagramsForUser(userId, sessionId).some((d) => d.name === wanted)
        ? wanted
        : null;
    }
    case "table": {
      const wanted = tableName(ref);
      return db.listTablesForUser(userId, sessionId).some((t) => t.name === wanted)
        ? wanted
        : null;
    }
    case "resource":
      return db.getWorkResourceForUser(userId, ref) ? ref : null;
    default: {
      const unhandled: never = kind;
      return unhandled;
    }
  }
}

/**
 * Record one note.
 *
 * An annotated note's message is checked rather than trusted, and checked the way the
 * delete-message route checks it — owner first, then session — because a `messageId` is a
 * client-supplied id: without it, a note could point at another account's conversation, and
 * `messageMissing` would then be answering about a message the reader can never see.
 *
 * A figure target is checked the same way and for the same reason, with one addition: what gets
 * *stored* is the canonical name rather than the one that arrived. The name is this app's join
 * key for a figure — the panel's label, `ila_query`'s handle, and the row's identity — so a note
 * that kept the caller's spelling would be the one place it and the model disagreed.
 */
export function createNote(
  db: AppDb,
  userId: string,
  sessionId: string,
  body: unknown
): NoteWriteResult {
  if (namesUnknownType(body)) return { ok: false, status: 400, code: "NOTE_TYPE_INVALID" };
  const parsed = createNoteSchema.safeParse(body ?? {});
  if (!parsed.success) return { ok: false, status: 400, code: "INVALID_FIELD" };

  const messageId = parsed.data.messageId ?? null;
  if (messageId !== null) {
    const message = db.getMessageForUser(messageId, userId);
    if (!message || message.sessionId !== sessionId) {
      return { ok: false, status: 404, code: "MESSAGE_NOT_FOUND" };
    }
  }

  const chosen = parsed.data.targetKind;
  let targetKind: NoteTargetKind = "text";
  let targetRef: string | null = null;
  if (chosen !== undefined) {
    const canonical = canonicalTarget(db, userId, sessionId, chosen, parsed.data.targetRef!);
    if (canonical === null) return { ok: false, status: 404, code: "FIGURE_NOT_FOUND" };
    targetKind = chosen;
    targetRef = canonical;
  }

  return {
    ok: true,
    note: db.createNote({
      id: newId(),
      sessionId,
      messageId,
      type: readType(body, "annotation"),
      quote: parsed.data.quote ?? "",
      occurrence: parsed.data.occurrence ?? 0,
      content: parsed.data.content ?? "",
      targetKind,
      targetRef,
    }),
  };
}

/**
 * Edit one note's type and/or body.
 *
 * An absent field keeps its stored value, so a body that mentions only the text cannot
 * silently reset a 灵感 to a 标注 — the same "omit means leave alone" contract `apiKey` and
 * the tool pair carry. An empty `content` is a value, not an omission: clearing a note back
 * to a bare annotation is an ordinary thing to want.
 */
export function updateNote(
  db: AppDb,
  userId: string,
  sessionId: string,
  noteId: string,
  body: unknown
): NoteWriteResult {
  if (namesUnknownType(body)) return { ok: false, status: 400, code: "NOTE_TYPE_INVALID" };
  const parsed = updateNoteSchema.safeParse(body ?? {});
  if (!parsed.success) return { ok: false, status: 400, code: "INVALID_FIELD" };
  if (!db.getNoteForUser(userId, sessionId, noteId)) {
    return { ok: false, status: 404, code: "NOTE_NOT_FOUND" };
  }

  const note = db.updateNote(sessionId, noteId, {
    type: (body as { type?: unknown }).type as NoteType | undefined,
    content: parsed.data.content,
  });
  // Defensive: the scoped read above already proved it is there, so this is a bug rather
  // than a race — but a write that misses must not answer with a note it did not write.
  if (!note) return { ok: false, status: 404, code: "NOTE_NOT_FOUND" };
  return { ok: true, note };
}

/**
 * Mark one note deleted.
 *
 * Soft, like every other application entity: the row and the words in it stay, and every
 * read filters it out. Deleting a note never touches the message it annotated — the
 * annotation is a record of what the learner marked, not a decoration on the message.
 */
export function deleteNote(
  db: AppDb,
  userId: string,
  sessionId: string,
  noteId: string
): NoteDeleteResult {
  if (!db.getNoteForUser(userId, sessionId, noteId)) {
    return { ok: false, status: 404, code: "NOTE_NOT_FOUND" };
  }
  if (!db.softDeleteNote(sessionId, noteId)) {
    return { ok: false, status: 404, code: "NOTE_NOT_FOUND" };
  }
  return { ok: true };
}
