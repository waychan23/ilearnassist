import { z } from "zod";
import {
  QUIZ_REVIEW_EXPLANATION_MAX,
  QUIZ_REVIEW_MAX_REVIEWS,
  type ApiErrorCode,
  type QuizAnswer,
  type QuizAnswers,
  type QuizQuestion,
  type QuizQuestionStatus,
  type QuizQuestionView,
  type QuizReviewItem,
  type QuizVerdict,
} from "@ilearnassist/shared";
import {
  validateQuizAnswers,
  type QuizAnswerKey,
  type QuizRegisterInput,
  type QuizRegistrationItem,
  type QuizRegisteredQuestion,
} from "./tools/quiz.js";
import { newId, type AppDb, type QuizQuestionInsert, type QuizQuestionRecord } from "./db.js";
import { renderPrompt } from "./prompts.js";

/**
 * The quiz widget's persisted questions.
 *
 * Mirrors `plans.ts`: the SQL lives in `db.ts`, this module owns the decisions — which plan
 * node a question belongs to, when a row is created/retired/re-graded, and the shapes the
 * routes and tools read. A row is created when `ila_quiz` suspends (before the user
 * answers), so even a question the learner walked away from is a thing the panel can list
 * and later make up.
 *
 * Two ids deliberately coexist: the row's global UUID (`QuizQuestionView.id`, what the
 * grading tool and the make-up route name) and the session-scoped `Qn` (`qid`, what the
 * model and the chat card use). Qn is only unique within a conversation; the UUID is the
 * identity.
 */

/* --------------------------------- registration --------------------------------- */
/*
 * The registration input/output types (`QuizRegisterInput`, `QuizRegistrationItem`,
 * `QuizRegisteredQuestion`) live in `tools/quiz.ts`: they are part of the tool's context
 * contract, and the tool must not import this module (it would create an import cycle — the
 * domain layer owns the tool's validator).
 */

/** The live plan node a quiz is about: the model's choice, else the current one. */
function resolveNode(
  db: AppDb,
  sessionId: string,
  modelNodeId: string | undefined
): { id: string; title: string } | null {
  const plan = db.getPlanBySession(sessionId);
  if (modelNodeId !== undefined && !plan) {
    // An explicitly named node with no plan is a hallucinated id, not an omission to fall
    // back from.
    throw new Error(
      `ila_quiz: node ${modelNodeId} is not a live node in this conversation's plan`
    );
  }
  if (!plan) return null;
  const live = db.listPlanNodes(plan.id).filter((n) => n.removedVersion === null);

  if (modelNodeId !== undefined) {
    const named = live.find((n) => n.id === modelNodeId);
    if (!named) {
      // Loud rather than reclassified: the model named an id, so silently attaching the
      // quiz to a different chapter would record a decision it never made.
      throw new Error(
        `ila_quiz: node ${modelNodeId} is not a live node in this conversation's plan`
      );
    }
    return { id: named.id, title: named.title };
  }

  // The current chapter: the earliest-started in-progress node, deterministic on the
  // positions when two were opened together. Chapters not started and completed ones do
  // not claim a quiz.
  const underway = live
    .filter((n) => n.status === "in_progress")
    .sort((a, b) => {
      const at = (a.anchorAt ?? "").localeCompare(b.anchorAt ?? "");
      if (at !== 0) return at;
      return a.position - b.position;
    });
  const current = underway[0];
  return current ? { id: current.id, title: current.title } : null;
}

/**
 * Persist the questions of a suspending `ila_quiz` call, returning each one's new uid in
 * input order. One transaction: a partial registration would be pending rows the card knew
 * nothing about.
 */
export function registerQuizQuestions(
  db: AppDb,
  sessionId: string,
  input: QuizRegisterInput
): QuizRegisteredQuestion[] {
  const node = resolveNode(db, sessionId, input.modelNodeId);
  const ts = new Date().toISOString();

  const inserts: QuizQuestionInsert[] = input.items.map((item) => ({
    id: newId(),
    sessionId,
    nodeId: node?.id ?? null,
    nodeTitle: node?.title ?? null,
    toolCallId: input.toolCallId,
    qid: item.qid,
    position: item.position,
    header: item.header,
    question: item.question,
    multiSelect: item.multiSelect === true,
    options: item.options,
    referenceAnswer: item.referenceAnswer,
    explanation: item.explanation,
    createdAt: ts,
  }));

  db.raw.transaction(() => db.insertQuizQuestions(inserts))();

  return inserts.map((row) => ({ uid: row.id, qid: row.qid }));
}

