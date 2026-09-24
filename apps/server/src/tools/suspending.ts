import {
  ASK_USER_TOOL_NAME,
  PLAN_MAKE_TOOL_NAME,
  QUIZ_MAKEUP_TOOL_NAME,
  QUIZ_TOOL_NAME,
  type AnswerToolCallInput,
  type InteractiveAnswer,
  type Session,
  type ToolCall,
  type Workspace,
} from "@ilearnassist/shared";
import { readAskUserQuestions, renderAskUserResult, validateAnswers } from "./askUser.js";
import {
  readQuizQuestions,
  renderQuizResult,
  validateMakeupAnswers,
  validateQuizAnswers,
} from "./quiz.js";
import { newId, type AppDb } from "../db.js";
import {
  forceMakePlan,
  planTreeInputSchema,
  readPlanConflictTree,
  renderMakeResult,
} from "../plans.js";
import { quizAnswerKeysForCall, recordMakeupAnswers } from "../quizzes.js";
import { renderMakeupResult } from "./quizMakeup.js";

/**
 * What the answers route needs from a suspending tool.
 *
 * One method rather than three (read, validate, render), because what has to hold is the
 * *pairing* of a tool's question type with the validator that understands it — split across
 * three maps keyed by the same name, the pairing is a thing to get wrong rather than a thing
 * the types enforce. `resolve` answers all three questions the route has: does this call
 * hold a question set at all, was the submission acceptable, and what are the two copies of
 * the answer that the two readers need.
 *
 * `commit` is the one variant for a tool whose answer has *side effects* — `ila_make_plan`'s
 * create-vs-new-session fork writes a plan, and possibly a whole conversation. Ask/quiz only
 * render an answer, so they define `resolve`; the registry guarantees one of the two.
 */
export interface SuspensionCommitContext {
  db: AppDb;
  userId: string;
  session: Session;
  workspace: Workspace;
}

export interface SuspensionResolved {
  ok: true;
  /** Absent only for a dismissed plan-conflict card; ask/quiz always carry it. */
  answer?: InteractiveAnswer;
  output: string;
  /**
   * When the answer created another conversation, its id. The route streams
   * `plan_session_created` before the resumed run so the client switches to it.
   */
  navigateToSessionId?: string;
}

export interface SuspensionRejected {
  ok: false;
  reason: string;
}

export interface SuspendingTool {
  /**
   * `undefined` — this call holds no question set (the route answers 409).
   * `ok: false` — the submission is not acceptable (the route answers 400).
   *
   * Receives the same context `commit` does: a read-only resolver (the quiz spec) still
   * needs the database to read its questions' answer keys back, which never live on the
   * call the client sees.
   */
  resolve?(
    call: ToolCall,
    submission: AnswerToolCallInput,
    ctx: SuspensionCommitContext
  ): SuspensionResolved | SuspensionRejected | undefined;

  /** Side-effecting variant: the answer commits something before the turn resumes. */
  commit?(
    call: ToolCall,
    submission: AnswerToolCallInput,
    ctx: SuspensionCommitContext
  ): SuspensionResolved | SuspensionRejected | undefined;
}

const askUserSpec: SuspendingTool = {
  resolve(call, submission) {
    const questions = readAskUserQuestions(call);
    if (!questions) return undefined;

    const validated = validateAnswers(questions, submission);
    if (!validated.ok) return { ok: false, reason: validated.reason };

    return {
      ok: true,
      answer: validated.answers,
      output: renderAskUserResult(questions, validated.answers, submission.action),
    };
  },
};

const quizSpec: SuspendingTool = {
  // Takes the commit context even though it writes nothing: the model's answer key was
  // stored on the quiz rows, never on the call the client receives, so the post-answer
  // tool result has to read it back from the database before grading resumes.
  resolve(call, submission, ctx) {
    const questions = readQuizQuestions(call);
    if (!questions) return undefined;

    const validated = validateQuizAnswers(questions, submission);
    if (!validated.ok) return { ok: false, reason: validated.reason };

    const keys = quizAnswerKeysForCall(ctx.db, ctx.session.id, call.id);
    return {
      ok: true,
      answer: validated.answers,
      output: renderQuizResult(questions, validated.answers, submission.action, keys),
    };
  },
};

/** A plan title doubles as the new conversation's title; the first root node, truncated. */
const NEW_SESSION_TITLE_MAX = 80;

function conflictSessionTitle(tree: unknown, fallback: string): string {
  const parsed = planTreeInputSchema.safeParse({ tree });
  if (!parsed.success) return fallback;
  const first = parsed.data.tree[0]?.title.trim();
  if (!first) return fallback;
  return first.length > NEW_SESSION_TITLE_MAX ? first.slice(0, NEW_SESSION_TITLE_MAX) : first;
}

/**
 * The `ila_make_plan` fork. The suspended call carries the whole proposed tree verbatim;
 * the answer says whether it overwrites this plan or lands in a new conversation.
 *
 * Everything writes through the same primitives a normal tool call uses, and every invalid
 * submission returns `ok: false` (the route answers 400) rather than throwing — this is an
 * HTTP handler boundary, not the agent loop's tool-error arm.
 */
