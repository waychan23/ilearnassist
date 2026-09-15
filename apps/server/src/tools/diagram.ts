import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import { DIAGRAM_TOOL_NAME, MAX_DIAGRAM_CHARS, diagramFileName } from "@ilearnassist/shared";
import { resolveInWorkspace } from "../workspace.js";

/**
 * `ila_diagram` — the model draws a diagram instead of describing one in characters.
 *
 * The tool is a **writer**, and that is the whole of it: the source goes to a file in the
 * conversation's own directory, and the rendering happens on the other side of the wire, in
 * a component that lazy-loads mermaid. Nothing here parses or validates mermaid syntax. A
 * malformed diagram is not this tool's error to report — the viewer has to survive one
 * anyway (a model can get a syntax wrong in ways no schema describes), and two validators
 * would be two opinions about what mermaid accepts, free to disagree with the mermaid that
 * actually draws it.
 *
 * The directory is captured in the closure, like `buildFileTools` captures the workspace, so
 * a tool can never write outside the conversation it was built for.
 */

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
}

export function buildDiagramTool(ctx: DiagramToolContext): StructuredToolInterface {
  const resolve = (fileName: string): string => {
    const resolved = resolveInWorkspace(ctx.sessionDir, fileName);
    if (!resolved.ok || !resolved.path) throw new Error(resolved.error ?? "Invalid diagram name.");
    return resolved.path;
  };

  return tool(
    async ({ name, source }) => {
      // Both refusals throw, which the loop turns into a `Tool error: …` the model can read
      // and act on — an empty diagram and an enormous one are things it can fix, unlike an
      // unwritable directory, which is not.
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
      await fs.writeFile(path, source, "utf8");

      return (
        `Wrote ${fileName} (${source.length} characters) to this conversation's folder. ` +
        "The diagram is rendered in the conversation.\n" +
        "To revise it, call ila_diagram again with the same name and the complete corrected " +
        "source — it overwrites that file, so the conversation shows one diagram, not two."
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
      }),
    }
  );
}
