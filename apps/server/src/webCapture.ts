import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import type { SourceOwner } from "@ilearnassist/shared";
import { newId, type AppDb, type SourceRecord } from "./db.js";
import { fetchGuarded, htmlToText } from "./tools/webFetch.js";
import { sourceWebPath } from "./sourcePaths.js";
import { registerPageSource } from "./sources.js";
import { writeParsedText } from "./documents/store.js";
import type { UserLayout } from "./paths.js";

/**
 * A page becomes a source, whoever asked for it.
 *
 * Two callers want exactly this and neither owns it: `ila_collect_page`, when the **model**
 * decides a page it read is worth keeping, and the source browser's "add a link", when the
 * **user** pastes a URL in. What they share is the whole of the operation — fetch through the
 * guard, extract the text, store both halves, write the row — and what differs is one field:
 * the summary, which only a model can write. So the difference is a parameter rather than a
 * second implementation, and the SSRF guard in particular has one call site for pages, not two.
 *
 * The bytes are the *fetched body*; the text is the derived half, in the one `parsed/` tree
 * every other source's text goes to. That split is what lets `read_document` and the prompt
 * builder treat a page like any other document, with no branch for "it came off the network".
 */

/** What a turn remembers about the pages it fetched, so keeping one does not refetch it. */
export type PageCache = Map<string, { finalUrl: string; body: string; contentType: string }>;

/** How much of a page's text is stored. The bytes are kept whole; the text is what a model reads. */
const MAX_PAGE_TEXT_CHARS = 400_000;

export interface CapturePageInput {
  user: UserLayout;
  userId: string;
  /** Who holds the page: a conversation when the model kept it, a workspace when a user added it. */
  owner: SourceOwner;
  /** The workspace it belongs to, so it is readable from every conversation in it. */
  workspaceId: string;
  url: string;
  /**
   * The model's one line about the page.
   *
   * Absent for a link the **user** added, and that absence is honest rather than a gap: a
   * summary is a reading of the page by something that understood it, and nothing has read a
   * URL pasted into a dialog. The browser shows the title and the URL instead.
   */
  summary?: string;
  /** This turn's fetches, when there is a turn. See `PageCache`. */
  cache?: PageCache;
  now?: string;
}

export async function captureWebPage(db: AppDb, input: CapturePageInput): Promise<SourceRecord> {
  const cached = input.cache?.get(input.url);
  let finalUrl = input.url;
  let body: string;
  let contentType: string;

  if (cached) {
    finalUrl = cached.finalUrl;
    body = cached.body;
    contentType = cached.contentType;
  } else {
    // The same guard `web_fetch` uses, exported precisely so this is the *same* function: the
    // SSRF check runs on this URL and on every redirect hop.
    const fetched = await fetchGuarded(input.url);
    finalUrl = fetched.finalUrl;
    body = fetched.body;
    contentType = fetched.contentType;
    input.cache?.set(input.url, fetched);
    input.cache?.set(finalUrl, fetched);
  }

  const isHtml = contentType.includes("html") || body.trimStart().startsWith("<");
  const extracted = isHtml ? htmlToText(body) : { title: "", text: body.trim() };

  const text = extracted.text.slice(0, MAX_PAGE_TEXT_CHARS);
  if (text.trim().length === 0) {
    // A page with no readable text is not worth keeping, and an empty source would read as
    // "unparsed" for ever. The model can still quote what `web_fetch` returned; it simply
    // cannot make it a source — and a user who pasted such a URL is told why.
    throw new Error(
      `"${finalUrl}" has no readable text to store — it may be a script-only page or a binary file.`
    );
  }

  /*
   * The stored file is HTML when the page was HTML and plain text otherwise, because
   * `storage: "web"` derives the extension from the MIME type — and a page stored as something
   * the table does not know would be a source nothing could resolve.
   */
  const mimeType = isHtml ? "text/html" : "text/plain";
  const id = newId();
  const path = sourceWebPath(input.user, id, mimeType);

  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, body, "utf8");
  await writeParsedText(input.user, id, text);

  const row = registerPageSource(db, {
    userId: input.userId,
    owner: input.owner,
    id,
    url: finalUrl,
    title: extracted.title,
    summary: input.summary ?? "",
    mimeType,
    size: Buffer.byteLength(body, "utf8"),
    text,
    now: input.now,
  });

  /*
   * Linked, like an upload — and this is the half that makes the row *usable*.
   *
   * `read_document` is bound to a whitelist built from these two link tables, so a page with a
   * row and no link is material the browser lists and the model cannot open. The workspace link
   * is what makes a page kept in one conversation readable from another in the same workspace,
   * which is the same widening an uploaded document already has.
   */
  db.linkSourceToWorkspace(input.userId, input.workspaceId, row.id);
  if (input.owner.kind === "session") db.linkSourceToSession(input.userId, input.owner.id, row.id);

  return row;
}
