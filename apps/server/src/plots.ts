import {
  MAX_PLOT_EXPR_CHARS,
  PLOT_COLORS,
  isPlotExpression,
  type PlotAxis,
  type PlotColor,
  type PlotElement,
  type PlotPoint,
  type PlotSpec,
} from "@ilearnassist/shared";
import { newId, type AppDb, type PlotRecord } from "./db.js";
import { slugify } from "./workspace.js";

/**
 * The rules for a plot row, outside any one tool or route.
 *
 * `tables.ts`'s twin, and the one structural difference mirrors the one between their tables: a
 * plot's row *is* the artifact, and the artifact is a JSON spec rather than markdown. So this
 * module owns what `looksLikeMarkdownTable` owns for a table — the shape check that refuses a
 * row the panel would list and the renderer could not draw — plus the expression whitelist that
 * makes "the model passes data, never code" a fact rather than a hope.
 */

/**
 * How long the model-written summary may be.
 *
 * Server-local, `TABLE_SUMMARY_MAX`'s rule verbatim: a shared constant exists when *both* sides
 * enforce one, and nothing on the client refuses a summary.
 */
export const PLOT_SUMMARY_MAX = 300;

/**
 * How much JSON one spec may be.
 *
 * Server-local, and larger than a table's cap on purpose: a table is characters in rows, while a
 * plot's spec is structural JSON, so the same visual size costs more bytes. A figure with a
 * dozen elements and a few hundred explicit points sits well under this; the cap exists so one
 * call cannot spend the conversation's context on a single drawing.
 */
export const MAX_PLOT_SPEC_CHARS = 32 * 1024;

/** At most this many elements in one figure. A wall of curves is a wall, not a figure. */
export const MAX_PLOT_ELEMENTS = 24;

/** At most this many explicit points across the whole figure, `points` elements included. */
export const MAX_PLOT_POINTS = 1000;

/** Cap on one text label. Long enough for a sentence, short enough to stay a label. */
export const MAX_PLOT_TEXT_CHARS = 200;

/**
 * The row's name, from the model's own label.
 *
 * **No extension**, `tableName`'s argument verbatim: there is no file, so the name is only an
 * identity and a label. **No uniqueness suffix** either — the name *is* the identity, so calling
 * the tool again with the same name revises that figure rather than adding a second one.
 */
export function plotName(name: string): string {
  return slugify(name.trim(), "plot");
}

/** What the tool hands the saver. The name is already canonical and the spec already validated. */
export interface PlotSaveInput {
  /** Canonical row name — the model's label, slugified. */
  name: string;
  /** The model's one-line description; required on the tool and `NOT NULL` in the row. */
  summary: string;
  /** The canonical JSON plot spec. The row is the only copy. */
  spec: string;
  /** The call that recorded it, or null when the invoke config carried no id. */
  toolCallId: string | null;
}

/**
 * Write, or revise in place.
 *
 * `registerTable`'s shape with the same note about the id: one is generated here because the
 * insert half needs one, and a revise's is discarded by the upsert's `ON CONFLICT` clause —
 * which is why the accessor reads back by `(session_id, name)` rather than returning what it was
 * handed.
 */
export function registerPlot(db: AppDb, sessionId: string, input: PlotSaveInput): PlotRecord {
  return db.upsertSessionPlot({
    id: newId(),
    sessionId,
    name: input.name,
    summary: input.summary,
    spec: input.spec,
    toolCallId: input.toolCallId,
  });
}

/**
 * The owner-scoped list the API carries.
 *
 * Synchronous like `listTableViews`, and for the same reason: there is no file for a row to be
 * missing, so being listed and being drawable are not two different questions here.
 */
export function listPlotViews(db: AppDb, userId: string, sessionId: string): ReturnType<AppDb["listPlotsForUser"]> {
  return db.listPlotsForUser(userId, sessionId);
}

/* --------------------------------- validating -------------------------------- */

/** A validation outcome: the canonical spec, or the sentence the tool hands the model. */
export type PlotSpecCheck = { ok: true; spec: PlotSpec } | { ok: false; error: string };

type Record_ = Record<string, unknown>;

