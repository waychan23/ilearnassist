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

/**
 * Every tool the agent can be given, in the order the settings screens list them.
 *
 * Shared for the same reason as `ASK_USER_TOOL_NAME` above, and one more: a Copilot's tool
 * allow-list is written by the *client* and read by the server, so a name the two disagree
 * about is either a tool that cannot be selected or a selection that matches nothing. It was
 * duplicated once, and the copies had already drifted — the client's list was missing
 * `read_document`, which therefore could not be chosen at all.
 *
 * `read_document` is only *assembled* when the turn has sources to read (see
 * `buildTools`), so it appearing here is a statement about what may be allow-listed, not a
 * promise that the tool exists on every turn.
 */
export const ALL_TOOL_NAMES = [
  "web_search",
  "web_fetch",
  "ila_collect_page",
  "list_files",
  "read_file",
  "write_file",
  "create_directory",
  "delete_file",
  "read_document",
  "ask_user",
  "ila_quiz",
  "ila_review_quiz",
  "ila_make_plan",
  "ila_read_plan",
  "ila_update_plan_progress",
  "ila_diagram",
  "ila_table",
  "ila_query",
  "ila_explore",
] as const;

export type ToolName = (typeof ALL_TOOL_NAMES)[number];

/**
 * The query tool's name: the agent's read of the conversation's own record.
 *
 * Shared because it is in `ALL_TOOL_NAMES` — the client writes the allow-list from that list,
 * so a name only the server knew would be a tool nobody could choose.
 */
export const QUERY_TOOL_NAME = "ila_query";

/**
 * The explore tool's name: the agent's read of the workspaces the user granted with `@`.
 *
 * Shared for the `QUERY_TOOL_NAME` reason, and it is assembled only when the conversation holds
 * a grant — see `WorkspaceScope` below. A conversation nobody has pointed anywhere is never
 * offered it, the same gating `read_document` uses.
 */
export const EXPLORE_TOOL_NAME = "ila_explore";

/**
 * What `ila_explore` can be asked for, and therefore its discriminator.
 *
 * Shared because it is an enum on the wire: `tool-wire-schema.test.ts` asserts the converted
 * schema names exactly these, and the constant is the thing that must not drift between the
 * server that builds the schema and the test that reads it.
 *
 * `workspaces` is the index rather than a convenience: the other four kinds are addressed by
 * **id**, and the grant cannot be enumerated in the prompt when it is "every workspace" — that
 * flag covers workspaces which do not exist yet.
 */
export const EXPLORE_KINDS = ["workspaces", "sessions", "messages", "files", "file"] as const;
export type ExploreKind = (typeof EXPLORE_KINDS)[number];

/**
 * The things `ila_query` can be asked about, and therefore its discriminator.
 *
 * Deliberately **not** the widget ids: `workspace_stats` and `session_stats` have no records
 * to read, and a thread is a thing this tool returns while never being a thing the model can
 * name as a widget. The two lists answer different questions and are free to differ.
 */
export const QUERY_KINDS = [
  "plan",
  "quiz",
  "thread",
  "note",
  "diagram",
  "table",
  "source",
] as const;
export type QueryKind = (typeof QUERY_KINDS)[number];

/**
 * The diagram tool's name.
 *
 * Shared for the `ASK_USER_TOOL_NAME` reason — the client switches on it, to pick the
 * diagram card out of an assistant message's tool calls.
 *
 * It is **not** `required`, and that is what keeps it reachable. A `required` tool is assembled
 * only where its widget is installed, so the tool would not exist in an ordinary conversation —
 * which is the complaint this tool exists to answer — and `isWidgetBoundTool` would keep it out
 * of a Copilot's tool allow-list, where it could then be neither enabled nor disabled. Instead
 * the widget declares it `auto-install`: ordinary and pickable, and drawing one installs the
 * panel that lists it. See `WidgetTools`.
 */
export const DIAGRAM_TOOL_NAME = "ila_diagram";

/**
 * The table tool's name.
 *
 * Shared for the same reason `DIAGRAM_TOOL_NAME` is: the client switches on it, to pick the
 * table's own card out of an assistant message's tool calls.
 *
 * It rides the **diagram widget** — `WIDGETS.diagram` names both tools — because 图表 is the
 * panel that shows what a conversation has drawn and a table is the other half of that. Like the
 * diagram tool it is `auto-install`: ordinary, pickable in a Copilot, and making one installs the
 * panel that lists it.
 *
 * What it is *not* is a file. A diagram's bytes have to be a file (the agent's own tools can write
 * `.mmd`, and the library browses it); a table's display is the reply itself, so the row holds the
 * markdown and the conversation holds the rendering. See `Table`.
 */
export const TABLE_TOOL_NAME = "ila_table";

/**
 * The plan tools' names. Declared here rather than in the plan section below because the
 * widget registry names the plan widget's tools at module-eval time, and a `const` used in
 * an initializer has to exist first.
 *
 * They are `auto-install` (see `WidgetTools`): assembled like any ordinary tool, selectable in
 * a Copilot's allow-list like any other, and calling one installs the plan widget in that
 * conversation. That is what lets a plan be made where no panel was ever installed.
 */
export const PLAN_MAKE_TOOL_NAME = "ila_make_plan";
export const PLAN_READ_TOOL_NAME = "ila_read_plan";
export const PLAN_PROGRESS_TOOL_NAME = "ila_update_plan_progress";
export const PLAN_TOOL_NAMES = [
  PLAN_MAKE_TOOL_NAME,
  PLAN_READ_TOOL_NAME,
  PLAN_PROGRESS_TOOL_NAME,
] as const;

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
 * Where a suspending tool call stands.
 *
 * `awaiting`  — the turn is suspended here; the card is live and answerable.
 * `answered`  — the user submitted; `output` and `answer` are both present.
 * `skipped`   — the user sent a new message instead of answering, so this was retired
 *               without an answer and deliberately **without** an `output`, which is what
 *               keeps it out of the model's history.
 * `dismissed` — the user pressed cancel. Also answerless, but a decision rather than a
 *               drift, and worded differently in the UI.
 *
 * Named for the call rather than for `ask_user`, which is what it used to be: it is the
 * vocabulary of every suspending tool, and `quiz` is the second one.
 */
export type ToolCallStatus = "awaiting" | "answered" | "skipped" | "dismissed";

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

/* -------------------------------------- quiz -------------------------------------- */

/**
 * The tool's name, shared for the same reason as `ASK_USER_TOOL_NAME`: the client switches
 * on it to pick the answerable card out of an assistant message's tool calls.
 *
 * Namespaced with the product's prefix, unlike `ask_user`, because this is the first of a
 * family of tools specific to what this app is *for* rather than to what a chatbox does —
 * and `quiz` alone is a name a general tool would plausibly claim, at which point the
 * collision would be in a Copilot's allow-list and in every stored conversation's history.
 * The TypeScript symbols stay `Quiz*`, following `read_document`, whose code is
 * `Document*`: a symbol is scoped by its module, a tool name is global.
 */
export const QUIZ_TOOL_NAME = "ila_quiz";
/**
 * The grading companion: a normal (non-suspending) tool the model calls once after judging
 * quiz answers, writing structured verdicts the quiz widget filters on. Bound to the same
 * widget as `ila_quiz`; see `QUIZ_TOOL_NAMES` and the quiz widget in `WIDGETS`.
 */
export const QUIZ_REVIEW_TOOL_NAME = "ila_review_quiz";
export const QUIZ_TOOL_NAMES = [QUIZ_TOOL_NAME, QUIZ_REVIEW_TOOL_NAME] as const;

/**
 * One choice the model offers.
 *
 * Its own interface rather than a reuse of `AskUserOption`, so that a later addition to
 * either tool's options is not automatically a change to both.
 */
export interface QuizOption {
  label: string;
  description?: string;
}

/**
 * One question as the model asked it, and **therefore without an `id`**.
 *
 * The numbering is the tool's: it comes from a session-scoped counter, so it is not
 * something the model can compute, and an id a model invents is an id it can duplicate —
 * the opposite of what an id is for. `QuizQuestion` below is this once numbered.
 */
export interface QuizQuestionInput {
  /** The tab label. Short on purpose — the card is a strip of tabs, not a paragraph. */
  header: string;
  question: string;
  /**
   * Absent means single-select.
   *
   * Per question rather than per call, so one quiz may mix the two — a set of four
   * questions can be three single-select and one "tick everything that applies".
   */
  multiSelect?: boolean;
  /** How many the model offered, `QUIZ_MIN_OPTIONS`–`QUIZ_MAX_OPTIONS`, labels distinct. */
  options: QuizOption[];
  /**
   * Optional answer key: the exact **labels** of the correct options.
   *
   * Grading material, never question material. The tool strips it from everything the
   * client receives — the live `tool_start`, the persisted call the card re-renders from,
   * and the widget's question rows — and only hands it back once the question has been
   * answered: in the resumed tool result, or in the make-up turn's system-side grading
   * note. Stored server-side on the quiz row, so a later make-up can be judged against it
   * without it ever living in the conversation the client reads.
   */
  referenceAnswer?: string[];
  /**
   * Optional answer analysis ("why this is the answer"). Same secrecy as
   * `referenceAnswer`: written for the grading turn, never shown before an answer exists.
   */
  explanation?: string;
}

/** Cap on the answer analysis, so one key cannot dwarf the context. */
export const QUIZ_EXPLANATION_MAX = 1000;

/**
 * One question as it is persisted **in the conversation** and shown: the model's question
 * plus the id the tool assigned it (`Q1`, `Q2`, …), unique within its session.
 *
 * Deliberately does NOT extend the whole input: `referenceAnswer`/`explanation` are the
 * answer key and are stripped before a question is recorded or sent to the client. They
 * live only in the tool's validated arguments and, server-side, on the quiz row.
 *
 * The id is the whole reason this is a type of its own. It travels in the tool call's
 * `input`, which is what lets a reload re-render the same ids; it comes back in the tool
 * result; and it keys the answer, so a later turn or tool can name a question exactly.
 */
export interface QuizQuestion
  extends Pick<QuizQuestionInput, "header" | "question" | "multiSelect" | "options"> {
  id: string;
  /**
   * The question's GLOBAL id, assigned by the server when the quiz is registered in the
   * database at suspension time — distinct from `id` (the session-scoped `Qn`), which is
   * only unique within a conversation. This is what `ila_review_quiz` and the widget routes
   * name a question by. Absent only on legacy calls persisted before the quiz widget.
   */
  uid?: string;
}

/**
 * One question's answer.
 *
 * `unsure` is a **third state, mutually exclusive with a choice** — "I don't know" or "the
 * question itself is wrong". A multiple-choice list with no such escape forces a guess and
 * then records that guess as knowledge, which is the failure this tool exists to avoid.
 * `unsureReason` says which of the two it was, and `notes` is the user's own take; neither
 * is an answer by itself, so neither substitutes for a choice or an `unsure`.
 */
export interface QuizAnswer {
  /** Labels the model offered, validated against them. Empty when the user was unsure. */
  selected: string[];
  unsure?: boolean;
  /** Why: they may not know, or may think the question is flawed. */
  unsureReason?: string;
  /** The user's own take on the question. Never graded, never required. */
  notes?: string;
}

/**
 * Answers keyed by question **id** (`"Q1"`…), where `ask_user` keys by position.
 *
 * The difference is deliberate. A quiz question has an id, the id is what later features
 * refer to, and keying by it means an answer names its question instead of depending on two
 * lists happening to line up.
 */
export type QuizAnswers = Record<string, QuizAnswer>;

/**
 * Limits, exported as values rather than baked into the zod schema alone so the card and
 * the catalog's tests can read the same numbers.
 *
 * Wider than `ask_user`'s on purpose: a quiz is a set of questions about one subject rather
 * than a handful of decisions, so ten questions and up to eight options (A–H) are ordinary.
 */
export const QUIZ_MAX_QUESTIONS = 10;
export const QUIZ_MIN_OPTIONS = 2;
export const QUIZ_MAX_OPTIONS = 8;
/** Advisory for the tab label; the schema rejects longer rather than truncating. */
export const QUIZ_HEADER_MAX = 12;
/** Cap on the free-text "why are you unsure", so one reply cannot dwarf the context. */
export const QUIZ_UNSURE_REASON_MAX = 500;
/** Cap on one question's notes, for the same reason. */
export const QUIZ_NOTES_MAX = 2000;

/* ----------------------------- quiz question records ----------------------------- */

/**
 * A question's lifecycle as the quiz widget stores it. Distinct from `ToolCallStatus`:
 * the call is "awaiting" while pending, and a quiz has its own dismissed state (the whole
 * set explicitly cancelled, unlike `skipped`, which the user walked away from and may make
 * up later).
 */
export const QUIZ_QUESTION_STATUSES = ["pending", "answered", "skipped", "dismissed"] as const;
export type QuizQuestionStatus = (typeof QUIZ_QUESTION_STATUSES)[number];

/**
 * The model's verdict on one answered question. `unsure` is the answer that made no claim:
 * neither right nor wrong, which the wrong-only filter must not count.
 */
export const QUIZ_VERDICTS = ["correct", "incorrect", "unsure"] as const;
export type QuizVerdict = (typeof QUIZ_VERDICTS)[number];

/** One question as the quiz widget reads it (`GET /api/sessions/:id/quizzes`). */
export interface QuizQuestionView {
  /** The global UUID; the row's identity across conversations and edits. */
  id: string;
  /** The session-scoped `Qn` shown to user and model. */
  qid: string;
  /** The Qn number; the list ordering across a session's quizzes. */
  position: number;
  header: string;
  question: string;
  multiSelect: boolean;
  options: QuizOption[];
  status: QuizQuestionStatus;
  verdict: QuizVerdict | null;
  /** The model's explanation, once `ila_review_quiz` has graded the answer. */
  feedback: string | null;
  answer: QuizAnswer | null;
  /** The plan node this question was about; null for session-level ("其他问题") questions. */
  nodeId: string | null;
  /** Snapshot of the node title at creation, surviving the node's later deletion. */
  nodeTitle: string | null;
  /** The `ila_quiz` call that posed it — also the chat scroll anchor. */
  toolCallId: string;
  createdAt: string;
  answeredAt: string | null;
  gradedAt: string | null;
}

export interface GetQuizQuestionsResponse {
  questions: QuizQuestionView[];
}

/** Body of the make-up answer POST; the question itself comes from the row. */
export interface QuizMakeupAnswerBody {
  answer: QuizAnswer;
}

/** One item of `ila_review_quiz`: the verdict for one question by its global id. */
export interface QuizReviewItem {
  quizId: string;
  verdict: QuizVerdict;
  explanation: string;
}
export interface QuizReviewInput {
  reviews: QuizReviewItem[];
}
/** A quiz carries at most ten questions, and one review call grades one quiz. */
export const QUIZ_REVIEW_MAX_REVIEWS = QUIZ_MAX_QUESTIONS;
export const QUIZ_REVIEW_EXPLANATION_MAX = 2000;

/**
 * The tools whose calls suspend the turn, and are therefore answered through a card rather
 * than reported as a result.
 *
 * Shared because both sides need the same list and neither is a subset of the other: the
 * server groups them to route an answer, the client to decide which card renders a call and
 * which calls belong below the reply they were introduced by. Written once so a third one
 * is added here rather than in four comparisons that are free to disagree.
 */
