import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ChatStreamEvent, Message, Session, Workspace } from "@ilearnassist/shared";
import type { ProviderDef } from "../src/config.js";
import { newId } from "../src/db.js";
import { sessionDir } from "../src/paths.js";
import { applyProgress, forceMakePlan } from "../src/plans.js";
import { gradeQuizAnswers, recordQuizAnswers, registerQuizQuestions } from "../src/quizzes.js";
import { sessionFilePath } from "../src/resources.js";
import { parseSse } from "./helpers/sse.js";
import { startFakeLlm, type FakeLlm } from "./helpers/fakeLlm.js";
import { newSession, newWorkspace, startTestServer, type TestEnv } from "./helpers/tempEnv.js";

/**
 * Branching a conversation, through the route and against the real database.
 *
 * Two halves, and they are the two questions a fork has to answer. **The cut** — every message
 * up to and including the named one travels, nothing after it does, and a message that is not
 * this conversation's is a 404 rather than a hole. **The graph** — plan, quizzes, threads,
 * notes, diagrams, tables, insights, held material, references, widget decisions and the
 * question counter are all copied with *new* ids that refer to each other, while the provider's
 * tool-call ids are preserved verbatim because six relations key on them.
 *
 * The second half seeds its rows straight through the database rather than through turns: what
 * is under test is the copy, and a fake model cannot produce a graded quiz, a classified thread
 * and a parsed reference in a way that reads. The seeding is the fixture, not the subject.
 */

let llm: FakeLlm;
let env: TestEnv;

beforeAll(async () => {
  llm = await startFakeLlm();
  const provider: ProviderDef = {
    id: "fake",
    name: "Fake Provider",
    baseURL: llm.baseURL,
    apiKey: "test-key",
    models: [{ id: "fake-model", name: "fake-model" }],
  };
  env = await startTestServer({ providers: [provider], defaultProvider: "fake", defaultModel: "fake-model" });
});

afterAll(async () => {
  await env.cleanup();
  await llm.close();
});

beforeEach(() => {
  llm.reset();
  llm.setTitle("Untouched");
});

async function messagesOf(sessionId: string): Promise<Message[]> {
  return (await env.inject({ method: "GET", url: `/api/sessions/${sessionId}/messages` })).json<
    Message[]
  >();
}

function fork(sessionId: string, messageId: string, payload: Record<string, unknown> = {}) {
  return env.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/messages/${messageId}/fork`,
    payload,
  });
}

async function chat(sessionId: string, message: string): Promise<void> {
  const res = await env.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/chat`,
    payload: { message },
  });
  // The stream is drained by `inject`; parsing it keeps a failed turn from passing silently.
  const events = parseSse(res.body) as ChatStreamEvent[];
  if (!events.some((e) => e.type === "done")) throw new Error(`chat did not finish: ${res.body}`);
}

/**
 * A source conversation with every kind of record a fork copies, built through the real write
 * paths where one exists and through the database where the row is derived.
 *
 * Returns the ids the assertions need: the conversation, the cut message, the full copy's
 * message, and the source versions of the rows whose copies must be new.
 */
interface Fixture {
  workspace: Workspace;
  session: Session;
  cutMessage: Message;
  tailMessage: Message;
  quizUid: string;
  nodeId: string;
  threadId: string;
  noteId: string;
  workResourceId: string;
  diagramFileId: string;
  diagramPath: string;
  preferenceId: string;
}

