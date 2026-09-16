import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatInput, ChatStreamEvent } from "@ilearnassist/shared";
import {
  api,
  fileToBase64,
  setUnauthenticatedHandler,
  setStoredTokens,
  sourceImageUrl,
  streamAnswers,
  streamChat,
} from "../../src/api/client.js";
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

async function collect(
  sessionId = "s1",
  input: Partial<ChatInput> = {}
): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = [];
  const chatInput: ChatInput = { message: "hi", ...input };
  for await (const event of streamChat(sessionId, chatInput)) events.push(event);
  return events;
}

/** The headers of one `fetch` call, as the client built them. */
function headerOf(mock: ReturnType<typeof stubFetch>, call: number): Headers {
  return (mock.mock.calls[call]![1]?.headers ?? new Headers()) as Headers;
}

afterEach(() => {
  vi.unstubAllGlobals();
  // The token lives in `localStorage`, which jsdom keeps for the whole file — so one test's
  // session would otherwise ride along on the next test's requests.
  setStoredTokens(null);
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
    expect(headerOf(fetchMock, 0).get("Content-Type")).toBe("application/json");

    // A body-less DELETE claiming application/json is rejected by Fastify with
    // FST_ERR_CTP_EMPTY_JSON_BODY, so it must not set the header.
    await api.deleteWorkspace("w1");
    expect(headerOf(fetchMock, 1).get("Content-Type")).toBeNull();
    expect(fetchMock.mock.calls[1]![1]!.body).toBeUndefined();
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

describe("workspace files", () => {
  it("asks for one directory level, with the path encoded", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ path: "", entries: [], truncated: false }));
    await api.listFiles("w1", "docs/sub dir");

    expect(fetchMock.mock.calls[0]![0]).toBe(
      "/api/workspaces/w1/files?path=docs%2Fsub%20dir"
    );
  });

  it("encodes the root as an empty path rather than omitting the parameter", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ path: "", entries: [], truncated: false }));
    await api.listFiles("w1", "");

    expect(fetchMock.mock.calls[0]![0]).toBe("/api/workspaces/w1/files?path=");
  });

  it("reads a file's contents from its own route", async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse({
        path: "a.md",
        name: "a.md",
        size: 1,
        modifiedAt: "2026-01-01T00:00:00.000Z",
        kind: "markdown",
        text: "#",
        truncated: false,
      })
    );
    await api.readFileContent("w1", "notes/a.md");

    expect(fetchMock.mock.calls[0]![0]).toBe(
      "/api/workspaces/w1/files/content?path=notes%2Fa.md"
    );
  });

  it("shows the catalog's sentence when the server refuses a path", async () => {
    i18n.global.locale.value = "zh-CN";
    stubFetch(() =>
      jsonResponse(
        { error: { code: "INVALID_FILE_PATH", message: "outside the workspace" } },
        { status: 400 }
      )
    );

    await expect(api.listFiles("w1", "../..")).rejects.toBeInstanceOf(ApiError);
    await expect(api.listFiles("w1", "../..")).rejects.toThrow("这个位置不在工作区内，无法访问。");
  });
});

