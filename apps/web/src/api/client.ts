import type {
  AdminUser,
  AnswerToolCallInput,
  Attachment,
  AuthResult,
  AuthTokens,
  ChatInput,
  ChatStreamEvent,
  Copilot,
  CreateCopilotInput,
  CreateDocumentParserInput,
  CreateProviderInput,
  CreateSessionInput,
  CreateUserInput,
  DirectoryListing,
  DocumentParserConfig,
  DocumentParsingConfig,
  DriverInfo,
  FileContent,
  GetPlanResponse,
  GetQuizQuestionsResponse,
  Message,
  PlanSnapshot,
  PlanView,
  ProviderConfig,
  QuizAnswer,
  QuizQuestionView,
  PublicConfig,
  Session,
  SessionStats,
  SessionWidgets,
  Source,
  UpdateCopilotInput,
  UpdateDocumentParserInput,
  UpdateDocumentParsingInput,
  UpdateProviderInput,
  UpdateSessionInput,
  UpdateUserInput,
  UploadAttachmentInput,
  User,
  UserCredentials,
  WidgetId,
  WidgetState,
  Workspace,
  WorkspaceStats,
} from "@ilearnassist/shared";
import { AUTH_STORAGE_KEY } from "@ilearnassist/shared";
import { ApiError, translateApiError } from "../utils/apiError";

/**
 * A failed response's body, as loosely as we can read it.
 *
 * Two shapes arrive here. Our own routes send the coded envelope
 * (`{ error: { code, message, params? } }`); Fastify's built-in errors send
 * `{ statusCode, error: "Not Found", message: "Route ... not found" }`. The `string` arm
 * of `error` is what keeps the second working.
 */
type RawErrorBody = {
  error?: string | { code?: string; message?: string; params?: Record<string, string | number> };
  message?: string;
};

async function errorBody(res: Response): Promise<RawErrorBody> {
  return (await res.json().catch(() => ({}))) as RawErrorBody;
}

/**
 * Normalize either shape into an `ApiError` whose `message` is already in the user's
 * language. Because it extends `Error`, every existing
 * `catch (e) { store.setError(e.message) }` site renders translated text without changing.
 */
function toApiError(body: RawErrorBody, status: number): ApiError {
  const error = body.error;
  if (error && typeof error === "object") {
    return new ApiError(
      error.code,
      translateApiError(error.code, error.params, error.message) || `Request failed (${status})`,
      status
    );
  }
  // Fastify's own error, or a route that has not been migrated yet. Its `message` is the
  // specific one ("Bad Request" is the generic `error`), so prefer it.
  return new ApiError(undefined, body.message ?? error ?? `Request failed (${status})`, status);
}

/**
 * Called when a request comes back 401 and could not be refreshed, so the app can put the
 * login screen back up.
 *
 * A callback rather than importing `showLogin` here, because the store imports this module
 * and the two would circle. `stores/app.ts` is what sets it, once.
 */
let onUnauthenticated: (() => void) | undefined;

export function setUnauthenticatedHandler(handler: () => void): void {
  onUnauthenticated = handler;
}

/* --------------------------------- the token --------------------------------- */
/*
 * Where the bearer token lives between requests.
 *
 * In `localStorage`, which is the trade the token model makes and worth stating plainly: an
 * HttpOnly cookie cannot be read by page script and this can, so a script injection anywhere
 * on the origin is a stolen session. What buys that back is everything else about the design —
 * the access token is a day old at most, a refresh token is spent on use, and either can be
 * revoked server-side without touching the other clients. The alternative, a cookie, is a
 * design this product had and moved away from deliberately.
 *
 * One key holding both halves, rather than two: they are written and cleared together, and
 * two keys are two chances to leave half a session behind.
 *
 * The key itself lives in `packages/shared`, because the browser suite has to name it too —
 * see its note there.
 */

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
}

function readStored(): StoredTokens | null {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredTokens>;
    if (typeof parsed?.accessToken !== "string" || typeof parsed?.refreshToken !== "string") {
      return null;
    }
    return { accessToken: parsed.accessToken, refreshToken: parsed.refreshToken };
  } catch {
    // Unreadable or malformed storage is the same as no storage: the app signs in again. It is
    // a cache of a credential, not a place anything else is kept.
    return null;
  }
}

