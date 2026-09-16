import { readFile } from "node:fs/promises";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { readParsedText } from "../documents/store.js";
import type { AppDb } from "../db.js";
import type { UserLayout } from "../paths.js";
import { sourceBytesOf } from "../sources.js";
import { needsParse } from "../sourcePaths.js";

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
 *
 * It is wider again when the user has `@`-referenced other workspaces, because the whitelist is
 * what the grant widens. Nothing here changes for that: the `Map` is still the gate, and an id
 * that is not in it is still refused before a path is touched. What the grant changes is only
 * which ids are in it.
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
  db: AppDb;
  /** The account that holds the sources, for the owner-scoped lookup the byte fallback needs. */
  userId: string;
  /** Whose sources tree to read from. Derived per request, never held. */
  user: UserLayout;
  /** Everything readable in this conversation. Anything else is refused. */
  sources: DocumentToolEntry[];
  /** Per-call ceiling, from config. */
  maxChars?: number;
}

/**
 * How many names the "no such document" reply lists before it stops.
 *
 * A whitelist is bounded by the conversation and its workspace today, and by **the account**
 * once the conversation holds an `@所有工作区` grant, so this string is built on the miss path
 * only and never on a turn that does not miss. 50 is enough to recognise what is there; the
 * ids, which are what a caller actually needs, are what `ila_query kind: "source"` is for.
 */
const CATALOGUE_MAX = 50;

export function buildDocumentTool(ctx: DocumentToolContext) {
  const allowed = new Map(ctx.sources.map((s) => [s.id, s]));
  const limit = Math.min(ctx.maxChars ?? MAX_READ_CHARS, MAX_READ_CHARS);

  /**
   * Built when it is asked for, and capped.
   *
   * This used to be an eager `.map().join()` at construction — one string per source, on every
   * turn, for a sentence only ever read when a lookup *fails*. That was affordable while the
   * whitelist was one conversation plus one workspace; a grant can make it the whole account,
   * and a per-turn cost proportional to everything the account has ever linked is not.
   */
  const catalogue = (): string => {
    const names = ctx.sources
      .slice(0, CATALOGUE_MAX)
      .map((s) => `"${s.id}" (${s.name})`);
    const rest = ctx.sources.length - names.length;
    return names.join(", ") + (rest > 0 ? `, … ${rest} more` : "");
  };

  /**
   * The text a source holds, from whichever of the two places actually has it.
   *
   * Extracted text is the normal answer, and for a PDF or an Office file it is the only one —
   * those are the categories `needsParse` names, and a `document` with no extracted text is a
   * file that could not be read rather than one that has not been.
   *
   * For everything else the parse was never going to produce anything: `text`, `markdown`,
   * `code` and `diagram` are inlined verbatim by `buildUserContent` and never extracted, so
   * `readParsedText` has always returned nothing for them. That left `read_document` able to
   * name a `.md` the user uploaded and unable to read it — a dead end that was survivable while
   * the model was only handed ids it had just been shown, and is not now that a grant makes
   * uploads from elsewhere addressable. So the bytes are decoded here instead.
   */
  const readableText = async (sourceId: string): Promise<string | undefined> => {
    const parsed = await readParsedText(ctx.user, sourceId);
    if (parsed !== undefined) return parsed;

    const row = ctx.db.getSourceForUser(sourceId, ctx.userId);
    if (!row || needsParse(row)) return undefined;
    const bytesPath = sourceBytesOf(ctx.db, ctx.user, ctx.userId, row);
    if (!bytesPath) return undefined;
    return readFile(bytesPath, "utf8").catch(() => undefined);
  };

  return tool(
    async ({ sourceId, offset, limit: requested }) => {
      const entry = allowed.get(sourceId);
      if (!entry) {
        return `No such document here. Available: ${catalogue() || "(none)"}.`;
      }

      const text = await readableText(sourceId);
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
        "Read the text of a source the user has uploaded to this conversation or to the workspace it is in — a PDF, " +
        "Word, Excel or PowerPoint file by its extracted text, and a Markdown, text, code or diagram file verbatim. " +
        "Long documents are only partly included in the prompt — use this tool to read " +
        "the rest, advancing with the `offset` it reports. The ids this accepts are the ones named in the prompt or in a " +
        "previous call's report; call ila_query with kind \"source\" to list everything you may read. Read a large " +
        "stretch in several calls rather than asking for everything at once.",
      schema: z.object({
        sourceId: z
          .string()
          .describe("Id of the source to read. Must be one this conversation may read — see ila_query kind \"source\"."),
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
