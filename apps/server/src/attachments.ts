import { promises as fs } from "node:fs";
import { join, relative, resolve as resolvePath, extname } from "node:path";
import type { Attachment } from "@ilearnassist/shared";
import { PROJECT_PATHS } from "./config.js";
import { isDocumentMime } from "./documents/formats.js";
import { readParseRecord, readParsedTextHead } from "./documents/store.js";

/** Root directory holding every session's uploaded bytes. */
export const UPLOADS_ROOT = join(PROJECT_PATHS.dataDir, "uploads");

/**
 * Uploaded attachments. Bytes live under `<dataDir>/uploads/<sessionId>/<attachmentId>.<ext>`,
 * deliberately outside the workspace so chat uploads never pollute the user's project
 * directory (or show up in the agent's `list_files`).
 *
 * The file extension is derived deterministically from the MIME type, so a later request
 * only needs the `Attachment` metadata (id + mimeType) to find the bytes again.
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

/** Per-file cap on how much inlined text is handed to the model. */
export const MAX_INLINE_CHARS = 20_000;

import { isSafeId } from "./ids.js";

export { isSafeId };

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

export function kindFor(mimeType: string): Attachment["kind"] {
  return mimeType.startsWith("image/") ? "image" : "file";
}

/** Text-like files get inlined into the prompt; binaries are only referenced by name. */
export function isTextLike(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/xml" ||
    mimeType === "application/javascript" ||
    mimeType === "application/typescript"
  );
}

/** Absolute path for a stored attachment. Throws if the ids are not safe. */
export function attachmentPath(uploadRoot: string, sessionId: string, att: Attachment): string {
  if (!isSafeId(sessionId) || !isSafeId(att.id)) {
    throw new Error("Invalid attachment id.");
  }
  const ext = MIME_EXT[att.mimeType];
  if (!ext) throw new Error(`Unsupported attachment type: ${att.mimeType}`);
  return join(uploadRoot, sessionId, `${att.id}.${ext}`);
}

/**
 * Resolve a stored attachment path, refusing anything that escapes the uploads root.
 * Mirrors the `resolveInWorkspace` guard used for file tools.
 */
export function resolveStoredPath(
  uploadRoot: string,
  sessionId: string,
  att: Attachment
): string | undefined {
  let candidate: string;
  try {
    candidate = attachmentPath(uploadRoot, sessionId, att);
  } catch {
    return undefined;
  }
  const root = resolvePath(uploadRoot);
  const full = resolvePath(candidate);
  const rel = relative(root, full);
  if (!rel || rel.startsWith("..") || resolvePath(root, rel) !== full) return undefined;
  return full;
}

