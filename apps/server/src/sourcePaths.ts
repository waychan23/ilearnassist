import { extname, join } from "node:path";
import type { SourceRecord } from "./db.js";
import { sessionDir, workspaceTrashDir, workspaceWorkdir } from "./paths.js";
import type { UserLayout } from "./paths.js";
import { resolveInWorkspace } from "./workspace.js";
import { isSafeId } from "./ids.js";

/**
 * Where a source's bytes are. The one module that answers it, for every kind of source.
 *
 * A source used to have exactly one home — `<user>/sources/raw/<id>.<ext>` — and this
 * question was one expression in `attachments.ts`. A source is now one record for material
 * that lives in five places, so the question has five answers and the thing that must not
 * happen is two of them drifting: an upload resolved one way by the chat route and another by
 * the source route is a file that reads in one place and is missing in another.
 *
 * The **MIME vocabulary** lives here too — which types may be uploaded, and which extension
 * each is stored under — because it is the other half of the same answer. A blob has no stored
 * path: its filename *is* the id and an extension that table decides, so the table and the
 * derivation cannot be in two modules without one of them becoming a stale copy.
 *
 * **Re-validated on every read, exactly as `resolveInSources` was.** A row travels through
 * backups and exports, and any future bug that let a request write one column would otherwise
 * turn a stored path into an arbitrary file read. A database row is not a trust boundary.
 *
 * **Lexical only, and deliberately unchanged in that respect.** `resolveInWorkspace` stops
 * `..` and absolute paths and says nothing about a symlink pointing out of the tree — which is
 * the right strictness for the *agent's* tools (the model has no tool that makes a symlink, so
 * one can only be there because the user put it there). The file *browser* adds a `realpath`
 * pass on top, and this module does not, for the same reason: the browser's route is where a
 * single click can follow a link, so that is where the stricter check belongs. A source
 * reached by id from the file browser goes through `files.ts`; one read for the model goes
 * through here.
 */

/** Accepted MIME types → the extension used on disk. */
const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "text/html": "html",
  "text/css": "css",
  "text/xml": "xml",
  "application/xml": "xml",
  "application/json": "json",
  "application/javascript": "js",
  "application/typescript": "ts",
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
};

/** Filename extension → MIME type, used when the browser reports nothing useful. */
const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  xml: "text/xml",
  json: "application/json",
  js: "application/javascript",
  ts: "application/typescript",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
};

/**
 * Pick the MIME type to trust: the browser's value when we support it, otherwise the
 * one implied by the filename extension. Returns undefined for unsupported files.
 */
export function normalizeMime(name: string, mimeType: string | undefined): string | undefined {
  if (mimeType && MIME_EXT[mimeType]) return mimeType;
  const ext = extname(name).slice(1).toLowerCase();
  return EXT_MIME[ext];
}

export function isSupportedMime(mimeType: string | undefined): mimeType is string {
  return !!mimeType && mimeType in MIME_EXT;
}

/**
 * Absolute path for an uploaded source's bytes. Throws if the id or the MIME type is unusable.
 *
 * **The** expression for where a blob lives, and the reason `sources.rel_path` is NULL for one:
 * the filename is the id plus an extension the MIME table already knows, so storing it would be
 * storing an answer twice.
 */
export function sourceRawPath(user: UserLayout, sourceId: string, mimeType: string): string {
  if (!isSafeId(sourceId)) throw new Error("Invalid source id.");
  const ext = MIME_EXT[mimeType];
  if (!ext) throw new Error(`Unsupported source type: ${mimeType}`);
  return join(user.rawDir, `${sourceId}.${ext}`);
}

/**
 * The same expression for a captured page.
 *
 * A sibling directory rather than a corner of `raw/`: these bytes came off the network rather
 * than from the user's disk, and the two are worth being able to tell apart with `ls`. A page
 * whose type is outside the table cannot be stored at all, which is why the capture tool
 * normalises to `text/html` — see `docs/sources.md`.
 */
