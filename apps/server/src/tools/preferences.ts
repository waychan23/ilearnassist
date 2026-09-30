import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import {
  PREFERENCE_CONTENT_MAX,
  PREFERENCE_MAX_REPLACES,
  PREFERENCE_TOOL_NAME,
  PREFERENCE_TYPES,
  type PreferenceType,
} from "@ilearnassist/shared";
import type { SavePreferenceResult } from "../preferences.js";
import { renderPrompt } from "../prompts.js";

/**
 * `ila_save_preference` — the agent records a standing requirement the user stated about how it
 * should work.
 *
 * A **writer of one row**, and the row is the artifact: no file, no widget-bound context. The
 * panel that lists it is installed by the call (`auto-install` in `WIDGETS`), the way drawing a
 * diagram installs the 图表 panel.
 *
 * **The prohibition is the half the schema cannot carry**: the requirement is explicit that
 * preferences are recorded only when the user asks for them, never inferred. `chat.guidance.
 * preference` carries that sentence, and it is appended whenever this tool survived assembly
 * (the `collectPageGuidance` rule) — the tool's own description is a restriction, and a model
 * that was never told when recording is wanted reads a restriction as "usually do not".
 *
 * Conflict handling is the caller's: the model names the superseded ids in `replaces`, and
 * `savePreference` refuses any id it cannot honour. The result lists the conversation's current
 * preferences with their ids, so a model that recorded one before — or that has just replaced
 * one — can name exactly what it means next time.
 */

export interface PreferenceToolContext {
  /**
   * Record the rule. A function rather than `{ db, sessionId }`, mirroring `TableToolContext`:
   * the domain rules (the id, the replace protocol, the refusal) live in `preferences.ts`, and
   * this file stays a caller with a schema.
   */
  save: (input: {
    type: PreferenceType;
    content: string;
    replaces?: string[];
  }) => SavePreferenceResult;
}

/**
 * What the system prompt says on a turn that offers this tool: `chat.guidance.preference` in the
 * catalog. Read at call time, never captured — a canonical function for the reason `tableGuidance`
 * documents.
 */
export function preferenceGuidance(): string {
  return renderPrompt("chat.guidance.preference");
}

export function buildPreferenceTool(ctx: PreferenceToolContext): StructuredToolInterface {
  return tool(
    async ({ type, content, replaces }) => {
      const saved = ctx.save({ type, content, replaces: replaces ?? [] });
      const current = saved.preferences.length
        ? saved.preferences
            .map((p) => `- ${p.id} [${p.scope}] (${p.type}) ${p.content}`)
            .join("\n")
        : "(none)";
      return (
        `Recorded this user preference:\n(${saved.preference.type}) ${saved.preference.content}\n\n` +
        `Current preferences in this conversation:\n${current}\n\n` +
        "These ids are what `replaces` accepts. When a later request from the user contradicts " +
        "one of them, record the new rule with that preference's id in `replaces` so it is " +
        "removed rather than both rules standing."
      );
    },
    {
      name: PREFERENCE_TOOL_NAME,
      description:
        "Record a standing requirement the user explicitly stated about how you should work — " +
        "a preference that applies to this and later turns (\"回答用中文\", \"先给结论\", " +
        "\"不要用表格\"). Only record what the user asked for in so many words; never infer a " +
        "preference from their reaction, their tone, or your own judgement, and never record a " +
        "one-off instruction about the current answer. positive is something they want " +
        "(希望/我要/我喜欢/你要…), negative is something they do not (不希望/我不要/我不喜欢/" +
        "你不要…). Write the rule as one short, self-contained, executable sentence in the " +
        "user's language. If it contradicts an existing preference, pass that preference's id " +
        "in `replaces` — the later statement wins and the old rule is deleted.",
      schema: z.object({
        type: z
          .enum(PREFERENCE_TYPES)
          .describe(
            'positive: something the user wants ("回答先给结论"). negative: something they ' +
              'do not want ("不要使用表格").'
          ),
        content: z
          .string()
          .min(1)
          .max(PREFERENCE_CONTENT_MAX)
          .describe(
            "The preference as one short, self-contained rule in the user's language — what " +
              "you should do or stop doing. Do not quote the user or refer to the current " +
              "answer; the rule must stand on its own on later turns."
          ),
        replaces: z
          .array(z.string())
          .max(PREFERENCE_MAX_REPLACES)
          .optional()
          .describe(
            "Ids of existing preferences this one contradicts or refines, from the list in " +
              "your system prompt, from a previous result of this tool, or from ila_query " +
              "kind \"preference\". Omit when the new rule conflicts with none."
          ),
      }),
    }
  );
}
