import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WebFetchConfig, WebSearchConfig } from "../../src/config.js";
import { dataLayout, userLayout } from "../../src/paths.js";
import {
  DIAGRAM_TOOL_NAME,
  EXPLORE_TOOL_NAME,
  PLAN_TOOL_NAMES,
  QUIZ_TOOL_NAMES,
  TABLE_TOOL_NAME,
} from "@ilearnassist/shared";
import { ALL_TOOL_NAMES, buildTools } from "../../src/tools/index.js";
import type { QuizToolContext } from "../../src/tools/quiz.js";
import type { QuizReviewToolContext } from "../../src/tools/quizReview.js";
import type { PlanToolContext } from "../../src/tools/planTools.js";
import type { DiagramToolContext } from "../../src/tools/diagram.js";
import type { TableToolContext } from "../../src/tools/table.js";
import type { CollectPageContext } from "../../src/tools/collectPage.js";
import type { QueryToolContext } from "../../src/tools/query.js";
import { fileToolsFor } from "../helpers/fileTools.js";
import { NO_SCOPE } from "../../src/workspaceScope.js";
import type { ExploreToolContext } from "../../src/tools/explore.js";

let workspace: string;

const webSearch: WebSearchConfig = { provider: "bing", maxResults: 5 };
const webFetch: WebFetchConfig = { enabled: true, maxChars: 20_000 };

/**
 * The diagram tool is assembled like a file tool, not like a widget tool: `turnContext`
 * always supplies its directory, so it is present by default here too — a default that
 * omitted it would be testing an installation that does not exist, and every allow-list case
 * below would pass for the wrong reason.
 *
 * A function rather than a const, because the temp workspace it points into is made in
 * `beforeEach` and a module-scope `join(workspace, …)` would run against `undefined`.
 */
function diagram(): DiagramToolContext {
  return { sessionDir: join(workspace, "sessions", "s1"), save: () => undefined };
}

/**
 * The table context, present for the same reason the diagram's is: `turnContext` always supplies
 * one, because a conversation can record a table from the moment it exists.
 *
 * It is *unlike* the diagram context in one respect that has its own case below — the tool it
 * assembles survives `fileToolsEnabled: false`, because it writes no file. See `NON_FILE_TOOLS`.
 */
function table(): TableToolContext {
  return { save: () => undefined };
}

/**
 * Like the diagram context, `ila_query` is not gated on a widget: `turnContext` always supplies
 * one, because a conversation's own record exists from the moment it is created. Present by
 * default for the same reason — an assembly case that started without it would be describing an
 * installation that cannot happen. Nothing is invoked here, so the stubs suffice.
 */
/**
 * The page-capture context, stubbed — nothing here invokes the tool.
 *
 * Present by default like the diagram and query contexts, because `turnContext` always supplies
 * one when fetching is enabled: an assembly case that started without it would describe an
 * installation nobody runs. Pass `{ collectPage: undefined }` to pin the other half.
 */
function collectPage(): CollectPageContext {
  return {
    db: {} as never,
    user: userLayout(dataLayout("/tmp/ila-tools"), "tester"),
    userId: "u1",
    sessionId: "s1",
    workspaceId: "w1",
  };
}

function query(): QueryToolContext {
  return {
    db: {} as never,
    userId: "u1",
    sessionId: "s1",
    workspaceId: "w1",
    scope: NO_SCOPE,
    sessionDirPath: join(workspace, "sessions", "s1"),
  };
}

/**
 * `quiz` numbers and registers its questions through callbacks the route supplies; stubs
 * keep these assembly cases off a database. Nothing here is about the numbering itself.
 */
const quiz: QuizToolContext = {
  reserveQuestionNumbers: (count) => Array.from({ length: count }, (_, i) => i + 1),
  registerQuestions: ({ items }) => items.map((item) => ({ uid: `uid-${item.qid}`, qid: item.qid })),
};
// The db/session are only touched when the grading tool is invoked, so a structural stub
// keeps these assembly tests off a database.
const quizReview = { db: {}, sessionId: "s1" } as unknown as QuizReviewToolContext;