describe("widgets and statistics", () => {
  it("addresses one widget as a resource, and toggles it with a PUT", async () => {
    // A `PUT` on the triple rather than a `PATCH` on a list: the widget *is* the resource and
    // `enabled` is its whole state, which is what makes a double-clicked toggle idempotent.
    const fetchMock = stubFetch(() =>
      jsonResponse({ id: "session_stats", scope: "session", enabled: true })
    );
    await api.setSessionWidget("s1", "session_stats", true);

    expect(fetchMock.mock.calls[0]![0]).toBe("/api/sessions/s1/widgets/session_stats");
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe("PUT");
    expect((fetchMock.mock.calls[0]![1] as RequestInit).body).toBe('{"enabled":true}');
  });

  it("reads both of a conversation's groups from one route", async () => {
    // One request, because the strip is one control: split across two, it could render with the
    // divider in the wrong place for a frame.
    const fetchMock = stubFetch(() => jsonResponse({ workspace: [], session: [] }));
    await api.listSessionWidgets("s1");
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/sessions/s1/widgets");
  });

  it("keeps the workspace-scope read separate from the conversation one", async () => {
    // The settings dialog needs a workspace's installs where there is no conversation to ask
    // about — from the home page's card, or the welcome screen.
    const fetchMock = stubFetch(() => jsonResponse([]));
    await api.listWorkspaceWidgets("w1");
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/workspaces/w1/widgets");
  });

  it("reads statistics from the object rather than from a widget's namespace", async () => {
    // Two widgets read the same two routes and a third will; hanging them off one widget would
    // make the next consumer add a second path to the same query.
    const fetchMock = stubFetch(() => jsonResponse({}));
    await api.getWorkspaceStats("w1");
    await api.getSessionStats("s1");

    expect(fetchMock.mock.calls[0]![0]).toBe("/api/workspaces/w1/stats");
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/sessions/s1/stats");
  });

  it("sends a workspace's widget selection in the create request", async () => {
    const fetchMock = stubFetch(() => jsonResponse({ id: "w1" }));
    await api.createWorkspace("Notes", ["workspace_stats"]);

    expect((fetchMock.mock.calls[0]![1] as RequestInit).body).toBe(
      '{"name":"Notes","widgets":["workspace_stats"]}'
    );
  });

  it("omits the widget field when no selection was made", async () => {
    // The distinction the API is built on: an absent field means "nobody decided" and takes the
    // server's default, while `[]` means none.
    const fetchMock = stubFetch(() => jsonResponse({ id: "w1" }));
    await api.createWorkspace("Notes");

    expect((fetchMock.mock.calls[0]![1] as RequestInit).body).toBe('{"name":"Notes"}');
  });
});

describe("sourceImageUrl", () => {
  it("fetches the bytes with the token and hands back an object URL", async () => {
    // Fetched rather than linked, because an `<img src>` cannot carry an `Authorization`
    // header — see the note on the function. The address is the source alone: the file belongs
    // to the account, so two conversations referencing it fetch the same bytes.
    setStoredTokens({ accessToken: "at", refreshToken: "rt" });
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:sources/a1" }));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      blob: async () => new Blob(["bytes"]),
    });
    vi.stubGlobal("fetch", fetchMock);

    const url = await sourceImageUrl("a1");

    expect(fetchMock.mock.calls[0]![0]).toBe("/api/sources/a1/raw");
    expect(headerOf(fetchMock as never, 0).get("Authorization")).toBe("Bearer at");
    expect(url).toBe("blob:sources/a1");
  });
});

