import { z } from "zod";
import {
  NOTE_CONTENT_MAX,
  NOTE_QUOTE_MAX,
  isNoteType,
  type ApiErrorCode,
  type Note,
  type NoteType,
} from "@ilearnassist/shared";
import { newId, type AppDb } from "./db.js";

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
 * Nothing here reads the model's conversation. A note is the learner's own writing: it is
 * never part of a turn's context and no tool can reach it.
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
 * Record one note.
 *
 * An annotated note's message is checked rather than trusted, and checked the way the
 * delete-message route checks it — owner first, then session — because a `messageId` is a
 * client-supplied id: without it, a note could point at another account's conversation, and
 * `messageMissing` would then be answering about a message the reader can never see.
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
