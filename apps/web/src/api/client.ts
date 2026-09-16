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
  CreateNoteInput,
  CreateProviderInput,
  CreateSessionInput,
  CreateUserInput,
  DirectoryListing,
  DocumentParserConfig,
  DocumentParsingConfig,
  DriverInfo,
  FileContent,
  GenerateSessionInsightsResponse,
  GetPlanResponse,
  GetQuizQuestionsResponse,
  GetSessionDiagramsResponse,
  GetSessionInsightsResponse,
  GetSessionNotesResponse,
  GetSessionThreadsResponse,
  Insight,
  Message,
  Note,
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
  UpdateInsightInput,
  UpdateNoteInput,
  UpdateProviderInput,
  UpdateSessionInput,
  UpdateUserInput,
  UploadAttachmentInput,
  User,
  UserCredentials,
  WidgetId,
  WidgetState,
  Workspace,
  WorkspaceSettings,
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

/**
 * Whether this tab's session has been declared over.
 *
 * Set the first time a 401 survives a refresh — a revoked pair, an expired refresh token —
 * and kept until a new pair is stored (a sign-in, a successful refresh, a self-reset) or the
 * stored pair is deliberately cleared. Two things depend on it:
 *
 * - The handler below fires **once**. A cold tab fires several requests together, so a kick
 *   answers all of them with 401 at once; without this the login screen would be torn down
 *   and rebuilt several times in a row, with one toast per request.
 * - Every later request short-circuits (see `send`/`streamPost`) instead of hitting a server
 *   that will only ever refuse it. After a kick the page keeps trying — widgets re-fetch,
 *   dialogs load, turns send — and each real 401 is console noise that tells nobody anything
 *   new. They reject with the same coded error the server would have sent, so callers' catches
 *   behave identically.
 */
let sessionEnded = false;

/** Declare the session over exactly once, however many parallel 401s arrive together. */
function markSessionEnded(): void {
  if (sessionEnded) return;
  sessionEnded = true;
  onUnauthenticated?.();
}

/** The rejection a request gets after the session has ended, identical in shape to the
 * server's own 401 envelope so callers cannot tell the two apart. */
function sessionEndedError(): ApiError {
  return new ApiError(
    "UNAUTHENTICATED",
    translateApiError("UNAUTHENTICATED", undefined, undefined) || "Request failed (401)",
    401
  );
}

/**
 * Requests still allowed once the session has ended.
 *
 * The sign-in call is the one that starts the next session; the refresh is what proved this
 * one ended. Everything else rejects locally, including `/auth/me` — after an explicit
 * session death nobody needs to ask the server who they are.
 */
const SESSION_RECOVERY_PATHS = new Set(["/auth/login", "/auth/refresh"]);

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
  // Any explicit write resets the verdict: a fresh pair is a new session, and a deliberate
  // clear is a fresh start. Note the ordering this depends on: a refused refresh clears the
  // pair *inside* `refreshTokens`, and the session-ended flag is set only afterwards by the
  // caller, so the clear there cannot wipe the verdict of the very 401 being handled.
  sessionEnded = false;
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
 * What a 401 comes to after the one permitted refresh attempt.
 *
 * Shared by `send`, `streamPost` and `sourceImageUrl`, because the image fetch used to carry
 * its own 401 handling — which was none: a kicked account opening an attached image got a
 * silent failure and stayed on a page whose session was already over. `signalsEnd` is the
 * `!ANSWERS_WITH_401.has(path)` question, asked by the caller because only it knows the path:
 * a 401 on `/auth/me` is an answer, not an expiry, and must not tear the app down.
 */
