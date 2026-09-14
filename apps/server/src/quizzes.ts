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

/**
 * The system-side grading note for a make-up turn: the question's answer key, which the
 * user never saw. Appended to THAT turn's system prompt only and never persisted in a
 * visible message. Null when the question was posed without a key, so a make-up against a
 * keyless quiz behaves exactly as before.
 */
export function renderMakeupKeyNote(row: QuizQuestionRecord): string | null {
  const reference = row.referenceAnswer && row.referenceAnswer.length > 0 ? row.referenceAnswer : null;
  const explanation = row.explanation ?? null;
  if (!reference && !explanation) return null;

  const lines = [
    `The user's just-sent message is a make-up answer (补答) for this conversation's quiz ` +
      `question ${row.qid} (quiz_id: ${row.id}), one they originally left unanswered. Grade that ` +
      "answer now and record it with ONE ila_review_quiz call naming this exact quiz_id — do not " +
      "call ila_quiz again and do not treat it as a new question.",
    "What follows is the question's grading key. It was never shown to the user, so judge against " +
      "it without reproducing it verbatim; give the user your own explanation in their language.",
    "",
    `Question: ${row.question}`,
  ];
  if (reference) lines.push(`Reference answer: ${reference.join("; ")}`);
  if (explanation) lines.push(`Explanation: ${explanation}`);
  return lines.join("\n");
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
      note: "The quiz panel now shows these verdicts and explanations. Give the user the rundown in your reply.",
    },
    null,
    2
  );
}