async function seedSource(): Promise<Fixture> {
  const db = env.server.db;
  const workspace = await newWorkspace(env, `W-${newId().slice(0, 8)}`);
  const session = await newSession(env, workspace.id, {
    title: "Source",
    settings: { temperature: 0.42, modelId: "fake-model", providerId: "fake" },
  });
  await env.inject({
    method: "PATCH",
    url: `/api/sessions/${session.id}`,
    payload: {
      systemPrompt: "You are terse.",
      description: "about the source",
      allTools: false,
      tools: ["ila_query"],
    },
  });

  llm.setTurns([{ content: "first answer" }, { content: "second answer" }]);
  await chat(session.id, "first question");
  await chat(session.id, "second question");
  const messages = await messagesOf(session.id);
  const cutMessage = messages[1]!;

  // The plan, with a chapter in progress so a quiz binds to it the way the tool's own path
  // would.
  const plan = forceMakePlan(db, session.id, {
    tree: [{ title: "第一章", children: [{ title: "窗口" }] }],
  });
  const nodeId = plan.tree[0]!.children![0]!.id;
  // Anchor to a call the tail message carries (copied in a full fork, absent in a cut one).
  applyProgress(db, session.id, { nodes: [{ id: nodeId, status: "in_progress" }] }, "call-diagram");

  // A registered, answered and graded question, numbered from the session counter as a real
  // registration is.
  const numbers = db.reserveCounter("session", session.id, "quiz_question", 1);
  const [registered] = registerQuizQuestions(db, session.id, {
    toolCallId: "call-quiz",
    items: [
      {
        qid: `Q${numbers[0]}`,
        position: numbers[0]!,
        header: "窗口",
        question: "Flink 有哪几种窗口？",
        options: [{ label: "滚动" }, { label: "滑动" }],
      },
    ],
  });
  const quizUid = registered!.uid;
  recordQuizAnswers(db, session.id, "call-quiz", { [registered!.qid]: { selected: ["滚动"] } });
  gradeQuizAnswers(db, session.id, "grade-1", {
    reviews: [{ quizId: quizUid, verdict: "correct", explanation: "对。" }],
  });

  // The tail message holds the calls the derived rows hang off, so the full-copy fork includes
  // them and the cut fork (at the first answer) does not.
  const tailMessage = db.createMessage({
    id: newId(),
    sessionId: session.id,
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: "call-quiz",
        name: "ila_quiz",
        input: JSON.stringify({
          questions: [
            {
              id: registered!.qid,
              uid: quizUid,
              header: "窗口",
              question: "Flink 有哪几种窗口？",
              options: [{ label: "滚动" }, { label: "滑动" }],
            },
          ],
        }),
        status: "answered",
      },
      { id: "call-diagram", name: "ila_diagram", input: "{}", status: "answered" },
      { id: "call-table", name: "ila_table", input: "{}", status: "answered" },
      { id: "call-plot", name: "ila_plot", input: "{}", status: "answered" },
    ],
    refs: [{ kind: "quiz", ref: quizUid, label: "Q1" }],
  });

  const thread = db.insertThread({
    id: newId(),
    sessionId: session.id,
    branch: "plan",
    title: "窗口",
    planNodeId: nodeId,
  });
  db.assignMessagesToThread(session.id, [tailMessage.id], thread.id);

  const note = db.createNote({
    id: newId(),
    sessionId: session.id,
    messageId: tailMessage.id,
    type: "annotation",
    quote: "滚动",
    occurrence: 0,
    content: "my own note",
    targetKind: "text",
    targetRef: null,
  });

  // Held material: a file row and the reference to it, parse state included. The path is
  // namespaced by a fresh id so two fixtures in one test can each have one.
  const entity = db.createFile({
    id: newId(),
    userId: env.user.id,
    sourceType: "agent_create",
    title: "notes.txt",
    path: `sources/raw/${newId()}.txt`,
    mimeType: "text/plain",
    category: "text",
    size: 5,
  });
  const resource = db.upsertWorkResource({
    id: newId(),
    userId: env.user.id,
    resourceType: "file",
    resourceId: entity.id,
    ownerType: "session",
    ownerId: session.id,
    title: "notes.txt",
  })!;
  db.addSessionReference({
    id: newId(),
    sessionId: session.id,
    workResourceId: resource.id,
  });

  // The conversation's own directory, with the diagram's bytes in it.
  const diagramName = "auth-flow.mmd";
  const sourceDir = sessionDir(workspace.dirPath, session.id);
  mkdirSync(sourceDir, { recursive: true });
  const diagramBytes = "flowchart TD\n  A --> B\n";
  writeFileSync(join(sourceDir, diagramName), diagramBytes);
  const diagramFile = db.createFile({
    id: newId(),
    userId: env.user.id,
    sourceType: "agent_create",
    title: diagramName,
    path: sessionFilePath(workspace.slug, session.id, diagramName),
    mimeType: "text/plain",
    category: "diagram",
    size: diagramBytes.length,
  });
  db.upsertDiagram({
    id: newId(),
    sessionId: session.id,
    name: diagramName,
    fileId: diagramFile.id,
    summary: "the flow",
    toolCallId: "call-diagram",
  });
  db.upsertSessionTable({
    id: newId(),
    sessionId: session.id,
    name: "window-table",
    summary: "windows",
    content: "| a |\n| - |\n| 1 |\n",
    toolCallId: "call-table",
  });
  db.upsertSessionPlot({
    id: newId(),
    sessionId: session.id,
    name: "window-plot",
    summary: "windows over time",
    spec: JSON.stringify({ elements: [{ kind: "function", expr: "x^2" }] }),
    toolCallId: "call-plot",
  });
  db.cloneInsight({
    id: newId(),
    sessionId: session.id,
    type: "strength",
    title: "recurring",
    body: "appears twice",
    adopted: true,
    ordinal: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const preference = db.createPreference({
    id: newId(),
    userId: env.user.id,
    scope: "session",
    scopeId: session.id,
    type: "negative",
    content: "不要使用表格",
    source: "manual",
    sourceMessageId: null,
  });
  db.setSessionWidgetForUser(env.user.id, session.id, "quiz", true);

  // Message columns on the node: start at the cut message, skip position at the tail — to
  // verify a copy maps them to its own messages (and drops what was not copied).
  const planId = db.getPlanBySession(session.id)!.id;
  db.fillPlanNodeMessageIds(planId, nodeId, cutMessage.id, tailMessage.id);

  return {
    workspace,
    session,
    cutMessage,
    tailMessage,
    quizUid,
    nodeId,
    threadId: thread.id,
    noteId: note.id,
    workResourceId: resource.id,
    diagramFileId: diagramFile.id,
    diagramPath: sessionFilePath(workspace.slug, session.id, diagramName),
    preferenceId: preference.id,
  };
}

describe("POST /api/sessions/:id/messages/:messageId/fork", () => {
  it("stops at the named message, keeps call ids, and gives every row a new one", async () => {
    const fix = await seedSource();
    const db = env.server.db;

    const res = await fork(fix.session.id, fix.cutMessage.id, { title: "Branch" });
    expect(res.statusCode).toBe(201);
    const branch = res.json<Session>();
    expect(branch.id).not.toBe(fix.session.id);
    expect(branch.title).toBe("Branch");
    expect(branch.titleSource).toBe("user");

    // The parameters travel: the settings the create carried, the persona and tool allowlist
    // the PATCH wrote, and the description.
    expect(branch.settings).toEqual(fix.session.settings);
    expect(branch.systemPrompt).toBe("You are terse.");
    expect(branch.allTools).toBe(false);
    expect(branch.tools).toEqual(["ila_query"]);
    expect(branch.description).toBe("about the source");
    expect(branch.copilotId).toBe(fix.session.copilotId);

    // The cut: up to and including the named message, and nothing after it.
    const copied = await messagesOf(branch.id);
    const sourceMessages = await messagesOf(fix.session.id);
    expect(copied).toHaveLength(2);
    expect(copied.map((m) => m.content)).toEqual(sourceMessages.slice(0, 2).map((m) => m.content));
    expect(copied.map((m) => m.id)).not.toEqual(sourceMessages.slice(0, 2).map((m) => m.id));
    expect(copied.map((m) => m.id)).not.toContain(fix.tailMessage.id);

    // A full copy carries the graph, all of it new, all of it referring to the copy.
    const full = (await fork(fix.session.id, fix.tailMessage.id, { title: "Full" })).json<Session>();
    const fullMessages = await messagesOf(full.id);
    expect(fullMessages).toHaveLength(5);

    // Tool-call ids are preserved verbatim: the copied tail's input still names them.
    const tailCopy = fullMessages.at(-1)!;
    expect((tailCopy.toolCalls ?? []).map((tc) => tc.id)).toEqual([
      "call-quiz",
      "call-diagram",
      "call-table",
      "call-plot",
    ]);

    const plan = db.getPlanBySession(full.id)!;
    const sourcePlan = db.getPlanBySession(fix.session.id)!;
    expect(plan.id).not.toBe(sourcePlan.id);
    expect(plan.version).toBe(sourcePlan.version);
    const copiedNodes = db.listPlanNodes(plan.id);
    const sourceNodes = db.listPlanNodes(sourcePlan.id);
    expect(copiedNodes.map((n) => n.title)).toEqual(sourceNodes.map((n) => n.title));
    expect(copiedNodes.map((n) => n.id)).not.toEqual(sourceNodes.map((n) => n.id));
    expect(copiedNodes.find((n) => n.id === fix.nodeId)).toBeUndefined();

    // Start/skip message ids map to the copy's own messages (not the source ids).
    const copiedWindow = copiedNodes.find((n) => n.title === "窗口")!;
    expect(copiedWindow.startMessageId).toBe(fullMessages[1]!.id);
    expect(copiedWindow.skippedMessageId).toBe(tailCopy.id);
    expect(copiedWindow.startMessageId).not.toBe(fix.cutMessage.id);
    expect(db.listPlanVersions(plan.id)).toHaveLength(db.listPlanVersions(sourcePlan.id).length);
    // Every version's structural snapshot names the copy's nodes.
    const copiedIds = new Set(copiedNodes.map((n) => n.id));
    for (const version of db.listPlanVersionRows(plan.id)) {
      const tree = JSON.parse(version.treeJson) as { id: string; children?: { id: string }[] }[];
      expect(copiedIds.has(tree[0]!.id)).toBe(true);
      expect(copiedIds.has(tree[0]!.children![0]!.id)).toBe(true);
    }

    const quizzes = db.listQuizQuestionsBySession(full.id);
    expect(quizzes).toHaveLength(1);
    const quizCopy = quizzes[0]!;
    expect(quizCopy.id).not.toBe(fix.quizUid);
    expect(copiedIds.has(quizCopy.nodeId!)).toBe(true);
    expect(quizCopy.answeredAt).not.toBeNull();
    expect(quizCopy).toMatchObject({ status: "answered", verdict: "correct", feedback: "对。" });
    expect(quizCopy.answer).toEqual({ selected: ["滚动"] });

    // The copied call's input and the copied reference both name the new quiz row.
    const copiedQuizCall = (tailCopy.toolCalls ?? []).find((tc) => tc.id === "call-quiz")!;
    const callInput = JSON.parse(copiedQuizCall.input) as { questions: { uid: string }[] };
    expect(callInput.questions[0]!.uid).toBe(quizCopy.id);
    expect(tailCopy.refs?.[0]?.ref).toBe(quizCopy.id);

    const threads = db.listThreadsBySession(full.id);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.id).not.toBe(fix.threadId);
    expect(copiedIds.has(threads[0]!.planNodeId!)).toBe(true);
    // The tail message the thread classified is the copy's own.
    expect(db.listThreadMessagesBySession(full.id).map((r) => r.id)).toEqual([tailCopy.id]);

    const notes = db.listNotesForUser(env.user.id, full.id);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.id).not.toBe(fix.noteId);
    expect(notes[0]!.messageId).toBe(tailCopy.id);
    expect(notes[0]!.content).toBe("my own note");

    const resources = db.listWorkResourcesForClone(env.user.id, full.id);
    expect(resources).toHaveLength(1);
    expect(resources[0]!.id).not.toBe(fix.workResourceId);
    expect(resources[0]!.ownerId).toBe(full.id);
    expect(resources[0]!.parseStatus).toBe("none");
    expect(db.listSessionReferences(full.id)).toEqual([resources[0]!.id]);

    const diagrams = db.listDiagramsBySession(full.id);
    expect(diagrams).toHaveLength(1);
    expect(diagrams[0]!.fileId).not.toBe(fix.diagramFileId);
    const copiedFile = db.getFileForUser(env.user.id, diagrams[0]!.fileId!)!;
    expect(copiedFile.path).not.toBe(fix.diagramPath);
    expect(copiedFile.path).toContain(full.id);
    // The bytes: the directory was copied wholesale, so the new path reads the same source.
    const absolute = join(env.userLayout.userRoot, copiedFile.path);
    expect(existsSync(absolute)).toBe(true);
    expect(readFileSync(absolute, "utf8")).toBe("flowchart TD\n  A --> B\n");

    const tables = db.listTablesBySession(full.id);
    expect(tables).toHaveLength(1);
    expect(tables[0]!.content).toBe("| a |\n| - |\n| 1 |\n");
    expect(copiedIds.has(tables[0]!.threadId ?? "missing")).toBe(false); // remapped, not the source's node

    // The third artifact row, copied whole: the spec *is* the artifact, so the copy has to carry
    // it — a row copied without one would list in the panel and render nothing.
    const plots = db.listPlotsBySession(full.id);
    expect(plots).toHaveLength(1);
    expect(plots[0]!.spec).toBe(
      JSON.stringify({ elements: [{ kind: "function", expr: "x^2" }] })
    );
    expect(plots[0]!.toolCallId).toBe("call-plot");
    expect(copiedIds.has(plots[0]!.threadId ?? "missing")).toBe(false);

    const insights = db.listInsightsForClone(env.user.id, full.id);
    expect(insights).toHaveLength(1);
    expect(insights[0]!.adopted).toBe(true);

    // The conversation's remembered rules travel to the branch — they are session-level
    // memory, and a branch that forgot them would behave differently from its source.
    const preferences = db.listPreferencesForClone(env.user.id, full.id);
    expect(preferences).toHaveLength(1);
    expect(preferences[0]!.content).toBe("不要使用表格");
    expect(preferences[0]!.id).not.toBe(fix.preferenceId);
    expect(preferences[0]!.source).toBe("manual");

    expect(db.getSessionWidgetDecisionForUser(env.user.id, full.id, "quiz")).toBe(true);

    // The counter is seeded from the source's: the next question is Q2, not Q1 again.
    expect(db.counterValue("session", full.id, "quiz_question")).toBe(
      db.counterValue("session", fix.session.id, "quiz_question")
    );
    expect(db.reserveCounter("session", full.id, "quiz_question", 1)).toEqual([2]);
  });

  it("copies the whole plan but only the rows whose call was copied", async () => {
    const fix = await seedSource();

    const res = await fork(fix.session.id, fix.cutMessage.id, { title: "Early" });
    const branch = res.json<Session>();
    const db = env.server.db;

    // The plan is copied whole — it is the conversation's shape, not a per-message artifact.
    expect(db.getPlanBySession(branch.id)).toBeDefined();
    // Everything anchored to a call after the cut is not.
    expect(db.listQuizQuestionsBySession(branch.id)).toEqual([]);
    expect(db.listThreadsBySession(branch.id)).toEqual([]);
    expect(db.listDiagramsBySession(branch.id)).toEqual([]);
    expect(db.listTablesBySession(branch.id)).toEqual([]);
    // Notes with no message anchor travel; this one is anchored after the cut.
    expect(db.listNotesForUser(env.user.id, branch.id)).toEqual([]);

    // The node's anchor sits on a call after the cut, so it drops and with it the message
    // columns; the skip position at the tail is not copied either.
    const earlyWindow = db
      .listPlanNodes(db.getPlanBySession(branch.id)!.id)
      .find((n) => n.title === "窗口")!;
    expect(earlyWindow.anchorToolCallId).toBeNull();
    expect(earlyWindow.startMessageId).toBeNull();
    expect(earlyWindow.skippedMessageId).toBeNull();

    // Held material, references, insights and widgets are conversation-level and travel.
    expect(db.listWorkResourcesForClone(env.user.id, branch.id)).toHaveLength(1);
    expect(db.listSessionReferences(branch.id)).toHaveLength(1);
    expect(db.listInsightsForClone(env.user.id, branch.id)).toHaveLength(1);
  });

  it("numbers a colliding title rather than sharing it", async () => {
    const fix = await seedSource();

    const first = (await fork(fix.session.id, fix.cutMessage.id, { title: "Same name" })).json<Session>();
    const second = (
      await fork(fix.session.id, fix.tailMessage.id, { title: "Same name" })
    ).json<Session>();

    expect(first.title).toBe("Same name");
    expect(second.title).toBe("Same name (2)");
  });

  it("falls back to the source's title when the caller sends none, still numbered", async () => {
    const fix = await seedSource();
    // A rename settles the title the auto-titler would otherwise rewrite, so the assertion is
    // about the fallback rather than about which title the fake model happened to pick.
    await env.inject({
      method: "PATCH",
      url: `/api/sessions/${fix.session.id}`,
      payload: { title: "Named Source" },
    });

    const branch = (await fork(fix.session.id, fix.cutMessage.id)).json<Session>();
    // Taken by the source, so the copy is numbered — the whole point of the fallback running
    // through the same sibling arithmetic every other title write uses.
    expect(branch.title).toBe("Named Source (2)");
    expect(branch.titleSource).toBe("user");
  });

  it("refuses an empty title, an unknown message, a foreign message and a foreign conversation", async () => {
    const fix = await seedSource();
    const other = await seedSource();

    const empty = await fork(fix.session.id, fix.cutMessage.id, { title: "   " });
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toMatchObject({ error: { code: "TITLE_EMPTY" } });

    expect((await fork(fix.session.id, "nope", { title: "x" })).statusCode).toBe(404);
    // A real message of another conversation answers the same way, so an id cannot be probed.
    const crossed = await fork(fix.session.id, other.tailMessage.id, { title: "x" });
    expect(crossed.statusCode).toBe(404);
    expect(crossed.json()).toMatchObject({ error: { code: "MESSAGE_NOT_FOUND" } });

    expect((await fork("not-a-session", fix.cutMessage.id, { title: "x" })).statusCode).toBe(404);
  });

  it("refuses while the source has a turn in flight", async () => {
    const fix = await seedSource();

    llm.setTurns([{ content: "starting", holdMs: 200 }]);
    const pending = env.inject({
      method: "POST",
      url: `/api/sessions/${fix.session.id}/chat`,
      payload: { message: "hold on" },
    });
    // Long enough for the turn to have registered, far shorter than the held turn.
    await new Promise((r) => setTimeout(r, 60));

    const res = await fork(fix.session.id, fix.cutMessage.id, { title: "Too early" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: "TURN_IN_PROGRESS" } });

    await pending;
  });
});