export const INTERACTIVE_TOOL_NAMES = [
  ASK_USER_TOOL_NAME,
  QUIZ_TOOL_NAME,
  PLAN_MAKE_TOOL_NAME,
] as const;

export function isInteractiveTool(name: string): boolean {
  return (INTERACTIVE_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * The answer recorded for an `ila_make_plan` call that found the conversation already had a
 * plan — the "create a second plan" fork the spec requires a person to decide.
 *
 * `edit` overwrites the existing plan as a new version in this conversation. `new_session`
 * creates a fresh conversation (with the plan widget installed) and writes V1 there;
 * `newSessionId` names it so the client can switch to it.
 */
export interface PlanConflictAnswer {
  choice: "edit" | "new_session";
  newSessionId?: string;
}

/** One answer shape per suspending tool; the tool call's `name` is the discriminant. */
export type InteractiveAnswer = AskUserAnswers | QuizAnswers | PlanConflictAnswer;

/* ------------------------------------ widgets ------------------------------------ */

/**
 * Which level an install lives at.
 *
 * **Two**, and a Copilot does not add a third: a Copilot's selection is copied into the
 * session it starts, so "copilot level" is session level reached through a template. The
 * install *UIs* are still three (a Copilot editor is a third place to tick a box), which is
 * why the dialog and the record do not share a list.
 */
export const WIDGET_SCOPES = ["workspace", "session"] as const;

export type WidgetScope = (typeof WIDGET_SCOPES)[number];

/**
 * The built-in widgets, in the order the tab strip shows them.
 *
 * Lives here for the `ALL_TOOL_NAMES` reason: the client writes the id and the server filters
 * by it, so two copies would drift — and the drift here is a widget that cannot be installed
 * or a stored selection that matches nothing.
 *
 * Add a widget by adding it here, to `WIDGETS`, and to `WIDGET_MODULES` in
 * `apps/web/src/widgets/registry.ts`. The last of those is typed by this list, so forgetting
 * it is a `vue-tsc` error rather than a blank tab.
 */
export const WIDGET_IDS = [
  "workspace_stats",
  "session_stats",
  "plan",
  "quiz",
  "thread",
  "notes",
  "diagram",
  "insight",
  "sources",
] as const;

export type WidgetId = (typeof WIDGET_IDS)[number];

/**
 * The two logics a widget's tools can follow, and **the widget chooses**.
 *
 * A list rather than two inline string literals for the `WIDGET_SCOPES` reason: the client
 * switches on the mode (it has to know which tool names install their widget), so a second
 * copy of the vocabulary would drift.
 */
export const WIDGET_TOOL_MODES = ["required", "auto-install"] as const;

export type WidgetToolMode = (typeof WIDGET_TOOL_MODES)[number];

/** The tools a widget brings, and which of the two logics governs them. */
export interface WidgetTools {
  names: readonly ToolName[];
  /**
   * `"required"` — the tools exist exactly while the widget is installed at the object the turn
   * runs in. They **bypass the session's tool allow-list in all three of its states** (every
   * tool / a named list / none), and `isWidgetBoundTool` keeps them out of a Copilot's tool
   * checklist, because the allow-list can neither enable nor remove them — the install is the
   * single switch.
   *
   * `"auto-install"` — the tools are ordinary. They are assembled whenever their own per-turn
   * preconditions hold, the allow-list can add or remove them, and they are pickable in a
   * Copilot. In exchange, **calling one installs the widget in that conversation**: a capability
   * can be reached before anyone has opened the panel for it, which is the only way a panel
   * whose tools are what *produces* its data can ever appear on its own.
   *
   * The mode is per widget rather than global because the two answers are both right for
   * different widgets: a quiz nobody can answer needs its panel installed first, while a plan
   * the user just asked for should bring its panel with it.
   */
  mode: WidgetToolMode;
}

/** A built-in widget. What it is *called* is the client's business — see the web registry. */
export interface WidgetDefinition {
  id: WidgetId;
  /**
   * Where it may be installed. `["session"]` also means "installable from a Copilot", since a
   * Copilot installs into a session.
   */
  scopes: readonly WidgetScope[];
  /**
   * Tools that come with the widget, and how they relate to the install — see `WidgetTools`.
   * A tool here is still only *assembled* when its own per-turn preconditions hold (e.g. the
   * plan tools require a session context).
   */
  tools?: WidgetTools;
}

export const WIDGETS: readonly WidgetDefinition[] = [
  { id: "workspace_stats", scopes: ["workspace"] },
  { id: "session_stats", scopes: ["session"] },
  /*
   * The plan tools are `auto-install`, and that is what makes "帮我制定一个学习计划" work in a
   * conversation nobody has installed anything into. With `required` the tool would be assembled
   * only where the panel already is, so the capability could never introduce itself: the model
   * has no way to make a plan in an ordinary conversation, and no way to reach the panel that
   * would show one. Calling any of the three installs the widget, so the plan and its panel
   * arrive together.
   */
  { id: "plan", scopes: ["session"], tools: { names: PLAN_TOOL_NAMES, mode: "auto-install" } },
  /*
   * The quiz tools stay `required`, and the contrast is the rule rather than a leftover: a quiz
   * exists to be *answered*, so its questions come from a card and its panel is where the answers
   * live. `ila_quiz` suspends the turn on the card, which means the tool cannot be the thing that
   * installs the panel — the panel has to be there to receive the answer.
   */
  { id: "quiz", scopes: ["session"], tools: { names: QUIZ_TOOL_NAMES, mode: "required" } },
  // The thread widget brings no tools: its classification is an out-of-band model call,
  // like the auto-titler, not a tool the agent can call.
  { id: "thread", scopes: ["session"] },
  /*
   * Notes name no tools of their own, which is not the same as being unreachable.
   *
   * The model reads them through the ordinary `ila_query(kind: "note")` and still cannot write
   * them — no tool creates or edits a note, so a turn can never rewrite what the learner wrote.
   * Naming a read here would be the wrong move in either mode: a `required` one would exist only
   * where this panel does, so the learner's own notes would be invisible in every conversation
   * that had not opted in, and `auto-install` has nothing to install — the notes already exist,
   * because the learner wrote them.
   *
   * It is deliberately *not* in the "study" pack either — that pack is material derived from
   * the conversation, and this is what the learner made of it.
   */
  { id: "notes", scopes: ["session"] },
  /*
   * The diagram widget declares `ila_diagram` and `ila_table` in `auto-install` mode, which is the
   * plan widget's shape applied to a viewer. The tools had to be reachable in an ordinary
   * conversation for the features to exist at all — a diagram the model cannot draw is not a
   * diagram — and `required` would have made them reachable only where the panel already was. So
   * the tools are ordinary, the allow-list can add or remove them, and they are pickable in a
   * Copilot; what the mode adds is that drawing a diagram or recording a table installs the panel
   * that lists it.
   *
   * Two kinds in one panel because 图表 is one idea with two halves — 图 and 表 — and because the
   * ids are persisted rows: `session_widgets.widget_id` is `"diagram"`, so renaming it to something
   * that covers both would leave every existing install pointing at a widget this build no longer
   * has. The panel is still only a *viewer*: it lists what this conversation has drawn and shows
   * the one you pick. A diagram is a file in the conversation's own directory plus its row, so the
   * two are independent — a `.mmd` copied in by hand reaches the library and the file tree without
   * a panel — while a table is the row alone.
   */
  {
    id: "diagram",
    scopes: ["session"],
    tools: { names: [DIAGRAM_TOOL_NAME, TABLE_TOOL_NAME], mode: "auto-install" },
  },
  /*
   * The insight panel names no tools either, and for a stronger reason than the diagram's: the
   * pass it drives is an **out-of-band model call**, the `agent/title.ts` / `agent/threads.ts`
   * shape, so there is no tool to name.
   *
   * Even if there were one, both modes would be wrong. The tool would be something the *agent*
   * can call, and the agent must not decide to spend a whole-conversation model call on a panel
   * nobody may open — it costs a full pass over every source, and the user pressing a button is
   * what makes that cost acceptable. And `auto-install` would be wrong in the other direction:
   * an install is not a request for a pass, so the panel would arrive empty and look broken
   * rather than ready.
   *
   * `ila_query` is the agent's own way into the material this panel reflects on. Two doors to the
   * same data on purpose: the agent reads it during a turn, the panel thinks about it when asked.
   */
  { id: "insight", scopes: ["session"] },
  /*
   * The sources panel brings no tools, for the diagram widget's reason: there is nothing to
   * bind that the agent does not already have.
   *
   * `read_document` and `ila_query` are how a *turn* reaches this material, and both exist
   * whether or not a panel is installed — `read_document` is gated on the conversation's
   * whitelist being non-empty, not on a widget. Binding something here would mean the model
   * could only find what the user happened to be looking at, which is backwards: the panel is a
   * *view* of what the conversation holds, and a conversation holds it either way.
   *
   * Session-scoped, because the question it answers is "what is this conversation working
   * from" — a workspace's own listing is the library dialog, which the chat header opens.
   */
  { id: "sources", scopes: ["session"] },
];

/**
 * Client-side widget **groups**: a purely presentational bundling offered by the install
 * dialogs (e.g. the "study" group installs 计划 / 测验 / 脉络 together). A group has no row
 * and no route — each member still writes its own `widget_instances` entry through the
 * ordinary per-widget write, so ungrouping or installing one member alone stays ordinary.
 * Ids and membership only; the words live in the web registry's label switch.
 */
export interface WidgetGroupDefinition {
  id: string;
  members: readonly WidgetId[];
}

export const WIDGET_GROUPS: readonly WidgetGroupDefinition[] = [
  { id: "study", members: ["plan", "quiz", "thread"] },
];

export function widgetsInGroup(groupId: string): readonly WidgetId[] {
  return WIDGET_GROUPS.find((g) => g.id === groupId)?.members ?? [];
}

/** A group as the install dialog for `scope` sees it: members that accept the scope only. */
export interface ScopedWidgetGroup {
  id: string;
  members: WidgetId[];
}

/** Groups with at least one member installable at `scope`, in registry order. */
export function widgetGroupsForScope(scope: WidgetScope): readonly ScopedWidgetGroup[] {
  const known = new Set(widgetsForScope(scope).map((w) => w.id));
  return WIDGET_GROUPS.map((g) => ({
    id: g.id,
    members: g.members.filter((m): m is WidgetId => known.has(m)),
  })).filter((g) => g.members.length > 0);
}

/**
 * Every `required`-mode tool of at least one of `ids`, de-duplicated. The server reads this when
 * assembling a turn's tools — a name here is what makes an absent tool context assemble nothing
 * — and the client reads it to keep those tools out of the tool checklist.
 *
 * `auto-install` tools are deliberately **not** in this set: they are assembled on their own
 * merits, and the allow-list governs them like any other tool.
 */
export function boundToolNamesForWidgetIds(ids: readonly WidgetId[]): ToolName[] {
  const enabled = new Set(ids);
  const out = new Set<ToolName>();
  for (const widget of WIDGETS) {
    if (widget.tools?.mode !== "required") continue;
    if (!enabled.has(widget.id)) continue;
    for (const name of widget.tools.names) out.add(name);
  }
  return [...out];
}

/**
 * Whether a tool name is switched by a widget's install rather than by the tool allow-list.
 *
 * Only `required`-mode tools are, and this predicate is what keeps them out of a Copilot's
 * checklist — a box there could neither enable nor remove one, so it would be a control that
 * does nothing. The `auto-install` names answer `false` on purpose: they are ordinary tools a
 * Copilot may enable or disable like any other.
 */
const WIDGET_BOUND_TOOL_NAMES: ReadonlySet<string> = new Set(
  WIDGETS.filter((w) => w.tools?.mode === "required").flatMap((w) => w.tools?.names ?? [])
);

export function isWidgetBoundTool(name: string): boolean {
  return WIDGET_BOUND_TOOL_NAMES.has(name);
}

/**
 * Which widget a tool call installs, if any — the reverse of the two lookups above, and the only
 * place that answers "does calling this tool install something?".
 *
 * Read by the **server** to write the install, and by the **client** to know its own copy of the
 * widget list has just gone stale. One function for both, because two would be two opinions about
 * which tools install — and a client that missed one would show a panel the server had already
 * created, or fail to show one it had.
 *
 * First match wins; the auto-install sets are disjoint, so the order of `WIDGETS` cannot matter
 * to an answer.
 */
export function autoInstallWidgetForTool(name: string): WidgetId | undefined {
  for (const widget of WIDGETS) {
    if (widget.tools?.mode !== "auto-install") continue;
    if ((widget.tools.names as readonly string[]).includes(name)) return widget.id;
  }
  return undefined;
}

/**
 * What a brand-new conversation starts with: the two panels that are *views over what the
 * conversation already holds*.
 *
 * `notes` is what the learner wrote and `sources` is what the conversation is working from.
 * Both are useful before anybody asks for them, and neither needs setting up — which is what
 * separates them from the rest. A plan, a quiz, a diagram and an insight pass are all things a
 * conversation *produces*, so a panel for one of those is meaningful only once there is
 * something in it, and `plan` and `diagram` install themselves when their tool runs.
 *
 * This is a product decision about what every *unanswered* object starts with, and the word
 * matters: a row exists for anything that has been **decided** (installed or uninstalled, see
 * `WidgetState`), and this is the answer for everything else. Two consequences are load-bearing
 * rather than incidental:
 *
 * - Changing this list reaches every object nobody has answered for — including ones that
 *   already exist, which is why it is a decision about *absence* rather than about the future.
 *   The three create dialogs prefill this list so the choice is visible before the object is
 *   made; a caller that sends `[]` still means "none", and that stops the fall-through.
 * - An uninstall writes `enabled = 0` rather than deleting the row, which is what keeps a
 *   widget removed from *this* list from coming back the moment the list changes again.
 */
export const DEFAULT_WIDGET_IDS: readonly WidgetId[] = ["notes", "sources"];

export function isWidgetId(value: unknown): value is WidgetId {
  return typeof value === "string" && (WIDGET_IDS as readonly string[]).includes(value);
}

/** The widgets that accept `scope`, in registry order. The one ordering every site uses. */
export function widgetsForScope(scope: WidgetScope): readonly WidgetDefinition[] {
  return WIDGETS.filter((w) => w.scopes.includes(scope));
}

/**
 * Whether an object that has never recorded a choice gets this widget.
 *
 * Absence is not a stored value: a row exists for everything that has been *decided*
 * (installed or uninstalled), and this is the answer for everything else. That is what makes
 * "an uninstall writes `enabled = 0` rather than deleting the row" load-bearing — a deleted
 * row would fall back here and the widget would come back.
 */
export function defaultWidgetEnabled(id: WidgetId): boolean {
  return DEFAULT_WIDGET_IDS.includes(id);
}

/**
 * The default widgets that accept `scope` — what a create dialog should actually prefill, and
 * what a server fallback at one level should actually write.
 *
 * `DEFAULT_WIDGET_IDS` is one list, and a level can only install what it accepts. That is not a
 * matter of installing too much: `parseWidgetIds` **refuses** a misplaced id with
 * `WIDGET_SCOPE_UNSUPPORTED` rather than filtering it, so a create request carrying a
 * session-scope default at workspace scope does not install the wrong widgets — it fails, and the
 * object is never created. The defaults are session-scope today and every scope's answer is the
 * same empty-relative-to-it list, which is exactly why the mistake is easy to make and worth a
 * function rather than a `filter` at each of the five call sites.
 */
export function defaultWidgetIdsForScope(scope: WidgetScope): WidgetId[] {
  return widgetsForScope(scope)
    .filter((w) => defaultWidgetEnabled(w.id))
    .map((w) => w.id);
}

/**
 * One widget's state on one object — what the install lists show and the tab strip renders.
 *
 * This is the **resolved** record, not the stored one: an object nothing has ever decided about
 * answers `defaultWidgetEnabled(id)`, which is why a call site cannot tell a stored row from a
 * defaulted one. Storing the difference would be a second source of truth for the same fact.
 */
export interface WidgetState {
  id: WidgetId;
  scope: WidgetScope;
  enabled: boolean;
}

/**
 * What `GET /api/sessions/:id/widgets` answers: the two groups the tab strip draws.
 *
 * One request rather than two, because the strip is one control — split across two reads it
 * could render half-drawn, and the divider's position depends on both lists.
 */
export interface SessionWidgets {
  workspace: WidgetState[];
  session: WidgetState[];
}

/* ------------------------------------ plans ------------------------------------ */

/** A plan's own progress. */
export const PLAN_STATUSES = ["not_started", "in_progress", "completed"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/**
 * A node's progress. The two states beyond the plan's:
 * - `skipped` — the learner moved on without doing it yet and may come back (it still counts
 *   as a live, unfinished node).
 * - `deleted` — a plan edit removed it. A tombstone, not a row deletion: the node keeps its
 *   id and last position, rendered struck through, and progress is never computed over it.
 */
export const PLAN_NODE_STATUSES = [...PLAN_STATUSES, "skipped", "deleted"] as const;
export type PlanNodeStatus = (typeof PLAN_NODE_STATUSES)[number];

/** A node as the model submits it to `ila_make_plan`. Ids are absent at first creation. */
export interface PlanNodeInput {
  id?: string;
  title: string;
  children?: PlanNodeInput[];
}

/**
 * A node in a version's **structural** snapshot. History versions carry only structure —
 * never progress — so browsing V1 is reading V1 as it was edited, independent of today.
 */
export interface PlanSnapshotNode {
  id: string;
  title: string;
  children?: PlanSnapshotNode[];
}

/** A node of the current plan: structure plus the live progress the widget renders. */
export interface PlanTreeNode extends PlanSnapshotNode {
  status: PlanNodeStatus;
  /**
   * The tool-call whose card marks where work on this node began — the
   * `ila_update_plan_progress` call that first put it `in_progress` (placed before the
   * teaching content, so a click jumps to the node's start), falling back to the call that
   * completed it when a model finished a node without a separate start call. Cleared when
   * the node returns to not-started/skipped.
   */
  anchorToolCallId?: string;
  children?: PlanTreeNode[];
}

/** Anything carrying an id/children tree, which is both snapshot and current nodes. */
interface PlanNumberedNode {
  id: string;
  children?: PlanNumberedNode[];
}

/**
 * Hierarchical ordinal for every node, from sibling positions: the second root is "2", its
 * third child "2.3". Pure and structural (status-free), so history snapshots and the live
 * tree number the same way and the server can use it for the jump message.
 */
export function planNodeNumbers(nodes: readonly PlanNumberedNode[]): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (list: readonly PlanNumberedNode[], prefix: number[]): void => {
    list.forEach((node, index) => {
      const number = [...prefix, index + 1].join(".");
      out.set(node.id, number);
      if (node.children) walk(node.children, [...prefix, index + 1]);
    });
  };
  walk(nodes, []);
  return out;
}

export interface PlanVersionSummary {
  version: number;
  createdAt: string;
}

/** The current plan, for `GET /api/sessions/:id/plan`. */
export interface PlanView {
  planId: string;
  version: number;
  status: PlanStatus;
  tree: PlanTreeNode[];
  /** Every version, oldest first — the widget's version dropdown. */
  versions: PlanVersionSummary[];
  createdAt: string;
  updatedAt: string;
}

/** One historical version, structure only, for `…/plan/versions/:version`. */
export interface PlanSnapshot {
  version: number;
  createdAt: string;
  tree: PlanSnapshotNode[];
}

export interface GetPlanResponse {
  plan: PlanView | null;
}

/* ----------------------------------- threads ----------------------------------- */

/**
 * A thread's branch:
 * - `plan` — work following the study plan; the thread is one plan node, nested under the
 *   plan's own hierarchy by the client.
 * - `other` — everything before the plan exists and every off-plan detour afterwards.
 */
export const THREAD_BRANCHES = ["plan", "other"] as const;
export type ThreadBranch = (typeof THREAD_BRANCHES)[number];

/** One message in a thread, as the panel renders it: a one-line preview, not the body. */
export interface ThreadMessageView {
  id: string;
  role: Role;
  /** One-line, ellipsised for the row. */
  preview: string;
  /** The full text, for the row tooltip. Empty for a tool-only assistant message. */
  content: string;
  createdAt: string;
}

/**
 * One topic chain (a linked list of messages, oldest first). The two branch headings
 * (计划 / 其他) are NOT threads: they are a rendering fact with translated labels, so they
 * are never stored.
 */
export interface ThreadView {
  id: string;
  branch: ThreadBranch;
  /** Model-given title for an `other` thread; a plan thread prefers the live node title. */
  title: string;
  /** The plan node this thread IS, when `branch === "plan"` (one node, one thread). */
  planNodeId?: string;
  messages: ThreadMessageView[];
}

/** `GET /api/sessions/:id/threads` and the sync route's response. */
export interface GetSessionThreadsResponse {
  threads: ThreadView[];
  /** Messages the classifier has not reached yet; the panel shows this as backfill progress. */
  unassigned: number;
}

/* ---------------------------------- diagrams --------------------------------- */

/**
 * One diagram a conversation drew, as the API carries it.
 *
 * The source is deliberately not here: the `.mmd` file is the source, and the row is what the
 * file cannot answer — the canonical name, the model's summary, the call that drew it, and the
 * thread it belongs to. `threadTitle` is resolved server-side (the quiz view carries
 * `nodeTitle` for the same reason) and is null exactly when `threadId` is.
 */
export interface Diagram {
  id: string;
  sessionId: string;
  /** The thread the classifier put this diagram in; null until the turn it was drawn in is classified. */
  threadId: string | null;
  threadTitle: string | null;
  /** The canonical file name inside the conversation's folder — `auth-flow.mmd`. */
  name: string;
  /** The model's one- or two-sentence description of what the diagram is about. */
  summary: string;
  /** The tool call that wrote, or last revised, it; null when none was stamped. */
  toolCallId: string | null;
  /** The row's file is not on disk. Resolved on read, like `Note.messageMissing`. */
  fileMissing: boolean;
  createdAt: string;
  updatedAt: string;
}

/** `GET /api/sessions/:id/diagrams`. */
export interface GetSessionDiagramsResponse {
  diagrams: Diagram[];
}

/**
 * A table the conversation has recorded, as a row.
 *
 * The sibling of `Diagram`, and the differences are all one decision: **a table is not a file, so
 * this row holds the markdown**. A diagram's bytes live in `sessions/<id>/<name>.mmd` because a
 * diagram is a file — the file tools can write one, the library browses it, `@` can reference it —
 * and its row deliberately holds only what the file cannot answer. A table's display is the reply
 * itself (the requirement is explicit that it renders inline as Markdown, not in a card), so there
 * is nothing for a second copy on disk to be the source of; `notes` stores its body in a column
 * for the same reason.
 *
 * No `fileMissing`, because there is no file to be missing. That absence is the assertion worth
 * having in the tests, rather than an oversight.
 */
export interface Table {
  id: string;
  sessionId: string;
  /** The thread the classifier put this table in; null until its turn is classified. */
  threadId: string | null;
  threadTitle: string | null;
  /**
   * The canonical name — a slug, with no extension.
   *
   * No extension because there is no file: the name is only the row's identity and the label the
   * panel shows. It is the join key for a revise all the same, which is what makes calling the
   * tool again with the same name correct the table rather than add a second one.
   */
  name: string;
  /** The model's one- or two-sentence description of what the table is about. */
  summary: string;
  /** The markdown table source. The row is the only copy — see the note above. */
  content: string;
  /** The tool call that wrote, or last revised, it; null when none was stamped. */
  toolCallId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `GET /api/sessions/:id/tables`. */
export interface GetSessionTablesResponse {
  tables: Table[];
}

/* ------------------------------------ notes ------------------------------------ */

/**
 * What a note *is*, in the learner's own terms.
 *
 * One list rather than "annotation" plus a separate kind: 标注 is the one-click quick action
 * and the rest are what the window offers, but all of them are the same thing to the store, the
 * list and the filter — a note with a label. The quick action picks a *default type*; it does not
 * create a second kind of row.
 *
 * The middle three are three stances a learner takes on the material, and they are angles rather
 * than kinds: 灵感 is something the reading prompted, 疑问 is something it left open, and 观点 is
 * something the reader now holds a position on. That last one is the reason the list is not
 * "question and idea" alone — a note that disagrees with the material, or agrees with it more
 * firmly than the material does, had nowhere to go before it existed.
 *
 * **`annotation` is the one member a note may not always be offered**, and that is a presentation
 * rule rather than a stored one: it means "this marks a passage", so the window hides it for a
 * note with nothing marked — the one written from the panel's own button rather than from a
 * selection. The list is what exists; which of it a given window offers is the client's business,
 * and `NoteEditor.vue` is where that is decided.
 *
 * Note this is not the `notes` field a `QuizAnswer` carries. That is one question's
 * free-text remark, stored inside the answer; a `Note` below is a record of its own, with an
 * id, a type and (usually) a place in a conversation.
 */
export const NOTE_TYPES = ["annotation", "idea", "question", "opinion", "other"] as const;

export type NoteType = (typeof NOTE_TYPES)[number];

export function isNoteType(value: unknown): value is NoteType {
  return typeof value === "string" && (NOTE_TYPES as readonly string[]).includes(value);
}

/**
 * Where inside a message an annotation points.
 *
 * A text-quote anchor rather than a pair of character offsets, because the offsets a browser
 * reports are offsets into *rendered* HTML, and the note outlives any one rendering: `quote`
 * is the selected text itself and `occurrence` says which match of it this was, counted over
 * the message's **visible** text (a formula is skipped — KaTeX renders each one twice, once
 * as glyphs and once as hidden MathML, so a raw walk sees every formula double).
 *
 * Nothing here is guaranteed to still resolve: the message may since have been peeled off by
 * a regenerate, and the quote may simply not be found. Resolution is best-effort by design —
 * the highlight is a convenience, while `quote` is the record, which is why it is stored
 * rather than re-derived.
 */
export interface NoteAnchor {
  quote: string;
  occurrence: number;
}

/**
 * What a note is *about*, when it is not a passage in a message.
 *
 * A note has always been able to point at a message, and the pair it points with — `quote` and
 * `occurrence` — only works for text. A 图 and a 表 have no passage to quote, so they are named
 * instead: the whole object is the target, addressed by the canonical `name` the figure already
 * carries (`session_diagrams.name`, `session_tables.name`), which is the same handle `ila_query`
 * looks them up by and the same one a follow-up reference carries.
 *
 * A figure is never *partly* annotated. A mermaid diagram is rendered SVG with no addressable
 * text nodes, and a table's cells are markdown the reader can see but the anchor arithmetic
 * counts over rendered geometry — so "the whole figure" is the only unit that means the same
 * thing on both sides of a reload.
 *
 * `text` is the default and what every row written before this existed means. It is a value
 * rather than NULL because NULL would say "we do not know", which is false of those rows: they
 * are text notes, all of them.
 */
export const NOTE_TARGET_KINDS = ["text", "diagram", "table"] as const;

export type NoteTargetKind = (typeof NOTE_TARGET_KINDS)[number];

/** The kinds a create may *choose*: `text` is what omitting the pair means, not a thing to send. */
export type NoteFigureKind = Exclude<NoteTargetKind, "text">;

/** Cap on a figure's name, matching what the figure tables themselves hold. */
export const NOTE_TARGET_REF_MAX = 200;

/**
 * Caps, exported as values rather than living in a validator alone, so the client can refuse
 * a paste before it becomes a 400 and the tests read the same numbers.
 *
 * The quote is capped well above a sentence and well below a message: it is the annotated
 * text, so it has to hold whatever the user dragged over, but a whole conversation pasted
 * into a note is not an annotation.
 */
export const NOTE_QUOTE_MAX = 2000;
/** Cap on the note body, for the reason `QUIZ_NOTES_MAX` gives: one note cannot dwarf anything. */
export const NOTE_CONTENT_MAX = 4000;

/**
 * One note, as both sides hold it.
 *
 * `messageId` is nullable and `sessionId` is not, and that asymmetry is the entity's whole
 * shape: a note belongs to a conversation always, and to a message only when something was
 * annotated. A note the user typed from the list has no message to point at, and one whose
 * message was since deleted keeps its id and gains `messageMissing`.
 */
export interface Note {
  id: string;
  sessionId: string;
  /** The annotated message; null for a note added from the list with no annotation. */
  messageId: string | null;
  type: NoteType;
  /** The annotated text, verbatim. Empty when there is no annotation. */
  quote: string;
  /** Which occurrence of `quote` this was, counted over the message's visible text. */
  occurrence: number;
  content: string;
  /** What this note is about. `text` for every note with a quote or nothing at all. */
  targetKind: NoteTargetKind;
  /**
   * The figure's canonical name — `auth-flow.mmd` for a diagram, a bare slug for a table.
   *
   * Null for a text note, and that NULL is honest rather than a sentinel: there is no figure, so
   * there is no name. The client shows it as the chip's label and the follow-up passes it on, so
   * it is the *server's* name that travels — the one `diagramFileName`/`tableName` produced —
   * rather than the spelling the client happened to open the dialog with.
   */
  targetRef: string | null;
  /**
   * The message this note points at is gone — soft-deleted by a regenerate or a tail delete.
   *
   * Resolved by the server on every read rather than guessed by the client, for the reason
   * the widget states are: the client's message list holds only the conversation on screen,
   * so it cannot answer this for a session it has not loaded. It is what turns "定位" from a
   * button that silently does nothing into one that is not drawn.
   *
   * False when there is no message at all, which is a different fact from "there was one and
   * it is gone" — an unanchored note never had a place to go back to.
   */
  messageMissing: boolean;
  /**
   * The figure `targetRef` names is gone from this conversation.
   *
   * The same rule as `messageMissing`, for the same reason and read the same way: a diagram's
   * row is derived data that an edit can take away, and a chip that opens nothing is worse than
   * no chip. False whenever `targetKind` is `text`, where there is nothing that could be missing.
   */
  targetMissing: boolean;
  createdAt: string;
  updatedAt: string;
}

/** `GET /api/sessions/:id/notes`. Newest first, which is the order the panel renders. */
export interface GetSessionNotesResponse {
  notes: Note[];
}

/* ------------------------------ notes → the library ------------------------------ */

/**
 * What the export run for one conversation is doing, or last did.
 *
 * Three settled outcomes rather than two, for the reason the insight pass gives: "it looked and
 * there were no notes" and "it produced nothing usable" ask the reader for opposite things, and
 * a single `failed` would report a conversation with nothing in it as a broken button.
 *
 * `running` is written *before* the work starts, and that write is the lock — see
 * `runNoteSync`. A row left `running` by a process that died is reported as `stuck` rather than
 * quietly settled, because only the clock can tell "still working" from "the owner is gone".
 */
export type NoteSyncStatus = "running" | "ok" | "empty" | "failed";

/** One conversation's export state. */
export interface SessionNoteSync {
  status: NoteSyncStatus;
  startedAt: string;
  finishedAt: string | null;
  /** Source rows created, rewritten, and soft-deleted by the run. */
  added: number;
  updated: number;
  removed: number;
  /**
   * The run's failure sentence, in the server's own words.
   *
   * Deliberately not translated and not code-keyed: it is whatever the provider or the parser
   * said, which has no code to key on — the same rule the raw SSE `error` body follows.
   */
  error: string | null;
  /**
   * A `running` run whose owner is gone. Derived on read from `startedAt`, never stored: only
   * the clock can answer it, and a stored flag would freeze at whatever the answer was the
   * first time somebody looked.
   */
  stuck: boolean;
}

/** `GET /api/sessions/:id/notes/sync`. `null` when this conversation was never exported. */
export interface GetNoteSyncResponse {
  sync: SessionNoteSync | null;
}

/** `POST /api/sessions/:id/notes/sync`. */
export interface StartNoteSyncInput {
  /**
   * Start even though one is running.
   *
   * The recovery for a run whose process died before the timeout could call it stuck, and for
   * a reader who does not want to wait out the timeout to be sure. Never coerced from a string:
   * `"false"` is truthy, and a forced sync is a real cost.
   */
  force?: boolean;
}

/* ----------------------------------- insights ----------------------------------- */

/**
 * What an observation *is*, which is the question the panel answers differently for each.
 *
 * Typed rather than free text because the types are the point: a difficulty is something to
 * re-teach, a doubt is something to verify, a gap is something to fill *before* going on, and a
 * habit is a remark about the learner rather than about the material. One list of prose would
 * lose exactly that, and "different follow-up per type" is what the feature is for.
 *
 * The first three are separated on purpose and it is worth keeping them apart:
 * `difficulty` is a property of the **material** (this topic is hard), `confusion` is a property
 * of the **learner's state** (they did not get it), and `doubt` is a claim being **pushed back
 * on** — which wants verification, not a re-explanation.
 */
export const INSIGHT_TYPES = [
  "difficulty",
  "confusion",
  "doubt",
  "strength",
  "background",
  "reading",
  "advice",
  "habit",
] as const;

export type InsightType = (typeof INSIGHT_TYPES)[number];

/**
 * Whether a value is one of the types. Exported because the two sides ask it about different
 * things: the server about a model's answer, the client about a JSON body it did not compose.
 */
export function isInsightType(value: unknown): value is InsightType {
  return typeof value === "string" && (INSIGHT_TYPES as readonly string[]).includes(value);
}

/**
 * Where an unrecognised type lands, and why it lands somewhere rather than being dropped.
 *
 * A model invents a ninth type sooner or later. Dropping the item discards work the user cannot
 * see — and the whole purpose of the panel is that the model's observations become visible —
 * so it is filed as `advice`, which is the vaguest of the eight and the only one that is never
 * *wrong* about an item: advice about anything is still advice.
 */
export const INSIGHT_FALLBACK_TYPE: InsightType = "advice";

/** A title is a line in a list; a body is a short paragraph. */
export const INSIGHT_TITLE_MAX = 120;
export const INSIGHT_BODY_MAX = 800;
/** Per pass. Past this the answer is truncated rather than refused. */
export const INSIGHT_MAX_ITEMS = 40;
/**
 * Adopted items shown back to the model so it does not re-propose them. Above
 * `INSIGHT_MAX_ITEMS` because fewer passes would otherwise make the "do not repeat these"
 * instruction start lying about what it was given.
 */
export const INSIGHT_MAX_KEPT_IN_PROMPT = 60;

/**
 * One observation, as the panel shows it.
 *
 * `adopted` is the whole of the user's side of the entity: it is what survives the next pass.
 * Everything else is the model's, which is why the row is derived data and carries no
 * `deleted_at` — see the `insight_items` comment in `schema.ts`.
 */
export interface Insight {
  id: string;
  type: InsightType;
  title: string;
  body: string;
  adopted: boolean;
  createdAt: string;
}

/** `GET /api/sessions/:id/insights`. Adopted first, then the current pass, in the model's order. */
export interface GetSessionInsightsResponse {
  items: Insight[];
}

/**
 * `POST /api/sessions/:id/insights/generate`.
 *
 * `status` is what the *request* did, not the list's state, and the three answers are three
 * different claims — conflating any two of them is how the panel ends up saying something false:
 *
 * - `"ok"` — the pass ran and the list is its result. Zero items here means the model looked and
 *   found nothing, which is a claim about the conversation.
 * - `"empty"` — there was nothing to reflect on, so the model was **never called** and the list is
 *   untouched. The readable sources are all derived, so a conversation that has just been created
 *   reaches this: a call with an empty `<study_record>` would be paying for the one instruction the
 *   prompt cannot honour, "say what you actually see".
 * - `"failed"` — the call or the parse or the write did not produce a usable answer. The list is
 *   untouched, and this is a claim about the *call* rather than about the conversation.
 *
 * `ok` and `empty` both leave zero new items, which is exactly why the panel cannot infer one from
 * the other and the server has to say.
 */
export interface GenerateSessionInsightsResponse extends GetSessionInsightsResponse {
  status: "ok" | "empty" | "failed";
}

/** Body of the adopt/release PATCH. A toggle rather than two routes, like `disabled` on a user. */
export interface UpdateInsightInput {
  adopted: boolean;
}

/* ------------------------------------ stats ------------------------------------ */

/**
 * One conversation's numbers, for the statistics widgets.
 *
 * Sums cover the assistant messages that recorded usage; a turn the user stopped reports none,
 * so it contributes to the counts and nothing else. `contextTokens` is deliberately **not** a
 * sum: it is the last turn's input+output, i.e. what the conversation had grown to.
 */
export interface SessionStats {
  sessionId: string;
  title: string;
  /** Every message in the conversation, both roles. */
  messageCount: number;
  /** Summed over the assistant messages that recorded usage. */
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** The last turn's size — a level, not a running total. `0` when nothing reported one. */
  contextTokens: number;
}

export interface WorkspaceStats {
  workspaceId: string;
  /** Newest first, matching the sidebar's conversation list. */
  sessions: SessionStats[];
  /** The workspace's own totals — the sum of the rows above. */
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** What the client POSTs back to `/api/sessions/:id/answers`. */
export interface AnswerToolCallInput extends TurnRequestMeta {
  toolCallId: string;
  action: "submit" | "cancel";
  /**
   * Required (and complete) when `action` is `submit`, and keyed the way the answering
   * tool keys its answers — by position for `ask_user`, by question id for `quiz`.
   */
  answers?: InteractiveAnswer;
}

/** A single tool invocation recorded on an assistant message (for rendering + history). */
export interface ToolCall {
  id: string;
  name: string;
  /** JSON-serialized tool arguments. */
  input: string;
  /** Tool result returned to the model (present once the call completes). */
  output?: string;
  /**
   * A suspending tool only (`ask_user`, `quiz`), and absent on every other tool. Set to
   * `awaiting` when the turn suspends on this call, so the UI knows to offer the controls
   * rather than report a tool that is merely slow.
   */
  status?: ToolCallStatus;
  /**
   * A suspending tool only: the user's answer in structured form, whose shape the call's
   * `name` selects.
   *
   * A second copy of something `output` also carries, which is deliberate — `output` is
   * the model's copy (a rendering that may be reworded), this is the UI's, and neither
   * can be derived from the other without the card parsing prose.
   */
  answer?: InteractiveAnswer;
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
 * What may become a source, and the three questions a source answers about itself.
 *
 * A source used to be one thing — an uploaded file, owned by the account, stored once under
 * `sources/raw/`. It is now the single record for *every* piece of material an account has:
 * an upload, a page the agent fetched, a file the agent wrote into a workspace, and a file it
 * wrote into a conversation's own directory. Three fields, because the questions are genuinely
 * different and collapsing any two of them loses something:
 *
 * - **`origin`** — *how did this come to exist.* Fixed for the life of the row; it is
 *   provenance, and the user's own list (`会话附件 / 工作区上传 / 助理生成`).
 * - **`storage`** — *which root are the bytes under.* This is the one that *changes*: a file
 *   the user deletes from the file manager moves to `trash` rather than being erased, and an
 *   object store later would be a fifth value. It is also what the resolver switches on.
 * - **`category`** — *what is it*, coarsely, for the browser's filters and for deciding
 *   whether anything needs parsing at all.
 *
 * Declared as runtime lists wherever a catalog or a filter reads them, for the same reason
 * `PARSE_ERROR_CODES` is: a type alone is erased by the time a test runs.
 */
export const SOURCE_ORIGINS = [
  "session_attachment",
  "workspace_upload",
  "agent_workspace",
  "agent_session",
  "web",
  /**
   * A learner's own note, exported into the library by the conversation's 同步到资料库 action.
   *
   * Not one of the two `agent_*` values, and not `session_attachment` either: every one of
   * those names *who wrote* the material, and the browser prints that beside the row. This
   * material is the learner's own words — filing it under the assistant's name would attribute
   * a person's notes to a model, which is the same lie the `discovered` note below guards.
   */
  "note_export",
  /**
   * A file that was in a sandbox with no row to account for it — dropped in from the Finder, a
   * restored backup, a `git clone`, or a file from before this registry existed.
   *
   * Its own value rather than a guess between the two `agent_*` origins, because those two
   * mean "the assistant wrote this" and the browser prints them as such. A file nobody's tool
   * wrote, labelled with the assistant's name, is a lie the user has no way to catch.
   */
  "discovered",
] as const;
export type SourceOrigin = (typeof SOURCE_ORIGINS)[number];

export function isSourceOrigin(value: unknown): value is SourceOrigin {
  return typeof value === "string" && (SOURCE_ORIGINS as readonly string[]).includes(value);
}

/**
 * Where a source's bytes are. Not the same question as `origin`.
 *
 * `trash` is where a file goes when the user deletes it from the file manager: the bytes stay
 * (soft delete is the rule for on-disk bytes too) and the row keeps its identity, but the file
 * is gone from the sandbox the agent and the tree see. `upload` and `web` have no stored path
 * at all — their filename is `<id>.<ext>`, derived from the id and the MIME type.
 */
export const SOURCE_STORAGES = ["upload", "web", "workspace", "session", "trash"] as const;
export type SourceStorage = (typeof SOURCE_STORAGES)[number];

export function isSourceStorage(value: unknown): value is SourceStorage {
  return typeof value === "string" && (SOURCE_STORAGES as readonly string[]).includes(value);
}

/**
 * Who holds a source.
 *
 * A pair rather than two loose arguments because the two halves are never meaningful apart:
 * every read of a source by its owner names both, and a helper that took only an id would be
 * the bug where one account's file answers another's request.
 */
export interface SourceOwner {
  kind: "session" | "workspace";
  id: string;
}

/** Coarse content type: what the browser filters on, and what decides whether a parse is needed. */
export const SOURCE_CATEGORIES = [
  "page",
  "text",
  "code",
  "markdown",
  "diagram",
  "image",
  "document",
  "other",
] as const;
export type SourceCategory = (typeof SOURCE_CATEGORIES)[number];

export function isSourceCategory(value: unknown): value is SourceCategory {
  return typeof value === "string" && (SOURCE_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Which sandbox a file write lands in.
 *
 * A workspace's `workdir/` is shared by every conversation in that workspace; a session's own
 * directory is not. The default is `session` — a conversation's own material is the common
 * case, and a shared directory every conversation writes into turns into a junk drawer without
 * deliberate organisation. See `docs/sources.md`.
 */
export const FILE_LOCATIONS = ["workspace", "session"] as const;
export type FileLocation = (typeof FILE_LOCATIONS)[number];

export function isFileLocation(value: unknown): value is FileLocation {
  return value === "workspace" || value === "session";
}

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
  // Sources rather than attachments: the entity is the account's file, and a message only
  // holds a snapshot of one. `INVALID_ATTACHMENT_PATH` went with the old reader — the path is
  // a validated column now, so there is nothing for a client to get wrong about it.
  "SOURCE_NOT_FOUND",
  "SOURCE_STORE_FAILED",
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
  // Not a reply the server chooses to send: the provider rejected the request, and the only
  // thing we can key on is its sentence. It is here because the cause is a *setting* the user
  // can fix — a thinking model whose `reasoning` capability was never enabled — and the
  // provider's own words say nothing about that. See `classifyProviderError`.
  "REASONING_NOT_DECLARED",
  "MESSAGE_REQUIRED",
  "QUESTION_NOT_PENDING",
  "INVALID_ANSWER",
  "FILE_NOT_FOUND",
  "INVALID_FILE_PATH",
  "NOT_A_DIRECTORY",
  "NOT_A_FILE",
  /**
   * A page that could not be fetched or had nothing to store.
   *
   * One code for the whole capture, with the reason in `params.detail`, because the reasons are
   * a *fetch* guard's own words — "it resolves to a private address", "HTTP 404 from …" — and
   * the guard's sentence is more specific than any wording invented here would be. The client
   * shows the code's own sentence and appends the detail.
   */
  "PAGE_FETCH_FAILED",
  /**
   * A name that is already taken, on a rename or a move.
   *
   * Its own code rather than `FILE_NOT_FOUND`, which is what the destination *not* existing
   * means — and the two are the opposite claim about the same path. A file manager that reports
   * "not found" for a file the user can see is one whose refusal reads as a bug.
   */
  "FILE_EXISTS",
  "UNAUTHENTICATED",
  "USERNAME_REQUIRED",
  "USERNAME_TOO_LONG",
  // Two rather than one, because only the first is a client bug worth naming: an id this
  // build does not know is a version skew, while a widget installed at the wrong level is a
  // request the caller assembled wrongly. The sentences differ, so the codes do.
  "UNKNOWN_WIDGET",
  "WIDGET_SCOPE_UNSUPPORTED",
  // A note id that this conversation does not hold — unknown, another account's, another
  // conversation's, or already soft-deleted. One code for the four, like MESSAGE_NOT_FOUND.
  "NOTE_NOT_FOUND",
  // A `type` outside NOTE_TYPES. Refused rather than defaulted, for the reason `INVALID_FIELD`
  // gives: a note that silently became an annotation is a note the user did not write.
  "NOTE_TYPE_INVALID",
  // A note names a 图 or a 表 this conversation does not hold. One code for the three, like
  // NOTE_NOT_FOUND: unknown, another conversation's, or a row that has since been revised away
  // are the same answer, so a name cannot be probed for existence.
  "FIGURE_NOT_FOUND",
  // One of a turn's attached references points at something this conversation does not hold.
  // Refused rather than dropped, unlike a missing `sources` entry: a source is material the model
  // reads, while a reference is the object of the question — losing it changes what was asked.
  "REFERENCE_NOT_FOUND",
  // A note export is already running for this conversation. One at a time, so two presses
  // cannot interleave their writes into the same files or race each other's summary.
  "SYNC_IN_PROGRESS",
  // A history version was asked for (…/plan/versions/:version) that never existed. No plan
  // at all is a 200 `{ plan: null }`, not this — that is the ordinary empty state.
  "PLAN_VERSION_NOT_FOUND",
  // The plan-jump target does not exist: no plan, unknown/deleted node, or a completed node.
  "PLAN_NODE_NOT_FOUND",
  // A quiz row id the make-up POST names is not this conversation's.
  "QUIZ_QUESTION_NOT_FOUND",
  // The question exists but is not make-up-eligible: only skipped questions can be re-answered.
  "QUIZ_NOT_ANSWERABLE",
  // A message id that this conversation does not hold — unknown, another account's, another
  // conversation's, or already soft-deleted. All four are the same answer on purpose, so an id
  // cannot be probed for existence.
  "MESSAGE_NOT_FOUND",
  // Deletion peels the tail only: the named message is real but something now follows it. Two
  // tabs, or a turn that landed between the read and the write, is how a client sees this.
  "MESSAGE_NOT_LAST",
  // Nothing to regenerate: no live messages, a tail that is the user's own message, or an
  // assistant tail still waiting on the user's answer (the interactive card owns that state).
  "NO_REPLY_TO_REGENERATE",
  // A turn is streaming for this conversation right now. Only the two tail-mutating routes
  // refuse on it — /chat has no such guard, deliberately (see its note in routes.ts).
  "TURN_IN_PROGRESS",
  // Another client holds this conversation's write lock, so this one may not write to it —
  // reads still work, which is what makes the refusal a read-only conversation rather than an
  // error. Also the answer to a write that arrived with no client id at all, since a request
  // that never identified itself can never hold a lease. See docs/session-locks.md.
  "SESSION_LOCKED",

  /*
   * Accounts and signing in.
   *
   * Each of these is a different sentence to a person, which is the only reason a code
   * exists. `INVALID_CREDENTIALS` deliberately covers both "no such account" and "wrong
   * password": the two are one reply so that a name cannot be probed by reading which
   * failure came back. `ACCOUNT_DISABLED` is a third answer, and it *is* distinguishable —
   * it can only follow a correct password, so it tells an attacker nothing they had not
   * already proved.
   */
  "INVALID_CREDENTIALS",
  "ACCOUNT_DISABLED",
  // The refresh token is unknown, expired or already spent. One code for all three, for the
  // same reason as INVALID_CREDENTIALS: the client's move is identical — sign in again.
  "INVALID_REFRESH_TOKEN",
  "PASSWORD_REQUIRED",
  "PASSWORD_TOO_SHORT",
  "PASSWORD_TOO_LONG",
  // The new password is the old one. Refused because the account was told to change it, and
  // accepting the same value would leave `mustChangePassword` cleared and the choice unmade.
  "PASSWORD_UNCHANGED",
  // Nobody has a password yet, so no account can sign in. The server refuses to *listen* in
  // that state, so this is only reachable through `buildServer` — a test harness, an embedder —
  // and it is what makes a bypassed boot rule legible rather than a 401 that reads as a wrong
  // password.
  "SETUP_REQUIRED",
  // The account is signed in and still owes a password change. Every route but the three that
  // make that state escapable answers 403 with this, which is what makes "you must change your
  // password before you can enter" a rule rather than a screen.
  "PASSWORD_CHANGE_REQUIRED",
  "USER_NOT_FOUND",
  "USERNAME_TAKEN",
  // A body field of the wrong shape — a string where a boolean belongs, say. Refused rather
  // than coerced, because coercion is what turns `"false"` into "yes": the console sends real
  // booleans, so this is only ever a hand-written request, and guessing at what it meant is how
  // a self-disable slipped past the guard that exists to prevent it.
  "INVALID_FIELD",
  // The caller is signed in but holds no role that may do this. Distinct from "not signed in"
  // (401): the credential is fine, the account simply may not do this.
  "FORBIDDEN",
  // The change would lock the console out of itself — disabling or demoting the account making
  // the request. There is deliberately no separate "last administrator" code: this refusal is
  // what makes that unreachable, since only a signed-in administrator can reach the route.
  "CANNOT_MODIFY_SELF",
  /*
   * Two refusals that only exist because there are two tiers of administrator.
   *
   * `CANNOT_MODIFY_ADMIN` is the ordinary admin who reached a row holding an administrative
   * role: they may run the installation's *accounts*, and an account that administers it is not
   * one of them. It is about the target, not the action, which is why it is not `FORBIDDEN` —
   * the same caller may disable an ordinary account in the same breath.
   *
   * `PANEL_RESET_REQUIRED` is a superadmin trying to reset *their own* password from the web
   * console. That is refused rather than merely discouraged: the console is reached with a
   * credential the superadmin already has, so a self-reset there would be a second, weaker way
   * to replace the one credential that can undo everything — and the control panel, which
   * proves identity by being the machine, is the way back in by design.
   */
  "CANNOT_MODIFY_ADMIN",
  "PANEL_RESET_REQUIRED",
  // A role this account is not allowed to grant. Distinct from `INVALID_FIELD` (which is a role
  // this build does not know): here the role is real and the caller may not hand it out.
  "ROLES_NOT_GRANTABLE",
  /*
   * The superadmin role is not granted from a screen, by anybody.
   *
   * An installation has exactly one superadmin, the account the desktop control panel
   * bootstraps with the server stopped (`cli create-admin`, which itself refuses once one
   * exists). Neither the create-account dialog nor an account edit may hand the role out, and
   * that is a rule on every HTTP caller rather than a box the console decided not to draw — a
   * hand-written request must meet the same refusal as a click.
   */
  "SUPERADMIN_NOT_GRANTABLE",
  /*
   * One code for four cases: an insight id that is unknown, another account's, another
   * conversation's, or already gone with the pass that replaced it. They answer the same way on
   * purpose, like `NOTE_NOT_FOUND` and `MESSAGE_NOT_FOUND` — an id that can be probed by the
   * shape of the refusal is an id that can be probed.
   */
  "INSIGHT_NOT_FOUND",
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

/**
 * A file the user attached to a message, **as it was attached**.
 *
 * `id` is a *source* id (`Source` below), and everything else here is a snapshot: the parse
 * state at the time, and the name the user actually used. That is deliberate rather than
 * duplicated. A source is shared — the same bytes uploaded twice are one source, and a
 * source can be referenced by several conversations — so its own `name` is whichever spelling
 * arrived first, and its parse state is whatever it is *now*. A message that showed "my
 * draft.pdf, parsed" should keep reading that way even if the source was renamed, reparsed
 * or unlinked afterwards.
 *
 * Bytes live on the server, never in this object.
 */
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
 * One piece of material the account holds, as the *server* knows it.
 *
 * The entity behind `Attachment.id`, and — since sources became the one registry — behind
 * every file the agent writes and every page it fetches. Three things make it different from
 * the message snapshot above, and all three are why it exists:
 *
 * - **It is owned by a workspace or a conversation, and so by the account**, not by the
 *   message that happened to use it. The same PDF uploaded in two conversations is one source
 *   with two references, so its bytes are stored once and parsed once. `ownerKind`/`ownerId`
 *   say who holds it; a workspace picking up a source uploaded in one of its conversations is
 *   a *link*, not a second owner.
 * - **Its fields are current.** `parseStatus` is whatever the last parse did, not what it was
 *   when some message was sent — which is what lets a reparse be reflected everywhere at once
 *   instead of only in conversations that start afterwards.
 * - **It says where it came from and what it is.** `origin`, `storage` and `category` are the
 *   three questions the old upload-only row could answer only by implication.
 *
 * `name` is the first name the file was uploaded under. With dedupe that means a second
 * upload of the same bytes shows the first name, which is why the message snapshot keeps its
 * own: the name the user typed belongs to the message, not to the bytes.
 */
export interface Source extends Attachment {
  createdAt: string;
  /** When the row last changed — a rename, a rewrite, a new summary. */
  updatedAt?: string;
  /** Who holds it. `ownerId` is that session's or workspace's id. */
  ownerKind: "session" | "workspace";
  ownerId: string;
  /** How it came to exist. Fixed for the life of the row. */
  origin: SourceOrigin;
  /** Which root the bytes are under. The one field here that changes. */
  storage: SourceStorage;
  /** The coarse content type — what the browser filters on. */
  category: SourceCategory;
  /**
   * Where it sits inside its root. Absent for `upload` and `web`, whose filename is
   * `<id>.<ext>` and therefore derived from the id and the MIME type rather than stored.
   */
  relPath?: string;
  /** The page this source is, when it is one. */
  url?: string;
  /**
   * What to call the thing that holds it: a workspace's name, or a conversation's title.
   *
   * Resolved server-side because a *conversation* owner is not something the client can name —
   * it holds the workspaces but not the conversations in them, and a list spanning the account
   * would need a request per workspace to label one. Absent when the owner is gone, which is
   * the same "reached through" rule the owner columns themselves follow.
   */
  ownerName?: string;
  /**
   * The workspace this source ultimately belongs to, whether it is owned by one or held by a
   * conversation in it. The browser groups by this, and a session-owned upload would otherwise
   * be grouped under nothing.
   */
  workspaceId?: string;
  workspaceName?: string;
  /**
   * The model's one-liner about this source, when something has produced one — a page's
   * abstract, an image's description. Distinct from `parsedChars`, which counts extracted
   * text: a summary is the *only* text an image ever has.
   */
  summary?: string;
  /**
   * The row is live and the bytes are gone — deleted outside the app, or by the agent's own
   * `delete_file`, which is a real filesystem operation rather than an application deletion.
   *
   * **Computed on read, never stored.** A stored flag would need somebody to clear it on the
   * next write, and the one writer that can create the drift is the file tool — which must
   * not become a database write. Same rule as `Diagram.fileMissing`.
   */
  missing?: boolean;
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
   * The user interrupted this turn, so `content` is only as much as had streamed when Stop
   * was pressed — possibly nothing at all.
   *
   * A stopped turn is still persisted, and still counts as the assistant's half of the
   * exchange: dropping it would leave the next turn's history opening on a user message with
   * no reply. Absent on every other message, including the `⚠️` one written when a turn fails.
   */
  stopped?: boolean;
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
  /**
   * The sources this turn *referenced*, as snapshots taken when it was sent.
   *
   * The same rule as `attachments`, and the same reason for a snapshot rather than a live
   * lookup: a message describes the turn that was had. A source referenced here and deleted
   * afterwards still reads as referenced, and the chip keeps the name the composer showed.
   */
  sources?: Attachment[];
  /**
   * What the user pointed at when they sent this turn — the 追问 chips, as they were shown.
   *
   * A snapshot on the same rule `sources` follows, and for the same reason: a message describes
   * the turn that was had, so a diagram referenced here and revised afterwards still reads as
   * referenced, and the chip keeps the label the composer showed.
   *
   * **It is replayed to the model, and that is load-bearing rather than tidy.** `/regenerate`
   * sends `userMessage: null` and rebuilds the turn from history; if a reference lived only in
   * the turn's own prompt, regenerating an answer about a diagram would ask the model the same
   * question with no idea what it was about. Replaying costs a re-resolution per stored reference
   * per turn — the same trade `sourcePaths` already makes for attachments — and what comes back
   * is current: a figure revised since is read as it is now, not as it was.
   */
  refs?: TurnReference[];
  usage?: MessageUsage;
  createdAt: string;
}

/**
 * What an account is allowed to do.
 *
 * A **list** on every account rather than a single role column, even though only one
 * combination exists today. The permission checks are already written as "does this account
 * hold role R", so adding a third role — or letting somebody hold two — is a row that
 * changes and nothing else. A single-valued column would make every check a comparison
 * against a name, and the first account needing two of them would be a migration.
 */
export const USER_ROLES = ["superadmin", "admin", "user"] as const;

export type UserRole = (typeof USER_ROLES)[number];

export const isUserRole = (value: unknown): value is UserRole =>
  typeof value === "string" && (USER_ROLES as readonly string[]).includes(value);

/** The role that reaches the platform console. Named once so the check reads the same way. */
export const SUPERADMIN_ROLE: UserRole = "superadmin";

/**
 * The ordinary administrator: granted by a superadmin, and able to run the platform day to day.
 *
 * A second tier rather than a second flag, and the split is about *who may appoint whom* rather
 * than about which screens exist. A superadmin is the account the installation was bootstrapped
 * with — created by the control panel or the CLI, and the only one that can promote anybody else
 * — so a superadmin cannot be edited, disabled or signed out from the web console at all. An
 * `admin` administers the installation's accounts and its shared settings, and the accounts it
 * may touch are the ones that hold no administrative role.
 *
 * Composed into `isPlatformAdmin` below rather than compared directly at call sites: every
 * screen that asks "may this account administer" wants the whole set, and a check written as
 * `roles.includes(ADMIN_ROLE)` is one that silently excludes the superadmin.
 */
export const ADMIN_ROLE: UserRole = "admin";

/**
 * Every role that may administer the platform.
 *
 * **A superadmin is a platform admin**, and that is the point of spelling it as a set rather
 * than writing `isSuperadmin(x) || isAdmin(x)` at each of a dozen call sites — the second tier
 * is an *addition* to the first, not a replacement, so the bootstrap account never has to be
 * given a second role to keep working.
 */
export const PLATFORM_ADMIN_ROLES: readonly UserRole[] = [SUPERADMIN_ROLE, ADMIN_ROLE];

/**
 * The roles the platform console is allowed to assign.
 *
 * **`superadmin` is deliberately absent.** An installation has exactly one superadmin, the
 * account the desktop control panel creates with the server stopped; the web console creates
 * and edits accounts but can neither mint a second one nor appoint one. The server enforces
 * the same refusal (`SUPERADMIN_NOT_GRANTABLE`) — this list is the shape the checkboxes take,
 * not the guard itself.
 *
 * A superadmin grants `admin`; an ordinary administrator sees that box locked (their tier may
 * run accounts, not appoint one). Both may hold `user`, which is the default.
 */
export const CONSOLE_GRANTABLE_ROLES: readonly UserRole[] = [ADMIN_ROLE, "user"];

/**
 * Whether an account is the installation's *original* administrator. Ignores `disabled`.
 *
 * The narrower of the two questions, and the one that decides who may appoint whom. It lives
 * here beside `isPlatformAdmin` rather than in the server's `auth.ts` — where it started — for
 * the `ALL_TOOL_NAMES` reason: the console draws different controls for the two tiers, so the
 * server's checks and the page's disabled states have to be the *same* predicate, and two
 * spellings of `roles.includes("superadmin")` is how they stop being.
 */
export const isSuperadmin = (user: Pick<User, "roles">): boolean =>
  user.roles.includes(SUPERADMIN_ROLE);

/** Whether an account holds a role that may administer the platform. Ignores `disabled`. */
export const isPlatformAdmin = (user: Pick<User, "roles">): boolean =>
  user.roles.some((role) => PLATFORM_ADMIN_ROLES.includes(role));

/**
 * An administrator who can actually sign in.
 *
 * Roles and the disabled flag are two separate columns, and every rule about "is there somebody
 * who can administer this installation" needs both — a disabled superadmin holds the role and
 * can do nothing with it. Composed once, in shared, because the server's boot rule, the
 * administrator CLI and the web console all ask it: two spellings of this is how the panel
 * comes to say "there is no administrator" while the CLI refuses to make one.
 */
export const isEnabledSuperadmin = (user: Pick<User, "roles"> & { disabled: boolean }): boolean =>
  !user.disabled && user.roles.includes(SUPERADMIN_ROLE);

/** The same question for the wider set: an enabled account that may administer the platform. */
export const isEnabledPlatformAdmin = (
  user: Pick<User, "roles"> & { disabled: boolean }
): boolean => !user.disabled && isPlatformAdmin(user);

/**
 * What an account holds when nobody says otherwise.
 *
 * Shared rather than a literal at each site because it is also the `users.roles` column
 * default: the database and the create route have to agree, and two spellings of the same
 * policy is how they would stop.
 */
export const DEFAULT_USER_ROLES: readonly UserRole[] = ["user"];

/**
 * One account, as the signed-in holder of it sees themselves.
 *
 * No `disabled` here, and its absence is not an oversight: a disabled account cannot sign
 * in, so the only client that could render the flag is one that was refused. It lives on
 * `AdminUser`, which is the view that has a reason to show it.
 */
export interface User {
  id: string;
  username: string;
  /**
   * The directory name under `users/`, fixed when the account is created. Renaming the
   * username does not change it, for the same reason a workspace's does not: every path in
   * the user's own workspaces, and every path the agent has already written into a
   * conversation, is built on top of it.
   */
  slug: string;
  roles: UserRole[];
  /**
   * The account still has to choose its own password before it can use anything.
   *
   * True after an administrator creates it or resets its password. The client turns this
   * into a screen the user cannot navigate away from, and the **server enforces it as well**
   * — every route except the ones that change the password answers 403 while it is set.
   * Client-side enforcement alone would be a suggestion: the token works, so anything that
   * can make a request could skip the screen.
   */
  mustChangePassword: boolean;
  createdAt: string;
}

/**
 * An account as the platform console lists it.
 *
 * A separate shape from `User` rather than a superset of it, because the two are read by
 * different people for different reasons: `User` is what a browser needs to render its own
 * session, this is what an administrator needs to manage somebody else's.
 */
export interface AdminUser {
  id: string;
  username: string;
  slug: string;
  roles: UserRole[];
  disabled: boolean;
  mustChangePassword: boolean;
  createdAt: string;
}

/**
 * The `localStorage` key the browser keeps its token pair under.
 *
 * Here rather than private to the web app for the reason `ALL_TOOL_NAMES` is: two sides have
 * to agree on the literal, and a shared constant is what stops them drifting. The browser
 * writes it; the e2e harness reads it to *remove* it, which is the only way a browser spec can
 * present itself as signed out — the session is a token now, so clearing cookies does nothing.
 */
export const AUTH_STORAGE_KEY = "ila-auth";

/** The shortest password the server will accept from a person choosing one. */
export const PASSWORD_MIN_LENGTH = 8;
/** Long enough for a passphrase, short enough that hashing stays a rounding error. */
export const PASSWORD_MAX_LENGTH = 200;
export const USERNAME_MAX_LENGTH = 64;

/* ------------------------------- authentication ------------------------------ */

/**
 * The pair a signed-in client holds.
 *
 * Both are opaque random strings, not JWTs, and the difference is the point: the server
 * keeps a row per token, so "sign this account out everywhere" is one `UPDATE` rather than
 * a key rotation that invalidates everybody. A JWT would be self-describing and would
 * therefore be *unrevocable* without exactly the table it was meant to avoid.
 *
 * The two lifetimes are split so that a leaked access token is worth a day and a leaked
 * refresh token is only useful once — see `AuthResult` on rotation.
 */
export interface AuthTokens {
  accessToken: string;
  /** Seconds until `accessToken` expires, so the client can refresh before it does. */
  expiresIn: number;
  refreshToken: string;
}

export interface AuthResult {
  user: User;
  tokens: AuthTokens;
}

/* ------------------------- the administrator bootstrap ------------------------ */
/*
 * The first administrator is created by the **control panel**, not by the web app, and not
 * through the HTTP API: the panel spawns `apps/server/src/cli.ts` as a one-shot child so it
 * works with the server deliberately stopped. `main()` refuses to listen until an
 * administrator exists, which is what makes `POST /api/auth/setup` unnecessary — there is no
 * running server for which "nobody can sign in yet" is true.
 *
 * What crosses that process boundary is a small JSON envelope, and these are its vocabulary.
 * They live here, next to the HTTP codes they share a policy with, for the `ALL_TOOL_NAMES`
 * reason: the panel writes the catalog that renders a code, and two spellings of one refusal
 * is a sentence that stops appearing.
 */

/**
 * The refusals a username or a password can earn.
 *
 * A subset of `ApiErrorCode`, named separately because these five are the ones the *policy*
 * produces — `passwordProblem` and `usernameProblem` can return nothing else, on either
 * channel. Naming them is what lets the CLI's envelope be exhaustive and the panel's catalog
 * be checked against it, rather than both being open-ended over every code the API can send.
 */
export const CREDENTIAL_ERROR_CODES = [
  "USERNAME_REQUIRED",
  "USERNAME_TOO_LONG",
  "PASSWORD_REQUIRED",
  "PASSWORD_TOO_SHORT",
  "PASSWORD_TOO_LONG",
] as const;

export type CredentialErrorCode = (typeof CREDENTIAL_ERROR_CODES)[number];

/**
 * The error envelope with its code narrowed.
 *
 * `ApiErrorBody` is this over every code either channel can send; a rule that can only
 * produce five of them says so instead, which is what lets the CLI's envelope be exhaustive
 * and the panel's catalog be checked against it rather than left open-ended.
 */
export interface CodedErrorBody<C extends string> {
  error: { code: C; message: string; params?: Record<string, string | number> };
}

/**
 * Every way the administrator CLI can refuse.
 *
 * The credential five first, because those come straight out of the shared policy, then the
 * ones only a command line can produce. `SCHEMA_UNREADABLE` and `NOT_A_DATABASE` exist so
 * `status` can say *which* of the ways a database is unusable it found: a caller told "no
 * administrator" for a file it merely could not read would offer to create one, which is
 * either a lie or a second, empty database beside the real one.
 */
export const ADMIN_CLI_ERROR_CODES = [
  ...CREDENTIAL_ERROR_CODES,
  /** An enabled superadmin already exists, and there is deliberately only ever one bootstrap. */
  "ADMIN_EXISTS",
  /**
   * There is no administrator to act on.
   *
   * Distinct from `ADMIN_EXISTS` rather than folded into `USER_NOT_FOUND`, because the two
   * commands that produce it are asking different questions: `reset-admin` on a data root
   * nobody has set up is "there is nothing here to recover", which the panel says in the same
   * breath as offering to create one.
   */
  "ADMIN_NOT_FOUND",
  /** No data root has been chosen — `ILA_DATA_DIR` is unset. */
  "DATA_DIR_MISSING",
  /** The path exists but is a file, or cannot be read as a directory. */
  "DATA_DIR_INVALID",
  /** The database is real but was written by a schema this build cannot read. */
  "SCHEMA_UNREADABLE",
  /** The file is not a SQLite database at all. */
  "NOT_A_DATABASE",
  /** It opened, and a read failed — busy, permissions, an unrecovered write-ahead log. */
  "UNREADABLE",
  /** The command line itself was wrong. */
  "USAGE",
  /** A bug. The message is what the caller has. */
  "INTERNAL",
] as const;

export type AdminCliErrorCode = (typeof ADMIN_CLI_ERROR_CODES)[number];

/**
 * Every curated code in the product, whichever channel sends it.
 *
 * The three unions overlap — `USERNAME_REQUIRED` is an HTTP code *and* a CLI one — but none
 * contains another, so a constructor for the envelope has to accept all three. Constraining it
 * to this rather than to bare `string` is what keeps an invented code a compile error.
 */
export type AnyErrorCode = ApiErrorCode | ParseErrorCode | AdminCliErrorCode;

/**
 * The CLI's failure arm — literally the HTTP error body, one channel over.
 *
 * The same shape rather than a parallel one, so a code means one thing in the product: the
 * panel maps these to its own catalog exactly as it maps `ServerFault`, and a refusal written
 * for the command line reads identically if the same rule is ever enforced over HTTP again.
 */
export type AdminCliErrorBody = CodedErrorBody<AdminCliErrorCode>;

/**
 * Whether a data root has an administrator, and whether it has a database at all.
 *
 * `database` is separate from `hasAdmin` on purpose. A folder with no database is the
 * ordinary first-run state and the answer to "may I create one" is yes; a folder whose
 * database could not be *read* is not that, and must never be reported as it.
 */
export interface AdminStatusResult {
  ok: true;
  command: "status";
  dataRoot: string;
  database: "absent" | "present";
  hasAdmin: boolean;
  /** Who the administrator is, so the panel can say which account it found. */
  adminUsername: string | null;
}

/**
 * The first administrator, created or adopted.
 *
 * `adopted` is the upgrade path: a data root carried over from the build where a username was
 * the credential has accounts and no passwords, and the one that shares this name is the one
 * whose workspaces are on disk. Creating a second account beside it would strand them.
 *
 * `password` is present only when the CLI invented one (`--generate`), and it is shown once —
 * only a hash is stored, so there is no second reading.
 */
export interface AdminCreateResult {
  ok: true;
  command: "create-admin" | "ensure-admin";
  dataRoot: string;
  /** False only from `ensure-admin`, which is a no-op when an administrator already exists. */
  created: boolean;
  username: string;
  slug: string;
  adopted: boolean;
  generated: boolean;
  password?: string;
}

/**
 * A superadmin's password, replaced by the control panel.
 *
 * The same shape as `AdminCreateResult`'s success arm: `password` is present only when the CLI
 * *generated* one (`--generate`, the terminal's path) — the panel hands the operator's own
 * choice in on stdin and gets no password back, because echoing a chosen credential back over
 * IPC is a leak with no upside. Either way only a hash is stored.
 */
export interface AdminResetResult {
  ok: true;
  command: "reset-admin";
  dataRoot: string;
  username: string;
  /** The invented password, shown once. Absent when the caller chose it. */
  password?: string;
}

export type AdminCliResult = AdminStatusResult | AdminCreateResult | AdminResetResult;

/** Creating an account from the console. The password is the server's to invent. */
export interface CreateUserInput {
  username: string;
  roles?: UserRole[];
}

/** What the console may change about an account. A username is not among them. */
export interface UpdateUserInput {
  roles?: UserRole[];
  disabled?: boolean;
}

/**
 * A newly created account, or one whose password was just reset.
 *
 * `password` is present **exactly once** — in the reply that set it — and is never readable
 * again: only a hash is stored, so there is nothing to re-read even for an administrator.
 * That is why the console offers a copy button rather than a "show password" one.
 */
export interface UserCredentials {
  user: AdminUser;
  password: string;
  /**
   * A fresh pair, present **only** when an administrator reset their own password.
   *
   * Resetting a password ends every session of the account — that is half of what a reset is
   * — which would otherwise sign the administrator out of the console they are standing in.
   * Handing back a replacement is what keeps the action from looking like a bug.
   */
  tokens?: AuthTokens;
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  /**
   * The workspace's **own** directory — the parent of `workdir/` and `sessions/`. This is
   * what deleting a workspace removes, and what the card on the home page names.
   */
  dirPath: string;
  /**
   * The directory the agent's file tools are sandboxed to, and the root the file browser
   * lists: `dirPath/workdir`.
   *
   * Carried alongside `dirPath` rather than left to each caller to append, because the two
   * are read for different reasons and a convention is invisible: the agent's system prompt
   * names the sandbox, `DELETE` removes the parent, and writing the sandbox's files into
   * the parent would leave them outside the sandbox and inside the workspace's own state.
   */
  workdirPath: string;
  /**
   * The workspace's own settings — what a conversation in it inherits unless the conversation
   * (or the Copilot it came from) says otherwise. Absent on a workspace created before this
   * existed, which reads as "no opinion" at every level.
   */
  settings?: WorkspaceSettings;
  /**
   * What this workspace is for, in the account's own words. Empty means nobody wrote one.
   *
   * Display-only: it reaches no prompt, so it is a note to the reader rather than an
   * instruction to a model. Renaming a workspace is display-only in the same way and for a
   * related reason — the directory keeps its slug — but unlike the name this one is editable
   * wherever the workspace is configured.
   */
  description: string;
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
  /**
   * The source row this file *is* — its id, which is what a rename or a delete addresses it by.
   *
   * Present on files and absent on directories, because a directory is not a source. It is
   * filled in by the listing itself: the route reconciles the rows for what it found before
   * answering, so an id is always there — including for a file that appeared with no writer,
   * which is a file the browser can still rename. A listing that returned entries without ids
   * would make the file manager possible only for files the agent happened to have written.
   */
  sourceId?: string;
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
 *
 * `diagram` is the first member added after the fact, and it taught that the sentence above
 * is only true of sites that *switch*. `FilePreviewDialog` dispatched on a `v-else-if` chain
 * whose last branch was `<pre v-else-if="content">`, so a mermaid file compiled cleanly and
 * silently rendered as highlighted text — plausible-looking, and wrong. The chain was turned
 * into an exhaustive switch in the same change. A new kind is a compile error only once a
 * site says so; until then the fallthrough is what handles it.
 *
 * `binary` is the second, and it replaced a member rather than only adding one. The old
 * `unsupported` claimed something the server cannot know: *whether anything can render this*.
 * That answer lives in a plugin registry inside the browser bundle, so a server asserting it
 * was asserting a fact about a table it cannot see — and the day a format gained support, the
 * server would have gone on refusing it. `binary` claims only what `classify` actually
 * established: **not text; the bytes are yours to hand to a viewer.** The client decides the
 * rest, and `unsupported` survives as a *client* view state for a file no plugin matches.
 *
 * The rule from the paragraph above still holds, and this is where it applies: extensionless
 * files, `Makefile` and `LICENSE` are decided by sniffing bytes, which is why *this* end of
 * the question — text versus binary — stays on the server. Only the previewability half moved.
 */
export const FILE_CONTENT_KINDS = ["text", "markdown", "diagram", "binary"] as const;
export type FileContentKind = (typeof FILE_CONTENT_KINDS)[number];

/**
 * A file's metadata, plus its text when the server decided there was any to send.
 *
 * `text` is null for `binary` on purpose — there is no text to send, so there is no way for a
 * caller to render a binary as mojibake, and the bytes are deliberately not in this reply:
 * they come from the raw route, which is the only place a preview may pull them from (see
 * `MAX_FILE_PREVIEW_BYTES`). `truncated` says the file is longer than the preview cap, which
 * the UI states outright rather than letting a file look like it ends there. It is always
 * false for `binary`, where nothing was truncated because nothing was read.
 */
export interface FileContent {
  path: string;
  name: string;
  size: number;
  modifiedAt: string;
  kind: FileContentKind;
  text: string | null;
  truncated: boolean;
  /**
   * The model's one-line description of a diagram, set only on a **session-root** read of a
   * file a `session_diagrams` row names. Absent in every other case — a workspace-root read,
   * and a `.mmd` nobody drew here — so the client treats "not present" as "no summary".
   */
  summary?: string;
  /**
   * The page these bytes came from, set only on a `page` source's preview.
   *
   * The preview of a page source is the app's *stored copy* of the reading — extracted HTML, shown
   * as source. Offering "open in browser" there means the dialog has to know where the reading came
   * from, and the alternative was a second request for a field the route already has in hand
   * (`Source.url`). Absent for every other file, which is the same "no page, nowhere to go" the
   * listing rows render on.
   */
  url?: string;
}

/**
 * The extensions a diagram is written with, and the test a directory listing filters by.
 *
 * Shared rather than declared on the server, because the *client* is the side that has to
 * pick the diagrams out of a listing — and a `DirectoryListing` carries names and sizes, not
 * the `kind` that only a content read produces. This is the `ALL_TOOL_NAMES` argument again:
 * the client writes the question and the server answers it, so a second copy is a viewer
 * that quietly stops matching the day an extension is added here.
 *
 * `.mmd` is what `ila_diagram` writes; `.mermaid` is what people arrive with, and both are
 * plain text so a `.mmd` from elsewhere reads as a diagram rather than as an unknown file.
 */
export const DIAGRAM_FILE_EXTENSIONS = ["mmd", "mermaid"] as const;

/**
 * How much diagram source is worth writing, and worth rendering.
 *
 * Shared, and the only size constant here that is: `MAX_HIGHLIGHT_CHARS` lives on the client
 * because highlighting is the client's own work, but a diagram is refused on *both* sides of
 * the wire — the tool will not write a source past this, and the renderer will not lay one
 * out. Two copies of the number would be a diagram the tool accepts and the viewer declines
 * to draw, which reads as a broken viewer rather than a very large diagram.
 *
 * Generous on purpose. A hand-written mermaid file is a few hundred bytes; this is the size
 * at which a model has stopped drawing and started concatenating, and it exists because
 * mermaid's layout is not linear in the input.
 */
export const MAX_DIAGRAM_CHARS = 50_000;

/** Whether a file's *name* says it holds diagram source. Extension only, and case-blind. */
export function isDiagramFile(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return (DIAGRAM_FILE_EXTENSIONS as readonly string[]).includes(name.slice(dot + 1).toLowerCase());
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
  /**
   * Where an unqualified file write lands. `null`/absent means "inherit from the next level
   * up" — the workspace's default, and then `session`.
   *
   * It rides `settings` rather than a column of its own so that the whole precedence chain
   * (workspace → Copilot → session) is the chain that already exists: a Copilot's settings are
   * copied onto the session at creation, which is why nothing reads a Copilot at turn time.
   */
  writeLocation?: FileLocation | null;
  /**
   * The workspaces this conversation may read *across*, granted by `@`-referencing them.
   *
   * `null`/absent means no grant, which is what every conversation created before this existed
   * reads as — nothing widens by default.
   *
   * It is a **session setting rather than a turn field**, and that is the load-bearing choice:
   * a reference persists (`session_sources` is the precedent — pointing at something once makes
   * it readable on every later turn), and all three turn routes must resolve the same grant, so
   * `/answers` and `/regenerate` cannot resume a turn with a narrower one than the turn that
   * asked the question. A request field could not give either.
   */
  workspaceScope?: WorkspaceScope | null;
}

/**
 * The workspaces a conversation may read across, as the user granted them with `@`.
 *
 * These are **read** grants and nothing else: no write, no delete, and no widening of the file
 * tools' own sandboxes, which keep their two roots. What a grant opens is `read_document` (the
 * granted workspaces' uploads and kept pages), `ila_explore` (their files and conversations),
 * and `ila_query`'s index of what may be read.
 *
 * `all` is a **flag, not a snapshot**: it means every workspace the account holds, including
 * ones created after the grant. Storing the ids it implied would answer the question the user
 * asked ("everything I have") with the answer to a different one ("everything I had on
 * Tuesday"). The two halves are never both meaningful — picking `@所有工作区` drops
 * `workspaceIds` rather than leaving a list nobody can see underneath a flag that covers it.
 */
export interface WorkspaceScope {
  /** Every workspace this account holds — including ones created after this was set. */
  all?: boolean;
  /** Named workspaces. Never the conversation's own: `@`-ing the workspace you are in grants nothing. */
  workspaceIds?: string[];
}

/** A Copilot's default settings, copied onto a session at creation time. */
export type CopilotDefaults = SessionSettings;

/**
 * A workspace's own settings — the defaults its conversations inherit.
 *
 * Deliberately the same *shape* as `SessionSettings` rather than a type of its own, so that
 * creating a conversation is one spread in the order the requirement asks for and no level
 * needs its own reading of the field.
 *
 * It carries `writeLocation` and deliberately **not** `workspaceScope`, and the difference is
 * not an oversight. The shared shape is about the spread at creation being one thing, not about
 * every field propagating: a workspace default that handed read access to all the other
 * workspaces to every conversation started in it is a grant made by nobody, from a screen that
 * is about a directory. The `@` grant is made per conversation, by the person in it.
 */
export interface WorkspaceSettings {
  writeLocation?: FileLocation | null;
}

/**
 * Who a Copilot is visible to.
 *
 * `private` means its owner alone; `public` means every account can see and *use* it, while
 * still only its owner can edit or delete it. That asymmetry is the whole of the "platform"
 * concept — there is no separate tier and no admin role, so a Copilot the operator wants
 * everyone to have is simply one they published.
 */
export type CopilotVisibility = "private" | "public";

/**
 * A reusable persona: a system prompt, a tool allowlist and generation defaults.
 *
 * Owned by the account that created it. Using one does not reference it — a conversation
 * **copies** this whole definition at creation, so later edits here leave conversations
 * already underway untouched, and a session whose Copilot has been deleted still behaves as
 * it did.
 */
export interface Copilot {
  id: string;
  /** The owning account. Never another account's Copilot, unless `visibility` is `public`. */
  userId: string;
  /** The owner's username, so a public Copilot can be attributed to whoever published it. */
  ownerName?: string;
  name: string;
  description: string;
  systemPrompt: string;
  /**
   * Whether every tool is available. **Authoritative over `tools`.**
   *
   * This exists because "no tools allowed" was previously unexpressible: an empty `tools` list
   * meant *every* tool, so a Copilot could not be locked down to none. The two states are now
   * distinct and both reachable — `allTools: true` means everything the turn assembled, and
   * `allTools: false` with an empty `tools` means nothing at all.
   *
   * `allTools: true` also means `tools` is empty and carries no authority; the write paths
   * clear it so a stored row cannot disagree with itself, and readers derive from the flag.
   */
  allTools: boolean;
  /**
   * Tool names this copilot is allowed to use, meaningful **only when `allTools` is false** —
   * and then exhaustive, so an empty list means no tools rather than all of them.
   */
  tools: string[];
  /** Defaults handed to new conversations started with this copilot. */
  settings: CopilotDefaults;
  /**
   * Widgets a conversation started from this copilot installs.
   *
   * Always resolved on the wire: a copilot whose selection has never been set reads as the
   * defaults rather than as `[]`, because the two are different claims — "nobody decided" and
   * "decided: none". The stored column is nullable to keep them apart; this is not.
   */
  widgets: WidgetId[];
  visibility: CopilotVisibility;
  createdAt: string;
  updatedAt: string;
}

/**
 * Where a conversation's title came from. `auto` means a model wrote it after the first
 * turn and may rewrite it; `user` means a person typed it and it must never be touched.
 */
export type TitleSource = "auto" | "user";

/**
 * How the automatic titler last left a conversation — absent when it has never run.
 *
 * A different question from `TitleSource` beside it, and the difference is the whole reason this
 * exists: that one says *who owns* the title, and this says **how the automatic pass fared**.
 *
 * - `"model"` — the model wrote the title. Nothing left to do.
 * - `"fallback"` — the call failed, and what is showing is the user's own clipped words. This is
 *   the state the retry exists for, and it used to be indistinguishable from the one above: both
 *   leave `titleSource: "auto"` and a non-empty title, so nothing could tell a titled conversation
 *   from one that had merely failed to be.
 * - absent — never attempted, because the turn produced no text to name. The title is still the
 *   create-time placeholder, which is equally worth another try.
 */
export type TitleState = "model" | "fallback";

/**
 * What `POST /api/sessions/:id/leave` answers.
 *
 * Three outcomes rather than a boolean, because the client does something different with each:
 * `titled` carries a title to show, `skipped` means nothing was wrong and nothing needed doing,
 * and `failed` means the model call did not work — which the reader is told nothing about, since
 * they have already left and the next leave will try again.
 */
export interface TitleRetryResult {
  status: "titled" | "skipped" | "failed";
  /** Present only with `titled`. */
  title?: string;
}

/**
 * A conversation.
 *
 * The Copilot fields are a **snapshot, not a reference**. `copilotId` is the only link back,
 * it is nullable, and it is deliberately allowed to dangle: `ON DELETE SET NULL` means
 * deleting a Copilot clears the link while `copilotName`, `systemPrompt`, `tools` and
 * `settings` keep the conversation behaving exactly as it did. `settings` was always copied;
 * `systemPrompt` and `tools` joined it because a live-read persona meant editing a Copilot
 * silently rewrote every conversation using it, and a live-read allowlist meant deleting one
 * silently *widened* them (an empty list reads as "all tools").
 *
 * Each of the three is independently editable afterwards — that is what "the conversation
 * owns its persona" means in practice, and it is why the per-turn Copilot override is gone.
 */
export interface Session {
  id: string;
  workspaceId: string;
  /** The Copilot this was created from, if any. May be null after that Copilot was deleted. */
  copilotId: string | null;
  /** The Copilot's name as it was at creation, so the UI can label the conversation anyway. */
  copilotName: string;
  /** The conversation's own system prompt. Empty means the built-in assistant prompt. */
  systemPrompt: string;
  /** Whether every tool is available. Authoritative over `tools`, exactly as on a Copilot. */
  allTools: boolean;
  /**
   * The conversation's own tool allowlist, meaningful only when `allTools` is false and then
   * exhaustive (empty = no tools).
   */
  tools: string[];
  title: string;
  titleSource: TitleSource;
  /**
   * How the automatic titler last left this conversation — see `TitleState`.
   *
   * On the wire because the *client* is the one that decides whether to ask for a retry: it
   * reports a leave, and asking the server to re-title a conversation the model already named
   * would be a model call per conversation the reader walks away from.
   */
  titleState?: TitleState;
  settings: SessionSettings;
  /**
   * What this conversation is about, in the user's own words. Empty means nobody wrote one.
   *
   * Display-only, like the workspace's, and deliberately unrelated to `titleSource`: a
   * description is not a name, so writing one neither offers nor costs the auto-titler its turn.
   */
  description: string;
  /**
   * Pinned to the top of the sidebar's list.
   *
   * A boolean rather than a pin *timestamp*, and the difference is a decision rather than an
   * economy: the ordering inside the pinned group is the ordinary most-recently-updated one, so
   * pinning decides which group a conversation is in and nothing about where it sits in it.
   * A timestamp would be a second ordering rule to keep in step with `updatedAt` for no reader
   * who asked for one.
   */
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

/*
 * Session write locks.
 *
 * A lease over one conversation: whoever holds it may write, and every other client of the same
 * account reads it read-only until it is released or expires. See `docs/session-locks.md` for
 * the design and, more importantly, for what it deliberately does not guarantee.
 */

/** The header a client identifies itself with. */
export const CLIENT_ID_HEADER = "x-client-id";

/**
 * How long a lease stays valid without a heartbeat.
 *
 * Shared rather than server-only, because the *client* has to beat faster than this or its own
 * lease expires underneath it — the two numbers are one fact, and a heartbeat derived from this
 * (`SESSION_LOCK_HEARTBEAT_MS`) is what keeps them from drifting apart. One missed heartbeat is
 * survivable on purpose: 60 against 120, so an unlucky request is not a lost conversation.
 */
export const SESSION_LOCK_TTL_SECONDS = 120;

/** Live leases in a workspace, keyed by conversation. */
export interface SessionLockView {
  sessionId: string;
  /**
   * The client holding it. Opaque, generated per browser tab, and **not a secret** — the lock
   * is advisory, so this is here to make state legible (a test, a log, a future "which of my
   * devices is this"), not to authenticate anybody. The account check is what protects the row.
   */
  clientId: string;
  /** Whether the *asking* client is the holder, which is the only part the UI acts on. */
  mine: boolean;
  acquiredAt: string;
  expiresAt: string;
}

/** What the acquire route answers with. */
export interface SessionLockResult {
  lock: SessionLockView;
}

/** What the release route answers with. */
export interface SessionLockRelease {
  /**
   * Whether a lease this client held was actually released.
   *
   * False is not an error — releasing something you do not hold, or one that already expired,
   * is what a stale tab does, and it is the honest answer rather than a refusal. The route
   * always answers 200 for the same reason `/leave` does: the caller is leaving either way.
   */
  released: boolean;
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
  /**
   * The largest file an account may upload, in bytes.
   *
   * On the wire because the *client* refuses past it before a request is made — which is the whole
   * point of raising the limit from a constant to a setting: a 60 MB file must be refused without
   * being sent. `MAX_ATTACHMENT_BYTES` is the value behind it when nothing has been set.
   */
  maxUploadBytes: number;
}

/* ----------------------------------- API payloads ----------------------------------- */

export interface CreateWorkspaceInput {
  name: string;
  /**
   * Which widgets to install, at workspace scope.
   *
   * A workspace does not exist when the boxes are ticked, so the whole selection arrives here
   * and is written in one go — which is what makes `installed` a moment rather than a sequence
   * of flips. **Absent** means `DEFAULT_WIDGET_IDS`; an explicit empty list means none.
   */
  widgets?: WidgetId[];
}

export interface UpdateWorkspaceInput {
  name?: string;
  /**
   * The workspace's own note about itself.
   *
   * Optional *and* independent of `name`, like everything else here. An **omitted** field
   * leaves the stored one alone; an empty string clears it. That is the same absent/empty
   * distinction `all_tools` and `widgets` carry, and here it is what makes "delete my
   * description" expressible without a sentinel.
   */
  description?: string;
  /**
   * The workspace's own defaults, replaced wholesale when present.
   *
   * One object rather than a field per setting, because a settings control draws every field
   * it knows about and a partial write would make "clear this back to the built-in default"
   * inexpressible without a sentinel value. Omitted means "leave them alone", which is what a
   * rename sends.
   */
  settings?: WorkspaceSettings;
}

export interface CreateCopilotInput {
  name: string;
  description?: string;
  systemPrompt: string;
  /** Defaults to `true`: an untouched Copilot gets every tool, as it always has. */
  allTools?: boolean;
  /** Ignored when `allTools` is true. Empty with `allTools: false` means no tools. */
  tools?: string[];
  settings?: CopilotDefaults;
  /**
   * Widgets conversations started from this Copilot install.
   *
   * Validated at **session** scope, because that is the level a Copilot installs at. On
   * `PUT` an absent field leaves the stored selection alone — the same contract `apiKey` and
   * the tool pair carry, so a form that does not mention widgets cannot clear them.
   */
  widgets?: WidgetId[];
  /** Defaults to `private` — publishing is something the owner opts into. */
  visibility?: CopilotVisibility;
}

export interface UpdateCopilotInput extends CreateCopilotInput {}

export interface CreateSessionInput {
  title?: string;
  /** The Copilot to copy from. Must be the caller's own, or public. */
  copilotId?: string | null;
  /**
   * Widgets to install, at session scope. Seeded by the client from the chosen Copilot.
   *
   * **Absent** falls through to the Copilot's selection, and then to `DEFAULT_WIDGET_IDS`; an
   * explicit empty list is "none" and stops the fall-through — the absent/empty distinction
   * `allTools` documents, for the same reason.
   */
  widgets?: WidgetId[];
  /**
   * Generation parameters chosen before the conversation existed.
   *
   * **Merged over** the Copilot's copied settings, with the Copilot's own values as the base,
   * so this is one write rather than the create-then-edit the client used to do.
   */
  settings?: SessionSettings;
}

export interface UpdateSessionInput {
  title?: string;
  /**
   * The conversation's own note about itself. Omitted leaves it alone; `""` clears it — the
   * `UpdateWorkspaceInput.description` rule, spelled the same way on both objects.
   */
  description?: string;
  settings?: SessionSettings;
  /** The conversation's own persona. Independent of the Copilot it came from. */
  systemPrompt?: string;
  /** Whether every tool is available. Authoritative over `tools`. */
  allTools?: boolean;
  /** Ignored when `allTools` is true. Empty with `allTools: false` means no tools. */
  tools?: string[];
}

/**
 * Payload for `PATCH /api/sessions/:id/pin`.
 *
 * Required, and required to be a real boolean on the server, because the two states are not a
 * default and a value: `false` is how a conversation is unpinned, so an absent field and a
 * `"false"` are both a request that does not say what it wants. A route that guessed would turn
 * `{"pinned": "false"}` — truthy in JavaScript — into a pin, which is the mistake
 * `PATCH /api/admin/users/:id` refuses to make with `disabled`.
 *
 * Its own route rather than a field on `UpdateSessionInput` for two reasons: pinning must not
 * touch `updatedAt` (see the statement in `db.ts`), and the update route returns through the
 * whole settings/persona path for a change that only moves a row in a list.
 */
export interface SetSessionPinnedInput {
  pinned: boolean;
}

/**
 * Payload for `POST /api/sessions/:id/notes`.
 *
 * `quote` and `occurrence` travel together or not at all: a quote with no occurrence has no
 * position to highlight, and an occurrence with no quote has nothing to search for. Sending
 * neither is the ordinary case for a note added from the list.
 */
export interface CreateNoteInput {
  /** The annotated message. Absent (or null) is a note with no annotation. */
  messageId?: string | null;
  /** Defaults to `annotation` — the quick action sends nothing but the selection. */
  type?: NoteType;
  quote?: string;
  occurrence?: number;
  content?: string;
  /**
   * What the note is about, when it is a figure rather than a passage.
   *
   * The pair travels together, the rule `quote`/`occurrence` already follows, and they are
   * mutually exclusive with the message anchor: a note about a 图 has no passage in it. Omitting
   * both halves is a `text` note, which is why `text` is not among the values here — it is what
   * saying nothing means, not a thing to send.
   */
  targetKind?: NoteFigureKind;
  /** The figure's name. Normalised server-side, so any spelling of it resolves. */
  targetRef?: string;
}

/**
 * Payload for `PATCH /api/sessions/:id/notes/:noteId`.
 *
 * Only these two, and deliberately: the anchor and the message are what a note *was*, and an
 * edit that could re-point one at different text would be a different note wearing the same
 * id. An absent field is left alone, the contract `apiKey` and the tool pair already carry.
 */
export interface UpdateNoteInput {
  type?: NoteType;
  content?: string;
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

/**
 * Payload for `PUT /api/upload-settings`.
 *
 * `maxUploadBytes` is required rather than optional, and required to be an integer within
 * `MIN_UPLOAD_LIMIT_BYTES`–`MAX_UPLOAD_CEILING_BYTES`. There is one field here, so an absent one
 * is a request that does not say what it wants rather than a partial update — and a limit is a
 * number a typo can make absurd in either direction.
 */
export interface UpdateUploadSettingsInput {
  maxUploadBytes: number;
}

/**
 * One turn's request. `provider`/`model` are one-turn overrides; anything absent comes from
 * the session's own settings.
 *
 * There is deliberately no `copilotId`. It used to switch the Copilot mid-conversation, which
 * the snapshot model makes meaningless — re-pointing the link would move the label and leave
 * the persona behind. A conversation's behaviour is changed through its own `systemPrompt`.
 */
/**
 * A source the user referenced, named by them, rather than one sent with the turn.
 *
 * The `@` in the composer, and the difference from `attachments` is *where it came from*: an
 * attachment is an upload made for this turn, and this is something already in the library — a
 * file in this workspace, in another one, in a past conversation. Both reach the model as
 * material to read; only the chip's provenance differs, which is why the two travel separately
 * rather than being merged into one array.
 *
 * `id` plus the name the composer showed: the same split `attachments` makes, and for the same
 * reason — the name is the client's, everything else about the source is re-read server-side.
 */
export interface SourceReference {
  id: string;
  name: string;
}

/**
 * What a reference points at.
 *
 * Five, and each is addressed the way *that* thing can be addressed rather than by a uniform id:
 * a message and a note and a quiz question by their ids, a figure by its canonical name (which is
 * what `ila_query` takes and what the panel labels the row with). The asymmetry is the honest
 * shape — a diagram has no id the model can use, and a note's name is not unique.
 *
 * `quiz` is the one that arrived last, migrating an older gesture onto this mechanism: the quiz
 * widget used to compose a sentence naming the question and send that as the user's own message,
 * which worked and was the only 追问 there was. It is a kind here for the same reason the other
 * four are — so the chip, the block and the bubble are one implementation rather than five, and so
 * the question reaches the agent as a question id rather than as prose it has to parse.
 */
export const TURN_REFERENCE_KINDS = ["message", "diagram", "table", "note", "quiz"] as const;

export type TurnReferenceKind = (typeof TURN_REFERENCE_KINDS)[number];

/**
 * Something the user pointed at when they asked their question.
 *
 * The 追问 gesture, and what it is *not* matters as much as what it is. It is not an attachment:
 * nothing is copied, nothing is sent twice, and the model is handed a **pointer** for everything
 * that has one. A diagram, a table and a note are read through `ila_query`, which is the same tool
 * the agent already uses to read this conversation's record — so the reference costs a few words
 * on the wire and the agent fetches the current content, not a stale copy of what the user was
 * looking at. A *passage* has no such handle — a text range inside a rendered message is not
 * addressable by id — so its text travels, which is the one case where copying is the only option.
 *
 * `label` is display only, the split `SourceReference.name` makes: the chip shows what the
 * composer showed, and the server re-reads everything it needs from `ref`.
 */
export interface TurnReference {
  kind: TurnReferenceKind;
  /**
   * The handle, in the kind's own terms.
   *
   * `message`/`note`/`quiz` → the row's id. `diagram`/`table` → the figure's canonical name, which
   * the server normalises again on the way in, so a client that opened a dialog with
   * "Auth Flow.mmd" and one that read `auth-flow.mmd` off the panel are asking about one figure.
   */
  ref: string;
  label: string;
  /**
   * The selected text, for `message` refs, and for them alone.
   *
   * It is what the model is shown, because there is nothing else to show it — see the note on
   * `kind` above. The client measured it over the message's *rendered* text, which is not the
   * markdown the server holds, so no side can re-derive it and the server does not try: it is
   * taken as the user's own words about the passage they pointed at.
   */
  quote?: string;
  /**
   * Which occurrence of `quote` in that message — the same number `NoteAnchor.occurrence` carries,
   * and the client's reason for sending it is the same: "ATP" appears many times in a reply about
   * it. Display only, like `label`: it is not part of what the model reads.
   */
  occurrence?: number;
}

/**
 * Cap on how many references one turn may carry.
 *
 * A number rather than no limit because the block below is *text in the prompt*: every reference
 * is a paragraph and a quote, so a message with forty of them would crowd out the conversation it
 * is part of. Eight is past what any real question attaches and well short of that.
 */
export const TURN_REFERENCE_MAX = 8;

/**
 * What every request that starts or resumes a turn carries besides its own payload.
 *
 * One field, and it is here rather than in three places because the *reason* is the same three
 * times: the turn's system prompt states what time it is where the user is, and only the
 * browser knows where that is. The server runs on the user's desk while the user may be holding
 * a phone in another timezone, so "the server's local time" is a proxy for the answer and not
 * the answer itself.
 *
 * Optional on purpose. A script, a test or an older client omits it and the server falls back
 * to its own zone, which is right for the desktop app and is a better guess than refusing the
 * turn.
 */
export interface TurnRequestMeta {
  /**
   * The IANA zone name the browser reports, e.g. `Asia/Shanghai`.
   *
   * A *name* rather than an offset, because the server derives the offset from it at the moment
   * the turn runs: an offset sent by a browser that has been open across a daylight-saving
   * boundary would state the wrong hour for the rest of the session.
   */
  timezone?: string;
}

export interface ChatInput extends TurnRequestMeta {
  message: string;
  provider?: string;
  model?: string;
  /** Attachments previously uploaded for this session (metadata only, no bytes). */
  attachments?: Attachment[];
  /**
   * Sources referenced with `@` in this turn.
   *
   * Distinct from `attachments` on purpose: an attachment is *sent* with the turn, a reference
   * is *pointed at*. The server links each to the conversation, so a later turn can
   * `read_document` it without the user referencing it again.
   */
  sources?: SourceReference[];
  /**
   * Things the user pointed at when they asked — the 追问 gesture, staged as chips in the
   * composer.
   *
   * Distinct from `sources` even though both are "something the user referred to", because the
   * two answer different questions. A source is *material to read*: the server links it to the
   * conversation and the model may `read_document` it on any later turn, so it survives the turn
   * it arrived on. A reference is **the object of this question**: the user is asking about *that
   * diagram*, and the agent is told which one so it can look it up — see `TurnReference`.
   */
  refs?: TurnReference[];
  /**
   * Set only by the quiz widget's make-up flow: the global id of a question whose answer
   * was just posted and that this ordinary chat turn is meant to grade. The server verifies
   * an owned, answered row and, when the question was posed with one, appends the answer
   * key and explanation to THIS turn's system prompt only — the key never travels to the
   * client and is not part of the visible message.
   */
  makeupQuizId?: string;
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
  /**
   * The server's row for the message the **user** just sent — the other half of
   * `message_done`, and the only way the client ever learns that row's id.
   *
   * A turn echoes nothing back for the user's own message: the bubble is drawn optimistically,
   * under a client-made `local-…` id, and the persisted copy has always been fetched rather
   * than announced. That is fine until something has to *address* the row, which is exactly
   * what deleting or regenerating a tail message does — a `local-` id names nothing the server
   * has ever seen. Sent right after `meta`, before the model streams, so the swap lands while
   * the reply is still arriving and never re-renders the list underneath the reader.
   */
  | { type: "message_saved"; message: Message }
  /**
   * A message left the conversation before the tokens that replace it arrive. Sent by the
   * regenerate turn immediately after `meta`, so the client drops the row it is about to see
   * re-answered instead of rendering both at once — the server has already soft-deleted it by
   * then, and a client that waited for `message_done` would show the stale reply throughout the
   * stream. `id` names the row; nothing else about it travels.
   */
  | { type: "message_removed"; id: string }
  /** Sent after the first turn when a model-written title replaced the placeholder. */
  | { type: "title"; sessionId: string; title: string }
  /**
   * The `ila_make_plan` "new session" fork committed a V1 plan into a freshly created
   * conversation; the client switches to it. Emitted on the *old* conversation's stream
   * before the resumed run continues.
   */
  | { type: "plan_session_created"; sessionId: string }
  /**
   * A turn that failed. `message` is the raw text and is what gets persisted into history,
   * so it is never rewritten.
   *
   * `code` is absent for provider text we cannot key on, which is the ordinary case — the
   * client then shows `message` as it stands. It is present only when the failure was
   * recognisably a *setting* rather than a fault, so the UI can say what to change instead of
   * repeating a sentence the user cannot act on.
   */
  | { type: "error"; message: string; code?: ApiErrorCode }
  | { type: "done" };

/* ------------------------------------ constants ------------------------------------ */

/**
 * The upload cap an installation starts with, and the fallback for one that has never been told
 * otherwise: 10 MB per file.
 *
 * It stopped being the whole rule when an administrator gained the ability to set it — see
 * `MAX_UPLOAD_CEILING_BYTES` — but it stays the *default*, and it is still what both sides fall
 * back to, because nothing in `config.yaml` seeds it: the value lives in `app_settings` and an
 * unset install behaves exactly as it always did. `PublicConfig.maxUploadBytes` is the number a
 * client should use; this one is behind it.
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * The most an administrator may raise the upload limit to, and the smallest.
 *
 * The ceiling is not a policy choice so much as a consequence of how a Fastify route is built:
 * `bodyLimit` is a fixed number per route, fixed when the route is registered, so a limit that is
 * editable at runtime cannot be the thing the body limit reads. The route therefore carries this
 * number and the *handler* compares against the configured value — which means an administrator
 * can set anything up to here and the two agree, while a body past this is refused by Fastify
 * before the handler sees it. Stated rather than hidden, because that is the one case where the
 * refusal does not carry `FILE_TOO_LARGE`.
 *
 * 100 MB of upload means roughly 133 MB in the server's memory for one request, since the body
 * arrives base64-encoded inside JSON. That is the real cost of the ceiling, and it is why this is
 * an administrator's setting rather than an unbounded one.
 *
 * Shared because both sides check it: the console refuses to save past it, and the route above
 * derives its body limit from it.
 */
export const MAX_UPLOAD_CEILING_BYTES = 100 * 1024 * 1024;

/** The least an administrator may set, so the limit cannot be made useless. */
export const MIN_UPLOAD_LIMIT_BYTES = 1 * 1024 * 1024;

/**
 * How large a file may be and still be handed to the preview viewer whole.
 *
 * The viewer is given a `File`, so these bytes are resident in the tab — this is a memory
 * bound, not a disk one. Deliberately larger than `MAX_ATTACHMENT_BYTES`: an attachment is
 * inlined into a prompt, and a preview is not.
 *
 * Shared, because both sides check it and they are checking different things. The client
 * checks it *before* the request, which is what keeps a 300 MB video from being requested at
 * all; the server enforces it as its own limit, which is what makes that a rule rather than a
 * screen. It is also why the refusal is `FILE_TOO_LARGE` with its own `limitMb` rather than a
 * sentence about uploads.
 *
 * 32 MB fits a large PDF, a scanned document, a spreadsheet and a short video. A ten-minute
 * 720p recording does not fit, and that is inherent in handing the viewer a whole `File` —
 * stated here rather than discovered.
 */
export const MAX_FILE_PREVIEW_BYTES = 32 * 1024 * 1024;

/**
 * Fallback context window when a model has none configured. Used only for the
 * context-usage indicator, so a rough value is acceptable.
 */
export const DEFAULT_CONTEXT_WINDOW = 128_000;
