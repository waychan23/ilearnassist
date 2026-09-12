/**
 * Shared API + domain types used by both the server and the Vue frontend.
 * Kept dependency-free so either side can import it without pulling in runtime deps.
 */

export type Role = "user" | "assistant";

/* ------------------------------------ ask_user ------------------------------------ */

/**
 * The tool's name.
 *
 * Shared rather than declared on the server, because the *client* switches on it: it is
 * what picks the answerable card out of an assistant message's tool calls. A second
 * literal on the web side is a card that silently stops rendering the day the name moves.
 */
export const ASK_USER_TOOL_NAME = "ask_user";

/** One choice the model offers, plus the sentence explaining what picking it means. */
export interface AskUserOption {
  label: string;
  description?: string;
}

/**
 * One question, as the model asked it. Persisted verbatim in the tool call's `input`,
 * which is what lets the card be re-rendered from history months later.
 *
 * There is deliberately **no `id`**: questions are an ordered array and the answers are
 * keyed by position. An id the model has to invent is an id it can duplicate or forget,
 * and neither failure buys anything — the model reads the full question text back.
 */
export interface AskUserQuestion {
  /** The tab label. Short on purpose — the card is a strip of tabs, not a paragraph. */
  header: string;
  question: string;
  /** Absent means single-select. */
  multiSelect?: boolean;
  /** How many the model offered. The client appends its own "other" choice on top. */
  options: AskUserOption[];
}

/**
 * Where an `ask_user` call stands.
 *
 * `awaiting`  — the turn is suspended here; the card is live and answerable.
 * `answered`  — the user submitted; `output` and `answer` are both present.
 * `skipped`   — the user sent a new message instead of answering, so this was retired
 *               without an answer and deliberately **without** an `output`, which is what
 *               keeps it out of the model's history.
 * `dismissed` — the user pressed cancel. Also answerless, but a decision rather than a
 *               drift, and worded differently in the UI.
 */
export type AskUserStatus = "awaiting" | "answered" | "skipped" | "dismissed";

/**
 * One question's answer.
 *
 * `selected` holds labels the model offered; `other` holds free text the user typed under
 * the client-added "other" choice. They are separate fields rather than one list because
 * only `selected` can be validated against what was offered.
 */
export interface AskUserAnswer {
  selected: string[];
  other?: string;
}

/** Answers keyed by the question's index in the `ask_user` call, as a string ("0"…"3"). */
export type AskUserAnswers = Record<string, AskUserAnswer>;

/** What the client POSTs back to `/api/sessions/:id/answers`. */
export interface AnswerToolCallInput {
  toolCallId: string;
  action: "submit" | "cancel";
  /** Required (and complete) when `action` is `submit`. */
  answers?: AskUserAnswers;
}

/**
 * Limits, exported as values rather than baked into the zod schema alone so the web
 * catalog's tests and the card's rendering can read the same numbers.
 */
export const ASK_USER_MAX_QUESTIONS = 4;
export const ASK_USER_MIN_OPTIONS = 2;
export const ASK_USER_MAX_OPTIONS = 4;
/** Advisory for the tab label; the schema rejects longer rather than truncating. */
export const ASK_USER_HEADER_MAX = 12;
/** Cap on a free-text "other" answer, so one reply cannot dwarf the context. */
export const ASK_USER_OTHER_MAX = 500;

