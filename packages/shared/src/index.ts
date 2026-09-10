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

/** A file the user attached to a message. Bytes live on the server, never in this object. */
export interface Attachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  /** `image` attachments are sent to the model as multimodal content. */
  kind: "image" | "file";
}

/**
 * Token accounting for one assistant turn.
 *
 * `input`/`output`/`total` are summed across every ReAct step, so they reflect what was
 * actually billed. `contextTokens` is the final step's input+output instead — i.e. how
 * large the conversation had grown by the end of the turn — which is what a
 * context-window indicator needs (the summed figure would overstate it).
 */
export interface MessageUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedInputTokens?: number;
  contextTokens?: number;
}

export interface Message {
  id: string;
  sessionId: string;
  role: Role;
  content: string;
  /**
   * The model's chain of thought, when the provider exposes one (`reasoning_content`
   * on DeepSeek, `reasoning` on OpenRouter, reasoning content blocks elsewhere).
   *
   * Shown in the UI but **never** replayed into history: providers either ignore it or
   * reject it outright, so it is display-only.
   */
  reasoning?: string;
  toolCalls?: ToolCall[];
  attachments?: Attachment[];
  usage?: MessageUsage;
  createdAt: string;
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  dirPath: string;
  createdAt: string;
}

/** What a model can do — drives vision handling and UI badges. */
export type ModelCapability = "vision" | "reasoning" | "tool_use";

export interface ProviderModel {
  /** Stable record id, used when editing/deleting this model. */
  id: string;
  /** The identifier sent to the provider's API, e.g. "gpt-4o-mini". */
  modelId: string;
  /** Human-readable label. */
  name: string;
  /** Total context window, in **tokens** (e.g. 128000). Used for the usage indicator. */
  contextWindow?: number | null;
  /** Maximum output per reply, in **tokens**. */
  maxOutput?: number | null;
  capabilities: ModelCapability[];
}

/**
 * Per-conversation generation parameters. Stored on the session; a Copilot supplies
 * the defaults that get copied in when the conversation is created.
 * `null`/absent means "inherit from the next level up".
 */
export interface SessionSettings {
  providerId?: string | null;
  modelId?: string | null;
  /** Sampling temperature, typically **0–2**. Higher is more random. */
  temperature?: number | null;
  /** Nucleus sampling, **0–1**. Normally tuned instead of `temperature`, not alongside it. */
  topP?: number | null;
  /** Cap on a single reply, in **tokens**. */
  maxTokens?: number | null;
  /** How many prior history messages to replay into the model context, in **messages**. */
  maxContextMessages?: number | null;
  /** Maximum ReAct steps (tool rounds) for a single turn. */
  maxSteps?: number | null;
}

/** A Copilot's default settings, copied onto a session at creation time. */
export type CopilotDefaults = SessionSettings;

export interface Copilot {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  /** Tool names this copilot is allowed to use (empty = all available). */
  tools: string[];
  /** Defaults handed to new conversations started with this copilot. */
  settings: CopilotDefaults;
  createdAt: string;
  updatedAt: string;
}

/**
 * Where a conversation's title came from. `auto` means a model wrote it after the first
 * turn and may rewrite it; `user` means a person typed it and it must never be touched.
 */
export type TitleSource = "auto" | "user";

export interface Session {
  id: string;
  workspaceId: string;
  copilotId: string | null;
  title: string;
  titleSource: TitleSource;
  settings: SessionSettings;
  createdAt: string;
  updatedAt: string;
}

/** Provider metadata exposed to the client (never includes the apiKey). */
export interface ProviderConfig {
  id: string;
  name: string;
  baseURL: string;
  models: ProviderModel[];
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
  tools?: string[];
  settings?: CopilotDefaults;
}

export interface UpdateCopilotInput extends CreateCopilotInput {}

export interface CreateSessionInput {
  title?: string;
  copilotId?: string | null;
}

export interface UpdateSessionInput {
  title?: string;
  settings?: SessionSettings;
}

/** Payload for `POST /api/sessions/:id/attachments` (base64 keeps us dependency-free). */
export interface UploadAttachmentInput {
  name: string;
  mimeType: string;
  /** Base64-encoded file bytes (no data-URL prefix). */
  data: string;
}

export interface ProviderModelInput {
  /** Omit to create a new model record. */
  id?: string;
  modelId: string;
  name?: string;
  contextWindow?: number | null;
  maxOutput?: number | null;
  capabilities?: ModelCapability[];
}

export interface CreateProviderInput {
  name: string;
  baseURL: string;
  apiKey?: string;
  models?: ProviderModelInput[];
}

export interface UpdateProviderInput {
  name?: string;
  baseURL?: string;
  /** Omit (or leave empty) to keep the stored key unchanged. */
  apiKey?: string;
  models?: ProviderModelInput[];
}

export interface ChatInput {
  message: string;
  provider?: string;
  model?: string;
  copilotId?: string | null;
  /** Attachments previously uploaded for this session (metadata only, no bytes). */
  attachments?: Attachment[];
}

/* ---------------------------------- Chat stream events -------------------------------- */

export type ChatStreamEvent =
  | { type: "meta"; sessionId: string }
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_start"; toolCall: Omit<ToolCall, "output"> }
  | { type: "tool_end"; toolCall: ToolCall }
  | { type: "usage"; usage: MessageUsage }
  | { type: "message_done"; message: Message }
  /** Sent after the first turn when a model-written title replaced the placeholder. */
  | { type: "title"; sessionId: string; title: string }
  | { type: "error"; message: string }
  | { type: "done" };

/* ------------------------------------ constants ------------------------------------ */

/** Uploads are capped at 10 MB per file (also enforced server-side). */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * Fallback context window when a model has none configured. Used only for the
 * context-usage indicator, so a rough value is acceptable.
 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;
