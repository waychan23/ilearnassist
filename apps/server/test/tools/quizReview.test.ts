import { describe, expect, it } from "vitest";
import { QUIZ_GUIDANCE, buildQuizReviewTool } from "../../src/tools/quizReview.js";
import { renderReviewResult } from "../../src/quizzes.js";

/**
 * The grading turn's wording is the behaviour here. Nothing in the schema stops a model from
 * recording a correct verdict with a vacuous explanation and then answering an all-correct
 * quiz with a one-line congratulations — which is exactly the thin reply these strings exist
 * to prevent. Pin the load-bearing phrases the way the ask_user/quiz description tests do.
 */

// The database is only touched inside invoke(); building the tool reads the context without
// using it, so a cast stand-in is enough for a description test.
const description = buildQuizReviewTool({
  db: {} as never,
  sessionId: "session-1",
}).description;

describe("quiz review description", () => {
  it("frames the explanation as required for every question, correct ones included", () => {
    expect(description).toMatch(/a short explanation for EVERY question/);
    expect(description).toMatch(/including the ones they got right/);
    expect(description).toMatch(/explanation is required for every question whatever the verdict/);
  });

  it("says what a correct answer's explanation must contain", () => {
    // A verdict alone used to be the whole feedback for a right answer; the rule now asks for
    // a sentence that reinforces why, and forbids the vacuous reply explicitly.
    expect(description).toMatch(/For a correct answer, briefly say what makes the picked option right/);
    expect(description).toMatch(/never just "correct" or "right"/);
  });

  it("demands a per-question rundown in the final message even when all are correct", () => {
    expect(description).toMatch(/walk the questions one by one in your FINAL message/);
    expect(description).toMatch(/each with its Qn label, its verdict and a brief why/);
    expect(description).toMatch(/An all-correct quiz is not a one-line congratulations/);
  });

  it("orders the bookkeeping tool calls before the verdict prose", () => {
    // Text streamed alongside a tool call is ephemeral in the loop unless it is the grading
    // call; telling the model to grade (and move the plan) first and write afterwards puts
    // the rundown in the final step, which is the step that always persists.
    expect(description).toMatch(/any ila_update_plan_progress that belongs to the same turn/);
    expect(description).toMatch(/BEFORE you write the verdict rundown/);
    expect(description).toMatch(/final message, after the tool results come back/);
  });
});

describe("quiz guidance", () => {
  it("does not let an all-correct quiz collapse into a summary", () => {
    expect(QUIZ_GUIDANCE).toMatch(/EVERY question gets one, correct answers included/);
    expect(QUIZ_GUIDANCE).toMatch(
      /an all-correct quiz is a per-question rundown, not a one-line congratulations/
    );
  });
});

describe("renderReviewResult", () => {
  it("is the last word before the reply and asks for every question's why", () => {
    const parsed = JSON.parse(
      renderReviewResult({ graded: [{ quiz_id: "q1", verdict: "correct" }] })
    ) as { graded: unknown; note: string };
    expect(parsed.graded).toEqual([{ quiz_id: "q1", verdict: "correct" }]);
    expect(parsed.note).toMatch(/[Ww]alk through each question by its Qn label/);
    expect(parsed.note).toMatch(/including every correct one/);
    expect(parsed.note).toMatch(/not only a congratulations/);
    expect(parsed.note).toMatch(/call ila_update_plan_progress FIRST/);
    expect(parsed.note).toMatch(/FINAL message/);
  });
});
