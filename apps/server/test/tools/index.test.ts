import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WebFetchConfig, WebSearchConfig } from "../../src/config.js";
import { dataLayout, userLayout } from "../../src/paths.js";
import { DIAGRAM_TOOL_NAME, PLAN_TOOL_NAMES, QUIZ_TOOL_NAMES } from "@ilearnassist/shared";
import { ALL_TOOL_NAMES, buildTools } from "../../src/tools/index.js";
import type { QuizToolContext } from "../../src/tools/quiz.js";
import type { QuizReviewToolContext } from "../../src/tools/quizReview.js";
import type { PlanToolContext } from "../../src/tools/planTools.js";
import type { DiagramToolContext } from "../../src/tools/diagram.js";

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
  // under test. Cases that want them spread `{ quiz, quizReview }`. The diagram context is
  // present because the route always passes one — pass `{ diagram: undefined }` to test the
  // other half. Spread last, so a case can override either.
  return buildTools({
    workspaceDir: workspace,
    webSearch,
    webFetch,
    fileToolsEnabled: true,
    diagram: diagram(),
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
  user,
  sources: [{ id: "att-1", name: "lecture.pdf", mimeType: "application/pdf" }],
};

/**
 * Tools assembled only when their per-turn preconditions hold: `read_document` needs a
 * readable document, the plan tools an installed plan widget. They live in ALL_TOOL_NAMES
 * (what may be allow-listed) but are absent from a turn with neither.
 */
const CONTEXT_ASSEMBLED = [
  "read_document",
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
    expect(names({ documents: { ...documents, sources: [] } })).not.toContain("read_document");
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
    // user. The quiz tools are widget-bound, so they stay absent here.
    expect(names({ fileToolsEnabled: false }).sort()).toEqual([
      "ask_user",
      "web_fetch",
      "web_search",
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
    expect(names({ documents })).toHaveLength(
      ALL_TOOL_NAMES.length - PLAN_TOOL_NAMES.length - QUIZ_TOOL_NAMES.length
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

  /* ------------------------------ plan (widget-bound) ------------------------------ */

  it("assembles no plan tools without a plan context", () => {
    const built = names();
    for (const name of PLAN_TOOL_NAMES) expect(built).not.toContain(name);
  });

  it("assembles all three plan tools with a plan context", () => {
    const built = names({ plan });
    for (const name of PLAN_TOOL_NAMES) expect(built).toContain(name);
  });

  it("lets widget-bound plan tools bypass the allow-list in every state", () => {
    // Named list: not in it, still there.
    expect(names({ plan, allowedNames: ["read_file"] }).sort()).toEqual(
      [...PLAN_TOOL_NAMES, "read_file"].sort()
    );
    // Empty list ("no tools"): the bound tools survive, and nothing else does.
    expect(names({ plan, allowedNames: [] }).sort()).toEqual([...PLAN_TOOL_NAMES].sort());
    // Absent list: the default set plus the plan tools. Said that way rather than as a count,
    // so a new tool has to be added to nothing — and `read_document`'s absence (this fixture
    // has no sources) is not silently part of a number.
    expect(names({ plan })).toHaveLength(names().length + PLAN_TOOL_NAMES.length);
  });

  it("keeps the plan tools when file tools are disabled", () => {
    const built = names({ plan, fileToolsEnabled: false });
    for (const name of PLAN_TOOL_NAMES) expect(built).toContain(name);
  });

  /* ----------------------- diagram (ordinary, allow-listable) ----------------------- */

  it("assembles ila_diagram by default, unlike the widget-bound tools", () => {
    // The route always supplies the directory, so a turn that can run at all can draw.
    expect(names()).toContain(DIAGRAM_TOOL_NAME);
  });

  it("assembles no diagram tool without a directory", () => {
    expect(names({ diagram: undefined })).not.toContain(DIAGRAM_TOOL_NAME);
  });

  it("treats the diagram tool as allow-listable in all three states", () => {
    /*
     * The reason it is not widget-bound. A bound tool is the widget's to switch, and nothing
     * installs a widget by default — so binding this one would leave the model with no way to
     * draw a diagram in the ordinary conversation, which is the complaint the tool answers.
     * Here a Copilot can turn diagrams off without turning the panel off, and vice versa.
     */
    expect(names({ allowedNames: [DIAGRAM_TOOL_NAME] })).toEqual([DIAGRAM_TOOL_NAME]);
    expect(names({ allowedNames: ["read_file"] })).not.toContain(DIAGRAM_TOOL_NAME);
    // "No tools" really does mean no tools, this one included.
    expect(names({ allowedNames: [] })).toEqual([]);
  });

  it("drops the diagram tool when the file tools are disabled", () => {
    /*
     * Deliberate, and the one place this tool behaves like a file tool rather than like the
     * widget-bound ones above. `fileTools.enabled: false` is an operator saying "this
     * installation's agent does not write files" — and a diagram whose file was never
     * written is half the feature, since the file is what the browser half exists to open.
     */
    expect(names({ fileToolsEnabled: false })).not.toContain(DIAGRAM_TOOL_NAME);
  });

  it("binds the file tools to the workspace they were built for", async () => {
    const [writeFile] = buildTools({
      workspaceDir: workspace,
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