/* ----------------------------- call-level transitions ----------------------------- */

/**
 * The card was submitted: pending rows of that call become answered with the per-qid
 * answer. A legacy uid-less call has no rows and is a no-op — its card still answers
 * through the generic route.
 */
export function recordQuizAnswers(
  db: AppDb,
  sessionId: string,
  toolCallId: string,
  answers: QuizAnswers
): void {
  const ts = new Date().toISOString();
  const writes = (): void => {
    for (const row of db.listQuizQuestionsBySession(sessionId)) {
      if (row.toolCallId !== toolCallId || row.status !== "pending") continue;
      const answer = answers[row.qid];
      db.transitionQuizQuestion({
        sessionId,
        id: row.id,
        expectedStatus: "pending",
        status: "answered",
        answerJson: answer ? JSON.stringify(answer) : null,
        answeredAt: ts,
      });
    }
  };
  db.raw.transaction(writes)();
}

/** The whole quiz was explicitly dismissed at the card: pending rows follow it. */
export function dismissQuizQuestions(db: AppDb, sessionId: string, toolCallId: string): void {
  const writes = (): void => {
    for (const row of db.listQuizQuestionsBySession(sessionId)) {
      if (row.toolCallId !== toolCallId || row.status !== "pending") continue;
      db.transitionQuizQuestion({
        sessionId,
        id: row.id,
        expectedStatus: "pending",
        status: "dismissed",
      });
    }
  };
  db.raw.transaction(writes)();
}

/** The user sent a new message instead of answering: retire the calls' pending rows. */
export function skipQuizQuestions(db: AppDb, sessionId: string, toolCallIds: string[]): void {
  db.skipQuizQuestions(sessionId, toolCallIds);
}

/**
 * The answer keys registered under one suspending `ila_quiz` call, keyed by Qn. Read at
 * resume time from the rows written at suspension — the persisted tool call carries no
 * key, since its input is sent to and re-rendered by the client. Only questions posed with
 * a key or an explanation appear; the grading turn for a keyless quiz is unchanged.
 */
export function quizAnswerKeysForCall(
  db: AppDb,
  sessionId: string,
  toolCallId: string
): Map<string, QuizAnswerKey> {
  const map = new Map<string, QuizAnswerKey>();
  for (const row of db.listQuizQuestionsBySession(sessionId)) {
    if (row.toolCallId !== toolCallId) continue;
    if ((row.referenceAnswer && row.referenceAnswer.length > 0) || row.explanation) {
      map.set(row.qid, {
        referenceAnswer: row.referenceAnswer,
        explanation: row.explanation,
      });
    }
  }
  return map;
}

/* ------------------------------------ reads ------------------------------------ */

function toView(row: QuizQuestionRecord): QuizQuestionView {
  return {
    id: row.id,
    qid: row.qid,
    position: row.position,
    header: row.header,
    question: row.question,
    multiSelect: row.multiSelect,
    options: row.options,
    status: row.status,
    verdict: row.verdict,
    feedback: row.feedback,
    answer: row.answer,
    nodeId: row.nodeId,
    nodeTitle: row.nodeTitle,
    toolCallId: row.toolCallId,
    createdAt: row.createdAt,
    answeredAt: row.answeredAt,
    gradedAt: row.gradedAt,
  };
}

/**
 * All of one conversation's questions for the panel, owner-scoped.
 *
 * First reconciles crash orphans: a `pending` row whose suspending call is no longer
 * awaiting (registration is committed before the awaiting message is, so a kill between
 * the two leaves one). It becomes `skipped`, which is also what makes it make-up eligible.
 * After that, "pending ⇔ a live answerable card" is an invariant the UI can trust.
 */
export function listQuizQuestionViews(
  db: AppDb,
  userId: string,
  sessionId: string
): QuizQuestionView[] {
  const awaiting = new Set(db.listAwaitingToolCalls(sessionId).map((c) => c.id));
  const writes = (): void => {
    for (const row of db.listQuizQuestionsBySession(sessionId)) {
      if (row.status === "pending" && !awaiting.has(row.toolCallId)) {
        db.transitionQuizQuestion({
          sessionId,
          id: row.id,
          expectedStatus: "pending",
          status: "skipped",
        });
      }
    }
  };
  db.raw.transaction(writes)();

  return db.listQuizQuestionsForUser(userId, sessionId).map(toView);
}

