import { computed, ref } from "vue";
import { defineStore } from "pinia";
import {
  api,
  setUnauthenticatedHandler,
  streamAnswers,
  streamChat,
  streamRegenerate,
  fileToBase64,
} from "../api/client";
import { i18n } from "../i18n";
import { translateApiError } from "../utils/apiError";
import { flattenTree } from "../utils/fileTree";
import {
  addAll,
  addWorkspace,
  isAll,
  removeWorkspace,
  scopeChipIds,
} from "../utils/workspaceScope";
import type { ReferenceChoice } from "../utils/referencePicker";
import type { SourceFilterQuery } from "../api/client";
import { fileViewerSupported } from "../utils/fileViewer";
import {
  closeCopilots,
  closeSources,
  showLogin,
  showPasswordChange,
  showWorkspaceHome,
  uiState,
} from "../composables/ui";
import { emitWidgetEvent } from "../composables/widgetEvents";
import { forgetSession, noteSession, onRetitled } from "../composables/sessionLeave";
import { widgetPanel } from "../composables/widgetPanel";
import { WIDGET_MODULES, type WidgetInstall } from "../widgets/registry";
import type {
  AskUserAnswers,
  Attachment,
  ChatInput,
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
  SessionLockView,
  SessionNoteSync,
  SessionSettings,
  Source,
  ToolCall,
  UpdateProviderInput,
  User,
  WidgetId,
  WidgetScope,
  WidgetState,
  Workspace,
  WorkspaceScope,
} from "../api/types";
import {
  DIAGRAM_TOOL_NAME,
  TABLE_TOOL_NAME,
  MAX_ATTACHMENT_BYTES,
  isInteractiveTool,
  isPlatformAdmin,
  PLAN_MAKE_TOOL_NAME,
  PLAN_TOOL_NAMES,
  autoInstallWidgetForTool,
  QUIZ_REVIEW_TOOL_NAME,
  SESSION_LOCK_TTL_SECONDS,
  widgetGroupsForScope,
  type InteractiveAnswer,
  type PlanConflictAnswer,
  type QuizAnswer,
  type QuizQuestionView,
} from "../api/types";
import { ApiError } from "../utils/apiError";

/**
 * How often the workspace-wide lock check runs on its own.
 *
 * A backstop rather than the mechanism: every state change the client knows about asks for a
 * check directly, and this is for the ones it cannot know — another client taking or releasing a
 * conversation while this one sits still. Five minutes is long because the cost of being late is
 * a stale dot that corrects itself on the next write, and the cost of being eager is a request
 * per client per interval forever.
 */
const LOCK_POLL_MS = 300_000;

/**
 * How long a burst of "something changed" waits before it becomes one request.
 *
 * Short enough that a dot appears while the reader is still looking at the list, long enough that
 * a switch between two conversations is one check rather than two.
 */
const LOCK_REFRESH_DEBOUNCE_MS = 2_000;

/**
 * The heartbeat, derived from the lease rather than chosen beside it.
 *
 * Half the server's TTL, so **one** missed beat is survivable: an unlucky request — a laptop
 * waking, a network blink — must not cost the reader a conversation. The two numbers are one
 * fact, which is why the client computes this rather than naming a second constant that could
 * drift into a lease which expires between beats.
 */
export const SESSION_LOCK_HEARTBEAT_MS = (SESSION_LOCK_TTL_SECONDS * 1000) / 2;

/** Whether a failure is the server saying another client holds this conversation. */
function isSessionLocked(e: unknown): boolean {
  return e instanceof ApiError && e.code === "SESSION_LOCKED";
}

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

/**
 * Where a file preview is reading from.
 *
 * Three, and the third is not a tree: the workspace's `workdir/`, which the file tree browses; a
 * conversation's own `sessions/<id>/`, where the diagrams it draws are written; and an uploaded
 * `source`, which lives outside every workspace and is addressed by id rather than by path.
 * `"workspace"` is the default so every existing caller of `openFile` reads the same way it
 * always did.
 *
 * It is kept only to answer one question — whether a *session switch* should close the preview —
 * and `"source"` gives the right answer by not matching `"session"`. An upload belongs to the
 * account, so the conversation in front of it is neither here nor there.
 */
