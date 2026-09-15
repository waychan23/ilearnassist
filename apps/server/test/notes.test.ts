import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApiErrorBody, CreateNoteInput, Note } from "@ilearnassist/shared";
import { newSession, newWorkspace, startTestServer, type TestEnv } from "./helpers/tempEnv.js";

/**
 * The notes widget's routes.
 *
 * Three claims are worth a test each here, and they are the three the entity turns on. A note
 * belongs to a conversation whether or not it was annotated — that is why `session_id` is
 * `NOT NULL` and `message_id` is not. An anchor is *validated* against a real message of that
 * conversation rather than trusted, because the id arrives from the client and a note pointing
 * into someone else's history would be a leak with a highlight on it. And a note outlives the
 * message it marked, which no other layer can check: a regenerate peels the message, and what
 * the reader needs then is to be told, not to have the note vanish with it.
 *
 * The panel's own behaviour is the browser suite's; this file is the server's promises.
 */

let env: TestEnv;
let sessionId: string;
let lastMessageId: string;

/** A note as the client would send it: the quick action's shape is a selection, nothing more. */
async function createNote(payload: CreateNoteInput) {
  return env.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/notes`,
    payload,
  });
}

async function listNotes(): Promise<Note[]> {
  const res = await env.inject({ method: "GET", url: `/api/sessions/${sessionId}/notes` });
  expect(res.statusCode).toBe(200);
  return res.json<{ notes: Note[] }>().notes;
}

beforeAll(async () => {
  env = await startTestServer();
  const workspace = await newWorkspace(env);
  const session = await newSession(env, workspace.id);
  sessionId = session.id;

  // Seeded rather than streamed: no turn is under test here, and the fake LLM would only add
  // a way for a notes test to fail because a model call did.
  env.server.db.createMessage({ id: "m1", sessionId, role: "user", content: "what is ATP?" });
  lastMessageId = "m2";
  env.server.db.createMessage({
    id: lastMessageId,
    sessionId,
    role: "assistant",
    content: "ATP is the cell's energy currency.",
  });
});

afterAll(async () => {
  await env?.cleanup();
});

describe("creating a note", () => {
  it("records an annotation from a selection alone, defaulting to the annotation type", async () => {
    const res = await createNote({
      messageId: lastMessageId,
      quote: "energy currency",
      occurrence: 0,
    });
    expect(res.statusCode).toBe(201);
    const note = res.json<Note>();
    expect(note).toMatchObject({
      sessionId,
      messageId: lastMessageId,
      type: "annotation",
      quote: "energy currency",
      occurrence: 0,
      content: "",
      messageMissing: false,
    });
    expect(note.id).toBeTruthy();
  });

  it("records a note the user typed from the list, with no message at all", async () => {
    const res = await createNote({ type: "idea", content: "revise this before the exam" });
    expect(res.statusCode).toBe(201);
    const note = res.json<Note>();
    // Not `messageMissing`: an unanchored note never had a place to go back to, which is a
    // different fact from "there was one and it is gone".
    expect(note).toMatchObject({ messageId: null, type: "idea", quote: "", messageMissing: false });
  });

  it("offers the note up in the list, newest first", async () => {
    const older = (await createNote({ content: "first" })).json<Note>();
    const newer = (await createNote({ content: "second" })).json<Note>();
    const ids = (await listNotes()).map((n) => n.id);
    // Newest first, so the note just written is the one at the top — the order the panel
    // renders, decided here rather than by whatever the client happened to do with it.
    expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id));
  });

  it("refuses an anchor whose message is not this conversation's", async () => {
    const res = await createNote({ messageId: "m-elsewhere", quote: "x" });
    expect(res.statusCode).toBe(404);
    expect(res.json<ApiErrorBody>().error.code).toBe("MESSAGE_NOT_FOUND");
  });

  it("refuses half an anchor rather than completing it", async () => {
    // A message with no quote has nothing to put back on screen; an occurrence with no quote
    // is an offset into nothing. Both are the same answer: the client sent something it did
    // not mean, and guessing which half it meant is how a note lands on the wrong words.
    const noQuote = await createNote({ messageId: lastMessageId });
    expect(noQuote.statusCode).toBe(400);
    expect(noQuote.json<ApiErrorBody>().error.code).toBe("INVALID_FIELD");

    const noQuoteWithOccurrence = await createNote({ occurrence: 3 });
    expect(noQuoteWithOccurrence.statusCode).toBe(400);
    expect(noQuoteWithOccurrence.json<ApiErrorBody>().error.code).toBe("INVALID_FIELD");
  });

  it("refuses a type this build does not know, by name", async () => {
    const res = await createNote({ type: "shopping" as never, content: "milk" });
    expect(res.statusCode).toBe(400);
    // Its own code, not INVALID_FIELD: the two are different sentences to the reader, and the
    // client renders the code rather than the server's message.
    expect(res.json<ApiErrorBody>().error.code).toBe("NOTE_TYPE_INVALID");
  });

  it("refuses a quote past the cap", async () => {
    const res = await createNote({ messageId: lastMessageId, quote: "x".repeat(2001) });
    expect(res.statusCode).toBe(400);
    expect(res.json<ApiErrorBody>().error.code).toBe("INVALID_FIELD");
  });
});

describe("editing a note", () => {
  it("changes the body and the type, and leaves everything else alone", async () => {
    const created = (await createNote({
      messageId: lastMessageId,
      quote: "energy currency",
      occurrence: 0,
    })).json<Note>();

    const res = await env.inject({
      method: "PATCH",
      url: `/api/sessions/${sessionId}/notes/${created.id}`,
      payload: { type: "question", content: "why is it called a currency?" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<Note>()).toMatchObject({
      id: created.id,
      type: "question",
      content: "why is it called a currency?",
      // What the note *was* is not editable: the anchor and its message are settled at
      // creation, so an edit cannot move a note onto different words.
      messageId: lastMessageId,
      quote: "energy currency",
      createdAt: created.createdAt,
    });
  });

  it("keeps a field the body does not mention", async () => {
    const created = (await createNote({ type: "question", content: "first" })).json<Note>();
    const res = await env.inject({
      method: "PATCH",
      url: `/api/sessions/${sessionId}/notes/${created.id}`,
      payload: { content: "second" },
    });
    // An absent type is not "annotation" — omitting a field must not silently relabel a note.
    expect(res.json<Note>()).toMatchObject({ type: "question", content: "second" });
  });

  it("lets the body be cleared back to a bare annotation", async () => {
    const created = (await createNote({ type: "idea", content: "something" })).json<Note>();
    const res = await env.inject({
      method: "PATCH",
      url: `/api/sessions/${sessionId}/notes/${created.id}`,
      payload: { content: "" },
    });
    // An empty string is a value, not an omission — the list falls back to showing the quote.
    expect(res.json<Note>().content).toBe("");
  });

  it("answers 404 for a note id this conversation does not hold", async () => {
    const res = await env.inject({
      method: "PATCH",
      url: `/api/sessions/${sessionId}/notes/nope`,
      payload: { content: "x" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<ApiErrorBody>().error.code).toBe("NOTE_NOT_FOUND");
  });
});

describe("deleting a note", () => {
  it("soft-deletes it out of every read, and is not idempotent by accident", async () => {
    const created = (await createNote({ content: "temporary" })).json<Note>();

    const first = await env.inject({
      method: "DELETE",
      url: `/api/sessions/${sessionId}/notes/${created.id}`,
    });
    expect(first.statusCode).toBe(200);

    expect((await listNotes()).some((n) => n.id === created.id)).toBe(false);
    // The row is still there — a delete costs no disk and a restore has something to restore.
    expect(
      env.server.db.raw
        .prepare("SELECT deleted_at FROM notes WHERE id = ?")
        .get(created.id) as { deleted_at: string | null }
    ).toMatchObject({ deleted_at: expect.any(String) });

    const second = await env.inject({
      method: "DELETE",
      url: `/api/sessions/${sessionId}/notes/${created.id}`,
    });
    expect(second.statusCode).toBe(404);
  });
});

describe("a note whose message is gone", () => {
  it("survives the message being deleted, and says so", async () => {
    const created = (await createNote({
      messageId: lastMessageId,
      quote: "energy currency",
      occurrence: 0,
    })).json<Note>();
    expect(created.messageMissing).toBe(false);

    // The tail delete peels the message the note is anchored to. The note is the user's own
    // writing, so nothing may take it with the message — what changes is that "定位" has
    // nowhere to go, and the flag is how the panel learns that without guessing.
    const deleted = await env.inject({
      method: "DELETE",
      url: `/api/sessions/${sessionId}/messages/${lastMessageId}`,
    });
    expect(deleted.statusCode).toBe(200);

    const after = (await listNotes()).find((n) => n.id === created.id);
    // The quote travels with it. It is stored rather than re-derived precisely for this: there
    // is no message left to read it out of, and a row that showed nothing would be a note that
    // lost its whole point.
    expect(after).toMatchObject({ messageMissing: true, quote: "energy currency" });
  });
});
