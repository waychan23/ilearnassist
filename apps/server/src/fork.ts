import { cpSync } from "node:fs";
import {
  PLAN_MAKE_TOOL_NAME,
  PLAN_PROGRESS_TOOL_NAME,
  QUERY_TOOL_NAME,
  QUIZ_MAKEUP_TOOL_NAME,
  QUIZ_REVIEW_TOOL_NAME,
  QUIZ_TOOL_NAME,
  widgetsForScope,
  type Attachment,
  type Message,
  type PlanSnapshotNode,
  type QuizQuestion,
  type Session,
  type ToolCall,
  type TurnReference,
  type Workspace,
} from "@ilearnassist/shared";
import { newId, type AppDb } from "./db.js";
import { QUIZ_QUESTION_COUNTER } from "./tools/quiz.js";
import { sessionFilePath } from "./resources.js";
import { sessionDir } from "./paths.js";

/**
 * Branch a conversation at one message: a copy holding everything up to and including it.
 *
 * The copy is a **snapshot of the record**, not a live link — the source and the branch have
 * nothing to do with each other afterwards, and editing one never moves the other. What travels
 * is the conversation as it stood at the cut: its parameters, its messages, and the derived
 * things a reader of those messages can open — the plan, quizzes, threads, notes, diagrams,
 * tables, insights, held material, `@`-references, widget decisions, the question counter and
 * the conversation's own directory.
 *
 * Three rules govern the body below, and each is load-bearing:
 *
 * - **Tool-call ids are preserved verbatim.** Six relations key on them: plan-node completion
 *   anchors, quiz rows and their grading call, diagram and table anchors, thread classification,
 *   and the make-up write-back. A copied call with a new id would silently orphan all of them,
 *   so the *message* ids are regenerated (they appear in the transcript and nowhere else) while
 *   the call ids ride along unchanged.
 * - **Everything else is regenerated and remapped through one table per collection.** Every
 *   remaining join key — message, note, quiz row, plan node, thread, file, work resource — gets
 *   a new id, and the mapping is what rewrites the JSON columns that name them. A reference
 *   left pointing at a source id is an entry in the branch that opens nothing.
 * - **The source is only read.** A fork writes to one row of its own (the new session) and
 *   nothing of the source's, which is why the route does not take the source's write lock.
 *   The one exception is best-effort and one-directional: the source directory is *read* to
 *   copy it, and a failure there leaves a branch with no files rather than no branch.
 *
 * Deliberately **not** copied: `session_locks` (a lease is about the present, not the record)
 * and `usage_events` (a ledger row describes what a call cost, and a copy of a turn was never
 * paid for). See `docs/architecture.md` → "Fork".
 */

export interface ForkSessionParams {
  userId: string;
  /** The conversation being branched, already resolved as this account's. */
  source: Session;
  /** The source's workspace, which the branch joins. */
  workspace: Workspace;
  /** The message the branch ends on, inclusive. */
  throughMessageId: string;
  /** Already deduplicated against the workspace's other titles by the route. */
  title: string;
}

export type ForkResult =
  | { ok: true; session: Session }
  | { ok: false; code: "MESSAGE_NOT_FOUND" };

