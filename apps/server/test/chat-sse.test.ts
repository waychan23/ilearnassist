import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Attachment,
  ChatStreamEvent,
  DirectoryListing,
  Message,
  Session,
  Workspace,
} from "@ilearnassist/shared";
import type { ProviderDef } from "../src/config.js";
import { DEFAULT_SESSION_TITLE } from "../src/db.js";
import { serverTimeZone } from "../src/agent/clock.js";
import { ensureWorkResource, registerFile } from "../src/resources.js";
import { resolveFilePath } from "../src/resourcePaths.js";
import { eventTypes, parseSse } from "./helpers/sse.js";
import { startFakeLlm, type FakeLlm } from "./helpers/fakeLlm.js";
import { newSession, newWorkspace, startTestServer, type TestEnv } from "./helpers/tempEnv.js";

/**
 * The chat route end to end: HTTP request → real agent loop → real SSE frames → persisted
 * messages. Only the model is fake. `inject()` captures the hijacked SSE response in full,
 * so no port is bound and the assertions run on the exact bytes the browser would receive.
 */

/** A real 1x1 PNG, so an image attachment is an image rather than bytes pretending to be one. */
const ONE_PX_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

/** The source fields these cases read, so the assertions do not rest on the whole wire type. */
/**
 * The shape these cases read off a library row.
 *
 * A v4 row is a **reference** with its entity attached, so what used to be flat is now two
 * levels: the sandbox and the file's kind live on `resource`, the ownership and the parse state
 * on the reference itself.
 */
interface ResourceRowish {
  id: string;
  resourceId: string;
  ownerType: string;
  title: string;
  parseStatus: string;
  missing?: boolean;
  resource: { path: string; category: string; mimeType: string; sourceType: string };
}

let llm: FakeLlm;
let env: TestEnv;

beforeAll(async () => {
  llm = await startFakeLlm();
  const provider: ProviderDef = {
    id: "fake",
    name: "Fake Provider",
    baseURL: llm.baseURL,
    apiKey: "test-key",
    // `fake-vision` picks up the `vision` capability from `guessCapabilities`.
    models: [{ id: "fake-model", name: "fake-model" }, { id: "fake-vision", name: "fake-vision" }],
  };
  env = await startTestServer({ providers: [provider], defaultProvider: "fake", defaultModel: "fake-model" });
});

afterAll(async () => {
  await env.cleanup();
  await llm.close();
});

beforeEach(() => {
  llm.reset();
  llm.setTitle("Fake Conversation Title");
});

/**
 * Whether the suite's model can see, as the *provider record* says.
 *
 * The one piece of state a case has to set and put back: a session resolves its capabilities from
 * the provider's model row, and that row is seeded once for the whole file — so a case that
 * declares vision and does not restore it turns every later case's image handling around. The
 * seeded value is `["tool_use"]`, which is what `seedConfig` writes for a model whose config
 * declares nothing.
 */
function setVision(on: boolean): void {
  const model = env.server.db.getProvider("fake")!.models[0]!;
  env.server.db.updateModel(model.id, { capabilities: on ? ["vision", "tool_use"] : ["tool_use"] });
}

afterEach(() => {
  setVision(false);
});