let tokens: StoredTokens | null = readStored();

export function setStoredTokens(next: AuthTokens | StoredTokens | null): void {
  tokens = next ? { accessToken: next.accessToken, refreshToken: next.refreshToken } : null;
  try {
    if (tokens) localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(tokens));
    else localStorage.removeItem(AUTH_STORAGE_KEY);
  } catch {
    // Private browsing with storage disabled. The session then lives only in this tab, which
    // is a downgrade rather than a failure — nothing here needs the write to have landed.
  }
}

/**
 * What came of trying to refresh.
 *
 * Three answers rather than a boolean, and the distinction is the point: "the server refused
 * it" and "the request never arrived" look identical to a caller that only gets a boolean, and
 * they call for opposite things. A refusal means sign in again; a dropped connection means try
 * again later, with the token still in hand.
 */
type RefreshOutcome =
  /** A fresh pair is stored. Retry the request. */
  | "refreshed"
  /** The server refused it, or there was nothing to present. The session is over. */
  | "refused"
  /** The request itself failed. The pair is untouched and may well still be good. */
  | "unreachable";

/**
 * The refresh in flight, if any.
 *
 * Shared rather than per request, and that is load-bearing on a cold load: the app fires
 * several requests at once, and with the access token a day old they all 401 together. Letting
 * each one refresh would spend the same single-use refresh token from several directions and
 * all but the first would fail.
 */
let refreshing: Promise<RefreshOutcome> | null = null;

async function refreshTokens(): Promise<RefreshOutcome> {
  const presented = tokens?.refreshToken;
  // Nothing to present is not a network problem: there is no session here, and the 401 that
  // prompted this is the honest answer.
  if (!presented) return "refused";

  refreshing ??= (async (): Promise<RefreshOutcome> => {
    try {
      const res = await fetch("/api/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: presented }),
      });
      if (!res.ok) {
        // Spent, expired or revoked — all the same move: sign in again. Cleared here rather
        // than left for the caller, so a second request does not try the same dead token.
        setStoredTokens(null);
        return "refused";
      }
      setStoredTokens(((await res.json()) as AuthResult).tokens);
      return "refreshed";
    } catch {
      // Offline, or the server went away mid-restart. The token may well still be good, so it
      // is *not* cleared — and the caller must not report an expiry off the back of this, or a
      // dropped connection would land the user on the sign-in screen with a valid session in
      // storage and a reload signing them straight back in.
      return "unreachable";
    } finally {
      refreshing = null;
    }
  })();

  return refreshing;
}

/**
 * Paths where a 401 that survives a refresh is the *answer* rather than an expired session.
 *
 * Reporting one of these would open the app with an error about a session that never existed:
 * `GET /auth/me` answering 401 is how a cold load asks whether anyone is signed in, and on a
 * first visit the honest answer is "no" rather than "yours expired".
 *
 * Listed one by one rather than by an `/auth/` prefix, because `/auth/password` is *not* one
 * of them: a 401 there means the token died under a signed-in user, which is exactly the case
 * the refresh exists for.
 */
const ANSWERS_WITH_401 = new Set([
  "/auth/login",
  "/auth/refresh",
  "/auth/logout",
  "/auth/me",
]);

/**
 * The headers a request goes out with, with the bearer token on them if there is one.
 *
 * One function for both the JSON calls and the image fetch, because the two must not disagree
 * about how a token is spelled — and a second `Bearer ` literal is how they would.
 */
function authHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  if (tokens) headers.set("Authorization", `Bearer ${tokens.accessToken}`);
  return headers;
}

