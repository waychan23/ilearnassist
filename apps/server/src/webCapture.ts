import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import type { ResourceOwner, WebPage } from "@ilearnassist/shared";
import { newId } from "./db.js";
import type { AppDb, WorkResourceRecord } from "./db.js";
import { fetchGuarded, htmlToText } from "./tools/webFetch.js";
import { parsedFilePath, storePath, webFilePath } from "./resourcePaths.js";
import { ensureWorkResource, registerFile } from "./resources.js";
import { writeParsedText } from "./documents/store.js";
import type { UserLayout } from "./paths.js";

/**
 * A page becomes a reference, whoever asked for it.
 *
 * Two callers want exactly this and neither owns it: `ila_collect_page`, when the **model**
 * decides a page it read is worth keeping, and the library's "add a link", when the **user**
 * pastes a URL in. What they share is the whole of the operation — fetch through the guard,
 * extract the text, store both halves, write the rows — and what differs is one field: the
 * summary, which only a model can write. So the difference is a parameter rather than a second
 * implementation, and the SSRF guard in particular has one call site for pages, not two.
 *
 * Three records, and each holds what the others cannot:
 *
 * - a **`web_pages` row**, whose identity is the *reading* — URL plus extracted text — rather
 *   than the bytes, so a masthead that changed since yesterday is the same page and an article
 *   that changed is a new one;
 * - two **`files` rows**: the fetched body, and the extracted text. The body's is registered and
 *   never referenced — the honest case the file/reference split exists for — while the text's id
 *   goes on the reference as `parsed_file_id`, which is how `read_document` finds it;
 * - exactly one **`work_resources` row**, held by whoever asked for the page: the conversation
 *   when the model kept it, the workspace when the user added a link.
 *
 * **One reference, and there used to be two — and the second bought nothing.** A page kept by a
 * turn also wrote the *workspace's* reference, on the reading that a page is like an uploaded
 * document and should be readable from every conversation in the workspace. That reading was
 * already served by `listReadableWorkResources`, whose third arm admits any reference owned by a
 * *sibling* conversation in the same workspace; the extra row changed nothing about what could be
 * read and only put a second, identical entry in the library under a different owner — the
 * duplication reported from use. Removing it is a subtraction with no loss, which is worth stating
 * plainly because the opposite is the natural assumption.
 */

/** What a turn remembers about the pages it fetched, so keeping one does not refetch it. */
export type PageCache = Map<string, { finalUrl: string; body: string; contentType: string }>;

/** How much of a page's text is stored. The bytes are kept whole; the text is what a model reads. */
const MAX_PAGE_TEXT_CHARS = 400_000;

export interface CapturePageInput {
  user: UserLayout;
  userId: string;
  /**
   * Who holds the page: a conversation when the model kept it, a workspace when a user added it.
   *
   * The only owner, since the fan-out to the workspace was removed — see the module docblock. What
   * makes a kept page readable from a sibling conversation is the readable set's own sibling arm,
   * not a second row here.
   */
  owner: ResourceOwner;
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

export async function captureWebPage(
  db: AppDb,
  input: CapturePageInput
): Promise<WorkResourceRecord> {
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
    // A page with no readable text is not worth keeping, and an empty one would read as
    // "unparsed" for ever. The model can still quote what `web_fetch` returned; it simply
    // cannot make it a kept page — and a user who pasted such a URL is told why.
    throw new Error(
      `"${finalUrl}" has no readable text to store — it may be a script-only page or a binary file.`
    );
  }

  const hash = createHash("sha256").update(`${finalUrl}\n${text}`).digest("hex");
  const title = extracted.title || finalUrl;
  const now = input.now;

  /*
   * The page's identity is the reading, so keeping it again is a no-op for the *bytes*: the row
   * is refreshed (a title or a summary may have been revised) and the files are left where they
   * are, because they are the bytes of the reading that is already recorded.
   *
   * The text file is found through an existing reference rather than derived: the id belongs to
   * the parse, and a second keep must not orphan the first one's file.
   */
  const known = db.findWebPageByHash(input.userId, hash);
  let page: WebPage;
  if (known) {
    db.updateWebPage(known.id, input.userId, {
      title,
      ...(input.summary ? { summary: input.summary } : {}),
      now,
    });
    page = db.getWebPageForUser(input.userId, known.id) ?? known;
  } else {
    page = db.createWebPage({
      id: newId(),
      userId: input.userId,
      sourceType: input.owner.kind === "session" ? "agent_fetch" : "upload",
      url: finalUrl,
      title,
      summary: input.summary,
      sha256: hash,
      now,
    });
  }

  /*
   * The stored body is HTML when the page was HTML and plain text otherwise, because the path's
   * extension comes from the MIME type — and a page stored as something the table does not know
   * would be a file nothing could resolve.
   */
  const mimeType = isHtml ? "text/html" : "text/plain";
  const priorTextFileId = known
    ? db.listWorkResourcesForResource(input.userId, "web_page", page.id)[0]?.parsedFileId
    : undefined;
  const textFileId = priorTextFileId ?? newId();

  if (!known) {
    const bodyFileId = newId();
    const bodyPath = webFilePath(input.user, bodyFileId, mimeType);

    await fs.mkdir(dirname(bodyPath), { recursive: true });
    await fs.writeFile(bodyPath, body, "utf8");

    // The body is stored and *not* referenced — the file/reference split doing its job, and the
    // one place it is not a workaround for the diagram's case but the ordinary one.
    registerFile(db, {
      userId: input.userId,
      path: storePath(input.user, bodyPath),
      sourceType: "agent_create",
      size: Buffer.byteLength(body, "utf8"),
      title: `${title} (raw)`,
      mimeType,
      now,
    });
  }

  // Written (or rewritten) either way: a re-keep whose extraction came out differently should
  // not leave the old text on disk under a row that says otherwise.
  await writeParsedText(input.user, textFileId, text);
  // The text is a registered file like any other — `parsed_file_id` is a link to a row, and a
  // link to nothing would make the reference's own parse state unresolvable.
  const textFile = registerFile(db, {
    id: textFileId,
    userId: input.userId,
    path: storePath(input.user, parsedFilePath(input.user, textFileId)),
    sourceType: "agent_create",
    size: Buffer.byteLength(text, "utf8"),
    title: `${title} (text)`,
    mimeType: "text/plain",
    now,
  });

  const resource = ensureWorkResource(db, {
    userId: input.userId,
    owner: input.owner,
    resourceType: "web_page",
    resourceId: page.id,
    title: page.title,
    summary: input.summary,
    now,
  });
  if (!resource) {
    // Unreachable through either caller — both pass an owner they have already resolved — and
    // a throw rather than a silent return: a page with no reference is a page nobody can read.
    throw new Error("Could not attach the page to anything.");
  }

  /*
   * `ready`, not `none`: a page arrives already extracted — the text is the point of keeping it
   * — and `none` would tell every reader nothing had been done. The parsed file is linked so
   * `read_document` finds the text through the ordinary path.
   *
   * The text file is *shared* by every reference to the same reading: the parse is per reference,
   * but a page arrives already extracted, so there is nothing to redo when a second conversation
   * is pointed at it.
   */
  db.updateWorkResourceParse({
    id: resource.id,
    userId: input.userId,
    status: "ready",
    parsedChars: text.length,
    parsedFileId: textFile.id,
    now,
  });

  return db.getWorkResourceForUser(input.userId, resource.id) ?? resource;
}
