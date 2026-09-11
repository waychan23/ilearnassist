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

/**
 * How far a document attachment has got through text extraction.
 *
 * `none`    — not a document (images, text files), or a message persisted before this
 *             feature existed. Everything downstream treats it as "no text expected".
 * `pending` — queued; `parsing` — a parser is running right now.
 * `ready`   — extracted text is on disk and will be injected into the prompt.
 * `failed`  — extraction gave up; `parseError` says why. The bytes are still attached.
 * `skipped` — deliberately not parsed (the file is too large, or parsing is disabled).
 */
export type ParseStatus = "none" | "pending" | "parsing" | "ready" | "failed" | "skipped";

/** A file the user attached to a message. Bytes live on the server, never in this object. */
export interface Attachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  /** `image` attachments are sent to the model as multimodal content. */
  kind: "image" | "file";
  /**
   * Parse state for document attachments. Absent on images, on text-like files (which are
   * inlined verbatim) and on rows persisted before this feature existed.
   */
  parseStatus?: ParseStatus;
  /** Why parsing failed, in words a user can act on. Never contains a credential. */
  parseError?: string;
  /** Which backend produced the text: `"local"`, or a configured parser's record id. */
  parserId?: string;
  /** Length of the extracted text in characters. */
  parsedChars?: number;
  /** Page count, when the parser could determine one (PDF and most cloud parsers). */
  pageCount?: number;
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

/**
 * Which wire protocol a document parser speaks. A closed set — each value is a driver
 * the server implements — while the *instances* are user-managed records, so two
 * `mineru` entries (hosted + self-hosted) are two records of the same kind.
 *
 * `sync` is the fully generic one: POST the bytes, get Markdown back. It covers any
 * service that extracts text in a single round trip (`docling-serve`, Marker, a
 * self-hosted MinerU). The other two are the async vendor protocols, which differ in
 * how the job is submitted and how the result is shaped — a difference no amount of
 * path templating bridges, hence a driver each.
 */
export type DocumentParserKind = "sync" | "mineru" | "llamaparse";

/** A configured document-parsing backend, as exposed to the client (never the apiKey). */
export interface DocumentParserConfig {
  id: string;
  name: string;
  kind: DocumentParserKind;
  baseURL: string;
  enabled: boolean;
  hasApiKey: boolean;
}

/**
 * When to use local extraction versus a cloud parser.
 *
 * `local-only`   — never call out.
 * `local-first`  — local, then fall back to cloud on a recoverable failure.
 * `cloud-first`  — cloud, then fall back to local.
 * `cloud-only`   — always call out.
 *
 * `fallbackEnabled: false` removes the second step from the two hybrid policies, so a
 * failure surfaces instead of being retried elsewhere.
 */
export type DocumentParsePolicy = "local-only" | "local-first" | "cloud-first" | "cloud-only";

export interface DocumentParsingConfig {
  localEnabled: boolean;
  policy: DocumentParsePolicy;
  fallbackEnabled: boolean;
  /** Pinned parser record id. `null` means "try every enabled parser in order". */
  defaultParserId: string | null;
}

export interface PublicConfig {
  defaultProvider: string;
  defaultModel: string;
  providers: ProviderConfig[];
  workspacesRootDir: string;
  webSearchProvider: string;
  documentParsers: DocumentParserConfig[];
  documentParsing: DocumentParsingConfig;
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

/**
 * A protocol the server can speak, as advertised by `GET /api/document-parsers/kinds`.
 * The settings form builds its "add a parser" UI from this rather than hard-coding the list.
 */
export interface DriverInfo {
  kind: DocumentParserKind;
  label: string;
  requiresApiKey: boolean;
  defaultBaseURL?: string;
  /** Where to send a user who needs a credential. */
  helpURL?: string;
}

/** Extraction state of one attachment, keyed by attachment id in the session status map. */
export interface AttachmentParseRecord {
  status: ParseStatus;
  error?: string;
  parserId?: string;
  parsedChars?: number;
  pageCount?: number;
  updatedAt: string;
}

export interface CreateDocumentParserInput {
  name: string;
  kind: DocumentParserKind;
  baseURL: string;
  apiKey?: string;
  enabled?: boolean;
}

export interface UpdateDocumentParserInput {
  name?: string;
  kind?: DocumentParserKind;
  baseURL?: string;
  /** Omit (or leave empty) to keep the stored key unchanged. */
  apiKey?: string;
  enabled?: boolean;
}

export interface UpdateDocumentParsingInput {
  localEnabled?: boolean;
  policy?: DocumentParsePolicy;
  fallbackEnabled?: boolean;
  defaultParserId?: string | null;
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