function isRecord(value: unknown): value is Record_ {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Validate the model's spec, and rebuild it field by field.
 *
 * **Rebuilt rather than checked in place**, and that is the point of the function: a spec that
 * passed is the spec that is stored, so an unknown or misspelled field is refused with a
 * sentence rather than silently dropped by a schema. It is also the shape the renderer relies
 * on: every number is finite, every expression is inside the drawing language, and every
 * field is one this build knows, so the client's job is drawing rather than defending.
 */
export function validatePlotSpec(value: unknown): PlotSpecCheck {
  if (!isRecord(value)) return { ok: false, error: "spec must be a JSON object." };

  const errors: string[] = [];
  for (const key of Object.keys(value)) {
    if (!["title", "x", "y", "grid", "elements"].includes(key)) {
      errors.push(`spec has no field "${key}"`);
    }
  }

  let title: string | undefined;
  if (value.title !== undefined) {
    if (typeof value.title !== "string" || !value.title.trim()) {
      errors.push("spec.title must be a non-empty string");
    } else if (value.title.length > 200) {
      errors.push("spec.title is too long (at most 200 characters)");
    } else {
      title = value.title;
    }
  }

  const x = checkAxis(value.x, "spec.x", errors);
  const y = checkAxis(value.y, "spec.y", errors);

  let grid: boolean | undefined;
  if (value.grid !== undefined) {
    if (typeof value.grid !== "boolean") errors.push("spec.grid must be true or false");
    else grid = value.grid;
  }

  if (!Array.isArray(value.elements) || value.elements.length === 0) {
    errors.push("spec.elements must be a non-empty array of figure elements");
    return { ok: false, error: errors.join("; ") + "." };
  }
  if (value.elements.length > MAX_PLOT_ELEMENTS) {
    errors.push(
      `spec.elements holds ${value.elements.length} elements, over the ${MAX_PLOT_ELEMENTS} ` +
        "element limit — draw the part that matters, or split it into two figures"
    );
  }

  const elements: PlotElement[] = [];
  let points = 0;
  value.elements.forEach((raw, index) => {
    const checked = checkElement(raw, index, errors);
    if (!checked) return;
    points += explicitPoints(checked);
    elements.push(checked);
  });
  if (points > MAX_PLOT_POINTS) {
    errors.push(
      `the figure plots ${points} explicit points, over the ${MAX_PLOT_POINTS} point limit`
    );
  }

  if (errors.length > 0) return { ok: false, error: errors.join("; ") + "." };

  return {
    ok: true,
    spec: {
      ...(title !== undefined ? { title } : {}),
      ...(x ? { x } : {}),
      ...(y ? { y } : {}),
      ...(grid !== undefined ? { grid } : {}),
      elements,
    },
  };
}

/** An axis, rebuilt. Shared by `spec.x` and `spec.y`. */
function checkAxis(value: unknown, path: string, errors: string[]): PlotAxis | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    errors.push(`${path} must be an object like {"domain": [-5, 5], "label": "x"}`);
    return undefined;
  }
  for (const key of Object.keys(value)) {
    if (!["domain", "label", "log"].includes(key)) errors.push(`${path} has no field "${key}"`);
  }

  const axis: PlotAxis = {};
  if (value.domain !== undefined) {
    const domain = checkDomain(value.domain, `${path}.domain`, errors);
    if (domain) axis.domain = domain;
  }
  if (value.label !== undefined) {
    if (typeof value.label !== "string" || !value.label.trim()) {
      errors.push(`${path}.label must be a non-empty string`);
    } else if (value.label.length > 80) {
      errors.push(`${path}.label is too long (at most 80 characters)`);
    } else {
      axis.label = value.label;
    }
  }
  if (value.log !== undefined) {
    if (typeof value.log !== "boolean") errors.push(`${path}.log must be true or false`);
    else axis.log = value.log;
  }
  return Object.keys(axis).length > 0 ? axis : undefined;
}

/** `[min, max]` with both ends finite and `min < max`. */
function checkDomain(value: unknown, path: string, errors: string[]): PlotPoint | undefined {
  const point = checkPoint(value, path, errors);
  if (!point) return undefined;
  if (point[0] >= point[1]) {
    errors.push(`${path} must have its first end smaller than its second`);
    return undefined;
  }
  return point;
}

/** `[x, y]` — exactly two finite numbers. */
function checkPoint(value: unknown, path: string, errors: string[]): PlotPoint | undefined {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !isFiniteNumber(value[0]) ||
    !isFiniteNumber(value[1])
  ) {
    errors.push(`${path} must be a point like [1, 2], with two finite numbers`);
    return undefined;
  }
  return [value[0], value[1]];
}

