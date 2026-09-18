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

/**
 * A note about a 图 or a 表, which is the same entity with a different thing at the other end.
 *
 * The anchor rules are the ones under test, and they mirror the passage anchor's exactly: both
 * halves or neither, and one anchor rather than two. What is *different* is that the name is
 * normalised on the way in — a figure's name is this app's join key, so the note has to store
 * the canonical one rather than whatever the caller typed.
 */
describe("a note about a figure", () => {
  /** A diagram as the tool would have written it: a row, plus the name that is its identity. */
  function seedDiagram(name: string): void {
    env.server.db.upsertDiagram({
      id: `d-${name}`,
      sessionId,
      name,
      fileId: `f-${name}`,
      summary: "A flow",
      toolCallId: null,
    });
  }

  function seedTable(name: string): void {
    env.server.db.upsertSessionTable({
      id: `t-${name}`,
      sessionId,
      name,
      summary: "A table",
      content: "| a |\n| - |\n| 1 |",
      toolCallId: null,
    });
  }

  it("stores the canonical name, whatever spelling the client used", async () => {
    seedDiagram("auth-flow.mmd");
    /*
     * The name is a server-side rule both ways — `diagramFileName` on this side, the same
     * normalisation in `ila_query` — so a note that kept the caller's spelling would be the one
     * place the note, the panel's chip and the model's lookup disagreed.
     */
    const res = await createNote({ targetKind: "diagram", targetRef: "Auth Flow", content: "看这里" });
    expect(res.statusCode).toBe(201);
    const note = res.json<Note>();
    expect(note.targetKind).toBe("diagram");
    expect(note.targetRef).toBe("auth-flow.mmd");
    expect(note.quote).toBe("");
    expect(note.targetMissing).toBe(false);
  });

  it("records a table target the same way, on its own name space", async () => {
    seedTable("scores");
    const res = await createNote({ targetKind: "table", targetRef: "Scores", content: "第二行" });
    expect(res.statusCode).toBe(201);
    expect(res.json<Note>().targetRef).toBe("scores");
  });

  it("refuses half a figure target rather than completing it", async () => {
    // The same rule as the passage anchor, and for the same reason: a kind with no name is a
    // note about nothing, and a name with no kind cannot be looked for — both `diagramFileName`
    // and `tableName` would claim it.
    const noRef = await createNote({ targetKind: "diagram" });
    expect(noRef.statusCode).toBe(400);
    expect(noRef.json<ApiErrorBody>().error.code).toBe("INVALID_FIELD");

    const noKind = await createNote({ targetRef: "auth-flow.mmd" });
    expect(noKind.statusCode).toBe(400);
    expect(noKind.json<ApiErrorBody>().error.code).toBe("INVALID_FIELD");
  });

  it("records a figure's own title as its 标注原文, and still refuses a passage", async () => {
    /*
     * One note names one thing, and the test of "a passage" is the `messageId` and the
     * `occurrence` — not the quote. An object note has a 标注原文 with nothing quoted in it,
     * holding the object's title, so a bare `quote` is a title rather than a second anchor.
     * Refusing it was refusing the only thing an object note can put in the field the reader
     * sees, which is why this half flipped from 400 to 201.
     */
    const withTitle = await createNote({
      targetKind: "diagram",
      targetRef: "auth-flow.mmd",
      quote: "登录与刷新的时序",
    });
    expect(withTitle.statusCode).toBe(201);
    expect(withTitle.json<Note>().quote).toBe("登录与刷新的时序");
    expect(withTitle.json<Note>().messageId).toBeNull();

    // A message is an anchor, and two anchors in one request is still a client that assembled
    // two different notes — either reading would throw away half of what was sent.
    const withMessage = await createNote({
      targetKind: "diagram",
      targetRef: "auth-flow.mmd",
      messageId: lastMessageId,
      quote: "some words",
    });
    expect(withMessage.statusCode).toBe(400);
    expect(withMessage.json<ApiErrorBody>().error.code).toBe("INVALID_FIELD");

    // And an occurrence without a message is an offset into nothing, so it is refused on the
    // same grounds rather than silently counted over the object's title.
    const withOccurrence = await createNote({
      targetKind: "diagram",
      targetRef: "auth-flow.mmd",
      quote: "登录与刷新的时序",
      occurrence: 1,
    });
    expect(withOccurrence.statusCode).toBe(400);
    expect(withOccurrence.json<ApiErrorBody>().error.code).toBe("INVALID_FIELD");
  });

  it("refuses a figure this conversation does not hold, under its own code", async () => {
    const res = await createNote({ targetKind: "diagram", targetRef: "no-such-thing" });
    expect(res.statusCode).toBe(404);
    // Its own code rather than MESSAGE_NOT_FOUND: a message id and a figure name are different
    // things to have lost, and the client says so in different words.
    expect(res.json<ApiErrorBody>().error.code).toBe("FIGURE_NOT_FOUND");
  });

  it("reports the figure as missing once its row is gone, without losing the note", async () => {
    seedTable("short-lived");
    const note = (
      await createNote({ targetKind: "table", targetRef: "short-lived", content: "记一下" })
    ).json<Note>();
    expect(note.targetMissing).toBe(false);

    // A table is derived data with no `deleted_at`, so a revise that renames it really removes
    // the row — and the note has to survive that, the way it survives a peeled message.
    env.server.db.raw.prepare("DELETE FROM session_tables WHERE id = ?").run(`t-short-lived`);

    const found = (await listNotes()).find((n) => n.id === note.id);
    expect(found, "the note should still be in the list").toBeDefined();
    expect(found!.targetMissing).toBe(true);
    expect(found!.content).toBe("记一下");
  });

  it("does not let a table stand in for a missing diagram of the same name", async () => {
    /*
     * The `target_kind` guard on each half of the expression, and this is the case that needs it:
     * a diagram and a table may share a name, so without the guard one row's presence would make
     * the other's absence read as present — a chip that opens a figure the note was never about.
     *
     * Both figures exist when the note is written; only the *diagram* is then removed, while the
     * table of the same name stays. The note is about the diagram, so it is missing.
     */
    seedDiagram("shared-name.mmd");
    seedTable("shared-name");
    const note = (
      await createNote({ targetKind: "diagram", targetRef: "shared-name", content: "图" })
    ).json<Note>();
    expect(note.targetMissing).toBe(false);

    env.server.db.raw
      .prepare("DELETE FROM session_diagrams WHERE id = ?")
      .run("d-shared-name.mmd");

    const found = (await listNotes()).find((n) => n.id === note.id);
    expect(found!.targetMissing).toBe(true);

    /*
     * Then the same pair with the roles swapped, and *this* is the assertion the guard carries:
     * a table of the name exists, no diagram of it ever did, and without the `target_kind` guard
     * the diagram half of the expression would report the table note as missing. Both figures
     * named `other-name` are impossible to confuse, so the two cases together pin the expression
     * in both directions rather than one.
     */
    seedTable("only-a-table");
    const tableNote = (
      await createNote({ targetKind: "table", targetRef: "only-a-table", content: "表" })
    ).json<Note>();
    expect(tableNote.targetMissing).toBe(false);
  });

  it("keeps the target out of an edit's reach", async () => {
    // What a note *was* is settled at creation — the rule the passage anchor already follows.
    // A PATCH sends only the type and the body, so the target cannot be re-pointed.
    seedDiagram("sticky.mmd");
    const note = (
      await createNote({ targetKind: "diagram", targetRef: "sticky.mmd", content: "初稿" })
    ).json<Note>();

    const res = await env.inject({
      method: "PATCH",
      url: `/api/sessions/${sessionId}/notes/${note.id}`,
      payload: { content: "改过", targetRef: "something-else" },
    });
    expect(res.statusCode).toBe(200);
    const updated = res.json<Note>();
    expect(updated.content).toBe("改过");
    expect(updated.targetRef).toBe("sticky.mmd");
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

/**
 * A note about the material the conversation is working from.
 *
 * The third kind of target, and the one whose validation is scoped differently from the other
 * two: a diagram and a table are found inside this conversation, while a resource may
 * legitimately be held by another workspace — which is exactly what the `@` picker offers and
 * what the read whitelist admits through a grant. So the checks below are about *whose* material
 * it may be, and about what the panel says when that material goes away.
 */
describe("a note about a resource", () => {
  /** A file row and this conversation's reference to it. */
  function seedResource(id: string, userId = env.user.id): string {
    const file = env.server.db.createFile({
      id: `file-${id}`,
      userId,
      sourceType: "agent_create",
      title: `${id}.md`,
      path: `workspaces/test-workspace/workdir/${id}.md`,
      mimeType: "text/markdown",
      category: "markdown",
      size: 3,
    });
    env.server.db.upsertWorkResource({
      id,
      userId,
      resourceType: "file",
      resourceId: file.id,
      ownerType: "session",
      ownerId: sessionId,
      title: file.title,
    });
    return id;
  }

  it("stores the reference id as the target", async () => {
    const id = seedResource("wr-note-1");
    const res = await createNote({ targetKind: "resource", targetRef: id });
    expect(res.statusCode).toBe(201);
    expect(res.json<Note>()).toMatchObject({ targetKind: "resource", targetRef: id });
  });

  it("refuses an id that is nobody's", async () => {
    // The owner check is the whole validation, and a reference from another account is simply
    // not found — the "not yours and does not exist answer alike" rule the routes follow.
    const mine = seedResource("wr-note-2");
    const other = env.server.db.createUser({
      id: "someone-else",
      username: "other",
      slug: "other",
    });
    void other;
    const theirs = seedResource("wr-note-theirs", "someone-else");

    expect((await createNote({ targetKind: "resource", targetRef: mine })).statusCode).toBe(201);
    expect((await createNote({ targetKind: "resource", targetRef: theirs })).statusCode).toBe(404);
    expect((await createNote({ targetKind: "resource", targetRef: "nope" })).statusCode).toBe(404);
  });

  it("reports the target missing once the reference is gone", async () => {
    const id = seedResource("wr-note-3");
    const created = (await createNote({ targetKind: "resource", targetRef: id })).json<Note>();
    expect(created.targetMissing).toBe(false);

    env.server.db.softDeleteWorkResourceForUser(id, env.user.id);

    const after = (await listNotes()).find((n) => n.id === created.id);
    // Reported rather than refused, on the note rule: a note outlives what it points at, and
    // what the reader needs is to be told — the same answer `messageMissing` gives.
    expect(after).toMatchObject({ targetMissing: true, targetRef: id });
  });

  it("does not call a cross-workspace reference missing", async () => {
    /*
     * The arm's scope, pinned. A reference held by another workspace is a legitimate target —
     * the `@` picker offers them — so scoping `target_missing` by the note's conversation would
     * report a perfectly live reference as gone, and the chip would quietly lose its 定位
     * control. Asserted through a second workspace because that is the only way to build the
     * case at all.
     */
    const other = env.server.db.createWorkspace({
      userId: env.user.id,
      id: "w-elsewhere",
      name: "Elsewhere",
      slug: "elsewhere",
      dirPath: "/tmp/elsewhere",
    });
    void other;
    const file = env.server.db.createFile({
      id: "file-elsewhere",
      userId: env.user.id,
      sourceType: "agent_create",
      title: "elsewhere.md",
      path: "workspaces/elsewhere/workdir/elsewhere.md",
      mimeType: "text/markdown",
      category: "markdown",
      size: 3,
    });
    env.server.db.upsertWorkResource({
      id: "wr-elsewhere",
      userId: env.user.id,
      resourceType: "file",
      resourceId: file.id,
      ownerType: "workspace",
      ownerId: "w-elsewhere",
      title: file.title,
    });

    const created = (
      await createNote({ targetKind: "resource", targetRef: "wr-elsewhere" })
    ).json<Note>();
    expect(created).toMatchObject({ targetMissing: false, targetRef: "wr-elsewhere" });
  });
});