/** A single tool invocation recorded on an assistant message (for rendering + history). */
export interface ToolCall {
  id: string;
  name: string;
  /** JSON-serialized tool arguments. */
  input: string;
  /** Tool result returned to the model (present once the call completes). */
  output?: string;
  /**
   * `ask_user` only, and absent on every other tool. Set to `awaiting` when the turn
   * suspends on this call, so the UI knows to offer the controls rather than report a
   * tool that is merely slow.
   */
  status?: AskUserStatus;
  /**
   * `ask_user` only: the user's answer in structured form.
   *
   * A second copy of something `output` also carries, which is deliberate — `output` is
   * the model's copy (a rendering that may be reworded), this is the UI's, and neither
   * can be derived from the other without the card parsing prose.
   */
  answer?: AskUserAnswers;
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

/**
 * Failure taxonomy for document text extraction.
 *
 * Lives here rather than beside the server's `ParseError` because the *client* turns it
 * into words: the server no longer owns the wording, so the code has to cross the wire.
 * `apps/server/src/documents/errors.ts` re-exports it, so server imports are unchanged.
 *
 * These codes carry more than messaging — the parse policy uses them to decide whether a
 * failure is worth retrying on the other tier (local ⇄ cloud).
 */
export const PARSE_ERROR_CODES = [
  "password_protected",
  "no_text_layer",
  "too_large",
  "unsupported_type",
  "corrupt",
  "missing_file",
  "no_cloud_parser",
  "local_disabled",
  "cloud_auth",
  "cloud_failed",
  "timeout",
  "cancelled",
] as const;

/**
 * Declared as a runtime list so the web catalog test can iterate it and prove every code
 * has a message in every locale — a type alone would be erased by the time tests run.
 */
export type ParseErrorCode = (typeof PARSE_ERROR_CODES)[number];

/**
 * Machine codes for the server's curated error replies.
 *
 * Every one of these has an `errors.<CODE>` message in each web catalog, and the catalog
 * test iterates this union to prove it — which is why it is a union and not bare strings.
 */
export const API_ERROR_CODES = [
  "NAME_REQUIRED",
  "WORKSPACE_NOT_FOUND",
  "COPILOT_NOT_FOUND",
  "SESSION_NOT_FOUND",
  "TITLE_EMPTY",
  "UNSUPPORTED_FILE_TYPE",
  "INVALID_ATTACHMENT_PATH",
  "ATTACHMENT_NOT_FOUND",
  "ATTACHMENT_STORE_FAILED",
  "DATA_REQUIRED",
  "INVALID_BASE64",
  "EMPTY_FILE",
  "FILE_TOO_LARGE",
  "PROVIDER_NOT_FOUND",
  "MODEL_NOT_FOUND",
  "MODEL_ID_REQUIRED",
  "BASE_URL_REQUIRED",
  "ONLY_PROVIDER",
  "DEFAULT_PROVIDER",
  "PARSER_NOT_FOUND",
  "UNKNOWN_PARSER_KIND",
  "UNKNOWN_POLICY",
  "UNKNOWN_PARSER",
  "UNKNOWN_PROVIDER",
  "MESSAGE_REQUIRED",
  "QUESTION_NOT_PENDING",
  "INVALID_ANSWER",
  "FILE_NOT_FOUND",
  "INVALID_FILE_PATH",
  "NOT_A_DIRECTORY",
  "NOT_A_FILE",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/**
 * The error envelope every curated reply carries.
 *
 * `code` is canonical — the client renders it in the user's language. `message` is the
 * server's own sentence, kept as the fallback for a code this build does not know yet
 * (an older client against a newer server). `params` carries whatever the client needs to
 * interpolate, so it can build the sentence itself rather than receiving one.
 *
 * Fastify's own errors do not use this shape and stay `{ message }`; the client handles
 * both. See `apps/web/src/utils/apiError.ts`.
 */
export interface ApiErrorBody {
  error: {
    code: ApiErrorCode | ParseErrorCode;
    message: string;
    params?: Record<string, string | number>;
  };
}

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
  /**
   * The machine code behind `parseError`, so the client can say it in the user's language.
   * Absent on rows written before i18n existed — the client falls back to `parseError`.
   */
  parseErrorCode?: ParseErrorCode;
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
  /**
   * How many conversations the workspace holds, and when the most recent one was last
   * touched — the two numbers the workspace cards are built from.
   *
   * Derived rather than stored, and carried on the workspace rather than fetched per card:
   * a management page that has to ask once per workspace is a page that gets slower with
   * every one the user creates. `lastActivityAt` is null for a workspace nobody has talked
   * to yet, which is why it is not simply the creation date.
   */
  sessionCount: number;
  lastActivityAt: string | null;
}

/**
 * One entry in a workspace directory listing.
 *
 * `path` is workspace-relative and always `/`-separated, whatever the host platform uses —
 * it is the key the client caches a directory's children under and the value it sends back
 * as `?path=`, so it has to mean the same thing on both sides of the wire. `name` is the
 * basename, which is all a row renders.
 *
 * `size` and `modifiedAt` are null for directories: a directory has no meaningful size, and
 * a listing that stat'ed every child to invent one would be slower for a number no row shows.
 */
export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "dir";
  size: number | null;
  modifiedAt: string | null;
}

/** One directory level. Children are fetched per level, so this is always a single layer. */
export interface DirectoryListing {
  /** The directory listed, workspace-relative — `""` for the workspace root. */
  path: string;
  entries: FileEntry[];
  /**
   * True when the directory held more entries than the server will return in one reply.
   *
   * Reported rather than silently dropped: a listing that quietly stops at the cap reads as
   * "this directory has 200 files" to anyone looking at it.
   */
  truncated: boolean;
}

/**
 * What the server could make of a file's bytes, and therefore what the client can render.
 *
 * A union rather than a boolean because the next formats are already planned — an image or
 * a PDF is a new member plus a branch, not a second endpoint and a rewrite. The client
 * switches exhaustively, so adding one is a compile error at every site that must handle it.
 */
export const FILE_CONTENT_KINDS = ["text", "markdown", "unsupported"] as const;
export type FileContentKind = (typeof FILE_CONTENT_KINDS)[number];

/**
 * A file's metadata, plus its text when the server decided there was any to send.
 *
 * `text` is null for `unsupported` on purpose — the bytes are never read past the sniff in
 * that case, so there is nothing to send and no way for a caller to render a binary as
 * mojibake. `truncated` says the file is longer than the preview cap, which the UI states
 * outright rather than letting a file look like it ends there.
 */
export interface FileContent {
  path: string;
  name: string;
  size: number;
  modifiedAt: string;
  kind: FileContentKind;
  text: string | null;
  truncated: boolean;
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

export interface UpdateWorkspaceInput {
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
  /** See `Attachment.parseErrorCode` — the streaming path needs it as much as the reload one. */
  parseErrorCode?: ParseErrorCode;
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