export function forkSession(db: AppDb, params: ForkSessionParams): ForkResult {
  const { userId, source, workspace, throughMessageId, title } = params;

  /*
   * The cut point, resolved before the transaction so a missing message is an answer rather
   * than a rollback. `listMessagesForUser` is the live, oldest-first read the conversation
   * itself uses — so "up to and including this message" means the same thing here as it does
   * on screen, and a soft-deleted message is not in the copy because it is not in the source.
   */
  const sourceMessages = db.listMessagesForUser(source.id, userId);
  const cutIndex = sourceMessages.findIndex((m) => m.id === throughMessageId);
  if (cutIndex < 0) return { ok: false, code: "MESSAGE_NOT_FOUND" };
  const copiedMessages = sourceMessages.slice(0, cutIndex + 1);
  // The provider's call ids, which stay as they are and are therefore what every derived row is
  // filtered by: a quiz, diagram or table asked after the cut belongs to no copied message.
  const copiedCallIds = new Set(
    copiedMessages.flatMap((m) => (m.toolCalls ?? []).map((tc) => tc.id))
  );

  const targetId = newId();
  const sourceDir = sessionDir(workspace.dirPath, source.id);
  const targetDir = sessionDir(workspace.dirPath, targetId);

  return db.raw.transaction((): ForkResult => {
    const session = db.createSession({
      id: targetId,
      workspaceId: workspace.id,
      copilotId: source.copilotId,
      copilotName: source.copilotName,
      systemPrompt: source.systemPrompt,
      allTools: source.allTools,
      tools: [...source.tools],
      title,
      // The route's dialog asked for this name, so it is the user's — the auto-titler must not
      // replace it. `pinned` deliberately does not travel: it is a statement about where the
      // source sits in a list, not about the record.
      titleSource: "user",
      settings: source.settings,
      description: source.description,
    });

    /*
     * The conversation's own directory, copied as bytes first so a cloned diagram row has a
     * file to point at. Best-effort in both directions: a source that never wrote one is a
     * directory that is not there, and a volume that refuses the copy costs the branch its
     * files and nothing else.
     */
    try {
      cpSync(sourceDir, targetDir, { recursive: true });
    } catch {
      // Ignored on purpose — see above.
    }

    const msgMap = new Map(
      db
        .cloneSessionMessages(source.id, targetId, copiedMessages.map((m) => m.id))
        .map((p) => [p.oldId, p.newId] as const)
    );

    const { nodeMap } = clonePlan(db, source.id, targetId, copiedCallIds);
    const wrMap = cloneWorkResources(db, userId, source.id, targetId);
    cloneSessionReferences(db, source.id, targetId, wrMap);
    const quizMap = cloneQuizQuestions(db, source.id, targetId, copiedCallIds, nodeMap);
    const sourceDiagrams = db
      .listDiagramsBySession(source.id)
      .filter((d) => d.toolCallId !== null && copiedCallIds.has(d.toolCallId));
    const sourceTables = db
      .listTablesBySession(source.id)
      .filter((t) => t.toolCallId !== null && copiedCallIds.has(t.toolCallId));
    const threadMap = cloneThreads(
      db,
      source.id,
      targetId,
      msgMap,
      nodeMap,
      sourceDiagrams.map((d) => d.threadId),
      sourceTables.map((t) => t.threadId)
    );
    const noteMap = cloneNotes(db, userId, source.id, targetId, msgMap, wrMap);
    // The order matters: the files have to exist as rows before the diagram rows can point at
    // them, and the directory they live in was copied above.
    const fileMap = cloneSessionFiles(db, userId, workspace.slug, source.id, targetId);
    cloneDiagrams(db, targetId, sourceDiagrams, threadMap, fileMap);
    cloneTables(db, targetId, sourceTables, threadMap);
    cloneInsights(db, userId, source.id, targetId);
    cloneWidgets(db, userId, source.id, targetId);
    cloneQuestionCounter(db, source.id, targetId);
    remapMessageJson(db, copiedMessages, msgMap, {
      wrMap,
      noteMap,
      quizMap,
      nodeMap,
    });

    return { ok: true, session };
  })();
}

/* ------------------------------------ plans ------------------------------------ */

/**
 * A plan's three tables, copied whole: the live nodes, every version's structural snapshot,
 * and the plan row itself.
 *
 * The **anchor** on a node is dropped when the call it names was not copied — a node completed
 * after the cut keeps its status and its place but cannot jump to a card that is not in this
 * conversation, and `null` is exactly "no anchor". Versions are structure only, so rewriting
 * their node ids through the same map is what makes history browseable in the branch.
 */
