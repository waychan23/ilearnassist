import { promises as fs } from "node:fs";
import { parsedFilePath } from "../resourcePaths.js";
import type { UserLayout } from "../paths.js";

/**
 * Extracted document text, one file per parse.
 *
 * ```
 * <userRoot>/sources/
 *   raw/<fileId>.<ext>      the bytes as they arrived
 *   parsed/<fileId>.txt     the extracted plain text
 * ```
 *
 * **Parse state is not here.** It lives on the `work_resources` row, which is where every reader
 * consults it, and the row's `parsed_file_id` is what points at the text this module holds. Two
 * conversations working from the same file therefore each have their own reference and *their own
 * parse* — the consequence the v4 model takes deliberately, stated in `schema.ts`.
 *
 * This module is only about the text, which is the one part too large for a column and which
 * `read_document` streams by offset.
 *
 * The two directories are siblings, which used to be *load-bearing*: `findStoredAttachment()`
 * located an attachment by globbing `<id>.*` inside the session directory, and `txt` is a
 * legitimate upload extension — so a flat `<id>.txt` could be found ahead of the original PDF
 * and the download endpoint would serve extracted text instead of the file. Nothing globs any
 * more, because the path is a column, so that particular collision is unreachable rather than
 * merely avoided. The split stays because raw bytes and derived text are different kinds of
 * thing and a reader should not have to check which it is holding.
 */

/**
 * Absolute path of one parse's text, or undefined for an id that cannot be trusted in a path.
 *
 * The id is the **file row's**, which is what `work_resources.parsed_file_id` names — so the
 * caller that has a reference resolves the file first and then asks here, exactly as it would for
 * any other file's bytes.
 */
export function parsedTextPath(user: UserLayout, fileId: string): string | undefined {
  try {
    return parsedFilePath(user, fileId);
  } catch {
    return undefined;
  }
}

/** Read only the first `maxChars` characters, without slurping a multi-MB file. */
export async function readParsedTextHead(
  user: UserLayout,
  fileId: string,
  maxChars: number
): Promise<string | undefined> {
  const path = parsedTextPath(user, fileId);
  if (!path) return undefined;

  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(path, "r");
    // A UTF-8 code point is at most 4 bytes, so this is a safe upper bound on the bytes
    // needed for `maxChars` characters. Trimming happens below.
    const buf = Buffer.alloc(maxChars * 4);
    const { bytesRead } = await handle.read(buf, 0, buf.byteLength, 0);
    if (bytesRead === 0) return "";
    const text = buf.subarray(0, bytesRead).toString("utf8");
    return text.length > maxChars ? text.slice(0, maxChars) : text;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readParsedText(
  user: UserLayout,
  fileId: string
): Promise<string | undefined> {
  const path = parsedTextPath(user, fileId);
  if (!path) return undefined;
  try {
    return await fs.readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

export async function writeParsedText(
  user: UserLayout,
  fileId: string,
  text: string
): Promise<void> {
  const path = parsedTextPath(user, fileId);
  if (!path) throw new Error("Invalid file id.");
  await fs.mkdir(user.parsedDir, { recursive: true });
  await fs.writeFile(path, text, "utf8");
}

/** Drop the extracted text, so a re-parse starts from nothing rather than from a stale read. */
export async function removeParsedText(user: UserLayout, fileId: string): Promise<void> {
  const path = parsedTextPath(user, fileId);
  if (!path) return;
  await fs.rm(path, { force: true }).catch(() => undefined);
}