/* --------------------------------- make-up answer --------------------------------- */

export const quizMakeupBodySchema = z.object({
  answer: z.object({
    selected: z.array(z.string()),
    unsure: z.boolean().optional(),
    unsureReason: z.string().optional(),
    notes: z.string().optional(),
  }),
});

export type MakeupOk = { ok: true; view: QuizQuestionView };
export type MakeupRejected = {
  ok: false;
  status: 400 | 404 | 409;
  code: ApiErrorCode | "INVALID_ANSWER";
  reason?: string;
};
export type MakeupResult = MakeupOk | MakeupRejected;

/**
 * Re-answer one question the learner never submitted: walked-away (`skipped`) or
 * explicitly cancelled with the rest of the quiz (`dismissed`) — in the product's
 * wording, a dismissed quiz is one the user skipped too. An answered question's history is
 * settled, and a pending one is still answerable through its live card. The answer is
 * checked against the exact options the row recorded, reusing the same validator the live
 * card has — one trust boundary. The UPDATE is guarded on the old status and clears the
 * grade columns, so a race with another transition changes nothing and the re-grading
 * starts blank. It updates the SAME row by UUID; nothing here ever inserts, so a make-up
 * can never create a duplicate question.
 */
const MAKEUP_ELIGIBLE: ReadonlySet<QuizQuestionStatus> = new Set(["skipped", "dismissed"]);

export function makeupAnswer(
  db: AppDb,
  userId: string,
  sessionId: string,
  quizId: string,
  body: unknown
): MakeupResult {
  const parsed = quizMakeupBodySchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, status: 400, code: "INVALID_ANSWER", reason: "answer has the wrong shape" };
  }

  const row = db.getQuizQuestionForUser(userId, sessionId, quizId);
  if (!row) return { ok: false, status: 404, code: "QUIZ_QUESTION_NOT_FOUND" };
  if (!MAKEUP_ELIGIBLE.has(row.status)) {
    return { ok: false, status: 409, code: "QUIZ_NOT_ANSWERABLE" };
  }
  const expectedStatus = row.status;

  // Rebuild the one-question set this answer is judged against, keyed by its Qn exactly as
  // the live card's validator expects.
  const questions: QuizQuestion[] = [
    {
      id: row.qid,
      header: row.header,
      question: row.question,
      ...(row.multiSelect ? { multiSelect: true } : {}),
      options: row.options,
    },
  ];
  const candidate: Record<string, QuizAnswer> = { [row.qid]: parsed.data.answer };
  const validated = validateQuizAnswers(questions, {
    toolCallId: "",
    action: "submit",
    answers: candidate,
  });
  if (!validated.ok) {
    return { ok: false, status: 400, code: "INVALID_ANSWER", reason: validated.reason };
  }
  const normalized = validated.answers[row.qid]!;

  const changed = db.transitionQuizQuestion({
    sessionId,
    id: row.id,
    expectedStatus,
    status: "answered",
    answerJson: JSON.stringify(normalized),
    answeredAt: new Date().toISOString(),
  });
  if (!changed) return { ok: false, status: 409, code: "QUIZ_NOT_ANSWERABLE" };

  const updated = db.getQuizQuestionForUser(userId, sessionId, quizId);
  // The guarded UPDATE just matched this row, so its read cannot miss.
  if (!updated) return { ok: false, status: 404, code: "QUIZ_QUESTION_NOT_FOUND" };
  return { ok: true, view: toView(updated) };
}

/* ------------------------------- batch make-up (the card) ------------------------------- */

/**
 * One row as a make-up card asks it: the `Qn` it is answered by, and the global id it is
 * written by.
 *
 * Both so that the two vocabularies stay on their own sides of the wire. `id` is the Qn,
 * because that is what `QuizAnswers` is keyed by and what `validateQuizAnswers` validates
 * against — the card, the validator and the live quiz all agree without a second shape.
 * `uid` is the row's UUID, which is what the model names (`ila_query` reports it) and what
 * `ila_review_quiz` grades by. The same split every other quiz surface has.
 */
