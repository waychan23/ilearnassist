import type {
  AnswerToolCallInput,
  Attachment,
  ChatInput,
  ChatStreamEvent,
  Copilot,
  CreateCopilotInput,
  CreateDocumentParserInput,
  CreateProviderInput,
  CreateSessionInput,
  DirectoryListing,
  DocumentParserConfig,
  DocumentParsingConfig,
  DriverInfo,
  FileContent,
  GetPlanResponse,
  Message,
  PlanSnapshot,
  ProviderConfig,
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
  UploadAttachmentInput,
  User,
  WidgetId,
  WidgetState,
  Workspace,
  WorkspaceStats,
} from "@ilearnassist/shared";
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
 * Called when a request comes back 401, so the app can put the login screen back up.
 *
 * A callback rather than importing `showLogin` here, because the store imports this module
 * and the two would circle. `stores/app.ts` is what sets it, once.
 */
let onUnauthenticated: (() => void) | undefined;

export function setUnauthenticatedHandler(handler: () => void): void {
  onUnauthenticated = handler;
}

/**
 * Whether a path is part of signing in rather than something that needs a session.
 *
 * These are exempt from the 401 handler, and the exemption is load-bearing: `GET /auth/me`
 * answering 401 is the *expected* reply on a cold load — it is how the app asks whether
 * anyone is signed in — so treating it as an expiry would open every first visit with an
 * error about a session that never existed.
 */
const isAuthPath = (path: string): boolean => path.startsWith("/auth/");

/** A 401 from anywhere else means the session is gone; report it and rethrow. */
function reportExpiry(status: number, path: string): void {
  if (status === 401 && !isAuthPath(path)) onUnauthenticated?.();
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Only send a JSON content-type when there is actually a body. Fastify (5.x)
  // rejects body-less requests that claim `application/json` with a 400
  // (FST_ERR_CTP_EMPTY_JSON_BODY), which broke DELETE calls.
  const options: RequestInit = { ...init };
  if (options.body !== undefined && options.headers === undefined) {
    options.headers = { "Content-Type": "application/json" };
  }

  // No `credentials` option, and none is needed: `fetch` defaults to `same-origin`, the app
  // is served from one origin, and the Vite dev proxy puts `/api` on that same origin too.
  // The session cookie rides along. Serving the API from somewhere else would break this.
  const res = await fetch(`/api${path}`, options);
  if (!res.ok) {
    const body = await errorBody(res);
    reportExpiry(res.status, path);
    throw toApiError(body, res.status);
  }
  return res.json() as Promise<T>;
}

export const api = {
  /* ----------------------------------- auth ----------------------------------- */

  /**
   * Sign in, creating the account if the name is new.
   *
   * One field, because there is one credential: a username, and no password at all. The
   * screen says so rather than leaving a user to guess what they are meant to type.
   */
  login: (username: string) =>
    request<User>("/auth/login", { method: "POST", body: JSON.stringify({ username }) }),
  logout: () => request<{ ok: boolean }>("/auth/logout", { method: "POST" }),
  /** Who the caller is. A 401 here is the answer, not an expiry — see `isAuthPath`. */
  me: () => request<User>("/auth/me"),
  /** The names that exist, so a returning visitor can pick one rather than recall it. */
  listUsers: () => request<{ usernames: string[] }>("/auth/users"),

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
 * URL for a source's bytes (used as an `<img src>`), not an API call.
 *
 * Addressed by the source alone, which is also why the response can be cached immutably: two
 * conversations referencing the same file resolve to the same URL, and that URL's content
 * never changes.
 */
export function attachmentUrl(sourceId: string): string {
  return `/api/sources/${sourceId}/raw`;
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

/** POST a body and stream the SSE frames it answers with. */
async function* streamPost(path: string, body: unknown): AsyncGenerator<ChatStreamEvent> {
  const res = await fetch(`/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const body_ = await errorBody(res);
    // Same rule as `request`: a turn that 401s means the session went away mid-conversation,
    // and the user has to be sent back to the login screen rather than left with an error
    // about a message they cannot send.
    reportExpiry(res.status, path);
    throw toApiError(body_, res.status);
  }
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
