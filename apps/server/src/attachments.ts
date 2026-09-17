import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join, extname } from "node:path";
import type { Attachment } from "@ilearnassist/shared";
import { isDocumentMime } from "./documents/formats.js";
import { readParsedTextHead } from "./documents/store.js";
import { sourceRawPath } from "./sourcePaths.js";
import { renderReferenceBlock, type ResolvedReference } from "./turnReferences.js";
import type { UserLayout } from "./paths.js";

/**
 * Uploaded files. Bytes live at `<userRoot>/sources/raw/<sourceId>.<ext>`, extracted text
 * beside them in `parsed/` — under the account that uploaded them rather than under the
 * conversation they arrived in, because a file can be referenced by several conversations and
 * is stored once.
 *
 * The extension is derived deterministically from the MIME type, so the `sources` row's
 * `raw_path` and this module compute the same location from the same two facts. The row is
 * the authority for *which* file a message referred to; this module is the authority for
 * where that file is.
 *
 * There is no root constant here, and that is the point: the tree belongs to a user under a
 * data directory the process chose at launch, so every function takes the layout. A
 * module-scope default would have to invent one.
 */

/** Per-file cap on how much inlined text is handed to the model. */
export const MAX_INLINE_CHARS = 20_000;

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

/**
 * Content hash, hex. The dedupe key: identical bytes uploaded twice are one source.
 *
 * Over the bytes rather than the name, because the name is the user's and two people (or one
 * person twice) call the same file different things. Hashed on upload, which is the one
 * moment the whole file is already in memory.
 */
export function sha256Of(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function readAsDataUrl(path: string, mimeType: string): Promise<string> {
  const buf = await fs.readFile(path);
  return `data:${mimeType};base64,${buf.toString("base64")}`;
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
  /** Whose sources tree to read from. Derived per request, never held. */
  user: UserLayout;
  /**
   * Where each attachment's bytes actually are, by id — for the ones that are not uploads.
   *
   * An attachment is a snapshot, and the snapshot was enough while a source was always an
   * upload: its bytes are at `<id>.<ext>`, an expression this module can compute from the id
   * and the MIME type alone. A file the agent wrote into a sandbox has no such path — its
   * location is `storage` + `relPath` on a row — so the caller resolves those and hands them
   * over. Absent, the derivation below is exactly what this module has always done.
   *
   * Paths rather than rows, because resolving one needs the workspace it lives in, and a turn
   * may reference sources held by several: the caller is the side that knows, per row, and this
   * module stays the side that knows what to *do* with a file once it has a path.
   */
  sourcePaths?: ReadonlyMap<string, string>;
  /** When false, images are replaced by a text placeholder instead of being sent. */
  vision: boolean;
  /**
   * Whether the selected model can call tools. A model that cannot page through a
   * truncated document is told the content was omitted outright, rather than being
   * pointed at a tool it will never invoke.
   */
  toolUse?: boolean;
  /**
   * What this turn's message pointed at — the 追问 chips, already resolved.
   *
   * Rendered *into the text* rather than sent as blocks of its own, because that is where it
   * belongs: the block reads as the user's own words about what they are asking about, and it
   * sits above the question exactly as a quoted passage does in the market-standard shape. See
   * `turnReferences.ts` for why a passage is copied and a figure is only named.
   */
  references?: readonly ResolvedReference[];
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
 * - References are prepended to the text, so a message that points at a diagram asks its
 *   question *after* saying what it is about.
 *
 * Returns a plain string when there are no attachments, which keeps the common path
 * byte-identical to before.
 */
export async function buildUserContent(
  text: string,
  attachments: Attachment[] | undefined,
  opts: BuildContentOptions
): Promise<string | UserContentBlock[]> {
  const referenceBlock = renderReferenceBlock(opts.references ?? []);
  // Above the question, and joined rather than a block of its own: to the model this is the user
  // talking about what they are asking about, and a separate block would read as a second turn.
  const body = referenceBlock
    ? text.trim()
      ? `${referenceBlock}\n\n${text}`
      : referenceBlock
    : text;

  if (!attachments || attachments.length === 0) return body;

  const blocks: UserContentBlock[] = [];
  if (body.trim()) blocks.push({ type: "text", text: body });

  for (const att of attachments) {
    /*
     * Where the bytes are, asked of the row when the caller has one and derived from the id
     * and the MIME type when it does not.
     *
     * The derivation is the upload case and stays first only in the sense of being the
     * fallback: a source whose row is in the map may live in either sandbox, and asking the
     * row is the only way to know. Both answers are re-checked against a root before use —
     * `resolveSourceBytes` for a row, and `sourceRawPath`'s own table for a derivation — so
     * neither is a path this module trusts from the wire.
     */
    let path = opts.sourcePaths?.get(att.id);
    if (path === undefined) {
      try {
        path = sourceRawPath(opts.user, att.id, att.mimeType);
      } catch {
        path = undefined;
      }
    }

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
 *
 * The parse state comes off the attachment — a snapshot taken from the source's row when the
 * message was written — so this needs no database either. A file still being parsed reads as
 * such for that message even after the parse finishes, which is what a message *should* say:
 * it describes the turn that was had, not the state of the world now.
 */
async function documentBlock(att: Attachment, opts: BuildContentOptions): Promise<string> {
  const header = `--- 附件：${att.name} ---`;

  // Read one character past the threshold: the extra character is what distinguishes "this
  // is the whole document" from "there is more", which a cap-sized read could never tell.
  const head = await readParsedTextHead(opts.user, att.id, MAX_INLINE_CHARS + 1);
  if (head === undefined) {
    if (att.parseStatus === "failed") {
      return `[附件：${att.name}（解析失败：${att.parseError ?? "未知原因"}）]`;
    }
    if (att.parseStatus === "pending" || att.parseStatus === "parsing") {
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
      `请调用 read_document 工具读取剩余内容 —— sourceId 为 "${att.id}"，` +
      `用 offset 参数分段读取。]`
    : `[... 内容过长，剩余部分已省略。]`;

  return `${header}\n${preview}\n${pointer}\n--- 附件结束 ---`;
}