function clonePlan(
  db: AppDb,
  sourceSessionId: string,
  targetSessionId: string,
  copiedCallIds: ReadonlySet<string>
): { planId: string | null; nodeMap: Map<string, string> } {
  const sourcePlan = db.getPlanBySession(sourceSessionId);
  if (!sourcePlan) return { planId: null, nodeMap: new Map() };

  const planId = newId();
  db.insertPlan({
    id: planId,
    sessionId: targetSessionId,
    version: sourcePlan.version,
    status: sourcePlan.status,
    createdAt: sourcePlan.createdAt,
    updatedAt: sourcePlan.updatedAt,
  });

  // Two passes, because a child may be listed before its parent: ids first, then the structure
  // that refers to them.
  const nodes = db.listPlanNodes(sourcePlan.id);
  const nodeMap = new Map(nodes.map((node) => [node.id, newId()] as const));
  for (const node of nodes) {
    const anchorKept =
      node.anchorToolCallId !== null && copiedCallIds.has(node.anchorToolCallId);
    db.insertPlanNode({
      id: nodeMap.get(node.id)!,
      planId,
      parentId: node.parentId ? nodeMap.get(node.parentId) ?? null : null,
      position: node.position,
      title: node.title,
      status: node.status,
      introducedVersion: node.introducedVersion,
      removedVersion: node.removedVersion,
      doneToolCallId: anchorKept ? node.anchorToolCallId : null,
      doneAt: anchorKept ? node.anchorAt : null,
    });
  }

  for (const version of db.listPlanVersionRows(sourcePlan.id)) {
    let tree: PlanSnapshotNode[];
    try {
      tree = JSON.parse(version.treeJson) as PlanSnapshotNode[];
    } catch {
      // A damaged snapshot is copied as empty rather than failing the fork: the live plan above
      // is the part a reader works from, and refusing the whole copy over one version would be
      // a worse answer than a version that reads as it already does on the source.
      tree = [];
    }
    db.insertPlanVersion({
      id: newId(),
      planId,
      version: version.version,
      treeJson: JSON.stringify(remapPlanTree(tree, nodeMap)),
      createdAt: version.createdAt,
    });
  }

  return { planId, nodeMap };
}

function remapPlanTree(
  nodes: PlanSnapshotNode[],
  nodeMap: ReadonlyMap<string, string>
): PlanSnapshotNode[] {
  return nodes.map((node) => ({
    ...node,
    id: nodeMap.get(node.id) ?? node.id,
    ...(node.children ? { children: remapPlanTree(node.children, nodeMap) } : {}),
  }));
}

/* ---------------------------- quizzes and questions ---------------------------- */

/**
 * Quiz rows belonging to a copied call, with their status and grading as the source recorded
 * them. `node_id` is remapped so a question stays under the chapter the copy holds; the Qn and
 * position ride along unchanged, which is what makes the branch's numbering match its cards.
 */
function cloneQuizQuestions(
  db: AppDb,
  sourceSessionId: string,
  targetSessionId: string,
  copiedCallIds: ReadonlySet<string>,
  nodeMap: ReadonlyMap<string, string>
): Map<string, string> {
  const quizMap = new Map<string, string>();
  for (const row of db.listQuizQuestionsBySession(sourceSessionId)) {
    if (!copiedCallIds.has(row.toolCallId)) continue;
    const id = newId();
    quizMap.set(row.id, id);
    db.cloneQuizQuestion({
      id,
      sessionId: targetSessionId,
      nodeId: row.nodeId ? nodeMap.get(row.nodeId) ?? null : null,
      nodeTitle: row.nodeTitle,
      toolCallId: row.toolCallId,
      qid: row.qid,
      position: row.position,
      header: row.header,
      question: row.question,
      multiSelect: row.multiSelect,
      options: row.options,
      referenceAnswer: row.referenceAnswer,
      explanation: row.explanation,
      status: row.status,
      answer: row.answer,
      verdict: row.verdict,
      feedback: row.feedback,
      gradeToolCallId: row.gradeToolCallId,
      createdAt: row.createdAt,
      answeredAt: row.answeredAt,
      gradedAt: row.gradedAt,
    });
  }
  return quizMap;
}

/**
 * The counter that numbers quizzes has to start where the source's stood, or the first question
 * the branch asks would be issued a `Qn` the copied rows already hold.
 */
function cloneQuestionCounter(db: AppDb, sourceSessionId: string, targetSessionId: string): void {
  const value = db.counterValue("session", sourceSessionId, QUIZ_QUESTION_COUNTER);
  db.seedCounter("session", targetSessionId, QUIZ_QUESTION_COUNTER, value);
}

/* ----------------------------------- threads ----------------------------------- */

/**
 * Only the threads the copy actually references: a message assigned to one, or a diagram/table
 * the copy holds. A thread nothing points at would be a topic with no turn behind it.
 *
 * The message backfill runs here rather than in the clone, because the thread ids are only
 * known once the threads exist — the same reason the message rows start unclassified.
 */
