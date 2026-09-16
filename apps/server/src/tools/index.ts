import type { StructuredToolInterface } from "@langchain/core/tools";
// The canonical list lives in `shared` rather than here, because the *client* writes the
// allow-list this module filters by: Settings → Copilots checkboxes produce these names. Kept
// here as a re-export so the server's own callers and tests read it as a tool-assembly fact.
export { ALL_TOOL_NAMES, type ToolName } from "@ilearnassist/shared";
import { isWidgetBoundTool } from "@ilearnassist/shared";
import type { WebFetchConfig, WebSearchConfig } from "../config.js";
import { buildAskUserTool } from "./askUser.js";
import { buildDiagramTool, type DiagramToolContext } from "./diagram.js";
import { buildDocumentTool, type DocumentToolContext } from "./documentTools.js";
import { buildExploreTool, type ExploreToolContext } from "./explore.js";
import { buildFileTools, type FileToolContext } from "./fileTools.js";
import { buildPlanTools, type PlanToolContext } from "./planTools.js";
import { buildQueryTool, type QueryToolContext } from "./query.js";
import { buildWebFetchTool } from "./webFetch.js";
import { buildCollectPageTool, type CollectPageContext, type PageCache } from "./collectPage.js";
import { buildWebSearchTool } from "./webSearch.js";
import { buildQuizTool, type QuizToolContext } from "./quiz.js";
import { buildQuizReviewTool, type QuizReviewToolContext } from "./quizReview.js";

/**
 * Tools that do not touch the workspace, and so survive `fileTools.enabled: false`.
 * `read_document` reads attachments from the uploads tree, not the workspace, so it
 * belongs here rather than being switched off with the file tools. `ask_user` and `quiz`
 * read nothing at all.
 *
 * A literal list rather than the client's `INTERACTIVE_TOOL_NAMES`: the two answer
 * different questions (does this tool touch the sandbox? versus which card renders it),
 * and one of them is a client concern.
 *
 * `ila_diagram` is deliberately **not** here, even though it writes outside the workspace
 * too. The question this list answers is read literally ("does this tool touch the
 * workspace?") but it is asked on behalf of a switch that means "this installation's agent
 * does not write files" — and a diagram whose file was never written is not the feature,
 * it is half of it. So `fileTools.enabled: false` means no diagrams, and the test in
 * `test/tools/index.test.ts` pins that rather than leaving it to be discovered.
 *
 * `ila_query` **is** here, and the contrast with the line above is the point: it reads the
 * database and the conversation's own directory and writes nothing at all, so a switch about
 * writing files has no bearing on it. The pair is worth keeping in view — "outside the
 * workspace" is not the test, because one of these reads and one of these writes.
 *
 * `ila_explore` is here on `ila_query`'s argument, and it is the stronger case of the two: it
 * reads granted workspaces' shared folders, and it writes nothing — the module contains no
 * write call at all. Leaving it out would mean a `fileTools.enabled: false` installation
 * silently gutting a user's explicit `@工作区`, which is the "control that renders but does
 * nothing" failure this list's own docblock is written against. The honest counter-argument is
 * that it reads arbitrary workdirs, which is more than `ila_query` reads; gating only its two
 * filesystem kinds at assembly would be worse, since then the tool's *available kinds* would
 * vary between installations and no description could state them.
 */
const NON_FILE_TOOLS = new Set<string>([
  "web_search",
  "web_fetch",
  "read_document",
  "ask_user",
  "ila_quiz",
  "ila_review_quiz",
  "ila_make_plan",
  "ila_read_plan",
  "ila_update_plan_progress",
  "ila_query",
  "ila_explore",
]);

