import type {
  Attachment,
  FileCategory,
  StoredFile,
  WebPage,
  WorkResource,
} from "../api/types";

/**
 * Reading a `WorkResource` the way the UI needs to read it.
 *
 * A v4 reference is an *entity plus the owner's reference to it*, and it is polymorphic: the
 * bytes of a `file` are a `StoredFile` and the bytes of a `web_page` are a `WebPage`, so the
 * facts a row draws — its content type, its size, whether it is an image, where its bytes are —
 * live one level down and are absent on one of the two arms.
 *
 * Every accessor here therefore answers for **both** arms rather than assuming a file, and they
 * live in one module because four surfaces draw the same row (the library, the `@` picker, the
 * sources panel and the chat composer) and a derivation repeated four times is how one of them
 * ends up disagreeing with the others. Pure, so it is unit tested rather than screenshotted.
 */

/** The file behind a reference, or `null` when it is a page. */
export function fileOf(row: WorkResource): StoredFile | null {
  return row.resourceType === "file" ? (row.resource as StoredFile) : null;
}

/** The page behind a reference, or `null` when it is a file. */
export function pageOf(row: WorkResource): WebPage | null {
  return row.resourceType === "web_page" ? (row.resource as WebPage) : null;
}

/** What this owner calls it. The reference's own title, never the entity's. */
export function resourceName(row: WorkResource): string {
  return row.title;
}

/**
 * The reference's coarse content type, or `null` when there is none.
 *
 * `null` is the honest answer for a page: a `FileCategory` is derived from a *file's name*, and a
 * page has no name — which is exactly why v3 had to hand-set `category: "page"`, and why v4 gave
 * that distinction its own axis (`resourceType`) instead.
 */
export function resourceCategory(row: WorkResource): FileCategory | null {
  return fileOf(row)?.category ?? null;
}

/** A reference's MIME type. A page's bytes are always the stored HTML. */
export function resourceMime(row: WorkResource): string {
  return fileOf(row)?.mimeType ?? "text/html";
}

/** A reference's byte size. A page has none — its bytes are not what the row is about. */
export function resourceSize(row: WorkResource): number {
  return fileOf(row)?.size ?? 0;
}

/** Whether this is a picture, which is what decides a chip's thumbnail and a row's icon. */
export function resourceIsImage(row: WorkResource): boolean {
  return resourceMime(row).startsWith("image/");
}

/** Where a page came from, so a row can offer to follow it. Absent for every file. */
export function resourceUrl(row: WorkResource): string | undefined {
  return pageOf(row)?.url;
}

/** The two segments the sandboxes are built from — see `paths.ts` on the server. */
const WORKDIR_MARKER = "/workdir/";

/**
 * A file's path **relative to the sandbox it is in**, or `undefined` when it is not in one.
 *
 * `StoredFile.path` is relative to the account's root, so a workspace file reads
 * `workspaces/<slug>/workdir/notes/a.md`. That prefix is the same for every row of an owner, so
 * a tree built on it would draw three levels of directory nobody named before reaching the one
 * that means something. This strips it back to `notes/a.md`.
 *
 * `undefined` is the answer for anything else, and it is load-bearing rather than a fallback: an
 * upload's bytes live under `sources/raw/`, a path that says nothing about where the material
 * came from, so a row with one belongs *at its owner* — the same place v3 put a row with no
 * `relPath` at all.
 */
export function resourceSandboxPath(row: WorkResource): string | undefined {
  const file = fileOf(row);
  if (!file) return undefined;

  const workdir = file.path.indexOf(WORKDIR_MARKER);
  if (workdir >= 0) return file.path.slice(workdir + WORKDIR_MARKER.length);

  // A conversation's own files, addressed by *this* owner's id so a path belonging to another
  // conversation is not silently filed under this one.
  const marker = `/sessions/${row.ownerId}/`;
  const at = file.path.indexOf(marker);
  if (at >= 0) return file.path.slice(at + marker.length);

  return undefined;
}

/**
 * The reference as an `Attachment`, which is the shape a composer chip and a message snapshot use.
 *
 * The two ids are the v4 split and are not interchangeable: `id` is the **entity** — what the
 * bytes are fetched by — and `resourceId` is the *reference*, whose parse state and title the
 * model reads. See `Attachment` in the shared package.
 */
export function resourceAttachment(row: WorkResource): Attachment {
  return {
    id: row.resource.id,
    resourceId: row.id,
    name: row.title,
    mimeType: resourceMime(row),
    size: resourceSize(row),
    kind: resourceIsImage(row) ? "image" : "file",
    parseStatus: row.parseStatus,
    parseError: row.parseError,
    parseErrorCode: row.parseErrorCode,
    parserId: row.parserId,
    parsedChars: row.parsedChars,
    pageCount: row.pageCount,
  };
}
