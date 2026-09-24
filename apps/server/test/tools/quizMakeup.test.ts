import { describe, expect, it, vi } from "vitest";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { QUIZ_MAKEUP_MAX, QUIZ_MAKEUP_TOOL_NAME, type QuizQuestion } from "@ilearnassist/shared";
import {
  buildMakeupQuizTool,
  MakeupQuizSuspension,
  makeupGuidance,
  renderMakeupResult,
  type MakeupQuizToolContext,
} from "../../src/tools/quizMakeup.js";

/**
 * The make-up tool, on its own.
 *
 * Three things are under test and none of them is the database: that the tool *suspends* with the
 * questions it selected (which is the whole mechanism — a card is a recorded call with no output),
 * that it asks the conversation for the right ones, and that its description and its guidance say
 * what the requirement needs said. The wire shape is asserted here as well as in
 * `tool-wire-schema.test.ts`, because a flat object is a property of this schema rather than of a
 * turn: the guard there needs a quiz widget installed to see the tool at all.
 */

function question(n: number): QuizQuestion {
  return {
    id: `Q${n}`,
    uid: `uid-${n}`,
    header: `题${n}`,
    question: `第 ${n} 题问的是什么？`,
    options: [{ label: "甲" }, { label: "乙" }],
  };
}

function context(questions: QuizQuestion[]): MakeupQuizToolContext & {
  selectQuestions: ReturnType<typeof vi.fn>;
} {
  const selectQuestions = vi.fn(() => questions);
  return { selectQuestions } as unknown as MakeupQuizToolContext & {
    selectQuestions: ReturnType<typeof vi.fn>;
  };
}

describe("buildMakeupQuizTool", () => {
  it("suspends with the selected questions, recorded so the card can re-render", async () => {
    const ctx = context([question(1), question(2)]);
    const tool = buildMakeupQuizTool(ctx);

    const error = await tool.invoke({}).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MakeupQuizSuspension);
    const suspension = error as MakeupQuizSuspension;
    expect(suspension.questions.map((q) => q.id)).toEqual(["Q1", "Q2"]);
    // What the call is persisted with — the entire card, since a suspended call carries no
    // output and the client renders from `input`.
    expect(suspension.recordedInput).toEqual({ questions: [question(1), question(2)] });
    /*
     * The answer key must not be reachable from anything the tool records: these questions come
     * from the conversation's rows, and the recorded shape is `QuizQuestion`, which has no key
     * field by construction. Asserted rather than assumed because the key's secrecy is the rule
     * the whole quiz family shares.
     */
    expect(JSON.stringify(suspension.recordedInput)).not.toMatch(/referenceAnswer|explanation/);
  });

  it("asks for every unanswered question when no id is named", async () => {
    const ctx = context([question(1)]);
    await buildMakeupQuizTool(ctx).invoke({}).catch(() => undefined);

    expect(ctx.selectQuestions).toHaveBeenCalledWith(undefined);
  });

  it("passes the ids it was given straight through", async () => {
    const ctx = context([question(3)]);
    await buildMakeupQuizTool(ctx)
      .invoke({ quiz_ids: ["uid-3"] })
      .catch(() => undefined);

    expect(ctx.selectQuestions).toHaveBeenCalledWith(["uid-3"]);
  });

  it("answers with a result rather than an empty card when there is nothing to make up", async () => {
    const tool = buildMakeupQuizTool(context([]));

    const result = (await tool.invoke({})) as string;

    expect(JSON.parse(result)).toMatchObject({ outcome: "nothing_to_make_up" });
  });

  it("refuses a set over the cap instead of silently taking the first twenty", async () => {
    /*
     * A truncation would be invisible in the worst way: the model believes it brought back
     * everything, and the learner is shown a card with questions missing that nobody mentioned.
     * The error names the count and the way out, which is what makes it a tool error the model
     * can act on inside the same turn.
     */
    const many = Array.from({ length: QUIZ_MAKEUP_MAX + 5 }, (_, i) => question(i + 1));
    const tool = buildMakeupQuizTool(context(many));

    await expect(tool.invoke({})).rejects.toThrow(/at most 20/);
  });

  it("converts to a top-level object schema", () => {
    // The `ila_query` trap: a union or a bare array converts to no top-level type, and a strict
    // endpoint refuses the function on every turn. This schema is one flat object with one
    // optional array field, and this is what keeps it that way.
    const tool = buildMakeupQuizTool(context([]));
    const schema = toJsonSchema(tool.schema as never) as Record<string, unknown>;

    expect(schema.type).toBe("object");
    expect(schema).not.toHaveProperty("anyOf");
    expect(Object.keys(schema.properties as Record<string, unknown>)).toEqual(["quiz_ids"]);
  });

  it("says in its description what it is for and what it will refuse", () => {
    // The requirement's own ask: the description has to tell the model this tool is how a learner
    // is brought back to questions they skipped, and it has to say that this is not a way to ask
    // a new question. Pinned, because it is the only place the model is told.
    const { description } = buildMakeupQuizTool(context([])) as { description: string };

    expect(description).toMatch(/make-up \(补答\)/);
    expect(description).toMatch(/never answered/);
    expect(description).toMatch(/partial/);
    expect(description).toMatch(/never creates a question/);
    expect(description).toMatch(/ila_review_quiz/);
  });
});

describe("renderMakeupResult", () => {
  const key = new Map([["Q1", { referenceAnswer: ["甲"], explanation: "它是按时间切的。" }]]);

  it("renders the answered questions through the quiz result, keys and all", () => {
    const rendered = JSON.parse(
      renderMakeupResult([question(1), question(2)], { Q1: { selected: ["甲"] } }, key)
    ) as { user_answers: Record<string, unknown>[] };

    expect(rendered.user_answers).toHaveLength(1);
    expect(rendered.user_answers[0]).toMatchObject({
      id: "Q1",
      quiz_id: "uid-1",
      selected: ["甲"],
      reference_answer: ["甲"],
      explanation: "它是按时间切的。",
    });
  });

  it("names the questions the learner passed over, beside the ones they answered", () => {
    /*
     * The half a partial answer needs. Without it the skipped questions are simply *absent* from
     * the result, and "do not grade what they skipped" is an instruction with nothing to apply it
     * to — the model would have to infer it from an empty selection, which is also what a malformed
     * answer looks like.
     */
    const rendered = JSON.parse(
      renderMakeupResult([question(1), question(2)], { Q1: { selected: ["甲"] } }, key)
    ) as { left_unanswered: Record<string, unknown>[] };

    expect(rendered.left_unanswered).toEqual([
      { id: "Q2", quiz_id: "uid-2", question: "第 2 题问的是什么？" },
    ]);
    // And no key travels for the one that was not answered.
    expect(JSON.stringify(rendered)).not.toMatch(/第 2 题[\s\S]*explanation/);
  });

  it("leaves the field out entirely when the whole card was answered", () => {
    const rendered = JSON.parse(
      renderMakeupResult([question(1)], { Q1: { selected: ["甲"] } }, key)
    ) as Record<string, unknown>;

    expect(rendered).not.toHaveProperty("left_unanswered");
    expect(rendered.user_answers).toHaveLength(1);
  });
});

describe("makeupGuidance", () => {
  it("renders the catalog entry and points at the make-up tool", () => {
    const text = makeupGuidance();

    expect(text).toMatch(new RegExp(QUIZ_MAKEUP_TOOL_NAME));
    // The sentence that keeps a model from re-posing a question the learner never answered — the
    // behaviour the tool exists to replace, and the one nothing else in the prompt forbids.
    expect(text).toMatch(/do not re-pose it with/);
  });
});