async function recoverFrom401(
  mayRefresh: boolean,
  signalsEnd: boolean
): Promise<RefreshOutcome> {
  const outcome = mayRefresh ? await refreshTokens() : "refused";
  if (outcome === "refused" && signalsEnd) markSessionEnded();
  return outcome;
}

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
  // After the session has ended, nothing but a new sign-in may leave the tab — see
  // `SESSION_RECOVERY_PATHS`. The rejection mirrors a real 401, so every catch site behaves
  // the way it does against the server.
  if (sessionEnded && !SESSION_RECOVERY_PATHS.has(path)) throw sessionEndedError();

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
    const outcome = await recoverFrom401(mayRefresh, !ANSWERS_WITH_401.has(path));
    if (outcome === "refreshed") return send<T>(path, init, false);
    // A refused refresh has declared the session over and moved the app to the login screen
    // once. An unreachable one falls through to the error below with the pair still stored, so
    // the user is told the request failed rather than that they were signed out.
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
  /**
   * A workspace's name and description, either or both.
   *
   * One method rather than a `rename…` and a `set…Description`, because the settings dialog
   * edits the two on one screen and the route takes them in one statement. An **omitted** field
   * is left alone and an empty description clears it — the absent/empty distinction the route
   * documents, and the reason this takes a patch object rather than two positional arguments
   * (which could not express "the name, but nothing about the description").
   */
  updateWorkspace: (id: string, patch: { name?: string; description?: string }) =>
    request<Workspace>(`/workspaces/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  /**
   * A workspace's own defaults, replaced wholesale.
   *
   * Omitted means "leave alone", which is what a rename sends — the route takes each field
   * independently so the two writers do not have to know about each other.
   */
  updateWorkspaceSettings: (id: string, settings: WorkspaceSettings) =>
    request<Workspace>(`/workspaces/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ settings }),
    }),
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
  /*
   * The four writes beside them, because a browser that cannot create, upload, move or delete
   * is a browser for a filesystem the user has no other way to reach: this is a web app, so
   * there is no Finder to fall back on.
   *
   * Each is one call rather than a general "files" endpoint with a verb in the body: the four
   * answer four different questions about a path, and their failures are different — a name
   * that is taken, a directory that is not empty, a path that is not inside the workspace.
   */
  createWorkspaceDirectory: (workspaceId: string, path: string) =>
    request<{ path: string; type: "dir" }>(`/workspaces/${workspaceId}/files/directory`, {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  /**
   * Upload bytes into a directory.
   *
   * The directory and the name are separate fields rather than one path, which is the server's
   * rule as well: a name that could carry a separator would let an upload land somewhere the
   * person did not point at.
   */
  uploadWorkspaceFile: (
    workspaceId: string,
    input: { dir: string; name: string; mimeType?: string; data: string }
  ) =>
    request<Source>(`/workspaces/${workspaceId}/files/upload`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  /**
   * Add a web page as a source, by pasting its URL.
   *
   * A workspace, never a conversation — the same rule the upload picker follows, and the same
   * reason: material added from outside a conversation belongs to the workspace it was added to.
   */
  addWebSource: (input: { url: string; workspaceId: string }) =>
    request<Source>("/sources/pages", { method: "POST", body: JSON.stringify(input) }),
  moveWorkspaceEntry: (workspaceId: string, input: { from: string; to: string }) =>
    request<{ from: string; to: string }>(`/workspaces/${workspaceId}/files/move`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  deleteWorkspaceEntry: (workspaceId: string, path: string) =>
    request<{ ok: boolean; path: string }>(
      `/workspaces/${workspaceId}/files?path=${encodeURIComponent(path)}`,
      { method: "DELETE" }
    ),
  /**
   * The same two reads for a conversation's own directory — where the diagrams it draws are
   * written. The flat directory is the whole of it: one level, no tree, and the same
   * envelopes as the workspace's.
   */
  listSessionFiles: (sessionId: string, path: string) =>
    request<DirectoryListing>(
      `/sessions/${sessionId}/files?path=${encodeURIComponent(path)}`
    ),
  readSessionFileContent: (sessionId: string, path: string) =>
    request<FileContent>(
      `/sessions/${sessionId}/files/content?path=${encodeURIComponent(path)}`
    ),
  /**
   * A file's bytes, as a `File` the preview viewer can be handed.
   *
   * A separate call from the two above rather than a field on their reply, because they carry
   * different things: those answer *what this is* in JSON and stop at 256 KB, and this answers
   * *here are the bytes* and goes to `MAX_FILE_PREVIEW_BYTES`. The caller has already read the
   * metadata by the time it asks for these — it needs the `kind` to know whether to ask at all.
   *
   * `name` is the client's and is not optional, because the response carries no usable type
   * (see the route's docblock) and the viewer matches its plugins by name. So this is the one
   * place the name and the bytes are put back together.
   */
  readRawFile: (workspaceId: string, path: string, name: string) =>
    fetchRawFile(`/api/workspaces/${workspaceId}/files/raw?path=${encodeURIComponent(path)}`, name),
  readSessionRawFile: (sessionId: string, path: string, name: string) =>
    fetchRawFile(`/api/sessions/${sessionId}/files/raw?path=${encodeURIComponent(path)}`, name),
  /**
   * An uploaded file, described the same way a workspace file is.
   *
   * Addressed by the *source* rather than by a path, because a source lives outside every
   * workspace — `sources/raw/<id>.<ext>` — and belongs to the account. `kind` comes back in the
   * same vocabulary, so the same dialog renders both.
   */
  readSourcePreview: (sourceId: string) =>
    request<FileContent>(`/sources/${sourceId}/preview`),
  /**
   * An uploaded file's bytes. The same `File` the browser's own files come back as, so the
   * viewer cannot tell the two apart — which is the point.
   *
   * No size cap on this one and none needed: uploads are already capped at
   * `MAX_ATTACHMENT_BYTES` when they arrive, so a source is at most 10 MB.
   */
  readSourceRawFile: (sourceId: string, name: string) =>
    fetchRawFile(`/api/sources/${sourceId}/raw`, name),
  /**
   * The diagrams a conversation drew, as rows carrying the model's summary and their
   * thread. Distinct from `listSessionFiles`, which lists the whole folder, so a
   * hand-copied `.mmd` is not itself a diagram the agent drew.
   */
  listSessionDiagrams: (sessionId: string) =>
    request<GetSessionDiagramsResponse>(`/sessions/${sessionId}/diagrams`),

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
  /**
   * Delete a message. The server soft-deletes it and refuses anything but the conversation's
   * last live message (`MESSAGE_NOT_LAST`), so a caller that raced another tab gets an error
   * rather than a hole in the middle of the conversation.
   */
  deleteMessage: (sessionId: string, messageId: string) =>
    request<{ ok: boolean }>(`/sessions/${sessionId}/messages/${messageId}`, { method: "DELETE" }),

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

  // Threads (the thread widget): derived topic chains plus the still-unclassified count.
  getSessionThreads: (sessionId: string) =>
    request<GetSessionThreadsResponse>(`/sessions/${sessionId}/threads`),
  // Classify one chunk of the oldest unassigned turns, then return the fresh view.
  syncSessionThreads: (sessionId: string) =>
    request<GetSessionThreadsResponse>(`/sessions/${sessionId}/threads/sync`, {
      method: "POST",
    }),

  /*
   * Notes (the notes widget). About the conversation, not about the widget: a note is the
   * learner's own writing and stays readable through the routes whether or not the panel is
   * installed — which is what lets uninstalling it lose nothing but the panel.
   */
  listNotes: (sessionId: string) => request<GetSessionNotesResponse>(`/sessions/${sessionId}/notes`),
  createNote: (sessionId: string, input: CreateNoteInput) =>
    request<Note>(`/sessions/${sessionId}/notes`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateNote: (sessionId: string, noteId: string, input: UpdateNoteInput) =>
    request<Note>(`/sessions/${sessionId}/notes/${noteId}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  deleteNote: (sessionId: string, noteId: string) =>
    request<{ ok: boolean }>(`/sessions/${sessionId}/notes/${noteId}`, { method: "DELETE" }),

  /*
   * Insights (the insight widget), about the conversation for the same reason.
   *
   * `generateInsights` is a long POST on purpose: it runs a whole-conversation model call and
   * answers when the pass is done, so the panel disables its button and says it is working rather
   * than polling for a background job. `status: "failed"` arrives as a **200** with the list
   * unchanged — a pass that produced nothing usable is a fact about the call, not an error the
   * panel should render as one.
   */
  listInsights: (sessionId: string) =>
    request<GetSessionInsightsResponse>(`/sessions/${sessionId}/insights`),
  generateInsights: (sessionId: string) =>
    request<GenerateSessionInsightsResponse>(`/sessions/${sessionId}/insights/generate`, {
      method: "POST",
    }),
  setInsightAdopted: (sessionId: string, insightId: string, input: UpdateInsightInput) =>
    request<{ item: Insight }>(`/sessions/${sessionId}/insights/${insightId}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  deleteInsight: (sessionId: string, insightId: string) =>
    request<{ ok: boolean }>(`/sessions/${sessionId}/insights/${insightId}`, {
      method: "DELETE",
    }),

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
  /**
   * The account's sources, filtered.
   *
   * One call for every caller, because the filters are the API rather than a mode: the uploads
   * dialog asks for `storage=upload`, the source browser asks for whatever its controls say,
   * and neither needs a route of its own. Only the keys that are set travel — an empty filter
   * is a request with no query string at all.
   */
  listSources: (filter: SourceFilterQuery = {}) => request<Source[]>(`/sources${queryOf(filter)}`),
  /**
   * One source, by id.
   *
   * For a caller that has the id and needs the row *now*: the composer polls this while a
   * source the user just referenced is being parsed, and a reference has no other way to be
   * asked about — it is not in the conversation's list until the turn that links it is sent.
   */
  getSource: (id: string) => request<Source>(`/sources/${id}`),
  /**
   * Delete a file. The server hides it — from every list, from the model's whitelist, from
   * `/raw` — and keeps the bytes, the extracted text and its links, so re-uploading the same
   * content brings it back with its history rather than as a new file.
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
  // Same session-ended short-circuit and one refresh as `send`: an image attached in a
  // conversation a kick has ended must take the reader to the login screen like any other
  // request, rather than failing quietly behind it.
  if (sessionEnded) throw sessionEndedError();
  const fetchBytes = () => fetch(`/api/sources/${sourceId}/raw`, { headers: authHeaders() });
  let res = await fetchBytes();
  if (res.status === 401) {
    const outcome = await recoverFrom401(true, true);
    if (outcome === "refreshed") res = await fetchBytes();
  }
  if (!res.ok) throw toApiError(await errorBody(res), res.status);
  return URL.createObjectURL(await res.blob());
}

/**
 * A viewable file's extension → the type the viewer is told it is.
 *
 * A **hint, not a gate.** Some of the library's plugins sniff the bytes themselves, and the
 * ones that read this use it to pick a renderer rather than to decide whether there is one —
 * `isPreviewSupported` is what answers that, and it is the authority. Kept short for that
 * reason: an entry missing costs a plugin that falls back to sniffing, and an entry wrong
 * would be worse than an entry absent.
 *
 * Only the formats the *server* calls `binary` can arrive here. A `.svg` or a `.csv` is valid
 * UTF-8 and classifies as `text`, so it never reaches the viewer at all and has no entry.
 */
const VIEWER_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  tiff: "image/tiff",
  avif: "image/avif",
  heic: "image/heic",
  pdf: "application/pdf",
  epub: "application/epub+zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  doc: "application/msword",
  xls: "application/vnd.ms-excel",
  ppt: "application/vnd.ms-powerpoint",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  rtf: "application/rtf",
  zip: "application/zip",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  eml: "message/rfc822",
};

/** The type to build a viewable file's `File` with; `octet-stream` when the name is unknown. */
export function mimeForName(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "application/octet-stream";
  return VIEWER_MIME_TYPES[name.slice(dot + 1).toLowerCase()] ?? "application/octet-stream";
}

/**
 * A file's bytes as a `File`, fetched with the bearer token.
 *
 * Fetched rather than pointed at, for `sourceImageUrl`'s reason: a bearer token cannot ride on
 * a `<video src>`, so the raw route is not something a browser will load on the page's behalf.
 *
 * A `File` rather than an object URL, and that is the difference from `sourceImageUrl`: that
 * one hands back a URL for an `<img src>` and makes the caller responsible for revoking it,
 * while the viewer takes a `File` — which carries the name, the type and the bytes together
 * and has no lifetime to manage. Nothing to revoke means nothing to leak.
 *
 * **The caller passes a URL with `/api` on it**, unlike every path in the `api` object above.
 * Those are `/api`-relative because `request()` adds the prefix; this function is a bare
 * `fetch`, so it has to carry its own. Getting that wrong is not a 404 — the dev server answers
 * an unknown path with `index.html` at 200, so the viewer would be handed a few kilobytes of
 * HTML to render as a PNG, and the only symptom is a picture that will not decode.
 */
async function fetchRawFile(url: string, name: string): Promise<File> {
  // The same session-ended short-circuit and single refresh as `send`: a preview opened after
  // a kick has ended must reach the login screen like any other request rather than failing
  // behind it.
  if (sessionEnded) throw sessionEndedError();
  const fetchBytes = () => fetch(url, { headers: authHeaders() });
  let res = await fetchBytes();
  if (res.status === 401) {
    const outcome = await recoverFrom401(true, true);
    if (outcome === "refreshed") res = await fetchBytes();
  }
  if (!res.ok) throw toApiError(await errorBody(res), res.status);
  return new File([await res.blob()], name, { type: mimeForName(name) });
}

/** Read a File as bare base64 (no `data:` prefix), matching `UploadAttachmentInput`. */
/**
 * What the source list may be narrowed by, as the wire spells it.
 *
 * Every field optional and independent; an empty string is treated as absent, which is what a
 * cleared `<select>` produces and what "no filter" means.
 */
export interface SourceFilterQuery {
  storage?: string;
  category?: string;
  origin?: string;
  mime?: string;
  name?: string;
  workspaceId?: string;
  sessionId?: string;
}

/** The query string for a filter, with the empty keys left out. */
function queryOf(filter: SourceFilterQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (value) params.set(key, value);
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

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
  // Same short-circuit as `send`: a turn sent after a kick fails locally, without paying for
  // a request the gate will refuse and without the console errors that report nothing new.
  if (sessionEnded) throw sessionEndedError();
  const res = await fetch(`/api${path}`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (res.status === 401) {
    const outcome = await recoverFrom401(mayRefresh, true);
    if (outcome === "refreshed") {
      yield* streamPost(path, body, false);
      return;
    }
    // Same rule as `send`, including the distinction: a turn that 401s and cannot be refreshed
    // means the session went away mid-conversation, and the user has to be sent back to the
    // login screen rather than left with an error about a message they cannot send. An
    // unreachable refresh is not that, and ends as a failed turn with the token still held.
    throw toApiError(await errorBody(res), res.status);
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

/**
 * Ask for the last reply again. No body: everything the turn needs — the user message it
 * answers, its attachments — is already persisted, and the server reads it from there rather
 * than trusting a client to hand back what it last saw.
 *
 * Consumed by the same loop as the other two. It carries one event they never send,
 * `message_removed`, naming the reply the server just dropped.
 */
export function streamRegenerate(sessionId: string): AsyncGenerator<ChatStreamEvent> {
  return streamPost(`/sessions/${sessionId}/regenerate`, {});
}
