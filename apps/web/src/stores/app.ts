import { computed, ref } from "vue";
import { defineStore } from "pinia";
import {
  api,
  setUnauthenticatedHandler,
  streamAnswers,
  streamChat,
  fileToBase64,
} from "../api/client";
import { i18n } from "../i18n";
import { translateApiError } from "../utils/apiError";
import { flattenTree } from "../utils/fileTree";
import {
  closeSettings,
  closeSources,
  showLogin,
  showPasswordChange,
  showWorkspaceHome,
  uiState,
} from "../composables/ui";
import { emitWidgetEvent } from "../composables/widgetEvents";
import { WIDGET_MODULES, type WidgetContext } from "../widgets/registry";
import type {
  AskUserAnswers,
  Attachment,
  ChatStreamEvent,
  Copilot,
  CopilotDefaults,
  CopilotVisibility,
  CreateCopilotInput,
  CreateProviderInput,
  DirectoryListing,
  DocumentParserConfig,
  DocumentParserKind,
  DocumentParsingConfig,
  DriverInfo,
  FileContent,
  Message,
  MessageUsage,
  ProviderConfig,
  PublicConfig,
  Session,
  SessionSettings,
  Source,
  ToolCall,
  UpdateProviderInput,
  User,
  WidgetId,
  WidgetScope,
  WidgetState,
  Workspace,
} from "../api/types";
import {
  MAX_ATTACHMENT_BYTES,
  isInteractiveTool,
  isPlatformAdmin,
  PLAN_TOOL_NAMES,
  QUIZ_REVIEW_TOOL_NAME,
  type InteractiveAnswer,
  type QuizAnswer,
  type QuizQuestionView,
} from "../api/types";

interface StreamingState {
  active: boolean;
  content: string;
  /** Chain of thought, arriving before (and between) the visible answer. */
  reasoning: string;
  /** True while reasoning deltas are still arriving. */
  thinking: boolean;
  /** Elapsed thinking time, ticked while thinking and frozen once the answer starts. */
  reasoningMs: number | null;
  toolCalls: ToolCall[];
  usage: MessageUsage | null;
  error: string | null;
  /**
   * A stop has been asked for and the turn has not wound up yet. Client-only: nothing is
   * persisted about it, it exists to keep the button from firing twice.
   */
  stopping: boolean;
}

export interface CopilotDraft {
  id?: string;
  name: string;
  description: string;
  systemPrompt: string;
  /** Authoritative over `tools`, which the server clears when this is true. */
  allTools: boolean;
  tools: string[];
  settings: CopilotDefaults;
  /** Widgets conversations started from this Copilot install, at session scope. */
  widgets: WidgetId[];
  visibility: CopilotVisibility;
}

export interface ProviderDraft {
  id?: string;
  name: string;
  baseURL: string;
  apiKey: string;
  /** Models as edited in the form. `id` present = an existing record. */
  models: {
    id?: string;
    modelId: string;
    name: string;
    contextWindow: number | null;
    maxOutput: number | null;
    capabilities: string[];
  }[];
}

export interface DocumentParserDraft {
  id?: string;
  name: string;
  kind: DocumentParserKind;
  baseURL: string;
  apiKey: string;
  enabled: boolean;
}

/** Whether an attachment is still queued or being read. */
function isSettling(attachment: Attachment): boolean {
  return attachment.parseStatus === "pending" || attachment.parseStatus === "parsing";
}

/**
 * A caught value as something worth showing. `ApiError` already carries a message the user
 * can read — the catalog's sentence for the server's code — so this is only about the
 * non-`Error` throws, which reach here as "[object Object]" if nobody says otherwise.
 */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const EMPTY_STREAMING = (): StreamingState => ({
  active: false,
  content: "",
  reasoning: "",
  thinking: false,
  reasoningMs: null,
  toolCalls: [],
  usage: null,
  error: null,
  stopping: false,
});