function toMakeupQuestion(row: QuizQuestionRecord): QuizQuestion {
  return {
    id: row.qid,
    uid: row.id,
    header: row.header,
    question: row.question,
    ...(row.multiSelect ? { multiSelect: true } : {}),
    options: row.options,
  };
}

/**
 * The questions a make-up may bring back: the ones the learner never submitted, which is
 * both "walked away" (`skipped`) and "cancelled with the quiz" (`dismissed`) in the
 * product's wording. Answered is settled history and pending is still answerable through
 * its live card, so neither is here.
 *
 * `ids` narrows to the global ids the model named. A named id that is not one of these
 * **throws** rather than being dropped: the model asked for that question, and silently
 * substituting a different one records a decision it never made — `resolveNode`'s rule for
 * a hallucinated plan node, and the same reason. No cap here; bounding the card is the
 * tool's contract, and it says so out loud.
 *
 * Ordered by position, which is the order the panel lists them in, so a card over "all of
 * them" reads like the quiz it came from rather than like a database.
 */
export function makeupQuestions(
  db: AppDb,
  sessionId: string,
  ids?: string[]
): QuizQuestion[] {
  const rows = db
    .listQuizQuestionsBySession(sessionId)
    .filter((row) => MAKEUP_ELIGIBLE.has(row.status))
    .sort((a, b) => a.position - b.position);

  if (!ids || ids.length === 0) return rows.map(toMakeupQuestion);

  const byId = new Map(rows.map((row) => [row.id, row]));
  return [...new Set(ids)].map((id) => {
    const row = byId.get(id);
    if (!row) {
      throw new Error(
        `ila_makeup_quiz: ${id} is not a question this conversation asked and left unanswered` +
          ` (use ila_query kind "quiz" for the ids)`
      );
    }
    return toMakeupQuestion(row);
  });
}

/**
 * The same selection, addressed by the **`Qn`** the card shows rather than by the global id.
 *
 * That is the difference between the two doors: the model names questions the way `ila_query`
 * reports them (global ids, which it read), while a card that was skipped holds the questions it
 * asked — `Q1`, `Q2` — and the learner answers the one in front of them. Neither id is derived
 * from the other, so each door resolves the one it was given against the same rows.
 *
 * A qid that is not an unanswered question here throws, like its sibling: a stale card is a
 * refusal the reader can be told about, not a silent write of something else.
 */
export function makeupQuestionsByQid(
  db: AppDb,
  sessionId: string,
  qids: string[]
): QuizQuestion[] {
  const rows = db
    .listQuizQuestionsBySession(sessionId)
    .filter((row) => MAKEUP_ELIGIBLE.has(row.status))
    .sort((a, b) => a.position - b.position);

  const byQid = new Map(rows.map((row) => [row.qid, row]));
  return [...new Set(qids)].map((qid) => {
    const row = byQid.get(qid);
    if (!row) {
      throw new Error(
        `the make-up card named ${qid}, which is not a question this conversation left unanswered`
      );
    }
    return toMakeupQuestion(row);
  });
}

/**
 * Write the make-up back onto the **calls that asked the questions**, so the card a reader
 * scrolled past shows what they answered.
 *
 * Without this the conversation keeps saying "skipped" about a question that has an answer: the
 * rows are right, the panel is right, and the card in the reply the learner is looking at offers
 * a 补答 button that the server would refuse. The row's `tool_call_id` names the call, so each
 * written answer is merged into its own call's record — one call per question, because a
 * make-up may span several quizzes — and the call's `answer` becomes the partial map the settled
 * card renders against.
 *
 * **No `output` is written**, deliberately: `buildHistoryMessages` replays a call only when it has
 * one, so the original turn stays exactly as it was for the model, while the row's own answer
 * travels to the grading turn through the new make-up call instead. And the status becomes
 * `answered` rather than staying `skipped`, which is what takes the 补答 control off a card whose
 * questions have been dealt with.
 */