const planMakeSpec: SuspendingTool = {
  commit(call, submission, ctx) {
    const tree = readPlanConflictTree(call);
    if (tree === undefined) return undefined;

    if (submission.action === "cancel") {
      return {
        ok: true,
        output: JSON.stringify(
          {
            outcome: "cancelled",
            note:
              "The user dismissed the choice without deciding. Do not create or replace the plan; " +
              "ask in chat how they want to proceed.",
          },
          null,
          2
        ),
      };
    }

    const choice = (submission.answers as { choice?: unknown } | undefined)?.choice;
    if (choice !== "edit" && choice !== "new_session") {
      return { ok: false, reason: "choice must be 'edit' or 'new_session'" };
    }
    // Re-validate the tree stored on the call before committing anything.
    if (!planTreeInputSchema.safeParse({ tree }).success) {
      return { ok: false, reason: "the stored plan tree is not a valid plan" };
    }

    if (choice === "edit") {
      try {
        const view = forceMakePlan(ctx.db, ctx.session.id, { tree });
        return { ok: true, answer: { choice: "edit" }, output: renderMakeResult(view) };
      } catch (err) {
        return {
          ok: false,
          reason: err instanceof Error ? err.message : "could not edit the plan",
        };
      }
    }

    // New conversation: snapshot the current one exactly like session creation from a
    // Copilot, install the plan widget into it, and write the proposal as its V1 plan. One
    // transaction so the three writes are one decision.
    const newSessionId = newId();
    const title = conflictSessionTitle(tree, ctx.session.title);
    try {
      ctx.db.raw.transaction(() => {
        ctx.db.createSession({
          id: newSessionId,
          workspaceId: ctx.workspace.id,
          copilotId: ctx.session.copilotId,
          copilotName: ctx.session.copilotName,
          systemPrompt: ctx.session.systemPrompt,
          allTools: ctx.session.allTools,
          tools: ctx.session.tools,
          title,
          settings: ctx.session.settings,
        });
        ctx.db.setSessionWidgetForUser(ctx.userId, newSessionId, "plan", true);
        forceMakePlan(ctx.db, newSessionId, { tree });
      })();
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : "could not create the new conversation",
      };
    }

    const plan = ctx.db.getPlanBySession(newSessionId)!;
    return {
      ok: true,
      answer: { choice: "new_session", newSessionId },
      navigateToSessionId: newSessionId,
      output: JSON.stringify(
        {
          outcome: "new_session_created",
          sessionId: newSessionId,
          title,
          version: plan.version,
          note:
            "The user chose to put this plan in a NEW conversation, which now exists with the plan " +
            "widget installed and this plan as version 1. Do NOT create, replace or edit any plan " +
            "in this conversation. Briefly tell the user the new conversation is ready and stop.",
        },
        null,
        2
      ),
    };
  },
};

/**
 * The make-up card. A `commit` spec, because answering it writes — and what it writes is the
 * learner's answer, not a plan: N existing rows move from `skipped`/`dismissed` to `answered` in
 * one transaction.
 *
 * It reuses `ila_quiz`'s reader, validator and result renderer wholesale, which is the design
 * rather than a shortcut: the questions were recorded in the quiz shape, so the boundary that
 * judges an answer and the sentence that reports it are the same ones a live quiz goes through,
 * and a make-up cannot come to mean something slightly different from a first answer.
 *
 * A cancel writes nothing at all. The rows stay where they are, so the questions remain
 * make-up-eligible — "not now" is not "never" — and the result tells the model that nothing was
 * recorded, so it does not go looking for answers that are not there.
 */
const makeupQuizSpec: SuspendingTool = {
  commit(call, submission, ctx) {
    const questions = readQuizQuestions(call);
    if (!questions) return undefined;

    if (submission.action === "cancel") {
      return { ok: true, answer: {}, output: renderQuizResult(questions, {}, "cancel") };
    }

    // The subset-aware validator: a make-up may leave questions unanswered, and that is what the
    // learner asked for when they answered two of the five they skipped.
    const validated = validateMakeupAnswers(questions, submission);
    if (!validated.ok) return { ok: false, reason: validated.reason };

    const written = recordMakeupAnswers(
      ctx.db,
      ctx.userId,
      ctx.session.id,
      questions,
      validated.answers
    );
    if (!written.ok) {
      return { ok: false, reason: written.reason ?? "the make-up answer could not be recorded" };
    }

    return {
      ok: true,
      answer: validated.answers,
      // The keys come off the rows just written — the same place `ila_quiz`'s spec reads them
      // from, and the only moment they may be shown: the question now has an answer. The rendered
      // result is `ila_quiz`'s shape over the answered ones, plus the questions this learner
      // passed over: see `renderMakeupResult`.
      output: renderMakeupResult(questions, validated.answers, written.keys),
    };
  },
};

/**
 * Every tool whose calls can be answered, keyed by the name recorded on the call.
 *
 * The lookup is by the *stored call's* name rather than by anything the client sent, so a
 * client cannot choose how its own submission is read. A suspending tool missing from here
 * gets the same 409 as a stale question, which is the safe direction — refusing rather than
 * guessing at a shape.
 */
export const SUSPENDING_TOOLS: Record<string, SuspendingTool> = {
  [ASK_USER_TOOL_NAME]: askUserSpec,
  [QUIZ_TOOL_NAME]: quizSpec,
  [QUIZ_MAKEUP_TOOL_NAME]: makeupQuizSpec,
  [PLAN_MAKE_TOOL_NAME]: planMakeSpec,
};