describe("readRawFile", () => {
  /** A response with no usable type, which is what the raw route deliberately sends. */
  function rawResponse(body: string) {
    return {
      ok: true,
      status: 200,
      blob: async () => new Blob([body], { type: "application/octet-stream" }),
    };
  }

  it("carries /api on the URL, unlike the paths in the api object", async () => {
    /*
     * The regression this exists for. Every path in `api` is `/api`-relative because `request()`
     * adds the prefix; this function is a bare `fetch` and must carry its own. Getting it wrong
     * is not a 404 — a dev server answers an unknown path with `index.html` at **200**, so the
     * viewer is handed a few kilobytes of HTML to draw as a PNG and the only symptom is a
     * picture that will not decode, with nothing in the console to say why.
     */
    setStoredTokens({ accessToken: "at", refreshToken: "rt" });
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => rawResponse("PNG"));
    vi.stubGlobal("fetch", fetchMock);

    await api.readRawFile("w1", "photo.png", "photo.png");

    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      `/api/workspaces/w1/files/raw?path=${encodeURIComponent("photo.png")}`
    );
    expect(headerOf(fetchMock as never, 0).get("Authorization")).toBe("Bearer at");
  });

  it("does the same for a conversation's own directory", async () => {
    setStoredTokens({ accessToken: "at", refreshToken: "rt" });
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => rawResponse("PNG"));
    vi.stubGlobal("fetch", fetchMock);

    await api.readSessionRawFile("s1", "shot.png", "shot.png");

    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      `/api/sessions/s1/files/raw?path=${encodeURIComponent("shot.png")}`
    );
  });

  it("builds the File's type from the name, not from the response", async () => {
    // The route sends `application/octet-stream` for everything on purpose — these bytes are
    // re-materialised into our own DOM by the office plugins — so the name is the only thing
    // that can label them, and it is also what the viewer matches its plugins by.
    setStoredTokens({ accessToken: "at", refreshToken: "rt" });
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, _init?: RequestInit) => rawResponse("PNG")));

    const file = await api.readRawFile("w1", "photo.png", "photo.png");

    expect(file.name).toBe("photo.png");
    expect(file.type).toBe("image/png");
    expect(file.size).toBe(3);
  });

  it("falls back to a type nothing will act on when the name is unfamiliar", async () => {
    setStoredTokens({ accessToken: "at", refreshToken: "rt" });
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, _init?: RequestInit) => rawResponse("data")));

    const file = await api.readRawFile("w1", "mystery.zzz", "mystery.zzz");

    expect(file.type).toBe("application/octet-stream");
  });
});

describe("uploaded files", () => {
  it("describes a source through its own route, under /api", async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse({
        path: "doc.pdf",
        name: "doc.pdf",
        size: 8,
        modifiedAt: "2026-01-01T00:00:00.000Z",
        kind: "binary",
        text: null,
        truncated: false,
      })
    );

    await api.readSourcePreview("s1");

    // Addressed by the source rather than by a path: a source is outside every workspace, so
    // there is no path for the file browser's routes to take.
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/sources/s1/preview");
  });

  it("fetches a source's bytes as the same File a workspace file comes back as", async () => {
    setStoredTokens({ accessToken: "at", refreshToken: "rt" });
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      blob: async () => new Blob(["PNG"], { type: "application/octet-stream" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const file = await api.readSourceRawFile("s1", "shot.png");

    expect(String(fetchMock.mock.calls[0]![0])).toBe("/api/sources/s1/raw");
    expect(headerOf(fetchMock as never, 0).get("Authorization")).toBe("Bearer at");
    // Indistinguishable from a workspace file's, which is what lets one viewer serve both.
    expect(file.name).toBe("shot.png");
    expect(file.type).toBe("image/png");
  });
});

