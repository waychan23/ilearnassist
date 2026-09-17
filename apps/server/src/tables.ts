import type { Table } from "@ilearnassist/shared";
import { newId, type AppDb, type TableRecord } from "./db.js";
import { slugify } from "./workspace.js";

/**
 * The rules for a table row, outside any one tool or route.
 *
 * `diagrams.ts`'s twin, and the one structural difference is the one thing to keep in mind here:
 * a diagram's row points at a file in the conversation's own directory, and a table's row *is* the
 * artifact. Everything else — the naming rule as identity, the revise-in-place upsert, the
 * classifier's placement — is the same problem with the same answer.
 */

/**
 * How long the model-written summary may be.
 *
 * Server-local, `DIAGRAM_SUMMARY_MAX`'s rule verbatim: a shared constant exists when *both* sides
 * enforce one, and nothing on the client refuses a summary.
 */
export const TABLE_SUMMARY_MAX = 300;

/**
 * How much markdown one table may be.
 *
 * Server-local too, and the reasoning differs slightly from the summary's in a way worth writing
 * down because it looks like an omission: `MAX_DIAGRAM_CHARS` is *shared* because the renderer
 * refuses a diagram past it as well (`layout is not linear in the input`), while markdown
 * rendering is linear — `renderMarkdown` has no cap and needs none — so the client has nothing to
 * refuse and no business knowing this number.
 *
 * Generous on purpose. A table is capped by what is worth showing in a panel, not by what the
 * model can type: a wide results table of 50 rows is a few thousand characters, and 16 KB is
 * roughly ten times the largest table anyone has asked for.
 */
export const MAX_TABLE_CHARS = 16 * 1024;

/**
 * The row's name, from the model's own label.
 *
 * **No extension**, unlike `diagramFileName`, and that is the whole difference between them: a
 * diagram's name is a *file* name and has to round-trip through the filesystem, while this one is
 * only an identity and a label. Appending `.md` would be inventing a file that does not exist.
 *
 * **No uniqueness suffix** — `diagramFileName`'s argument unchanged: the name *is* the identity, so
 * calling the tool again with the same name revises the same row, which is how a model corrects a
 * table it already made. A suffix would turn a correction into a second table beside the wrong one.
 */
export function tableName(name: string): string {
  return slugify(name.trim(), "table");
}

/**
 * True when the text has a markdown table's **header separator row** — the `|---|` line.
 *
 * The one thing this validates, and deliberately not the whole table. A full parse would be a
 * second renderer, free to disagree with the `markdown-it` that actually draws it — the argument
 * `docs/diagrams.md` makes for not validating mermaid syntax at all. But a table is not a drawing:
 * the panel's whole claim is that a thing called a table renders as one, and the separator row is
 * the line markdown-it itself keys on, so refusing its absence is refusing the one case that has
 * no reading in which the caller was right.
 *
 * A separator row is one or more cells of dashes and colons, pipes optional at the ends:
 * `|---|---|`, `| :--- | ---: |`, `--- | ---`. The line still has to contain **a pipe**, and that
 * is not decoration: `---` alone is a thematic break, which markdown-it renders as a horizontal
 * rule — so a validator that accepted it would accept a table that is not there, which is exactly
 * the claim the panel makes about the row.
 */
export function looksLikeMarkdownTable(text: string): boolean {
  return text.split("\n").some((line) => {
    const trimmed = line.trim();
    if (!trimmed.includes("|") || !trimmed.includes("-")) return false;
    // Every cell, once the outer pipes are gone, has to be dashes with optional alignment colons.
    const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|");
    return cells.length > 0 && cells.every((cell) => /^\s*:?-+:?\s*$/.test(cell));
  });
}

/** What the tool hands the saver. The name is already canonical. */
export interface TableSaveInput {
  /** Canonical row name — `季度对比`, slugified. */
  name: string;
  /** The model's one-line description; required on the tool and `NOT NULL` in the row. */
  summary: string;
  /** The markdown table itself. The row is the only copy. */
  content: string;
  /** The call that recorded it, or null when the invoke config carried no id. */
  toolCallId: string | null;
}

/**
 * Write, or revise in place.
 *
 * `registerDiagram`'s shape with the same note about the id: one is generated here because the
 * insert half needs one, and a revise's is discarded by the upsert's `ON CONFLICT` clause — which
 * is why the accessor reads back by `(session_id, name)` rather than returning what it was handed.
 */
export function registerTable(db: AppDb, sessionId: string, input: TableSaveInput): TableRecord {
  return db.upsertSessionTable({
    id: newId(),
    sessionId,
    name: input.name,
    summary: input.summary,
    content: input.content,
    toolCallId: input.toolCallId,
  });
}

/**
 * The owner-scoped list the API carries.
 *
 * Synchronous, and the asymmetry with `listDiagramViews` is the point rather than an oversight:
 * that one is `async` because each row's `fileMissing` is a `stat`, and there is no file here to
 * stat. If a table ever grows one, this becomes `async` and gains the flag.
 */
export function listTableViews(db: AppDb, userId: string, sessionId: string): Table[] {
  return db.listTablesForUser(userId, sessionId);
}
