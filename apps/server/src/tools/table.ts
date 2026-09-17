import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import { TABLE_TOOL_NAME } from "@ilearnassist/shared";
import {
  MAX_TABLE_CHARS,
  TABLE_SUMMARY_MAX,
  looksLikeMarkdownTable,
  tableName,
} from "../tables.js";

/**
 * `ila_table` — the model records a table, in a conversation whose reply already shows it.
 *
 * A **writer of one row**, and nothing else: there is no file, because a table's display is the
 * assistant's own reply. That is the requirement this tool serves rather than a limitation — the
 * table is read inline as Markdown in the conversation, and this call exists so the panel can list
 * it, the viewer can re-render it, and the reader can copy it out. `docs/tables.md` is the full
 * statement; the short version is that a table's *artifact* is the message, and the row is the
 * index of it that outlives a regenerate.
 *
 * **The inline copy is the model's job, not this tool's**, and there is no code path that could
 * make it otherwise: nothing on the server writes into a model's reply. So the instruction lives
 * in `TABLE_GUIDANCE` below, which reaches the system prompt on any turn where this tool survived
 * assembly — and that guidance is not decoration. The tool's own description is necessarily a
 * *restriction* ("not every table"), and a model that was never told to write the table out reads
 * a restriction as "usually do not": the exact failure `COLLECT_PAGE_GUIDANCE` documents one tool
 * over.
 */

export interface TableSaveInput {
  /** Canonical row name — the model's label, slugified. */
  name: string;
  summary: string;
  /** The markdown table itself. */
  content: string;
  toolCallId: string | null;
}

export interface TableToolContext {
  /**
   * Record the row. A function rather than `{ db, sessionId }`, mirroring `DiagramToolContext`:
   * the domain rules (the canonical name, the revise upsert, the id) live in `tables.ts`, and this
   * file stays a writer of rows.
   */
  save: (input: TableSaveInput) => void;
}

/** The invoke config shape this tool reads; only the one field it needs. */
interface TableInvokeConfig {
  configurable?: { toolCallId?: unknown };
}

/**
 * What the system prompt says on a turn that offers this tool.
 *
 * The positive half of a contract whose other half is a restriction, and it has to carry three
 * things the schema cannot: that the table is *also* written in the reply (which is what the user
 * sees — the tool produces no rendering at all), that this is how a table becomes findable later
 * in the 图表 panel, and that the panel's copy is the row rather than the reply, so a revise means
 * calling again with the same name.
 *
 * Deliberately *not* a repetition of the description: the description is read when the model is
 * deciding whether to call, and this when it is deciding what to do with the turn.
 */
export const TABLE_GUIDANCE =
  "When a table is worth keeping (a comparison, a summary, anything the learner will want to " +
  "find again), call ila_table with the same markdown table you are writing in your reply. Write " +
  "the table out in your reply as ordinary Markdown as well — that inline copy is what the user " +
  "reads, and the tool's purpose is to keep it: it is saved to this conversation's 图表 panel, " +
  "where it can be reopened, zoomed and copied out later. To correct a table you already " +
  "recorded, call ila_table again with the same name and the complete corrected table.";

export function buildTableTool(ctx: TableToolContext): StructuredToolInterface {
  return tool(
    async ({ name, table, summary }, config?: TableInvokeConfig) => {
      /*
       * Both refusals throw before the write, which is what keeps a refused revise from wiping the
       * previous row: without the ordering, correcting a table with a malformed one would clear
       * the copy the panel holds. Both are things the model can fix, unlike a database that will
       * not take the row.
       */
      if (!table.trim()) {
        throw new Error("The table is empty. Pass the complete Markdown table.");
      }
      if (table.length > MAX_TABLE_CHARS) {
        throw new Error(
          `The table is ${table.length} characters, over the ${MAX_TABLE_CHARS} character ` +
            "limit. Record the part that matters, or split it into two tables."
        );
      }
      if (!looksLikeMarkdownTable(table)) {
        throw new Error(
          "This does not look like a Markdown table — it needs a header row and a separator " +
            "row of dashes under it, like `| 项目 | 数值 |` then `| --- | --- |`. Prose and " +
            "lists do not need this tool at all."
        );
      }

      const toolCallId =
        typeof config?.configurable?.toolCallId === "string"
          ? (config.configurable.toolCallId as string)
          : null;
      const canonical = tableName(name);
      ctx.save({ name: canonical, summary, content: table, toolCallId });

      /*
       * The result says what was *saved*, and asks for the part the tool cannot do. It must not
       * claim the reply already shows the table: the row and the reply are two copies and the
       * model is the only thing that can make them agree, so a result asserting that they do would
       * be a claim this side cannot verify — and one the model would read as permission to skip
       * writing it out.
       */
      return (
        `Saved the table "${canonical}" to this conversation's 图表 panel (${table.length} ` +
        `characters). Summary shown with it:\n${summary.trim()}\n` +
        "Write the same table into your reply as ordinary Markdown if you have not already — the " +
        "panel is where it is kept, not where it is read. To revise it, call ila_table again " +
        "with the same name and the complete corrected table."
      );
    },
    {
      name: TABLE_TOOL_NAME,
      description:
        "Record a Markdown table so the learner can find it again in the 图表 panel, where it " +
        "can be reopened, zoomed and copied out. Use it for a comparison, a summary or any " +
        "tabular result this conversation will want to come back to — not for every table, and " +
        "never instead of writing the table in your reply, which is where the user reads it. " +
        "The table's contents live in this conversation's record; nothing is written to a file.",
      schema: z.object({
        name: z
          .string()
          .describe(
            'Short name for this table, for example "季度对比". Any language is fine; it ' +
              "becomes the label the user sees in the 图表 list. Reuse the exact same name to " +
              "revise a table you recorded earlier — it replaces that one rather than adding a " +
              "second."
          ),
        table: z
          .string()
          .describe(
            "The complete Markdown table, exactly as you would write it in the reply: a header " +
              "row, then a separator row of dashes (`| --- | --- |`), then the body rows."
          ),
        summary: z
          .string()
          .min(1)
          .max(TABLE_SUMMARY_MAX)
          .describe(
            "One or two sentences saying what this table shows, in the same language as the " +
              "conversation. This is the description the user reads in the 图表 list and above " +
              "the enlarged view — say what it is about, not that it is \"a table\". Rewrite it " +
              "whenever you revise the table."
          ),
      }),
    }
  );
}