function cloneThreads(
  db: AppDb,
  sourceSessionId: string,
  targetSessionId: string,
  msgMap: ReadonlyMap<string, string>,
  nodeMap: ReadonlyMap<string, string>,
  diagramThreadIds: readonly (string | null)[],
  tableThreadIds: readonly (string | null)[]
): Map<string, string> {
  const referenced = new Set<string>();
  const sourceMessageThreads = db.listThreadMessagesBySession(sourceSessionId);
  for (const row of sourceMessageThreads) {
    if (msgMap.has(row.id)) referenced.add(row.threadId);
  }
  for (const id of [...diagramThreadIds, ...tableThreadIds]) {
    if (id) referenced.add(id);
  }

  const threadMap = new Map<string, string>();
  for (const thread of db.listThreadsBySession(sourceSessionId)) {
    if (!referenced.has(thread.id)) continue;
    const id = newId();
    threadMap.set(thread.id, id);
    db.insertThread({
      id,
      sessionId: targetSessionId,
      branch: thread.branch,
      title: thread.title,
      planNodeId: thread.planNodeId ? nodeMap.get(thread.planNodeId) ?? null : null,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    });
  }

  // Grouped per new thread, then one statement each: `assignMessagesToThread` takes a list.
  const byThread = new Map<string, string[]>();
  for (const row of sourceMessageThreads) {
    const newThreadId = threadMap.get(row.threadId);
    const newMessageId = msgMap.get(row.id);
    if (!newThreadId || !newMessageId) continue;
    const list = byThread.get(newThreadId) ?? [];
    list.push(newMessageId);
    byThread.set(newThreadId, list);
  }
  for (const [threadId, messageIds] of byThread) {
    db.assignMessagesToThread(targetSessionId, messageIds, threadId);
  }

  return threadMap;
}

/* -------------------------------- notes and material -------------------------------- */

/**
 * Notes the branch can still anchor: the conversation-wide ones (`message_id` null) and the
 * ones written on a copied message. A note anchored to a later message is about something the
 * branch does not contain, and its quote would point at nothing.
 *
 * `target_ref` is a work-resource id for a `resource` note and a canonical figure name for the
 * other two — the names are stable across the copy, so only the resource arm is remapped.
 */
function cloneNotes(
  db: AppDb,
  userId: string,
  sourceSessionId: string,
  targetSessionId: string,
  msgMap: ReadonlyMap<string, string>,
  wrMap: ReadonlyMap<string, string>
): Map<string, string> {
  const noteMap = new Map<string, string>();
  for (const note of db.listNotesForUser(userId, sourceSessionId)) {
    if (note.messageId !== null && !msgMap.has(note.messageId)) continue;
    const id = newId();
    noteMap.set(note.id, id);
    db.createNote({
      id,
      sessionId: targetSessionId,
      messageId: note.messageId ? msgMap.get(note.messageId) ?? null : null,
      type: note.type,
      quote: note.quote,
      occurrence: note.occurrence,
      content: note.content,
      targetKind: note.targetKind,
      targetRef:
        note.targetKind === "resource" && note.targetRef
          ? wrMap.get(note.targetRef) ?? note.targetRef
          : note.targetRef,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
    });
  }
  return noteMap;
}

/**
 * Every reference the source conversation **holds**, with its parse state.
 *
 * `resource_id` and `parsed_file_id` keep pointing where they did: a file is the account's, not
 * the conversation's, and sharing it is what a reference is for. The parse columns ride along so
 * a cloned conversation reads the extracted text instead of paying for the same parse twice.
 */
function cloneWorkResources(
  db: AppDb,
  userId: string,
  sourceSessionId: string,
  targetSessionId: string
): Map<string, string> {
  const wrMap = new Map<string, string>();
  for (const row of db.listWorkResourcesForClone(userId, sourceSessionId)) {
    const id = newId();
    wrMap.set(row.id, id);
    db.cloneWorkResource({
      ...row,
      id,
      ownerId: targetSessionId,
      ownerType: "session",
    });
  }
  return wrMap;
}

/**
 * The conversation's `@`-links. A link names a **work resource**, and only a held one has a new
 * id — a link to material that belongs elsewhere keeps naming the row the user actually pointed
 * at, which is the same row the source named.
 */
function cloneSessionReferences(
  db: AppDb,
  sourceSessionId: string,
  targetSessionId: string,
  wrMap: ReadonlyMap<string, string>
): void {
  for (const workResourceId of db.listSessionReferences(sourceSessionId)) {
    db.addSessionReference({
      id: newId(),
      sessionId: targetSessionId,
      workResourceId: wrMap.get(workResourceId) ?? workResourceId,
    });
  }
}

