/**
 * Shared API + domain types used by both the server and the Vue frontend.
 * Kept dependency-free so either side can import it without pulling in runtime deps.
 */

export type Role = "user" | "assistant";

/** A single tool invocation recorded on an assistant message (for rendering + history). */
export interface ToolCall {
  id: string;
  name: string;
  /** JSON-serialized tool arguments. */
  input: string;
  /** Tool result returned to the model (present once the call completes). */
  output?: string;
}

export interface Message {
  id: string;
  sessionId: string;
  role: Role;
  content: string;
  toolCalls?: ToolCall[];
  createdAt: string;
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  dirPath: string;
  createdAt: string;
}

export interface Copilot {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  /** Optional explicit model id overriding the default; null = use default. */
  model: string | null;
  /** Tool names this copilot is allowed to use (empty = all available). */
  tools: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Session {
  id: string;
  workspaceId: string;
  copilotId: string | null;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ModelOption {
  id: string;
  name: string;
}

/** Provider metadata exposed to the client (never includes the apiKey). */
export interface ProviderConfig {
  id: string;
  name: string;
  baseURL: string;
  models: ModelOption[];
  hasApiKey: boolean;
}

export interface PublicConfig {
  defaultProvider: string;
  defaultModel: string;
  providers: ProviderConfig[];
  workspacesRootDir: string;
  webSearchProvider: string;
}

/* ----------------------------------- API payloads ----------------------------------- */

export interface CreateWorkspaceInput {
  name: string;
}

export interface CreateCopilotInput {
  name: string;
  description?: string;
  systemPrompt: string;
  model?: string | null;
  tools?: string[];
}

export interface UpdateCopilotInput extends CreateCopilotInput {}

export interface CreateSessionInput {
  title?: string;
  copilotId?: string | null;
}

export interface ChatInput {
  message: string;
  provider?: string;
  model?: string;
  copilotId?: string | null;
}

/* ---------------------------------- Chat stream events -------------------------------- */

export type ChatStreamEvent =
  | { type: "meta"; sessionId: string }
  | { type: "text"; delta: string }
  | { type: "tool_start"; toolCall: Omit<ToolCall, "output"> }
  | { type: "tool_end"; toolCall: ToolCall }
  | { type: "message_done"; message: Message }
  | { type: "error"; message: string }
  | { type: "done" };