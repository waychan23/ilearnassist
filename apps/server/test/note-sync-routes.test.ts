import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ApiErrorBody, Session, SessionNoteSync, Source, Workspace } from "@ilearnassist/shared";
import type { ProviderDef } from "../src/config.js";
import { startFakeLlm, type FakeLlm } from "./helpers/fakeLlm.js";
import { newSession, newWorkspace, startTestServer, type TestEnv } from "./helpers/tempEnv.js";

/**
 * Exporting a conversation's notes into the source library, over HTTP.
 *
 * The run goes through the **real** path — `ChatOpenAI` → `makeNoteSummarizer` → `runNoteSync` →
 * the filesystem and the registry — against the fake provider, so this is the only place that
 * proves the pieces are wired to each other rather than merely correct in isolation. The pure
 * decisions are `notesExport.test.ts`'s.
 *
 * Five claims here are the feature's promises rather than its plumbing, and no single layer could
 * check them: a note becomes an ordinary source reachable from *another* conversation; a re-sync
 * updates rather than replaces, so an `@`-reference keeps pointing at something; a note that is
 * gone takes its source with it; a failed summary writes nothing at all; and one conversation
 * runs one export at a time, with a run whose process died recoverable.
 */

let llm: FakeLlm;
let env: TestEnv;

const SUMMARY = "这次会话讨论了递归的写法，重点是基准情形和递推关系的分工。";

beforeAll(async () => {
  llm = await startFakeLlm();
  const provider: ProviderDef = {
    id: "fake",
    name: "Fake Provider",
    baseURL: llm.baseURL,
    apiKey: "test-key",
    models: [{ id: "fake-model", name: "fake-model" }],
  };
  env = await startTestServer({
    providers: [provider],
    defaultProvider: "fake",
    defaultModel: "fake-model",
  });
});

afterAll(async () => {
  await env.cleanup();
  await llm.close();
});

beforeEach(() => {
  llm.reset();
  llm.setTitle("递归练习");
  // The needle is the human message's wrapper, which is what tells this call's body from the
  // classifier's and the insight pass's — all three go through the same fake server, whose
  // body-keyed scripts resolve by substring.
  llm.setMatches([{ includes: "<session_transcript>", content: SUMMARY }]);
});

/** A conversation of its own, so no case can be disturbed by another's rows. */
async function conversation(): Promise<{ session: Session; workspace: Workspace }> {
  const workspace = await newWorkspace(env, `W-${Math.random().toString(36).slice(2)}`);
  return { session: await newSession(env, workspace.id), workspace };
}

async function addNote(sessionId: string, content: string): Promise<string> {
  const res = await env.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/notes`,
    payload: { type: "idea", content, quote: "", occurrence: 0 },
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ id: string }>().id;
}

async function exportNotes(sessionId: string, body: Record<string, unknown> = {}) {
  return env.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/notes/sync`,
    payload: body,
  });
}

/**
 * Start an export and wait for it to settle.
 *
 * The route answers `202` with the work still running — that is the shape of the feature — so
 * every assertion about the result goes through here. Bounded rather than a single sleep, so a
 * slow machine is not a flake, and it throws rather than handing an assertion a `running` state
 * it would misread.
 */
async function syncAndSettle(
  sessionId: string,
  body: Record<string, unknown> = {}
): Promise<SessionNoteSync> {
  const started = await exportNotes(sessionId, body);
  expect(started.statusCode).toBe(202);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const res = await env.inject({ method: "GET", url: `/api/sessions/${sessionId}/notes/sync` });
    const { sync } = res.json<{ sync: SessionNoteSync | null }>();
    if (sync && sync.status !== "running") return sync;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`export never settled: ${started.body}`);
}

const sourcesOf = async (sessionId: string): Promise<Source[]> => {
  const res = await env.inject({ method: "GET", url: `/api/sources?sessionId=${sessionId}` });
  expect(res.statusCode).toBe(200);
  return res.json<Source[]>();
};

/**
 * Where an exported note's bytes are, derived the way `sourcePaths.ts` derives them: the row's
 * `storage` picks the root, `relPath` says where in it, and a note's root is its conversation's
 * own directory. Reading the file at the row's own path is the assertion that matters — the
 * relPath *is* the join key the feature rests on.
 */
function exportedPath(workspace: Workspace, sessionId: string, row: Source): string {
  return join(workspace.dirPath, "sessions", sessionId, row.relPath ?? "");
}

