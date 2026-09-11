import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ApiErrorBody,
  Attachment,
  DocumentParserConfig,
  PublicConfig,
  Workspace,
} from "@guided-learning/shared";
import { MAX_INLINE_CHARS } from "../src/attachments.js";
import { buildPdf } from "../src/documents/sample.js";
import { eventTypes } from "./helpers/sse.js";
import { startFakeLlm, type FakeLlm } from "./helpers/fakeLlm.js";
import { startFakeParser, type FakeParser } from "./helpers/fakeParser.js";
import {
  newSession,
  newWorkspace,
  parserFor,
  providerFor,
  startTestServer,
  uploadAttachment,
  waitForParsing,
  type TestEnv,
} from "./helpers/tempEnv.js";

/**
 * Document parsing through the real HTTP surface: the upload route schedules extraction,
 * the status route reports it, and the chat route injects whatever came out.
 *
 * Extraction is asynchronous by design, so these tests wait on the sidecar rather than on
 * a response — the same state the browser polls.
 */

let llm: FakeLlm;
let parser: FakeParser;
let env: TestEnv;
let workspace: Workspace;

async function config(): Promise<PublicConfig> {
  const res = await env.server.app.inject({ method: "GET", url: "/api/config" });
  return res.json<PublicConfig>();
}

async function statusOf(
  sessionId: string
): Promise<
  Record<string, { status: string; error?: string; parseErrorCode?: string; parsedChars?: number }>
> {
  const res = await env.server.app.inject({
    method: "GET",
    url: `/api/sessions/${sessionId}/attachments`,
  });
  return res.json();
}

beforeEach(async () => {
  llm = await startFakeLlm();
  parser = await startFakeParser({ text: "cloud extracted text" });
  env = await startTestServer({ providers: [providerFor(llm)] });
  workspace = await newWorkspace(env);
});

afterEach(async () => {
  await env.cleanup();
  await llm.close();
  await parser.close();
});