function names(input: Partial<Parameters<typeof buildTools>[0]> = {}): string[] {
  // No quiz context by default: the quiz tools are widget-bound, so the absence itself is
  // under test. Cases that want them spread `{ quiz, quizReview }`. The diagram, query and
  // page-capture contexts are present because the route always passes them (fetching being
  // enabled here) — pass `{ diagram: undefined }` and so on to test the other half. Spread
  // last, so a case can override any of them.
  return buildTools({
    fileTools: fileToolsFor(workspace).ctx,
    webSearch,
    webFetch,
    fileToolsEnabled: true,
    diagram: diagram(),
    table: table(),
    query: query(),
    collectPage: collectPage(),
    ...input,
  }).map((t) => t.name);
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "gl-tools-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

const user = userLayout(dataLayout("/tmp/ila-tools"), "tester");

const documents = {
  db: {} as never,
  userId: "u1",
  user,
  resources: [{ id: "att-1", name: "lecture.pdf", mimeType: "application/pdf" }],
};

/**
 * The `@` grant's context, present only when the conversation holds one — so it is *not* in the
 * defaults below, and every case that wants it names it.
 */
function explore(): ExploreToolContext {
  return {
    db: {} as never,
    userId: "u1",
    scope: { all: false, workspaces: [{ id: "w2", name: "Other", workdirPath: "/tmp/w2" }] },
  };
}

/**
 * Tools assembled only when their per-turn preconditions hold: `read_document` needs a
 * readable document, the plan tools an installed plan widget, `ila_explore` an `@` grant. They
 * live in ALL_TOOL_NAMES (what may be allow-listed) but are absent from a turn with none of
 * those.
 */
const CONTEXT_ASSEMBLED = [
  "read_document",
  EXPLORE_TOOL_NAME,
  ...PLAN_TOOL_NAMES,
  ...QUIZ_TOOL_NAMES,
] as const;

// The db/session are only touched when a plan tool is invoked, so a structural stub keeps
// these assembly tests off a database.
const plan = { db: {}, sessionId: "s1" } as unknown as PlanToolContext;

describe("buildTools", () => {
  it("exposes every tool by default, minus the context-assembled ones", () => {
    // `read_document` is absent because this conversation has nothing to read, and the plan
    // tools because their widget is not installed — each is assembled per turn.
    expect(names().sort()).toEqual(
      [...ALL_TOOL_NAMES].filter((n) => !CONTEXT_ASSEMBLED.includes(n as never)).sort()
    );
  });

  it("adds read_document when the conversation has a readable document", () => {
    expect(names({ documents })).toContain("read_document");
  });

  it("omits read_document when the whitelist is empty", () => {
    expect(names({ documents: { ...documents, resources: [] } })).not.toContain("read_document");
  });

  it("omits ila_query when there is no conversation to query", () => {
    // The context is what carries the session and the owner, so its absence is the only thing
    // that can switch the tool off. In a real turn it is always there — see `query()` above.
    expect(names({ query: undefined })).not.toContain("ila_query");
  });

  it("lets a Copilot allow-list choose ila_query like any other tool", () => {
    // It is ordinary, not widget-bound: a bound tool bypasses the allow-list in all three of
    // its states, and this one must be excluded by a list that does not name it.
    expect(names({ allowedNames: ["read_file", "ila_query"] }).sort()).toEqual([
      "ila_query",
      "read_file",
    ]);
  });

  it("adds read_document even when this turn attached nothing", () => {
    // The gate is the whitelist, not the turn's attachments: a conversation with a PDF from
    // last week can still page through it on a turn that attaches nothing. Getting this
    // wrong is how the tool used to be missing exactly when it was wanted.
    expect(names({ documents })).toContain("read_document");
  });

  it("keeps the non-workspace tools but drops the file tools when fileTools is disabled", () => {
    // `ask_user` is here with the web tools because it reads nothing at all — switching
    // off the workspace sandbox is a statement about file access, not about talking to the
    // user. The quiz tools are widget-bound, so they stay absent here. `ila_query` stays for
    // `ask_user`'s reason and one more: it reads the conversation's own record and writes
    // nothing, so a switch about writing files has no bearing on it — which is exactly where
    // it differs from `ila_diagram`, absent from this list on purpose.
    //
    // `ila_table` is the fifth, and it is `ila_query`'s case rather than the diagram's: the
    // switch means "this agent does not write files", and a table writes a row and no file.
    expect(names({ fileToolsEnabled: false }).sort()).toEqual([
      "ask_user",
      "ila_query",
      "ila_table",
      "web_fetch",
      "web_search",
    ]);
  });

  /* ------------------------------ ila_explore (the `@` grant) ------------------------------ */

  it("assembles no ila_explore without a grant", () => {
    // The gate is the grant, like `read_document`'s gate is the whitelist: an ordinary
    // conversation carries no tool for reading across workspaces, and the model is never
    // offered one that could only refuse.
    expect(names()).not.toContain("ila_explore");
  });

  it("adds ila_explore when the conversation has been opened to another workspace", () => {
    expect(names({ explore: explore() })).toContain("ila_explore");
  });

  it("keeps ila_explore when the file tools are disabled", () => {
    // It writes nothing at all — its module contains no write call — so a switch about writing
    // files has no bearing on it. Switching it off would silently gut a user's explicit
    // `@工作区`, which is the "control that renders but does nothing" failure.
    expect(names({ fileToolsEnabled: false, explore: explore() })).toContain("ila_explore");
  });

  it("lets a Copilot allow-list choose ila_explore like any other tool", () => {
    // Ordinary, not widget-bound: a list that does not name it must exclude it. Asserting
    // `explore: undefined` switches it off is not enough — the allow-list is a second gate.
    expect(names({ explore: explore(), allowedNames: ["read_file", "ila_explore"] }).sort()).toEqual([
      "ila_explore",
      "read_file",
    ]);
  });

  it("keeps read_document when the file tools are disabled", () => {
    // It reads attachments from the uploads tree, not the workspace, so the workspace
    // sandbox switch has no bearing on it.
    expect(names({ fileToolsEnabled: false, documents })).toContain("read_document");
  });

  it("drops web_fetch when it is disabled", () => {
    expect(names({ webFetch: { enabled: false, maxChars: 1000 } })).not.toContain("web_fetch");
  });

  it("restricts to a Copilot's allow-list", () => {
    expect(names({ allowedNames: ["read_file", "web_search"] }).sort()).toEqual(["read_file", "web_search"]);
  });

  it("treats an absent allow-list as 'no restriction'", () => {
    // What a Copilot with `allTools: true` produces — the flag becomes an absent list, not an
    // empty one, precisely so that this case and the next one stay distinguishable.
    //
    // Stated as "the same set as naming every tool" rather than as a count, because a count has
    // to be re-derived every time a context-assembled tool is added, and the two assertions the
    // count was making — nothing is dropped, nothing appears — are what this says directly.
    expect(names({ documents }).sort()).toEqual(
      names({ documents, allowedNames: [...ALL_TOOL_NAMES] }).sort()
    );
  });

  it("treats an empty allow-list as 'no tools', not as everything", () => {
    /*
     * This used to be the other way round, and that was the bug: `length > 0` gated the filter,
     * so an empty list skipped it entirely. A Copilot the user had deliberately locked down to
     * no tools therefore got *every* tool — the widest possible reading of the narrowest
     * possible selection — and "deny everything" could not be expressed at all.
     */
    expect(names({ allowedNames: [], documents })).toEqual([]);
  });

  it("lets a Copilot allow-list exclude read_document", () => {
    expect(names({ allowedNames: ["read_file"], documents })).toEqual(["read_file"]);
  });

  /* ------------------------------ quiz (widget-bound) ------------------------------ */

  it("assembles no quiz tools without a quiz context", () => {
    const built = names();
    for (const name of QUIZ_TOOL_NAMES) expect(built).not.toContain(name);
  });

  it("assembles both quiz tools with a quiz context", () => {
    const built = names({ quiz, quizReview });
    for (const name of QUIZ_TOOL_NAMES) expect(built).toContain(name);
  });

  it("lets widget-bound quiz tools bypass the allow-list in every state", () => {
    // Named list: not in it, still there.
    expect(names({ quiz, quizReview, allowedNames: ["read_file"] }).sort()).toEqual(
      [...QUIZ_TOOL_NAMES, "read_file"].sort()
    );
    // Empty list ("no tools"): the bound tools survive, and nothing else does.
    expect(names({ quiz, quizReview, allowedNames: [] }).sort()).toEqual(
      [...QUIZ_TOOL_NAMES].sort()
    );
    // An allow-list that does not name quiz cannot remove it: the widget is the switch.
    const namedOnly = names({ quiz, quizReview, allowedNames: ["read_file"] });
    expect(namedOnly).not.toContain("ask_user");
    for (const name of QUIZ_TOOL_NAMES) expect(namedOnly).toContain(name);
  });

  it("keeps the quiz tools when file tools are disabled", () => {
    const built = names({ quiz, quizReview, fileToolsEnabled: false });
    for (const name of QUIZ_TOOL_NAMES) expect(built).toContain(name);
  });

  it("assembles ila_quiz without its grading companion when only the quiz context is given", () => {
    // Routes always pass both; this is the defensive half of the optional pair.
    const built = names({ quiz });
    expect(built).toContain("ila_quiz");
    expect(built).not.toContain("ila_review_quiz");
  });

  it("applies the allow-list on top of the config gates", () => {
    expect(names({ allowedNames: ["web_fetch", "write_file"], fileToolsEnabled: false })).toEqual([
      "web_fetch",
    ]);
  });

  /* -------------------- plan (auto-install, allow-listable) -------------------- */

  it("assembles no plan tools without a plan context", () => {
    const built = names();
    for (const name of PLAN_TOOL_NAMES) expect(built).not.toContain(name);
  });

  it("assembles all three plan tools with a plan context", () => {
    const built = names({ plan });
    for (const name of PLAN_TOOL_NAMES) expect(built).toContain(name);
  });

  it("treats the plan tools as allow-listable in all three states", () => {
    /*
     * The `auto-install` half of the mode split, and the mirror of the diagram case below. The
     * plan tools used to bypass the allow-list, because they were assembled solely by the widget
     * install and a ticked box could neither enable nor remove them. They are ordinary now — the
     * allow-list governs them — and what the widget gets in exchange is the install on call.
     */
    expect(names({ plan, allowedNames: ["read_file"] })).toEqual(["read_file"]);
    // "No tools" really does mean no tools, these included.
    expect(names({ plan, allowedNames: [] })).toEqual([]);
    // Absent list: the default set plus the plan tools. Said that way rather than as a count,
    // so a new tool has to be added to nothing — and `read_document`'s absence (this fixture
    // has no sources) is not silently part of a number.
    expect(names({ plan })).toHaveLength(names().length + PLAN_TOOL_NAMES.length);
  });

  it("keeps the plan tools when file tools are disabled", () => {
    const built = names({ plan, fileToolsEnabled: false });
    for (const name of PLAN_TOOL_NAMES) expect(built).toContain(name);
  });

  /* --------------------------- diagram (auto-install) --------------------------- */

  it("assembles ila_diagram by default, like the plan tools", () => {
    // The route always supplies the directory, so a turn that can run at all can draw.
    expect(names()).toContain(DIAGRAM_TOOL_NAME);
  });

  it("assembles no diagram tool without a directory", () => {
    expect(names({ diagram: undefined })).not.toContain(DIAGRAM_TOOL_NAME);
  });

  it("treats the diagram tool as allow-listable in all three states", () => {
    /*
     * The reason it is `auto-install` rather than `required`. A `required` tool is the widget's
     * to switch, so it would not exist in the ordinary conversation — which is the complaint this
     * tool answers. Here a Copilot can turn diagrams off without turning the panel off, and vice
     * versa; what the mode adds is that drawing one installs the panel that lists it.
     */
    expect(names({ allowedNames: [DIAGRAM_TOOL_NAME] })).toEqual([DIAGRAM_TOOL_NAME]);
    expect(names({ allowedNames: ["read_file"] })).not.toContain(DIAGRAM_TOOL_NAME);
    // "No tools" really does mean no tools, this one included.
    expect(names({ allowedNames: [] })).toEqual([]);
  });

  it("drops the diagram tool when the file tools are disabled", () => {
    /*
     * Deliberate, and the one place this tool behaves like a file tool rather than like the
     * `auto-install` plan tools above. `fileTools.enabled: false` is an operator saying "this
     * installation's agent does not write files" — and a diagram whose file was never
     * written is half the feature, since the file is what the browser half exists to open.
     */
    expect(names({ fileToolsEnabled: false })).not.toContain(DIAGRAM_TOOL_NAME);
  });

  /* ---------------------------- table (auto-install) ---------------------------- */

  it("assembles ila_table by default, like the diagram tool", () => {
    expect(names()).toContain(TABLE_TOOL_NAME);
  });

  it("assembles no table tool without a context", () => {
    // Optional so this half is pinnable: the route always passes one, and a test that could not
    // take it away could not tell "assembled" from "assembled by accident".
    expect(names({ table: undefined })).not.toContain(TABLE_TOOL_NAME);
  });

  it("treats the table tool as allow-listable in all three states", () => {
    // `auto-install`, like its sibling: a Copilot can turn tables off without turning the 图表
    // panel off, and recording one installs the panel that lists it.
    expect(names({ allowedNames: [TABLE_TOOL_NAME] })).toEqual([TABLE_TOOL_NAME]);
    expect(names({ allowedNames: ["read_file"] })).not.toContain(TABLE_TOOL_NAME);
    expect(names({ allowedNames: [] })).toEqual([]);
  });

  it("keeps the table tool when the file tools are disabled", () => {
    /*
     * The contrast with `ila_diagram` one case up, and the comparison that decides it is
     * `ila_query`'s rather than the diagram's: the switch means "this agent does not write
     * files", a table writes a database row and nothing else, and dropping it would mean an
     * operator's file-tools switch silently removing a capability that never touched a file.
     */
    expect(names({ fileToolsEnabled: false })).toContain(TABLE_TOOL_NAME);
  });

  it("binds the file tools to the workspace they were built for", async () => {
    const [writeFile] = buildTools({
      fileTools: fileToolsFor(workspace).ctx,
      webSearch,
      webFetch,
      fileToolsEnabled: true,
      allowedNames: ["write_file"],
    });
    await writeFile!.invoke({ path: "a.txt", content: "x" });
    // Written under the given workspace, proving the closure captured it.
    expect(names()).toContain("read_file");
    await expect(writeFile!.invoke({ path: "/tmp/escape.txt", content: "x" })).rejects.toThrow(
      /outside the workspace sandbox/
    );
  });
});
