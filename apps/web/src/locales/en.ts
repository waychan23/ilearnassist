import type MessageSchema from "./zh-CN";

/**
 * English — the fallback locale, and the language a visitor gets when their browser asks
 * for something we do not ship.
 *
 * Typed as the zh-CN schema, so `pnpm typecheck` fails on a missing *or* extra key here.
 * That is the first of two nets; `test/i18n/catalog.test.ts` is the second, and the one
 * that catches an untranslated copy-paste (a Chinese string left in this file).
 *
 * Plural messages use `|`; the zh-CN originals do not. Both catalogs are called the same
 * way — `t(key, count, { …params })` — so no component ever branches on the locale.
 */
const en: typeof MessageSchema = {
  common: {
    confirmTitle: "Confirm",
    confirm: "Confirm",
    cancel: "Cancel",
    create: "Create",
    delete: "Delete",
    name: "Name",
    copied: "Copied",
    copy: "Copy",
    save: "Save",
    close: "Close",
    edit: "Edit",
    rename: "Rename",
    settings: "Settings",
  },

  app: {
    title: "guided-learning",
    configBanner: {
      before: "No API key is configured yet. Click",
      action: "Settings → Providers",
      after: "in the top right to add a Provider and its key; it takes effect as soon as you save.",
    },
  },

  // Autonyms: intentionally identical to the zh-CN catalog. See the note there.
  locale: {
    switchLabel: "Language",
    zhCN: "中文",
    en: "English",
  },

  theme: {
    light: "Light",
    dark: "Dark",
    auto: "Auto",
    autoCurrent: "Auto (currently {current})",
    toggleTitle: "Theme: {label} (click to switch)",
  },

  chat: {
    titleHint: "Titles are generated automatically and stop updating once you edit them",
    titlePlaceholder: "Conversation title",
    editTitleHint: "Click to edit the title",
    editTitle: "Edit title",
    autoBadgeTitle: "Titles are generated from the first turn of the conversation",
    start: "Start a conversation",
    startHint: "Type a message below; the agent will call tools as it needs them.",
    backToWorkspaces: "Back to workspaces",
    startAction: "New conversation (choose a Copilot)",
  },

  composer: {
    parsing: "Attachments are still being parsed; sending unlocks when they finish…",
    parseFailed:
      "1 attachment could not be parsed, so the model will not be able to read it. Use the retry button on the attachment, or configure a cloud parser under Settings → Document parsing. | {count} attachments could not be parsed, so the model will not be able to read them. Use the retry button on an attachment, or configure a cloud parser under Settings → Document parsing.",
    visionWarning:
      "The current model “{model}” is not marked as accepting image input, so images will be sent as text placeholders. Tick “Image input” for it under Settings → Providers.",
    placeholder: "Type a message — Enter to send, Shift+Enter for a new line",
    thinking: "The agent is thinking…",
    parsingShort: "Parsing attachments…",
    send: "Send (Enter)",
    attach: "Add an image or file",
    settings: "Session parameters (temperature, context length, tool steps…)",
  },

  attachments: {
    parsing: "Parsing…",
    parsingTitle: "Extracting text — sending unlocks when it finishes",
    ready: "Parsed",
    readyTitle: "Parsed; the contents will be sent with the message",
    failed: "Parsing failed",
    chars: "1 character | {count} characters",
    charsK: "{count}k characters",
    pages: "1 page | {count} pages",
    cloud: "cloud",
    reparse: "Parse again",
    remove: "Remove",
    tooLarge: "“{name}” exceeds the {limitMb} MB limit",
  },

  minimap: {
    image: "[image]",
    file: "[file: {name}]",
    empty: "(no text content)",
    jumpTo: "Jump to turn {n}",
  },

  sidebar: {
    allWorkspaces: "All workspaces",
    sessions: "Conversations",
    newSession: "New conversation",
    renameHint: "Double-click to rename",
    noSessions: "No conversations yet",
    openNav: "Open navigation",
  },

  session: {
    fallbackTitle: "New conversation",
    new: {
      title: "New conversation",
      titleLabel: "Title (optional)",
      titlePlaceholder: "Leave blank for “{fallback}”",
      noCopilot: "No Copilot",
      noCopilotDesc: "Uses the built-in general-purpose assistant and default parameters.",
      noCopilots: "No Copilots yet. Create one under Settings → Copilots.",
    },
    // 「」 is a Chinese quoting convention; English gets curly quotes.
    delete: {
      title: "Delete conversation",
      message: "Delete “{name}”?",
      detail: "All of its messages will be deleted too. This cannot be undone.",
    },
  },

  workspace: {
    new: {
      title: "New workspace",
      namePlaceholder: "e.g. My Project",
      hint: "A matching subdirectory will be created under the workspaces root.",
    },
    delete: {
      title: "Delete workspace",
      message: "Delete “{name}”?",
      detail: "The directory {path} and every file in it will be deleted. This cannot be undone.",
    },

    home: {
      title: "Choose a workspace",
      subtitle: "The agent reads and writes files only inside the workspace you pick.",
      newCard: "New workspace",
      empty: "No workspaces yet",
      emptyHint: "Create one and the agent will read and write files inside it.",
      open: "Open workspace {name}",
      sessions: "1 conversation | {count} conversations",
      activity: {
        never: "No activity yet",
        now: "just now",
        minutes: "1 minute ago | {count} minutes ago",
        hours: "1 hour ago | {count} hours ago",
        days: "1 day ago | {count} days ago",
      },
    },
  },

  tools: {
    name: {
      web_search: "Web search",
      web_fetch: "Read a web page",
      list_files: "List files",
      read_file: "Read a file",
      write_file: "Write a file",
      create_directory: "Create a directory",
      delete_file: "Delete a file",
      read_document: "Read a document",
    },
    done: "Done",
    running: "Running",
    args: "Arguments",
    result: "Result",
  },

  message: {
    copyReply: "Copy the reply",
    contextTokens: "Context this turn: {count} tokens",
    usage: {
      input: "In",
      output: "Out",
      total: "Total",
      cached: "Cached",
    },
    reasoning: {
      thinking: "Thinking",
      done: "Thought process",
      duration: "took {duration}",
      copy: "Copy the reasoning",
    },
  },

  tokens: {
    used: "Context used",
    pending: "Pending input (estimated)",
    projected: "Projected total",
    estimatedLimit: "Estimated limit",
    limitHint: "This model has no configured context length, so a default estimate is used",
    messages: "Context messages",
    maxSteps: "Max tool steps",
    note: "“Context used” comes from last turn's token counts; “pending input” is estimated from character count and is a preview only.",
  },

  copilot: {
    edit: "Edit Copilot",
    create: "New Copilot",
    namePlaceholder: "e.g. Code assistant",
    description: "Description",
    descriptionPlaceholder: "One line on what it is for",
    systemPrompt: "System prompt",
    systemPromptPlaceholder: "Define this Copilot's role, abilities and behavioural constraints…",
    systemPromptHint: "Leave blank to use the built-in general-purpose assistant.",
    tools: "Available tools (blank = all of them)",
    defaults: "Defaults (copied into a new conversation; adjustable there afterwards)",
    inherit: "Inherit default",
    model: "Model",
    maxOutput: "Max output",
    unitToken: "in tokens",
    maxHistory: "History messages to carry",
    all: "All",
    unitMessages: "messages",
    maxSteps: "Max tool steps",
    unitSteps: "steps",
  },


  settings: {
    title: "Settings",
    tabs: {
      providers: "Providers / models",
      documents: "Document parsing",
      copilot: "Defaults & tools",
    },
    providers: {
      countConfigured: "{count} provider configured | {count} providers configured",
      add: "New provider",
      default: "Default",
      keySet: "Key configured",
      keyMissing: "No key",
      deleteModel: "Delete this model",
      noModels: "No models configured",
      empty: "No providers yet. Click “New provider” to add an OpenAI-compatible endpoint.",
      visionHint: "Accepts image input",
      reasoningHint: "Reasoning model",
      noteBefore: "Providers and models live in the database, so changes take effect",
      noteLive: "immediately",
      noteBetween: " with no restart.",
      noteConfigFile: "config.yaml",
      noteAfter: " is only the initial seed. API keys are write-only.",
    },
    documents: {
      introBefore:
        "PDF, Word, Excel and PowerPoint attachments are converted to text before the model sees them. Local parsing",
      introBuiltin: "works out of the box",
      introAfter:
        ", and cloud parsers are an optional supplement — better suited to scans, complex layouts and formula-heavy tables that local extraction cannot read.",
      policy: "Parsing policy",
      localEnabled: "Enable local parsing",
      localHint:
        "With this off, everything depends on cloud parsers. Only turn it off when the policy is “Cloud only”, or once a cloud service is configured.",
      fallback: "Allow falling back to the other side",
      fallbackHint:
        "With this off, a failure on the chosen side errors out instead of trying the other. Useful when you want tight control over what leaves the machine.",
      cloudParsers: "Cloud parsers",
      addParser: "Add a service",
      noParsers:
        "No cloud parsers configured. Local parsing still works; scans will fail to parse because of it.",
      enabled: "Enabled",
      disabled: "Disabled",
      keySet: "Key set",
      testing: "Testing…",
      test: "Test connection",
      testOk: "Connection OK",
    },
    copilot: {
      countConfigured: "{count} Copilot configured | {count} Copilots configured",
      add: "New Copilot",
      inUse: "In use by this conversation",
      empty: "No Copilots yet. Click “New Copilot” to create one.",
      introBefore:
        "A Copilot bundles a system prompt, a set of available tools and default generation parameters. Picking one for a new conversation injects its prompt and",
      introCopied: "copies",
      introAfter:
        " its defaults into that conversation — later edits to the Copilot do not affect conversations already under way.",
      summarySteps: "up to {count} tool steps",
      summaryHistory: "1 message of history | {count} messages of history",
      summaryTools: "1 tool | {count} tools",
      summaryAllTools: "all tools",
    },
    defaults: {
      provider: "Default provider",
      providerHint: "Used when a new conversation does not name one. Currently: {name}",
      model: "Default model",
      modelHint: "Used when a new conversation does not name one. Currently: {name}",
      modelUnset: "not set",
      workspaceRoot: "Workspaces root",
      webSearch: "Web search provider",
      webSearchHint: "(change it under tools.webSearch in config.yaml)",
    },
    deleteProvider: {
      title: "Delete provider",
      message: "Delete “{name}”?",
      detail:
        "1 model configuration will be deleted with it, and conversations using it will fall back to the default provider. | Its {count} model configurations will be deleted with it, and conversations using it will fall back to the default provider.",
    },
    deleteModel: {
      title: "Delete model",
      message: "Delete the model “{model}” from “{provider}”?",
      detail: "Conversations still using it will fall back to the first model of that provider.",
    },
    deleteParser: {
      title: "Delete parser",
      message: "Delete “{name}”?",
      detail:
        "Documents already parsed are unaffected; parsing again will need another service selected.",
    },
    deleteCopilot: {
      title: "Delete Copilot",
      message: "Delete the Copilot “{name}”?",
      detail: "Conversations using it are kept, but lose its settings.",
    },
    policy: {
      "local-only": { label: "Local only", hint: "Fully offline; no external service is called" },
      "local-first": {
        label: "Local first",
        hint: "Parse locally, and call the cloud parser only when nothing can be read",
      },
      "cloud-first": { label: "Cloud first", hint: "Parse in the cloud, falling back to local" },
      "cloud-only": { label: "Cloud only", hint: "Hand every document to a cloud parser" },
    },
  },

  providers: {
    edit: "Edit provider",
    create: "New provider",
    namePlaceholder: "e.g. DeepSeek",
    apiKeySet: "Configured (leave blank to keep it)",
    apiKeyUnset: "Not configured",
    apiKeyNote:
      "For security the server never returns the key, so leaving this blank keeps the current one.",
    models: "Models",
    addModel: "Add a model",
    modelNoteBefore: "Both the context length and the max output are in ",
    modelNoteToken: "tokens",
    modelNoteAfter:
      " (e.g. 128000). The context length only estimates how full the context is; leave it blank to assume {fallback}.",
    modelId: "Model ID",
    displayName: "Display name",
    displayNamePlaceholder: "Defaults to the model ID",
    contextLength: "Context length",
    contextWrong: "Looks wrong — this is in tokens, not characters",
    unitToken: "in tokens",
    maxOutput: "Max output",
    optional: "Optional",
    removeModel: "Remove this model",
    capabilities: {
      vision: "Image input",
      reasoning: "Reasoning model",
      tool_use: "Tool calling",
    },
  },

  modelSelector: {
    choose: "Choose a model",
    chooseTitle: "Choose a model (applies to this conversation)",
    noModelsTitle: "No model is available yet",
    keyMissing: "No key",
    empty: "No models available yet. Add a provider and its models under Settings → Providers.",
    manage: "Manage models…",
  },

  parsers: {
    edit: "Edit parser",
    create: "New parser",
    kind: "Protocol",
    kindHint:
      "The protocol decides how we talk to the service; the endpoint and key are set by the fields below. The same protocol can back several entries (MinerU cloud and self-hosted, say).",
    namePlaceholder: "e.g. Docling (local)",
    credentialsBefore: "The endpoint has to match the chosen protocol. Get credentials:",
    apiKey: "API Key",
    apiKeyOptional: " (optional)",
    apiKeyRequired: "Required",
    apiKeyOptionalValue: "Optional",
    apiKeySet: "Configured (leave blank to keep it)",
    apiKeyNote:
      "For security the server never returns the key, so leaving this blank keeps the current one.",
    enabled: "Enabled (parsing skips this entry when off)",
  },

  sessionSettings: {
    title: "Session parameters",
    scopeExisting: "These parameters apply to this conversation only.",
    scopeNew: "No conversation yet, so these apply to the one about to be created.",
    scopeSuffix: " Left blank, each falls back to the Copilot's default and then to the global one.",
    model: "Model",
    inherit: "Inherit default",
    temperatureHint: "Between 0 and 2; higher answers are more random.",
    topPHint: "Between 0 and 1; usually adjusted instead of temperature, not alongside it.",
    maxOutput: "Max output",
    maxOutputHint: "In tokens; caps how long a single reply can be.",
    maxHistory: "History messages to carry",
    maxHistoryAll: "All (no truncation)",
    maxHistoryHint: "In messages; the oldest are dropped first once the limit is passed.",
    maxSteps: "Max tool steps",
    maxStepsHint:
      "How many times the model → tool loop may run within a single reply.",
    reset: "Reset",
  },

  errors: {
    NAME_REQUIRED: "A name is required.",
    WORKSPACE_NOT_FOUND: "That workspace no longer exists.",
    COPILOT_NOT_FOUND: "That Copilot no longer exists.",
    SESSION_NOT_FOUND: "That conversation no longer exists.",
    TITLE_EMPTY: "The title cannot be empty.",
    UNSUPPORTED_FILE_TYPE: "Unsupported file type: {mimeType}",
    INVALID_ATTACHMENT_PATH: "That attachment path is not valid.",
    ATTACHMENT_NOT_FOUND: "That attachment no longer exists.",
    ATTACHMENT_STORE_FAILED: "Could not save the attachment. Please try again.",
    DATA_REQUIRED: "The file contents are missing.",
    INVALID_BASE64: "The file contents are not valid base64.",
    EMPTY_FILE: "That file is empty.",
    FILE_TOO_LARGE: "The file exceeds the {limitMb} MB limit.",
    PROVIDER_NOT_FOUND: "That provider no longer exists.",
    MODEL_NOT_FOUND: "That model no longer exists.",
    MODEL_ID_REQUIRED: "Every model needs a modelId.",
    BASE_URL_REQUIRED: "A base URL is required.",
    ONLY_PROVIDER: "You cannot delete the only provider.",
    DEFAULT_PROVIDER: "This is the default provider. Choose a different default first.",
    PARSER_NOT_FOUND: "That parser no longer exists.",
    UNKNOWN_PARSER_KIND: "Unknown parser kind: {kind}",
    UNKNOWN_POLICY: "Unknown parsing policy: {policy}",
    UNKNOWN_PARSER: "Unknown parser.",
    UNKNOWN_PROVIDER: "Unknown provider.",
    MESSAGE_REQUIRED: "A message is required.",
  },

  parseErrors: {
    password_protected: "This file is encrypted; its contents need a password.",
    no_text_layer:
      "No text layer was found — this is likely a scan or an image-only PDF. Configure an OCR-capable cloud parser and try again.",
    too_large:
      "The file is over the local parsing limit, so it was skipped. Configure a cloud parser and try again, or raise the limit.",
    unsupported_type: "This file type cannot be parsed yet.",
    corrupt: "The file could not be read: {detail}",
    missing_file: "The file is gone and cannot be parsed. Please upload it again.",
    no_cloud_parser:
      "No cloud parser is available. Add and enable one under Settings → Document parsing.",
    local_disabled: "Local parsing is turned off in settings.",
    cloud_auth: "The cloud parser rejected our credentials. Check the API key.",
    cloud_failed: "Cloud parsing failed: {detail}",
    timeout: "Parsing timed out. The file may be too large, or the parser is unresponsive.",
    cancelled: "Parsing was cancelled.",
  },
};

export default en;
