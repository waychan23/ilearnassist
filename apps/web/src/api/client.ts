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
  DocumentParserConfig,
  DocumentParsingConfig,
  DriverInfo,
  AttachmentParseRecord,
  Message,
  ProviderConfig,
  PublicConfig,
  Session,
  UpdateCopilotInput,
  UpdateDocumentParserInput,
  UpdateDocumentParsingInput,
  UpdateProviderInput,
  UpdateSessionInput,
  UploadAttachmentInput,
  Workspace,
} from "@guided-learning/shared";
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Only send a JSON content-type when there is actually a body. Fastify (5.x)
  // rejects body-less requests that claim `application/json` with a 400
  // (FST_ERR_CTP_EMPTY_JSON_BODY), which broke DELETE calls.
  const options: RequestInit = { ...init };
  if (options.body !== undefined && options.headers === undefined) {
    options.headers = { "Content-Type": "application/json" };
  }

  const res = await fetch(`/api${path}`, options);
  if (!res.ok) throw toApiError(await errorBody(res), res.status);
  return res.json() as Promise<T>;
}

export const api = {
  getConfig: () => request<PublicConfig>("/config"),

  listWorkspaces: () => request<Workspace[]>("/workspaces"),
  createWorkspace: (name: string) =>
    request<Workspace>("/workspaces", { method: "POST", body: JSON.stringify({ name }) }),
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

  uploadAttachment: (sessionId: string, input: UploadAttachmentInput) =>
    request<Attachment>(`/sessions/${sessionId}/attachments`, {
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

  /** Parse state for every attachment in a session, keyed by attachment id. */
  listAttachmentStatus: (sessionId: string) =>
    request<Record<string, AttachmentParseRecord>>(`/sessions/${sessionId}/attachments`),
  reparseAttachment: (sessionId: string, attachmentId: string, name?: string) =>
    request<{ status: string }>(`/sessions/${sessionId}/attachments/${attachmentId}/reparse`, {
      method: "POST",
      body: JSON.stringify(name ? { name } : {}),
    }),
};

/** URL for an attachment's bytes (used as an `<img src>`), not an API call. */
export function attachmentUrl(sessionId: string, attachmentId: string): string {
  return `/api/sessions/${sessionId}/attachments/${attachmentId}`;
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
