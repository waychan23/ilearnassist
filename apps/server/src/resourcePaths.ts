import { extname, join, relative, sep } from "node:path";
import type { FileCategory } from "@ilearnassist/shared";
import { isSafeId } from "./ids.js";
import type { UserLayout } from "./paths.js";
import { resolveInWorkspace } from "./workspace.js";

/**
 * Where a file's bytes are, and where a parse result goes. The one module that answers it.
 *
 * A v3 source resolved its bytes **through its owner**: `storage` picked a root and `rel_path`
 * said where in it, and finding the root meant looking up the owning workspace or session. That
 * worked only while a row had exactly one owner. A v4 `files` row is owned by the *account* and
 * may be referenced from several workspaces at once, so there is no owner to ask — the row
 * carries its whole locator, `files.path`, relative to one user's root, and this module is what
 * turns it back into a path.
 *
 * Three things are load-bearing:
 *
 * - **Relative to `<userRoot>`, never absolute.** The v3 argument survives verbatim: an absolute
 *   path is the one stored fact that silently breaks when a data root is copied or moved. What
 *   changed is only that the relative path is now *stored* rather than derived from an owner.
 * - **Re-validated on every read.** A row travels through backups and exports, and any future bug
 *   that let a request write one column would otherwise turn a stored path into an arbitrary file
 *   read. A database row is not a trust boundary.
 * - **Blob paths are derived at write time and stored anyway.** An upload's filename is still
 *   `<id>.<ext>` from the MIME table — but it is written *into the row* rather than recomputed on
 *   read, because the bytes are where they are and the MIME type of a row can be corrected later.
 *   The helpers below are therefore write-time only; a reader uses `resolveFilePath`, and
 *   `attachments.ts` no longer keeps a derive-it-if-absent fallback.
 *
 * **Lexical only, and deliberately.** `resolveInWorkspace` stops `..` and absolute paths and says
 * nothing about a symlink pointing out of the tree — the right strictness for the *agent's* tools,
 * since the model has no tool that makes a symlink, so one can only be there because the user put
 * it there. The file *browser* adds a `realpath` pass on top in `files.ts`, because a single click
 * is what follows a link. That asymmetry is a product decision, not an oversight — see CLAUDE.md.
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

/** The extension a MIME type is stored under, or `undefined` when it is not one we accept. */
function extFor(mimeType: string): string | undefined {
  return MIME_EXT[mimeType];
}

/**
 * The absolute path an uploaded file's bytes go to. **Write-time only** — store the result's
 * relative form on the row; do not derive it again on read.
 */
export function rawFilePath(user: UserLayout, fileId: string, mimeType: string): string {
  if (!isSafeId(fileId)) throw new Error("Invalid file id.");
  const ext = extFor(mimeType);
  if (!ext) throw new Error(`Unsupported file type: ${mimeType}`);
  return join(user.rawDir, `${fileId}.${ext}`);
}

/**
 * The same expression for a captured page's raw bytes.
 *
 * A sibling directory rather than a corner of `raw/`: these bytes came off the network rather
 * than from the user's disk, and the two are worth being able to tell apart with `ls`.
 */
export function webFilePath(user: UserLayout, fileId: string, mimeType: string): string {
  if (!isSafeId(fileId)) throw new Error("Invalid file id.");
  const ext = extFor(mimeType);
  if (!ext) throw new Error(`Unsupported file type: ${mimeType}`);
  return join(user.webDir, `${fileId}.${ext}`);
}

/**
 * Where a parse result is written. **Write-time only**, like the two above; the row's
 * `parsed_file_id` is what a reader follows.
 *
 * Keyed by the **work resource** rather than by the entity, which is the consequence the schema
 * states: two references to one file each parse it and each get their own text.
 */
export function parsedFilePath(user: UserLayout, workResourceId: string): string {
  if (!isSafeId(workResourceId)) throw new Error("Invalid resource id.");
  return join(user.parsedDir, `${workResourceId}.txt`);
}

/**
 * The absolute path of anything inside one user's tree, as a **stored** value.
 *
 * One conversion for every storage, because the alternative is a second table of path segments
 * that can drift from `paths.ts`'s — and the drift would be a file listed at one path and read
 * at another. Forward slashes, so a database written on one platform reads on another; the
 * resolver splits them back out.
 */
export function storePath(user: UserLayout, absolutePath: string): string {
  return relative(user.userRoot, absolutePath).split(sep).join("/");
}

/**
 * A file's bytes, or `undefined` when the row cannot be trusted to name a place.
 *
 * `undefined` is not "no such file" — the caller has the row — it is "this row's answer is
 * unusable", and every caller degrades the way it does for a file that is simply gone: the model
 * is told the attachment is missing rather than being handed a path.
 *
 * Refuses an **empty** path as well as an escaping one, which `resolveInWorkspace` does for free
 * with `allowRoot = false`: an empty string resolves to the user root itself, and a live row
 * naming a directory is not a file.
 */
export function resolveFilePath(
  user: UserLayout,
  file: { path: string }
): string | undefined {
  if (!file.path) return undefined;
  const resolved = resolveInWorkspace(user.userRoot, file.path.split("/").join(sep), false);
  return resolved.ok && resolved.path ? resolved.path : undefined;
}

/**
 * Where a file's extracted text is, following the row's own pointer.
 *
 * The parse state on the reference is what says whether anything is there; this only says *where
 * it would be*, and a caller that reads it must handle the file being absent, exactly as
 * `readParsedTextHead` does.
 */
export function resolveParsedFile(
  user: UserLayout,
  resource: { parsedFileId?: string; parseStatus: string }
): string | undefined {
  if (resource.parseStatus === "none" || !resource.parsedFileId) return undefined;
  if (!isSafeId(resource.parsedFileId)) return undefined;
  return join(user.parsedDir, `${resource.parsedFileId}.txt`);
}

/**
 * Whether a file needs a parse before a model can read it.
 *
 * Text and code are inlined verbatim; a diagram is a picture of text; a page arrives already
 * extracted. Everything else — a PDF, an image, an archive nobody can open — is either parsed or
 * named. This is a *policy* answer that sits here beside the resolver because it is the other half
 * of "can the model read this", and the two must agree about what a blob is.
 */
export function needsParse(file: { category: FileCategory }): boolean {
  return file.category === "document" || file.category === "image";
}