export async function ensureSessionUploadDir(uploadRoot: string, sessionId: string): Promise<string> {
  if (!isSafeId(sessionId)) throw new Error("Invalid session id.");
  const dir = join(uploadRoot, sessionId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function readAsDataUrl(path: string, mimeType: string): Promise<string> {
  const buf = await fs.readFile(path);
  return `data:${mimeType};base64,${buf.toString("base64")}`;
}

/**
 * Locate a stored attachment by id, deriving the MIME type from the extension on disk.
 *
 * Deliberately does not trust a caller-supplied MIME type: the directory listing is the
 * authority, so nothing the client says can redirect the read outside `uploadRoot`.
 */
export async function findStoredAttachment(
  uploadRoot: string,
  sessionId: string,
  attachmentId: string
): Promise<{ path: string; mimeType: string } | undefined> {
  if (!isSafeId(sessionId) || !isSafeId(attachmentId)) return undefined;

  const dir = join(uploadRoot, sessionId);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return undefined;
  }

  const match = entries.find((name) => name.startsWith(`${attachmentId}.`));
  if (!match) return undefined;

  const mimeType = EXT_MIME[extname(match).slice(1).toLowerCase()];
  if (!mimeType) return undefined;

  const path = resolveStoredPath(uploadRoot, sessionId, {
    id: attachmentId,
    name: match,
    mimeType,
    size: 0,
    kind: kindFor(mimeType),
  });
  if (!path) return undefined;

  return { path, mimeType };
}

/** Delete a session's upload directory. Best-effort — a failure must not block deletion. */
export async function removeSessionUploads(uploadRoot: string, sessionId: string): Promise<void> {
  if (!isSafeId(sessionId)) return;
  await fs.rm(join(uploadRoot, sessionId), { recursive: true, force: true }).catch(() => undefined);
}

export type UserContentBlock =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/**
 * How much of a long parsed document is inlined before the model is told to read the rest
 * with the `read_document` tool. Keeping the preview short is what stops a 200-page PDF
 * from being resent in full on every turn of the conversation.
 */
export const PREVIEW_CHARS = 4_000;

export interface BuildContentOptions {
  uploadRoot: string;
  sessionId: string;
  /** When false, images are replaced by a text placeholder instead of being sent. */
  vision: boolean;
  /**
   * Whether the selected model can call tools. A model that cannot page through a
   * truncated document is told the content was omitted outright, rather than being
   * pointed at a tool it will never invoke.
   */
  toolUse?: boolean;
}

/**
 * Turn a user turn (text + attachments) into LangChain message content.
 *
 * - Images become `image_url` blocks so a vision model actually sees them; without
 *   vision support they degrade to a labelled placeholder rather than failing the run.
 * - Text-like files are inlined with a filename header.
 * - Documents (PDF, Office) are inlined from their extracted text, truncated to a preview
 *   once they get long — the model is told how to page through the rest with
 *   `read_document`. Anything still unparsed is named rather than silently dropped.
 *
 * Returns a plain string when there are no attachments, which keeps the common path
 * byte-identical to before.
 */
export async function buildUserContent(
  text: string,
  attachments: Attachment[] | undefined,
  opts: BuildContentOptions
): Promise<string | UserContentBlock[]> {
  if (!attachments || attachments.length === 0) return text;

  const blocks: UserContentBlock[] = [];
  if (text.trim()) blocks.push({ type: "text", text });

  for (const att of attachments) {
    const path = resolveStoredPath(opts.uploadRoot, opts.sessionId, att);

    if (att.kind === "image") {
      if (!opts.vision || !path) {
        blocks.push({
          type: "text",
          text: `[附件图片：${att.name}${opts.vision ? "（文件缺失）" : "（当前模型不支持图片输入，未能识别）"}]`,
        });
        continue;
      }
      try {
        blocks.push({ type: "image_url", image_url: { url: await readAsDataUrl(path, att.mimeType) } });
      } catch {
        blocks.push({ type: "text", text: `[附件图片：${att.name}（读取失败）]` });
      }
      continue;
    }

    if (isTextLike(att.mimeType) && path) {
      try {
        let body = await fs.readFile(path, "utf8");
        const truncated = body.length > MAX_INLINE_CHARS;
        if (truncated) body = body.slice(0, MAX_INLINE_CHARS);
        blocks.push({
          type: "text",
          text:
            `--- 附件：${att.name} ---\n${body}` +
            (truncated ? `\n[... 已在 ${MAX_INLINE_CHARS} 字符处截断]` : "") +
            `\n--- 附件结束 ---`,
        });
      } catch {
        blocks.push({ type: "text", text: `[附件：${att.name}（读取失败）]` });
      }
      continue;
    }

    if (isDocumentMime(att.mimeType)) {
      blocks.push({ type: "text", text: await documentBlock(att, opts) });
      continue;
    }

    // A binary we have no extractor for: name it so the model knows it exists.
    blocks.push({ type: "text", text: `[附件：${att.name}（${att.mimeType}，未解析内容）]` });
  }

  return blocks;
}

/**
 * The prompt representation of one parsed document.
 *
 * Long documents are inlined as a preview plus a pointer, never in full. `buildHistoryMessages`
 * re-runs this for every earlier turn, so inlining a whole book would put it in the context
 * window once per turn for the rest of the conversation — which is exactly the case the
 * `read_document` tool exists to avoid.
 */
async function documentBlock(att: Attachment, opts: BuildContentOptions): Promise<string> {
  const header = `--- 附件：${att.name} ---`;

  // Read one character past the threshold: the extra byte is what distinguishes "this is
  // the whole document" from "there is more", which a cap-sized read could never tell.
  const head = await readParsedTextHead(
    opts.uploadRoot,
    opts.sessionId,
    att.id,
    MAX_INLINE_CHARS + 1
  );
  if (head === undefined) {
    // No sidecar yet. Either extraction is still running, or it failed; the parse record
    // is what distinguishes them, and the user can see both states on the attachment chip.
    const record = await readParseRecord(opts.uploadRoot, opts.sessionId, att.id);
    if (record?.status === "failed") {
      return `[附件：${att.name}（解析失败：${record.error ?? "未知原因"}）]`;
    }
    if (record?.status === "pending" || record?.status === "parsing") {
      return `[附件：${att.name}（正在解析，内容暂不可用）]`;
    }
    return `[附件：${att.name}（${att.mimeType}，未解析内容）]`;
  }

  if (head.length <= MAX_INLINE_CHARS) {
    return `${header}\n${head}\n--- 附件结束 ---`;
  }

  const preview = head.slice(0, PREVIEW_CHARS);
  const pointer = opts.toolUse
    ? `[... 内容过长，此处仅为前 ${PREVIEW_CHARS} 字符。` +
      `请调用 read_document 工具读取剩余内容 —— attachmentId 为 "${att.id}"，` +
      `用 offset 参数分段读取。]`
    : `[... 内容过长，剩余部分已省略。]`;

  return `${header}\n${preview}\n${pointer}\n--- 附件结束 ---`;
}
