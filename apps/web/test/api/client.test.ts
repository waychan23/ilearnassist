import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatStreamEvent } from "@guided-learning/shared";
import { api, attachmentUrl, fileToBase64, streamAnswers, streamChat } from "../../src/api/client.js";
import { ApiError } from "../../src/utils/apiError.js";
import { i18n } from "../../src/i18n.js";

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

/** A response whose body streams the given chunks verbatim. */
function sseResponse(chunks: string[], init: ResponseInit = {}) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" }, ...init });
}

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const mock = vi.fn(async (url: unknown, init?: RequestInit) => handler(String(url), init));
  vi.stubGlobal("fetch", mock);
  return mock;
}

async function collect(sessionId = "s1"): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = [];
  for await (const event of streamChat(sessionId, { message: "hi" })) events.push(event);
  return events;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("request", () => {
  it("parses a successful response", async () => {
    stubFetch(() => jsonResponse({ ok: true }));
    await expect(api.listWorkspaces()).resolves.toEqual({ ok: true });
  });

  it("calls the API under /api", async () => {
    const fetchMock = stubFetch(() => jsonResponse([]));
    await api.listWorkspaces();
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/workspaces");
  });

  it("prefers a specific `message` over the generic `error`", async () => {
    // Fastify errors carry a specific message and a generic error ("Bad Request").
    stubFetch(() => jsonResponse({ error: "Bad Request", message: "body is required" }, { status: 400 }));
    await expect(api.listWorkspaces()).rejects.toThrow("body is required");
  });

  it("falls back to `error` when there is no message", async () => {
    stubFetch(() => jsonResponse({ error: "name is required" }, { status: 400 }));
    await expect(api.listWorkspaces()).rejects.toThrow("name is required");
  });

  it("falls back to the status when the body is not JSON", async () => {
    stubFetch(() => new Response("<html>500</html>", { status: 500 }));
    await expect(api.listWorkspaces()).rejects.toThrow("Request failed (500)");
  });

  describe("the coded error envelope", () => {
    // Our own routes send `{ error: { code, message, params? } }`. The code is what the
    // user reads; the server's `message` is only a fallback.
    beforeEach(() => {
      i18n.global.locale.value = "zh-CN";
    });

    it("renders the code in the active language and keeps the code on the error", async () => {
      stubFetch(() =>
        jsonResponse(
          { error: { code: "SESSION_NOT_FOUND", message: "session not found" } },
          { status: 404 }
        )
      );

      const error = await api.listWorkspaces().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("SESSION_NOT_FOUND");
      expect((error as ApiError).status).toBe(404);
      // The server's English sentence is replaced by the localized one.
      expect((error as Error).message).toBe("会话不存在，可能已被删除。");
    });

    it("interpolates params from the envelope", async () => {
      stubFetch(() =>
        jsonResponse(
          { error: { code: "FILE_TOO_LARGE", message: "too large", params: { limitMb: 20 } } },
          { status: 413 }
        )
      );
      await expect(api.listWorkspaces()).rejects.toThrow("文件超过 20 MB 限制。");
    });

    it("falls back to the server's message for a code this build does not know", async () => {
      stubFetch(() =>
        jsonResponse(
          { error: { code: "FROM_A_NEWER_SERVER", message: "the server said this" } },
          { status: 400 }
        )
      );
      // Must not render the key path, which is what a bare `t()` would produce.
      await expect(api.listWorkspaces()).rejects.toThrow("the server said this");
    });

    it("uses the status when the envelope carries no message at all", async () => {
      stubFetch(() => jsonResponse({ error: { code: "UNKNOWN_TO_ME" } }, { status: 502 }));
      await expect(api.listWorkspaces()).rejects.toThrow("Request failed (502)");
    });
  });

  it("sends a JSON content-type only when there is a body", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ ok: true }));

    await api.createWorkspace("Notes");
    expect((fetchMock.mock.calls[0]![1]!.headers as Record<string, string>)["Content-Type"]).toBe("application/json");

    // A body-less DELETE claiming application/json is rejected by Fastify with
    // FST_ERR_CTP_EMPTY_JSON_BODY, so it must not set the header.
    await api.deleteWorkspace("w1");
    expect(fetchMock.mock.calls[1]![1]!.headers).toBeUndefined();
  });

  it("serializes the payload", async () => {
    const fetchMock = stubFetch(() => jsonResponse({}));
    await api.createWorkspace("My Notes");
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({ name: "My Notes" });
  });

  it("builds the session URLs from the right ids", async () => {
    const fetchMock = stubFetch(() => jsonResponse([]));
    await api.deleteModel("p1", "m1");
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/providers/p1/models/m1");
  });
});

