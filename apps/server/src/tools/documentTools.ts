import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { readParsedText } from "../documents/store.js";
import type { UserLayout } from "../paths.js";

/**
 * `read_document` — page through the text extracted from a document the user uploaded.
 *
 * This is the other half of the preview strategy in `buildUserContent`: a long document is
 * inlined as its first few thousand characters plus a pointer here, so the model can pull
 * the rest on demand instead of the whole file riding along in every turn's context.
 *
 * The tool is bound to a **whitelist resolved per turn**, never to an id a model supplied on
 * its own. Ids are guessable enough that a tool taking a bare one would let a model wander
 * into another conversation's uploads; the whitelist makes that unrepresentable rather than
 * merely forbidden, and the lookup fails before any path is touched.
 *
 * The whitelist is a conversation's sources **plus its workspace's** — see
 * `AppDb.listReadableSources`. That is wider than it used to be (this turn's attachments
 * only), and deliberately: a model shown a 200-page PDF in turn one could not previously page
 * through it in turn three, which is the whole point of the tool. A workspace is already a
 * shared sandbox — every conversation in it can `read_file` the same tree — so a document
 * there is not more privileged than a file there. Documents therefore cross a boundary that
 * files do not, and that asymmetry is a decision: a source belongs to the *account* and is
 * *referenced* by a workspace, rather than living inside it.
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
  /** Whose sources tree to read from. Derived per request, never held. */
  user: UserLayout;
  /** Everything readable in this conversation. Anything else is refused. */
  sources: DocumentToolEntry[];
  /** Per-call ceiling, from config. */
  maxChars?: number;
}

export function buildDocumentTool(ctx: DocumentToolContext) {
  const allowed = new Map(ctx.sources.map((s) => [s.id, s]));
  const limit = Math.min(ctx.maxChars ?? MAX_READ_CHARS, MAX_READ_CHARS);

  const catalogue = ctx.sources.map((s) => `"${s.id}" (${s.name})`).join(", ");

  return tool(
    async ({ sourceId, offset, limit: requested }) => {
      const entry = allowed.get(sourceId);
      if (!entry) {
        return `No such document here. Available: ${catalogue || "(none)"}.`;
      }

      const text = await readParsedText(ctx.user, sourceId);
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
        "Read the extracted text of a document the user has uploaded to this conversation or to the workspace it is in " +
        "(PDF, Word, Excel, PowerPoint). Long documents are only partly included in the prompt — use this tool to read " +
        "the rest, advancing with the `offset` it reports. The ids this accepts are the ones named in the prompt or in a " +
        "previous call's report; there is no way to look up others. Read a large stretch in several calls rather than " +
        "asking for everything at once.",
      schema: z.object({
        sourceId: z
          .string()
          .describe("Id of the document to read. Must be one uploaded to this conversation or its workspace."),
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