export function sourceWebPath(user: UserLayout, sourceId: string, mimeType: string): string {
  if (!isSafeId(sourceId)) throw new Error("Invalid source id.");
  const ext = MIME_EXT[mimeType];
  if (!ext) throw new Error(`Unsupported source type: ${mimeType}`);
  return join(user.webDir, `${sourceId}.${ext}`);
}

/**
 * The root a `workspace` or `session` source's path is relative to.
 *
 * `trash` is a root of its own rather than a corner of `workdir/`, and it is namespaced by
 * source id so that two files deleted from different directories can each keep their original
 * `rel_path` and a future restore has somewhere to put them back.
 */
function rootFor(source: SourceRecord, workspaceRoot: string): string | undefined {
  switch (source.storage) {
    case "workspace":
      return workspaceWorkdir(workspaceRoot);
    case "session":
      // `ownerId` is the conversation, and its directory is named by its id.
      return isSafeId(source.ownerId) ? sessionDir(workspaceRoot, source.ownerId) : undefined;
    case "trash":
      return isSafeId(source.id) ? join(workspaceTrashDir(workspaceRoot), source.id) : undefined;
    default:
      return undefined;
  }
}

/**
 * A source's bytes, or `undefined` when the row cannot be trusted to name a place.
 *
 * `undefined` is not "no such source" — the caller has the row — it is "this row's answer is
 * unusable", and every caller degrades the same way it does for a file that is simply gone:
 * the model is told the attachment is missing rather than being handed a path.
 *
 * The `switch` is exhaustive over `SourceStorage` with a `never` arm, so a sixth storage is a
 * compile error rather than a silent fallthrough. That is the `FileContent.kind` lesson: a new
 * member is only a compile error once a site says so, and this is the site.
 */
export function resolveSourceBytes(
  user: UserLayout,
  source: SourceRecord,
  workspaceRoot: string
): string | undefined {
  switch (source.storage) {
    // The two blob roots store no path: the filename is `<id>.<ext>`, derived from the id and
    // the MIME type. A MIME type outside the table is unusable rather than fatal — an upload
    // whose type this build no longer knows reads as missing, which is what `buildUserContent`
    // has always done with it.
    case "upload":
    case "web": {
      const derive = source.storage === "upload" ? sourceRawPath : sourceWebPath;
      try {
        return derive(user, source.id, source.mimeType);
      } catch {
        return undefined;
      }
    }
    case "workspace":
    case "session":
    case "trash": {
      const root = rootFor(source, workspaceRoot);
      if (!root || !source.relPath) return undefined;
      const resolved = resolveInWorkspace(root, source.relPath, true);
      return resolved.ok && resolved.path ? resolved.path : undefined;
    }
    default: {
      const unhandled: never = source.storage;
      void unhandled;
      return undefined;
    }
  }
}

/**
 * A source's extracted text, when it has any.
 *
 * One tree for every storage, which is the point of it being derived rather than stored: a
 * PDF uploaded last week and a PDF the agent wrote into a workspace put their text in the same
 * place, so `read_document` has one lookup and no branch per origin.
 *
 * The parse state on the row is what says whether anything is there at all — this only says
 * *where it would be*, and a caller that reads it must handle the file being absent, exactly
 * as `readParsedTextHead` does.
 */
export function resolveSourceParsed(user: UserLayout, source: SourceRecord): string | undefined {
  if (!isSafeId(source.id)) return undefined;
  return join(user.parsedDir, `${source.id}.txt`);
}

/**
 * Whether a source needs a parse before a model can read it.
 *
 * Text and code are inlined verbatim; a diagram is a picture of text; a page arrives already
 * extracted. Everything else — a PDF, an image, an archive nobody can open — is either parsed
 * or named. This is a *policy* answer that sits here beside the resolver because it is the
 * other half of "can the model read this", and the two must agree about what a blob is.
 */
export function needsParse(source: SourceRecord): boolean {
  return source.category === "document" || source.category === "image";
}
