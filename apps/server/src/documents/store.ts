import { promises as fs } from "node:fs";
import { join } from "node:path";
import { isSafeId } from "../ids.js";
import type { UserLayout } from "../paths.js";

/**
 * Extracted document text, one file per source.
 *
 * ```
 * <userRoot>/sources/
 *   raw/<sourceId>.<ext>      the uploaded bytes
 *   parsed/<sourceId>.txt     the extracted plain text
 * ```
 *
 * **Parse state is not here any more.** It lives in the `sources` row, which is where every
 * reader consults it — so a reparse is visible in every conversation at once rather than only
 * in the messages written after it, and a source uploaded once and referenced twice is parsed
 * once. This module is now only about the text, which is the one part too large for a column
 * and which `read_document` streams by offset.
 *
 * The two directories are siblings, which used to be *load-bearing*: `findStoredAttachment()`
 * located an attachment by globbing `<id>.*` inside the session directory, and `txt` is a
 * legitimate upload extension — so a flat `<id>.txt` could be found ahead of the original PDF
 * and the download endpoint would serve extracted text instead of the file. Nothing globs any
 * more, because the path is a column, so that particular collision is unreachable rather than
 * merely avoided. The split stays because raw bytes and derived text are different kinds of
 * thing and a reader should not have to check which it is holding.
 */

/** Absolute path of one source's extracted text, or undefined for an unsafe id. */
export function sourceParsedPath(user: UserLayout, sourceId: string): string | undefined {
  if (!isSafeId(sourceId)) return undefined;
  return join(user.parsedDir, `${sourceId}.txt`);
}

/** Read only the first `maxChars` characters, without slurping a multi-MB file. */
export async function readParsedTextHead(
  user: UserLayout,
  sourceId: string,
  maxChars: number
): Promise<string | undefined> {
  const path = sourceParsedPath(user, sourceId);
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
  sourceId: string
): Promise<string | undefined> {
  const path = sourceParsedPath(user, sourceId);
  if (!path) return undefined;
  try {
    return await fs.readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

export async function writeParsedText(
  user: UserLayout,
  sourceId: string,
  text: string
): Promise<void> {
  const path = sourceParsedPath(user, sourceId);
  if (!path) throw new Error("Invalid source id.");
  await fs.mkdir(user.parsedDir, { recursive: true });
  await fs.writeFile(path, text, "utf8");
}

/** Drop the extracted text, so a re-parse starts from nothing rather than from a stale read. */
export async function removeParsedText(user: UserLayout, sourceId: string): Promise<void> {
  const path = sourceParsedPath(user, sourceId);
  if (!path) return;
  await fs.rm(path, { force: true }).catch(() => undefined);
}