describe("document parser settings", () => {
  it("publishes the supported protocol kinds for the settings form", async () => {
    const res = await env.server.app.inject({ method: "GET", url: "/api/document-parsers/kinds" });
    const kinds = res.json<{ kind: string; requiresApiKey: boolean }[]>();
    expect(kinds.map((k) => k.kind)).toEqual(expect.arrayContaining(["sync", "mineru", "llamaparse"]));
  });

  it("starts with no cloud parsers and a local-first policy", async () => {
    const cfg = await config();
    expect(cfg.documentParsers).toEqual([]);
    expect(cfg.documentParsing.policy).toBe("local-first");
    expect(cfg.documentParsing.localEnabled).toBe(true);
    expect(cfg.documentParsing.fallbackEnabled).toBe(true);
  });

  it("creates, edits and deletes a parser", async () => {
    const created = await env.server.app.inject({
      method: "POST",
      url: "/api/document-parsers",
      payload: { name: "Docling", kind: "sync", baseURL: "http://127.0.0.1:5001/v1/convert/file" },
    });
    expect(created.statusCode).toBe(201);
    const parserConfig = created.json<DocumentParserConfig>();
    expect(parserConfig.enabled).toBe(true);
    expect(parserConfig.hasApiKey).toBe(false);

    const updated = await env.server.app.inject({
      method: "PUT",
      url: `/api/document-parsers/${parserConfig.id}`,
      payload: { name: "Renamed", enabled: false },
    });
    expect(updated.json<DocumentParserConfig>().name).toBe("Renamed");
    expect(updated.json<DocumentParserConfig>().enabled).toBe(false);

    const deleted = await env.server.app.inject({
      method: "DELETE",
      url: `/api/document-parsers/${parserConfig.id}`,
    });
    expect(deleted.statusCode).toBe(200);
  });

  it("rejects an unknown kind and a missing baseURL", async () => {
    const badKind = await env.server.app.inject({
      method: "POST",
      url: "/api/document-parsers",
      payload: { name: "Nope", kind: "carrier-pigeon", baseURL: "http://x" },
    });
    expect(badKind.statusCode).toBe(400);

    const noUrl = await env.server.app.inject({
      method: "POST",
      url: "/api/document-parsers",
      payload: { name: "Nope", kind: "sync" },
    });
    expect(noUrl.statusCode).toBe(400);
  });

  it("keeps a stored API key when the update omits it, and never returns it", async () => {
    const created = await env.server.app.inject({
      method: "POST",
      url: "/api/document-parsers",
      payload: { name: "MinerU", kind: "mineru", baseURL: "http://x/api/v4", apiKey: "secret" },
    });
    const { id } = created.json<DocumentParserConfig>();
    expect(created.json<DocumentParserConfig>().hasApiKey).toBe(true);
    expect(created.body).not.toContain("secret");

    // An absent key means "leave it alone" — the same contract as LLM providers.
    const renamed = await env.server.app.inject({
      method: "PUT",
      url: `/api/document-parsers/${id}`,
      payload: { name: "Renamed" },
    });
    expect(renamed.json<DocumentParserConfig>().hasApiKey).toBe(true);

    // An explicit empty string clears it.
    const cleared = await env.server.app.inject({
      method: "PUT",
      url: `/api/document-parsers/${id}`,
      payload: { apiKey: "" },
    });
    expect(cleared.json<DocumentParserConfig>().hasApiKey).toBe(false);
  });

  it("allows deleting the last parser", async () => {
    // Unlike LLM providers, zero cloud parsers is a valid configuration (local-only).
    const created = await env.server.app.inject({
      method: "POST",
      url: "/api/document-parsers",
      payload: { name: "Only", kind: "sync", baseURL: "http://x" },
    });
    const { id } = created.json<DocumentParserConfig>();
    const res = await env.server.app.inject({ method: "DELETE", url: `/api/document-parsers/${id}` });
    expect(res.statusCode).toBe(200);
  });

  it("updates the parsing policy", async () => {
    const res = await env.server.app.inject({
      method: "PUT",
      url: "/api/document-parsing",
      payload: { policy: "cloud-first", fallbackEnabled: false, localEnabled: false },
    });
    const body = res.json<PublicConfig["documentParsing"]>();
    expect(body.policy).toBe("cloud-first");
    expect(body.fallbackEnabled).toBe(false);
    expect(body.localEnabled).toBe(false);
  });

  it("rejects an unknown policy", async () => {
    const res = await env.server.app.inject({
      method: "PUT",
      url: "/api/document-parsing",
      payload: { policy: "whenever" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("parsing an uploaded document", () => {
  it("schedules extraction and settles on ready, without blocking the upload", async () => {
    const session = await newSession(env, workspace.id);
    const attachment = await uploadAttachment(env, session.id, {
      name: "lecture.pdf",
      mimeType: "application/pdf",
      data: buildPdf(["Photosynthesis converts light into chemical energy."]),
    });

    // The upload response already reports the queue state, so the client never has to guess.
    expect(attachment.parseStatus).toBe("pending");

    await waitForParsing(env, session.id);
    const record = (await statusOf(session.id))[attachment.id]!;

    expect(record.status).toBe("ready");
    expect(record.parsedChars).toBeGreaterThan(0);
    expect((record as { pageCount?: number }).pageCount).toBe(1);
  });

  it("records a failure with a message the user can act on", async () => {
    const session = await newSession(env, workspace.id);
    const attachment = await uploadAttachment(env, session.id, {
      name: "scanned.pdf",
      mimeType: "application/pdf",
      data: buildPdf([""]), // no text layer, and no cloud parser configured
    });

    await waitForParsing(env, session.id);
    const record = (await statusOf(session.id))[attachment.id]!;

    expect(record.status).toBe("failed");
    expect(record.error).toContain("扫描件");
  });

  it("leaves non-document attachments alone", async () => {
    const session = await newSession(env, workspace.id);
    const attachment = await uploadAttachment(env, session.id, {
      name: "notes.txt",
      mimeType: "text/plain",
      data: Buffer.from("plain text is inlined, not parsed"),
    });

    expect(attachment.parseStatus).toBeUndefined();
    await waitForParsing(env, session.id);
    expect((await statusOf(session.id))[attachment.id]).toBeUndefined();
  });

  it("re-parses on request", async () => {
    const session = await newSession(env, workspace.id);
    const attachment = await uploadAttachment(env, session.id, {
      name: "scanned.pdf",
      mimeType: "application/pdf",
      data: buildPdf([""]),
    });
    await waitForParsing(env, session.id);
    expect((await statusOf(session.id))[attachment.id]!.status).toBe("failed");

    // Point the failure at something that works, then retry.
    const res = await env.server.app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/attachments/${attachment.id}/reparse`,
      payload: { name: "scanned.pdf" },
    });
    expect(res.statusCode).toBe(202);

    await waitForParsing(env, session.id);
    expect((await statusOf(session.id))[attachment.id]!.status).toBe("failed");
  });

  it("reports the failure code, not just a sentence, on the status endpoint", async () => {
    // The client translates by code — it owns the wording now — so the code has to survive
    // the trip. The sidecar stores it as `code`; the endpoint renames it to `parseErrorCode`
    // to match the client-facing type, and this is what pins that rename.
    const session = await newSession(env, workspace.id);
    const attachment = await uploadAttachment(env, session.id, {
      name: "scanned.pdf",
      mimeType: "application/pdf",
      data: buildPdf([""]), // no text layer, and no cloud parser configured
    });
    await waitForParsing(env, session.id);

    const record = (await statusOf(session.id))[attachment.id]!;
    expect(record.status).toBe("failed");
    expect(record.parseErrorCode).toBe("no_text_layer");
    // The fallback sentence rides along for a client that does not know the code.
    expect(record.error).toBeTruthy();
  });

  it("404s a re-parse of an attachment that does not exist", async () => {
    const session = await newSession(env, workspace.id);
    const res = await env.server.app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/attachments/ghost/reparse`,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("parsing through a cloud provider", () => {
  async function withParser(kind: "sync" | "mineru" | "llamaparse", apiKey?: string) {
    await env.cleanup();
    env = await startTestServer({
      providers: [providerFor(llm)],
      documentParsers: [parserFor(parser, { kind, apiKey })],
      documentParsing: { policy: "cloud-only" },
    });
    return newWorkspace(env);
  }

  it.each(["sync", "mineru", "llamaparse"] as const)(
    "extracts a scanned PDF via the %s protocol",
    async (kind) => {
      const ws = await withParser(kind, kind === "sync" ? undefined : "test-key");
      const session = await newSession(env, ws.id);

      const attachment = await uploadAttachment(env, session.id, {
        name: "scan.pdf",
        mimeType: "application/pdf",
        data: buildPdf([""]),
      });
      await waitForParsing(env, session.id);

      const record = (await statusOf(session.id))[attachment.id]!;
      expect(record.status).toBe("ready");
      expect(record.error).toBeUndefined();
      // The parser's id is recorded, so the UI can say where the text came from.
      expect((record as { parserId?: string }).parserId).toBe("fake-parser");
      expect(parser.requests().length).toBeGreaterThan(0);
    }
  );

  it("falls back to the cloud when local extraction finds no text layer", async () => {
    const ws = await withParser("sync");
    const session = await newSession(env, ws.id);
    await env.server.app.inject({
      method: "PUT",
      url: "/api/document-parsing",
      payload: { policy: "local-first" },
    });

    const attachment = await uploadAttachment(env, session.id, {
      name: "scan.pdf",
      mimeType: "application/pdf",
      data: buildPdf([""]),
    });
    await waitForParsing(env, session.id);

    const record = (await statusOf(session.id))[attachment.id]!;
    expect(record.status).toBe("ready");
    expect((record as { parserId?: string }).parserId).toBe("fake-parser");
  });

  it("reports a rejected key on the settings screen's test button", async () => {
    await env.cleanup();
    const strict = await startFakeParser({ expectedApiKey: "right" });
    try {
      env = await startTestServer({
        providers: [providerFor(llm)],
        documentParsers: [
          { id: "bad", name: "Bad", kind: "sync", baseURL: strict.baseURL, apiKey: "wrong" },
        ],
      });

      const res = await env.server.app.inject({ method: "POST", url: "/api/document-parsers/bad/test" });
      expect(res.statusCode).toBe(400);
      // The code is what the client renders; the server's own sentence rides along only as
      // a fallback, so assert the code rather than the wording.
      const body = res.json<ApiErrorBody & { ok: boolean }>();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("cloud_auth");
    } finally {
      await strict.close();
    }
  });

  it("passes the test button against a healthy service", async () => {
    await env.cleanup();
    env = await startTestServer({
      providers: [providerFor(llm)],
      documentParsers: [{ id: "good", name: "Good", kind: "sync", baseURL: parser.baseURL }],
    });

    const res = await env.server.app.inject({ method: "POST", url: "/api/document-parsers/good/test" });
    expect(res.statusCode).toBe(200);
  });
});

describe("documents in the prompt", () => {
  it("injects the extracted text, not just the filename", async () => {
    const session = await newSession(env, workspace.id);
    const attachment = await uploadAttachment(env, session.id, {
      name: "lecture.pdf",
      mimeType: "application/pdf",
      data: buildPdf(["Photosynthesis converts light into chemical energy."]),
    });
    await waitForParsing(env, session.id);

    llm.setTurns([{ content: "the answer" }]);
    const res = await env.server.app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/chat`,
      payload: { message: "summarise this", attachments: [attachment] },
    });

    expect(eventTypes(res.body)).toContain("message_done");

    const sent = JSON.stringify(llm.requests()[0]);
    expect(sent).toContain("Photosynthesis converts light into chemical energy.");
    expect(sent).toContain("lecture.pdf");
  });

  it("persists the parse state onto the message so a reload still shows it", async () => {
    const session = await newSession(env, workspace.id);
    const attachment = await uploadAttachment(env, session.id, {
      name: "lecture.pdf",
      mimeType: "application/pdf",
      data: buildPdf(["Some content"]),
    });
    await waitForParsing(env, session.id);

    llm.setTurns([{ content: "ok" }]);
    await env.server.app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/chat`,
      payload: { message: "hi", attachments: [attachment] },
    });

    const messages = await env.server.app.inject({
      method: "GET",
      url: `/api/sessions/${session.id}/messages`,
    });
    const user = messages.json<{ role: string; attachments?: Attachment[] }[]>().find((m) => m.role === "user");
    expect(user?.attachments?.[0]?.parseStatus).toBe("ready");
    expect(user?.attachments?.[0]?.parsedChars).toBeGreaterThan(0);
  });

  it("truncates a long document to a preview and points at read_document", async () => {
    await env.cleanup();
    const long = await startFakeParser({ text: "z".repeat(MAX_INLINE_CHARS * 3) });
    try {
      env = await startTestServer({
        providers: [providerFor(llm)],
        documentParsers: [{ id: "big", name: "Big", kind: "sync", baseURL: long.baseURL }],
        documentParsing: { policy: "cloud-only" },
      });
      const ws = await newWorkspace(env);
      const session = await newSession(env, ws.id);

      const attachment = await uploadAttachment(env, session.id, {
        name: "book.pdf",
        mimeType: "application/pdf",
        data: buildPdf(["x"]),
      });
      await waitForParsing(env, session.id);

      llm.setTurns([{ content: "answer" }]);
      await env.server.app.inject({
        method: "POST",
        url: `/api/sessions/${session.id}/chat`,
        payload: { message: "summarise", attachments: [attachment] },
      });

      const sent = JSON.stringify(llm.requests()[0]);
      // The preview is inlined, the rest is not — the whole point of the truncation.
      expect(sent).toContain("内容过长");
      expect(sent).toContain("read_document");
      expect(sent).toContain(attachment.id);
      expect(sent).not.toContain("z".repeat(MAX_INLINE_CHARS));
    } finally {
      await long.close();
    }
  });

  it("tells a model without tool support that the rest was simply omitted", async () => {
    await env.cleanup();
    const long = await startFakeParser({ text: "z".repeat(MAX_INLINE_CHARS * 3) });
    try {
      env = await startTestServer({
        // A model whose capabilities exclude tool_use: pointing it at read_document would
        // promise a capability it does not have.
        providers: [
          {
            id: "no-tools",
            name: "No tools",
            baseURL: llm.baseURL,
            apiKey: "test-key",
            models: [{ id: "fake-model", name: "fake-model" }],
          },
        ],
        documentParsers: [{ id: "big", name: "Big", kind: "sync", baseURL: long.baseURL }],
        documentParsing: { policy: "cloud-only" },
      });
      const ws = await newWorkspace(env);
      const session = await newSession(env, ws.id);

      // Strip the capability the seeder guessed.
      const provider = env.server.db.listProviders()[0]!;
      env.server.db.updateModel(provider.models[0]!.id, { capabilities: [] });

      const attachment = await uploadAttachment(env, session.id, {
        name: "book.pdf",
        mimeType: "application/pdf",
        data: buildPdf(["x"]),
      });
      await waitForParsing(env, session.id);

      llm.setTurns([{ content: "answer" }]);
      await env.server.app.inject({
        method: "POST",
        url: `/api/sessions/${session.id}/chat`,
        payload: { message: "summarise", attachments: [attachment] },
      });

      // Scope to the user message: `read_document` still appears in the tool list if the
      // model was given tools at all, so the request as a whole is the wrong thing to read.
      const request = llm.requests()[0]! as { messages: { role: string; content: unknown }[] };
      const userTurn = JSON.stringify(request.messages.filter((m) => m.role === "user"));
      expect(userTurn).toContain("已省略");
      expect(userTurn).not.toContain("read_document");
    } finally {
      await long.close();
    }
  });

  it("reports an unparsed document as such rather than staying silent", async () => {
    const session = await newSession(env, workspace.id);
    const attachment = await uploadAttachment(env, session.id, {
      name: "scanned.pdf",
      mimeType: "application/pdf",
      data: buildPdf([""]),
    });
    await waitForParsing(env, session.id);

    llm.setTurns([{ content: "ok" }]);
    await env.server.app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/chat`,
      payload: { message: "read this", attachments: [attachment] },
    });

    const sent = JSON.stringify(llm.requests()[0]);
    expect(sent).toContain("scanned.pdf");
    expect(sent).toContain("解析失败");
  });
});