describe("attachmentUrl", () => {
  it("points at the attachment route", () => {
    expect(attachmentUrl("s1", "a1")).toBe("/api/sessions/s1/attachments/a1");
  });
});

describe("fileToBase64", () => {
  it("encodes a small file", async () => {
    await expect(fileToBase64(new File(["hello"], "a.txt"))).resolves.toBe("aGVsbG8=");
  });

  it("encodes a file larger than the chunk size without corrupting it", async () => {
    // The 8 KB chunking exists so `String.fromCharCode(...)` cannot blow the argument
    // limit; the bytes must still come back identical.
    const bytes = new Uint8Array(20_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;

    const encoded = await fileToBase64(new File([bytes], "big.bin"));
    const decoded = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    expect(decoded).toEqual(bytes);
  });

  it("encodes an empty file", async () => {
    await expect(fileToBase64(new File([], "empty.txt"))).resolves.toBe("");
  });
});

describe("streamChat", () => {
  it("posts the chat input", async () => {
    const fetchMock = stubFetch(() => sseResponse(["event: done\ndata: {\"type\":\"done\"}\n\n"]));
    await collect("s7");

    expect(fetchMock.mock.calls[0]![0]).toBe("/api/sessions/s7/chat");
    expect(fetchMock.mock.calls[0]![1]!.method).toBe("POST");
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({ message: "hi" });
  });

  it("throws the server's error on a non-OK response", async () => {
    stubFetch(() => jsonResponse({ error: "session not found" }, { status: 404 }));
    await expect(collect()).rejects.toThrow("session not found");
  });

  it("throws when there is no response body", async () => {
    stubFetch(() => new Response(null, { status: 200 }));
    await expect(collect()).rejects.toThrow(/Chat failed|No response body/);
  });

  it("throws when there is no response body", async () => {
    stubFetch(() => new Response(null, { status: 200 }));
    await expect(collect()).rejects.toThrow(/Chat failed|No response body/);
  });

  describe("streamAnswers", () => {
    // The resumed turn arrives on its own route but in the same shape, which is what lets
    // the store drain both with one loop.
    async function collectAnswers(): Promise<ChatStreamEvent[]> {
      const events: ChatStreamEvent[] = [];
      for await (const event of streamAnswers("s7", {
        toolCallId: "call_1",
        action: "submit",
        answers: { "0": { selected: ["OAuth"] } },
      })) {
        events.push(event);
      }
      return events;
    }

    it("posts the submission to the answers route", async () => {
      const fetchMock = stubFetch(() => sseResponse(['event: done\ndata: {"type":"done"}\n\n']));
      await collectAnswers();

      expect(fetchMock.mock.calls[0]![0]).toBe("/api/sessions/s7/answers");
      expect(fetchMock.mock.calls[0]![1]!.method).toBe("POST");
      expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({
        toolCallId: "call_1",
        action: "submit",
        answers: { "0": { selected: ["OAuth"] } },
      });
    });

    it("parses the resumed turn's events", async () => {
      stubFetch(() =>
        sseResponse([
          'event: meta\ndata: {"type":"meta","sessionId":"s7"}\n\n',
          'event: text\ndata: {"type":"text","delta":"好的"}\n\n',
          'event: done\ndata: {"type":"done"}\n\n',
        ])
      );

      await expect(collectAnswers()).resolves.toEqual([
        { type: "meta", sessionId: "s7" },
        { type: "text", delta: "好的" },
        { type: "done" },
      ]);
    });

    it("surfaces a 409 as a translated ApiError", async () => {
      // The double-submit and the already-skipped card both land here, and the store rolls
      // the card back on it — so it has to reject rather than resolve with no events.
      i18n.global.locale.value = "zh-CN";
      stubFetch(() =>
        jsonResponse(
          { error: { code: "QUESTION_NOT_PENDING", message: "that question is no longer awaiting an answer" } },
          { status: 409 }
        )
      );

      await expect(collectAnswers()).rejects.toBeInstanceOf(ApiError);
      await expect(collectAnswers()).rejects.toThrow("这组问题已经不需要回答了");
    });
  });

  describe("event parsing", () => {
    it("yields typed events in order", async () => {
      stubFetch(() =>
        sseResponse([
          'event: meta\ndata: {"type":"meta","sessionId":"s1"}\n\n',
          'event: text\ndata: {"type":"text","delta":"Hi"}\n\n',
          'event: done\ndata: {"type":"done"}\n\n',
        ])
      );
      await expect(collect()).resolves.toEqual([
        { type: "meta", sessionId: "s1" },
        { type: "text", delta: "Hi" },
        { type: "done" },
      ]);
    });

    it("reassembles a frame split across chunks", async () => {
      const frame = 'event: text\ndata: {"type":"text","delta":"split"}\n\n';
      stubFetch(() => sseResponse([frame.slice(0, 10), frame.slice(10)]));
      await expect(collect()).resolves.toEqual([{ type: "text", delta: "split" }]);
    });

    it("parses several frames delivered in one chunk", async () => {
      stubFetch(() =>
        sseResponse(['event: text\ndata: {"type":"text","delta":"a"}\n\nevent: text\ndata: {"type":"text","delta":"b"}\n\n'])
      );
      await expect(collect()).resolves.toEqual([
        { type: "text", delta: "a" },
        { type: "text", delta: "b" },
      ]);
    });

    it("joins multi-line data fields within one frame", async () => {
      stubFetch(() => sseResponse(['event: text\ndata: {"type":"text",\ndata: "delta":"joined"}\n\n']));
      await expect(collect()).resolves.toEqual([{ type: "text", delta: "joined" }]);
    });

    it("skips a malformed frame without dropping the rest", async () => {
      stubFetch(() =>
        sseResponse([
          'event: text\ndata: {not json}\n\n',
          'event: text\ndata: {"type":"text","delta":"survived"}\n\n',
        ])
      );
      await expect(collect()).resolves.toEqual([{ type: "text", delta: "survived" }]);
    });

    it("ignores a frame with no data line", async () => {
      stubFetch(() => sseResponse([": keepalive\n\n", 'data: {"type":"done"}\n\n']));
      await expect(collect()).resolves.toEqual([{ type: "done" }]);
    });

    it("carries every event variant the server can send", async () => {
      stubFetch(() =>
        sseResponse([
          'data: {"type":"reasoning","delta":"hmm"}\n\n',
          'data: {"type":"tool_start","toolCall":{"id":"c1","name":"read_file","input":"{}"}}\n\n',
          'data: {"type":"tool_end","toolCall":{"id":"c1","name":"read_file","input":"{}","output":"ok"}}\n\n',
          'data: {"type":"usage","usage":{"totalTokens":5}}\n\n',
          'data: {"type":"title","sessionId":"s1","title":"T"}\n\n',
          'data: {"type":"error","message":"boom"}\n\n',
        ])
      );

      const events = await collect();
      expect(events.map((e) => e.type)).toEqual([
        "reasoning",
        "tool_start",
        "tool_end",
        "usage",
        "title",
        "error",
      ]);
    });
  });
});
