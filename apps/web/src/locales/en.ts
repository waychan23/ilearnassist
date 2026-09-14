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
    listSeparator: ", ",
    save: "Save",
    close: "Close",
    edit: "Edit",
    rename: "Rename",
    settings: "Settings",
    signOut: "Sign out",
    back: "Back",
    loading: "Loading…",
    retry: "Try again",
    copyFailed: "Copy failed — select the text and copy it yourself",
  },

  app: {
    /**
     * The product name. Shown when there is no session and no workspace to name the topbar
     * after, and on the login screen — which is the one page with nothing else to call itself.
     */
    title: "ilearnassist",
    configBanner: {
      before: "No API key is configured yet. Click",
      action: "Settings → Providers",
      after: "in the top right to add a Provider and its key; it takes effect as soon as you save.",
    },
  },

  // See the note on `login` in the zh-CN catalog for what `note` is doing.
  login: {
    lead: "Sign in with your username and password.",
    username: "Username",
    usernamePlaceholder: "For example: your name",
    password: "Password",
    passwordPlaceholder: "Your password",
    submit: "Sign in",
    note: "You stay signed in for 7 days at a time. If you forget your password, ask an administrator to reset it.",
  },

  password: {
    title: "Change password",
    lead: "{name}, choose a new password before you carry on.",
    current: "Current password",
    new: "New password",
    confirm: "Confirm new password",
    hint: "At least {min} characters.",
    submit: "Save new password",
    mismatch: "The two passwords do not match.",
    tooShort: "A new password needs at least {min} characters.",
    unchanged: "The new password cannot be the one you already have.",
    signOut: "Sign out",
  },

  account: {
    title: "Your account",
    identity: "Account",
    passwordLead: "Changing your password signs this account out everywhere else.",
    passwordChanged: "Your password has been changed.",
  },

  roles: {
    superadmin: "Superadmin",
    admin: "Administrator",
    user: "User",
  },

  admin: {
    title: "Platform console",
    subtitle: "Manage the accounts on this installation.",
    nav: {
      users: "Users",
    },
    create: "New user",
    roles: "Roles",
    you: "You",
    disabled: "Disabled",
    mustChange: "Must change password",
    enable: "Enable",
    count: "No accounts | 1 account | {count} accounts",
    createPasswordHint:
      "The initial password is generated for you and shown once. Copy it and send it to the user — they have to change it the first time they sign in.",
    selfLocked: "You cannot disable or demote your own account.",
    rowLocked: "Only a superadmin can manage administrator accounts.",
    resetPanel: "A superadmin cannot reset their own password here — do it in the desktop control panel.",
    grantHint: "Only a superadmin can grant the administrator role.",
    disable: {
      action: "Disable",
      title: "Disable account",
      message: "Disable “{name}”?",
      detail:
        "The account is signed out immediately and cannot sign in again. Its workspaces, files and conversations are kept, and you can re-enable it at any time.",
      confirm: "Disable",
    },
    reset: {
      action: "Reset password",
      title: "Reset password",
      message: "Reset the password for “{name}”?",
      detailSelf:
        "A new password is generated. Your current session ends and this one carries on with the new password.",
      detailOther:
        "A new password is generated and the account is signed out immediately. Its owner has to change it the first time they sign in.",
      confirm: "Reset",
    },
    kick: {
      action: "Sign out",
      title: "Sign out everywhere",
      message: "Sign “{name}” out everywhere?",
      detail:
        "Every session the account holds ends immediately. Its password is untouched and it can sign back in.",
      confirm: "Sign out",
      self: "To end your own session, use Sign out.",
    },
    credential: {
      created: "The account is ready. Send these details to its owner:",
      reset: "The password has been reset. Send the new one to its owner:",
      username: "Username",
      password: "Password",
      note: "This password is shown once and never again — only a hash is stored, so nobody, not even you, can read it back later. Its owner has to change it the first time they sign in.",
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
    jumpToLatest: "Jump to latest",
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
    stop: "Stop generating",
    stopping: "Stopping…",
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
    collapse: "Collapse the sidebar",
    expand: "Expand the sidebar",
  },

  files: {
    tab: "Files",
    refresh: "Refresh the file list",
    empty: "This workspace has no files yet",
    truncated: "Too many entries — showing the first {count}",
    treeLabel: "Workspace files",
    retry: "Try again",
    preview: {
      loading: "Reading…",
      rendered: "Preview",
      source: "Source",
      viewLabel: "View as",
      unsupported: "No preview for this format yet",
      unsupportedHint: "Plain text and Markdown files can be previewed today.",
      truncated: "Showing the first {size}",
      size: "Size",
    },
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
      groupPublic: "Published Copilots",
      groupMine: "My Copilots",
      byAuthor: "published by {name}",
      advanced: "Other parameters (set here at creation, adjustable afterwards in session parameters)",
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
      ask_user: "Ask the user",
      ila_quiz: "Quiz",
      ila_review_quiz: "Grade quiz",
      ila_make_plan: "Make / edit plan",
      ila_read_plan: "Read plan",
      ila_update_plan_progress: "Update plan progress",
    },
    done: "Done",
    running: "Running",
    args: "Arguments",
    result: "Result",
  },

  askUser: {
    title: "Ask the user",
    preparing: "Preparing questions",
    awaiting: "Waiting for your answer",
    answered: "Confirmed",
    skipped: "Skipped",
    dismissed: "Dismissed",
    skippedHint: "You sent a new message instead, so these questions were retired.",
    dismissedHint: "You dismissed these questions, so the assistant will use its own judgement.",
    other: "Other (type it in)",
    otherPlaceholder: "Type your answer…",
    multiSelectHint: "Select any that apply.",
    autoSubmitHint: "One question only — picking an option submits it.",
    step: "Question {current} of {total}",
    previous: "Previous",
    next: "Next",
    submit: "Submit",
    cancel: "Dismiss",
    unanswered: "No answer",
    details: "Show details",
    options: "Options",
  },
  quiz: {
    title: "Quiz",
    preparing: "Preparing questions",
    awaiting: "Waiting for your answers",
    answered: "Submitted",
    skipped: "Skipped",
    dismissed: "Dismissed",
    skippedHint: "You sent a new message instead, so this quiz was retired.",
    dismissedHint: "You dismissed this quiz, so the assistant will use its own judgement.",
    multiSelectHint: "Select any that apply.",
    unsure: "Not sure",
    unsureHint: "Picking this clears the choices above: it is a third answer, not one of them.",
    unsureReasonLabel: "Why you are unsure",
    unsureReasonPlaceholder:
      "Say why: you have not covered it, cannot recall it, or think the question is off…",
    notesLabel: "Your take",
    notesPlaceholder: "Write down your understanding or a question (optional)",
    step: "Question {current} of {total}",
    previous: "Previous",
    next: "Next",
    submit: "Submit",
    cancel: "Dismiss",
    unanswered: "No answer",
    details: "Show details",
    options: "Options",

    /* ------------------------------ quiz widget panel ------------------------------ */
    empty: "No quiz questions yet",
    viewList: "List",
    viewTree: "By chapter",
    filterAll: "All",
    filterAnswered: "Answered",
    filterSkipped: "Skipped",
    filterWrong: "Wrong",
    groupInPlan: "Study quizzes",
    groupOther: "Other questions",
    pending: "To answer",
    verdictCorrect: "Correct",
    verdictIncorrect: "Incorrect",
    verdictUnsure: "Not sure",
    verdictUngraded: "Not graded",
    nodeMissing: "Chapter deleted",
    detail: {
      title: "Question details",
      yourAnswer: "Your answer",
      feedback: "Explanation",
      waitingGrade: "Waiting for the assistant to grade it…",
      makeupHint:
        "You did not answer this question earlier (skipped or cancelled the quiz). Answer it here and the assistant will grade it.",
      makeupSubmit: "Submit make-up answer",
      followup: "Follow up",
      followupPlaceholder: "Ask a follow-up about this question…",
      followupSend: "Send follow-up",
      close: "Close",
    },
    makeupMessage:
      "[MAKE-UP ANSWER] This is a late answer to a question I did not answer before (I skipped or cancelled the quiz). It is the SAME question — do not call ila_quiz to create a new one.\n" +
      "Question ID: {id} ({qid})\n" +
      "Question: {question}\n" +
      "Options: {options}\n" +
      "My make-up answer: {answer}\n" +
      "Please grade this make-up answer: call ila_review_quiz with the exact question ID, a verdict, and an explanation.",
    followupMessage:
      "A follow-up about question {id} ({qid}).\nQuestion: {question}\nMy follow-up: {text}\nPlease answer directly; no new quiz is needed.",
  },

  message: {
    copyReply: "Copy the reply",
    stopped: "Stopped",
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

  /** The generation parameters, named once — see the note in `zh-CN.ts`. */
  params: {
    provider: "Provider",
    model: "Model",
    inherit: "Inherit default",
    temperature: "Temperature",
    temperatureHint: "Between 0 and 2; higher answers are more random.",
    topP: "Top P",
    topPHint: "Between 0 and 1; usually adjusted instead of temperature, not alongside it.",
    maxOutput: "Max output",
    maxOutputHint: "In tokens; caps how long a single reply can be.",
    maxHistory: "History messages to carry",
    maxHistoryAll: "All (no truncation)",
    maxHistoryHint: "In messages; the oldest are dropped first once the limit is passed.",
    maxSteps: "Max tool steps",
    maxStepsHint: "How many times the model → tool loop may run within a single reply.",
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
    tools: "Available tools",
    allTools: "All tools available",
    allToolsHint:
      "This Copilot may use every tool, including any added later.",
    toolsHint: "Only the ticked tools are available; none ticked means no tools at all.",
    boundToolsHint:
      "Some tools come with a widget (the Plan widget's make/read/update plan tools): they switch on automatically when the widget is installed, and are deliberately not listed here.",
    public: "Publish this Copilot",
    publicHint:
      "Every account can then see and use it, but only you can edit or delete it.",
    defaults: "Defaults (copied into a new conversation; adjustable there afterwards)",
    widgets: "Widgets to install",
    widgetsHint:
      "Starting a conversation from this Copilot installs the ticked widgets into it; they can be adjusted there afterwards, in session parameters.",
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
      groupPublic: "Published Copilots",
      groupMine: "My Copilots",
      byAuthor: "published by {name}",
      published: "published",
      viewPrompt: "View its system prompt",
      promptNone: "No system prompt written.",
      copyToMine: "Copy to mine",
      introBefore:
        "A Copilot bundles a system prompt, a set of available tools and default generation parameters. Picking one for a new conversation",
      introCopied: "copies the whole of it",
      introAfter:
        " into that conversation — later edits to the Copilot leave conversations already under way alone, and a conversation can change its own prompt independently.",
      summarySteps: "up to {count} tool steps",
      summaryHistory: "1 message of history | {count} messages of history",
      summaryTools: "1 tool | {count} tools",
      summaryAllTools: "all tools",
      summaryNoTools: "no tools",
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
      detail:
        "Conversations already using it are unaffected — they keep the prompt and parameters copied in when they were created.",
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

  widgets: {
    install: "Install",
    uninstall: "Uninstall",
    heading: "Widgets",
    workspaceLead: "Widgets installed here appear in the right sidebar of every conversation in this workspace.",
    sessionLead: "Widgets installed here affect this conversation only.",
    panel: {
      layoutTop: "Move the tab strip to the top",
      layoutLeft: "Move the tab strip to the left",
      collapse: "Collapse the widget panel",
      expand: "Expand the widget panel",
      resize: "Resize the widget panel (arrow keys for a nudge)",
      more: "More widgets",
    },
    open: "Open the widget panel",
    noSession: "No conversation yet — a widget has to be installed into one.",
    loadFailed: "Couldn't load the data",
    retry: "Retry",
    messages: "Messages",
    tokens: "Tokens",
    workspaceStats: {
      /** "(Demo)" is part of the name, not a note about it — see the remark in `zh-CN.ts`. */
      name: "Workspace stats (Demo)",
      hint: "This workspace's conversations, with each one's message count and token use.",
      empty: "This workspace has no conversations yet.",
    },
    workspaceSettings: {
      title: "Workspace settings",
      liveHint: "Changes show up in the right sidebar immediately.",
    },
    sessionStats: {
      name: "Conversation stats (Demo)",
      hint: "This conversation's message count and token use.",
      noSession: "Open a conversation and its numbers appear here.",
      context: "Context this turn",
    },
    plan: {
      name: "Plan",
      hint: "The assistant-maintained study plan: outline tree, progress and version history.",
      noSession: "Open a conversation and its plan appears here.",
    },
    quiz: {
      name: "Quiz",
      hint: "This conversation's quiz questions: chapter grouping, wrong-answer filter, make-up and follow-up.",
      noSession: "Open a conversation and its quiz questions appear here.",
    },
  },

  plan: {
    empty:
      "This conversation has no plan yet. Ask the assistant to make a study plan and it appears here.",
    version: "Plan version",
    versionLatest: "Latest V{n}",
    versionN: "V{n}",
    historyBanner: "Browsing history version V{n} (read-only; the latest plan is unchanged)",
    historyLoadFailed: "That history version could not be loaded; it may no longer exist.",
    showLevel: "Show levels through {n}",
    expandAll: "Expand all",
    expandCurrentPath: "Show only the current node's path",
    expand: "Expand",
    collapse: "Collapse",
    jumpToCompletion: "Jump to where this node was completed",
    jumpToStart: "Jump to where work on this node began",
    jumpToChapter: "Jump to this chapter",
    jumpConfirm: "Jump to chapter {number} {title} now?",
    jumpConfirmDetail:
      "Earlier unfinished chapters (including the one currently in progress) are marked skipped and can be caught up later.",
    jumpConfirmOk: "Jump to chapter",
    jumpMessage: "Update progress: jump to chapter {number} {title}",
    adjust: "Adjust plan",
    adjustPlaceholder:
      "Write how the plan should change while reading it — split chapter 3 into two, add a practice section…",
    adjustSend: "Send adjustment",
    adjustCancel: "Cancel",
    adjustMessage: "Adjust the plan: {text}",
    status: {
      not_started: "Not started",
      in_progress: "In progress",
      completed: "Completed",
      skipped: "Skipped",
      deleted: "Deleted",
    },
  },

  planConflict: {
    title: "A plan already exists",
    preparing: "Waiting for your choice",
    awaiting: "Waiting for your choice",
    answered: "Chosen",
    dismissed: "Dismissed",
    question:
      "This conversation already has a plan. Overwrite it with the new content as a new version here, or start a fresh conversation for it?",
    edit: "Overwrite this plan (new version)",
    newSession: "New conversation with this plan",
    cancel: "Cancel",
    choseEdit: "The new plan overwrote this conversation's plan as a new version.",
    choseNewSession:
      "A new conversation was created with this plan as V1, and the view switched to it.",
    dismissedHint: "You dismissed the choice; the assistant leaves the existing plan alone.",
  },

  sessionSettings: {
    title: "Session parameters",
    scopeExisting: "These parameters apply to this conversation only.",
    scopeNew: "No conversation yet, so these apply to the one about to be created.",
    scopeSuffix: " Left blank, each falls back to the global default.",
    systemPrompt: "System prompt",
    systemPromptPlaceholder: "What should this conversation be?",
    systemPromptHint:
      "This conversation's own. A new conversation copies one in from its Copilot and the two are independent afterwards — editing it here does not change that Copilot.",
    reset: "Reset",
  },

  errors: {
    NAME_REQUIRED: "A name is required.",
    WORKSPACE_NOT_FOUND: "That workspace no longer exists.",
    COPILOT_NOT_FOUND: "That Copilot no longer exists.",
    SESSION_NOT_FOUND: "That conversation no longer exists.",
    TITLE_EMPTY: "The title cannot be empty.",
    UNSUPPORTED_FILE_TYPE: "Unsupported file type: {mimeType}",
    SOURCE_NOT_FOUND: "That file no longer exists.",
    SOURCE_STORE_FAILED: "Could not save the file. Please try again.",
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
    REASONING_NOT_DECLARED: "This model needs its reasoning passed back, but \"Reasoning model\" is not enabled for it in settings, so the provider rejected the request. Enable it for this model in Settings, then try again.",
    MESSAGE_REQUIRED: "A message is required.",
    QUESTION_NOT_PENDING: "Those questions no longer need an answer — they were submitted or retired already.",
    INVALID_ANSWER: "That answer is incomplete or out of date. Refresh the page and try again.",
    FILE_NOT_FOUND: "That file or folder is gone — it was deleted or renamed.",
    INVALID_FILE_PATH: "That location is outside the workspace and cannot be opened.",
    NOT_A_DIRECTORY: "That path is not a folder.",
    NOT_A_FILE: "That path is not a file.",
    UNAUTHENTICATED: "Your session has ended. Sign in again.",
    USERNAME_REQUIRED: "A username is required.",
    USERNAME_TOO_LONG: "A username cannot be longer than {max} characters.",
    UNKNOWN_WIDGET: "This build has no such widget. Reload the page and try again.",
    WIDGET_SCOPE_UNSUPPORTED: "That widget cannot be installed at this level.",
    PLAN_VERSION_NOT_FOUND: "That plan version does not exist.",
    PLAN_NODE_NOT_FOUND: "That plan node cannot be found — it may have been deleted or completed.",
    QUIZ_QUESTION_NOT_FOUND: "That quiz question cannot be found.",
    QUIZ_NOT_ANSWERABLE:
      "That question is not open to a make-up answer (only questions skipped or cancelled without answering are).",

    INVALID_CREDENTIALS: "That username or password is not right.",
    ACCOUNT_DISABLED: "This account is disabled. Ask an administrator to re-enable it.",
    INVALID_REFRESH_TOKEN: "Your session has ended. Sign in again.",
    PASSWORD_REQUIRED: "A password is required.",
    PASSWORD_TOO_SHORT: "A password needs at least {min} characters.",
    PASSWORD_TOO_LONG: "A password cannot be longer than {max} characters.",
    PASSWORD_UNCHANGED: "The new password cannot be the one you already have.",
    SETUP_REQUIRED:
      "This installation has no administrator yet. Ask the operator to create one in the control panel.",
    PASSWORD_CHANGE_REQUIRED: "Choose a new password before you can carry on.",
    USER_NOT_FOUND: "That account no longer exists.",
    USERNAME_TAKEN: "That username is already taken.",
    INVALID_FIELD: "\u201c{field}\u201d is not a valid value for that field.",
    FORBIDDEN: "This account is not allowed to do that.",
    CANNOT_MODIFY_SELF: "You cannot disable or demote your own account.",
    CANNOT_MODIFY_ADMIN: "Only a superadmin can manage administrator accounts.",
    ROLES_NOT_GRANTABLE: "Only a superadmin can grant the administrator role.",
    PANEL_RESET_REQUIRED:
      "A superadmin cannot reset their own password here — do it in the desktop control panel.",
  },

  /**
   * The account's uploaded files.
   *
   * `delete.detail` carries the part a user cannot guess: that deleting a conversation did
   * *not* delete this file, and which way round the two actions are. Without it, "delete"
   * reads as tidying up something already gone.
   */
  sources: {
    title: "Uploaded files",
    lead: "Everything you have uploaded. These belong to your account rather than to one conversation — a file referenced from several conversations is stored and parsed once.",
    open: "Uploaded files",
    loading: "Loading…",
    empty: "Nothing uploaded yet. Use the paperclip in the composer, or paste a screenshot.",
    parsed: "Read",
    parsedChars: "{count} characters read",
    parsing: "Reading…",
    parseFailed: "Could not be read",
    delete: {
      title: "Delete file",
      message: 'Delete "{name}"?',
      detail: "The file, its extracted text and every reference to it will be removed for good. Messages that were sent with it still show the attachment, but it will no longer open.",
      action: "Delete file",
    },
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