export function markMakeupOnCalls(
  db: AppDb,
  sessionId: string,
  entries: { toolCallId: string; qid: string; answer: QuizAnswer }[]
): void {
  const byCall = new Map<string, QuizAnswers>();
  for (const entry of entries) {
    const merged = byCall.get(entry.toolCallId) ?? {};
    merged[entry.qid] = entry.answer;
    byCall.set(entry.toolCallId, merged);
  }

  for (const [toolCallId, answers] of byCall) {
    const found = db.findMessageWithToolCall(sessionId, toolCallId);
    // A legacy call registered before the widget has no row, so nothing names it and there is
    // nothing to write back.
    if (!found) continue;
    const calls = (found.message.toolCalls ?? []).map((tc) =>
      tc.id === toolCallId
        ? {
            ...tc,
            status: "answered" as const,
            // Merged rather than replaced: a card over five questions that had two made up keeps
            // the three it never asked, which is what its settled view renders as 未回答.
            answer: {
              ...((tc.answer as QuizAnswers | undefined) ?? {}),
              ...answers,
            },
          }
        : tc
    );
    db.updateMessageToolCalls(found.message.id, calls);
  }
}

export type MakeupWrite =
  | {
      ok: true;
      keys: Map<string, QuizAnswerKey>;
      /**
       * What was actually written, one entry per answered question. Carries the call that asked it
       * as well as the Qn, because the caller writes the answer back onto that call's record — the
       * card a reader scrolls past has to stop saying "skipped" about a question that has an answer.
       */
      applied: { qid: string; toolCallId: string; answer: QuizAnswer }[];
    }
  | { ok: false; status: 400 | 404 | 409; code: ApiErrorCode; reason?: string };

/**
 * Write a batch of make-up answers, one row at a time and all of it or none of it.
 *
 * **All or nothing**, which is not the obvious choice and is the one that can be read: a
 * partly-written batch leaves the card's own record of what was answered disagreeing with
 * the rows, and the learner with no way to tell which half landed. A refusal is legible
 * ("that question was answered in another tab") and the submission can be sent again; a
 * partial write is a state nothing on screen can represent.
 *
 * A question the submission left out is **skipped, not refused**: a make-up is allowed to be
 * partial, and the questions that stay behind are still the learner's to answer later. An empty
 * submission is different, and the validator above is what refuses it.
 *
 * The answers are already validated, against the options the cards offered — which is what
 * `makeupQuestions` built them from, so the row and the card cannot disagree. What this
 * adds is the *state* check the validator cannot make and the guard on each UPDATE: the
 * status is re-read here and asserted in the `WHERE`, so a question answered since the card
 * opened is refused rather than overwritten.
 *
 * Update-in-place only, exactly as the single make-up was: nothing here ever inserts, so a
 * make-up can never create a duplicate question.
 */
export function recordMakeupAnswers(
  db: AppDb,
  userId: string,
  sessionId: string,
  questions: QuizQuestion[],
  answers: QuizAnswers
): MakeupWrite {
  const pending: { row: QuizQuestionRecord; answerJson: string }[] = [];
  const answeredAt = new Date().toISOString();

  for (const question of questions) {
    // A legacy call persisted before the quiz widget has no row to write to; grading it
    // fails the same lookup, so refusing here is the consistent answer.
    if (!question.uid) {
      return { ok: false, status: 404, code: "QUIZ_QUESTION_NOT_FOUND" };
    }
    const row = db.getQuizQuestionForUser(userId, sessionId, question.uid);
    if (!row) return { ok: false, status: 404, code: "QUIZ_QUESTION_NOT_FOUND" };
    if (!MAKEUP_ELIGIBLE.has(row.status)) {
      return {
        ok: false,
        status: 409,
        code: "QUIZ_NOT_ANSWERABLE",
        reason: `question ${row.qid} is already answered`,
      };
    }
    /*
     * No answer for this one: the learner passed over it, which a make-up allows and the card
     * reports back as `left_unanswered`. It is *not* written — the row stays `skipped`/`dismissed`
     * and can be brought back later — and it is not an error either: the batch is partial on
     * purpose, and refusing it would make "answer the two you remember" impossible.
     */
    const answer = answers[question.id];
    if (!answer) continue;
    pending.push({ row, answerJson: JSON.stringify(answer) });
  }

  // Nothing to write: a submission that answered none of the questions is not a partial answer,
  // it is an empty one. The validator refuses it too; this is the same rule at the layer that
  // actually writes, so the function is safe on its own.
  if (pending.length === 0) {
    return { ok: false, status: 400, code: "INVALID_ANSWER", reason: "no question was answered" };
  }

  try {
    db.raw.transaction(() => {
      for (const { row, answerJson } of pending) {
        const changed = db.transitionQuizQuestion({
          sessionId,
          id: row.id,
          expectedStatus: row.status,
          status: "answered",
          answerJson,
          answeredAt,
        });
        // Unreachable while this transaction holds the write lock, and a rollback is still the
        // right answer: the alternative is committing the half that got through.
        if (!changed) throw new Error(`question ${row.qid} is no longer open to a make-up answer`);
      }
    })();
  } catch (err) {
    return {
      ok: false,
      status: 409,
      code: "QUIZ_NOT_ANSWERABLE",
      reason: err instanceof Error ? err.message : "the make-up could not be recorded",
    };
  }

  const keys = new Map<string, QuizAnswerKey>();
  const applied: { qid: string; toolCallId: string; answer: QuizAnswer }[] = [];
  for (const { row, answerJson } of pending) {
    applied.push({
      qid: row.qid,
      toolCallId: row.toolCallId,
      answer: JSON.parse(answerJson) as QuizAnswer,
    });
    if ((row.referenceAnswer && row.referenceAnswer.length > 0) || row.explanation) {
      keys.set(row.qid, { referenceAnswer: row.referenceAnswer, explanation: row.explanation });
    }
  }
  return { ok: true, keys, applied };
}

