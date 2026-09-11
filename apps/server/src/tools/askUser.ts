import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  ASK_USER_HEADER_MAX,
  ASK_USER_MAX_OPTIONS,
  ASK_USER_MAX_QUESTIONS,
  ASK_USER_MIN_OPTIONS,
  ASK_USER_OTHER_MAX,
  ASK_USER_TOOL_NAME,
  type AnswerToolCallInput,
  type AskUserAnswers,
  type AskUserQuestion,
} from "@guided-learning/shared";

export { ASK_USER_TOOL_NAME };

/**
 * Thrown by `ask_user` to suspend the turn until the user answers.
 *
 * **This is control flow, not failure.** It is the same trick LangGraph's `interrupt()`
 * uses, and for the same reason: a tool cannot return "please pause the loop now" through
 * its normal return value without inventing a sentinel string that every other reader of
 * a tool result would then have to know about. `runAgentStream` catches this class
 * *before* its generic tool-error catch, so it never becomes a `Tool error:` string —
 * and it must stay that way, or the model would be told its own question failed.
 *
 * Do not wrap `interrupt`-style code in a bare `try/catch` on the way out: a catch that
 * swallows this would turn a suspension into a silent no-op.
 */
export class AskUserSuspension extends Error {
  readonly questions: AskUserQuestion[];

  constructor(questions: AskUserQuestion[]) {
    super(`ask_user: suspended awaiting the user (${questions.length} question(s))`);
    this.name = "AskUserSuspension";
    this.questions = questions;
  }
}

const optionSchema = z.object({
  label: z.string().min(1).max(80).describe("The choice, as the user should read it."),
  description: z
    .string()
    .max(200)
    .optional()
    .describe("One sentence on what picking this implies. Strongly recommended."),
});

const questionSchema = z.object({
  header: z
    .string()
    .min(1)
    .max(ASK_USER_HEADER_MAX)
    .describe(`Tab label, at most ${ASK_USER_HEADER_MAX} characters (e.g. "认证方式").`),
  question: z.string().min(1).max(500).describe("The full question, ending in a question mark."),
  multiSelect: z
    .boolean()
    .optional()
    .describe("True to let the user pick several options. Omit for a single choice."),
  options: z
    .array(optionSchema)
    .min(ASK_USER_MIN_OPTIONS)
    .max(ASK_USER_MAX_OPTIONS)
    .refine(
      (opts) => new Set(opts.map((o) => o.label)).size === opts.length,
      "Option labels must be unique within a question."
    )
    .describe(`${ASK_USER_MIN_OPTIONS}–${ASK_USER_MAX_OPTIONS} distinct choices.`),
});

const inputSchema = z.object({
  questions: z
    .array(questionSchema)
    .min(1)
    .max(ASK_USER_MAX_QUESTIONS)
    .describe(`1–${ASK_USER_MAX_QUESTIONS} questions, shown one at a time as tabs.`),
});

const DESCRIPTION = [
  "Ask the user to choose between options, and stop this turn until they answer.",
  "",
  `Use it when there are ${ASK_USER_MIN_OPTIONS}–${ASK_USER_MAX_OPTIONS} defensible ways forward and the choice changes what you build, or when a detail you cannot infer would otherwise be guessed at. Ask 1–${ASK_USER_MAX_QUESTIONS} questions in one call; they are presented one at a time as tabs with a single submit at the end.`,
  "",
  "Rules:",
  "- Never offer an option like \"Other\" or \"Something else\" — the client appends its own free-text choice to every question automatically.",
  "- Do not call this alongside other tools, and do not call it more than once per step. It ends the step.",
  "- Prefer answering from context; asking a question the conversation already answers is worse than a wrong guess the user can correct.",
  "- When you have a recommendation, put it first and say so in its description.",
  "",
  "The user's answers come back as the tool result. If they dismiss the questions instead, the result says so — continue with your best judgement or ask them in chat.",
].join("\n");

/**
 * The `ask_user` tool.
 *
 * Its implementation only ever throws: by the time `runAgentStream` invokes it, the zod
 * schema above has already run, so reaching this body means the questions are well-formed
 * and the only thing left to do is hand them to the loop and stop. An *invalid* call never
 * gets here — it fails validation and becomes an ordinary tool error, which is what keeps
 * a malformed question set from ever reaching the card.
 *
 * Takes no context: it reads nothing and touches nothing, so it is built the same way for
 * every turn regardless of workspace, config or copilot.
 */
export function buildAskUserTool() {
  return tool(
    async (input: z.infer<typeof inputSchema>): Promise<string> => {
      throw new AskUserSuspension(input.questions);
    },
    {
      name: ASK_USER_TOOL_NAME,
      description: DESCRIPTION,
      schema: inputSchema,
    }
  );
}

/**
 * Check a client's submission against the questions that were actually asked.
 *
 * This is a trust boundary, not a formality. Whatever passes here is written into the
 * conversation and replayed to the model as the user's own answer, so the client does not
 * get to send prose: every label must be one the model offered, and a `submit` must leave
 * no question unanswered. A stale browser tab holding a question that has since been
 * skipped is the ordinary way this rejects, not only a hostile request.
 */
export function validateAnswers(
  questions: AskUserQuestion[],
  input: AnswerToolCallInput
): { ok: true; answers: AskUserAnswers } | { ok: false; reason: string } {
  if (input.action === "cancel") return { ok: true, answers: {} };

  const submitted = input.answers ?? {};
  const answers: AskUserAnswers = {};

  for (const [index, question] of questions.entries()) {
    const key = String(index);
    const given = submitted[key];
    if (!given) return { ok: false, reason: `question ${index} was not answered` };

    const offered = new Set(question.options.map((o) => o.label));
    const selected = Array.isArray(given.selected) ? given.selected : [];
    if (selected.some((label) => !offered.has(label))) {
      return { ok: false, reason: `question ${index} chose an option that was never offered` };
    }
    if (!question.multiSelect && selected.length > 1) {
      return { ok: false, reason: `question ${index} accepts a single choice` };
    }

    const other = typeof given.other === "string" ? given.other.trim() : "";
    if (other.length > ASK_USER_OTHER_MAX) {
      return { ok: false, reason: `the typed answer for question ${index} is too long` };
    }
    if (selected.length === 0 && !other) {
      return { ok: false, reason: `question ${index} has no answer` };
    }

    answers[key] = other ? { selected, other } : { selected };
  }

  return { ok: true, answers };
}

/**
 * The tool result the model reads.
 *
 * A tool-result string is *model input*, so it is deliberately not translated and not
 * phrased for a person — see the note in CLAUDE.md. The shape is flat and explicit so a
 * small model does not have to infer which answer belonged to which question.
 */
export function renderAskUserResult(
  questions: AskUserQuestion[],
  answers: AskUserAnswers,
  action: "submit" | "cancel"
): string {
  if (action === "cancel") {
    return JSON.stringify(
      {
        user_answers: null,
        note: "The user dismissed the questions without answering. Do not ask again; continue with your best judgement or ask them in chat.",
      },
      null,
      2
    );
  }

  const rendered = questions.map((question, index) => {
    const answer = answers[String(index)];
    return {
      question: question.question,
      selected: answer?.selected ?? [],
      ...(answer?.other ? { other: answer.other } : {}),
    };
  });

  return JSON.stringify({ user_answers: rendered }, null, 2);
}