export const useAppStore = defineStore("app", () => {
  /* --------------------------------- state --------------------------------- */
  /**
   * The signed-in account, or null before the first answer and after signing out.
   *
   * Held because the UI needs a name to show, because the console's entry point is drawn from
   * `roles`, and because "who am I" is the first question the app asks. It is not the
   * *authority* on anything: every request carries a token the server checks, and a role the
   * server does not grant is a hidden button and nothing more. Clearing this signs nobody out.
   */
  const account = ref<User | null>(null);

  const config = ref<PublicConfig | null>(null);
  /**
   * Every file this account has uploaded, as the sources dialog lists them.
   *
   * Loaded on demand rather than with `init`: it is a page most sessions never open, and the
   * account's whole library is not something to fetch on every cold start.
   */
  const sources = ref<Source[]>([]);
  const sourcesLoading = ref(false);
  /** A load or delete failure, shown inside the dialog — not the global toast. */
  const sourcesError = ref<string | null>(null);

  const workspaces = ref<Workspace[]>([]);
  const copilots = ref<Copilot[]>([]);
  const sessions = ref<Session[]>([]);
  const messages = ref<Message[]>([]);
  /**
   * The widget installs for the two objects the panel can be showing.
   *
   * Both lists are *resolved* by the server — one entry per widget this build knows at that
   * level, `enabled` already settled — so a client-side default for "nothing has decided" would
   * be a second answer to a question that already has one.
   *
   * Kept apart rather than merged because the strip draws them as two groups with a divider, and
   * the group an entry belongs to is not recoverable from its id.
   */
  const workspaceWidgets = ref<WidgetState[]>([]);
  const sessionWidgets = ref<WidgetState[]>([]);

  const activeWorkspaceId = ref<string | null>(null);
  const activeSessionId = ref<string | null>(null);
  const activeCopilotId = ref<string | null>(null);

  /**
   * Settings chosen before a conversation exists. Folded into the session on creation,
   * so the header selectors work on the welcome screen too.
   */
  const draftSettings = ref<SessionSettings>({});

  /** Uploaded-but-not-yet-sent attachments for the composer. */
  const pendingAttachments = ref<Attachment[]>([]);

  /**
   * Live parse state per source id, as the server last reported it.
   *
   * Overlaid on a message's stored snapshots so a reparse is visible in history without a
   * reload. Holds whole `Source` rows rather than a trimmed shape, because the live state and
   * the stored state are the same object read at different moments.
   */
  const parseStatus = ref<Record<string, Source>>({});

  /** The protocol kinds the server implements, for the parser settings form. */
  const parserKinds = ref<DriverInfo[]>([]);

  /**
   * Timer behind the attachment parse badges.
   *
   * Extraction is asynchronous on the server, so the composer has to poll for it. Polling
   * only runs while something is actually settling and stops as soon as everything has —
   * an idle conversation must not keep asking.
   */
  let parsePoll: ReturnType<typeof setInterval> | null = null;

  /** Attachment ids whose re-parse was asked for but has not yet settled. */
  const markingParsing = ref(new Set<string>());

  /**
   * Ticker behind the "思考中 · 3.2s" label. Lives in the store rather than the component
   * so there is exactly one interval regardless of how many reasoning blocks render.
   */
  let reasoningStartedAt: number | null = null;
  let reasoningTicker: ReturnType<typeof setInterval> | null = null;

  function startReasoningTicker() {
    if (reasoningTicker !== null || reasoningStartedAt === null) return;
    reasoningTicker = setInterval(() => {
      if (reasoningStartedAt !== null) {
        streaming.value.reasoningMs = Date.now() - reasoningStartedAt;
      }
    }, 200);
  }

  function stopReasoningTicker() {
    if (reasoningTicker !== null) {
      clearInterval(reasoningTicker);
      reasoningTicker = null;
    }
    reasoningStartedAt = null;
    streaming.value.thinking = false;
  }

  const streaming = ref<StreamingState>(EMPTY_STREAMING());
  const error = ref<string | null>(null);

  /* ------------------------------ file browser ------------------------------ */

  /**
   * The workspace's file tree, held here rather than inside the component.
   *
   * The tree is domain state, not a widget's private business: it is filled from the API,
   * it is invalidated by something that happens elsewhere (a turn that wrote files), and it
   * is the one part of this feature a unit test can reach — components in this project are
   * covered by Playwright and nothing else.
   *
   * Listings are keyed by the directory's workspace-relative path, `""` for the root, and a
   * directory is fetched when it is first expanded. Nothing is recursive: a workspace with a
   * `node_modules` in it costs one `readdir` until someone actually opens it.
   */
  const fileListings = ref<Record<string, DirectoryListing>>({});
  /** Directories the user has opened, by path. Order is irrelevant; membership is not. */
  const fileExpanded = ref<string[]>([]);
  /** The directory whose listing is in flight, or null. One at a time — it is a click. */
  const fileLoadingPath = ref<string | null>(null);
  /**
   * A listing failure, shown in the tree pane.
   *
   * Its own slot rather than the global toast: the failure belongs to the panel the user is
   * looking at, and a toast is the app-wide channel for a failed *action*. The preview's
   * failures are separate again, for the same reason — see `filePreviewError`.
   */
  const fileTreeError = ref<string | null>(null);

  /** The file the preview dialog is showing, or null when it is closed. */
  const filePreviewPath = ref<string | null>(null);
  const fileContent = ref<FileContent | null>(null);
  const fileContentLoading = ref(false);
  const filePreviewError = ref<string | null>(null);

  /** The visible rows, depth-first — see `utils/fileTree.ts` for the walk. */
  const fileRows = computed(() => flattenTree(fileListings.value, fileExpanded.value));

  /**
   * How many entries the first truncated listing is showing, or null when none is.
   *
   * The count comes from the listing rather than from a constant the client would have to
   * keep in step with the server: what the user needs to know is how much they are looking
   * at, and that number is already in the reply.
   */
  const fileTruncatedAt = computed<number | null>(() => {
    for (const path of ["", ...fileExpanded.value]) {
      const listing = fileListings.value[path];
      if (listing?.truncated) return listing.entries.length;
    }
    return null;
  });

  /* ------------------------------- derived --------------------------------- */
  const activeWorkspace = computed(
    () => workspaces.value.find((w) => w.id === activeWorkspaceId.value) ?? null
  );
  const activeSession = computed(
    () => sessions.value.find((s) => s.id === activeSessionId.value) ?? null
  );
  /**
   * The label for the active conversation's persona, or null when it has none.
   *
   * Read from the *session*, not by looking the Copilot up in the list — the conversation
   * copied the name at creation, so the badge still says "Tutor" after that Copilot was
   * renamed or deleted, and it works for a Copilot another account published. A lookup in
   * `copilots` would show nothing in exactly those cases.
   */
  const activeCopilotName = computed(() => activeSession.value?.copilotName || null);

  /**
   * Whether the console is worth offering this account.
   *
   * Derived here rather than compared at each of the three places that draw an entry point —
   * the home page's header, the sidebar's menu and the account page — because the two tiers are
   * an *addition* and a check written as `roles.includes("superadmin")` at one of the three is
   * how an ordinary administrator ends up with a console they can reach from two buttons and not
   * from the third. `isPlatformAdmin` is the shared spelling of the rule the server enforces.
   *
   * Still not a permission: it decides whether a button is drawn, and the routes answer 403 for
   * anybody else regardless.
   */
  const canAdmin = computed(() => (account.value ? isPlatformAdmin(account.value) : false));

  /**
   * The Copilot list, split into the two groups the UI shows.
   *
   * A clean partition on ownership, so nothing appears twice: everything this account owns is
   * "mine" whatever its visibility, and whatever is left is another account's public Copilot —
   * the server returns nothing else. One's own published Copilots belonging under "mine" is the
   * point: that is where the switch to unpublish them lives.
   */
  const myCopilots = computed(() =>
    copilots.value.filter((c) => c.userId === account.value?.id)
  );
  /** Another account's public Copilots. Usable and copyable; never editable. */
  const publicCopilots = computed(() =>
    copilots.value.filter((c) => c.userId !== account.value?.id)
  );

  /** The active conversation's own prompt, which is what the persona badge explains. */
  const activeSystemPrompt = computed(() => activeSession.value?.systemPrompt ?? "");

  /**
   * The parameters actually in force. Mirrors the server's resolution order exactly:
   * session → app default. A candidate only wins when it still resolves, so a deleted
   * provider degrades instead of showing a broken selection.
   *
   * The Copilot tier that used to sit between those two is gone from here as well as from the
   * server: its defaults were merged into the session's settings when the conversation was
   * created, so consulting the Copilot would be reading the same values twice — and reading
   * them from a record that is now allowed to have been deleted since.
   */
  const sessionSettings = computed<SessionSettings>(
    () => activeSession.value?.settings ?? draftSettings.value
  );

  const currentProviderId = computed(() => {
    const candidates = [
      sessionSettings.value.providerId,
      config.value?.defaultProvider,
    ];
    for (const c of candidates) {
      if (c && config.value?.providers.some((p) => p.id === c)) return c;
    }
    return config.value?.providers[0]?.id ?? "";
  });

  const currentProvider = computed(() =>
    config.value?.providers.find((p) => p.id === currentProviderId.value)
  );

  const modelOptions = computed(() => currentProvider.value?.models ?? []);

  const effectiveModelId = computed(() => {
    const provider = currentProvider.value;
    if (!provider) return "";
    const known = new Set(provider.models.map((m) => m.modelId));
    const candidates = [
      sessionSettings.value.modelId,
      config.value?.defaultModel,
    ];
    for (const c of candidates) {
      if (c && known.has(c)) return c;
    }
    return provider.models[0]?.modelId ?? "";
  });

  const effectiveModel = computed(
    () => modelOptions.value.find((m) => m.modelId === effectiveModelId.value) ?? null
  );

  /** Whether the effective model accepts image input — drives the composer's warning. */
  const supportsVision = computed(
    () => effectiveModel.value?.capabilities.includes("vision") ?? false
  );

  /** Context window of the effective model, for the token popover. */
  const contextWindow = computed(() => effectiveModel.value?.contextWindow ?? null);

  /** Context used by the last completed assistant turn. */
  const contextTokens = computed(() => {
    for (let i = messages.value.length - 1; i >= 0; i--) {
      const usage = messages.value[i]?.usage;
      if (usage?.contextTokens) return usage.contextTokens;
    }
    return 0;
  });

  /*
   * The installed widgets, as ids. `enabled` is the whole question the strip asks, so the lists
   * the panel and the layout read are these rather than the `WidgetState[]` behind them — the
   * same reason `sidebarRail` is derived once instead of tested at each of its two readers.
   *
   * `enabledWidgetIds` is the concatenation *in group order*, which is what makes "workspace
   * first, then session" a property of the data rather than of the render.
   */
  const workspaceWidgetIds = computed(() =>
    workspaceWidgets.value.filter((w) => w.enabled).map((w) => w.id)
  );
  const sessionWidgetIds = computed(() =>
    sessionWidgets.value.filter((w) => w.enabled).map((w) => w.id)
  );
  /** Whether the panel exists at all: it is shown only when something is installed. */
  const enabledWidgetIds = computed(() => [
    ...workspaceWidgetIds.value,
    ...sessionWidgetIds.value,
  ]);

  const isConfigured = computed(() => !!config.value?.providers.some((p) => p.hasApiKey));

  /**
   * True while any pending attachment is still being extracted.
   *
   * The composer blocks sending until this clears. Sending anyway would produce a turn
   * where the model never saw the document the user believes they attached — and because
   * the text is injected at send time, it would never appear later either.
   */
  const documentsParsing = computed(() => pendingAttachments.value.some(isSettling));

  /* ------------------------------- actions --------------------------------- */
  function setError(message: string | null) {
    error.value = message;
  }

  function replaceSession(updated: Session) {
    const idx = sessions.value.findIndex((s) => s.id === updated.id);
    if (idx !== -1) sessions.value[idx] = updated;
  }

  /**
   * Bumped whenever the signed-in account goes away.
   *
   * A turn already in flight outlives the account that started it: signing out does not close
   * the stream, and its later deltas would otherwise be applied to whatever state the *next*
   * account has by then — one person's reply text appearing in another's conversation. Not
   * reactive, because nothing renders it: it exists to be compared inside `consume`.
   */
  let accountEpoch = 0;

  /**
   * Drop everything that belonged to the account that was signed in.
   *
   * Called on sign-out and on an expired session, and it is deliberately total: a name, a
   * workspace list or a half-written conversation left on screen after someone signs out is
   * the next person's problem, and on a shared machine it is a real one. Bumping the epoch is
   * what makes it total for a turn that is still arriving too.
   */
  function forgetAccount(): void {
    accountEpoch += 1;
    account.value = null;
    config.value = null;
    sources.value = [];
    sourcesLoading.value = false;
    sourcesError.value = null;
    workspaces.value = [];
    copilots.value = [];
    sessions.value = [];
    messages.value = [];
    // The installs belong to the objects, so they go with them — an uninstalled-but-still-listed
    // widget would keep the panel on screen for whoever signs in next.
    workspaceWidgets.value = [];
    sessionWidgets.value = [];
    activeWorkspaceId.value = null;
    activeSessionId.value = null;
    activeCopilotId.value = null;
    draftSettings.value = {};
    pendingAttachments.value = [];
    parseStatus.value = {};
    // The half-arrived reply is as much a part of the account as the messages are, and the
    // login screen has no business showing either.
    streaming.value = EMPTY_STREAMING();
    resetFileTree();
    closeSettings();
    closeSources();
  }

  /**
   * Work out who is asking, then load the app for them — or show the sign-in screen.
   *
   * One question, because there is only one left to ask: the installation always has an
   * administrator by the time anything can reach this page — the server refuses to listen
   * without one — so there is no "nobody can sign in yet" state for a cold load to discover.
   * What the administrator is created by is the control panel, not this app.
   *
   * `me()` answering 401 is the ordinary "nobody is signed in" case rather than a failure,
   * which is why it is caught here instead of reaching the toast.
   *
   * `authReady` is set before either branch, and that ordering is the whole reason the flag
   * exists: rendering the sign-in screen first would flash it at someone already signed in, on
   * every single refresh.
   */
  async function init(): Promise<void> {
    try {
      account.value = await api.me();
    } catch {
      account.value = null;
    }

    uiState.authReady = true;
    if (!account.value) {
      showLogin();
      return;
    }
    await enterApp();
  }

  /**
   * Everything a signed-in account gets, or the one screen it still owes first.
   *
   * The password check is not a courtesy to the server. A password an administrator generated
   * is one the account was told to replace, and the server refuses every other route until it
   * is — so loading the app behind the screen would be a workspace list of failing requests.
   * The screen comes first and the app follows it.
   */
  async function enterApp(): Promise<void> {
    if (account.value?.mustChangePassword) {
      showPasswordChange();
      return;
    }
    showWorkspaceHome();
    await loadApp();
  }

  /** Everything that needs a session. The half of `init` that a signed-out user must not run. */
  async function loadApp(): Promise<void> {
    config.value = await api.getConfig();
    workspaces.value = await api.listWorkspaces();
    if (workspaces.value.length === 0) {
      await createWorkspace("Default");
    }
    copilots.value = await api.listCopilots();
    if (!activeWorkspaceId.value) activeWorkspaceId.value = workspaces.value[0]!.id;
    await loadSessions();
  }

  /**
   * Sign in with a name and a password.
   *
   * The stored token pair is `api.login`'s business, not this function's — see `requestAuth`.
   * What is left here is the account and where to go next.
   */
  async function signIn(username: string, password: string): Promise<void> {
    const result = await api.login(username.trim(), password);
    account.value = result.user;
    uiState.authReady = true;
    error.value = null;
    await enterApp();
  }

  /**
   * Change the signed-in account's own password.
   *
   * Answers with a fresh pair, which `api.changePassword` stores — it has to, because the
   * change ends every session the account held including this one. The caller says where to go
   * afterwards: the forced screen enters the app, the account page stays where it is.
   */
  async function changePassword(oldPassword: string, newPassword: string): Promise<void> {
    const result = await api.changePassword(oldPassword, newPassword);
    account.value = result.user;
  }

  /**
   * Sign out, and land on the login screen whatever the server says.
   *
   * The cookie is HttpOnly, so clearing it is the server's job and a logout that fails cannot
   * be retried locally — but leaving someone looking signed in because a request failed is
   * worse than the reverse. So the local state goes either way and the failure is reported
   * rather than swallowed: the cookie is still there, and a reload will sign them back in,
   * which is exactly the kind of thing to say out loud rather than let them discover.
   */
  async function signOut(): Promise<void> {
    let failure: unknown;
    try {
      await api.logout();
    } catch (e) {
      failure = e;
    }
    forgetAccount();
    showLogin();
    if (failure) error.value = messageOf(failure);
  }

  /**
   * What a 401 from anywhere means: the session went away under us.
   *
   * A toast *and* the login screen. The screen alone reads as the app having forgotten
   * something, and the toast alone leaves the user looking at a page none of whose controls
   * will work. Registered here rather than in `client.ts` because the client would have to
   * import the store to know any of this, and the two would circle.
   */
  setUnauthenticatedHandler(() => {
    forgetAccount();
    showLogin();
    // Through the code, not a message of its own: the server sends UNAUTHENTICATED for
    // exactly this, and one sentence in the catalog is one place to keep it right.
    setError(translateApiError("UNAUTHENTICATED", undefined, undefined));
  });

  async function refreshConfig(): Promise<void> {
    config.value = await api.getConfig();
  }

  async function loadSessions(): Promise<void> {
    if (!activeWorkspaceId.value) {
      sessions.value = [];
      return;
    }
    sessions.value = await api.listSessions(activeWorkspaceId.value);
  }

  async function selectWorkspace(id: string): Promise<void> {
    activeWorkspaceId.value = id;
    activeSessionId.value = null;
    activeCopilotId.value = null;
    draftSettings.value = {};
    messages.value = [];
    // The conversation being left had its own installs, and they belong to it.
    sessionWidgets.value = [];
    resetFileTree();
    // Both are reads of the same workspace and neither needs the other, so they go together
    // rather than as two round trips on every switch.
    await Promise.all([loadSessions(), loadWorkspaceWidgets()]);
    // After the reads, so a widget that reacts by fetching sees the workspace it is now in
    // rather than the one that was there a moment ago.
    emitWidgetEvent({ type: "workspace.selected", workspaceId: id });
  }

  /**
   * Create a workspace, optionally with widgets already chosen.
   *
   * The selection is a parameter rather than a follow-up call because a workspace does not exist
   * when its boxes are ticked — so this is the one write that carries them all, and it is what
   * makes installing a widget a moment rather than a sequence of flips.
   */
  async function createWorkspace(name: string, widgets?: WidgetId[]): Promise<void> {
    const ws = await api.createWorkspace(name, widgets);
    workspaces.value.push(ws);
    if (!activeWorkspaceId.value) {
      activeWorkspaceId.value = ws.id;
      await loadWorkspaceWidgets();
    }
    /*
     * The newly installed widgets are told, which is one of the two moments the lifecycle is
     * defined at: a **created object's** installs are initialised here, and a *later* install is
     * initialised by `setWidgetEnabled`. The whole selection is chosen before the workspace
     * exists, so this is the only place it can happen.
     *
     * The list passed is the one that was asked for, and that is exactly the installed set: the
     * create route writes a row for every widget that differs from the default, so with an empty
     * default set the two are the same list. `undefined` — a caller with no opinion — installs the
     * defaults, which are also empty today; the day they are not, this is the line that has to
     * read the resolved list instead.
     */
    await runInstallHooks("workspace", ws.id, widgets ?? []);
  }

  /**
   * Re-read the workspace list, refreshing each card's conversation count and last activity.
   *
   * Called on the way back to the workspace home rather than kept in sync as conversations
   * come and go: the counts are only ever looked at on that page, and a client-side
   * incrementing counter would be a second source of truth to get wrong every time a turn
   * is deleted, a session is renamed, or a second tab is open. Deliberately leaves
   * `activeWorkspaceId` alone — the user is on their way somewhere, not arriving.
   */
  async function refreshWorkspaces(): Promise<void> {
    workspaces.value = await api.listWorkspaces();
  }

  /* ------------------------------ file browser ------------------------------ */

  /**
   * Forget the tree. The paths in it belong to the workspace being left, so keeping any of
   * them would show one workspace's files under another's name — and an open preview would
   * outlive the file it is showing.
   */
  function resetFileTree(): void {
    fileListings.value = {};
    fileExpanded.value = [];
    fileLoadingPath.value = null;
    fileTreeError.value = null;
    closeFile();
  }

  /**
   * Read one directory, and remember it. Returns whether it arrived.
   *
   * Reports its own failure into `fileTreeError` rather than throwing, because every caller
   * wants the same thing done with it: shown in the panel the user is looking at. The one
   * caller that does *not* want it reported is the post-turn re-read, and that one goes
   * through `refreshFileTree`, which has the silent flag.
   *
   * A listing that is already cached is reused, which is what makes collapsing and reopening a
   * directory free. Re-reading on demand is `refreshFileTree`, which is deliberately not this.
   */
  async function loadDirectory(path: string): Promise<boolean> {
    const workspaceId = activeWorkspaceId.value;
    if (!workspaceId) return false;
    if (fileListings.value[path]) return true;

    fileLoadingPath.value = path;
    try {
      const listing = await api.listFiles(workspaceId, path);
      /*
       * Dropped if the workspace changed while this was in flight. The paths in a listing are
       * relative to the workspace that answered, so writing one into a tree the user has
       * since switched away from would show one workspace's files under another's name — and
       * `selectWorkspace` has already cleared the tree by then, so this would be resurrecting
       * it rather than appending to it.
       */
      if (activeWorkspaceId.value !== workspaceId) return false;
      fileListings.value = { ...fileListings.value, [listing.path]: listing };
      fileTreeError.value = null;
      return true;
    } catch (e) {
      fileTreeError.value = messageOf(e);
      return false;
    } finally {
      fileLoadingPath.value = null;
    }
  }

  /**
   * Open or close a directory. Opening fetches it the first time; closing only folds it
   * away, leaving the listing cached so reopening does not go back to the server.
   *
   * A directory whose fetch failed is closed again rather than left open and empty: an empty
   * expanded directory is indistinguishable from a directory that really is empty, which is
   * the one thing a failure must not look like.
   */
  async function toggleDirectory(path: string): Promise<void> {
    if (fileExpanded.value.includes(path)) {
      fileExpanded.value = fileExpanded.value.filter((p) => p !== path);
      return;
    }

    fileTreeError.value = null;
    fileExpanded.value = [...fileExpanded.value, path];
    if (!(await loadDirectory(path))) {
      fileExpanded.value = fileExpanded.value.filter((p) => p !== path);
    }
  }

  /**
   * Re-read the root and every directory the user has open.
   *
   * This is the whole refresh story, and it is deliberately shallow: it re-reads what is on
   * screen, not the workspace. Anything deeper is unopened and will be fetched when it is.
   *
   * `silent` is the post-turn re-read. It reports nothing, because a turn that wrote files
   * is not a turn that was *about* the file browser — a failure there is a server problem
   * the user did not ask about, and a toast for it would interrupt a conversation that
   * worked. It also does nothing at all when the tree was never opened.
   */
  async function refreshFileTree(options: { silent?: boolean } = {}): Promise<void> {
    const workspaceId = activeWorkspaceId.value;
    if (!workspaceId) return;
    if (options.silent && fileListings.value[""] === undefined) return;

    const targets = ["", ...fileExpanded.value];
    fileLoadingPath.value = "";
    try {
      const listings = await Promise.all(targets.map((path) => api.listFiles(workspaceId, path)));
      // Same guard as `loadDirectory`: a refresh that outlived its workspace must not land.
      if (activeWorkspaceId.value !== workspaceId) return;
      const next = { ...fileListings.value };
      for (const listing of listings) next[listing.path] = listing;
      fileListings.value = next;
      fileTreeError.value = null;
    } catch (e) {
      if (!options.silent) fileTreeError.value = messageOf(e);
    } finally {
      fileLoadingPath.value = null;
    }
  }

  /**
   * Open a file in the preview.
   *
   * Unlike the rest of the store's actions this one reports its own failure instead of
   * throwing, because its caller is a dialog that is already open: the error has one
   * obvious home, and it is the body of the thing the user just asked for.
   */
  async function openFile(path: string): Promise<void> {
    const workspaceId = activeWorkspaceId.value;
    if (!workspaceId) return;

    filePreviewPath.value = path;
    fileContent.value = null;
    filePreviewError.value = null;
    fileContentLoading.value = true;
    try {
      fileContent.value = await api.readFileContent(workspaceId, path);
    } catch (e) {
      filePreviewError.value = messageOf(e);
    } finally {
      fileContentLoading.value = false;
    }
  }

  function closeFile(): void {
    filePreviewPath.value = null;
    fileContent.value = null;
    filePreviewError.value = null;
    fileContentLoading.value = false;
  }

  async function renameWorkspace(id: string, name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) return;
    const updated = await api.renameWorkspace(id, trimmed);
    const idx = workspaces.value.findIndex((w) => w.id === updated.id);
    if (idx !== -1) workspaces.value[idx] = updated;
  }

  async function deleteWorkspace(id: string): Promise<void> {
    await api.deleteWorkspace(id);
    workspaces.value = workspaces.value.filter((w) => w.id !== id);
    if (activeWorkspaceId.value === id) {
      activeWorkspaceId.value = workspaces.value[0]?.id ?? null;
      activeSessionId.value = null;
      messages.value = [];
      sessionWidgets.value = [];
      await loadSessions();
      // The next workspace may have its own installs; leaving the deleted one's would show a
      // panel for widgets nothing claims.
      if (activeWorkspaceId.value) await loadWorkspaceWidgets();
      else workspaceWidgets.value = [];
    }
  }

  /**
   * Open a conversation.
   *
   * The widgets come from the same reply as the messages, in one request: the read answers both
   * groups, so the strip and the transcript arrive together rather than the strip filling in a
   * moment later.
   */
  async function selectSession(id: string): Promise<void> {
    activeSessionId.value = id;
    activeCopilotId.value = activeSession.value?.copilotId ?? null;
    const [loaded, widgets] = await Promise.all([
      api.listMessages(id),
      api.listSessionWidgets(id),
    ]);
    messages.value = loaded;
    workspaceWidgets.value = widgets.workspace;
    sessionWidgets.value = widgets.session;
    pendingAttachments.value = [];
    streaming.value = EMPTY_STREAMING();
  }

  /**
   * Start a conversation.
   *
   * The parameters and the widgets go in the **create** request rather than a `PATCH` afterwards.
   * The two-step that used to be here left a window in which the conversation existed with
   * parameters nobody chose, and — the half that is observable — a failure between the calls left
   * it that way for good.
   *
   * `settings` defaults to the staged `draftSettings`, which is what the welcome screen's
   * settings dialog writes into; the new-session dialog passes its own draft instead. Null values
   * are dropped rather than sent, because `null` means "inherit" and the server's merge would
   * take it literally as "unset this" over the Copilot's copied value.
   */
  async function createSession(
    options: { copilotId?: string | null; settings?: SessionSettings; widgets?: WidgetId[] } = {}
  ): Promise<Session | null> {
    if (!activeWorkspaceId.value) return null;
    const workspaceId = activeWorkspaceId.value;
    const staged = Object.entries(options.settings ?? draftSettings.value).filter(
      ([, v]) => v != null
    );
    const created = await api.createSession(workspaceId, {
      copilotId: options.copilotId ?? activeCopilotId.value ?? null,
      ...(staged.length ? { settings: Object.fromEntries(staged) } : {}),
      // `[]` is a decision and is sent as one — it means "none", and omitting it would fall
      // through to the Copilot's selection instead. Only `undefined` leaves the choice open.
      ...(options.widgets !== undefined ? { widgets: options.widgets } : {}),
    });
    draftSettings.value = {};
    sessions.value = [created, ...sessions.value.filter((s) => s.id !== created.id)];
    await selectSession(created.id);
    // After `selectSession`, so the list is the server's resolved answer rather than the request's
    // — a Copilot's selection is copied in by the server, and this call may have named no widgets
    // of its own at all.
    await runInstallHooks("session", created.id, sessionWidgets.value.filter((w) => w.enabled).map((w) => w.id));
    emitWidgetEvent({ type: "session.created", workspaceId, sessionId: created.id });
    return created;
  }

  async function renameSession(id: string, title: string): Promise<void> {
    const trimmed = title.trim();
    if (!trimmed) return;
    const updated = await api.updateSession(id, { title: trimmed });
    replaceSession(updated);
    // Announced because a widget that lists conversations shows the title, and the *server* is
    // where the new one was settled.
    emitWidgetEvent({ type: "session.renamed", sessionId: id, title: updated.title });
  }

  /* --------------------------------- widgets --------------------------------- */

  async function loadWorkspaceWidgets(): Promise<void> {
    const workspaceId = activeWorkspaceId.value;
    if (!workspaceId) {
      workspaceWidgets.value = [];
      return;
    }
    workspaceWidgets.value = await api.listWorkspaceWidgets(workspaceId);
  }

  /**
   * Install or uninstall one widget, then run its lifecycle hook, and answer the new state.
   *
   * The hook runs **after** the write: by the time it is called the user's action has already done
   * what they asked, so a hook that throws cannot report a failure — nor undo the state the server
   * now holds. It is logged instead, and a widget whose *data* fails says so inside its own panel,
   * which is the split `fileTreeError` and `filePreviewError` already make.
   *
   * No once-only guard on the hooks: install / uninstall / install on the same object is
   * supported, and re-firing `onInstall` is exactly what "initialise the instance" means.
   *
   * The reply is returned because a caller may be holding its own copy of the rows. The workspace
   * settings dialog is one: it can be opened for a workspace that is not the active one, so it
   * keeps its own list rather than borrowing this module's — and it is that list, not this one,
   * that has to be patched.
   */
  async function setWidgetEnabled(
    scope: WidgetScope,
    scopeId: string,
    widgetId: WidgetId,
    enabled: boolean
  ): Promise<WidgetState> {
    const state =
      scope === "workspace"
        ? await api.setWorkspaceWidget(scopeId, widgetId, enabled)
        : await api.setSessionWidget(scopeId, widgetId, enabled);

    /*
     * Patch the shared list **only when it is about this object**. These two lists belong to the
     * active workspace and the active conversation; writing a foreign id into them would put one
     * workspace's installs on another's panel, which is the same failure as reading them from the
     * wrong place.
     */
    const isActive =
      scope === "workspace"
        ? scopeId === activeWorkspaceId.value
        : scopeId === activeSessionId.value;
    if (isActive) {
      const list = scope === "workspace" ? workspaceWidgets : sessionWidgets;
      const idx = list.value.findIndex((w) => w.id === state.id);
      if (idx === -1) list.value = [...list.value, state];
      else list.value[idx] = state;
    }

    await runWidgetHook(enabled ? "onInstall" : "onUninstall", { scope, scopeId, widgetId });
    // From the reply rather than composed locally, so a caller renders the record rather than
    // what this function believed it asked for.
    return state;
  }

  /**
   * Run a widget's lifecycle hook, swallowing whatever it throws.
   *
   * Swallowed rather than reported, and the ordering is what makes that honest: the record is
   * committed by now, so a toast would read as "the install failed" when it did not. A hook that
   * threw is a defect in a built-in widget that no user action can fix, so it is logged for the
   * developer who wrote it.
   */
  async function runWidgetHook(
    kind: "onInstall" | "onUninstall",
    ctx: WidgetContext
  ): Promise<void> {
    const hook = WIDGET_MODULES[ctx.widgetId]?.[kind];
    if (!hook) return;
    try {
      await hook(ctx);
    } catch (err) {
      console.warn(`[widgets] ${ctx.widgetId}.${kind} threw`, err);
    }
  }

  /**
   * Announce a whole selection that was installed by an object's *creation*.
   *
   * The other half of the lifecycle, and the reason it is a separate function rather than a loop
   * at each call site: a create installs a set in one write, so there is no per-widget moment for
   * `setWidgetEnabled` to hook into. Sequential rather than `Promise.all` — a widget's setup is
   * its own business, and running several at once would make their relative order depend on
   * timing for no benefit.
   */
  async function runInstallHooks(
    scope: WidgetScope,
    scopeId: string,
    widgetIds: WidgetId[]
  ): Promise<void> {
    for (const widgetId of widgetIds) {
      await runWidgetHook("onInstall", { scope, scopeId, widgetId });
    }
  }

  /**
   * Write generation parameters. Before a conversation exists the values are staged
   * locally and applied when the session is created.
   */
  async function updateSettings(partial: SessionSettings): Promise<void> {
    const session = activeSession.value;
    if (!session) {
      draftSettings.value = { ...draftSettings.value, ...partial };
      return;
    }
    const updated = await api.updateSession(session.id, { settings: partial });
    replaceSession(updated);
  }

  async function deleteSession(id: string): Promise<void> {
    const workspaceId = activeWorkspaceId.value;
    await api.deleteSession(id);
    sessions.value = sessions.value.filter((s) => s.id !== id);
    if (activeSessionId.value === id) {
      activeSessionId.value = null;
      activeCopilotId.value = null;
      messages.value = [];
      pendingAttachments.value = [];
      // Its installs go with it, or the strip would keep offering a conversation that is gone.
      sessionWidgets.value = [];
    }
    if (workspaceId) emitWidgetEvent({ type: "session.deleted", workspaceId, sessionId: id });
  }

  /**
   * Pick a model from the composer's picker. Provider and model move together: a model id
   * is only meaningful inside its own provider, so setting one without the other would
   * leave the session pointing at a model its provider does not serve.
   */
  function setProviderAndModel(providerId: string, modelId: string): void {
    void updateSettings({ providerId, modelId });
  }

  /**
   * Change a conversation's own persona.
   *
   * This is what replaced the mid-turn Copilot switch. There is deliberately no way to
   * re-point a conversation at a Copilot: the persona is a copy, so moving the link would
   * move the label and leave the behaviour behind.
   */
  async function updateSessionPrompt(systemPrompt: string): Promise<void> {
    const session = activeSession.value;
    if (!session) return;
    replaceSession(await api.updateSession(session.id, { systemPrompt }));
  }

  /* ------------------------------ copilots --------------------------------- */
  async function saveCopilot(draft: CopilotDraft): Promise<void> {
    const payload: CreateCopilotInput = {
      name: draft.name,
      description: draft.description,
      systemPrompt: draft.systemPrompt,
      allTools: draft.allTools,
      tools: draft.tools,
      settings: draft.settings,
      widgets: draft.widgets,
      visibility: draft.visibility,
    };
    if (draft.id) {
      const updated = await api.updateCopilot(draft.id, payload);
      const idx = copilots.value.findIndex((c) => c.id === updated.id);
      if (idx !== -1) copilots.value[idx] = updated;
    } else {
      const created = await api.createCopilot(payload);
      copilots.value.push(created);
    }
  }

  async function deleteCopilot(id: string): Promise<void> {
    await api.deleteCopilot(id);
    copilots.value = copilots.value.filter((c) => c.id !== id);
    if (activeCopilotId.value === id) activeCopilotId.value = null;
    // Conversations started from it keep working and keep its name — that is the point of the
    // snapshot, so nothing here reaches into `sessions`.
  }

  /**
   * Fork a Copilot into an editable copy of one's own — the escape hatch from "you may use it
   * but not edit it", and the only thing to do with a public Copilot someone else wrote.
   *
   * A plain copy with no link back, exactly as a conversation copies a Copilot: later edits to
   * the original must not propagate. Private on creation, because publishing under your own
   * name is a decision rather than a side effect of forking.
   */
  async function copyCopilotToMine(id: string): Promise<void> {
    const source = copilots.value.find((c) => c.id === id);
    if (!source) return;
    const created = await api.createCopilot({
      name: source.name,
      description: source.description,
      systemPrompt: source.systemPrompt,
      // The tool *restriction* has to come across with the prompt: a fork that copied the
      // persona but silently widened the tools would be a different Copilot wearing its name.
      allTools: source.allTools,
      tools: [...source.tools],
      settings: { ...source.settings },
      visibility: "private",
    });
    copilots.value.push(created);
  }

  /* ------------------------------ providers -------------------------------- */
  function applyProvider(updated: ProviderConfig) {
    const providers = config.value?.providers ?? [];
    const idx = providers.findIndex((p) => p.id === updated.id);
    if (idx !== -1) providers[idx] = updated;
    else providers.push(updated);
    if (config.value) config.value.providers = providers;
  }

  async function saveProvider(draft: ProviderDraft): Promise<void> {
    const models = draft.models
      .filter((m) => m.modelId.trim())
      .map((m) => ({
        id: m.id,
        modelId: m.modelId.trim(),
        name: m.name.trim() || m.modelId.trim(),
        contextWindow: m.contextWindow,
        maxOutput: m.maxOutput,
        capabilities: m.capabilities as ProviderConfig["models"][number]["capabilities"],
      }));

    const input: CreateProviderInput = {
      name: draft.name.trim(),
      baseURL: draft.baseURL.trim(),
      // Omit entirely when blank so the server keeps the stored key untouched.
      ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
      models,
    };

    const updated = draft.id
      ? await api.updateProvider(draft.id, input as UpdateProviderInput)
      : await api.createProvider(input);
    applyProvider(updated);
  }

  async function deleteProvider(id: string): Promise<void> {
    await api.deleteProvider(id);
    if (config.value) {
      config.value.providers = config.value.providers.filter((p) => p.id !== id);
    }
    await refreshConfig();
  }

  async function deleteModel(providerId: string, modelId: string): Promise<void> {
    applyProvider(await api.deleteModel(providerId, modelId));
  }

  async function setDefaults(input: { providerId?: string; modelId?: string }): Promise<void> {
    config.value = await api.updateDefaults(input);
  }

  /* -------------------------- document parsers ----------------------------- */
  function applyDocumentParser(updated: DocumentParserConfig) {
    if (!config.value) return;
    const parsers = config.value.documentParsers;
    const idx = parsers.findIndex((p) => p.id === updated.id);
    if (idx !== -1) parsers[idx] = updated;
    else parsers.push(updated);
  }

  /** The protocol kinds, fetched once — the "add a parser" form is built from them. */
  async function loadParserKinds(): Promise<void> {
    if (parserKinds.value.length > 0) return;
    parserKinds.value = await api.listParserKinds();
  }

  async function saveDocumentParser(draft: DocumentParserDraft): Promise<void> {
    const input = {
      name: draft.name.trim(),
      kind: draft.kind,
      baseURL: draft.baseURL.trim(),
      enabled: draft.enabled,
      // Omit entirely when blank so the server keeps the stored key untouched.
      ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
    };

    const updated = draft.id
      ? await api.updateDocumentParser(draft.id, input)
      : await api.createDocumentParser(input);
    applyDocumentParser(updated);
  }

  async function deleteDocumentParser(id: string): Promise<void> {
    await api.deleteDocumentParser(id);
    if (config.value) {
      config.value.documentParsers = config.value.documentParsers.filter((p) => p.id !== id);
    }
    await refreshConfig();
  }

  /** Round-trip a throwaway document through a parser. Throws with the reason on failure. */
  async function testDocumentParser(id: string): Promise<void> {
    await api.testDocumentParser(id);
  }

  async function setDocumentParsing(
    input: Partial<DocumentParsingConfig>
  ): Promise<void> {
    const updated = await api.updateDocumentParsing(input);
    if (config.value) config.value.documentParsing = updated;
  }

  /* ----------------------------- attachments ------------------------------- */
  function stopParsePolling(): void {
    if (parsePoll !== null) {
      clearInterval(parsePoll);
      parsePoll = null;
    }
  }

  /**
   * Fold freshly polled parse state onto the staged attachments and the live map.
   *
   * The polled object is a **source** — the server's own row for the file — which is why the
   * map holds sources rather than a smaller ad-hoc shape: the live state and the stored state
   * are the same thing, read at different moments.
   */
  function mergeParseStatus(sources: Source[]): void {
    const byId = new Map(sources.map((s) => [s.id, s]));
    parseStatus.value = { ...parseStatus.value, ...Object.fromEntries(byId) };
    pendingAttachments.value = pendingAttachments.value.map((attachment) => {
      const source = byId.get(attachment.id);
      if (!source) return attachment;
      return {
        ...attachment,
        parseStatus: source.parseStatus,
        parseError: source.parseError,
        parserId: source.parserId,
        parsedChars: source.parsedChars,
        pageCount: source.pageCount,
      };
    });
  }

  /**
   * Watch for extraction to finish.
   *
   * `also` lets a re-parse started from a *sent* message keep the loop alive: nothing is
   * pending in that case, so the "is anything still settling" check would stop polling
   * before the first result arrived.
   */
  function startParsePolling(sessionId: string, also: () => boolean = () => false): void {
    if (parsePoll !== null) return;

    const tick = async (): Promise<void> => {
      try {
        const sources = await api.listSessionSources(sessionId);
        mergeParseStatus(sources);
        for (const id of [...markingParsing.value]) {
          const status = sources.find((s) => s.id === id)?.parseStatus;
          if (status && status !== "pending" && status !== "parsing") markingParsing.value.delete(id);
        }
      } catch {
        // A failed poll is not worth surfacing — the next one usually succeeds, and the
        // attachment chip keeps showing the last known state either way.
      }
      if (!pendingAttachments.value.some(isSettling) && !also()) stopParsePolling();
    };

    parsePoll = setInterval(() => void tick(), 1500);
    void tick();
  }

  async function uploadAttachment(file: File): Promise<Attachment | null> {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setError(
        i18n.global.t("attachments.tooLarge", {
          name: file.name,
          limitMb: Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024),
        })
      );
      return null;
    }

    // Attachments are stored per session, so a conversation has to exist first.
    if (!activeSessionId.value) await createSession();
    const sessionId = activeSessionId.value;
    if (!sessionId) return null;

    try {
      const attachment = await api.uploadAttachment(sessionId, {
        name: file.name,
        mimeType: file.type,
        data: await fileToBase64(file),
      });
      pendingAttachments.value.push(attachment);
      // Documents are extracted in the background; anything else is already in a final
      // state and needs no polling.
      if (isSettling(attachment)) startParsePolling(sessionId);
      return attachment;
    } catch (e) {
      setError(messageOf(e));
      return null;
    }
  }

  /**
   * Re-run extraction on an attachment that failed, or that predates a settings change.
   *
   * Works for both a pending composer attachment and one already sent in the conversation
   * — the latter is why the live `parseStatus` map exists, since nothing about a historical
   * message changes when the server re-parses it.
   */
  /* ------------------------------ uploaded files ---------------------------- */

  /**
   * Read the account's uploaded files.
   *
   * Errors go to `sourcesError` rather than the toast: the dialog is open and the user asked
   * for this, so the place to say it failed is where they are looking.
   */
  async function loadSources(): Promise<void> {
    sourcesLoading.value = true;
    sourcesError.value = null;
    try {
      sources.value = await api.listSources();
    } catch (e) {
      sourcesError.value = messageOf(e);
    } finally {
      sourcesLoading.value = false;
    }
  }

  /**
   * Delete a file, its extracted text and every reference to it.
   *
   * The confirmation is the caller's (`composables/confirm`), because this is the app's one
   * action that destroys something the user cannot get back by retrying — and the copy has to
   * say so, which a store cannot.
   *
   * Chips on messages that referenced the file are deliberately left alone: they render from
   * each message's own snapshot, so history keeps reading the way it was written, and the
   * thumbnail starts 404ing. Dropping them here would make a past turn look like it never
   * happened.
   */
  async function deleteSource(sourceId: string): Promise<void> {
    try {
      await api.deleteSource(sourceId);
      sources.value = sources.value.filter((s) => s.id !== sourceId);
      // The live overlay must forget it too, or a chip would keep showing parse state for a
      // file that is gone.
      const { [sourceId]: _removed, ...rest } = parseStatus.value;
      parseStatus.value = rest;
    } catch (e) {
      sourcesError.value = messageOf(e);
    }
  }

  async function reparseAttachment(attachment: Attachment): Promise<void> {
    const sessionId = activeSessionId.value;
    if (!sessionId) return;
    try {
      await api.reparseSource(attachment.id, attachment.name);
      markingParsing.value.add(attachment.id);
      pendingAttachments.value = pendingAttachments.value.map((a) =>
        a.id === attachment.id ? { ...a, parseStatus: "pending", parseError: undefined } : a
      );
      // No optimistic write to the live map: `startParsePolling` ticks immediately, and the
      // server has already written `pending` — so the first answer is both sooner and more
      // truthful than anything assembled here.
      startParsePolling(sessionId, () => markingParsing.value.size > 0);
    } catch (e) {
      markingParsing.value.delete(attachment.id);
      setError(messageOf(e));
    }
  }

  function removePendingAttachment(id: string): void {
    pendingAttachments.value = pendingAttachments.value.filter((a) => a.id !== id);
  }

  function clearPendingAttachments(): void {
    stopParsePolling();
    pendingAttachments.value = [];
  }

  /* -------------------------------- chat ----------------------------------- */

  /**
   * Apply one server-sent event to the store.
   *
   * Shared by the two streams a turn can arrive on — the one `streamChat` opens and the
   * one `streamAnswers` opens when a suspended question is answered. They carry identical
   * events, and a second switch on them would be a second definition of what "streaming"
   * means, free to drift from the first.
   */
  function applyEvent(ev: ChatStreamEvent): void {
    switch (ev.type) {
      case "reasoning":
        if (reasoningStartedAt === null) {
          reasoningStartedAt = Date.now();
          startReasoningTicker();
        }
        streaming.value.thinking = true;
        streaming.value.reasoning += ev.delta;
        break;
      case "text":
        // The answer starting means reasoning is over: freeze the timer for good.
        if (streaming.value.thinking) stopReasoningTicker();
        streaming.value.content += ev.delta;
        break;
      case "tool_start":
        streaming.value.toolCalls.push({
          id: ev.toolCall.id,
          name: ev.toolCall.name,
          input: ev.toolCall.input,
        });
        break;
      case "tool_end": {
        const tc = streaming.value.toolCalls.find((t) => t.id === ev.toolCall.id);
        if (tc) tc.output = ev.toolCall.output;
        // A plan tool commits inside the turn; its widget refetches now rather than at
        // turn end, so the tree moves while the model is still writing its reply.
        if ((PLAN_TOOL_NAMES as readonly string[]).includes(ev.toolCall.name)) {
          emitWidgetEvent({
            type: "plan.changed",
            sessionId: activeSessionId.value ?? "",
          });
        }
        // A grading call commits verdicts mid-turn; the quiz widget refetches now rather
        // than waiting for turn end. `ila_quiz` itself never emits tool_end (it suspends).
        if (ev.toolCall.name === QUIZ_REVIEW_TOOL_NAME) {
          emitWidgetEvent({
            type: "quiz.changed",
            sessionId: activeSessionId.value ?? "",
          });
        }
        break;
      }
      case "plan_session_created": {
        // Applied at the end of `consume`, not here — the old conversation's resumed turn
        // is still streaming and must finish before the view switches.
        pendingPlanSessionId = ev.sessionId;
        break;
      }
      case "usage":
        streaming.value.usage = ev.usage;
        break;
      case "message_done":
        // The authoritative message is now in `messages`, so retire the transient
        // one — otherwise both render until `done`, and the server still has a
        // title call to make after this point.
        messages.value.push(ev.message);
        stopReasoningTicker();
        streaming.value.active = false;
        streaming.value.stopping = false;
        streaming.value.content = "";
        streaming.value.reasoning = "";
        streaming.value.toolCalls = [];
        break;
      case "title": {
        // The server named the conversation after its first exchange.
        const session = sessions.value.find((s) => s.id === ev.sessionId);
        if (session) session.title = ev.title;
        break;
      }
      case "error": {
        // `translateApiError` falls back to the provider's own sentence, which is what almost
        // every failure gets: there is no code to key on for text we cannot recognise, and
        // inventing one would put words in the provider's mouth. A code is present only when
        // the failure was a *setting*, and then it replaces a sentence the user can do
        // nothing with by one naming the thing to change.
        const text = translateApiError(ev.code, undefined, ev.message) || ev.message;
        // Recorded in two places on purpose. The banner belongs to the turn and unmounts
        // with it — the streaming block is only rendered while `active` — so on its own it
        // leaves a failed turn with *nothing* on screen a moment later. The toast outlives
        // the turn, which is what makes a failure something the user can actually read.
        streaming.value.error = text;
        error.value = text;
        break;
      }
      default:
        break;
    }
  }

  /**
   * Drain a turn's stream into the store, and tidy up whatever it did.
   *
   * Resolves `false` only when the request itself failed — a non-2xx, or a stream that
   * never opened. A failure *inside* a turn arrives as an `error` event on a 200 and is
   * not one of these: by then the server has already accepted the request, so a caller
   * that rolled back on this would be undoing something the server did write.
   *
   * `sessionId` is taken so the end of the turn can be announced with it — see the emit in the
   * `finally` below, which is the one point every turn ends at.
   */
  /**
   * A `plan_session_created` event arrived on this stream: the make-plan fork created another
   * conversation, and the end of this stream is when we switch to it. Stored on the stream
   * rather than applied immediately so the (short) resumed turn in the old conversation can
   * finish streaming without the view vanishing mid-token.
   */
  let pendingPlanSessionId: string | null = null;

  async function consume(stream: AsyncGenerator<ChatStreamEvent>, sessionId: string): Promise<boolean> {
    // Whose turn this is. If the account goes away mid-stream the events stop being applied at
    // all, so a signed-out turn cannot write into the next account's conversation.
    const epoch = accountEpoch;
    let requestFailed = false;
    try {
      for await (const ev of stream) {
        if (epoch !== accountEpoch) break;
        applyEvent(ev);
      }
    } catch (e) {
      requestFailed = true;
      if (epoch === accountEpoch) streaming.value.error = messageOf(e);
    } finally {
      streaming.value.active = false;
      streaming.value.stopping = false;
      stopReasoningTicker();
      // The two re-reads below are for the account that was signed in, so they are skipped
      // rather than merely harmless: `loadSessions` would early-return on the cleared
      // workspace id anyway, and neither is something to run on the login screen's behalf.
      if (epoch === accountEpoch) {
        // Pick up the server-assigned title and this turn's updated_at without clobbering
        // the optimistic bubbles already in `messages`.
        await loadSessions().catch(() => undefined);
        // The make-plan fork created another conversation: switch to it now its short reply
        // has finished, but only if the reader is still on the conversation that chose the
        // fork — a manual switch away wins over the navigation.
        const planSessionId = pendingPlanSessionId;
        pendingPlanSessionId = null;
        if (planSessionId && activeSessionId.value === sessionId) {
          await selectSession(planSessionId).catch(() => undefined);
        }
        // A turn is the one thing that reliably writes into the workspace, so the tree is
        // re-read here — at the single point every turn ends, rather than from the two
        // callers that start one. Silent, and a no-op when the tree was never opened: this
        // is a courtesy to the panel, not part of finishing a turn.
        await refreshFileTree({ silent: true }).catch(() => undefined);
        // And the end of the turn is announced here for the same reason the two re-reads are:
        // this is the one point every turn ends at. Unconditionally, including a request that
        // failed — a failed turn still persisted a message, so a widget showing a count would
        // otherwise be showing one that is no longer true.
        emitWidgetEvent({ type: "turn.finished", sessionId });
      }
    }
    return !requestFailed;
  }

  /** Every question still waiting for an answer, across the loaded messages. */
  function awaitingToolCalls(): ToolCall[] {
    return messages.value.flatMap((m) =>
      (m.toolCalls ?? []).filter((tc) => isInteractiveTool(tc.name) && tc.status === "awaiting")
    );
  }

  function findToolCall(id: string): ToolCall | undefined {
    for (const message of messages.value) {
      const found = (message.toolCalls ?? []).find((tc) => tc.id === id);
      if (found) return found;
    }
    return undefined;
  }

  /**
   * Send a plan-panel message through the ordinary chat flow — the "adjust plan" composer
   * and the "jump to chapter" action both reduce to a user message after a server write.
   */
  async function sendPanelMessage(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || streaming.value.active) return;
    await sendMessage(trimmed);
  }

  /**
   * The plan widget's "jump to chapter": the server marks prior undone nodes skipped and
   * opens the target in one transaction, then a normal user message drives the turn.
   * Returns false when the target is gone (the panel refetches elsewhere).
   */
  async function planJumpToNode(nodeId: string, message: string): Promise<boolean> {
    const sessionId = activeSessionId.value;
    if (!sessionId || streaming.value.active) return false;
    await api.jumpPlanNode(sessionId, nodeId);
    await sendPanelMessage(message);
    return true;
  }

  /**
   * The quiz widget's make-up answer for a question originally skipped/dismissed:
   * persist the answer on the SAME row (the server refuses pending/answered), then START
   * an ordinary chat turn whose message quotes the global id, so the model grades that
   * question instead of posing a new quiz.
   *
   * Resolves (true) as soon as the answer is persisted and the turn is dispatched — the
   * stream itself runs in the background so the detail dialog can close immediately rather
   * than covering the chat while the model answers. False on the streaming guard or a
   * rejected POST (whose translated error is surfaced, leaving the dialog open).
   */
  async function makeupQuizAnswer(
    question: QuizQuestionView,
    answer: QuizAnswer,
    message: string
  ): Promise<boolean> {
    const sessionId = activeSessionId.value;
    if (!sessionId || streaming.value.active) return false;
    try {
      await api.answerQuizQuestion(sessionId, question.id, answer);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
    void sendPanelMessage(message);
    return true;
  }

  async function sendMessage(text: string, attachments: Attachment[] = []): Promise<void> {
    const content = text.trim();
    if ((!content && attachments.length === 0) || streaming.value.active) return;

    // Auto-create a session if the user is on a fresh workspace.
    if (!activeSessionId.value) {
      await createSession();
    }
    if (!activeSessionId.value) return;

    const sessionId = activeSessionId.value;

    // Sending a message instead of answering retires the pending questions: the turn they
    // belonged to is over. The server makes the same change when it writes this turn, and
    // doing it here too is what keeps the card honest until the page is next reloaded.
    for (const tc of awaitingToolCalls()) tc.status = "skipped";

    // Optimistic user bubble.
    messages.value.push({
      id: `local-${Date.now()}`,
      sessionId,
      role: "user",
      content,
      attachments: attachments.length > 0 ? attachments : undefined,
      createdAt: new Date().toISOString(),
    });

    clearPendingAttachments();
    streaming.value = { ...EMPTY_STREAMING(), active: true };
    emitWidgetEvent({ type: "turn.started", sessionId });

    await consume(
      streamChat(sessionId, {
        message: content,
        attachments,
      }),
      sessionId
    );
  }

  /**
   * Submit (or cancel) a pending question and stream the turn that resumes.
   *
   * Name-agnostic on purpose: which tool asked decides how the server reads the payload, so
   * this only has to carry it. The card is flipped locally before the request goes out
   * because no server event describes the change: nothing streams while the question is
   * waiting, so the answer growing an `output` is something only this client knows about,
   * right up until the resumed turn starts emitting. If the request fails the flip is
   * undone, since the server will not have written it either.
   */
  async function answerQuestion(
    toolCallId: string,
    submission: { action: "submit" | "cancel"; answers?: InteractiveAnswer }
  ): Promise<void> {
    const sessionId = activeSessionId.value;
    const toolCall = findToolCall(toolCallId);
    // A turn is already running; the card's controls are disabled for the same reason, so
    // this is a race rather than a user action.
    if (streaming.value.active) return;
    if (!sessionId || !toolCall) {
      // Never silently: the card is on screen, so a caller that drops the submission owes
      // the user a reason. Saying nothing is indistinguishable from a button that is broken.
      setError(translateApiError("QUESTION_NOT_PENDING", undefined, undefined));
      return;
    }

    const previous: { status: ToolCall["status"]; answer: ToolCall["answer"] } = {
      status: toolCall.status,
      answer: toolCall.answer,
    };
    toolCall.status = submission.action === "cancel" ? "dismissed" : "answered";
    toolCall.answer = submission.answers;

    streaming.value = { ...EMPTY_STREAMING(), active: true };
    // A resumed turn moves the message counts and the token totals just as a fresh one does, so
    // it is announced from the same place rather than from only the fresh path.
    emitWidgetEvent({ type: "turn.started", sessionId });

    const accepted = await consume(
      streamAnswers(sessionId, { toolCallId, ...submission }),
      sessionId
    );
    if (!accepted) {
      // The server never took the answer — a 409 because it was already skipped, say — so
      // the card goes back to waiting rather than claiming a decision nobody recorded.
      toolCall.status = previous.status;
      toolCall.answer = previous.answer;
    }
  }

  /**
   * Cut the streaming turn short.
   *
   * It asks the server and then does nothing else, deliberately. The chat request is
   * still open — stopping is not the same as abandoning — and the server answers by
   * ending that stream with the usual `message_done` and `done`. So a stopped turn winds
   * down through exactly the path a completed one takes: the partial reply arrives as an
   * ordinary message, and there is no local copy to reconcile or reload.
   *
   * Covers both streams a turn can arrive on, because the server registers both.
   */
  async function stopMessage(): Promise<void> {
    const sessionId = activeSessionId.value;
    if (!sessionId || !streaming.value.active || streaming.value.stopping) return;

    streaming.value.stopping = true;
    try {
      // The reply is deliberately ignored: `ok: false` means the stream is already
      // delivering `message_done`, whose arm clears `stopping`.
      await api.stopSession(sessionId);
    } catch (e) {
      // Nothing was stopped, so let the button be pressed again.
      streaming.value.stopping = false;
      setError(messageOf(e));
    }
  }

  return {
    // state
    account,
    config,
    sources,
    sourcesLoading,
    sourcesError,
    workspaces,
    copilots,
    sessions,
    messages,
    workspaceWidgets,
    sessionWidgets,
    activeWorkspaceId,
    activeSessionId,
    activeCopilotId,
    draftSettings,
    pendingAttachments,
    parseStatus,
    parserKinds,
    streaming,
    error,
    fileListings,
    fileExpanded,
    fileLoadingPath,
    fileTreeError,
    filePreviewPath,
    fileContent,
    fileContentLoading,
    filePreviewError,
    // derived
    fileRows,
    fileTruncatedAt,
    activeWorkspace,
    activeSession,
    activeCopilotName,
    canAdmin,
    activeSystemPrompt,
    myCopilots,
    publicCopilots,
    sessionSettings,
    currentProviderId,
    effectiveModelId,
    effectiveModel,
    supportsVision,
    contextWindow,
    contextTokens,
    isConfigured,
    documentsParsing,
    workspaceWidgetIds,
    sessionWidgetIds,
    enabledWidgetIds,
    // actions
    init,
    signIn,
    changePassword,
    enterApp,
    signOut,
    loadSources,
    deleteSource,
    refreshConfig,
    loadSessions,
    selectWorkspace,
    createWorkspace,
    refreshWorkspaces,
    renameWorkspace,
    deleteWorkspace,
    selectSession,
    createSession,
    renameSession,
    updateSettings,
    deleteSession,
    loadWorkspaceWidgets,
    setWidgetEnabled,
    setProviderAndModel,
    updateSessionPrompt,
    saveCopilot,
    deleteCopilot,
    copyCopilotToMine,
    saveProvider,
    deleteProvider,
    deleteModel,
    setDefaults,
    loadParserKinds,
    saveDocumentParser,
    deleteDocumentParser,
    testDocumentParser,
    setDocumentParsing,
    uploadAttachment,
    reparseAttachment,
    removePendingAttachment,
    clearPendingAttachments,
    sendMessage,
    answerQuestion,
    sendPanelMessage,
    planJumpToNode,
    makeupQuizAnswer,
    stopMessage,
    setError,
    loadDirectory,
    toggleDirectory,
    refreshFileTree,
    openFile,
    closeFile,
    resetFileTree,
  };
});
