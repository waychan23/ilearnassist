import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WebFetchConfig, WebSearchConfig } from "../../src/config.js";
import { dataLayout, userLayout } from "../../src/paths.js";
import { PLAN_TOOL_NAMES } from "@ilearnassist/shared";
import { ALL_TOOL_NAMES, buildTools } from "../../src/tools/index.js";
import type { QuizToolContext } from "../../src/tools/quiz.js";
import type { PlanToolContext } from "../../src/tools/planTools.js";

let workspace: string;

const webSearch: WebSearchConfig = { provider: "bing", maxResults: 5 };
const webFetch: WebFetchConfig = { enabled: true, maxChars: 20_000 };

/**
 * `quiz` numbers its questions from a counter the route supplies; a stub keeps these cases
 * off a database. Nothing here is about the numbering itself.
 */
const quiz: QuizToolContext = {
  reserveQuestionNumbers: (count) => Array.from({ length: count }, (_, i) => i + 1),
};

function names(input: Partial<Parameters<typeof buildTools>[0]> = {}): string[] {
  return buildTools({
    workspaceDir: workspace,
    webSearch,
    webFetch,
    fileToolsEnabled: true,
    quiz,
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
const CONTEXT_ASSEMBLED = ["read_document", ...PLAN_TOOL_NAMES] as const;

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
    // The suspending tools are here with the web tools because they read nothing at all —
    // switching off the workspace sandbox is a statement about file access, not about
    // talking to the user.
    expect(names({ fileToolsEnabled: false }).sort()).toEqual([
      "ask_user",
      "ila_quiz",
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
      ALL_TOOL_NAMES.length - PLAN_TOOL_NAMES.length
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

  it("offers quiz by default, and keeps it when the file tools are off", () => {
    // Like `ask_user`, it reads nothing from the workspace, so switching the file tools off
    // must not take a conversation's ability to be quizzed with them.
    expect(names()).toContain("ila_quiz");
    expect(names({ fileToolsEnabled: false })).toContain("ila_quiz");
  });

  it("lets a Copilot allow-list exclude quiz", () => {
    expect(names({ allowedNames: ["ask_user"] })).toEqual(["ask_user"]);
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
    // Absent list: the default nine plus read_document's gate aside, the bound tools add three.
    expect(names({ plan })).toHaveLength(9 + PLAN_TOOL_NAMES.length);
  });

  it("keeps the plan tools when file tools are disabled", () => {
    const built = names({ plan, fileToolsEnabled: false });
    for (const name of PLAN_TOOL_NAMES) expect(built).toContain(name);
  });

  it("binds the file tools to the workspace they were built for", async () => {
    const [writeFile] = buildTools({
      workspaceDir: workspace,
      webSearch,
      webFetch,
      fileToolsEnabled: true,
      allowedNames: ["write_file"],
      quiz,
    });
    await writeFile!.invoke({ path: "a.txt", content: "x" });
    // Written under the given workspace, proving the closure captured it.
    expect(names()).toContain("read_file");
    await expect(writeFile!.invoke({ path: "/tmp/escape.txt", content: "x" })).rejects.toThrow(
      /outside the workspace sandbox/
    );
  });
});