export type FileRoot = "workspace" | "session" | "source";

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
   * Which conversations are being written to, and by which client.
   *
   * Keyed by session id, and holding only *live* leases — the server filters by expiry, so an
   * entry here means "somebody may write to this right now". An absent entry is a free or expired
   * conversation, which is the same thing to every reader: no dot, and writing is allowed.
   *
   * The `clientId` of every lease matters only for `mine`; the UI draws two states from it, not
   * a list of holders. See `docs/session-locks.md`.
   */
  const sessionLocks = ref<Record<string, SessionLockView>>({});
  /**
   * The conversation this client holds, which it holds at most one of.
   *
   * Kept separately rather than derived from `sessionLocks` because the two answer different
   * questions: `sessionLocks` is the workspace as the server sees it (and may lag), while this is
   * what *this* client last took. A release clears it, and the heartbeat beats for it.
   */
  const heldSessionId = ref<string | null>(null);

  /**
   * Settings chosen before a conversation exists. Folded into the session on creation,
   * so the header selectors work on the welcome screen too.
   */
  const draftSettings = ref<SessionSettings>({});

  /** Uploaded-but-not-yet-sent attachments for the composer. */
  const pendingAttachments = ref<Attachment[]>([]);

  /**
   * Sources the user referenced with `@`, staged for the next turn.
   *
   * Beside the attachments rather than merged into them, because the two say different things
   * on screen: a chip the user uploaded for this turn, and one they pointed at. Both reach the
   * model as material; only the provenance differs, and only the client shows it.
   *
   * Held as whole rows rather than ids, so a chip can carry the parse state it already had —
   * a reference to a document that is still being extracted is a chip that should say so.
   */
  const pendingSources = ref<Source[]>([]);

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

  /**
   * The active conversation's note-export state, and the timer that watches it.
   *
   * The export is asynchronous on the server by design — the POST returns as soon as the job is
   * recorded — so the panel polls for the outcome the same way the attachment chips do, and for
   * the same reason: a button whose press produced nothing visible is a control that looks
   * broken. It stops on any settled status, so an idle conversation asks for nothing.
   */
  const noteSync = ref<SessionNoteSync | null>(null);
  const noteSyncing = ref(false);
  let noteSyncPoll: ReturnType<typeof setInterval> | null = null;

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
  /**
   * The bytes of a `binary` file, for the viewer.
   *
   * A second request rather than a field on `fileContent`, because the two carry different
   * kinds of thing and have different ceilings — see `readRawFile`. Fetched **only** when the
   * metadata says `binary` *and* `fileViewerSupported` says the viewer has a claim on the name,
   * which is what keeps a `.bin` from costing a request at all rather than merely a render.
   *
   * Null is therefore ordinary and means two different things — a text file, which never needs
   * bytes, and a binary nothing can draw. `fileViewerSupported` is what separates them, and the
   * viewer is shown either way so it can say which.
   */
  const filePreviewFile = ref<File | null>(null);
  /**
   * Which root the open preview is reading.
   *
   * Web-local — there is no wire type for it, because the two endpoints already differ and
   * this only decides which one `openFile` calls and which context the dialog names. It is
   * state rather than an argument threaded to the dialog because the dialog is always mounted
   * (`App.vue` has no `v-if` on it) and only ever sees the store.
   */
  const filePreviewRoot = ref<FileRoot>("workspace");

  /**
   * The last `openFile` to be *started*.
   *
   * Two opens can be in flight — a click on one file, then another before the first replies —
   * and the roots differ in which id a switch invalidates, so the reply that arrives late must
   * not write the state the current one owns.
   */
  let filePreviewSeq = 0;

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
   * The conversation on screen is held by *another* client, so it is read-only here.
   *
   * The one flag the composer and the banner read. Deliberately keyed on `mine` rather than on
   * `heldSessionId`: this client's own lease may have lapsed (a failed heartbeat, a resumed
   * laptop), and the question the UI asks is "may I write", which the server's view answers and
   * a local record cannot.
   *
   * A conversation nobody holds is writable, which is what makes the whole thing unobtrusive:
   * a single client sees no lock at all until a second one appears.
   */
  const isActiveSessionReadOnly = computed(() => {
    const lease = sessionLocks.value[activeSessionId.value ?? ""];
    return lease !== undefined && !lease.mine;
  });
  /** Whether *this* client holds the conversation on screen — what the green dot means. */
  const holdsActiveSessionLock = computed(
    () => sessionLocks.value[activeSessionId.value ?? ""]?.mine === true
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
    // Forgotten rather than reported, and the reason is the token: signing out revokes it, so a
    // report scheduled here would fire a few seconds later and be refused. The conversation keeps
    // whatever name it had, and the next reader to open it is a leave of its own.
    forgetSession();
    account.value = null;
    config.value = null;
    sources.value = [];
    sourcesLoading.value = false;
    sourcesError.value = null;
    workspaces.value = [];
    copilots.value = [];
    sessions.value = [];
    messages.value = [];
    // The bubble it pointed at is gone with the messages, so the tracker goes too: a stale id
    // here would swap the *next* account's first message out for a row that is not there.
    pendingLocalMessageId = null;
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
    /*
     * The locks go with the account, like everything else here — and for a sharper reason than
     * most: a lease held by a signed-out account would keep beating, and a *stale* list would
     * hand the next account a read-only conversation that is not its own.
     *
     * `stopLockChecks` cancels the pending debounced refresh, which would otherwise land after
     * the sign-out and write the previous account's locks into the new one's state. The lease
     * itself is released by the lock lifecycle's `onScopeDispose`, which fires with the view.
     */
    sessionLocks.value = {};
    heldSessionId.value = null;
    stopLockChecks();
    // The export's state and its timer go with the account: a run started by one person's click
    // must not report itself into whoever signs in next.
    stopNoteSyncPolling();
    noteSync.value = null;
    // The half-arrived reply is as much a part of the account as the messages are, and the
    // login screen has no business showing either.
    streaming.value = EMPTY_STREAMING();
    // Closes the open preview too, whichever root it read.
    resetFileTree();
    closeCopilots();
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
      // Named in the language the account is reading, because this is the one workspace nobody
      // chose a name for — and the name is data from here on, so a later language switch leaves it
      // exactly where it was.
      await createWorkspace(i18n.global.t("workspace.defaultName"));
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
    // The conversation goes with the workspace, and so does the report about leaving it.
    noteSession(null);
    activeCopilotId.value = null;
    draftSettings.value = {};
    messages.value = [];
    // The conversation being left had its own installs, and they belong to it.
    sessionWidgets.value = [];
    // Both roots become wrong here — there is no session any more, and the workspace is a
    // different one — so an open preview must go. `resetFileTree` closes it, which is why
    // there is no `closeFile()` beside this.
    resetFileTree();
    // The previous workspace's locks mean nothing here, so they are dropped rather than left to
    // be re-read: a dot on a conversation from another workspace would be a mark with nothing
    // behind it. Read alongside the rest, as one of three.
    sessionLocks.value = {};
    heldSessionId.value = null;
    // All three are reads of the same workspace and none needs the others, so they go together
    // rather than as three round trips on every switch.
    await Promise.all([loadSessions(), loadWorkspaceWidgets(), refreshWorkspaceLocks()]);
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
   * Open a file in the preview, from either root.
   *
   * Unlike the rest of the store's actions this one reports its own failure instead of
   * throwing, because its caller is a dialog that is already open: the error has one
   * obvious home, and it is the body of the thing the user just asked for.
   *
   * The read and the id it needs are resolved *before* the await, so a switch during the
   * round trip cannot re-point the request at the context the user moved to — the same
   * captured-id shape `loadDirectory` uses for the tree.
   */
  async function openFile(path: string, root: FileRoot = "workspace"): Promise<void> {
    const workspaceId = activeWorkspaceId.value;
    const sessionId = activeSessionId.value;
    let load: (() => Promise<FileContent>) | null = null;
    let loadBytes: ((name: string) => Promise<File>) | null = null;
    if (root === "session") {
      if (sessionId) {
        load = () => api.readSessionFileContent(sessionId, path);
        loadBytes = (name) => api.readSessionRawFile(sessionId, path, name);
      }
    } else if (workspaceId) {
      load = () => api.readFileContent(workspaceId, path);
      loadBytes = (name) => api.readRawFile(workspaceId, path, name);
    }
    if (!load || !loadBytes) return;
    await runPreview(root, path, load, loadBytes);
  }

  /**
   * A listing the tree must not trust any more.
   *
   * The tree caches one listing per directory and `loadDirectory` returns early for a path it
   * already has, so a write that changed a directory *nobody has open* — moving a file into a
   * collapsed one, deleting a subtree — would leave a stale cache that re-expanding would
   * serve without ever asking the server. Dropping the entry is what makes the next expand a
   * real read.
   */
  function invalidateListing(path: string): void {
    if (fileListings.value[path] === undefined) return;
    const next = { ...fileListings.value };
    delete next[path];
    fileListings.value = next;
  }

  /** The directory a path lives in. `""` for a top-level entry, and for the root itself. */
  function parentOf(path: string): string {
    const cut = path.lastIndexOf("/");
    return cut === -1 ? "" : path.slice(0, cut);
  }

  /**
   * The four file-manager writes.
   *
   * Each reports its own failure into the tree panel rather than the toast, on the rule the
   * rest of the file browser follows: a write the user asked for has one obvious home for its
   * error, and it is the panel the action was taken in. Each then *re-reads the tree*, because
   * the point of the action is what the tree shows afterwards — a create that leaves the row
   * missing is indistinguishable from a create that failed.
   *
   * The `await` order matters. `refreshFileTree` runs after the write resolved and after the
   * affected listings were dropped, so it re-reads the directories that actually changed
   * rather than the ones that were open a moment ago.
   */
  async function createFolder(dirPath: string, name: string): Promise<void> {
    const workspaceId = activeWorkspaceId.value;
    if (!workspaceId) return;
    const path = dirPath ? `${dirPath}/${name}` : name;
    try {
      await api.createWorkspaceDirectory(workspaceId, path);
    } catch (e) {
      fileTreeError.value = messageOf(e);
      return;
    }
    invalidateListing(dirPath);
    await refreshFileTree();
  }

  async function uploadToFolder(dirPath: string, file: File): Promise<void> {
    const workspaceId = activeWorkspaceId.value;
    if (!workspaceId) return;
    try {
      const data = await fileToBase64(file);
      await api.uploadWorkspaceFile(workspaceId, {
        dir: dirPath,
        name: file.name,
        mimeType: file.type || undefined,
        data,
      });
    } catch (e) {
      fileTreeError.value = messageOf(e);
      return;
    }
    invalidateListing(dirPath);
    await refreshFileTree();
  }

  /**
   * Move or rename, and take the cached listings with it.
   *
   * Both ends are invalidated, and the moved path *itself* when it was a directory — its
   * listing is cached under a path that no longer exists, and leaving it would mean the next
   * expand of the new path re-fetching while the old one lingers.
   */
  async function moveEntry(from: string, to: string): Promise<void> {
    const workspaceId = activeWorkspaceId.value;
    if (!workspaceId || !to.trim() || to === from) return;
    try {
      await api.moveWorkspaceEntry(workspaceId, { from, to });
    } catch (e) {
      fileTreeError.value = messageOf(e);
      return;
    }
    invalidateListing(parentOf(from));
    invalidateListing(parentOf(to));
    invalidateListing(from);
    await refreshFileTree();
  }

  async function deleteEntry(path: string): Promise<void> {
    const workspaceId = activeWorkspaceId.value;
    if (!workspaceId) return;
    try {
      await api.deleteWorkspaceEntry(workspaceId, path);
    } catch (e) {
      fileTreeError.value = messageOf(e);
      return;
    }
    invalidateListing(parentOf(path));
    invalidateListing(path);
    fileExpanded.value = fileExpanded.value.filter((p) => p !== path && !p.startsWith(`${path}/`));
    await refreshFileTree();
  }

  /**
   * An uploaded file, open in the same dialog as a workspace one.
   *
   * Its own entry point rather than a `root` argument to `openFile`, because a source is not
   * reached by a path: the file tree hands over a path it just listed, while this is handed the
   * row itself and addresses it by id. Everything after that is the same call.
   */
  async function openSourceFile(source: Source): Promise<void> {
    await runPreview(
      "source",
      source.name,
      () => api.readSourcePreview(source.id),
      (name) => api.readSourceRawFile(source.id, name)
    );
  }

  /**
   * The one path a preview takes, whichever root it came from: describe the file, then fetch its
   * bytes *only* if something can draw them.
   *
   * Both fetches are guarded by the same sequence number, which is what makes a close a
   * cancellation rather than a reset — a reply that arrives late belongs to a file nobody is
   * looking at any more, and writing it would overwrite whatever the next open has put up.
   *
   * The order is load-bearing in both directions. The metadata has to come back first because the
   * decision to fetch bytes is made from `kind` and `name`; and asking `fileViewerSupported`
   * *before* the request is what keeps a `.bin` — or a video past the cap — from costing a
   * request whose only possible outcome is being discarded.
   */
  async function runPreview(
    root: FileRoot,
    path: string,
    load: () => Promise<FileContent>,
    loadBytes: (name: string) => Promise<File>
  ): Promise<void> {
    const seq = ++filePreviewSeq;
    filePreviewRoot.value = root;
    filePreviewPath.value = path;
    fileContent.value = null;
    filePreviewFile.value = null;
    filePreviewError.value = null;
    fileContentLoading.value = true;
    try {
      const content = await load();
      if (seq !== filePreviewSeq) return;
      fileContent.value = content;

      if (content.kind === "binary" && fileViewerSupported(content.name)) {
        const file = await loadBytes(content.name);
        if (seq !== filePreviewSeq) return;
        filePreviewFile.value = file;
      }
    } catch (e) {
      if (seq !== filePreviewSeq) return;
      filePreviewError.value = messageOf(e);
    } finally {
      if (seq === filePreviewSeq) fileContentLoading.value = false;
    }
  }

  function closeFile(): void {
    // Bumping the sequence is what makes a close a *cancellation* rather than a reset: a
    // reply still in flight would otherwise land in the state of the next thing opened.
    filePreviewSeq++;
    filePreviewPath.value = null;
    fileContent.value = null;
    filePreviewFile.value = null;
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
      // The whole workspace went, so the conversation did too — and so does the report about
      // leaving it. Nothing is skipped here: the workspace may hold nothing else, so this is not
      // `deleteSession`'s case.
      noteSession(null);
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
    // A conversation's own file belongs to the conversation being left, so the preview closes
    // with it. A *workspace* file is still the file it was — the workspace has not changed —
    // so that one is left open, which is also what it did before either root existed.
    if (filePreviewRoot.value === "session") closeFile();

    activeSessionId.value = id;
    /*
     * …and the conversation being left is reported, which is what makes "the reader has gone" a
     * fact this side can see. Told what is on screen rather than what is leaving, so there is one
     * obligation to remember instead of two — see `composables/sessionLeave.ts`.
     */
    noteSession(activeSession.value);
    activeCopilotId.value = activeSession.value?.copilotId ?? null;
    /*
     * The export state belongs to the conversation being left, so it is cleared rather than kept —
     * and the poll for it is stopped with it. A poll left running would settle the *previous*
     * conversation's run into the new one's panel, which is a status line about somebody else's
     * notes.
     */
    stopNoteSyncPolling();
    noteSync.value = null;
    /*
     * Take this conversation's write lock, and give back the one being left.
     *
     * Not awaited with the reads below, deliberately: the lock is advisory, and making the
     * conversation's messages wait on a lease would put a write lock in front of a read. It
     * resolves into the state either way, and a refusal is the read-only state rather than an
     * error — see `acquireSessionLock`.
     *
     * The release is keyed on `heldSessionId` rather than on "the session before this one",
     * because a client holds at most one lease and the one it holds is the only one it owes.
     */
    const held = heldSessionId.value;
    if (held && held !== id) void releaseSessionLock(held);
    void acquireSessionLock(id);
    const [loaded, widgets] = await Promise.all([
      api.listMessages(id),
      api.listSessionWidgets(id),
      loadNoteSync(id),
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
    options: {
      title?: string;
      copilotId?: string | null;
      settings?: SessionSettings;
      widgets?: WidgetId[];
    } = {}
  ): Promise<Session | null> {
    if (!activeWorkspaceId.value) return null;
    const workspaceId = activeWorkspaceId.value;
    const staged = Object.entries(options.settings ?? draftSettings.value).filter(
      ([, v]) => v != null
    );
    const created = await api.createSession(workspaceId, {
      /*
       * Named here rather than by the server, because the placeholder has to be in a language,
       * and the server has no reader to ask. The workspace's first-run name is written the same
       * way and for the same reason — see `workspace.defaultName`, which this mirrors.
       *
       * It is sent **with** `titleSource: "auto"`, which is what makes it a placeholder: the
       * auto-titler still replaces it after the first turn. A name the user actually typed is a
       * different thing, and `NewSessionDialog` sets it afterwards so it reads as `user`.
       */
      title: options.title ?? i18n.global.t("session.fallbackTitle"),
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
    // Last, and the position is the meaning: "the first tab" is a statement about what is
    // installed, and that is settled by the two calls above. Neither `collapsed` nor
    // `widgetDrawerOpen` is touched — the panel is already *on* the right tab, and sliding a
    // drawer over the conversation because a session was created is a panel nobody asked for.
    activateFirstWidget();
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

  /**
   * Pin or unpin a conversation.
   *
   * No re-read and no new event: the sidebar computes its two groups from `pinned` on the rows it
   * already holds, so replacing the row is the whole of what the list needs, and no widget lists
   * conversations in an order this decides. The one thing it must *not* do is move the row within
   * the array — the server leaves `updated_at` alone for exactly that reason, and the two groups
   * are drawn from the flag rather than from the position of a boundary.
   */
  async function setSessionPinned(id: string, pinned: boolean): Promise<void> {
    const updated = await api.setSessionPinned(id, pinned);
    replaceSession(updated);
  }

  /* --------------------------------- widgets --------------------------------- */

  /**
   * A title the server settled on while the reader was leaving.
   *
   * Patched rather than re-read: the request that produced it is not part of any list request, and
   * the reader has already gone somewhere else — so a full `loadSessions()` for one string would
   * be a round trip about a conversation that is not on screen. `titleState` moves with it, which
   * is what stops the next leave reporting the same conversation again.
   */
  function applyRetitle(sessionId: string, title: string): void {
    const session = sessions.value.find((s) => s.id === sessionId);
    if (!session) return;
    session.title = title;
    session.titleState = "model";
  }

  // Registered once per store, and an assignment rather than a subscription — see
  // `composables/sessionLeave.ts` for why that is the shape with no lifetime to get wrong.
  onRetitled(applyRetitle);

  async function loadWorkspaceWidgets(): Promise<void> {
    const workspaceId = activeWorkspaceId.value;
    if (!workspaceId) {
      workspaceWidgets.value = [];
      return;
    }
    workspaceWidgets.value = await api.listWorkspaceWidgets(workspaceId);
  }

  /**
   * Re-read the conversation's own widget list — the narrower half of what `selectSession` reads
   * alongside the messages.
   *
   * **The reply is dropped unless the conversation is still the active one**, and that guard is
   * part of the read rather than of any caller because the failure it prevents is silent: two
   * reloads of this list can be in flight at once (a tool call's refetch, and the reader opening
   * another conversation), responses do not arrive in order, and an unguarded assignment would
   * settle the widget list on the *previous* conversation's answer while `activeSessionId` said
   * otherwise. The same shape as `filePreviewSeq` and the source browser's `loadRows`.
   */
  async function loadSessionWidgets(): Promise<void> {
    const sessionId = activeSessionId.value;
    if (!sessionId) {
      sessionWidgets.value = [];
      return;
    }
    const widgets = await api.listSessionWidgets(sessionId);
    if (activeSessionId.value !== sessionId) return;
    sessionWidgets.value = widgets.session;
  }

  /**
   * An `auto-install` widget's tool was called, so the *server* may have installed that widget in
   * this conversation — a fact this store cannot see, because the write happened inside the turn.
   * That is `widgetEvents.ts`'s own definition of when an event is warranted, and the answer here
   * is a refetch rather than an event: the route that answers "what is installed here" already
   * exists, and an event would be a second way to learn one fact.
   *
   * **Fire-and-forget, and the activation is in the continuation.** Both on purpose. `applyEvent`
   * is synchronous, so awaiting a round trip inside the `tool_end` arm would stall every
   * subsequent text delta; and the arm's own `activateWidget` reads `enabledWidgetIds`, which is
   * precisely the list that is stale until this resolves — so the tab is opened after the fetch,
   * not before it.
   *
   * `open` is the caller's decision rather than this function's, because which of an auto-install
   * widget's tools should pull the reader's tab out from under them is a per-tool question with an
   * existing answer: only `ila_make_plan` does. See the `tool_end` arm.
   */
  function syncAutoInstalledWidget(toolName: string, options: { open: boolean }): void {
    const widgetId = autoInstallWidgetForTool(toolName);
    if (!widgetId) return;
    const sessionId = activeSessionId.value;
    if (!sessionId) return;

    // Already here: the install is old news, and the activation can happen now.
    if (enabledWidgetIds.value.includes(widgetId)) {
      if (options.open) activateWidget(widgetId);
      return;
    }

    void loadSessionWidgets()
      .then(() => {
        // The reader may have moved to another conversation during the round trip.
        if (activeSessionId.value !== sessionId) return;
        if (options.open && enabledWidgetIds.value.includes(widgetId)) activateWidget(widgetId);
      })
      .catch(() => {
        // A list that could not be re-read is a tab that has not appeared yet. The server holds
        // the install either way, so the next `selectSession` — or a reload — picks it up, and
        // the panel's own data already reported any failure of its own.
      });
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
   * Install or uninstall a whole client-side widget **group** (e.g. 计划/测验/脉络) as one
   * click: the ordinary per-widget write for every member this scope accepts, sequential so
   * the hooks run in order. A group has no row, so this is sugar over `setWidgetEnabled`.
   * For the active object members already in the target state are skipped, which keeps an
   * install-all click from re-firing an installed widget's setup hook.
   */
  async function setWidgetGroupEnabled(
    scope: WidgetScope,
    scopeId: string,
    groupId: string,
    enabled: boolean
  ): Promise<void> {
    const group = widgetGroupsForScope(scope).find((g) => g.id === groupId);
    if (!group) return;
    const activeList =
      scope === "workspace"
        ? scopeId === activeWorkspaceId.value
          ? workspaceWidgets.value
          : null
        : scopeId === activeSessionId.value
          ? sessionWidgets.value
          : null;
    for (const widgetId of group.members) {
      if (activeList && activeList.find((w) => w.id === widgetId)?.enabled === enabled) continue;
      await setWidgetEnabled(scope, scopeId, widgetId, enabled);
    }
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
    ctx: WidgetInstall
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
   * Bring a widget's tab to the front — if this conversation has it installed.
   *
   * The guard is the whole function. `widgetPanel.setActive` **persists** its argument, and an id
   * this object does not have is a preference written for a tab that does not exist: the panel
   * would fall back to `ids[0]` anyway, so the stored value would be a lie until the next click.
   *
   * `enabledWidgetIds` rather than either scope's own list: the strip draws both groups and "the
   * first tab" is the workspace group's first member, which is the order that list is built in.
   * Anything narrower would make this function's answer disagree with what is on screen.
   */
  function activateWidget(id: WidgetId): void {
    if (!enabledWidgetIds.value.includes(id)) return;
    widgetPanel.setActive(id);
  }

  /**
   * The tab a freshly created conversation opens on: the strip's first.
   *
   * Writing it is the fix. `widgetPanel`'s active tab is **one global preference**
   * (`gl-widget-active`) and the panel prefers the remembered id whenever it happens to be
   * installed here — so a tab read in a *different* conversation wins over the panel's own
   * `ids[0]` fallback, which is the "a new conversation opens on the wrong tab" report. A
   * conversation the user has just made has no last-read tab of its own, so the first one is the
   * only honest answer.
   */
  function activateFirstWidget(): void {
    const first = enabledWidgetIds.value[0];
    if (first) activateWidget(first);
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
      // Forgotten rather than reported: a deleted conversation has nowhere to keep a new title,
      // and the report would be a request whose answer is a 404 by construction.
      forgetSession();
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

  /**
   * Write the conversation's own note about itself.
   *
   * An empty string is sent rather than skipped, because clearing a description is a decision
   * and it is the only way to express one — the same absent/empty rule `UpdateSessionInput`
   * documents. Nothing is announced on the widget bus: a description is not in any list a
   * widget draws.
   */
  async function updateSessionDescription(description: string): Promise<void> {
    const session = activeSession.value;
    if (!session) return;
    replaceSession(await api.updateSession(session.id, { description }));
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

  /**
   * The upload cap the server reported, or the shared constant before `/api/config` has landed.
   *
   * The fallback matters for the one press that can happen first: a file dropped on the composer
   * while the config request is still in flight. It is the same number the server would fall back
   * to, so the check is never *more* permissive than the route behind it.
   */
  function uploadLimitBytes(): number {
    return config.value?.maxUploadBytes ?? MAX_ATTACHMENT_BYTES;
  }

  async function setDefaults(input: { providerId?: string; modelId?: string }): Promise<void> {
    config.value = await api.updateDefaults(input);
  }

  /**
   * Save the installation's upload limit.
   *
   * The whole config comes back and replaces what the store holds, which is the same shape
   * `setDefaults` uses and the reason the upload pre-check below can read one field: there is one
   * `store.config`, not a settings copy beside it.
   */
  async function setUploadSettings(maxUploadBytes: number): Promise<void> {
    config.value = await api.updateUploadSettings({ maxUploadBytes });
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

  /* ------------------------- session write locks ---------------------------- */

  /**
   * Take the conversation, warning nobody if it is taken.
   *
   * A 409 is an *answer* here rather than a failure: it is how this client learns the
   * conversation belongs to another one, which is the read-only state. So this never throws, and
   * the caller — `selectSession`, which does not await anything about locks — needs no catch.
   *
   * The lease is recorded locally on success so the heartbeat has something to beat for even
   * before the workspace list has been re-read; the list then confirms it (or corrects it, if the
   * lease had already expired and somebody else took it in the meantime).
   */
  async function acquireSessionLock(sessionId: string): Promise<boolean> {
    try {
      const { lock } = await api.acquireSessionLock(sessionId);
      heldSessionId.value = sessionId;
      sessionLocks.value = { ...sessionLocks.value, [sessionId]: lock };
      return true;
    } catch (e) {
      if (isSessionLocked(e)) {
        /*
         * Somebody else has it. Recorded here rather than left to the next workspace-wide read,
         * because this is the answer to *the reader's own action*: they clicked a conversation and
         * the composer has to be right about it before they type, not a poll later.
         *
         * The entry is deliberately bare — `mine` is the only field anything reads, and it is the
         * only one a refusal answers. The holder's id, and when it took the lease, are what the
         * workspace list carries; this is a belief about a lock, not a row copied from one, and
         * the next read replaces it with the real thing.
         */
        heldSessionId.value = heldSessionId.value === sessionId ? null : heldSessionId.value;
        sessionLocks.value = {
          ...sessionLocks.value,
          [sessionId]: {
            sessionId,
            clientId: "",
            mine: false,
            acquiredAt: "",
            expiresAt: "",
          },
        };
        // And ask the server for the real list, so the bare entry above lives for one round trip
        // rather than until the five-minute poll. Debounced with every other trigger.
        requestLockRefresh(0);
      }
      return false;
    }
  }

  /**
   * Give it back.
   *
   * Every failure is swallowed, like the leave report's: the reader has already gone, the
   * conversation is not broken, and the lease expiring in two minutes is the same outcome for
   * everybody else. What must happen either way is the local forgetting — a client that kept
   * believing it held a conversation it had released would beat for it forever.
   */
  async function releaseSessionLock(sessionId: string): Promise<void> {
    if (heldSessionId.value === sessionId) heldSessionId.value = null;
    const { [sessionId]: released, ...rest } = sessionLocks.value;
    if (released !== undefined) sessionLocks.value = rest;
    try {
      await api.releaseSessionLock(sessionId);
    } catch {
      /* silent — see above */
    }
  }

  /**
   * Re-read every lock in the workspace, once.
   *
   * One request for the whole list rather than one per conversation, because the marks are drawn
   * on the session list; the sequence guard drops a reply that is not the latest, the shape
   * `loadRows` and `runPreview` already use.
   *
   * **A second call while one is in flight for the same workspace joins it** rather than starting
   * another — the "one in-flight attempt per conversation, joined rather than duplicated" rule the
   * auto-titler uses. It is not hypothetical: entering a workspace reads the list (here, alongside
   * the session list) and then mounts the chat view, whose lock lifecycle reads it again. Two
   * requests for one action, and the join makes the second wait for the first instead.
   */
  let lockSeq = 0;
  let lockRead: { workspaceId: string; promise: Promise<void> } | null = null;
  async function refreshWorkspaceLocks(): Promise<void> {
    const workspaceId = activeWorkspaceId.value;
    if (!workspaceId) return;
    if (lockRead?.workspaceId === workspaceId) return lockRead.promise;

    const seq = (lockSeq += 1);
    const read = readLocks(workspaceId, seq);
    lockRead = { workspaceId, promise: read };
    // The tracking is released whatever the read did, and only if this is still the read being
    // tracked — a newer one for a different workspace has replaced it and owns the slot now.
    // `readLocks` never rejects, so there is nothing here for the discarded promise to carry.
    void read.finally(() => {
      if (lockRead?.promise === read) lockRead = null;
    });
    return read;
  }

  /**
   * The request itself, and the two ways its answer is not usable: it is not the latest read, or
   * the reader has moved to another workspace. Either way it is dropped rather than applied.
   */
  async function readLocks(workspaceId: string, seq: number): Promise<void> {
    try {
      const { locks } = await api.listWorkspaceLocks(workspaceId);
      if (seq !== lockSeq || activeWorkspaceId.value !== workspaceId) return;
      sessionLocks.value = Object.fromEntries(locks.map((l) => [l.sessionId, l]));
    } catch {
      // Silently keep what is on screen. A lock list that could not be fetched is not a reason to
      // strip the marks off the conversations — the dots would flicker on every hiccup, and the
      // server refuses writes it should refuse regardless of what this client believes.
    }
  }

  /**
   * Ask for a workspace-wide refresh, at most once every couple of seconds.
   *
   * Six things notice a lock changing — entering the workspace, entering a conversation, a
   * release, the five-minute poll, and a refusal from a turn — and without this they would each
   * be a request. The debounce is short because the states it feeds are visible: a dot that
   * appears a second late is fine, one that appears after a keystroke is not.
   */
  let lockRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  function requestLockRefresh(delayMs = LOCK_REFRESH_DEBOUNCE_MS): void {
    if (lockRefreshTimer !== null) clearTimeout(lockRefreshTimer);
    lockRefreshTimer = setTimeout(() => {
      lockRefreshTimer = null;
      void refreshWorkspaceLocks();
    }, delayMs);
  }

  /** Stop every pending check. Called on sign-out, and by the lifecycle when the view goes. */
  function stopLockChecks(): void {
    if (lockRefreshTimer !== null) {
      clearTimeout(lockRefreshTimer);
      lockRefreshTimer = null;
    }
  }

  /* ----------------------------- attachments ------------------------------- */
  function stopParsePolling(): void {
    if (parsePoll !== null) {
      clearInterval(parsePoll);
      parsePoll = null;
    }
  }

  /* ------------------------- notes → the library ---------------------------- */

  function stopNoteSyncPolling(): void {
    if (noteSyncPoll !== null) {
      clearInterval(noteSyncPoll);
      noteSyncPoll = null;
    }
    noteSyncing.value = false;
  }

  /**
   * Read this conversation's export state, once.
   *
   * Called when a conversation is opened, so a run started in another tab — or finished while the
   * page was closed — is on screen rather than remembered only by whoever pressed the button.
   * A failure is silently left as "never exported": the panel then shows an idle button, which is
   * the honest reading of a state nobody could fetch.
   */
  async function loadNoteSync(sessionId: string): Promise<void> {
    try {
      const { sync } = await api.getNoteSync(sessionId);
      // Dropped when the reader has moved on, the `loadedSessionId` idiom the other lists use:
      // a reply that arrives after a switch describes a conversation that is no longer open.
      if (activeSessionId.value !== sessionId) return;
      noteSync.value = sync;
    } catch {
      if (activeSessionId.value === sessionId) noteSync.value = null;
    }
  }

  /**
   * Export this conversation's notes, and follow the run to its end.
   *
   * A **start** failure is reported; a run that later settles `failed` is not. That split is not
   * tidiness: the status line is on screen for as long as the conversation is and carries the
   * server's own sentence, so a toast would say the same thing twice — while a press that could
   * not even be recorded has nowhere else to appear, and a button that does nothing is exactly
   * what this app keeps out of the UI.
   */
  async function syncNotesToLibrary(force = false): Promise<void> {
    const sessionId = activeSessionId.value;
    if (!sessionId) return;
    noteSyncing.value = true;
    try {
      const { sync } = await api.startNoteSync(sessionId, force ? { force: true } : {});
      if (activeSessionId.value !== sessionId) return;
      noteSync.value = sync;
      startNoteSyncPolling(sessionId);
    } catch (e) {
      setError(messageOf(e));
      stopNoteSyncPolling();
      // The refusal is the one failure with a state to re-read: another tab's run is live, and
      // the panel should say so rather than sitting on the button it just failed to press.
      await loadNoteSync(sessionId);
    }
  }

  /**
   * Follow a run until it settles.
   *
   * `tick` first and the interval after, the shape `startParsePolling` uses — a run this short
   * would otherwise always cost one interval before the panel noticed it had finished.
   */
  function startNoteSyncPolling(sessionId: string): void {
    if (noteSyncPoll !== null) return;

    const tick = async (): Promise<void> => {
      try {
        const { sync } = await api.getNoteSync(sessionId);
        if (activeSessionId.value !== sessionId) {
          stopNoteSyncPolling();
          return;
        }
        noteSync.value = sync;
        if (sync && sync.status !== "running") {
          stopNoteSyncPolling();
          // Only when it touched something: a run that rewrote nothing left the panel's copy
          // correct, and refetching for it would be work about a change that did not happen.
          if (sync.status === "ok" && sync.added + sync.updated + sync.removed > 0) {
            emitWidgetEvent({ type: "library.changed", sessionId });
          }
        }
      } catch {
        // A failed poll is not worth surfacing — the next one usually succeeds, and the status
        // line keeps showing the last known state either way.
      }
    };

    noteSyncPoll = setInterval(() => void tick(), 1500);
    void tick();
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
    const fold = <T extends Attachment>(attachment: T): T => {
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
    };
    pendingAttachments.value = pendingAttachments.value.map(fold);
    pendingSources.value = pendingSources.value.map(fold);
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
        /*
         * A referenced source is not in that list yet — the link is written when the turn is
         * sent — so it is asked for by id. Read individually rather than by widening the list
         * route: there are a handful of them, and the alternative is a route that answers a
         * question about a conversation with material that is not the conversation's.
         */
        const referenced = pendingSources.value.filter(isSettling);
        if (referenced.length > 0) {
          const rows = await Promise.all(
            referenced.map((source) => api.getSource(source.id).catch(() => null))
          );
          mergeParseStatus(rows.filter((row): row is Source => row !== null));
        }
        mergeParseStatus(sources);
        for (const id of [...markingParsing.value]) {
          const status = sources.find((s) => s.id === id)?.parseStatus;
          if (status && status !== "pending" && status !== "parsing") markingParsing.value.delete(id);
        }
      } catch {
        // A failed poll is not worth surfacing — the next one usually succeeds, and the
        // attachment chip keeps showing the last known state either way.
      }
      if (
        !pendingAttachments.value.some(isSettling) &&
        !pendingSources.value.some(isSettling) &&
        !also()
      ) {
        stopParsePolling();
      }
    };

    parsePoll = setInterval(() => void tick(), 1500);
    void tick();
  }

  async function uploadAttachment(file: File): Promise<Attachment | null> {
    /*
     * The cap in force, which is a setting now rather than the constant — `MAX_ATTACHMENT_BYTES`
     * is what it falls back to when nothing has been configured, and the fallback lives on the
     * server so the two cannot disagree about the default.
     */
    if (file.size > uploadLimitBytes()) {
      setError(
        i18n.global.t("attachments.tooLarge", {
          name: file.name,
          limitMb: Math.round(uploadLimitBytes() / 1024 / 1024),
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
   * Read the account's sources, filtered.
   *
   * Errors go to `sourcesError` rather than the toast: the dialog is open and the user asked
   * for this, so the place to say it failed is where they are looking — which is also why the
   * previous list is *kept* on a failure rather than cleared. A filter that fails to apply
   * should leave the reader looking at what they had, not at an empty panel.
   *
   * `silent` is for a re-read nobody asked for: the post-delete refresh, where a failure has
   * the delete's own report to ride on. Two errors for one action is one too many.
   */
  async function loadSources(filter: SourceFilterQuery = {}, options: { silent?: boolean } = {}): Promise<void> {
    if (!options.silent) sourcesLoading.value = true;
    if (!options.silent) sourcesError.value = null;
    try {
      sources.value = await api.listSources(filter);
    } catch (e) {
      if (!options.silent) sourcesError.value = messageOf(e);
    } finally {
      if (!options.silent) sourcesLoading.value = false;
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
  /**
   * Delete the conversation's last message.
   *
   * The control that calls this is only rendered on the last one, so a refusal here is either
   * a second tab having moved the tail or a turn that started between the render and the
   * click — neither of which the user caused. It is reported rather than swallowed: the row
   * they clicked is still on screen, and a click that does nothing is the thing the toast
   * exists to prevent.
   */
  async function deleteMessage(messageId: string): Promise<void> {
    const sessionId = activeSessionId.value;
    if (!sessionId || streaming.value.active) return;
    try {
      await api.deleteMessage(sessionId, messageId);
      messages.value = messages.value.filter((m) => m.id !== messageId);
    } catch (e) {
      setError(messageOf(e));
    }
  }

  /**
   * Ask for the last reply again, in the same conversation.
   *
   * Nothing is removed here: the server soft-deletes the old reply and says so on the stream
   * (`message_removed`), which is what keeps this from being a second opinion about what the
   * server just did. The rollback on a failed request is likewise not needed — a request that
   * never opened left the reply in place.
   */
  async function regenerateLastMessage(): Promise<void> {
    const sessionId = activeSessionId.value;
    if (!sessionId || streaming.value.active) return;

    const last = messages.value[messages.value.length - 1];
    // Only an assistant tail has a reply to replace, and one still holding a question belongs
    // to the card, not to this button. The control is hidden in both cases; this is the race.
    if (!last || last.role !== "assistant") return;
    if ((last.toolCalls ?? []).some((tc) => tc.status === "awaiting")) return;

    streaming.value = { ...EMPTY_STREAMING(), active: true };
    emitWidgetEvent({ type: "turn.started", sessionId });

    await consume(streamRegenerate(sessionId), sessionId);
  }

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

  /**
   * Reference a source in the next turn, the way `@` names it.
   *
   * An unparsed document is extracted first, because the requirement is exact about it: a
   * model may only read a source that has been parsed, so pointing at one has to *make* it
   * readable rather than hand the model a name. The chip shows the state while that runs and
   * the composer waits on it, which is the same shape an attachment already has.
   *
   * Already-referenced is a no-op rather than a second chip: the reference is the pair, and
   * two chips for one file would be two references in one turn.
   */
  async function referenceSource(source: Source): Promise<void> {
    if (pendingSources.value.some((s) => s.id === source.id)) return;
    pendingSources.value = [...pendingSources.value, source];

    if (!isSettling(source) || !needsExtraction(source)) return;
    try {
      await api.reparseSource(source.id, source.name);
      markingParsing.value.add(source.id);
      markSourceParsing(source.id);
      startParsePolling(activeSessionId.value ?? "");
    } catch (e) {
      // A parse that could not be *started* is reported, unlike one that failed: the chip
      // would otherwise sit at "pending" forever with nothing running.
      setError(messageOf(e));
    }
  }

  function removePendingSource(id: string): void {
    pendingSources.value = pendingSources.value.filter((s) => s.id !== id);
  }

  function clearPendingSources(): void {
    pendingSources.value = [];
  }

  /**
   * The workspaces this conversation has been opened to, or `null` for none.
   *
   * Read the same way the provider and model are — the conversation's own settings, falling back
   * to what is staged before one exists — so a grant picked on the welcome screen is still on
   * screen after the conversation is created, and a reload shows the same chips.
   */
  const workspaceScope = computed<WorkspaceScope | null>(() => {
    const settings = activeSession.value?.settings ?? draftSettings.value;
    return settings.workspaceScope ?? null;
  });

  /** The workspaces already readable, for a picker row that would otherwise look unpicked. */
  const scopedWorkspaceIds = computed(() => scopeChipIds(workspaceScope.value));
  const scopeIsAll = computed(() => isAll(workspaceScope.value));

  /**
   * Open a workspace — or all of them — to this conversation.
   *
   * A **session setting** rather than something sent with the turn, and that is the whole design:
   * the grant persists (`session_sources` is the precedent — pointing at something once makes it
   * readable on every later turn), it survives a reload, and it is in force for turns nobody
   * typed an `@` in. The `@` is how it is *made*; the setting is what it means.
   */
  async function referenceScope(choice: ReferenceChoice & { kind: "scope" }): Promise<void> {
    const next: WorkspaceScope = choice.all
      ? addAll()
      : addWorkspace(workspaceScope.value, choice.workspaceId);
    await writeScope(next);
  }

  /**
   * Take one workspace back out.
   *
   * `null` rather than an empty object when the last one goes — see `removeWorkspace`, which is
   * where that rule and its reason live. The server merges settings, so this is a partial write;
   * `undefined` would vanish in JSON and leave the grant unremovable.
   */
  async function removeScopeWorkspace(id: string): Promise<void> {
    await writeScope(removeWorkspace(workspaceScope.value, id));
  }

  /** Close every workspace — the all-workspaces chip's removal, and the last named one's. */
  async function clearWorkspaceScope(): Promise<void> {
    await writeScope(null);
  }

  /**
   * Write the grant, and **say so when it does not land**.
   *
   * The one place in this store where a swallowed failure is worse than a noisy one: a grant the
   * user believes they made and did not is a conversation that will not read a workspace, and
   * nothing on screen afterwards would explain it. Reported through the toast, which is where
   * `referenceSource` reports a parse it could not start — the composer's own failures have no
   * pane of their own to land in.
   */
  async function writeScope(next: WorkspaceScope | null): Promise<void> {
    try {
      await updateSettings({ workspaceScope: next });
    } catch (e) {
      setError(messageOf(e));
    }
  }

  /** Whether this source is one a model can only read after extraction. */
  function needsExtraction(source: Source): boolean {
    return source.category === "document" || source.category === "image";
  }

  /** Show a source as parsing in both the staged list and the live overlay. */
  function markSourceParsing(id: string): void {
    pendingSources.value = pendingSources.value.map((s) =>
      s.id === id ? { ...s, parseStatus: "pending" } : s
    );
    parseStatus.value = {
      ...parseStatus.value,
      [id]: { ...parseStatus.value[id], ...pendingSources.value.find((s) => s.id === id) } as Source,
    };
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
        /*
         * A tool of an `auto-install` widget ran, so the conversation may now hold a widget this
         * client has not seen — the server wrote the install during the call. Fired for every
         * `tool_end` and a no-op for an ordinary tool; see `syncAutoInstalledWidget` for why it
         * is a refetch and why the fetch is not awaited.
         *
         * `open` names exactly one tool, and the reason is the same one the plan arm has always
         * given: `ila_make_plan` covers both a first creation and a later edit, so it should put
         * the reader on the plan. A read and a progress update are neither, and a diagram is
         * already visible inline as its own card, so none of those should pull the reader's tab
         * out from under them.
         */
        syncAutoInstalledWidget(ev.toolCall.name, {
          open: ev.toolCall.name === PLAN_MAKE_TOOL_NAME,
        });
        // A plan tool commits inside the turn; its widget refetches now rather than at
        // turn end, so the tree moves while the model is still writing its reply. The event
        // deliberately covers all three plan tools — narrowing it to the make tool would stop
        // the panel moving on a progress update, which is the opposite of the point.
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
        // A diagram call has written its file by now. Nothing local knows what the folder
        // holds, which is the definition of something a widget cannot see for itself.
        if (ev.toolCall.name === DIAGRAM_TOOL_NAME) {
          emitWidgetEvent({
            type: "diagram.changed",
            sessionId: activeSessionId.value ?? "",
          });
        }
        // A table call has written its row by now, and the same argument holds one level over:
        // the message's tool calls name the *call*, and nothing local turns one into the row the
        // panel lists. Two events rather than one because the panels filter on them by name, so
        // sharing would wake the other on every call.
        if (ev.toolCall.name === TABLE_TOOL_NAME) {
          emitWidgetEvent({
            type: "table.changed",
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
      case "message_saved": {
        /*
         * The server's row for the message the user just sent, replacing the optimistic
         * bubble this client drew. Without the swap that bubble keeps its `local-…` id for
         * the life of the page, and the tail actions address rows by id — so deleting a
         * message you had just sent would ask the server about a name it has never seen.
         */
        if (pendingLocalMessageId === null) break;
        const localId = pendingLocalMessageId;
        pendingLocalMessageId = null;
        messages.value = messages.value.map((m) => (m.id === localId ? ev.message : m));
        break;
      }
      case "message_removed":
        /*
         * A regenerate dropped this reply server-side before the replacement streams. The
         * row goes now rather than at `message_done`: leaving it would render the old answer
         * and the new one at the same time for the length of the turn. Nothing else is
         * touched — the stream that replaces it owns the banner.
         */
        messages.value = messages.value.filter((m) => m.id !== ev.id);
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

  /**
   * The id of the optimistic user bubble the current turn is standing in for, until the
   * server says which row it wrote (`message_saved`). Null between turns, and between
   * accounts — see `forgetAccount`.
   */
  let pendingLocalMessageId: string | null = null;

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
      if (epoch === accountEpoch) {
        streaming.value.error = messageOf(e);
        /*
         * A refusal from a turn route is the last way this client learns a lease changed.
         *
         * It is the case the requirement names — the heartbeat failed for some reason and the
         * lease expired under a reader who was typing — and it is the one no amount of polling
         * can prevent, because the turn is refused before it starts. Re-reading the workspace's
         * locks is what turns the error into a state: the composer goes read-only, the dot turns
         * orange, and the sentence on screen matches what the buttons do.
         */
        if (isSessionLocked(e)) {
          /*
           * The toast as well, unlike every other failure that arrives as a thrown response —
           * and the difference is that this one is about the *action*, not about the turn.
           *
           * A refused turn is never persisted (the server refuses it before a turn exists), so
           * the message list keeps no trace of it and the banner unmounts with the streaming
           * block a moment later. Left at that, a reader who pressed send would watch a red line
           * vanish and have nothing told to them, which is the shape of failure the error must
           * survive. The persistent banner and the orange dot explain the state; this is the
           * answer to the press.
           */
          error.value = messageOf(e);
          requestLockRefresh(0);
        }
      }
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
          // The server made this conversation to hold a plan and installed the plan widget
          // into it, so naming that tab is the stronger true statement than taking the first
          // one. `activateWidget`'s guard supplies the fallback if that ever stops being so.
          activateWidget("plan");
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
   * `chatExtras` carries server-only routing on that same turn: the quiz make-up passes
   * `makeupQuizId` so the grading key is attached to the system prompt, never to the
   * visible message.
   */
  async function sendPanelMessage(
    text: string,
    chatExtras: Partial<ChatInput> = {}
  ): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || streaming.value.active) return;
    await sendMessage(trimmed, [], chatExtras);
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
    // Name the row: the server appends its (hidden) answer key to this turn's system
    // prompt so the model grades against it instead of reconstructing one.
    void sendPanelMessage(message, { makeupQuizId: question.id });
    return true;
  }

  async function sendMessage(
    text: string,
    attachments: Attachment[] = [],
    chatExtras: Partial<ChatInput> = {}
  ): Promise<void> {
    const content = text.trim();
    // A reference counts as something to send, on the same footing as an attachment: pointing
    // at a file is a turn, even when the sentence around it is empty.
    const references = [...pendingSources.value];
    if ((!content && attachments.length === 0 && references.length === 0) || streaming.value.active)
      return;

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

    // Optimistic user bubble, under an id this client made up. The server's own row arrives
    // as `message_saved` and replaces it — see `pendingLocalMessageId` for why that matters.
    const localId = `local-${Date.now()}`;
    pendingLocalMessageId = localId;
    messages.value.push({
      id: localId,
      sessionId,
      role: "user",
      content,
      attachments: attachments.length > 0 ? attachments : undefined,
      sources: references.length > 0 ? references : undefined,
      createdAt: new Date().toISOString(),
    });

    clearPendingAttachments();
    clearPendingSources();
    streaming.value = { ...EMPTY_STREAMING(), active: true };
    emitWidgetEvent({ type: "turn.started", sessionId });

    await consume(
      streamChat(sessionId, {
        message: content,
        attachments,
        // Ids and the names the composer showed: everything else about a source is re-read
        // server-side, the same split an attachment makes.
        sources: references.length > 0
          ? references.map((source) => ({ id: source.id, name: source.name }))
          : undefined,
        ...chatExtras,
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

    /*
     * A plan **edit** arrives through this route rather than through `tool_end`, and that is the
     * whole reason this call site exists. `ila_make_plan` refuses a fresh-looking tree when the
     * conversation already has a plan and suspends on the conflict card — and a suspended call
     * emits no `tool_end` at all, by design (it is the same absence that keeps a pending
     * `ask_user` out of the model's context). So "the user chose *edit this plan*" is the only
     * client-visible moment at which a plan is known to have been committed here.
     *
     * Gated on the choice and not just the tool: `new_session` commits the plan into a different
     * conversation, which the `plan_session_created` tail of `consume` handles instead.
     *
     * Deliberately optimistic, before the request below has been answered. A refusal costs a plan
     * tab opened on a conversation whose plan did not change, and the panel's own state is the
     * truth either way; moving it after the await would put a view change in a worse place.
     */
    if (
      submission.action !== "cancel" &&
      toolCall.name === PLAN_MAKE_TOOL_NAME &&
      (submission.answers as PlanConflictAnswer | undefined)?.choice === "edit"
    ) {
      activateWidget("plan");
    }

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
    noteSync,
    noteSyncing,
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
    pendingSources,
    parseStatus,
    parserKinds,
    streaming,
    error,
    fileListings,
    fileExpanded,
    fileLoadingPath,
    fileTreeError,
    filePreviewPath,
    filePreviewRoot,
    fileContent,
    filePreviewFile,
    fileContentLoading,
    filePreviewError,
    // derived
    fileRows,
    fileTruncatedAt,
    activeWorkspace,
    activeSession,
    activeCopilotName,
    sessionLocks,
    heldSessionId,
    isActiveSessionReadOnly,
    holdsActiveSessionLock,
    acquireSessionLock,
    releaseSessionLock,
    refreshWorkspaceLocks,
    requestLockRefresh,
    stopLockChecks,
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
    loadNoteSync,
    syncNotesToLibrary,
    signIn,
    changePassword,
    enterApp,
    signOut,
    loadSources,
    deleteSource,
    deleteMessage,
    regenerateLastMessage,
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
    setSessionPinned,
    updateSettings,
    deleteSession,
    loadWorkspaceWidgets,
    setWidgetEnabled,
    setWidgetGroupEnabled,
    setProviderAndModel,
    updateSessionPrompt,
    updateSessionDescription,
    saveCopilot,
    deleteCopilot,
    copyCopilotToMine,
    saveProvider,
    deleteProvider,
    deleteModel,
    setDefaults,
    setUploadSettings,
    uploadLimitBytes,
    loadParserKinds,
    saveDocumentParser,
    deleteDocumentParser,
    testDocumentParser,
    setDocumentParsing,
    uploadAttachment,
    referenceSource,
    removePendingSource,
    clearPendingSources,
    workspaceScope,
    scopedWorkspaceIds,
    scopeIsAll,
    referenceScope,
    removeScopeWorkspace,
    clearWorkspaceScope,
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
    createFolder,
    uploadToFolder,
    moveEntry,
    deleteEntry,
    openFile,
    openSourceFile,
    closeFile,
    resetFileTree,
  };
});