export interface BuildToolsInput {
  /**
   * The two sandboxes a file tool may touch, the default one, and the sink that records a
   * write. Required, not optional — see `FileToolContext`.
   */
  fileTools: FileToolContext;
  webSearch: WebSearchConfig;
  webFetch: WebFetchConfig;
  /**
   * This turn's fetched pages, shared by `web_fetch` and `ila_collect_page`.
   *
   * Created by `buildTools` when absent, so a caller that does not care cannot forget it: an
   * absent cache would make collecting a page fetch it a second time, which is invisible
   * except in the one place it matters — the network.
   */
  pageCache?: PageCache;
  /**
   * Present when a page can be kept at all, which is whenever fetching is enabled. Optional so
   * a test can pin what its absence assembles.
   */
  collectPage?: CollectPageContext;
  fileToolsEnabled: boolean;
  /**
   * The tools to expose. **Absent means every tool; an empty array means none.**
   *
   * The distinction is the whole reason `allTools` exists on a Copilot — see `BuildTools`'s
   * callers — so do not "simplify" this back to a single "empty means unrestricted" case.
   */
  allowedNames?: string[];
  /**
   * Present only when this conversation can read a document at all — that is, when its
   * whitelist is non-empty. The tool is left out entirely otherwise, so the common case
   * carries no tool for a capability it has no use for, and the model cannot call it against
   * a document that does not exist.
   *
   * The gate is "the whitelist is non-empty" rather than "this turn has attachments", which
   * is the same widening the tool itself got: a conversation with a PDF from last week can
   * still page through it on a turn that attaches nothing.
   */
  documents?: DocumentToolContext;
  /**
   * How `ila_quiz` numbers and registers its questions, and the grading tool's context.
   *
   * Present only when the conversation has the quiz widget installed: both quiz tools are
   * widget-bound, so — like `plan` — the absence assembles neither tool (regardless of the
   * allow-list). Both pieces are co-present: the one widget switches both tools.
   */
  quiz?: QuizToolContext;
  quizReview?: QuizReviewToolContext;
  /**
   * Present only when the conversation has the plan widget installed: its bound tools are
   * then assembled regardless of the session's tool allow-list — the widget install is the
   * single switch, in all three of the allow-list's states (every tool / a named list /
   * none). Like `documents`, the absence carries no tool at all.
   */
  plan?: PlanToolContext;
  /**
   * Present when this conversation can draw a diagram, which is whenever its own directory
   * can be resolved — always, in practice; the field is optional so a test can pin what its
   * absence assembles (nothing).
   *
   * **Not widget-bound**, unlike `plan` and `quiz` above. A bound tool is assembled only when
   * its widget is installed, and nothing installs a widget by default, so binding this one
   * would leave the model with no way to draw a diagram in every ordinary conversation —
   * which is the complaint the tool exists to answer. The diagram widget is a viewer with no
   * bound tools of its own.
   */
  diagram?: DiagramToolContext;
  /**
   * Present whenever a session context exists — always, in practice; the field is optional so
   * a test can pin what its absence assembles (nothing).
   *
   * **Ordinary, not widget-bound**, on the `ila_diagram` argument and for a stronger reason: a
   * bound tool is assembled only when its widget is installed, and nothing installs a widget by
   * default, so binding the agent's read of the conversation's own plan, quizzes, threads,
   * notes and diagrams would hide all of it from every ordinary conversation.
   */
  query?: QueryToolContext;
  /**
   * Present only when this conversation holds an `@` grant — the user has opened other
   * workspaces to it. The absent case is the ordinary conversation, which is most of them, and
   * it assembles no tool: `read_document`'s rule, because a tool that could only refuse is a
   * step the model wastes discovering that.
   */
  explore?: ExploreToolContext;
}

/**
 * Assemble the tool set for a single agent run. File tools are always built
 * bound to the provided workspace directory; the web tools use whichever
 * providers are configured. Copilot-level and config-level gating is applied here.
 */
export function buildTools(input: BuildToolsInput): StructuredToolInterface[] {
  const files = buildFileTools(input.fileTools);
  // One cache per assembled set, which is one per turn: the web tools are built together and
  // discarded together, so the lifetime needs no owner.
  const pageCache = input.pageCache ?? new Map();
  const fileTools = [
    files.listFiles,
    files.readFile,
    files.writeFile,
    files.createDirectory,
    files.deleteFile,
  ];

  // `ask_user` depends on no config and reads nothing, so it is assembled like a file tool
  // rather than behind a feature switch. The quiz tools are widget-bound: see `input.quiz`.
  const all: StructuredToolInterface[] = [
    ...fileTools,
    buildWebSearchTool(input.webSearch),
    buildAskUserTool(),
  ];
  if (input.webFetch.enabled) {
    // The two web tools share a **turn-scoped cache**: the fetch a model just made is the one
    // `ila_collect_page` reuses, so keeping a page costs no second request. The cache lives
    // here rather than in either tool because it is the turn's, and `buildTools` is what a turn
    // is assembled by.
    all.push(buildWebFetchTool(input.webFetch, pageCache));
    if (input.collectPage) {
      all.push(buildCollectPageTool({ ...input.collectPage, cache: pageCache }));
    }
  }
  if (input.documents && input.documents.sources.length > 0) {
    all.push(buildDocumentTool(input.documents));
  }
  // Widget-bound tools: assembled only when their widget is installed, which is exactly when
  // this context is present — nothing else gates them.
  if (input.quiz) {
    all.push(buildQuizTool(input.quiz));
    if (input.quizReview) all.push(buildQuizReviewTool(input.quizReview));
  }
  if (input.plan) all.push(...buildPlanTools(input.plan));
  // Ordinary, allow-listable, and gated by `fileToolsEnabled` like the file tools — see
  // `NON_FILE_TOOLS` above for why that is the decision rather than an oversight.
  if (input.diagram) all.push(buildDiagramTool(input.diagram));
  // Ordinary and allow-listable like the diagram tool, but unlike it *kept* when the file
  // tools are switched off — it writes nothing. See `NON_FILE_TOOLS`.
  if (input.query) all.push(buildQueryTool(input.query));
  // Kept when the file tools are switched off, like `ila_query` and for the same reason: it
  // reads and writes nothing at all. See `NON_FILE_TOOLS`.
  if (input.explore) all.push(buildExploreTool(input.explore));

  // Absent means "no restriction"; an empty array means "no tools". The two used to be the same
  // thing — `length > 0` was the test — which made a Copilot with no tools checked silently
  // become a Copilot with every tool, and left "deny everything" unexpressible.
  const allowed = input.allowedNames ? new Set(input.allowedNames) : null;

  return all.filter((t) => {
    if (!input.fileToolsEnabled && !NON_FILE_TOOLS.has(t.name)) return false;
    // A widget-bound tool bypasses the allow-list in all three of its states: it is assembled
    // solely because its widget is installed, and a ticked/unticked box must neither enable nor
    // remove it (it is not shown in the checklist for that reason).
    if (allowed && !allowed.has(t.name) && !isWidgetBoundTool(t.name)) return false;
    return true;
  });
}