async function send<T>(path: string, init: RequestInit | undefined, mayRefresh: boolean): Promise<T> {
  // Only send a JSON content-type when there is actually a body. Fastify (5.x)
  // rejects body-less requests that claim `application/json` with a 400
  // (FST_ERR_CTP_EMPTY_JSON_BODY), which broke DELETE calls.
  const options: RequestInit = { ...init };
  if (options.body !== undefined && options.headers === undefined) {
    options.headers = { "Content-Type": "application/json" };
  }
  options.headers = authHeaders(options.headers);

  const res = await fetch(`/api${path}`, options);

  if (res.status === 401) {
    // The refresh is tried **before** the answer-paths are consulted, and that ordering is
    // what makes the week-long session real. `/auth/me` cannot tell "nobody is signed in" from
    // "the access token aged out overnight", so treating its 401 as final would send a user
    // who was signed in yesterday back to the sign-in form even though their refresh token was
    // still good — which is the one thing the second lifetime exists to prevent.
    //
    // `refreshTokens` answers false without a request when there is nothing to present, so a
    // genuinely first visit costs no round trip and reaches the same place.
    //
    // One refresh, one retry. The retry is safe because a 401 comes from the gate, which
    // refuses *before* any handler runs — so nothing was persisted and nothing can be done
    // twice.
    const outcome = mayRefresh ? await refreshTokens() : "refused";
    if (outcome === "refreshed") return send<T>(path, init, false);
    // Only a *refused* refresh is an expired session. An unreachable one falls through to the
    // error below with the pair still stored, so the user is told the request failed rather
    // than that they were signed out.
    if (outcome === "refused" && !ANSWERS_WITH_401.has(path)) onUnauthenticated?.();
  }
  if (!res.ok) throw toApiError(await errorBody(res), res.status);
  return res.json() as Promise<T>;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return send<T>(path, init, true);
}

/**
 * A request whose reply carries a new token pair, which is stored before the caller sees it.
 *
 * Every route that returns `AuthResult` goes through here rather than through `request`, so
 * there is no call site where storing the pair is something to remember. A failure to store it
 * would be a session that works until the next navigation and then silently does not.
 */
async function requestAuth(path: string, init: RequestInit): Promise<AuthResult> {
  const result = await request<AuthResult>(path, init);
  setStoredTokens(result.tokens);
  return result;
}