/* -------------------------------- figures -------------------------------- */

/**
 * The `.mmd` files in the conversation's own directory, as rows at the copy's paths.
 *
 * The bytes were copied wholesale with the directory; this is the registry catching up, which is
 * what makes a diagram openable in the branch. A file outside the conversation's directory is
 * deliberately not copied: it belongs to the workspace, and both conversations read the same
 * bytes at the same path.
 */
function cloneSessionFiles(
  db: AppDb,
  userId: string,
  workspaceSlug: string,
  sourceSessionId: string,
  targetSessionId: string
): Map<string, string> {
  const fileMap = new Map<string, string>();
  const sourcePrefix = sessionFilePath(workspaceSlug, sourceSessionId, "");
  for (const file of db.listFilesForUser(userId)) {
    if (!file.path.startsWith(sourcePrefix)) continue;
    const rel = file.path.slice(sourcePrefix.length);
    const clone = db.createFile({
      id: newId(),
      userId,
      sourceType: file.sourceType,
      title: file.title,
      path: sessionFilePath(workspaceSlug, targetSessionId, rel),
      mimeType: file.mimeType,
      category: file.category,
      size: file.size,
      summary: file.summary,
      // The content hash is the dedupe key for *user-supplied* bytes (`idx_files_blob`); a
      // copied upload would collide with the row it was copied from. Nothing in a conversation's
      // own directory is an upload today, and this is what keeps that true if one ever is.
      sha256:
        file.sourceType === "upload" || file.sourceType === "attachment"
          ? undefined
          : file.sha256,
      now: file.createdAt,
    });
    fileMap.set(file.id, clone.id);
  }
  return fileMap;
}

function cloneDiagrams(
  db: AppDb,
  targetSessionId: string,
  rows: ReturnType<AppDb["listDiagramsBySession"]>,
  threadMap: ReadonlyMap<string, string>,
  fileMap: ReadonlyMap<string, string>
): void {
  for (const row of rows) {
    const copied = db.upsertDiagram({
      id: newId(),
      sessionId: targetSessionId,
      name: row.name,
      // The file is in the copied directory, so the pointer has to be the copied row. A source
      // row with no file (or one whose file the copy missed) keeps the row and no pointer,
      // which the panel already reports as `fileMissing`.
      fileId: row.fileId ? fileMap.get(row.fileId) ?? null : null,
      summary: row.summary,
      toolCallId: row.toolCallId,
    });
    const threadId = row.threadId ? threadMap.get(row.threadId) : undefined;
    if (threadId) db.assignDiagramToThread(targetSessionId, copied.id, threadId);
  }
}

function cloneTables(
  db: AppDb,
  targetSessionId: string,
  rows: ReturnType<AppDb["listTablesBySession"]>,
  threadMap: ReadonlyMap<string, string>
): void {
  for (const row of rows) {
    const copied = db.upsertSessionTable({
      id: newId(),
      sessionId: targetSessionId,
      name: row.name,
      summary: row.summary,
      content: row.content,
      toolCallId: row.toolCallId,
    });
    const threadId = row.threadId ? threadMap.get(row.threadId) : undefined;
    if (threadId) db.assignTableToThread(targetSessionId, copied.id, threadId);
  }
}

/* ----------------------------------- insights ----------------------------------- */

/**
 * Every observation, `adopted` included — the one part of an insight a rerun keeps — with the
 * source's ordinals and timestamps so the panel's order survives.
 */
function cloneInsights(
  db: AppDb,
  userId: string,
  sourceSessionId: string,
  targetSessionId: string
): void {
  for (const item of db.listInsightsForClone(userId, sourceSessionId)) {
    db.cloneInsight({
      ...item,
      id: newId(),
      sessionId: targetSessionId,
    });
  }
}

/* ----------------------------------- widgets ----------------------------------- */

/**
 * The source's **decisions**, not its resolved list: a widget nobody ever answered for stays
 * unanswered in the branch and keeps inheriting the level's default, exactly as it did.
 */
function cloneWidgets(
  db: AppDb,
  userId: string,
  sourceSessionId: string,
  targetSessionId: string
): void {
  for (const widget of widgetsForScope("session")) {
    const decision = db.getSessionWidgetDecisionForUser(userId, sourceSessionId, widget.id);
    if (decision === undefined) continue;
    db.setSessionWidgetForUser(userId, targetSessionId, widget.id, decision);
  }
}