/* ------------------------------------- grading ------------------------------------- */

const reviewSchema = z.object({
  reviews: z
    .array(
      z.object({
        quizId: z.string().min(1).max(100),
        verdict: z.enum(["correct", "incorrect", "unsure"]),
        explanation: z.string().min(1).max(QUIZ_REVIEW_EXPLANATION_MAX),
      })
    )
    .min(1)
    .max(QUIZ_REVIEW_MAX_REVIEWS),
});

/**
 * Apply one `ila_review_quiz` call: write each verdict onto its answered question row.
 *
 * Throws a tool error (not a route error) for an unknown id, a batch that repeats an id, or
 * a question that is not answered — those are the model naming the wrong thing, and the
 * tool result is where it can correct itself. Update-in-place only: regrading never creates
 * a row.
 */
export function gradeQuizAnswers(
  db: AppDb,
  sessionId: string,
  gradeToolCallId: string,
  rawInput: unknown
): { graded: { quiz_id: string; verdict: QuizVerdict }[] } {
  const input = reviewSchema.parse(rawInput) as { reviews: QuizReviewItem[] };
  const ids = new Set<string>();
  for (const item of input.reviews) {
    if (ids.has(item.quizId)) {
      throw new Error(
        `ila_review_quiz: quiz_id ${item.quizId} appears more than once in this call`
      );
    }
    ids.add(item.quizId);
  }

  const byId = new Map(
    db.listQuizQuestionsBySession(sessionId).map((row) => [row.id, row] as const)
  );
  for (const item of input.reviews) {
    const row = byId.get(item.quizId);
    if (!row) {
      throw new Error(
        `ila_review_quiz: quiz_id ${item.quizId} is not a question in this conversation; ` +
          "use the exact quiz_id returned with each question"
      );
    }
    if (row.status !== "answered") {
      throw new Error(
        `ila_review_quiz: quiz_id ${item.quizId} has no answer to grade (status ${row.status})`
      );
    }
  }

  const ts = new Date().toISOString();
  const writes = (): void => {
    for (const item of input.reviews) {
      const landed = db.gradeQuizQuestion({
        sessionId,
        id: item.quizId,
        verdict: item.verdict,
        feedback: item.explanation,
        gradeToolCallId,
        gradedAt: ts,
      });
      if (!landed) {
        // Defensive: every row was answered just above, so losing the guard is a race the
        // transaction should roll back rather than partially grade.
        throw new Error(`ila_review_quiz: quiz_id ${item.quizId} could not be graded`);
      }
    }
  };
  db.raw.transaction(writes)();

  return {
    graded: input.reviews.map((item) => ({ quiz_id: item.quizId, verdict: item.verdict })),
  };
}

/** The tool result the model reads: confirmation plus the panel-update note. */
export function renderReviewResult(result: {
  graded: { quiz_id: string; verdict: QuizVerdict }[];
}): string {
  return JSON.stringify(
    {
      graded: result.graded,
      note: "The quiz panel now shows these verdicts and explanations. If the plan needs moving, call ila_update_plan_progress FIRST, before any prose; your FINAL message (after every tool call of the turn has returned) is where the full rundown goes. Walk through each question by its Qn label with its verdict and a brief why, including every correct one: an all-correct quiz still gets the per-question rundown, not only a congratulations.",
    },
    null,
    2
  );
}