export const api = {
  /* ----------------------------------- auth ----------------------------------- */

  /**
   * Sign in.
   *
   * The app has no create-an-account screen and asks for no status first: the first
   * administrator is made by the **control panel**, which spawns the server package's CLI as a
   * one-shot child so it works with the server deliberately stopped. A running server always
   * has an administrator, so there is no "nobody can sign in yet" state for a page to see.
   */
  login: (username: string, password: string) =>
    requestAuth("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),

  /**
   * Sign out of this client.
   *
   * The refresh token rides along so the server can spend it; the stored pair is cleared here
   * either way, because the local state is going regardless and a failed logout that left the
   * user looking signed in would be the worse of the two outcomes.
   */
  logout: async () => {
    const refreshToken = tokens?.refreshToken;
    try {
      return await request<{ ok: boolean }>("/auth/logout", {
        method: "POST",
        body: JSON.stringify(refreshToken ? { refreshToken } : {}),
      });
    } finally {
      setStoredTokens(null);
    }
  },

  /** Who the caller is. A 401 here is the answer, not an expiry — see `ANSWERS_WITH_401`. */
  me: () => request<User>("/auth/me"),

  /**
   * Change your own password.
   *
   * Requires the current one, and answers with a fresh pair: the change ends every session the
   * account holds, this one included. Also the way out of a forced change.
   */
  changePassword: (oldPassword: string, newPassword: string) =>
    requestAuth("/auth/password", {
      method: "POST",
      body: JSON.stringify({ oldPassword, newPassword }),
    }),

  /* ------------------------------ platform console ----------------------------- */
  /*
   * Accounts, for a superadmin. Every one of these answers 403 for anybody else, which is the
   * server's rule and not a screen's: a hidden button is not a permission.
   */

  listAccounts: () => request<{ users: AdminUser[] }>("/admin/users"),
  createAccount: (input: CreateUserInput) =>
    request<UserCredentials>("/admin/users", { method: "POST", body: JSON.stringify(input) }),
  updateAccount: (id: string, input: UpdateUserInput) =>
    request<AdminUser>(`/admin/users/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  /**
   * Give an account a new password without knowing the old one. Omit `password` to have one
   * generated. The password comes back once and is never readable again.
   *
   * Storing the returned pair is not optional when the account reset is the caller's own: the
   * server ends every session it holds, including the one making the request, and hands back a
   * replacement for exactly that reason. Dropping it would sign the administrator out of the
   * console they are standing in — the action would look like a bug.
   */
  resetAccountPassword: async (id: string, password?: string) => {
    const result = await request<UserCredentials>(`/admin/users/${id}/password`, {
      method: "POST",
      body: JSON.stringify(password ? { password } : {}),
    });
    if (result.tokens) setStoredTokens(result.tokens);
    return result;
  },
  /** End every session an account holds, without touching its password. */
  revokeAccountSessions: (id: string) =>
    request<{ ok: boolean; revoked: number }>(`/admin/users/${id}/revoke`, { method: "POST" }),

  /* ---------------------------------- the app ---------------------------------- */

  getConfig: () => request<PublicConfig>("/config"),

  listWorkspaces: () => request<Workspace[]>("/workspaces"),
  /**
   * `widgets` is the whole workspace-scope selection, chosen before the workspace existed —
   * the create dialog ticks boxes for an object that does not exist yet, so this is the one
   * write that carries them all. Omitted means the server's defaults.
   */
  createWorkspace: (name: string, widgets?: WidgetId[]) =>
    request<Workspace>("/workspaces", { method: "POST", body: JSON.stringify({ name, widgets }) }),
  renameWorkspace: (id: string, name: string) =>
    request<Workspace>(`/workspaces/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  deleteWorkspace: (id: string) =>
    request<{ ok: boolean }>(`/workspaces/${id}`, { method: "DELETE" }),

  listCopilots: () => request<Copilot[]>("/copilots"),
  createCopilot: (input: CreateCopilotInput) =>
    request<Copilot>("/copilots", { method: "POST", body: JSON.stringify(input) }),
  updateCopilot: (id: string, input: UpdateCopilotInput) =>
    request<Copilot>(`/copilots/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  deleteCopilot: (id: string) =>
    request<{ ok: boolean }>(`/copilots/${id}`, { method: "DELETE" }),

  /**
   * One directory level of the workspace, addressed by a path relative to its root (`""`
   * for the root itself). The tree is expanded by the user, so only the levels they opened
   * are ever fetched.
   */
  listFiles: (workspaceId: string, path: string) =>
    request<DirectoryListing>(
      `/workspaces/${workspaceId}/files?path=${encodeURIComponent(path)}`
    ),
  /** A file's metadata and, when it is text, its contents. */
  readFileContent: (workspaceId: string, path: string) =>
    request<FileContent>(
      `/workspaces/${workspaceId}/files/content?path=${encodeURIComponent(path)}`
    ),

  listSessions: (workspaceId: string) =>
    request<Session[]>(`/workspaces/${workspaceId}/sessions`),
  createSession: (workspaceId: string, input: CreateSessionInput) =>
    request<Session>(`/workspaces/${workspaceId}/sessions`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateSession: (id: string, input: UpdateSessionInput) =>
    request<Session>(`/sessions/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteSession: (id: string) =>
    request<{ ok: boolean }>(`/sessions/${id}`, { method: "DELETE" }),

  listMessages: (sessionId: string) => request<Message[]>(`/sessions/${sessionId}/messages`),

  /*
   * Widgets.
   *
   * The installs are a `PUT` on one widget rather than a `PATCH` on a list, because that is what
   * a toggle is: the resource is `(scope, scopeId, widgetId)` and `enabled` is its whole state,
   * so repeating the request is the same as making it once.
   */
  listWorkspaceWidgets: (workspaceId: string) =>
    request<WidgetState[]>(`/workspaces/${workspaceId}/widgets`),
  setWorkspaceWidget: (workspaceId: string, widgetId: WidgetId, enabled: boolean) =>
    request<WidgetState>(`/workspaces/${workspaceId}/widgets/${widgetId}`, {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    }),
  /** Both groups at once, so the tab strip cannot render half-drawn. */
  listSessionWidgets: (sessionId: string) =>
    request<SessionWidgets>(`/sessions/${sessionId}/widgets`),
  setSessionWidget: (sessionId: string, widgetId: WidgetId, enabled: boolean) =>
    request<WidgetState>(`/sessions/${sessionId}/widgets/${widgetId}`, {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    }),

  /* The statistics the widget panels read. About the object, not about a widget. */
  getWorkspaceStats: (workspaceId: string) =>
    request<WorkspaceStats>(`/workspaces/${workspaceId}/stats`),
  getSessionStats: (sessionId: string) => request<SessionStats>(`/sessions/${sessionId}/stats`),

  // Plans. `{ plan: null }` is the ordinary empty state, not an error.
  getPlan: (sessionId: string) => request<GetPlanResponse>(`/sessions/${sessionId}/plan`),
  getPlanVersion: (sessionId: string, version: number) =>
    request<PlanSnapshot>(`/sessions/${sessionId}/plan/versions/${version}`),
  // Move study to one chapter: prior undone nodes are marked skipped server-side.
  jumpPlanNode: (
    sessionId: string,
    nodeId: string
  ): Promise<{ plan: PlanView; number: string; title: string; skippedCount: number }> =>
    request(`/sessions/${sessionId}/plan/nodes/${nodeId}/jump`, { method: "POST" }),

  // Quiz questions for the quiz widget. An empty list is the ordinary empty state.
  listQuizQuestions: (sessionId: string) =>
    request<GetQuizQuestionsResponse>(`/sessions/${sessionId}/quizzes`),
  // Make-up answer for one skipped question: validates/persists, after which the client
  // drives an ordinary chat turn that grades it.
  answerQuizQuestion: (sessionId: string, quizId: string, answer: QuizAnswer) =>
    request<{ question: QuizQuestionView }>(
      `/sessions/${sessionId}/quizzes/${quizId}/answer`,
      { method: "POST", body: JSON.stringify({ answer }) }
    ),

  /**
   * Stop the turn currently streaming for a session.
   *
   * Deliberately a request of its own rather than aborting the chat fetch: the stream has
   * to stay open for the server to report the partial reply down it. `ok: false` means
   * nothing was running — the stop raced the turn's own ending, which is an outcome, not
   * a failure.
   */
  stopSession: (sessionId: string) =>
    request<{ ok: boolean }>(`/sessions/${sessionId}/stop`, { method: "POST" }),

  uploadAttachment: (sessionId: string, input: UploadAttachmentInput) =>
    request<Attachment>(`/sessions/${sessionId}/sources`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  listProviders: () => request<ProviderConfig[]>("/providers"),
  createProvider: (input: CreateProviderInput) =>
    request<ProviderConfig>("/providers", { method: "POST", body: JSON.stringify(input) }),
  updateProvider: (id: string, input: UpdateProviderInput) =>
    request<ProviderConfig>(`/providers/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  deleteProvider: (id: string) =>
    request<{ ok: boolean }>(`/providers/${id}`, { method: "DELETE" }),
  deleteModel: (providerId: string, modelId: string) =>
    request<ProviderConfig>(`/providers/${providerId}/models/${modelId}`, { method: "DELETE" }),

  updateDefaults: (input: { providerId?: string; modelId?: string }) =>
    request<PublicConfig>("/defaults", { method: "PUT", body: JSON.stringify(input) }),

  /* --------------------------- document parsers --------------------------- */

  listParserKinds: () => request<DriverInfo[]>("/document-parsers/kinds"),
  listDocumentParsers: () => request<DocumentParserConfig[]>("/document-parsers"),
  createDocumentParser: (input: CreateDocumentParserInput) =>
    request<DocumentParserConfig>("/document-parsers", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateDocumentParser: (id: string, input: UpdateDocumentParserInput) =>
    request<DocumentParserConfig>(`/document-parsers/${id}`, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  deleteDocumentParser: (id: string) =>
    request<{ ok: boolean }>(`/document-parsers/${id}`, { method: "DELETE" }),
  // A failure is a 400 carrying the error envelope, so it rejects rather than resolving
  // with `ok: false` — callers only ever see the success shape.
  testDocumentParser: (id: string) =>
    request<{ ok: true }>(`/document-parsers/${id}/test`, { method: "POST" }),
  updateDocumentParsing: (input: UpdateDocumentParsingInput) =>
    request<DocumentParsingConfig>("/document-parsing", {
      method: "PUT",
      body: JSON.stringify(input),
    }),

  /**
   * The files a conversation can read, with the parse state as it is now.
   *
   * Not "this conversation's attachments": a source can be shared with the workspace, and this
   * is what the composer overlays onto its chips so a reparse shows up without a reload.
   */
  listSessionSources: (sessionId: string) => request<Source[]>(`/sessions/${sessionId}/sources`),
  /** Every file the account has uploaded — the list the sources dialog manages. */
  listSources: () => request<Source[]>("/sources"),
  /**
   * Delete a file for good: its bytes, its extracted text, and every reference to it.
   *
   * Distinct from deleting a conversation, which leaves files alone. The messages that were
   * sent with it keep their snapshots, so history still shows what was sent.
   */
  deleteSource: (sourceId: string) =>
    request<{ ok: boolean }>(`/sources/${sourceId}`, { method: "DELETE" }),
  /** Addressed by the source, not by a conversation: the file is the account's. */
  reparseSource: (sourceId: string, name?: string) =>
    request<{ status: string }>(`/sources/${sourceId}/reparse`, {
      method: "POST",
      body: JSON.stringify(name ? { name } : {}),
    }),
};

/**
 * A source's bytes, as an object URL the page can point an `<img>` at.
 *
 * **Fetched rather than linked, and that is what a bearer token costs.** An `<img src>` cannot
 * carry an `Authorization` header, so `/api/sources/:id/raw` is not something a browser will
 * load on the page's behalf any more. The alternatives were worse: a token in the query string
 * lands in server logs, browser history and every `Referer` the page emits, and a separate
 * signed-URL endpoint is a second kind of credential to get right.
 *
 * The caller owns the returned URL and must `revokeObjectURL` it. Addressed by the source
 * alone, so two conversations referencing the same file fetch the same bytes.
 */
export async function sourceImageUrl(sourceId: string): Promise<string> {
  const res = await fetch(`/api/sources/${sourceId}/raw`, { headers: authHeaders() });
  if (!res.ok) throw toApiError(await errorBody(res), res.status);
  return URL.createObjectURL(await res.blob());
}

/** Read a File as bare base64 (no `data:` prefix), matching `UploadAttachmentInput`. */
export async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  // Chunked so a large file does not blow the argument limit of String.fromCharCode.
  let binary = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Parse an `event: ...\ndata: ...\n\n` Server-Sent Events stream into typed events. */
async function* sseEvents(response: Response): AsyncGenerator<ChatStreamEvent> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body.");
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sepIdx: number;
    while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, sepIdx);
      buffer = buffer.slice(sepIdx + 2);

      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (data) {
        try {
          yield JSON.parse(data) as ChatStreamEvent;
        } catch {
          // ignore malformed frames
        }
      }
    }
  }
}

/**
 * POST a body and stream the SSE frames it answers with.
 *
 * One refresh-and-retry, the same as `send`. Retrying a turn is safe for a reason worth
 * stating: a 401 comes from the gate, which refuses *before* any handler runs — so nothing was
 * persisted and no second message can appear. Past that point the reply is a stream and there
 * is nothing to retry, which is why the refresh happens before the body is read.
 */
async function* streamPost(
  path: string,
  body: unknown,
  mayRefresh = true
): AsyncGenerator<ChatStreamEvent> {
  const res = await fetch(`/api${path}`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    const outcome = mayRefresh ? await refreshTokens() : "refused";
    if (outcome === "refreshed") {
      yield* streamPost(path, body, false);
      return;
    }
    const body_ = await errorBody(res);
    // Same rule as `send`, including the distinction: a turn that 401s and cannot be refreshed
    // means the session went away mid-conversation, and the user has to be sent back to the
    // login screen rather than left with an error about a message they cannot send. An
    // unreachable refresh is not that, and ends as a failed turn with the token still held.
    if (outcome === "refused") onUnauthenticated?.();
    throw toApiError(body_, res.status);
  }
  if (!res.ok) throw toApiError(await errorBody(res), res.status);
  // A 200 with no body breaks the SSE contract below rather than being a server-reported
  // error, so it stays a plain Error — there is no code to translate.
  if (!res.body) throw new Error("No response body.");
  yield* sseEvents(res);
}

/** Stream the agent's chat response for a session. */
export function streamChat(sessionId: string, input: ChatInput): AsyncGenerator<ChatStreamEvent> {
  return streamPost(`/sessions/${sessionId}/chat`, input);
}

/**
 * Answer a pending `ask_user` call and stream the turn that resumes from it.
 *
 * The same shape as `streamChat` on purpose: from the client's side the only difference
 * is which bytes started the turn, so both are consumed by one loop in the store.
 */
export function streamAnswers(
  sessionId: string,
  input: AnswerToolCallInput
): AsyncGenerator<ChatStreamEvent> {
  return streamPost(`/sessions/${sessionId}/answers`, input);
}