async function chat(sessionId: string, payload: Record<string, unknown>) {
  const res = await env.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/chat`,
    payload,
  });
  return { res, events: parseSse(res.body) as ChatStreamEvent[] };
}

/**
 * The request the *turn* made, out of everything the fake LLM recorded.
 *
 * Not `requests()[0]`. The turn fires side calls of its own — the auto-titler, and the image
 * summary pass — and a fire-and-forget one can land *after the test has reset the recorder*,
 * so "the first request" is whichever of them got there first. Matching on the user's own words
 * is what makes these assertions about the turn rather than about the race.
 *
 * `text` must therefore be unique to the calling test. The image-summary pass carries a sample
 * of the conversation, so two image tests that both said "what is this" would have their side
 * calls match each other's marker — which is exactly how this was found.
 */
function turnRequest(text: string): { messages: { role: string; content: unknown }[] } {
  const found = llm
    .requests()
    .find((r) => JSON.stringify(r).includes(text)) as
    | { messages: { role: string; content: unknown }[] }
    | undefined;
  if (!found) throw new Error(`no request carrying "${text}" was recorded`);
  return found;
}

async function messagesOf(sessionId: string): Promise<Message[]> {
  return (await env.inject({ method: "GET", url: `/api/sessions/${sessionId}/messages` })).json<Message[]>();
}

/** The workspace owning the session under test, set by `freshSession`. */
let currentWorkspaceId: string;

async function sessionOf(sessionId: string): Promise<Session> {
  const sessions = (
    await env.inject({ method: "GET", url: `/api/workspaces/${currentWorkspaceId}/sessions` })
  ).json<Session[]>();
  return sessions.find((s) => s.id === sessionId)!;
}

async function freshSession(): Promise<{
  session: Session;
  workdirPath: string;
  sessionDirPath: string;
  workspace: Workspace;
}> {
  const workspace = await newWorkspace(env, `W-${Math.random().toString(36).slice(2)}`);
  currentWorkspaceId = workspace.id;
  const session = await newSession(env, workspace.id);
  return {
    session,
    workspace,
    workdirPath: workspace.workdirPath,
    sessionDirPath: join(workspace.dirPath, "sessions", session.id),
  };
}

describe("POST /api/sessions/:id/chat", () => {
  it("validates the request", async () => {
    const { session } = await freshSession();

    expect((await env.inject({ method: "POST", url: "/api/sessions/nope/chat", payload: { message: "hi" } })).statusCode).toBe(404);

    const empty = await env.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/chat`,
      payload: { message: "   " },
    });
    expect(empty.statusCode).toBe(400);
  });

  it("streams the answer and persists both turns", async () => {
    const { session } = await freshSession();
    llm.setTurns([{ content: "Hello from the model", usage: { input: 30, output: 6 } }]);

    const { res, events } = await chat(session.id, { message: "hi there" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");

    // Framing: meta first, done last, and the answer in between.
    expect(events[0]).toEqual({ type: "meta", sessionId: session.id });
    expect(events.at(-1)).toEqual({ type: "done" });
    expect(eventTypes(res.body)).toEqual([
      "meta",
      // The persisted row for the user's own message: the client has been drawing that
      // bubble optimistically and needs the server's id to be able to address it.
      "message_saved",
      "text",
      "usage",
      "message_done",
      "title",
      "done",
    ]);

    const done = events.find((e) => e.type === "message_done") as { message: Message };
    expect(done.message).toMatchObject({ role: "assistant", content: "Hello from the model" });
    expect(done.message.usage).toMatchObject({ inputTokens: 30, outputTokens: 6 });

    const persisted = await messagesOf(session.id);
    expect(persisted.map((m) => [m.role, m.content])).toEqual([
      ["user", "hi there"],
      ["assistant", "Hello from the model"],
    ]);
  });

  it("streams reasoning separately from the answer", async () => {
    const { session } = await freshSession();
    llm.setTurns([{ reasoning: "weighing options", content: "the answer" }]);

    const { events } = await chat(session.id, { message: "why?" });

    expect(events.filter((e) => e.type === "reasoning")).toEqual([{ type: "reasoning", delta: "weighing options" }]);
    const persisted = await messagesOf(session.id);
    expect(persisted[1]!.reasoning).toBe("weighing options");
    expect(persisted[1]!.content).toBe("the answer");
  });

  it("runs a tool call and records it on the assistant message", async () => {
    const { session, sessionDirPath } = await freshSession();
    llm.setTurns([
      { content: "Writing the file.", toolCalls: [{ id: "call_1", name: "write_file", args: { path: "out.txt", content: "done" } }] },
      { content: "Wrote it." },
    ]);

    const { events } = await chat(session.id, { message: "write a file" });

    expect(events.map((e) => e.type)).toEqual([
      "meta",
      "message_saved",
      "text",
      "tool_start",
      "tool_end",
      "text",
      "usage",
      "message_done",
      "title",
      "done",
    ]);

    const started = events.find((e) => e.type === "tool_start") as { toolCall: { name: string } };
    expect(started.toolCall.name).toBe("write_file");

    /*
     * The tool really ran, into the conversation's **own** folder — which is the default an
     * unqualified write gets. It used to be the workspace's `workdir/`, and the change is the
     * product decision the setting exists for: a workspace directory every conversation writes
     * into becomes a junk drawer, so a file that is about one conversation belongs to it.
     */
    expect(existsSync(join(sessionDirPath, "out.txt"))).toBe(true);
    expect(readFileSync(join(sessionDirPath, "out.txt"), "utf8")).toBe("done");

    const persisted = await messagesOf(session.id);
    expect(persisted[1]!.toolCalls).toHaveLength(1);
    expect(persisted[1]!.toolCalls![0]).toMatchObject({ name: "write_file" });
    expect(persisted[1]!.toolCalls![0]!.output).toContain("Wrote 4 characters");
  });

  it("leaves a row for every file the turn writes", async () => {
    /*
     * The registry's end-to-end claim, through the real route rather than the registry's own
     * test: a tool writes bytes, and the rows that come out have the same shape the file manager
     * and the library will read. What it pins beyond "a row exists" is the pair a second
     * implementation would get wrong — the file lands in the conversation's own folder, and the
     * reference says the conversation owns it rather than the workspace.
     */
    const { session, sessionDirPath } = await freshSession();
    llm.setTurns([
      {
        content: "Writing.",
        toolCalls: [
          { id: "call_1", name: "write_file", args: { path: "notes/a.md", content: "# hi" } },
        ],
      },
      { content: "Done." },
    ]);

    await chat(session.id, { message: "write a file" });

    const rows = (await env.inject({ method: "GET", url: "/api/resources" })).json<
      ResourceRowish[]
    >();
    const row = rows.find((r) => r.resource.path.endsWith("/notes/a.md"))!;
    expect(row).toBeTruthy();
    expect(row.ownerType).toBe("session");
    expect(row.resource.sourceType).toBe("agent_create");
    expect(row.resource.category).toBe("markdown");
    expect(row.resource.mimeType).toBe("text/markdown");
    expect(row.missing).toBe(false);
    expect(existsSync(join(sessionDirPath, "notes/a.md"))).toBe(true);
  });

  it("deletes a file it wrote through the reference, so no row outlives the bytes", async () => {
    /*
     * **The path that used to bypass the registry.** `delete_file` unlinked and touched no row, so
     * the `files` row went on naming a file that was not there and the library went on listing it
     * — the state every read has to *compute* its way out of (`missing`, `fileMissing`). It goes
     * through `deleteWorkResource` now, which is the same operation the file manager's route and
     * the library's rows end in: the reference, the row and the bytes go together, and any other
     * conversation that pointed at the file keeps its row and starts reporting it as gone.
     */
    const { session, sessionDirPath } = await freshSession();
    llm.setTurns([
      {
        content: "Writing.",
        toolCalls: [{ id: "call_1", name: "write_file", args: { path: "scratch.md", content: "# hi" } }],
      },
      { content: "Done." },
    ]);
    await chat(session.id, { message: "write a note" });

    const before = (await env.inject({ method: "GET", url: "/api/resources" })).json<
      { id: string; resource: { id: string; path: string } }[]
    >();
    const written = before.find((r) => r.resource.path.endsWith("/scratch.md"))!;
    expect(written).toBeTruthy();

    llm.setTurns([
      {
        content: "Deleting.",
        toolCalls: [{ id: "call_2", name: "delete_file", args: { path: "scratch.md" } }],
      },
      { content: "Deleted." },
    ]);
    await chat(session.id, { message: "delete that note" });

    // The bytes are gone from the sandbox — moved to the workspace's trash, which is what the
    // unified delete does with a sandbox file rather than unlinking it.
    expect(existsSync(join(sessionDirPath, "scratch.md"))).toBe(false);
    // Nothing lists it any more, and the two rows it was made of are gone as live rows: the
    // reference, and the file. A row left behind is what this test exists to catch.
    const after = (await env.inject({ method: "GET", url: "/api/resources" })).json<
      { resource: { path: string } }[]
    >();
    expect(after.some((r) => r.resource.path.endsWith("/scratch.md"))).toBe(false);
    expect(env.server.db.getWorkResourceForUser(env.user.id, written.id)).toBeUndefined();
    expect(env.server.db.getFileForUser(env.user.id, written.resource.id)).toBeUndefined();
  });

  it("records a workspace write as the workspace's", async () => {
    // The other half of `fileOwner`, and the reason it is a function: the *act* happened in a
    // conversation, but a file every conversation in the workspace can read belongs to the
    // workspace, and a row claiming otherwise would put it under the wrong filter.
    const { session, workdirPath } = await freshSession();
    llm.setTurns([
      {
        content: "Writing.",
        toolCalls: [
          {
            id: "call_1",
            name: "write_file",
            args: { path: "shared/a.md", content: "# hi", location: "workspace" },
          },
        ],
      },
      { content: "Done." },
    ]);

    await chat(session.id, { message: "write a shared file" });

    const rows = (await env.inject({ method: "GET", url: "/api/resources" })).json<
      ResourceRowish[]
    >();
    const row = rows.find((r) => r.resource.path.endsWith("/shared/a.md"))!;
    expect(row).toBeTruthy();
    expect(row.ownerType).toBe("workspace");
    expect(row.resource.sourceType).toBe("agent_create");
    expect(existsSync(join(workdirPath, "shared/a.md"))).toBe(true);
  });

  it("links and records a resource the turn pointed at with @", async () => {
    /*
     * A `@`-reference and a 追问 are the same mechanism now — a `TurnReference` of kind
     * `resource` — so what this pins is the three halves of one gesture, each a different claim.
     *
     * The reference is **linked**: the chat route gives this conversation a reference of its own
     * to the same entity, which is what lets a later turn `read_document` it without the user
     * pointing at it again and what puts it in the whitelist the tool is built from. The
     * **snapshot** is recorded on the message as a ref, so the chip can say what the question was
     * about. And the **content** reaches the model, because a reference that only appeared in a
     * chip would be a turn the user thinks is about a file and the model has never seen.
     *
     * v3 wrote the second half into `messages.sources`, its own column beside `attachments`.
     * That column is gone: the reference *is* the message's record of what it pointed at, and a
     * second copy would be a second thing to keep in agreement.
     */
    const { session } = await freshSession();
    const uploaded = await env
      .inject({
        method: "POST",
        url: `/api/sessions/${session.id}/resources`,
        payload: {
          name: "referenced.txt",
          mimeType: "text/plain",
          data: Buffer.from("the referenced body").toString("base64"),
        },
      })
      .then((r) => r.json<{ id: string; resourceId: string }>());

    llm.setTurns([{ content: "read it" }]);
    await chat(session.id, {
      message: "look at this",
      refs: [{ kind: "resource", ref: uploaded.resourceId, label: "referenced.txt" }],
    });

    const persisted = await messagesOf(session.id);
    const user = persisted[0]!;
    expect(user.refs).toHaveLength(1);
    expect(user.refs![0]).toMatchObject({ kind: "resource", label: "referenced.txt" });
    // Not in `attachments`: an upload and a pointer are different things and say so.
    expect(user.attachments).toBeUndefined();

    // Every request of the turn, because the *last* one is the auto-titler's — a side call
    // that sees the conversation and is not the turn.
    const bodies = llm
      .requests()
      .map((r) => JSON.stringify((r as { messages: unknown }).messages))
      .join("\n");
    // The block names the reference and says how to read it, which is what makes the pointer
    // usable rather than merely present.
    expect(bodies).toContain("read_document");
    expect(bodies).toContain("referenced.txt");

    // The link, which is what a later turn reads the whitelist from.
    const readable = (
      await env.inject({ method: "GET", url: `/api/sessions/${session.id}/resources` })
    ).json<{ resourceId: string }[]>();
    expect(readable.map((r) => r.resourceId)).toContain(uploaded.id);
  });

  it("refers to a page it does not hold, and makes the holder readable", async () => {
    /*
     * Two claims at once, and they are the shape of the whole change.
     *
     * **The link is a reference, not a holding.** Pointing at the workspace's page adds a
     * `session_references` row and **no** `work_resources` row — which is what stops the library
     * showing one file once per conversation that mentioned it.
     *
     * **And the text still has to be reachable.** A page's extracted text is reachable only
     * through a holding row, and `documents.schedule` cannot produce one for a page — `text/html`
     * is not a document MIME, and the service early-returns before writing anything. So the
     * schedule (and `adoptPageParse` before it) runs against the **holder**, and the conversation
     * reads through it: one extraction, every referrer.
     *
     * The page is seeded as the capture path leaves it — a `web_pages` row, a text file, and a
     * reference whose `parsed_file_id` points at it — because the real capture route fetches a
     * URL through the SSRF guard, which refuses loopback and cannot run offline.
     */
    const { session } = await freshSession();
    const db = env.server.db;

    const page = db.createWebPage({
      id: `p-${Math.random().toString(36).slice(2)}`,
      userId: env.user.id,
      sourceType: "agent_fetch",
      url: "https://example.com/kept",
      title: "递归入门",
      sha256: "a".repeat(64),
    });
    const text = registerFile(db, {
      userId: env.user.id,
      path: `users/${env.user.slug}/sources/parsed/${page.id}.txt`,
      sourceType: "agent_create",
      size: 12,
      title: "递归入门 (text)",
      mimeType: "text/plain",
    });
    const kept = ensureWorkResource(db, {
      userId: env.user.id,
      owner: { kind: "workspace", id: currentWorkspaceId },
      resourceType: "web_page",
      resourceId: page.id,
      title: page.title,
    })!;
    db.updateWorkResourceParse({
      id: kept.id,
      userId: env.user.id,
      status: "ready",
      parsedChars: 12,
      parsedFileId: text.id,
    });

    llm.setTurns([{ content: "read it" }]);
    await chat(session.id, {
      message: "看一下这个网页",
      refs: [{ kind: "resource", ref: kept.id, label: page.title }],
    });

    // The link, which is the only row this conversation gained — and it names the **reference**
    // the user pointed at, which is what every other reader reaches material through.
    expect(db.listSessionReferences(session.id)).toEqual([kept.id]);
    // And **no** holding row — the assertion the library's duplication was made of.
    expect(
      db.listWorkResourcesForResource(env.user.id, "web_page", page.id).map((r) => r.ownerType)
    ).toEqual(["workspace"]);

    // The holder's row is what the conversation reads, and it is readable.
    const held = db.getWorkResourceForUser(env.user.id, kept.id)!;
    expect(held.parseStatus).toBe("ready");
    expect(held.parsedFileId).toBe(text.id);

    // ...and the whitelist admits it through the reference, so `read_document` takes that id.
    const readable = (
      await env.inject({ method: "GET", url: `/api/sessions/${session.id}/resources` })
    ).json<{ id: string }[]>();
    expect(readable.map((r) => r.id)).toContain(kept.id);
  });

  it("says an image was not understood, rather than letting the reply imply it was", async () => {
    /*
     * The silent failure this closes: with no vision the image reaches the prompt as a
     * placeholder, so the reply reads as though the picture was considered and had nothing to
     * say. Nothing on screen distinguished that from a model that looked and answered about it.
     *
     * The line rides the turn's own message rather than being posted afterwards, and that is
     * forced rather than chosen: `runAgentStream` has already emitted `message_done` by the time
     * `finishTurn` runs, so a row created there would appear only on a reload.
     */
    const { session } = await freshSession();
    const image = await env
      .inject({
        method: "POST",
        url: `/api/sessions/${session.id}/resources`,
        payload: { name: "cat.png", mimeType: "image/png", data: ONE_PX_PNG.toString("base64") },
      })
      .then((r) => r.json<Attachment>());
    expect(image.kind).toBe("image");

    llm.setTurns([{ content: "看过了。" }]);
    await chat(session.id, { message: "看看这张图", attachments: [image] });

    const persisted = await messagesOf(session.id);
    const reply = persisted.find((m) => m.role === "assistant")!;
    // The model's own sentence is kept, and the note follows it — the reply is not replaced.
    expect(reply.content).toContain("看过了。");
    expect(reply.content).toContain("⚠️");
    expect(reply.content).toContain("cat.png");
    expect(reply.content).toContain("不支持图片输入");
  });

  it("describes the image for later turns, when the model can see it", async () => {
    /*
     * The other half of `summarizeTurnImages`, and the half that was **broken**: the description
     * was written to `parsed/<imageId>.txt` with no `files` row and no `parsed_file_id`, so no
     * reader could reach it — `read_document` follows a reference's pointer to a *row* and
     * resolves that row's path. The id was the image's own, too, which cannot work: `files.id` is
     * a primary key, so a parse result cannot share the row its bytes live on.
     */
    const { session } = await freshSession();
    const db = env.server.db;
    // A model that can see has to be declared — through the same accessor the console's settings
    // route writes, and restored by the `afterEach` above.
    setVision(true);
    llm.setTitle("一张纯色小图。");

    const image = await env
      .inject({
        method: "POST",
        url: `/api/sessions/${session.id}/resources`,
        payload: { name: "cat.png", mimeType: "image/png", data: ONE_PX_PNG.toString("base64") },
      })
      .then((r) => r.json<Attachment>());

    llm.setTurns([{ content: "看过了。" }]);
    await chat(session.id, { message: "看看这张图", attachments: [image] });

    // The pass is fire-and-forget from `finishTurn`, so the row arrives a moment after `done`.
    const reference = await vi.waitFor(() => {
      const held = db.listWorkResourcesForResource(env.user.id, "file", image.id)[0];
      expect(held?.parsedFileId).toBeTruthy();
      return held!;
    });

    expect(reference.parseStatus).toBe("ready");
    // A pointer to a **row**, and the row's stored path is where the text actually is — which is
    // the whole difference between this and a file nothing can find.
    const text = db.getFileForUser(env.user.id, reference.parsedFileId!)!;
    expect(text.mimeType).toBe("text/plain");
    expect(text.path).toContain("/parsed/");
    expect(readFileSync(resolveFilePath(env.userLayout, text)!, "utf8")).toContain("一张纯色小图");

    // And the model can read it back, which is the promise the docblock makes.
    const readable = await env.inject({
      method: "GET",
      url: `/api/sessions/${session.id}/resources`,
    });
    expect(readable.statusCode).toBe(200);
  });

  it("does not hold what it merely refers to, so the library shows it once", async () => {
    /*
     * **The reported bug.** `@`-ing a workspace file used to write a holding row for the
     * conversation, and the library lists holdings — so one file appeared once per conversation
     * that had mentioned it. It is the same file throughout: a reference points at an entity, and
     * the entity was never copied.
     *
     * The two halves are asserted separately because either alone passes while the bug is there:
     * the conversation must *gain* a reference (or the panel and the whitelist lose it), and must
     * *not* gain a holding row (or the library lists it again).
     */
    const { session, workdirPath } = await freshSession();
    const db = env.server.db;
    // A file in the workspace's own tree, which the listing registers.
    writeFileSync(join(workdirPath, "shared.md"), "# shared");
    const listed = (
      await env.inject({ method: "GET", url: `/api/workspaces/${currentWorkspaceId}/files` })
    ).json<DirectoryListing>();
    const entry = listed.entries.find((e) => e.name === "shared.md")!;
    const held = db
      .listWorkResourcesForResource(env.user.id, "file", entry.fileId!)
      .find((r) => r.ownerType === "workspace")!;

    llm.setTurns([{ content: "看过了。" }]);
    await chat(session.id, {
      message: "看一下这个文件",
      refs: [{ kind: "resource", ref: held.id, label: "shared.md" }],
    });

    expect(db.listSessionReferences(session.id)).toEqual([held.id]);
    expect(
      db.listWorkResourcesForResource(env.user.id, "file", entry.fileId!).map((r) => r.ownerType)
    ).toEqual(["workspace"]);

    // The library — which is the listing, not the whitelist — has one row for that file, and it
    // is the workspace's. This is the assertion that fails while the link writes a holding row.
    const library = (await env.inject({ method: "GET", url: "/api/resources" })).json<
      { id: string; resourceId: string }[]
    >();
    const rows = library.filter((r) => r.resourceId === entry.fileId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(held.id);

    /*
     * And the conversation's 参考资料 still shows it — the half that would break if the link had
     * been removed without a reference to replace it. The row is the **holder's**, which is the
     * point: its id, title and parse state are the ones the model reads, so the panel and the
     * model cannot disagree about what is there.
     */
    const panel = (
      await env.inject({ method: "GET", url: `/api/resources?sessionId=${session.id}` })
    ).json<{ id: string }[]>();
    expect(panel.map((r) => r.id)).toEqual([held.id]);
  });

  it("refuses a reference to somebody else's material", async () => {
    /*
     * Unlike a source in v3, which was silently dropped, a reference that cannot be resolved
     * **refuses the turn**: a reference is the object of the question, so losing it changes what
     * was asked — and no message is written, because a row recording a question the server
     * declined to run would be a turn in the conversation that never happened.
     */
    const { session } = await freshSession();

    llm.setTurns([{ content: "ok" }]);
    const { res } = await chat(session.id, {
      message: "look at this",
      refs: [{ kind: "resource", ref: "not-mine", label: "someone-elses.pdf" }],
    });

    expect(res.statusCode).toBe(404);
    expect(await messagesOf(session.id)).toHaveLength(0);
  });

  it("records what the turn pointed at, and hands the model a way to read it", async () => {
    /*
     * The whole of the reference mechanism at the level only a route can check: what the client
     * sent is **stored** on the message (so the chip survives a reload), and what the model gets
     * is a **pointer** rather than a copy — a figure is named with the exact call that fetches it,
     * which is the same string that works unchanged when the turn is replayed later.
     */
    const { session } = await freshSession();
    env.server.db.upsertDiagram({
      id: "d-ref",
      sessionId: session.id,
      name: "auth-flow.mmd",
      fileId: "f-1",
      summary: "登录流程",
      toolCallId: null,
    });

    llm.setTurns([{ content: "看起来是这样" }]);
    const { res } = await chat(session.id, {
      message: "这一步是什么意思？",
      refs: [{ kind: "diagram", ref: "Auth Flow", label: "auth-flow" }],
    });
    expect(res.statusCode).toBe(200);

    const user = (await messagesOf(session.id))[0]!;
    // The client's own spelling and label, not the resolved ones: a message describes the turn
    // that was had, and the chip shows what the composer showed.
    expect(user.refs).toEqual([{ kind: "diagram", ref: "Auth Flow", label: "auth-flow" }]);

    const sent = JSON.stringify(turnRequest("这一步是什么意思？").messages);
    expect(sent).toContain('ila_query(kind: \\"diagram\\", name: \\"auth-flow.mmd\\")');
    /*
     * What travels is the *pointer* and the one-line summary — never the content. The summary is
     * there so the model has the gist even if it decides not to look; the mermaid source is not,
     * because the agent fetches it and gets the figure as it is now rather than as it was when
     * the reader was looking at it.
     */
    expect(sent).toContain("登录流程");
  });

  it("does not put a table's content in the prompt, only how to get it", async () => {
    // The counterpart, where there *is* content to leak: a table's row holds the markdown, so a
    // reference that spliced it would be the copy the mechanism exists to avoid — and a long
    // table would crowd the turn that is asking about it.
    const { session } = await freshSession();
    env.server.db.upsertSessionTable({
      id: "t-body",
      sessionId: session.id,
      name: "scores",
      summary: "两季度对比",
      content: "| 项目 | 数值 |\n| --- | --- |\n| 速度 | 3 |",
      toolCallId: null,
    });

    llm.setTurns([{ content: "ok" }]);
    await chat(session.id, {
      message: "这个表怎么看？",
      refs: [{ kind: "table", ref: "scores", label: "scores" }],
    });

    const sent = JSON.stringify(turnRequest("这个表怎么看？").messages);
    expect(sent).toContain('ila_query(kind: \\"table\\", name: \\"scores\\")');
    expect(sent).not.toContain("| 项目 | 数值 |");
  });

  it("sends a turn that is nothing but a reference", async () => {
    // "What about this?" is a complete question. The client's `canSend` accepts a staged chip
    // alone, so the server's own guard has to agree or the two sides disagree about what a
    // sendable message is — and a question asked by pointing at something is refused by a server
    // that never looked at what was pointed at.
    const { session } = await freshSession();
    env.server.db.upsertSessionTable({
      id: "t-ref",
      sessionId: session.id,
      name: "scores",
      summary: "",
      content: "| a |\n| - |\n| 1 |",
      toolCallId: null,
    });

    llm.setTurns([{ content: "这是成绩表" }]);
    const { res } = await chat(session.id, {
      refs: [{ kind: "table", ref: "scores", label: "scores" }],
    });
    expect(res.statusCode).toBe(200);
    expect((await messagesOf(session.id))[0]!.refs).toHaveLength(1);
  });

  it("refuses an unresolvable reference without writing the turn", async () => {
    /*
     * Refused rather than dropped, unlike `sources` two cases above. A source is *material the
     * model may read*, so one that has gone narrows the turn and the answer is still an answer; a
     * reference is **the object of the question**, so losing it changes what was asked. And the
     * message is not written, because a row recording a question the server refused to run would
     * be a turn in the conversation that never happened.
     */
    const { session } = await freshSession();
    llm.setTurns([{ content: "should not run" }]);

    const { res } = await chat(session.id, {
      message: "这是什么？",
      refs: [{ kind: "diagram", ref: "no-such-diagram", label: "x" }],
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("REFERENCE_NOT_FOUND");
    expect(await messagesOf(session.id)).toHaveLength(0);
  });

  it("refuses a refs field that is not a list", async () => {
    const { session } = await freshSession();
    const { res } = await chat(session.id, { message: "hi", refs: "nope" });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("INVALID_FIELD");
  });

  it("names the conversation from the first exchange", async () => {
    const { session } = await freshSession();
    llm.setTurns([{ content: "Sure." }]);
    llm.setTitle("Recursion Basics");

    const { events } = await chat(session.id, { message: "what is recursion" });

    expect(events.find((e) => e.type === "title")).toEqual({
      type: "title",
      sessionId: session.id,
      title: "Recursion Basics",
    });
    expect(await sessionOf(session.id)).toMatchObject({ title: "Recursion Basics", titleSource: "auto" });
  });

  it("never overwrites a title the user typed", async () => {
    const { session } = await freshSession();
    await env.inject({
      method: "PATCH",
      url: `/api/sessions/${session.id}`,
      payload: { title: "My Own Title" },
    });
    llm.setTurns([{ content: "Sure." }]);
    llm.setTitle("Model Title");

    const { events } = await chat(session.id, { message: "hi" });

    expect(events.some((e) => e.type === "title")).toBe(false);
    expect(await sessionOf(session.id)).toMatchObject({ title: "My Own Title", titleSource: "user" });
  });

  it("keeps asking until the conversation has something to be named after", async () => {
    /*
     * The whole of the new rule. A conversation that opens with a greeting has nothing to name, and
     * the titler says so rather than inventing a title from it — so the conversation keeps its
     * placeholder and the *next* turn asks again. Nothing else could produce a name that means
     * anything: an attempt is the only way to find out, and the first one can only be answered
     * "not yet".
     */
    const { session } = await freshSession();
    llm.setTitle("NO_TITLE");
    llm.setTurns([{ content: "你好！有什么可以帮你的？" }]);

    const first = await chat(session.id, { message: "你好" });

    expect(first.events.some((e) => e.type === "title")).toBe(false);
    expect(await sessionOf(session.id)).toMatchObject({
      title: DEFAULT_SESSION_TITLE,
      titleSource: "auto",
      titleState: "unnamed",
    });

    // A turn with something in it: the same conversation, now nameable.
    llm.setTitle("快速排序入门");
    llm.reset();
    llm.setTurns([{ content: "快速排序是…" }]);
    const second = await chat(session.id, { message: "帮我讲讲快速排序" });

    expect(second.events.find((e) => e.type === "title")).toEqual({
      type: "title",
      sessionId: session.id,
      title: "快速排序入门",
    });
    expect(await sessionOf(session.id)).toMatchObject({
      title: "快速排序入门",
      titleState: "model",
    });

    // And having been named, it is left alone — the gate the leave path shares.
    llm.setTitle("另一个标题");
    llm.reset();
    llm.setTurns([{ content: "继续。" }]);
    const third = await chat(session.id, { message: "再讲讲" });

    expect(third.events.some((e) => e.type === "title")).toBe(false);
    expect(await sessionOf(session.id)).toMatchObject({ title: "快速排序入门" });
  });

  it("gives a conversation the model declined to name a title on a later turn", async () => {
    // The same rule from the other side: a decline is not a decision about the conversation, only
    // about what was in it when it was asked.
    const { session } = await freshSession();
    llm.setTitle("NO_TITLE");
    llm.setTurns([{ content: "嗯。" }]);
    await chat(session.id, { message: "你好" });

    llm.setTitle("数据库索引");
    llm.reset();
    llm.setTurns([{ content: "索引是…" }]);
    await chat(session.id, { message: "讲讲数据库索引" });

    expect(await sessionOf(session.id)).toMatchObject({
      title: "数据库索引",
      titleState: "model",
    });
  });

  it("replays the earlier turns as history", async () => {
    const { session } = await freshSession();
    llm.setTurns([{ content: "first answer" }]);
    await chat(session.id, { message: "first question" });

    llm.reset();
    llm.setTurns([{ content: "second answer" }]);
    await chat(session.id, { message: "second question" });

    const sent = llm.requests()[0] as { messages: { role: string; content: unknown }[] };
    expect(sent.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(JSON.stringify(sent.messages)).toContain("first question");
    expect(JSON.stringify(sent.messages)).toContain("first answer");
  });

  it("degrades to the default provider when the override names an unknown one", async () => {
    const { session } = await freshSession();
    llm.setTurns([{ content: "still works" }]);

    const res = await env.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/chat`,
      payload: { message: "hi", provider: "keyless-for-error" },
    });

    // A stale provider id must not make the turn fail.
    expect(res.statusCode).toBe(200);
    expect(parseSse(res.body).some((e) => e.type === "error")).toBe(false);
    expect((await messagesOf(session.id))[1]!.content).toBe("still works");
  });

  it("persists a warning message when the provider cannot be used", async () => {
    const { session } = await freshSession();
    // Seed a provider that serves a model but has no API key, then point the turn at it.
    // (`buildModel` checks for a model before it checks for a key, so it needs both.)
    await env.inject({
      method: "POST",
      url: "/api/providers",
      payload: {
        name: "Keyless",
        baseURL: "http://127.0.0.1:1/v1",
        models: [{ modelId: "fake-model", name: "fake-model" }],
      },
    });
    const keyless = (
      await env.inject({ method: "GET", url: "/api/providers" })
    ).json<{ id: string; name: string }[]>().find((p) => p.name === "Keyless")!;

    const { events } = await chat(session.id, { message: "hi", provider: keyless.id });

    const error = events.find((e) => e.type === "error") as { message: string } | undefined;
    expect(error?.message).toMatch(/no API key configured/);
    // The stream still terminates cleanly.
    expect(events.at(-1)).toEqual({ type: "done" });

    const persisted = await messagesOf(session.id);
    expect(persisted).toHaveLength(2);
    expect(persisted[1]!.role).toBe("assistant");
    expect(persisted[1]!.content).toMatch(/^⚠️ /);
  });

  it("names the setting to change when a provider demands the reasoning echo", async () => {
    // The state this catches: a thinking model whose record omits the `reasoning`
    // capability, so `createReasoningFetch` is never handed a replay map and the request
    // goes out without the field. The provider's sentence describes the symptom and says
    // nothing about the cause, so the turn has to name the checkbox that fixes it.
    const rejecting = createServer((_req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: "The `reasoning_content` in the thinking mode must be passed back to the API.",
          },
        })
      );
    });
    await new Promise<void>((resolve) => rejecting.listen(0, "127.0.0.1", resolve));
    const { port } = rejecting.address() as AddressInfo;

    try {
      const { session } = await freshSession();
      await env.inject({
        method: "POST",
        url: "/api/providers",
        payload: {
          name: "Rejecting",
          baseURL: `http://127.0.0.1:${port}/v1`,
          apiKey: "test-key",
          models: [{ modelId: "deepseek-v4-pro", name: "deepseek-v4-pro" }],
        },
      });
      const rejectingProvider = (
        await env.inject({ method: "GET", url: "/api/providers" })
      ).json<{ id: string; name: string }[]>().find((p) => p.name === "Rejecting")!;

      const { events } = await chat(session.id, { message: "hi", provider: rejectingProvider.id });

      const error = events.find((e) => e.type === "error") as
        | { message: string; code?: string }
        | undefined;
      expect(error?.code).toBe("REASONING_NOT_DECLARED");
      // The code adds to the event; it does not replace what the provider said.
      expect(error?.message).toMatch(/reasoning_content/);

      // And the provider's words are what history keeps. That `⚠️` line is replayed to the
      // model next turn, so rewriting it into the sentence the *user* is shown would change
      // what the model is told about its own failure — a different decision entirely.
      const persisted = await messagesOf(session.id);
      expect(persisted[1]!.content).toMatch(/^⚠️ 400/);
      expect(persisted[1]!.content).toContain("reasoning_content");
    } finally {
      await new Promise<void>((resolve) => rejecting.close(() => resolve()));
    }
  });

  it("sends an attached image to a vision model as image content", async () => {
    const { session } = await freshSession();
    const attachment = (
      await env.inject({
        method: "POST",
        url: `/api/sessions/${session.id}/resources`,
        payload: { name: "shot.png", mimeType: "image/png", data: Buffer.from("fake-png").toString("base64") },
      })
    ).json<Attachment>();

    llm.setTurns([{ content: "I see it." }]);
    await chat(session.id, { message: "what is this", model: "fake-vision", attachments: [attachment] });

    const userTurn = turnRequest("what is this").messages.at(-1)!;
    expect(JSON.stringify(userTurn.content)).toContain("image_url");
    expect(JSON.stringify(userTurn.content)).toContain("data:image/png;base64,");

    // The attachment is recorded on the persisted user message too.
    const persisted = await messagesOf(session.id);
    expect(persisted[0]!.attachments?.[0]).toMatchObject({ id: attachment.id, kind: "image" });
  });

  it("degrades an attached image to a placeholder for a non-vision model", async () => {
    const { session } = await freshSession();
    const attachment = (
      await env.inject({
        method: "POST",
        url: `/api/sessions/${session.id}/resources`,
        payload: { name: "shot.png", mimeType: "image/png", data: Buffer.from("fake-png").toString("base64") },
      })
    ).json<Attachment>();

    llm.setTurns([{ content: "ok" }]);
    await chat(session.id, {
      message: "what is this, non-vision",
      model: "fake-model",
      attachments: [attachment],
    });

    const serialized = JSON.stringify(
      turnRequest("what is this, non-vision").messages.at(-1)!.content
    );
    expect(serialized).not.toContain("image_url");
    expect(serialized).toContain("当前模型不支持图片输入");
  });

  it("drops an attachment whose id could never address a stored file", async () => {
    // A stale or hostile client must not be able to record an attachment reference that
    // would later be resolved against the uploads tree.
    const { session } = await freshSession();

    llm.setTurns([{ content: "ok" }]);
    await chat(session.id, {
      message: "hi",
      attachments: [{ id: "../../escape", name: "x.txt", mimeType: "text/plain", size: 1, kind: "file" }],
    });

    const persisted = await messagesOf(session.id);
    expect(persisted[0]!.attachments).toBeUndefined();
    // The turn itself still went through.
    expect(persisted[1]!.content).toBe("ok");
  });

  /** A Copilot, and a conversation started from it. */
  async function sessionFromCopilot(payload: Record<string, unknown>) {
    const workspace = await newWorkspace(env, `W-${Math.random().toString(36).slice(2)}`);
    currentWorkspaceId = workspace.id;
    const copilot = (
      await env.inject({ method: "POST", url: "/api/copilots", payload })
    ).json<{ id: string }>();
    const session = await newSession(env, workspace.id, { copilotId: copilot.id });
    return { copilot, session };
  }

  /** The system message and the tool names the model was actually sent. */
  function sentToModel(index = 0) {
    const body = llm.requests()[index] as {
      messages: { role: string; content: unknown }[];
      tools?: { function?: { name: string } }[];
    };
    return {
      system: JSON.stringify(body.messages[0]!.content),
      tools: (body.tools ?? []).map((t) => t.function?.name),
    };
  }

  /**
   * The *streamed* turn's request, which `sentToModel` cannot promise.
   *
   * A turn fires out-of-band calls of its own — the auto-titler, the image summary pass — and
   * one of them can land first, so `requests()[0]` is whichever got there. `stream: true` is
   * the conversation's own call and nothing else's, which matters most for the system prompt:
   * every one of those side calls has a prompt of its own to be mistaken for.
   */
  function streamedTurn(): { system: string; tools: string[] } {
    const body = llm.requests().find((r) => r.stream === true) as
      | { messages: { role: string; content: unknown }[]; tools?: { function?: { name: string } }[] }
      | undefined;
    if (!body) throw new Error("no streamed turn was recorded");
    return {
      system: JSON.stringify(body.messages[0]!.content),
      tools: (body.tools ?? []).map((t) => t.function?.name as string),
    };
  }

  it("tells the model it may keep a web page, on a turn where it can", async () => {
    /*
     * The prompt half of `ila_collect_page`. The tool was assembled, wired, stored and tested
     * long before this, and none of it was visible in use, because nothing in the system prompt
     * ever mentioned the tool: its own description is a *restriction* ("do this only for pages
     * this conversation is about"), which a model that was never told to keep anything reads as
     * "usually do not". This is what fails if the guidance stops being appended.
     */
    const { session } = await freshSession();

    llm.setTurns([{ content: "ok" }]);
    await chat(session.id, { message: "hi" });

    const turn = streamedTurn();
    expect(turn.tools).toContain("ila_collect_page");
    expect(turn.system).toContain("ila_collect_page");
  });

  it("says nothing about keeping pages to a conversation that cannot", async () => {
    /*
     * The other half, and the reason the route reads the *assembled* set rather than the config:
     * guidance for a call the model has no tool to make is an instruction it can only fail. A
     * Copilot restricted to one file tool is the case that makes the two answers differ.
     */
    const { session } = await sessionFromCopilot({
      name: "Reader",
      systemPrompt: "Read only.",
      allTools: false,
      tools: ["read_file"],
    });

    llm.setTurns([{ content: "ok" }]);
    await chat(session.id, { message: "hi" });

    const turn = streamedTurn();
    expect(turn.tools).toEqual(["read_file"]);
    expect(turn.system).not.toContain("ila_collect_page");
  });

  it("states the time in the zone the browser reported", async () => {
    /*
     * End to end, which is the only place this can be asserted: the zone travels from the
     * request body through `turnContext` into the prompt, and the *string* is built from it.
     * `Asia/Shanghai` because it has had no daylight saving since 1991 — a zone with DST would
     * make the expected offset depend on which month the suite runs in.
     */
    const { session } = await freshSession();

    llm.setTurns([{ content: "ok" }]);
    await chat(session.id, { message: "hi", timezone: "Asia/Shanghai" });

    expect(streamedTurn().system).toContain("Asia/Shanghai, UTC+08:00");
  });

  it("falls back to the server's own zone for one it does not recognise", async () => {
    // A body field is not a trust boundary, and `Intl` throws a RangeError on a zone it cannot
    // resolve — which would fail the turn. An unusable name is dropped to the same answer as
    // sending none, rather than being refused.
    const { session } = await freshSession();

    llm.setTurns([{ content: "ok" }]);
    await chat(session.id, { message: "hi", timezone: "Mars/Olympus_Mons" });

    const system = streamedTurn().system;
    expect(system).not.toContain("Mars/Olympus_Mons");
    expect(system).toContain(serverTimeZone()!);
  });

  it("gives the model the account's own introduction", async () => {
    /*
     * End to end, because the whole value of the introduction is that it *arrives*: it is written
     * on the account page, stored on `users.about`, resolved by `turnContext` and assembled into
     * the prompt by `buildSystemPrompt`. Any one of those can be right on its own while the
     * feature does nothing in use — which is what the `ila_collect_page` guidance did for a while.
     */
    const { session } = await freshSession();
    await env.inject({
      method: "PATCH",
      url: "/api/auth/me",
      payload: { about: "I write Java and am learning linear algebra." },
    });

    llm.setTurns([{ content: "ok" }]);
    await chat(session.id, { message: "hi" });

    const system = streamedTurn().system;
    expect(system).toContain("I write Java and am learning linear algebra.");
    // Fenced and labelled, because it is the user's own prose: a sentence in it that reads like a
    // command has to arrive as something they wrote rather than as an instruction.
    expect(system).toContain("<about_the_learner>");
  });

  it("says nothing at all about a learner who has not written one", async () => {
    /*
     * The block is dropped whole — heading and fence with it — rather than arriving empty. An
     * empty `<about_the_learner></about_the_learner>` would spend a paragraph of every turn's
     * prompt telling the model that the user said nothing.
     *
     * Cleared explicitly rather than left alone: this file shares one account across its tests, so
     * a test that only *omits* to set an introduction would pass or fail on the order they ran in.
     */
    const { session } = await freshSession();
    await env.inject({ method: "PATCH", url: "/api/auth/me", payload: { about: "" } });

    llm.setTurns([{ content: "ok" }]);
    await chat(session.id, { message: "hi" });

    expect(streamedTurn().system).not.toContain("about_the_learner");
  });

  it("reaches a regenerated turn too, which is a third route into the same prompt", async () => {
    /*
     * `/chat`, `/answers` and `/regenerate` each build their own `turnContext` and each call
     * `runAgentStream`, so a field threaded into one and not the others disappears on exactly the
     * turns nobody thought about. This covers the third; `/answers` is the ask-user file's.
     */
    const { session } = await freshSession();
    await env.inject({
      method: "PATCH",
      url: "/api/auth/me",
      payload: { about: "Spatial thinker, weak at notation." },
    });

    llm.setTurns([{ content: "first" }, { content: "second" }]);
    await chat(session.id, { message: "hi" });

    const res = await env.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/regenerate`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);

    // The regenerate is the *second* streamed request; the first was the turn it replaces.
    const streamed = llm.requests().filter((r) => r.stream === true);
    expect(streamed).toHaveLength(2);
    const system = JSON.stringify(
      (streamed[1]!.messages as { content: unknown }[])[0]!.content
    );
    expect(system).toContain("Spatial thinker, weak at notation.");
  });

  it("answers with the Copilot's prompt as it was at creation, not as it is now", async () => {
    const { copilot, session } = await sessionFromCopilot({
      name: "Coach",
      systemPrompt: "Be terse.",
      tools: [],
    });

    // Edited after the conversation exists. The session copied the prompt when it was created,
    // so this must not reach it — that is what the UI promises, and what the live read this
    // replaced used to break.
    await env.inject({
      method: "PUT",
      url: `/api/copilots/${copilot.id}`,
      payload: { systemPrompt: "Write essays." },
    });

    llm.setTurns([{ content: "ok" }]);
    await chat(session.id, { message: "hi" });

    const { system } = sentToModel();
    expect(system).toContain("Be terse.");
    expect(system).not.toContain("Write essays.");
  });

  it("keeps its tool allowlist after the Copilot it came from is deleted", async () => {
    /*
     * The widening this exists to prevent. `buildTools` reads an empty allowlist as "all tools",
     * and `sessions.copilot_id` is `ON DELETE SET NULL` — so while the allowlist was read live
     * from the Copilot, deleting it did not merely remove a restriction, it silently granted
     * every tool. The conversation's own copy is what makes the restriction outlive its source.
     */
    const { copilot, session } = await sessionFromCopilot({
      name: "Reader",
      systemPrompt: "Read only.",
      allTools: false,
      tools: ["read_file"],
    });
    expect((await env.inject({ method: "DELETE", url: `/api/copilots/${copilot.id}` })).statusCode).toBe(200);

    llm.setTurns([{ content: "ok" }]);
    await chat(session.id, { message: "hi" });

    const { tools } = sentToModel();
    expect(tools).toContain("read_file");
    expect(tools).not.toContain("write_file");
    expect(tools).not.toContain("delete_file");
  });

  it("sends no tools at all when the conversation is allowed none", async () => {
    /*
     * The state that used to be unreachable. An empty allow-list meant "no restriction", so a
     * Copilot locked down to nothing arrived at the model with every tool — the widest possible
     * reading of the narrowest possible selection.
     */
    const { session } = await sessionFromCopilot({
      name: "Silent",
      systemPrompt: "只聊天。",
      allTools: false,
      tools: [],
    });

    llm.setTurns([{ content: "ok" }]);
    await chat(session.id, { message: "hi" });

    const { tools } = sentToModel();
    expect(tools).toEqual([]);
    // The turn still ran, so this is a tool-less conversation rather than a failed request.
    expect(await messagesOf(session.id)).toHaveLength(2);
  });

  it("sends every tool when the flag is on, list or no list", async () => {
    // `allTools: true` is authoritative, so a stale selection left beside it changes nothing —
    // and the two must not be able to disagree about what the model was offered.
    const { session } = await sessionFromCopilot({
      name: "Everything",
      systemPrompt: "",
      allTools: true,
      tools: ["read_file"],
    });

    llm.setTurns([{ content: "ok" }]);
    await chat(session.id, { message: "hi" });

    expect(sentToModel().tools).toContain("write_file");
    // Which is to say all of them, not merely the one name that happened to be listed.
    expect(sentToModel().tools.length).toBeGreaterThan(1);
  });

  it("honours a per-turn model override that the provider actually serves", async () => {
    const { session } = await freshSession();
    llm.setTurns([{ content: "ok" }]);
    await chat(session.id, { message: "hi", model: "fake-vision" });

    expect((llm.requests()[0] as { model: string }).model).toBe("fake-vision");
  });

  it("rejects a model the provider does not serve and falls back", async () => {
    const { session } = await freshSession();
    llm.setTurns([{ content: "ok" }]);
    await chat(session.id, { message: "hi", model: "does-not-exist" });

    expect((llm.requests()[0] as { model: string }).model).toBe("fake-model");
  });
});

describe("a turn's message is what the client rendered", () => {
  /*
   * The route's half of the loop's invariant: the persisted row equals the concatenation of the
   * `text` frames the browser received. It is stated over the raw SSE transcript, because that
   * transcript *is* what the client accumulates into `streaming.content` — and the row is what
   * replaces it at `message_done`, which is the moment text used to vanish: the message was
   * trimmed to the model's last utterance, so a chapter's lecture streamed and then disappeared.
   *
   * Exactly two things a row may carry that never travelled as `text`, and both are named here
   * rather than allowed by a loose comparison: the budget notice, and the unseen-image warning
   * `finishTurn` appends when a turn attached an image to a model that cannot see one. A third
   * tolerance would be the wrong answer — `redactQuizInput`, for instance, rewrites tool inputs
   * and never the text channel, so tolerating it would blind this to an answer key leaking into
   * prose.
   */
  const OUT_OF_STEPS_NOTICE =
    "The assistant ran out of steps while working on this task. Please ask a follow-up to continue.";

  const QUESTIONS = [
    { header: "核心", question: "最本质的突破是什么？", options: [{ label: "A" }, { label: "B" }] },
  ];

  const textDeltas = (events: ChatStreamEvent[]): string[] =>
    events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta);

  /**
   * Every `data:` frame in the transcript parsed.
   *
   * `parseSse` skips a frame it cannot parse, exactly as the client does — which means a broken
   * transcript would satisfy "the deltas join to the content" by agreeing about a *smaller*
   * string. Comparing the two counts is what closes that door.
   */
  function expectNoFrameWasDropped(transcript: string): void {
    const frames = transcript.split("\n\n").filter((block) => block.includes("data:"));
    expect(parseSse(transcript)).toHaveLength(frames.length);
  }

  it("persists a multi-step turn as the deltas that streamed", async () => {
    const { session } = await freshSession();
    llm.setTurns([
      {
        content: "我先把这一节的重点写成一个文件。",
        toolCalls: [{ name: "write_file", args: { path: "notes.md", content: "# 重点" } }],
      },
      { content: "写好了。下面是我对第一章的讲解：\n\n第一点是……" },
    ]);

    const { res, events } = await chat(session.id, { message: "开始讲第一章" });

    expectNoFrameWasDropped(res.body);
    const streamed = textDeltas(events).join("");
    // Two steps, so two paragraphs — and the narration before the tool call is part of the
    // reply rather than something a later step replaced.
    expect(streamed).toBe("我先把这一节的重点写成一个文件。\n\n写好了。下面是我对第一章的讲解：\n\n第一点是……");

    const done = events.find((e) => e.type === "message_done") as { message: Message };
    expect(done.message.content).toBe(streamed);
    // And the row a reload reads is the same one — the assertion the reported bug failed.
    const persisted = await messagesOf(session.id);
    expect(persisted.at(-1)!.content).toBe(streamed);
  });

  it("persists a lecture the asking step followed, not just the question's introduction", async () => {
    // The reported shape end to end: the model explains a chapter, draws on it, then asks a
    // question. Only the asking step's one-line introduction used to survive.
    const { session } = await freshSession();
    const lecture = `# 1.1 背景与动机\n\n${"LangGraph 把 Agent 的流程建模成一张图。".repeat(20)}`;
    const closer = "讲完了第一项的背景与动机。在进入第 2 项之前，用两道题检验一下你是否抓住了核心：";
    llm.setTurns([
      { content: lecture, toolCalls: [{ name: "write_file", args: { path: "ch1.md", content: "x" } }] },
      {
        content: "这一章的循环结构可以画成这样。",
        toolCalls: [{ name: "write_file", args: { path: "loop.md", content: "y" } }],
      },
      { content: closer, toolCalls: [{ name: "ask_user", args: { questions: QUESTIONS } }] },
    ]);

    const { res, events } = await chat(session.id, { message: "开始讲第一章" });

    expectNoFrameWasDropped(res.body);
    const done = events.find((e) => e.type === "message_done") as { message: Message };
    const streamed = textDeltas(events).join("");

    expect(streamed.startsWith(lecture)).toBe(true);
    expect(streamed.endsWith(closer)).toBe(true);
    expect(streamed).toContain("这一章的循环结构可以画成这样。");
    expect(streamed).not.toContain(OUT_OF_STEPS_NOTICE);

    expect(done.message.content).toBe(streamed);
    const persisted = await messagesOf(session.id);
    expect(persisted.at(-1)!.content).toBe(streamed);
    // The turn is still suspended on the question, so the lecture is at rest in a row with a
    // pending call — the state the reported conversation was in when its text was gone.
    expect(persisted.at(-1)!.toolCalls?.some((c) => c.status === "awaiting")).toBe(true);
  });
});