/* ------------------------------- message remapping ------------------------------- */

interface ReferenceMaps {
  wrMap: ReadonlyMap<string, string>;
  noteMap: ReadonlyMap<string, string>;
  quizMap: ReadonlyMap<string, string>;
  nodeMap: ReadonlyMap<string, string>;
}

/**
 * Rewrite a copied message's JSON columns so every id in them names the copy.
 *
 * Three columns, in one write: `tool_calls` carries the arguments and results the card and the
 * model both read, `attachments` names the reference a document is read through, and `refs` is
 * what the turn pointed at. All three are patched together because a second pass per column is a
 * second chance for one of them to be forgotten.
 */
function remapMessageJson(
  db: AppDb,
  copiedMessages: Message[],
  msgMap: ReadonlyMap<string, string>,
  maps: ReferenceMaps
): void {
  for (const message of copiedMessages) {
    const newId = msgMap.get(message.id);
    if (!newId) continue;
    const toolCalls = message.toolCalls?.map((tc) => remapCall(tc, maps));
    const attachments = message.attachments?.map(
      (a): Attachment => ({
        ...a,
        resourceId: maps.wrMap.get(a.resourceId) ?? a.resourceId,
      })
    );
    const refs = message.refs?.map((ref) => remapReference(ref, msgMap, maps));
    db.updateMessageJson(newId, {
      ...(toolCalls ? { toolCalls } : {}),
      ...(attachments ? { attachments } : {}),
      ...(refs ? { refs } : {}),
    });
  }
}

function remapReference(
  ref: TurnReference,
  msgMap: ReadonlyMap<string, string>,
  maps: ReferenceMaps
): TurnReference {
  switch (ref.kind) {
    // A figure is addressed by its canonical name, which the copy keeps.
    case "diagram":
    case "table":
      return ref;
    case "message":
      return { ...ref, ref: msgMap.get(ref.ref) ?? ref.ref };
    case "note":
      return { ...ref, ref: maps.noteMap.get(ref.ref) ?? ref.ref };
    case "quiz":
      return { ...ref, ref: maps.quizMap.get(ref.ref) ?? ref.ref };
    case "resource":
      return { ...ref, ref: maps.wrMap.get(ref.ref) ?? ref.ref };
  }
}

function remapCall(call: ToolCall, maps: ReferenceMaps): ToolCall {
  const input = remapToolInput(call.name, call.input, maps);
  const output = call.output !== undefined ? remapToolOutput(call.output, maps) : undefined;
  if (input === call.input && output === call.output) return call;
  return {
    ...call,
    input,
    ...(output !== undefined ? { output } : {}),
  };
}

/**
 * The per-tool argument rewrite.
 *
 * Only the tools whose **arguments** name a copied row: a plan tree's node ids, a progress
 * call's nodes, a quiz's node and its questions' uids, a make-up's ids, a review's targets, a
 * query naming one question or note, and a document read by resource id. A tool that takes no
 * such field — and an input that will not parse — is returned untouched, because the alternative
 * is a rewrite that invents structure.
 */
