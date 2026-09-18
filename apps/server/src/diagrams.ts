import { stat } from "node:fs/promises";
import { join } from "node:path";
import { DIAGRAM_FILE_EXTENSIONS, type Diagram } from "@ilearnassist/shared";
import { newId, type AppDb, type DiagramRecord } from "./db.js";
import { slugify } from "./workspace.js";

/**
 * The rules for a diagram row that lives outside any one tool or route.
 *
 * The naming rule — `diagramFileName` — currently lives in `packages/shared` because the
 * client matches a tool call to the file it wrote (`utils/diagramAnchors.ts`); the day that
 * stops being needed it moves here, beside this function. What is here is the part only the
 * server can own: turning the tool's call into a row.
 */

/**
 * How long the model-written summary may be.
 *
 * Server-local rather than shared, deliberately: the shared size constants exist when *both*
 * sides enforce one (`MAX_DIAGRAM_CHARS` is refused by the tool and refused by the renderer).
 * The summary is enforced by the tool alone, and the viewer clamps it with CSS rather than a
 * character count.
 */
export const DIAGRAM_SUMMARY_MAX = 300;

/** What `ila_diagram` writes, and the one extension the tool will produce. */
export const DIAGRAM_EXTENSION = "mmd";

/**
 * The file a diagram with this name is written to, inside a conversation's own directory.
 *
 * **No uniqueness suffix.** The name *is* the identity: calling the tool again with the same
 * name overwrites the same file (and the upsert revises the same row), which is how a model
 * corrects a diagram it already drew. A suffix would turn a correction into
 * `auth-flow-1.mmd` and leave the wrong picture on screen beside the right one.
 */
export function diagramFileName(name: string): string {
  // A model that passes "auth-flow.mmd" means the same diagram as one that passes
  // "auth-flow"; slugifying the raw string would make `auth-flow-mmd.mmd` of it.
  let base = name.trim();
  for (const extension of DIAGRAM_FILE_EXTENSIONS) {
    const suffix = `.${extension}`;
    if (base.toLowerCase().endsWith(suffix)) {
      base = base.slice(0, -suffix.length);
      break;
    }
  }
  return `${slugify(base, "diagram")}.${DIAGRAM_EXTENSION}`;
}

/** What the tool hands the saver. The file name is already canonical — see the call site. */
export interface DiagramSaveInput {
  /** Canonical file name inside the conversation's folder — `auth-flow.mmd`. */
  name: string;
  /** The `.mmd` this row drew, as a file id. See `Diagram.fileId`. */
  fileId: string;
  /** The model's one-line description; required on the tool and `NOT NULL` in the row. */
  summary: string;
  /** The call that wrote it, or null when the invoke config carried no id. */
  toolCallId: string | null;
}

/**
 * Write, or revise in place.
 *
 * The id is generated here even though a revise's id is discarded by the upsert's
 * `ON CONFLICT` clause: `newId()` is cheap, and the insert half needs one. The row that comes
 * back is the one now in the table — the original id on a revise, which is why the accessor
 * reads back by `(session_id, name)` rather than returning the generated id.
 */
export function registerDiagram(
  db: AppDb,
  sessionId: string,
  input: DiagramSaveInput
): DiagramRecord {
  return db.upsertDiagram({
    id: newId(),
    sessionId,
    name: input.name,
    fileId: input.fileId,
    summary: input.summary,
    toolCallId: input.toolCallId,
  });
}

/** True when the file is on disk; any stat failure (missing, unreadable) counts as missing. */
async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The owner-scoped list the API carries, with each row's file checked on disk.
 *
 * `fileMissing` is computed here rather than in SQL because the answer is a `stat`, and any
 * stat error reads as missing: a row whose file is unreadable must not offer a button that
 * opens an error, the same choice the file browser makes for `ENOENT`. The call count is one
 * conversation's diagrams, and a stat is microseconds.
 */
export async function listDiagramViews(
  db: AppDb,
  userId: string,
  sessionId: string,
  sessionDirPath: string
): Promise<Diagram[]> {
  const rows = db.listDiagramsForUser(userId, sessionId);
  return Promise.all(
    rows.map(
      async (row): Promise<Diagram> => ({
        ...row,
        fileMissing: !(await fileExists(join(sessionDirPath, row.name))),
      })
    )
  );
}
