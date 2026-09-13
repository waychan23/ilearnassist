import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  PLAN_MAKE_TOOL_NAME,
  PLAN_PROGRESS_TOOL_NAME,
  PLAN_READ_TOOL_NAME,
} from "@ilearnassist/shared";
import type { AppDb } from "../db.js";
import {
  applyProgress,
  makePlan,
  planConflicted,
  planProgressInputSchema,
  planTreeInputSchema,
  readCurrentPlan,
  renderMakeResult,
  renderProgressResult,
  renderReadResult,
} from "../plans.js";
import { Suspension } from "./suspension.js";

/**
 * What the plan tools need from the turn they run in: the database and the server-bound
 * session id. The model never names a session — the context is assembled only when the
 * plan widget is installed for this conversation, the same contextual assembly
 * `read_document` uses for its whitelist.
 */
export interface PlanToolContext {
  db: AppDb;
  sessionId: string;
}

/**
 * Thrown by `ila_make_plan` when a conversation already has a plan and the submission looks
 * like a fresh create (no node ids). Control flow rather than failure — see `Suspension` and
 * the loop's arm — the user picks "edit this plan" or "new conversation", and the answer
 * route commits the choice.
 */
export class PlanConflictSuspension extends Suspension {
  constructor(tree: unknown) {
    super(
      "PlanConflictSuspension",
      "ila_make_plan: a plan already exists; suspended awaiting the user's choice",
      { tree }
    );
  }
}

/** The only invoke config the tools read: the loop stamps the provider's tool-call id. */
interface PlanInvokeConfig {
  configurable?: { toolCallId?: unknown };
}

const MAKE_DESCRIPTION = [
  "Create or replace the conversation's study plan as a tree, and stop once you have called it so the user can decide the shape of what follows.",
  "",
  "A conversation has exactly ONE plan. Use this tool both to create it and to edit it later.",
  "",
  "Creating (first time):",
  "- Submit the whole tree in `tree`, an ordered array of root nodes; each node is {title, children?} with NO id. The tool assigns every node a stable id and returns the tree with ids.",
  "- The panel renders the tree, and the same ids are how later edits and progress updates name nodes — they are not readable numbers like 1.2, they are opaque ids.",
  "",
  "Editing (a plan already exists):",
  "- You MUST call ila_read_plan first and edit against the ids it returned: every node that already exists keeps the same id. Omit the id only for nodes you are adding.",
  "- A node left out of the edited tree is recorded as deleted (shown struck through) but its history and version stay intact.",
  "- Never invent or guess an id. Reusing a deleted node's id, or an id from another plan, is an error.",
  "- If the user wants a genuinely different plan rather than a revision, they are asked whether to edit this plan or start a new conversation; the tool suspends with a choice card. Do not work around it.",
  "",
  "Rules:",
  "- Titles are short statements of what to learn/do, in the user's language; keep the tree focused (chapters/sections/topics), at most 8 levels deep and 300 nodes.",
  "- The plan is a structure for tracking progress, not the teaching content itself: nodes are topics, not paragraphs.",
  "- After the call, present the full plan in your message too, as a readable outline — the tool result asks you to. Call it once per step.",
].join("\n");

const READ_DESCRIPTION = [
  "Read the conversation's current plan: its version, overall status, and the complete tree with every node's id and status.",
  "",
  "Use it before editing the plan with ila_make_plan (you must carry the existing ids), when you need to know what has been studied, and whenever the user asks what the plan says. Status is one of: not_started, in_progress, completed, skipped (moved past, may return), deleted (removed by an edit).",
].join("\n");

const PROGRESS_DESCRIPTION = [
  "Update study progress on the current plan, in one batched call. Two levels:",
  "- `planStatus`: one of not_started | in_progress | completed. Usually you can omit it — when every non-deleted node is completed the plan completes itself, and any started node makes it in_progress.",
  "- `nodes`: each {id, status}. Node status is one of not_started | in_progress | completed | skipped.",
  "  - `skipped` means the learner moved on without finishing it yet and may come back; it is still unfinished.",
  "  - Mark `completed` only when the topic was actually learned/practised in the conversation. Completed nodes become clickable jumps back to the moment they were finished.",
  "  - Nodes are deleted only by editing the plan with ila_make_plan, never here.",
  "",
  "Batch every change a turn produced into one call (several nodes, or the plan plus nodes). Only send statuses that actually changed.",
].join("\n");

export function buildPlanTools(ctx: PlanToolContext) {
  const make = tool(
    async (input: z.infer<typeof planTreeInputSchema>): Promise<string> => {
      const result = makePlan(ctx.db, ctx.sessionId, input);
      if (planConflicted(result)) {
        // The recorded input is the tree the model submitted, which the answer route
        // re-validates before committing either fork.
        throw new PlanConflictSuspension(input.tree);
      }
      return renderMakeResult(result);
    },
    { name: PLAN_MAKE_TOOL_NAME, description: MAKE_DESCRIPTION, schema: planTreeInputSchema }
  );

  const read = tool(
    async (): Promise<string> => renderReadResult(readCurrentPlan(ctx.db, ctx.sessionId)),
    {
      name: PLAN_READ_TOOL_NAME,
      description: READ_DESCRIPTION,
      schema: z.object({}),
    }
  );

  const updateProgress = tool(
    async (
      input: z.infer<typeof planProgressInputSchema>,
      config?: PlanInvokeConfig
    ): Promise<string> => {
      const toolCallId =
        typeof config?.configurable?.toolCallId === "string"
          ? config.configurable.toolCallId
          : "";
      const view = applyProgress(ctx.db, ctx.sessionId, input, toolCallId);
      return renderProgressResult(view, input.nodes?.length ?? 0);
    },
    {
      name: PLAN_PROGRESS_TOOL_NAME,
      description: PROGRESS_DESCRIPTION,
      schema: planProgressInputSchema,
    }
  );

  return [make, read, updateProgress];
}
