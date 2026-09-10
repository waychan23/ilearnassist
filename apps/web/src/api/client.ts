import type {
  ChatInput,
  ChatStreamEvent,
  Copilot,
  CreateCopilotInput,
  CreateSessionInput,
  Message,
  PublicConfig,
  Session,
  UpdateCopilotInput,
  Workspace,
} from "@guided-learning/shared";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Only send a JSON content-type when there is actually a body. Fastify (5.x)
  // rejects body-less requests that claim `application/json` with a 400
  // (FST_ERR_CTP_EMPTY_JSON_BODY), which broke DELETE calls.
  const options: RequestInit = { ...init };
  if (options.body !== undefined && options.headers === undefined) {
    options.headers = { "Content-Type": "application/json" };
  }

  const res = await fetch(`/api${path}`, options);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
    };
    // Fastify errors carry a specific `message` and a generic `error`
    // ("Bad Request"); our own routes return `{ error }`. Prefer specific.
    throw new Error(body.message ?? body.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  getConfig: () => request<PublicConfig>("/config"),

  listWorkspaces: () => request<Workspace[]>("/workspaces"),
  createWorkspace: (name: string) =>
    request<Workspace>("/workspaces", { method: "POST", body: JSON.stringify({ name }) }),
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
  deleteSession: (id: string) =>
    request<{ ok: boolean }>(`/sessions/${id}`, { method: "DELETE" }),

  listMessages: (sessionId: string) => request<Message[]>(`/sessions/${sessionId}/messages`),
};

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

/** Stream the agent's chat response for a session. */
export async function* streamChat(
  sessionId: string,
  input: ChatInput
): AsyncGenerator<ChatStreamEvent> {
  const res = await fetch(`/api/sessions/${sessionId}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Chat failed (${res.status})`);
  }
  yield* sseEvents(res);
}