function remapToolInput(name: string, input: string, maps: ReferenceMaps): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(input) as Record<string, unknown>;
  } catch {
    return input;
  }
  if (!parsed || typeof parsed !== "object") return input;

  let changed = false;
  const remapId = (value: unknown, map: ReadonlyMap<string, string>): unknown => {
    if (typeof value !== "string") return value;
    const next = map.get(value);
    if (next === undefined) return value;
    changed = true;
    return next;
  };

  switch (name) {
    case PLAN_MAKE_TOOL_NAME: {
      if (Array.isArray(parsed.tree)) {
        parsed.tree = remapPlanTree(
          parsed.tree as PlanSnapshotNode[],
          maps.nodeMap
        );
        changed = true;
      }
      break;
    }
    case PLAN_PROGRESS_TOOL_NAME: {
      if (Array.isArray(parsed.nodes)) {
        parsed.nodes = parsed.nodes.map((node) => {
          if (!node || typeof node !== "object") return node;
          const record = node as Record<string, unknown>;
          return { ...record, id: remapId(record.id, maps.nodeMap) };
        });
      }
      break;
    }
    case QUIZ_TOOL_NAME: {
      parsed.nodeId = remapId(parsed.nodeId, maps.nodeMap);
      if (Array.isArray(parsed.questions)) {
        parsed.questions = parsed.questions.map((question: unknown) => {
          if (!question || typeof question !== "object") return question;
          const record = question as QuizQuestion & Record<string, unknown>;
          return { ...record, ...(record.uid ? { uid: remapId(record.uid, maps.quizMap) } : {}) };
        });
      }
      break;
    }
    case QUIZ_MAKEUP_TOOL_NAME: {
      if (Array.isArray(parsed.quiz_ids)) {
        parsed.quiz_ids = parsed.quiz_ids.map((id) => remapId(id, maps.quizMap));
      }
      break;
    }
    case QUIZ_REVIEW_TOOL_NAME: {
      if (Array.isArray(parsed.reviews)) {
        parsed.reviews = parsed.reviews.map((review: unknown) => {
          if (!review || typeof review !== "object") return review;
          const record = review as Record<string, unknown>;
          return { ...record, quizId: remapId(record.quizId, maps.quizMap) };
        });
      }
      break;
    }
    case QUERY_TOOL_NAME: {
      if (parsed.kind === "quiz") parsed.id = remapId(parsed.id, maps.quizMap);
      else if (parsed.kind === "note") parsed.id = remapId(parsed.id, maps.noteMap);
      break;
    }
    case "read_document": {
      parsed.resourceId = remapId(parsed.resourceId, maps.wrMap);
      break;
    }
    default:
      return input;
  }

  return changed ? JSON.stringify(parsed) : input;
}

/**
 * The structured half of a tool result, walked for the same keys the arguments use.
 *
 * **Free-text prose in an output is deliberately not rewritten** — the model may go on naming an
 * id that no longer resolves, and it recovers by asking again. Structured JSON is different: it
 * is replayed into the model's context and is meant to be acted on, so a `quiz_id` that names
 * the source would send the next `ila_review_quiz` at a conversation the branch cannot see.
 *
 * A **plan tree** is handled by shape (`tree`/`children`/`id`) rather than by key, because that
 * is the one nested structure whose ids are positional. The query tool's answer is handled by
 * its own `kind`, which is the discriminant the tool itself uses.
 */
function remapToolOutput(output: string, maps: ReferenceMaps): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return output;
  }
  let changed = false;
  const rewrite = (value: unknown, key: string | null, inTree: boolean): unknown => {
    if (Array.isArray(value)) return value.map((item) => rewrite(item, null, inTree));
    if (!value || typeof value !== "object") {
      if (typeof value !== "string" || !key) return value;
      const map =
        key === "quiz_id" || key === "quizId"
          ? maps.quizMap
          : key === "node_id" || key === "nodeId"
            ? maps.nodeMap
            : key === "resourceId" || key === "resource_id"
              ? maps.wrMap
              : key === "note_id"
                ? maps.noteMap
                : inTree && key === "id"
                  ? maps.nodeMap
                  : null;
      if (!map) return value;
      const next = map.get(value);
      if (next === undefined) return value;
      changed = true;
      return next;
    }
    const record = value as Record<string, unknown>;
    const kind = typeof record.kind === "string" ? record.kind : null;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
      // The query tool's answer: `{ kind: "quiz"|"note", item | items }`, whose `id` is the row
      // that kind names. Resolved once per object rather than by key alone, because a bare `id`
      // means something different under every kind.
      const kindMap =
        kind === "quiz"
          ? maps.quizMap
          : kind === "note"
            ? maps.noteMap
            : null;
      if (
        kindMap &&
        (key === "item" || key === "items") &&
        typeof item === "object" &&
        item !== null
      ) {
        out[key] = rewriteKindIds(item, kindMap);
        continue;
      }
      out[key] = rewrite(item, key, inTree || key === "tree");
    }
    return out;
  };
  const result = rewrite(parsed, null, false);
  return changed ? JSON.stringify(result) : output;
}

/** Rewrite `id` fields (one item or a list) through one map, without touching anything else. */
function rewriteKindIds(value: unknown, map: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => rewriteKindIds(item, map));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (key === "id" && typeof item === "string" && map.has(item)) out[key] = map.get(item);
    else out[key] = item;
  }
  return out;
}
