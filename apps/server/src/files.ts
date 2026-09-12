import { open, readdir, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  ApiErrorCode,
  DirectoryListing,
  FileContent,
  FileContentKind,
  FileEntry,
} from "@guided-learning/shared";
import { resolveInWorkspace } from "./workspace.js";

/**
 * The workspace's read side: what a directory holds, and what is in a file.
 *
 * This is the browser's counterpart to `tools/fileTools.ts`. The two are deliberately not
 * one module. `list_files` speaks to a model — capped at 200 entries, one level, no size,
 * shaped as a JSON string in a tool result — while this answers a UI that renders every
 * entry it is given and needs metadata to do it. Sharing the traversal would mean either a
 * tool that returns sizes it never uses or a listing that silently stops at a model's cap.
 *
 * `resolveInWorkspace` remains the boundary for both. It is *lexical*, though — it stops
 * `../../etc/passwd` and says nothing about a symlink inside the workspace pointing out of
 * it — so every read here is additionally checked against the workspace's real path. The
 * write tools keep their existing behaviour: changing what a *model* may reach is a product
 * decision, not something to slip in behind a file viewer.
 */

/** Entries returned for one directory. Past this a listing reports itself truncated. */
export const MAX_LIST_ENTRIES = 2_000;

/**
 * How much of a file is read to decide whether it is text, and then to send it.
 *
 * One constant for both, because the sniff and the payload want the same bytes: reading
 * more to classify than to serve would be work thrown away.
 */
export const MAX_PREVIEW_BYTES = 256 * 1024;

/**
 * Extensions known to be binary. Checked *before* reading, so the common large binary is
 * refused on its name alone rather than after pulling a quarter-megabyte off disk.
 *
 * It is a denylist on top of a content sniff rather than a complete answer: the sniff is
 * what decides an unfamiliar extension, and this exists so a `.png` never gets that far.
 */
const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tiff", "avif", "heic",
  "pdf", "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "tar",
  "docx", "xlsx", "pptx", "odt", "ods", "odp", "doc", "xls", "ppt",
  "mp3", "wav", "ogg", "flac", "m4a", "aac", "mp4", "mov", "avi", "mkv", "webm",
  "woff", "woff2", "ttf", "otf", "eot", "sqlite", "db", "wasm", "class", "jar", "exe",
]);

/** Markdown, which the client renders rather than showing as source. */
const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdx"]);

/**
 * A path or file the browser cannot serve.
 *
 * Carries the same `ApiErrorCode` the route puts in its envelope, so the mapping from
 * "what happened on disk" to "what the client is told" happens once, where the failure is
 * detected, rather than in a chain of try/catch in the route.
 */
export class FileAccessError extends Error {
  readonly code: ApiErrorCode;

  constructor(code: ApiErrorCode, message: string) {
    super(message);
    this.name = "FileAccessError";
    this.code = code;
  }
}

/**
 * Resolve a workspace-relative path, then prove it really is inside the workspace.
 *
 * Two steps, and the second is the one this module exists to add. `resolveInWorkspace`
 * settles the *string* — `..`, absolute paths, siblings whose name merely starts with the
 * workspace's — and `realpath` settles what the string points at, which is how a symlink to
 * `/etc/passwd` is caught. `realpath` also resolves the workspace root itself, so a root
 * that is reached through a symlink (a temp directory on macOS, say) compares equal instead
 * of failing every read.
 */
async function resolveReal(workspaceDir: string, userPath: string): Promise<string> {
  const sandboxed = resolveInWorkspace(workspaceDir, userPath, true);
  if (!sandboxed.ok || !sandboxed.path) {
    throw new FileAccessError("INVALID_FILE_PATH", sandboxed.error ?? "Invalid path.");
  }

  const [realRoot, realTarget] = await Promise.all([
    realpath(resolve(workspaceDir)).catch(() => resolve(workspaceDir)),
    realpath(sandboxed.path).catch(() => null),
  ]);

  // `null` means the path does not exist yet — a 404 rather than an escape attempt, and the
  // caller's `stat`/`readdir` would have said so anyway. Returning the lexical path keeps
  // this function's job to one question: did it escape?
  if (realTarget === null) return sandboxed.path;

  const rel = relative(realRoot, realTarget);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new FileAccessError(
      "INVALID_FILE_PATH",
      `Path "${userPath}" resolves outside the workspace.`
    );
  }
  return realTarget;
}

/**
 * `""` and `"."` both mean the workspace root.
 *
 * The two refusals are about what a query string can smuggle in. `?path=a&path=b` arrives as
 * an *array*, and a string operation on it would be a `TypeError` — a 500 for a malformed
 * request. A NUL byte reaches `fs` as `ERR_INVALID_ARG_VALUE`, which is again a 500, and it
 * is checked here rather than in the route so no future caller can forget it.
 */
function normalizeRel(relPath: string | string[] | undefined): string {
  if (relPath === undefined) return "";
  if (typeof relPath !== "string" || relPath.includes("\0")) {
    throw new FileAccessError("INVALID_FILE_PATH", "Invalid path.");
  }
  const trimmed = relPath.trim();
  if (trimmed === "" || trimmed === "." || trimmed === "./") return "";
  return trimmed;
}

/**
 * Turn a filesystem error into the client's vocabulary.
 *
 * Anything not named here is rethrown: an `EACCES` on a workspace the app owns is a real
 * server problem, and dressing it up as "file not found" would send someone looking for a
 * missing file instead of a broken permission.
 */
function asFileError(err: unknown, userPath: string): FileAccessError {
  if (err instanceof FileAccessError) return err;
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") {
    return new FileAccessError("FILE_NOT_FOUND", `"${userPath}" does not exist.`);
  }
  if (code === "ENOTDIR" || code === "EISDIR") {
    return new FileAccessError("NOT_A_DIRECTORY", `"${userPath}" is not a directory.`);
  }
  throw err;
}

