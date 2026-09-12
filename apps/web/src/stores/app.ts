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
import { closeSettings, closeSources, showLogin, showWorkspaceHome, uiState } from "../composables/ui";
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
  Workspace,
} from "../api/types";
import { ASK_USER_TOOL_NAME, MAX_ATTACHMENT_BYTES } from "../api/types";

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
   * Held because the UI needs a name to show and because "who am I" is the first question the
   * app asks, but it is not the *authority* on anything: every request is authenticated by the
   * cookie, and the server is what decides. Clearing this does not sign anyone out.
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
   * Work out who is asking, then load the app for them — or show the login screen.
   *
   * Runs on every page load, because the cookie is HttpOnly and there is nothing on the page
   * that can tell whether it is there. `me()` answering 401 is the ordinary "nobody is signed
   * in" case rather than a failure, which is why it is caught here instead of being allowed
   * to reach the toast — the first visit to a fresh installation is not an error.
   *
   * `authReady` is set before either branch, and that ordering is the whole reason the flag
   * exists: rendering the login screen first would flash it at a signed-in user on every
   * refresh.
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
   * Sign in, creating the account if the name is new.
   *
   * One argument and no password: see `api.login`. The screen states the same thing, because
   * a user who believes they typed a password is a user who will be surprised later.
   */
  async function signIn(username: string): Promise<void> {
    account.value = await api.login(username.trim());
    uiState.authReady = true;
    error.value = null;
    showWorkspaceHome();
    await loadApp();
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
    resetFileTree();
    await loadSessions();
  }

  async function createWorkspace(name: string): Promise<void> {
    const ws = await api.createWorkspace(name);
    workspaces.value.push(ws);
    if (!activeWorkspaceId.value) activeWorkspaceId.value = ws.id;
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
      await loadSessions();
    }
  }

  async function selectSession(id: string): Promise<void> {
    activeSessionId.value = id;
    activeCopilotId.value = activeSession.value?.copilotId ?? null;
    messages.value = await api.listMessages(id);
    pendingAttachments.value = [];
    streaming.value = EMPTY_STREAMING();
  }

  async function createSession(copilotId?: string | null): Promise<Session | null> {
    if (!activeWorkspaceId.value) return null;
    const session = await api.createSession(activeWorkspaceId.value, {
      copilotId: copilotId ?? activeCopilotId.value ?? null,
    });
    // Carry over anything picked on the welcome screen, so the choice survives.
    const carried = Object.entries(draftSettings.value).filter(([, v]) => v != null);
    const created = carried.length
      ? await api.updateSession(session.id, { settings: draftSettings.value })
      : session;
    draftSettings.value = {};
    if (carried.length) replaceSession(created);
    sessions.value = [created, ...sessions.value.filter((s) => s.id !== created.id)];
    await selectSession(created.id);
    return created;
  }

  async function renameSession(id: string, title: string): Promise<void> {
    const trimmed = title.trim();
    if (!trimmed) return;
    const updated = await api.updateSession(id, { title: trimmed });
    replaceSession(updated);
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
    await api.deleteSession(id);
    sessions.value = sessions.value.filter((s) => s.id !== id);
    if (activeSessionId.value === id) {
      activeSessionId.value = null;
      activeCopilotId.value = null;
      messages.value = [];
      pendingAttachments.value = [];
    }
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
   */
  async function consume(stream: AsyncGenerator<ChatStreamEvent>): Promise<boolean> {
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
        // A turn is the one thing that reliably writes into the workspace, so the tree is
        // re-read here — at the single point every turn ends, rather than from the two
        // callers that start one. Silent, and a no-op when the tree was never opened: this
        // is a courtesy to the panel, not part of finishing a turn.
        await refreshFileTree({ silent: true }).catch(() => undefined);
      }
    }
    return !requestFailed;
  }

  /** Every `ask_user` call still waiting for an answer, across the loaded messages. */
  function awaitingToolCalls(): ToolCall[] {
    return messages.value.flatMap((m) =>
      (m.toolCalls ?? []).filter((tc) => tc.name === ASK_USER_TOOL_NAME && tc.status === "awaiting")
    );
  }

  function findToolCall(id: string): ToolCall | undefined {
    for (const message of messages.value) {
      const found = (message.toolCalls ?? []).find((tc) => tc.id === id);
      if (found) return found;
    }
    return undefined;
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

    await consume(
      streamChat(sessionId, {
        message: content,
        attachments,
      })
    );
  }

  /**
   * Submit (or cancel) a pending `ask_user` call and stream the turn that resumes.
   *
   * The card is flipped locally before the request goes out because no server event
   * describes the change: nothing streams while the question is waiting, so the answer
   * growing an `output` is something only this client knows about, right up until the
   * resumed turn starts emitting. If the request fails the flip is undone, since the
   * server will not have written it either.
   */
  async function answerQuestion(
    toolCallId: string,
    submission: { action: "submit" | "cancel"; answers?: AskUserAnswers }
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

    const accepted = await consume(streamAnswers(sessionId, { toolCallId, ...submission }));
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
    // actions
    init,
    signIn,
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
