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
    add: "Add",
    delete: "Delete",
    name: "Name",
    copied: "Copied",
    copy: "Copy",
    listSeparator: ", ",
    save: "Save",
    close: "Close",
    edit: "Edit",
    rename: "Rename",
    signOut: "Sign out",
    back: "Back",
    loading: "Loading…",
    retry: "Try again",
    copyFailed: "Copy failed — select the text and copy it yourself",
  },

  /**
   * How long ago something happened, from `composables/relativeTime.ts`.
   *
   * A namespace of its own rather than one per surface: the workspace cards and the file lists
   * both show a timestamp, and the sentence is the same sentence. A key under either surface
   * would be a copy of the other's wording.
   */
  time: {
    now: "just now",
    minutes: "1 minute ago | {count} minutes ago",
    hours: "1 hour ago | {count} hours ago",
    days: "1 day ago | {count} days ago",
  },

  /**
   * Diagrams: the card that draws one in the conversation, and the viewer that enlarges it.
   *
   * Not under `tools.` with the tool's own name (`tools.name.ila_diagram`), because these are
   * about the *drawing* rather than about the call: the same sentences are shown by the file
   * preview, which knows nothing about a tool call.
   */
  diagram: {
    rendering: "Drawing the diagram…",
    failed: "This diagram cannot be drawn — mermaid could not parse the source below.",
    tooLarge: "This diagram is over {size} characters, so its source is shown instead.",
    expand: "Open larger",
    viewTitle: "Diagram",
    tableTitle: "Table",
    zoomIn: "Zoom in",
    zoomOut: "Zoom out",
    fit: "Back to 100%",
    maximize: "Maximise the window",
    restore: "Restore the window",
    download: "Download as an image",
    formats: {
      png: "PNG image (transparent)",
      jpg: "JPG image (theme background)",
      svg: "SVG vector",
    },
    downloadFailed: "The download failed — this drawing could not be written to a file.",
    copyHint: "Copies an HTML table; pasting into a plain-text editor gives the Markdown",
    source: "Source",
    summary: "Summary",
  },

  app: {
    /**
     * The displayed product name. See the note in the zh-CN catalog for the boundary between it
     * and the identifiers, which keep `ilearnassist`.
     */
    title: "Interactive Learning Assistant",
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
    /** The toggle that opens the section menu, on a viewport where it is a drawer. */
    openMenu: "Open the menu",
    subtitle: {
      users: "Manage the accounts on this installation.",
      providers: "Configure the model services every account shares; ordinary users choose from what is configured here.",
      documents: "Configure how documents are parsed for every account.",
      uploads: "The upload limit every account shares.",
    },
    nav: {
      users: "Users",
      providers: "Model services",
      documents: "Documents",
      uploads: "Uploads",
    },
    uploads: {
      maxSize: "Largest file size (MB)",
      range: "Anywhere from {min} to {max} MB.",
      saving: "Saving…",
      saved: "Saved",
      note: "A file past the limit is refused before it is uploaded, with the limit it hit. Attachments and workspace files share this one limit.",
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
    superadminFixed:
      "The superadmin is created when the desktop control panel is first set up — it cannot be created or assigned here, and there is exactly one.",
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
    autoBadgeTitle: "Titles are generated from the first turn of the conversation",
    start: "Start a conversation",
    startHint: "Type a message below; the agent will call tools as it needs them.",
    startAction: "New conversation (choose an Assistant)",
    jumpToLatest: "Jump to latest",
  },

  composer: {
    parsing: "Attachments are still being parsed; sending unlocks when they finish…",
    parseFailed:
      "1 attachment could not be parsed, so the model will not be able to read it. Use the retry button on the attachment, or configure a cloud parser under Settings → Document parsing. | {count} attachments could not be parsed, so the model will not be able to read them. Use the retry button on an attachment, or configure a cloud parser under Settings → Document parsing.",
    visionWarning:
      "The current model “{model}” is not marked as accepting image input, so images will be sent as text placeholders. Tick “Image input” for it under Settings → Providers.",
    /* The `@` is `{'@'}`: see the note in the Chinese catalog. */
    placeholder: "Type a message — Enter to send, Shift+Enter for a new line, {'@'} to reference a source",
    /** The `@` picker: nothing matched what has been typed, and nothing exists to match. */
    noSourceMatch: "No source matches that.",
    noSources: "Nothing to reference yet.",
    /* The picker's tabs, which double as its group headings. */
    tabAll: "All",
    tabWorkspace: "Workspaces",
    tabSource: "Sources",
    /* The type filter's five pills. Coarser than the eight categories a source really has. */
    pillImage: "Images",
    pillText: "Text",
    pillCode: "Code",
    pillPage: "Web pages",
    pillOther: "Other files",
    /*
     * The row that opens every workspace at once. Its Chinese label is what it is called in the
     * product; this one is the translation, and the picker also matches the literal `all` so the
     * difference between the two spellings never strands somebody mid-word.
     */
    allWorkspaces: "{'@'}All workspaces",
    /** Said when more rows matched than the list shows. */
    moreHidden: "{count} more not shown",
    noWorkspaceMatch: "No workspace matches that.",
    /** Removing one workspace from what this conversation may read. */
    scopeRemove: "Stop referencing “{name}”",
    thinking: "The agent is thinking…",
    parsingShort: "Parsing attachments…",
    send: "Send (Enter)",
    stop: "Stop generating",
    stopping: "Stopping…",
    attach: "Add an image or file",
    /*
     * The canned replies above the input. Each label is also the message that gets sent — the
     * chip *is* the sentence — so they are kept short and conversational rather than being
     * names for intents. "OK" rather than "Okay" to match the Chinese in length on screen.
     *
     * `label` names the row rather than being sent.
     */
    quick: {
      label: "Quick replies",
      continue: "Continue",
      yes: "Yes",
      ok: "OK",
    },
    /* The session-parameters button's label lives under `sessionSettings.open`: three places
       open that dialog, and it is the dialog that owns the words. */
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
    pinnedGroup: "Pinned",
    pin: "Pin",
    unpin: "Unpin",
    openNav: "Open navigation",
    collapse: "Collapse the sidebar",
    expand: "Expand the sidebar",
  },

  files: {
    tab: "Workspace files",
    refresh: "Refresh the file list",
    empty: "This workspace has no files yet",
    truncated: "Too many entries — showing the first {count}",
    treeLabel: "Workspace files",
    retry: "Try again",
    /*
     * The file manager. Four verbs, because a web app has no Finder behind it: without these
     * the workdir is a directory the agent writes into and the user can only look at.
     */
    newFolder: "New folder",
    newFolderHint: "A folder name, relative to the folder you are in.",
    upload: "Upload files",
    rename: "Rename or move",
    renameHint: "A path relative to the workspace root. Type a new one to move it.",
    deleteTitle: "Delete this file?",
    deleteDirectoryTitle: "Delete this folder?",
    deleteMessage: "“{name}” will be removed from the workspace. Its bytes are kept in the trash folder, but it is gone from here.",
    deleteDirectoryMessage: "“{name}” will be removed from the workspace. Only an empty folder can be deleted this way.",
    preview: {
      loading: "Reading…",
      rendered: "Preview",
      source: "Source",
      viewLabel: "View as",
      unsupported: "No preview for this format",
      unsupportedHint:
        "Previewable: text, Markdown, diagrams, images, PDFs and Office documents.",
      /** A file the viewer claimed but could not draw. The library's own error is shown below
       *  it untranslated, the same treatment a provider's raw failure gets. */
      viewerFailed: "This file could not be previewed",
      truncated: "Showing the first {size}",
      size: "Size",
      /** Filling the viewport, and going back — see `zh-CN` for why the label names the action. */
      maximize: "Maximise",
      restore: "Restore window",
    },
    /**
     * A conversation's own directory — where the diagrams it draws are written.
     *
     * Its own dialog rather than a second tree in the sidebar, because these files belong to
     * one conversation rather than to the workspace, and because the sidebar's tree is the
     * same directory the file tools write into. The lead says where they are, since "why is
     * this not in the file tree" is the first question the list raises.
     */
  },

  session: {
    /** What a conversation is called before it has a name of its own. See the Chinese catalog. */
    fallbackTitle: "(Untitled) Session",
    new: {
      title: "New conversation",
      titleLabel: "Title (optional)",
      titlePlaceholder: "Leave blank for “{fallback}”",
      noCopilot: "No Assistant",
      noCopilotDesc: "Uses the built-in general-purpose assistant and default parameters.",
      noCopilots: "No Assistants yet. Create one from the Assistants row in the sidebar.",
      groupPublic: "Published Assistants",
      groupMine: "My Assistants",
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
    // See the note in the zh-CN catalog: a name written once, not a translation.
    defaultName: "Default Workspace",
    new: {
      title: "New workspace",
      namePlaceholder: "e.g. My Project",
      hint: "A matching subdirectory will be created under the workspaces root.",
      // See the note in the zh-CN catalog: the same sentences as the settings dialog's, kept
      // apart on purpose.
      descriptionLabel: "Description (optional)",
      descriptionPlaceholder: "What is this workspace for?",
      descriptionHint: "For your own reference; never sent to the model.",
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
        // Only this one is the card's own. The buckets are `time.*` below, shared with the
        // file lists.
        never: "No activity yet",
      },
    },
  },

  tools: {
    name: {
      web_search: "Web search",
      web_fetch: "Read a web page",
      ila_collect_page: "Keep a page",
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
      ila_diagram: "Diagram",
      ila_table: "Table",
      ila_query: "Query record",
      ila_explore: "Explore other workspaces",
    },
    done: "Done",
    running: "Running",
    args: "Arguments",
    result: "Result",
    /** A run of consecutive tool calls, folded into one card. See `zh-CN` for the shapes. */
    group: {
      count: "{count} tool call | {count} tool calls",
      running: "Using {name}…",
    },
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
    /** The other nothing: questions exist, but the status filter is hiding all of them. */
    noMatch: "No questions match this filter",
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
      close: "Close",
    },
    makeupMessage:
      "[MAKE-UP ANSWER] This is a late answer to a question I did not answer before (I skipped or cancelled the quiz). It is the SAME question — do not call ila_quiz to create a new one.\n" +
      "Question ID: {id} ({qid})\n" +
      "Question: {question}\n" +
      "Options: {options}\n" +
      "My make-up answer: {answer}\n" +
      "Please grade this make-up answer: call ila_review_quiz with the exact question ID, a verdict, and an explanation.",
  },

  /** What a message can point at. See `zh-CN` for why this is a namespace of its own. */
  turnRef: {
    /** In `TURN_REFERENCE_KINDS` order — see `zh-CN`. */
    kind: {
      message: "Selected text",
      diagram: "Diagram",
      table: "Table",
      note: "Note",
      quiz: "Quiz question",
    },
    remove: "Remove this reference",
    ask: "Ask about it",
  },

  message: {
    copyReply: "Copy the reply",
    stopped: "Stopped",
    contextTokens: "Context this turn: {count} tokens",
    delete: {
      title: "Delete this message",
      message: "Delete this message?",
      detail:
        "It leaves the conversation and later turns will not see it. The message before it becomes the new last one.",
      action: "Delete",
    },
    regenerate: {
      title: "Regenerate the reply",
      message: "Ask the model to answer this message again?",
      detail: "The current reply is deleted and the model answers the same message again.",
      action: "Regenerate",
    },
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
    edit: "Edit Assistant",
    create: "New Assistant",
    namePlaceholder: "e.g. Code assistant",
    description: "Description",
    descriptionPlaceholder: "One line on what it is for",
    systemPrompt: "System prompt",
    systemPromptPlaceholder: "Define this Assistant's role, abilities and behavioural constraints…",
    systemPromptHint: "Leave blank to use the built-in general-purpose assistant.",
    tools: "Available tools",
    allTools: "All tools available",
    allToolsHint:
      "This Assistant may use every tool, including any added later.",
    toolsHint: "Only the ticked tools are available; none ticked means no tools at all.",
    boundToolsHint:
      "A few tools come with a widget and are deliberately not listed here (today only the Quiz widget's ask and grade tools): they switch on automatically when that widget is installed. Tools like the plan and diagram ones are ordinary and can be ticked.",
    public: "Publish this Assistant",
    publicHint:
      "Every account can then see and use it, but only you can edit or delete it.",
    defaults: "Defaults (copied into a new conversation; adjustable there afterwards)",
    widgets: "Widgets to install",
    widgetsHint:
      "Starting a conversation from this Assistant installs the ticked widgets into it; they can be adjusted there afterwards, in session parameters.",
    /* The list. It used to live under `settings.`, because the list and the editor were two
       halves of one settings dialog; the list has a dialog of its own now, and the editor that
       shares this namespace is what makes `copilot.*` its domain rather than the app's. */
    countConfigured: "{count} Assistant configured | {count} Assistants configured",
    add: "New Assistant",
    inUse: "In use by this conversation",
    empty: "No Assistants yet. Click “New Assistant” to create one.",
    groupPublic: "Published Assistants",
    groupMine: "My Assistants",
    byAuthor: "published by {name}",
    published: "published",
    viewPrompt: "View its system prompt",
    promptNone: "No system prompt written.",
    copyToMine: "Copy to mine",
    introBefore:
      "An Assistant bundles a system prompt, a set of available tools and default generation parameters. Picking one for a new conversation",
    introCopied: "copies the whole of it",
    introAfter:
      " into that conversation — later edits to the Assistant leave conversations already under way alone, and a conversation can change its own prompt independently.",
    summarySteps: "up to {count} tool steps",
    summaryHistory: "1 message of history | {count} messages of history",
    summaryTools: "1 tool | {count} tools",
    summaryAllTools: "all tools",
    summaryNoTools: "no tools",
    delete: {
      title: "Delete Assistant",
      message: "Delete the Assistant “{name}”?",
      detail:
        "Conversations already using it are unaffected — they keep the prompt and parameters copied in when they were created.",
    },
  },

  /**
   * The Copilot list, as a noun: the dialog's own title and the two entry points that open it.
   *
   * Separate from `copilot.*` because that namespace is the *editor* — "New Copilot",
   * "Description", "Available tools" — and a label for the thing the editor edits is not one of
   * its fields. The same word as the Chinese catalog's, which is a product name rather than an
   * untranslated string.
   */
  copilots: {
    title: "Assistant",
  },

  /* The installation's own settings — see the note in the Chinese catalog. */
  settings: {
    writeLocation: {
      label: "Where files are written",
      workspace: "The workspace (shared by every conversation)",
      session: "This conversation (private to it)",
      hint: "This is the default. An explicit instruction in the conversation wins over it.",
      inheritWorkspace: "Follow the workspace setting",
      inheritBuiltIn: "Default (this conversation)",
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
    defaults: {
      appSection: "Default model",
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
    empty: "No models available yet. Ask an administrator to configure one.",
    emptyAdmin: "No models available yet. Add a provider under Platform console → Model services.",
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
      name: "Workspace name",
      namePlaceholder: "For example: Linear algebra",
      description: "Workspace description",
      descriptionPlaceholder: "What is this workspace for?",
      descriptionHint: "For your own reference; never sent to the model.",
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
    thread: {
      name: "Threads",
      hint: "Topic chains organised as the conversation happens: grouped by plan chapter versus background; click to locate the message.",
      noSession: "Open a conversation and its topic threads are organised here.",
    },
    notes: {
      name: "Notes",
      hint: "Select text in a message to mark it or write about it — tied to what you marked, and locatable again at any time.",
      noSession: "Open a conversation and its notes are listed here.",
    },
    diagram: {
      name: "Diagrams",
      hint: "The diagrams this conversation has drawn — open one to look at it, or jump back to the reply it was drawn in.",
      noSession: "Open a conversation and the diagrams it has drawn are listed here.",
      /** The panel's own link to the whole folder, which holds more than diagrams. */
      /** A row the conversation has a tool call for — the button that scrolls back to it. */
      locate: "Go to the reply that drew it",
      /** Writing a note about a figure. Offered only where the notes panel has a home. */
      note: "Write a note about it",
      empty: "This conversation has not drawn a diagram or recorded a table yet.",
      filterKind: "Filter by kind",
      allKinds: "All",
      kinds: {
        diagram: "Diagrams",
        table: "Tables",
      },
      noMatch: "Nothing matches that filter.",
      failed: "Could not read the diagrams.",
      /** The thread the classifier put this diagram in. */
      inThread: "In: {title}",
      /** The row exists but its file is gone. */
      missing: "The file is gone",
    },
    insight: {
      name: "Insights",
      hint: "Reflect on this conversation's plan, quizzes, topics, notes and diagrams — what looks hard, what is unclear, what to read next.",
      noSession: "Open a conversation and you can reflect on its study record here.",
      /** The button that runs a pass. A button, because a pass costs a whole model call. */
      generate: "Generate",
      generating: "Generating…",
      generatingHint: "Reading this conversation's record; this can take a minute.",
      /** The pass ran and produced nothing usable. The list above it is unchanged. */
      generateFailed: "That pass produced nothing usable. The list above is unchanged.",
      /**
       * The other reason a press produced nothing, and the opposite instruction to the one
       * above: nothing is broken, there is simply nothing to read yet.
       */
      nothingToReflect:
        "This conversation has no record to reflect on yet — no plan, quizzes, topics, notes or diagrams. Come back after studying for a while.",
      empty: "Nothing here yet — press Generate to start.",
      /** The toggle: `adopted` is what survives the next pass, so the label says what it does. */
      adopt: "Keep",
      release: "Stop keeping",
      adoptedBadge: "Kept",
      /** Said once, under the list, because the rule is not guessable from the controls. */
      keepNote: "Only the items you keep survive the next pass; the rest are replaced by it.",
      /**
       * The eight kinds. A dynamic key (`widgets.insight.types.<id>`) over the closed
       * `INSIGHT_TYPES` union — the one narrow prefix this feature adds to `DYNAMIC_PREFIXES`.
       */
      types: {
        difficulty: "Hard",
        confusion: "Unclear",
        doubt: "Doubtful",
        strength: "Mastered",
        background: "Background",
        reading: "Further reading",
        advice: "Advice",
        habit: "Study habits",
      },
    },
    sources: {
      name: "Sources",
      hint: "What this conversation references and produces — uploaded files, saved pages, written files — filterable by content type.",
      noSession: "Open a conversation and its sources are listed here.",
      empty:
        "This conversation has no sources yet. Uploading a file, referencing one, or having the Assistant write one puts it here.",
      /** A filter rather than an empty conversation: the rows exist, the selection hides them. */
      noMatch: "No sources match the filter.",
      missing: "Missing",
      failed: "Could not load this conversation's sources.",
    },
  },

  /** Client-side widget groups: a master row in the install list, no row of their own. */
  widgetGroups: {
    study: {
      name: "Study pack",
      hint: "Install or uninstall the Plan, Quiz and Threads widgets together.",
    },
  },

  thread: {
    planBranch: "Plan",
    otherBranch: "Other (background)",
    empty: "Topic threads are organised here as the conversation goes.",
    syncing: "Organising threads…",
    unassigned: "1 message left to organise | {count} messages left to organise",
    toolCall: "(tool call)",
    locate: "Go to the message where this thread began",
    expand: "Expand",
    collapse: "Collapse",
    nodeMissing: "removed from the plan",
  },

  notes: {
    types: {
      annotation: "Marked",
      idea: "Idea",
      question: "Question",
      opinion: "Viewpoint",
      other: "Other",
    },
    count: "{count} note | {count} notes",
    add: "New note",
    empty: "No notes yet. Select something in a message to mark it or write about it.",
    untitled: "(empty)",
    open: "Open this note",
    /** The row's control for a note written about a 图 or a 表 instead of a passage. */
    target: {
      label: "Open the {kind} it is about",
      kinds: {
        diagram: "diagram",
        table: "table",
      },
      missing: "The {kind} it is about is gone",
    },
    claimedByOther: "Another widget is using this conversation's annotations, so marking is unavailable here.",
    /** The bar's own label, not a widget's — see `zh-CN` for why it is the neutral one. */
    toolbar: {
      label: "Actions for the selection",
      annotate: "Mark",
      note: "Note",
    },
    editor: {
      title: "Note",
      newTitle: "New note",
      editTitle: "Edit note",
      quoteLabel: "Marked text",
      /** The counterpart of `quoteLabel`, for a note about a 图 or a 表. */
      targetLabel: "About",
      contentLabel: "Your note",
      contentPlaceholder: "What are you thinking?",
      typeLabel: "Kind of note",
      /** Growing the window to write in, and putting it back. See `zh-CN`. */
      maximize: "Expand window",
      restore: "Shrink window",
      save: "Save",
      saving: "Saving…",
      locate: "Go to it",
      discardTitle: "Discard unsaved changes?",
      discardMessage: "What you typed will not be kept when this closes.",
      discardAction: "Discard",
    },
    remove: {
      title: "Delete this note?",
      message: "It will no longer appear in the list.",
      detail: "The message and the text you marked are both kept.",
      action: "Delete",
    },
  },

  /** Exporting a conversation's notes into the source library. See `zh-CN` for the shapes. */
  noteSync: {
    action: "Export notes to the library",
    hint: "Export this conversation's notes as sources. They join the library, and any conversation in this account can reference them.",
    running: "Exporting…",
    done: "{count} note exported | {count} notes exported",
    empty: "This conversation has no notes yet",
    failed: "Export failed",
    stuck: "The last export never finished",
    force: "Force a re-export",
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
    /** The button that opens this dialog — a title/aria-label, drawn as an icon alone. */
    open: "Session parameters (temperature, context length, tool steps…)",
    scopeExisting: "These parameters apply to this conversation only.",
    scopeNew: "No conversation yet, so these apply to the one about to be created.",
    scopeSuffix: " Left blank, each falls back to the global default.",
    name: "Session name",
    namePlaceholder: "For example: Chapter 3 review",
    description: "Session description",
    descriptionPlaceholder: "What is this conversation about?",
    descriptionHint: "For your own reference; never sent to the model.",
    systemPrompt: "System prompt",
    systemPromptPlaceholder: "What should this conversation be?",
    systemPromptHint:
      "This conversation's own. A new conversation copies one in from its Assistant and the two are independent afterwards — editing it here does not change that Copilot.",
    reset: "Reset",
  },

  /**
   * The session write lock: which client may write to a conversation.
   *
   * A domain of its own rather than keys under `session` or `sidebar`, because the same two facts
   * are drawn in three places — the dot on a session row, the banner over the conversation, and
   * the composer's disabled send button — and none of those is where the concept lives.
   * `docs/session-locks.md` is the concept.
   */
  lock: {
    /** The dot's own words, and the row's `title`: this client holds it, so typing works here. */
    mine: "This conversation is being edited from this client — you can send messages",
    /** The other client's dot — orange, and the reason the conversation is read-only here. */
    other: "Another client is editing this conversation, so it is read-only here",
  },

  errors: {
    NAME_REQUIRED: "A name is required.",
    WORKSPACE_NOT_FOUND: "That workspace no longer exists.",
    COPILOT_NOT_FOUND: "That Assistant no longer exists.",
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
    FILE_EXISTS: "That name is already taken — pick another one.",
    PAGE_FETCH_FAILED: "That link could not be kept: {detail}",
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
    NOTE_NOT_FOUND: "That note cannot be found — it may already have been deleted.",
    NOTE_TYPE_INVALID: "That kind of note does not exist.",
    FIGURE_NOT_FOUND: "That diagram or table cannot be found — it may have changed or been deleted.",
    REFERENCE_NOT_FOUND:
      "Something this message refers to is gone — it may have been deleted or changed. Please send it again.",
    SYNC_IN_PROGRESS: "This conversation is already being exported to the library.",
    INSIGHT_NOT_FOUND:
      "That observation cannot be found — a later pass may have replaced it.",
    MESSAGE_NOT_FOUND: "That message cannot be found — it may already have been deleted.",
    MESSAGE_NOT_LAST: "Only the last message can be deleted. Reload the page and try again.",
    NO_REPLY_TO_REGENERATE:
      "There is no reply to regenerate (the last message is not a reply, or it is waiting for your answer).",
    TURN_IN_PROGRESS: "The previous reply is still being generated. Stop it or wait for it to finish.",
    SESSION_LOCKED: "This conversation is being edited from another client, so it is read-only here.",

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
    SUPERADMIN_NOT_GRANTABLE:
      "The superadmin is created by the desktop control panel during setup and cannot be created or assigned here.",
    PANEL_RESET_REQUIRED:
      "A superadmin cannot reset their own password here — do it in the desktop control panel.",
  },

  /**
   * The account's library: every source it holds, whether that arrived as an upload, a page
   * the agent kept, or a file a conversation wrote. See `zh-CN` for the shapes.
   *
   * `delete.detail` carries the part a user cannot guess: that deleting a conversation did
   * *not* delete this file, and which way round the two actions are. Without it, "delete"
   * reads as tidying up something already gone.
   */
  sources: {
    title: "Library",
    loading: "Loading…",
    empty: "Nothing matches these filters.",
    parsed: "Parsed",
    parsedChars: "{count} characters parsed",
    parsing: "Parsing…",
    parseFailed: "Parsing failed",
    preview: "Preview {name}",
    search: "Search",
    searchHint: "Find by name",
    filterWorkspace: "Workspace",
    filterSession: "Conversation",
    filterCategory: "Kind",
    filterOrigin: "Came from",
    filterMime: "MIME type",
    allWorkspaces: "All workspaces",
    allSessions: "All conversations",
    allCategories: "All kinds",
    allOrigins: "Any origin",
    allMimes: "All MIME types",
    viewFlat: "List",
    viewTree: "Tree",
    expandAll: "Expand all",
    collapseAll: "Collapse all",
    add: "Add a source",
    addLinkLabel: "Web address",
    /* The add dialog: one door, a tab per kind. */
    addKind: "Kind of source",
    tabFile: "File",
    tabLink: "Web link",
    addDir: "Folder",
    addDirHint: "Leave empty for the workspace root",
    addFiles: "Files",
    pickFiles: "Choose files",
    addLinkHint: "The server fetches the page and keeps it, so a conversation can reference it later.",
    viewLabel: "View",
    origin: {
      session_attachment: "Attachment",
      workspace_upload: "Uploaded to a workspace",
      agent_workspace: "Written into a workspace",
      agent_session: "Written into a conversation",
      web: "Web page",
      note_export: "Notes you exported",
      discovered: "Found in a folder",
    },
    category: {
      page: "Web page",
      text: "Text",
      markdown: "Markdown",
      code: "Code",
      diagram: "Diagram",
      image: "Image",
      document: "Document",
      other: "Other",
    },
    delete: {
      title: "Delete this file",
      message: "Delete \u201c{name}\u201d?",
      detail: "The file, its extracted text and every reference to it are removed, and this cannot be undone. Messages already sent keep showing the attachment, but it will not open.",
      action: "Delete file",
    },
    /** Leaving the app for the page a web source came from. See `zh-CN` for why it is its own
     *  verb rather than a second reading of `preview`. */
    openInBrowser: "Open in browser",
    openExternal: {
      title: "Opening a third-party site",
      message: "This link goes to an outside site, and following it leaves this app.",
      confirm: "Continue",
    },
    /** The file preview's copy control. See `zh-CN` for why the partial case is worded apart. */
    copyFile: "Copy file contents",
    copyFilePartial: "Copy file contents (large file — only the part that was loaded)",
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