/** An optional finite number, refused with the field's path when it is not one. */
function checkNumber(
  value: unknown,
  path: string,
  errors: string[],
  opts: { min?: number; exclusiveMin?: number } = {}
): number | undefined {
  if (value === undefined) return undefined;
  if (!isFiniteNumber(value)) {
    errors.push(`${path} must be a finite number`);
    return undefined;
  }
  if (opts.min !== undefined && value < opts.min) {
    errors.push(`${path} must be at least ${opts.min}`);
    return undefined;
  }
  if (opts.exclusiveMin !== undefined && value <= opts.exclusiveMin) {
    errors.push(`${path} must be greater than ${opts.exclusiveMin}`);
    return undefined;
  }
  return value;
}

function checkColor(value: unknown, path: string, errors: string[]): PlotColor | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !(PLOT_COLORS as readonly string[]).includes(value)) {
    errors.push(`${path} must be one of ${PLOT_COLORS.join(", ")}`);
    return undefined;
  }
  return value as PlotColor;
}

function checkDashed(value: unknown, path: string, errors: string[]): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    errors.push(`${path} must be true or false`);
    return undefined;
  }
  return value;
}

/** The fields each kind takes, beyond `kind` itself. */
const ELEMENT_FIELDS: Record<string, readonly string[]> = {
  function: ["expr", "from", "to", "fill", "dashed", "color"],
  implicit: ["expr", "dashed", "color"],
  parametric: ["x", "y", "from", "to", "dashed", "color"],
  points: ["points", "connect", "color"],
  segment: ["from", "to", "dashed", "color"],
  polygon: ["points", "fill", "color"],
  vector: ["from", "to", "color"],
  circle: ["center", "radius", "dashed", "color"],
  text: ["at", "text", "color"],
};

/**
 * One expression, checked against its element's own variables.
 *
 * The whitelist lives in `packages/shared` because the renderer refuses it too — one rule, two
 * enforcers — and the sentence here names the variable so a model that wrote `y` in a function
 * of `x` is told which one it may use.
 */