describe("the note export", () => {
  it("turns each note into a source, and writes the context into the file", async () => {
    const { session, workspace } = await conversation();
    await addNote(session.id, "递归必须有基准情形");
    await addNote(session.id, "递推关系要把问题变小");

    const settled = await syncAndSettle(session.id);
    expect(settled).toMatchObject({ status: "ok", added: 2, updated: 0, removed: 0, error: null });

    const rows = await sourcesOf(session.id);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      // The two fields that make this its own feature: a provenance of its own rather than the
      // assistant's name on the learner's words, and material the browser renders rather than
      // offers as a download.
      expect(row.origin).toBe("note_export");
      expect(row.storage).toBe("session");
      expect(row.category).toBe("markdown");
      expect(row.ownerKind).toBe("session");
      expect(row.name).toMatch(/^(递归必须有基准情形|递推关系要把问题变小)$/);
    }

    for (const row of rows) {
      const absolute = exportedPath(workspace, session.id, row);
      expect(existsSync(absolute), `missing ${absolute}`).toBe(true);
      const text = readFileSync(absolute, "utf8");
      // The heading is the same string as the library row's name, so the two cannot disagree.
      expect(text.startsWith(`# ${row.name}\n`)).toBe(true);
      // The conversation's own title, which no turn has renamed — the fake's `title` only answers
      // the auto-titler, and this conversation has never had a turn.
      expect(text).toContain(`来自会话《${session.title}》`);
      expect(text).toContain(`会话摘要：${SUMMARY}`);
      expect(text).toContain("\n---\n");
    }
  });

  it("makes an exported note reachable from another conversation", async () => {
    // The stated purpose: material a later conversation can draw on. Being a source is not
    // enough on its own — what makes it readable is the union the `@`-link feeds, which is the
    // same list `read_document` resolves against.
    const { session } = await conversation();
    await addNote(session.id, "闭包捕获的是变量而不是值");
    await syncAndSettle(session.id);
    const [row] = await sourcesOf(session.id);

    const other = await conversation();
    env.server.db.linkSourceToSession(env.user.id, other.session.id, row!.id);

    const listed = await env.inject({ method: "GET", url: `/api/sessions/${other.session.id}/sources` });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<Source[]>().map((s) => s.id)).toContain(row!.id);
  });

  it("updates in place rather than replacing, and keeps the name it chose", async () => {
    const { session } = await conversation();
    await addNote(session.id, "第一条");
    await addNote(session.id, "第二条");
    await syncAndSettle(session.id);
    const before = await sourcesOf(session.id);

    /*
     * An unfiltered listing runs `reconcileFilesystem`, which walks every session directory and
     * re-registers every file it finds, supplying no name of its own. This is the regression test
     * for the `registerFileSource` fix: before it, both rows came back named `nt_….md` — the file
     * name — because the walk's implicit `basename` overwrote the label.
     *
     * Scoped to this conversation's ids, because the listing is account-wide by design and every
     * other case in this file has left exported rows of its own in it.
     */
    const all = await env.inject({ method: "GET", url: "/api/sources" });
    expect(all.statusCode).toBe(200);
    const mine = new Set(before.map((row) => row.id));
    const relisted = all.json<Source[]>().filter((row) => mine.has(row.id));
    expect(relisted).toHaveLength(before.length);
    expect(relisted.map((row) => row.name).sort()).toEqual(before.map((row) => row.name).sort());

    // A second sync of a conversation that has not moved on rewrites nothing: the summary is
    // deterministic here, so every file comes out byte-identical and the run is a no-op. This is
    // what makes pressing the button twice harmless.
    const unchanged = await syncAndSettle(session.id);
    expect(unchanged).toMatchObject({ status: "ok", added: 0, updated: 0, removed: 0 });

    // Now it moves on, and the new summary reaches every note's file — the summary is context, and
    // it is context for the notes that were already there too.
    llm.setMatches([
      { includes: "<session_transcript>", content: `${SUMMARY}后来还聊到了尾递归。` },
    ]);
    const resummarised = await syncAndSettle(session.id);
    expect(resummarised).toMatchObject({ status: "ok", added: 0, updated: 2, removed: 0 });

    // Same ids throughout, which is what keeps an `@`-reference from dangling.
    const after = await sourcesOf(session.id);
    expect(after.map((row) => row.id).sort()).toEqual(before.map((row) => row.id).sort());
  });

  it("takes a source away when its note is deleted, and leaves the others alone", async () => {
    const { session } = await conversation();
    const keep = await addNote(session.id, "保留的");
    const drop = await addNote(session.id, "要删掉的");
    await syncAndSettle(session.id);
    const before = await sourcesOf(session.id);
    expect(before).toHaveLength(2);

    const removed = await env.inject({
      method: "DELETE",
      url: `/api/sessions/${session.id}/notes/${drop}`,
    });
    expect(removed.statusCode).toBe(200);

    // `updated: 0` alongside it, and that is the honest number: the surviving note's file is
    // byte-identical, because its own text and the summary both went unchanged.
    const settled = await syncAndSettle(session.id);
    expect(settled).toMatchObject({ status: "ok", added: 0, updated: 0, removed: 1 });

    const rows = await sourcesOf(session.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("保留的");

    // Soft-deleted, not erased — the row and its bytes stay, for the reason every other source's
    // do. Read through raw SQL because no route returns a deleted row.
    const marks = env.server.db.raw
      .prepare("SELECT rel_path, deleted_at FROM sources WHERE owner_id = ? ORDER BY rel_path")
      .all(session.id) as { rel_path: string; deleted_at: string | null }[];
    expect(marks).toHaveLength(2);
    expect(marks.find((m) => m.rel_path === `notes/${drop}.md`)?.deleted_at).toBeTruthy();
    expect(marks.find((m) => m.rel_path === `notes/${keep}.md`)?.deleted_at).toBeNull();
  });

  it("runs one export at a time, and lets a dead one be recovered", async () => {
    const { session } = await conversation();
    await addNote(session.id, "笔记");

    // A run that is alive is refused without `force`.
    env.server.db.saveNoteSyncState({
      sessionId: session.id,
      status: "running",
      startedAt: new Date().toISOString(),
    });
    const refused = await exportNotes(session.id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json<ApiErrorBody>().error.code).toBe("SYNC_IN_PROGRESS");

    expect((await exportNotes(session.id, { force: true })).statusCode).toBe(202);

    /*
     * A run whose owner is gone: the state says so, and a plain press recovers it with no force
     * at all. That second half is the requirement rather than a convenience — the recovery must
     * not depend on the reader knowing that `force` exists.
     */
    env.server.db.saveNoteSyncState({
      sessionId: session.id,
      status: "running",
      startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    const read = await env.inject({ method: "GET", url: `/api/sessions/${session.id}/notes/sync` });
    expect(read.json<{ sync: unknown }>().sync).toMatchObject({
      status: "running",
      stuck: true,
    });
    expect((await exportNotes(session.id)).statusCode).toBe(202);
  });

  it("never coerces `force`", async () => {
    // `"false"` is truthy, so a coerced field would turn a refusal into a second concurrent run
    // over the same files — the rule `PATCH /api/admin/users/:id` follows for `disabled`.
    const { session } = await conversation();
    const res = await exportNotes(session.id, { force: "true" });
    expect(res.statusCode).toBe(400);
    expect(res.json<ApiErrorBody>().error.code).toBe("INVALID_FIELD");
  });

  it("writes nothing at all when the summary cannot be used", async () => {
    const { session, workspace } = await conversation();
    await addNote(session.id, "第一条");
    await addNote(session.id, "第二条");
    await syncAndSettle(session.id);
    const before = await sourcesOf(session.id);
    const bytes = before.map((row) => readFileSync(exportedPath(workspace, session.id, row), "utf8"));

    // A model that answered with nothing usable.
    llm.setMatches([{ includes: "<session_transcript>", content: "" }]);
    const settled = await syncAndSettle(session.id, { force: true });
    expect(settled).toMatchObject({ status: "failed" });
    expect(settled.error).toBeTruthy();

    /*
     * Every row and every byte exactly as it was. Half-writing would be the worst outcome
     * available: the files embed the summary as their context, so a run that replaced a good
     * summary with an empty one would have made the notes worse than they already were.
     */
    const after = await sourcesOf(session.id);
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
    expect(after.map((row) => readFileSync(exportedPath(workspace, session.id, row), "utf8"))).toEqual(
      bytes
    );
  });

  it("says `empty` without calling the model when there are no notes", async () => {
    const { session } = await conversation();
    const settled = await syncAndSettle(session.id);
    expect(settled).toMatchObject({ status: "empty", added: 0, updated: 0, removed: 0 });

    // Nothing was asked of the provider: a summary of a conversation with no notes in it would be
    // a model call spent on material the export does not keep.
    expect(llm.requests()).toHaveLength(0);
    expect(await sourcesOf(session.id)).toHaveLength(0);
  });

  it("answers `null` rather than an error for a conversation nobody has exported", async () => {
    const { session } = await conversation();
    const res = await env.inject({ method: "GET", url: `/api/sessions/${session.id}/notes/sync` });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ sync: unknown }>().sync).toBeNull();
  });
});
