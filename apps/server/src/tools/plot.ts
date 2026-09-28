import { tool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import { PLOT_ELEMENT_KINDS, PLOT_TOOL_NAME } from "@ilearnassist/shared";
import {
  MAX_PLOT_SPEC_CHARS,
  PLOT_SUMMARY_MAX,
  plotName,
  validatePlotSpec,
} from "../plots.js";
import { renderPrompt } from "../prompts.js";

/**
 * `ila_plot` — the model draws a math figure from data.
 *
 * The third artifact tool, and the one whose contract is the strictest about *what* it accepts:
 * a JSON spec, never code. The renderer is deterministic and lives entirely in the app, so a
 * plot cannot run anything, read anything or reach the network — the model says what the figure
 * is and the app draws it. `docs/plots.md` is the full statement; the short version is that a
 * plot is the table pattern (a row holds the artifact, no file, no sandbox) applied to a
 * coordinate-plane figure.
 *
 * **The spec is rebuilt before it is stored**, by `validatePlotSpec`: every number finite, every
 * expression inside the drawing language, every field one this build knows. That is what makes
 * the tool's promise true rather than aspirational — a spec that reaches the row is a spec the
 * renderer can draw.
 *
 * `name` is a slug like a table's, with no extension: there is no file, so it is only the row's
 * identity and the panel's label, and calling again with the same name revises in place.
 */

export interface PlotSaveInput {
  /** Canonical row name — the model's label, slugified. */
  name: string;
  summary: string;
  /** Canonical JSON, already validated. */
  spec: string;
  toolCallId: string | null;
}

export interface PlotToolContext {
  /**
   * Record the row. A function rather than `{ db, sessionId }`, mirroring the diagram and table
   * contexts: the domain rules (the canonical name, the revise upsert, the id) live in
   * `plots.ts`, and this file stays a writer of rows.
   */
  save: (input: PlotSaveInput) => void;
}

/** The invoke config shape this tool reads; only the one field it needs. */
interface PlotInvokeConfig {
  configurable?: { toolCallId?: unknown };
}

/**
 * What the system prompt says on a turn that offers this tool: `chat.guidance.plot` in the
 * catalog, so it can be tuned without a rebuild.
 *
 * The positive half of a contract whose other half is a restriction, and it has to carry what
 * the schema cannot: when a figure is worth drawing at all (a relation, a shape, a geometry
 * problem — not decoration), that the spec is **data** and expressions are formulas rather than
 * code, that the y-axis convention is up, and that re-calling with the same name revises the
 * figure rather than adding a second one.
 *
 * A function rather than a constant, and that is load-bearing: the catalog is patched by the
 * process entry point (`<dataRoot>/config.patch.json`), which runs *after* every module has been
 * evaluated. A module-level constant would be the bundled text forever, so a tuned prompt would
 * silently do nothing.
 */
export function plotGuidance(): string {
  return renderPrompt("chat.guidance.plot");
}

/** The axis shape, shared by `spec.x` and `spec.y`. Passthrough so our validator can refuse
 *  unknown fields with a sentence rather than zod dropping them. */
const axisSchema = z
  .object({
    domain: z.array(z.number()).length(2).optional(),
    label: z.string().optional(),
    log: z.boolean().optional(),
  })
  .passthrough();

/**
 * One element. The `kind` is a real enum so an unknown kind is a schema refusal; every other
 * field is optional at this level and the per-kind contract is `validatePlotSpec`'s, because a
 * per-kind field set cannot be expressed as one flat object and a union would be the wire-format
 * trap `ila_query` documents (a schema that does not convert to a top-level `"type": "object"`).
 */
const elementSchema = z
  .object({
    kind: z.enum(PLOT_ELEMENT_KINDS),
    expr: z.string().optional(),
    x: z.string().optional(),
    y: z.string().optional(),
    from: z.union([z.number(), z.array(z.number()).length(2)]).optional(),
    to: z.union([z.number(), z.array(z.number()).length(2)]).optional(),
    points: z.array(z.array(z.number()).length(2)).optional(),
    center: z.array(z.number()).length(2).optional(),
    radius: z.number().optional(),
    at: z.array(z.number()).length(2).optional(),
    text: z.string().optional(),
    connect: z.boolean().optional(),
    fill: z.boolean().optional(),
    dashed: z.boolean().optional(),
    color: z.string().optional(),
  })
  .passthrough();

export function buildPlotTool(ctx: PlotToolContext): StructuredToolInterface {
  return tool(
    async ({ name, summary, spec }, config?: PlotInvokeConfig) => {
      // The size refusal comes first because it is about the call as a whole, and both refusals
      // throw before the write — so a refused revise leaves the previous row entirely alone,
      // including its thread placement.
      const raw = JSON.stringify(spec);
      if (raw.length > MAX_PLOT_SPEC_CHARS) {
        throw new Error(
          `The spec is ${raw.length} characters, over the ${MAX_PLOT_SPEC_CHARS} character ` +
            "limit. Draw fewer elements or fewer explicit points, or split it into two figures."
        );
      }

      const checked = validatePlotSpec(spec);
      if (!checked.ok) {
        throw new Error(`The plot spec was refused: ${checked.error}`);
      }

      const toolCallId =
        typeof config?.configurable?.toolCallId === "string"
          ? (config.configurable.toolCallId as string)
          : null;
      const canonical = plotName(name);
      ctx.save({ name: canonical, summary, spec: JSON.stringify(checked.spec), toolCallId });

      const count = checked.spec.elements.length;
      return (
        `Saved the figure "${canonical}" to this conversation's 图表 panel (${count} ` +
        `element${count === 1 ? "" : "s"}). Summary shown with it:\n${summary.trim()}\n` +
        "The figure is rendered in the conversation. To revise it, call ila_plot again with " +
        "the same name and the complete corrected spec — it replaces that figure, so the " +
        "conversation shows one figure, not two."
      );
    },
    {
      name: PLOT_TOOL_NAME,
      description: [
        "Draw a math figure on a coordinate plane — a function, a curve, a geometric figure, a " +
          "set of points, a vector — for the user to see. Use this instead of describing the " +
          "shape in words or drawing it with ASCII art, and instead of mermaid: mermaid draws " +
          "flowcharts and diagrams, this draws *mathematics* (graphs of functions, circles, " +
          "triangles, vectors, coordinate geometry).",
        "",
        "The argument is a JSON **spec**, never code: the app renders it deterministically. An " +
          "expression is a formula in a variable — the drawing language has numbers, `x` (a " +
          "function of x), `x` and `y` (an implicit relation, drawn where the expression equals " +
          "zero), `t` (a parametric pair), the constants pi and e, the operators + - * / ^, and " +
          "functions abs, sqrt, sin, cos, tan, asin, acos, atan, sinh, cosh, tanh, exp, log, " +
          "log10, min, max, pow, round, floor, ceil. Nothing else is accepted.",
        "",
        `spec.elements is an array of up to 24 objects, each with a "kind":`,
        '- {"kind":"function","expr":"sin(x)","from":-6.28,"to":6.28,"dashed":false,"fill":false} — y = f(x); fill shades down to y = 0',
        '- {"kind":"implicit","expr":"x^2 + y^2 - 9"} — f(x, y) = 0, e.g. a circle or ellipse',
        '- {"kind":"parametric","x":"3*cos(t)","y":"3*sin(t)","from":0,"to":6.28}',
        '- {"kind":"points","points":[[1,2],[3,4]],"connect":false} — dots, or a polyline when connect is true',
        '- {"kind":"segment","from":[0,0],"to":[3,2]}',
        '- {"kind":"polygon","points":[[0,0],[4,0],[3,3]],"fill":true}',
        '- {"kind":"vector","from":[0,0],"to":[2,1]} — an arrow',
        '- {"kind":"circle","center":[1,2],"radius":3}',
        '- {"kind":"text","at":[1,2],"text":"A"} — a label; use these to name points and curves',
        "",
        "Every element may carry `color` (accent, success, warning, danger, muted) and the " +
          "line-like kinds may carry `dashed`. spec.x and spec.y take {domain:[min,max], label, " +
          "log}, spec.title is the figure's heading, spec.grid draws a grid. Give each figure a " +
          "`name` (reuse it to revise) and a `summary` saying what it shows.",
      ].join("\n"),
      schema: z.object({
        name: z
          .string()
          .describe(
            'Short name for this figure, for example "抛物线顶点". Any language is fine; it ' +
              "becomes the label the user sees in the 图表 list. Reuse the exact same name to " +
              "revise a figure you drew earlier — it replaces that one rather than adding a " +
              "second."
          ),
        summary: z
          .string()
          .min(1)
          .max(PLOT_SUMMARY_MAX)
          .describe(
            "One or two sentences saying what this figure shows, in the same language as the " +
              "conversation. This is the description the user reads in the 图表 list and above " +
              'the enlarged view — say what it is about, e.g. "抛物线 y=x² 与直线 y=x+2 的交点", ' +
              'not what shape it is, like "a graph". Rewrite it whenever you revise the figure.'
          ),
        spec: z
          .object({
            title: z.string().optional().describe("The figure's heading, shown above the plot."),
            x: axisSchema.optional().describe("The x-axis: domain [min,max], label, log."),
            y: axisSchema.optional().describe("The y-axis: domain [min,max], label, log."),
            grid: z.boolean().optional().describe("Draw a grid behind the figure."),
            elements: z
              .array(elementSchema)
              .min(1)
              .describe(
                "The figure's elements. Each object needs a `kind`; its other fields depend on " +
                  "the kind, as the description above lists."
              ),
          })
          .passthrough()
          .describe("The figure, as data: axes, grid, title and the elements to draw."),
      }),
    }
  );
}
