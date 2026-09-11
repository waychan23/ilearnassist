import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { readParsedText } from "../documents/store.js";

/**
 * `read_document` — page through the text extracted from an attachment.
 *
 * This is the other half of the preview strategy in `buildUserContent`: a long document is
 * inlined as its first few thousand characters plus a pointer here, so the model can pull
 * the rest on demand instead of the whole file riding along in every turn's context.
 *
 * The tool is bound to a **whitelist of the current session's attachments**, not to the
 * uploads root. Attachment ids are guessable enough that a tool taking a bare id would let
 * a model wander into another session's uploads; the whitelist makes that unrepresentable.
 * It is the same discipline as validating `resolveStoredPath` before persisting an
 * attachment — the check lives where the data crosses the boundary.
 */

/** Enough for a chapter of prose; a second call is cheap, a giant result is not. */
const DEFAULT_READ_CHARS = 20_000;
const MAX_READ_CHARS = 40_000;

export interface DocumentToolEntry {
  id: string;
  name: string;
  mimeType: string;
}

export interface DocumentToolContext {
  uploadRoot: string;
  sessionId: string;
  /** Every attachment on this session. Anything else is refused. */
  attachments: DocumentToolEntry[];
  /** Per-call ceiling, from config. */
  maxChars?: number;
}

export function buildDocumentTool(ctx: DocumentToolContext) {
  const allowed = new Map(ctx.attachments.map((a) => [a.id, a]));
  const limit = Math.min(ctx.maxChars ?? MAX_READ_CHARS, MAX_READ_CHARS);

  const catalogue = ctx.attachments
    .map((a) => `"${a.id}" (${a.name})`)
    .join(", ");

  return tool(
    async ({ attachmentId, offset, limit: requested }) => {
      const entry = allowed.get(attachmentId);
      if (!entry) {
        return `No such attachment in this conversation. Available: ${catalogue || "(none)"}.`;
      }

      const text = await readParsedText(ctx.uploadRoot, ctx.sessionId, attachmentId);
      if (text === undefined) {
        return `附件「${entry.name}」没有可读文本（尚未解析，或解析失败）。`;
      }

      const start = Math.max(0, offset ?? 0);
      if (start >= text.length) {
        return `offset ${start} 超出范围；该文档共 ${text.length} 个字符。`;
      }

      const size = Math.min(Math.max(1, requested ?? DEFAULT_READ_CHARS), limit);
      const end = Math.min(start + size, text.length);
      const slice = text.slice(start, end);

      const footer =
        end < text.length
          ? `\n\n[... 已读取 ${start}–${end} / 共 ${text.length} 字符。继续读取请再次调用，offset=${end}。]`
          : `\n\n[... 已读取 ${start}–${end} / 共 ${text.length} 字符（已到末尾）。]`;

      return `附件「${entry.name}」第 ${start}–${end} 字符：\n\n${slice}${footer}`;
    },
    {
      name: "read_document",
      description:
        "Read the extracted text of a document the user attached to this conversation (PDF, Word, Excel, PowerPoint). " +
        "Long documents are only partly included in the prompt — use this tool to read the rest, " +
        "advancing with the `offset` it reports. Read a large stretch in several calls rather than asking for everything at once.",
      schema: z.object({
        attachmentId: z
          .string()
          .describe("Id of the attachment to read. Must be one attached to this conversation."),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Character offset to start from. Defaults to 0; use the value the previous call reported."),
        limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(`How many characters to return. Defaults to ${DEFAULT_READ_CHARS}, capped at ${limit}.`),
      }),
    }
  );
}
