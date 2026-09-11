import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { ParseStatus } from "@guided-learning/shared";
import { isSafeId } from "../ids.js";

/**
 * Extracted document text and its parse state, kept beside the uploaded bytes:
 *
 * ```
 * <uploadsRoot>/<sessionId>/
 *   <attachmentId>.pdf          the original bytes
 *   parsed/
 *     <attachmentId>.txt        extracted plain text
 *     <attachmentId>.json       { status, error?, parserId?, parsedChars?, pageCount? }
 * ```
 *
 * **The `parsed/` subdirectory is load-bearing.** `findStoredAttachment()` locates an
 * attachment with `entries.find(name => name.startsWith(id + "."))`, and `txt` is a
 * legitimate extension in `EXT_MIME` — so a sibling `<id>.txt` could be picked ahead of
 * `<id>.pdf` and the download endpoint would serve extracted text instead of the original
 * file. Keeping derived data in its own directory makes that collision impossible.
 *
 * State lives on disk rather than in sqlite because the uploads tree is already the
 * authority for attachment bytes and MIME types (derived by directory listing), and
 * because `removeSessionUploads()` deletes the whole session directory — so a session
 * delete cleans up parse state for free, with no migration and no cascade to maintain.
 */

/** State of one attachment's extraction. Mirrors the client-facing `Attachment` fields. */
export interface ParseRecord {
  status: ParseStatus;
  /** A message aimed at the user. Never contains a credential. */
  error?: string;
  /** `"local"`, or the id of the document parser record that produced the text. */
  parserId?: string;
  parsedChars?: number;
  pageCount?: number;
  updatedAt: string;
}

/** Absolute path of the derived-data directory, or undefined for an unsafe id. */
export function parsedDir(uploadRoot: string, sessionId: string): string | undefined {
  if (!isSafeId(sessionId)) return undefined;
  return join(uploadRoot, sessionId, "parsed");
}

function parsedPaths(
  uploadRoot: string,
  sessionId: string,
  attachmentId: string
): { dir: string; text: string; meta: string } | undefined {
  const dir = parsedDir(uploadRoot, sessionId);
  if (!dir || !isSafeId(attachmentId)) return undefined;
  return { dir, text: join(dir, `${attachmentId}.txt`), meta: join(dir, `${attachmentId}.json`) };
}

/** Read only the first `maxChars` characters, without slurping a multi-MB file. */
export async function readParsedTextHead(
  uploadRoot: string,
  sessionId: string,
  attachmentId: string,
  maxChars: number
): Promise<string | undefined> {
  const paths = parsedPaths(uploadRoot, sessionId, attachmentId);
  if (!paths) return undefined;

  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(paths.text, "r");
    // A UTF-8 code point is at most 4 bytes, so this is a safe upper bound on bytes
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
  uploadRoot: string,
  sessionId: string,
  attachmentId: string
): Promise<string | undefined> {
  const paths = parsedPaths(uploadRoot, sessionId, attachmentId);
  if (!paths) return undefined;
  try {
    return await fs.readFile(paths.text, "utf8");
  } catch {
    return undefined;
  }
}

export async function writeParsedText(
  uploadRoot: string,
  sessionId: string,
  attachmentId: string,
  text: string
): Promise<void> {
  const paths = parsedPaths(uploadRoot, sessionId, attachmentId);
  if (!paths) throw new Error("Invalid attachment id.");
  await fs.mkdir(paths.dir, { recursive: true });
  await fs.writeFile(paths.text, text, "utf8");
}

export async function readParseRecord(
  uploadRoot: string,
  sessionId: string,
  attachmentId: string
): Promise<ParseRecord | undefined> {
  const paths = parsedPaths(uploadRoot, sessionId, attachmentId);
  if (!paths) return undefined;
  try {
    const raw = await fs.readFile(paths.meta, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    return parsed as ParseRecord;
  } catch {
    return undefined;
  }
}

export async function writeParseRecord(
  uploadRoot: string,
  sessionId: string,
  attachmentId: string,
  record: Omit<ParseRecord, "updatedAt">
): Promise<void> {
  const paths = parsedPaths(uploadRoot, sessionId, attachmentId);
  if (!paths) throw new Error("Invalid attachment id.");
  await fs.mkdir(paths.dir, { recursive: true });
  const full: ParseRecord = { ...record, updatedAt: new Date().toISOString() };
  await fs.writeFile(paths.meta, JSON.stringify(full), "utf8");
}

/** Every parse record for a session, keyed by attachment id. Missing dir → empty map. */
export async function listParseRecords(
  uploadRoot: string,
  sessionId: string
): Promise<Map<string, ParseRecord>> {
  const out = new Map<string, ParseRecord>();
  const dir = parsedDir(uploadRoot, sessionId);
  if (!dir) return out;

  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const id = entry.slice(0, -".json".length);
    const record = await readParseRecord(uploadRoot, sessionId, id);
    if (record) out.set(id, record);
  }
  return out;
}

/** Drop derived data for one attachment, so a re-parse starts clean. */
export async function removeParsed(
  uploadRoot: string,
  sessionId: string,
  attachmentId: string
): Promise<void> {
  const paths = parsedPaths(uploadRoot, sessionId, attachmentId);
  if (!paths) return;
  await Promise.all([
    fs.rm(paths.text, { force: true }).catch(() => undefined),
    fs.rm(paths.meta, { force: true }).catch(() => undefined),
  ]);
}