/** The file's modified time as ISO, or null when the platform will not say. */
function isoOrNull(value: number | undefined): string | null {
  return typeof value === "number" ? new Date(value).toISOString() : null;
}

/**
 * List one directory level, directories first and then files, each alphabetically.
 *
 * One level and no recursion, which is what makes a workspace with a `node_modules` in it
 * cost one `readdir` rather than a walk of sixty thousand files.
 */
export async function listDirectory(
  workspaceDir: string,
  relPath?: string | string[]
): Promise<DirectoryListing> {
  const rel = normalizeRel(relPath);
  const abs = await resolveReal(workspaceDir, rel);

  // A directory that is itself a symlink out of the workspace is caught by `resolveReal`,
  // whose fallback for a missing path is the lexical one — so this `stat` is also what
  // turns "does not exist" into the 404 the caller expects.
  const info = await stat(abs).catch((err) => {
    throw asFileError(err, rel);
  });
  if (!info.isDirectory()) {
    throw new FileAccessError("NOT_A_DIRECTORY", `"${rel}" is not a directory.`);
  }

  const dirents = await readdir(abs, { withFileTypes: true }).catch((err) => {
    throw asFileError(err, rel);
  });

  const entries: FileEntry[] = [];
  for (const dirent of dirents) {
    const entryPath = rel ? `${rel}/${dirent.name}` : dirent.name;
    // `lstat` semantics for the type, so a broken symlink is listed rather than dropped:
    // an entry the tree silently omits is indistinguishable from one that was never there.
    const stats = await stat(join(abs, dirent.name)).catch(() => null);
    const isDir = stats ? stats.isDirectory() : dirent.isDirectory();
    entries.push({
      name: dirent.name,
      path: entryPath,
      type: isDir ? "dir" : "file",
      size: isDir || !stats ? null : stats.size,
      modifiedAt: isDir || !stats ? null : isoOrNull(stats.mtimeMs),
    });
  }

  entries.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1
  );

  return {
    path: rel,
    entries: entries.slice(0, MAX_LIST_ENTRIES),
    truncated: entries.length > MAX_LIST_ENTRIES,
  };
}

/**
 * Decide what can be done with a file's bytes.
 *
 * Extension first, content second. The name settles the two cases worth settling cheaply —
 * Markdown renders, and a known binary is refused without being read at all — and everything
 * else is decided by looking, which is what makes `Makefile`, `LICENSE` and `Dockerfile`
 * work despite having no extension to consult.
 */
function classify(ext: string, bytes: Buffer): FileContentKind {
  if (MARKDOWN_EXTENSIONS.has(ext)) return "markdown";
  if (BINARY_EXTENSIONS.has(ext)) return "unsupported";

  // A NUL byte is what text files do not contain, and it is the check that needs no
  // decoding: a UTF-16 file is full of them and is not something this can render either.
  if (bytes.includes(0)) return "unsupported";
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return "unsupported";
  }
  return "text";
}

/**
 * The first `MAX_PREVIEW_BYTES` of a file, and whether there was more.
 *
 * `open`+`read` rather than `readFile`, because the file being opened is exactly the one
 * most likely to be enormous: a 2 GB log is the canonical thing someone clicks to see the
 * top of, and `readFile` would pull all of it into a Buffer to hand back 256 KB. One byte
 * past the cap is what distinguishes "this is the whole file" from "there is more".
 */
async function readHead(
  absPath: string,
  rel: string
): Promise<{ bytes: Buffer; truncated: boolean }> {
  const handle = await open(absPath, "r").catch((err) => {
    throw asFileError(err, rel);
  });
  try {
    const buffer = Buffer.allocUnsafe(MAX_PREVIEW_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, MAX_PREVIEW_BYTES + 1, 0);
    const truncated = bytesRead > MAX_PREVIEW_BYTES;
    return {
      bytes: buffer.subarray(0, truncated ? MAX_PREVIEW_BYTES : bytesRead),
      truncated,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Read a file for preview: its metadata, and its text when there is text to send.
 *
 * Truncation is a first-class outcome rather than an error. A 2 GB log is exactly the file
 * someone opens to look at the top of, and refusing it would be less useful than showing the
 * first 256 KB and saying so.
 */
export async function readFileContent(
  workspaceDir: string,
  relPath?: string | string[]
): Promise<FileContent> {
  const rel = normalizeRel(relPath);
  if (!rel) {
    throw new FileAccessError("INVALID_FILE_PATH", "A file path is required.");
  }

  const abs = await resolveReal(workspaceDir, rel);
  const info = await stat(abs).catch((err) => {
    throw asFileError(err, rel);
  });
  if (info.isDirectory()) {
    throw new FileAccessError("NOT_A_FILE", `"${rel}" is a directory, not a file.`);
  }

  const name = rel.slice(rel.lastIndexOf("/") + 1);
  const base: Omit<FileContent, "kind" | "text" | "truncated"> = {
    path: rel,
    name,
    size: info.size,
    modifiedAt: new Date(info.mtimeMs).toISOString(),
  };

  const { bytes, truncated } = await readHead(abs, rel);
  const kind = classify(extname(name).slice(1).toLowerCase(), bytes);
  if (kind === "unsupported") {
    return { ...base, kind, text: null, truncated: false };
  }

  // A multi-byte character straddling the cap decodes to a replacement character rather
  // than throwing, which is what we want: the tail of a truncated preview is allowed to be
  // approximate, and the alternative is dropping the character before it too.
  return {
    ...base,
    kind,
    text: new TextDecoder("utf-8").decode(bytes),
    truncated,
  };
}
