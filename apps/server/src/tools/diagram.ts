import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import { DIAGRAM_TOOL_NAME, MAX_DIAGRAM_CHARS } from "@ilearnassist/shared";
import { resolveInWorkspace } from "../workspace.js";
import {
  DIAGRAM_SUMMARY_MAX,
  diagramFileName,
  registerDiagram,
} from "../diagrams.js";

/**
 * `ila_diagram` — the model draws a diagram instead of describing one in characters.
 *
 * The tool is a **writer**, and of two things: the source goes to a file in the
 * conversation's own directory, and a row goes to the database. The file is the source of
 * the bytes; the row holds what the file cannot answer — the canonical name, the model's
 * summary, the call that wrote it, and later the thread it belongs to. Nothing here parses
 * or validates mermaid syntax: a malformed diagram is not this tool's error to report — the
 * viewer has to survive one anyway, and two validators would be two opinions about what
 * mermaid accepts.
 *
 * The directory is captured in the closure, like `buildFileTools` captures the workspace, so
 * a tool can never write outside the conversation it was built for.
 */

export interface DiagramSaveInput {
  /** Canonical file name inside the conversation's folder — `auth-flow.mmd`. */
  name: string;
  summary: string;
  toolCallId: string | null;
}

export interface DiagramToolContext {
  /**
   * This conversation's own directory: `sessionDir(workspace.dirPath, session.id)`.
   *
   * `dirPath`, never `workdirPath`. The workdir is the agent's own sandbox and the file
   * browser's root; a session directory derived from it would land at
   * `workdir/sessions/<id>/`, inside the tree the model may already write into — which would
   * make this tool's files indistinguishable from the ones `write_file` makes, and lose the
   * reason the session directory exists at all.
   */
  sessionDir: string;
  /**
   * Record the row. A function rather than `{ db, sessionId }`, mirroring the quiz tool's
   * `registerQuestions` callback: the domain rules (canonical name, the revise upsert, the
   * id generation) live in `diagrams.ts`, and this file stays a writer of files and rows.
   */
  save: (input: DiagramSaveInput) => void;
}

/** The invoke config shape this tool reads; only the one field it needs. */
interface DiagramInvokeConfig {
  configurable?: { toolCallId?: unknown };
}

export function buildDiagramTool(ctx: DiagramToolContext): StructuredToolInterface {
  const resolve = (fileName: string): string => {
    const resolved = resolveInWorkspace(ctx.sessionDir, fileName);
    if (!resolved.ok || !resolved.path) throw new Error(resolved.error ?? "Invalid diagram name.");
    return resolved.path;
  };

  return tool(
    async ({ name, source, summary }, config?: DiagramInvokeConfig) => {
      // Both refusals throw before either write, so a refused revise leaves the previous
      // file and row untouched — in particular it does not clear the previous thread_id.
      // They are things the model can fix, unlike an unwritable directory.
      if (!source.trim()) {
        throw new Error("The diagram source is empty. Pass the complete Mermaid source.");
      }
      if (source.length > MAX_DIAGRAM_CHARS) {
        throw new Error(
          `The diagram source is ${source.length} characters, over the ${MAX_DIAGRAM_CHARS} ` +
            "character limit. Split it into two diagrams, or draw a smaller part of it."
        );
      }

      const fileName = diagramFileName(name);
      const path = resolve(fileName);

      // The session directory is created when the conversation is, but that mkdir is
      // best-effort on purpose (a read-only data root must not fail starting a conversation),
      // so the writer is what guarantees the directory it writes into.
      await fs.mkdir(dirname(path), { recursive: true });
      // File first, then the row: a file with no row is still drawn in the conversation from
      // the arguments and fixed by the next call with the same name; a row with no file lists
      // a diagram that errors when opened, which is a lie the UI tells.
      await fs.writeFile(path, source, "utf8");

      const toolCallId =
        typeof config?.configurable?.toolCallId === "string"
          ? (config.configurable.toolCallId as string)
          : null;
      ctx.save({ name: fileName, summary, toolCallId });

      return (
        `Wrote ${fileName} (${source.length} characters) to this conversation's folder. ` +
        "The diagram is rendered in the conversation, and this summary is shown with it:\n" +
        summary.trim() +
        "\nTo revise it, call ila_diagram again with the same name, the complete corrected " +
        "source, and the rewritten summary — it overwrites that file, so the conversation shows " +
        "one diagram, not two."
      );
    },
    {
      name: DIAGRAM_TOOL_NAME,
      description:
        "Render a diagram for the user. Use this for every diagram — flowcharts, sequence " +
        "diagrams, class and UML diagrams, state machines, ER models, timelines — instead of " +
        "drawing one with ASCII art or box-drawing characters, which the user cannot read. " +
        "The source is rendered in the conversation and saved as a file in this conversation's " +
        "own folder, where the user can open it later.",
      schema: z.object({
        name: z
          .string()
          .describe(
            "Short file name for this diagram, without extension — for example \"auth-flow\". " +
              "Reuse the exact same name to revise a diagram you drew earlier: it overwrites " +
              "that file rather than adding a second one. Any language is fine; this becomes " +
              "the file name and the label the user sees in the diagram list."
          ),
        source: z
          .string()
          .describe(
            "The complete Mermaid source, starting with the diagram type on the first line " +
              "(\"flowchart TD\", \"sequenceDiagram\", \"classDiagram\", \"erDiagram\", " +
              "\"stateDiagram-v2\", \"gantt\", \"mindmap\", …). You may open it with a YAML " +
              "front-matter block (`---`, then `title: …`, then `---`) to give the diagram a " +
              "title."
          ),
        summary: z
          .string()
          .min(1)
          .max(DIAGRAM_SUMMARY_MAX)
          .describe(
            "One or two sentences saying what this diagram shows, in the same language as the " +
              "conversation. This is the description the user reads in the diagram list and " +
              "above the enlarged view — say what it is about, e.g. " +
              "\"登录流程：提交凭证、校验、签发会话，含失败分支\", not what shape it is, " +
              "like \"a flowchart\". Rewrite it whenever you revise the diagram."
          ),
      }),
    }
  );
}