describe("the bearer token", () => {
  it("rides on every request once there is one", async () => {
    setStoredTokens({ accessToken: "at", refreshToken: "rt" });
    const fetchMock = stubFetch(() => jsonResponse([]));

    await api.listWorkspaces();

    expect(headerOf(fetchMock, 0).get("Authorization")).toBe("Bearer at");
  });

  it("is refreshed and the request retried when it comes back 401", async () => {
    // The ordinary case: the access token lasts a day, so a tab left open past it 401s once
    // and carries on. The retry is safe because a 401 is the gate refusing *before* any
    // handler ran — nothing was persisted, so nothing can be done twice.
    setStoredTokens({ accessToken: "stale", refreshToken: "rt" });
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url) === "/api/auth/refresh") {
        return jsonResponse({
          user: {},
          tokens: { accessToken: "fresh", refreshToken: "rt2", expiresIn: 60 },
        });
      }
      const header = init?.headers as Headers;
      return header.get("Authorization") === "Bearer fresh"
        ? jsonResponse([{ id: "w1" }])
        : jsonResponse({ error: { code: "UNAUTHENTICATED", message: "no" } }, { status: 401 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.listWorkspaces()).resolves.toEqual([{ id: "w1" }]);

    expect(String(fetchMock.mock.calls[0]![0])).toBe("/api/workspaces");
    expect(String(fetchMock.mock.calls[1]![0])).toBe("/api/auth/refresh");
    expect(String(fetchMock.mock.calls[2]![0])).toBe("/api/workspaces");
  });

  it("gives up and reports an expired session when the refresh fails too", async () => {
    setStoredTokens({ accessToken: "stale", refreshToken: "rt" });
    const fetchMock = vi.fn(async (url: unknown) =>
      String(url) === "/api/auth/refresh"
        ? jsonResponse({ error: { code: "INVALID_REFRESH_TOKEN", message: "spent" } }, { status: 401 })
        : jsonResponse({ error: { code: "UNAUTHENTICATED", message: "no" } }, { status: 401 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.listWorkspaces()).rejects.toThrow();

    // The dead pair is dropped rather than left to be presented again by the next request.
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([
      "/api/workspaces",
      "/api/auth/refresh",
    ]);
    expect(localStorage.getItem("ila-auth")).toBeNull();
  });

  it("stores the replacement pair a self-reset hands back", async () => {
    // Resetting your *own* password ends every session the account holds — including the one
    // making the request — so the server answers with a fresh pair. Dropping it would sign the
    // administrator out of the console they are standing in, which is the one way this action
    // could look like a bug.
    setStoredTokens({ accessToken: "about-to-die", refreshToken: "about-to-die" });
    stubFetch(() =>
      jsonResponse({
        user: { id: "u1", username: "Ada", roles: ["superadmin"] },
        password: "abcd-efgh-ijkl-mnop",
        tokens: { accessToken: "fresh", refreshToken: "fresh-rt", expiresIn: 60 },
      })
    );

    await api.resetAccountPassword("u1");

    const stored = JSON.parse(localStorage.getItem("ila-auth") ?? "{}") as {
      accessToken?: string;
    };
    expect(stored.accessToken).toBe("fresh");
  });

  it("leaves the stored pair alone when it reset somebody else's", async () => {
    // Resetting another account ends *their* sessions, not the caller's. Replacing the
    // caller's pair with nothing would sign them out for an action that was not about them.
    setStoredTokens({ accessToken: "mine", refreshToken: "mine-rt" });
    stubFetch(() =>
      jsonResponse({
        user: { id: "u2", username: "Bob", roles: ["user"] },
        password: "abcd-efgh-ijkl-mnop",
      })
    );

    await api.resetAccountPassword("u2");

    const stored = JSON.parse(localStorage.getItem("ila-auth") ?? "{}") as {
      accessToken?: string;
    };
    expect(stored.accessToken).toBe("mine");
  });

  it("refreshes even where 401 is normally the answer, so a week-long session survives", async () => {
    /*
     * The case this exists for: the access token lasts a day, the refresh token a week, and
     * `/auth/me` cannot tell "nobody is signed in" from "the access token aged out overnight".
     * Treating its 401 as final would send somebody who was signed in yesterday back to the
     * sign-in form with a perfectly good refresh token in hand.
     */
    setStoredTokens({ accessToken: "stale", refreshToken: "rt" });
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url) === "/api/auth/refresh") {
        return jsonResponse({
          user: {},
          tokens: { accessToken: "fresh", refreshToken: "rt2", expiresIn: 60 },
        });
      }
      const header = init?.headers as Headers;
      return header.get("Authorization") === "Bearer fresh"
        ? jsonResponse({ id: "u1", username: "Ada" })
        : jsonResponse({ error: { code: "UNAUTHENTICATED", message: "no" } }, { status: 401 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.me()).resolves.toMatchObject({ username: "Ada" });
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([
      "/api/auth/me",
      "/api/auth/refresh",
      "/api/auth/me",
    ]);
  });

  it("does not report an expiry when the refresh never arrived", async () => {
    /*
     * A dropped connection is not a refused credential, and the two call for opposite things:
     * one means sign in again, the other means try later. `refreshTokens` deliberately keeps
     * the pair when the request itself fails, and treating that as an expiry would land the
     * user on the sign-in screen holding a valid session — where a reload signs them straight
     * back in, which is the UI and the stored credential disagreeing.
     */
    const onUnauthenticated = vi.fn();
    setUnauthenticatedHandler(onUnauthenticated);
    setStoredTokens({ accessToken: "stale", refreshToken: "rt" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network down");
      })
    );

    await expect(api.listWorkspaces()).rejects.toThrow();

    expect(onUnauthenticated).not.toHaveBeenCalled();
    // Still there, because it may well still be good.
    expect(localStorage.getItem("ila-auth")).not.toBeNull();
  });

  it("does not refresh, and does not report an expiry, when there is nothing to present", async () => {
    // A genuine first visit: no stored pair, so `refreshTokens` answers without a request and
    // `/auth/me`'s 401 stays what it is — the answer, not an expired session. Reporting it
    // would open every first visit with an error about a session that never existed.
    const handlers = vi.fn();
    setUnauthenticatedHandler(handlers);
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: { code: "UNAUTHENTICATED", message: "no" } }, { status: 401 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.me()).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(handlers).not.toHaveBeenCalled();
  });

  describe("a session that has ended", () => {
    /*
     * The kick: every token row is revoked server-side, so the next requests answer 401 and
     * the refresh answers 401 too. A cold tab fires several requests at once, and the page
     * keeps trying afterwards (widgets, dialogs, turns) — the whole bug was that the login
     * screen went up and an optimistic catch navigated straight back to the chat pane.
     */
    function revokedFetcher() {
      return vi.fn(async (url: unknown) =>
        String(url) === "/api/auth/refresh"
          ? jsonResponse(
              { error: { code: "INVALID_REFRESH_TOKEN", message: "spent" } },
              { status: 401 }
            )
          : jsonResponse(
              { error: { code: "UNAUTHENTICATED", message: "no" } },
              { status: 401 }
            )
      );
    }

    it("declares the session over once however many requests 401 together", async () => {
      const onUnauthenticated = vi.fn();
      setUnauthenticatedHandler(onUnauthenticated);
      setStoredTokens({ accessToken: "stale", refreshToken: "spent" });
      const fetchMock = revokedFetcher();
      vi.stubGlobal("fetch", fetchMock);

      await Promise.allSettled([api.listWorkspaces(), api.listCopilots()]);

      // Both data requests were already in flight, and they share the one refresh attempt.
      expect(fetchMock).toHaveBeenCalledTimes(3);
      // The handler — what takes the app to the login screen — runs exactly once.
      expect(onUnauthenticated).toHaveBeenCalledTimes(1);
    });

    it("stops later requests at the door with the same coded 401", async () => {
      const onUnauthenticated = vi.fn();
      setUnauthenticatedHandler(onUnauthenticated);
      setStoredTokens({ accessToken: "stale", refreshToken: "spent" });
      const fetchMock = revokedFetcher();
      vi.stubGlobal("fetch", fetchMock);

      await expect(api.listWorkspaces()).rejects.toBeInstanceOf(ApiError);
      const callsAfterRefusal = fetchMock.mock.calls.length;

      // Every request the kicked page goes on to make — widgets re-fetching, dialogs loading,
      // a turn being sent — rejects locally, as the same UNAUTHENTICATED 401 the server would
      // answer, without touching the network again.
      const later = await api.listSessions("w1").catch((e: unknown) => e);
      expect(later).toBeInstanceOf(ApiError);
      expect((later as ApiError).status).toBe(401);
      expect((later as ApiError).code).toBe("UNAUTHENTICATED");
      expect(fetchMock).toHaveBeenCalledTimes(callsAfterRefusal);
      expect(onUnauthenticated).toHaveBeenCalledTimes(1);
    });

    it("still lets a sign-in through, and its pair clears the ended state", async () => {
      setStoredTokens({ accessToken: "stale", refreshToken: "spent" });
      const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
        const path = String(url);
        if (path === "/api/auth/refresh") {
          return jsonResponse(
            { error: { code: "INVALID_REFRESH_TOKEN", message: "spent" } },
            { status: 401 }
          );
        }
        if (path === "/api/auth/login") {
          return jsonResponse({
            user: { id: "u1", username: "Ada" },
            tokens: { accessToken: "new-at", refreshToken: "new-rt", expiresIn: 60 },
          });
        }
        const header = init?.headers as Headers;
        return header.get("Authorization") === "Bearer new-at"
          ? jsonResponse([{ id: "w1" }])
          : jsonResponse(
              { error: { code: "UNAUTHENTICATED", message: "no" } },
              { status: 401 }
            );
      });
      vi.stubGlobal("fetch", fetchMock);

      await expect(api.listWorkspaces()).rejects.toBeInstanceOf(ApiError);

      // The next session's sign-in is the one request exempt from the short-circuit.
      await expect(api.login("ada", "secret")).resolves.toMatchObject({
        user: { username: "Ada" },
      });
      // And app data flows again under the new pair.
      await expect(api.listWorkspaces()).resolves.toEqual([{ id: "w1" }]);
      expect(localStorage.getItem("ila-auth")).toContain("new-at");
    });

    it("rejects a streamed turn locally instead of sending it to a dead session", async () => {
      setStoredTokens({ accessToken: "stale", refreshToken: "spent" });
      const fetchMock = revokedFetcher();
      vi.stubGlobal("fetch", fetchMock);

      await expect(api.listWorkspaces()).rejects.toBeInstanceOf(ApiError);
      const callsAfterRefusal = fetchMock.mock.calls.length;

      // The generator throws when iteration starts — a send after a kick is a failed turn
      // with no request paid for, and the login screen is already up.
      await expect(collect("s-dead")).rejects.toBeInstanceOf(ApiError);
      expect(fetchMock).toHaveBeenCalledTimes(callsAfterRefusal);
    });

    it("takes an attached image through the same refresh and handler", async () => {
      const onUnauthenticated = vi.fn();
      setUnauthenticatedHandler(onUnauthenticated);
      setStoredTokens({ accessToken: "stale", refreshToken: "spent" });
      vi.stubGlobal("fetch", revokedFetcher());

      await expect(sourceImageUrl("a1")).rejects.toBeInstanceOf(ApiError);
      expect(onUnauthenticated).toHaveBeenCalledTimes(1);
    });
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
  /**
   * The zone this environment reports, which is what the client is supposed to send.
   *
   * Read rather than written out: the value comes from the host, so a literal would make these
   * tests pass only on the machine they were written on — and it is the *presence* of the right
   * value that is worth asserting, not which zone the suite happens to run in.
   */
  const hostZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  it("posts the chat input", async () => {
    const fetchMock = stubFetch(() => sseResponse(["event: done\ndata: {\"type\":\"done\"}\n\n"]));
    await collect("s7");

    expect(fetchMock.mock.calls[0]![0]).toBe("/api/sessions/s7/chat");
    expect(fetchMock.mock.calls[0]![1]!.method).toBe("POST");
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({
      message: "hi",
      timezone: hostZone,
    });
  });

  it("states the browser's own zone, not one a caller passed", async () => {
    /*
     * The field is a fact about the browser rather than an input, which is why the client's own
     * value wins rather than the caller's. The server's turn prompt says what time it is *where
     * the user is*, and a call site with an opinion about that is a call site that can make the
     * model state an hour the user is not living in.
     */
    const fetchMock = stubFetch(() => sseResponse(["event: done\ndata: {\"type\":\"done\"}\n\n"]));
    await collect("s7", { timezone: "America/New_York" });

    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)).timezone).toBe(hostZone);
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
        // A resumed turn is a turn: its system prompt states the time too.
        timezone: hostZone,
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