function checkExpression(
  value: unknown,
  path: string,
  variables: readonly string[],
  errors: string[]
): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${path} must be an expression string`);
    return undefined;
  }
  if (value.length > MAX_PLOT_EXPR_CHARS) {
    errors.push(`${path} is ${value.length} characters, over the ${MAX_PLOT_EXPR_CHARS} limit`);
    return undefined;
  }
  if (!isPlotExpression(value, variables)) {
    errors.push(
      `${path} is not a formula this renderer draws. Use numbers, ${variables.join(", ")}, ` +
        "parentheses, + - * / ^, and the usual functions (sin, cos, sqrt, log, …) — nothing else"
    );
    return undefined;
  }
  return value;
}

/** How many explicit points an element carries, for the figure-wide budget. */
function explicitPoints(element: PlotElement): number {
  if (element.kind === "points" || element.kind === "polygon") return element.points.length;
  return 0;
}

/**
 * One element, rebuilt. Returns null when it is unusable, with the reasons appended to `errors`.
 *
 * The unknown-field check is per kind, and that is `ila_query`'s `checkFields` argument one level
 * down: a `function` carrying `radius` is a model that picked the wrong kind, and a schema that
 * stripped the field would return a figure and never say it went nowhere.
 */
function checkElement(value: unknown, index: number, errors: string[]): PlotElement | null {
  const path = `spec.elements[${index}]`;
  if (!isRecord(value)) {
    errors.push(`${path} must be an object with a "kind"`);
    return null;
  }
  const kind = value.kind;
  if (typeof kind !== "string" || !(kind in ELEMENT_FIELDS)) {
    errors.push(`${path}.kind must be one of ${Object.keys(ELEMENT_FIELDS).join(", ")}`);
    return null;
  }

  const allowed = ELEMENT_FIELDS[kind]!;
  for (const key of Object.keys(value)) {
    if (key !== "kind" && !allowed.includes(key)) {
      errors.push(`${path}: a "${kind}" element has no field "${key}"`);
    }
  }

  switch (kind) {
    case "function": {
      const expr = checkExpression(value.expr, `${path}.expr`, ["x"], errors);
      const from = checkNumber(value.from, `${path}.from`, errors);
      const to = checkNumber(value.to, `${path}.to`, errors);
      if (from !== undefined && to !== undefined && from >= to) {
        errors.push(`${path}.from must be smaller than ${path}.to`);
      }
      const color = checkColor(value.color, `${path}.color`, errors);
      if (expr === undefined) return null;
      return {
        kind: "function",
        expr,
        ...(from !== undefined ? { from } : {}),
        ...(to !== undefined ? { to } : {}),
        ...(value.fill === true ? { fill: true } : {}),
        ...(checkDashed(value.dashed, `${path}.dashed`, errors) ? { dashed: true } : {}),
        ...(color ? { color } : {}),
      };
    }
    case "implicit": {
      const expr = checkExpression(value.expr, `${path}.expr`, ["x", "y"], errors);
      const color = checkColor(value.color, `${path}.color`, errors);
      if (expr === undefined) return null;
      return {
        kind: "implicit",
        expr,
        ...(checkDashed(value.dashed, `${path}.dashed`, errors) ? { dashed: true } : {}),
        ...(color ? { color } : {}),
      };
    }
    case "parametric": {
      const x = checkExpression(value.x, `${path}.x`, ["t"], errors);
      const y = checkExpression(value.y, `${path}.y`, ["t"], errors);
      const from = checkNumber(value.from, `${path}.from`, errors);
      const to = checkNumber(value.to, `${path}.to`, errors);
      if (from !== undefined && to !== undefined && from >= to) {
        errors.push(`${path}.from must be smaller than ${path}.to`);
      }
      const color = checkColor(value.color, `${path}.color`, errors);
      if (x === undefined || y === undefined) return null;
      return {
        kind: "parametric",
        x,
        y,
        ...(from !== undefined ? { from } : {}),
        ...(to !== undefined ? { to } : {}),
        ...(checkDashed(value.dashed, `${path}.dashed`, errors) ? { dashed: true } : {}),
        ...(color ? { color } : {}),
      };
    }
    case "points": {
      const points = checkPoints(value.points, `${path}.points`, errors, 1);
      const color = checkColor(value.color, `${path}.color`, errors);
      if (!points) return null;
      return {
        kind: "points",
        points,
        ...(value.connect === true ? { connect: true } : {}),
        ...(color ? { color } : {}),
      };
    }
    case "segment": {
      const from = checkPoint(value.from, `${path}.from`, errors);
      const to = checkPoint(value.to, `${path}.to`, errors);
      const color = checkColor(value.color, `${path}.color`, errors);
      if (!from || !to) return null;
      return {
        kind: "segment",
        from,
        to,
        ...(checkDashed(value.dashed, `${path}.dashed`, errors) ? { dashed: true } : {}),
        ...(color ? { color } : {}),
      };
    }
    case "polygon": {
      const points = checkPoints(value.points, `${path}.points`, errors, 3);
      const color = checkColor(value.color, `${path}.color`, errors);
      if (!points) return null;
      return {
        kind: "polygon",
        points,
        ...(value.fill === false ? { fill: false } : {}),
        ...(color ? { color } : {}),
      };
    }
    case "vector": {
      const from = checkPoint(value.from, `${path}.from`, errors);
      const to = checkPoint(value.to, `${path}.to`, errors);
      const color = checkColor(value.color, `${path}.color`, errors);
      if (!from || !to) return null;
      return { kind: "vector", from, to, ...(color ? { color } : {}) };
    }
    case "circle": {
      const center = checkPoint(value.center, `${path}.center`, errors);
      const radius = checkNumber(value.radius, `${path}.radius`, errors, { exclusiveMin: 0 });
      const color = checkColor(value.color, `${path}.color`, errors);
      if (!center || radius === undefined) return null;
      return {
        kind: "circle",
        center,
        radius,
        ...(checkDashed(value.dashed, `${path}.dashed`, errors) ? { dashed: true } : {}),
        ...(color ? { color } : {}),
      };
    }
    case "text": {
      const at = checkPoint(value.at, `${path}.at`, errors);
      const color = checkColor(value.color, `${path}.color`, errors);
      if (typeof value.text !== "string" || !value.text.trim()) {
        errors.push(`${path}.text must be a non-empty string`);
        return null;
      }
      if (value.text.length > MAX_PLOT_TEXT_CHARS) {
        errors.push(`${path}.text is too long (at most ${MAX_PLOT_TEXT_CHARS} characters)`);
        return null;
      }
      if (!at) return null;
      return { kind: "text", at, text: value.text, ...(color ? { color } : {}) };
    }
    default:
      return null;
  }
}

/** A list of points, with a minimum count (1 for a set, 3 for a polygon). */
function checkPoints(
  value: unknown,
  path: string,
  errors: string[],
  min: number
): PlotPoint[] | undefined {
  if (!Array.isArray(value) || value.length < min) {
    errors.push(`${path} must be an array of at least ${min} [x, y] point(s)`);
    return undefined;
  }
  const points: PlotPoint[] = [];
  value.forEach((raw, index) => {
    const point = checkPoint(raw, `${path}[${index}]`, errors);
    if (point) points.push(point);
  });
  return points.length === value.length ? points : undefined;
}
