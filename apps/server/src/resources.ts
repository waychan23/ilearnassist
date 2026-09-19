import { basename } from "node:path";
import { stat } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  FileSourceType,
  ResourceOwner,
  StoredFile,
  WebPage,
  WorkResource,
  WorkResourceType,
} from "@ilearnassist/shared";
import { newId } from "./db.js";
import type { AppDb, FileRecord, WorkResourceFilter, WorkResourceRecord } from "./db.js";
import { classifyFile } from "./fileCategory.js";
import { deletePath } from "./fileOps.js";
import {
  sessionDir,
  workspaceTrashDir,
  workspaceWorkdir,
} from "./paths.js";
import type { UserLayout } from "./paths.js";
import { resolveFilePath } from "./resourcePaths.js";

/**
 * The registry: what makes a piece of material *referenceable*.
 *
 * Two writes, and keeping them apart is the whole of the v4 model:
 *
 * - **`registerFile`** records that bytes exist at a path. It never creates a work resource, so a
 *   file can be registered and stay invisible to the library — which is exactly what a diagram's
 *   `.mmd` and a document's extracted text need.
 * - **`ensureWorkResource`** is the reference, the thing the library browses and `@` picks.
 *
 * The rule that falls out of that pair, and the one to remember: **reconciliation adds a work
 * resource only for a file it itself discovered.** A file that already has a row was registered
 * by a writer that knew what it was doing, and that writer's decision about whether the file is
 * externally referenceable is not the reconciler's to overrule. Without the rule, a `.mmd` nobody
 * drew would appear in the library the moment somebody walked the directory it is in.
 */

/**
 * The stored path of a workspace's `workdir/` file, relative to the user root.
 *
 * The workspace segment is the **slug**, never `dir_path`: the column is absolute, and an
 * absolute path is the one stored fact that breaks when a data root is copied. Slugs are unique
 * per account and a rename is display-only, so this stays valid for the life of the row.
 *
 * These builders are the only place the shape is written, and `paths.ts` owns the directory
 * names they are built from. A test asserts each one agrees with the absolute path the same
 * layout produces, because the failure this guards against — a file listed at one path and read
 * at another — is silent.
 */
export function workspaceFilePath(workspaceSlug: string, rel: string): string {
  return `workspaces/${workspaceSlug}/workdir/${rel}`;
}

/** The same for a file in a conversation's own directory. */
export function sessionFilePath(workspaceSlug: string, sessionId: string, rel: string): string {
  return `workspaces/${workspaceSlug}/sessions/${sessionId}/${rel}`;
}

/**
 * Where a file deleted from the file manager goes.
 *
 * Per **workspace**, not per user, and namespaced by the file's id so two files deleted from
 * different directories can each keep their original name. The id namespaces the destination
 * rather than the file, which is what lets a restore put a file back where it was.
 */
export function trashFilePath(workspaceSlug: string, fileId: string, rel: string): string {
  return `workspaces/${workspaceSlug}/trash/${fileId}/${rel}`;
}

/**
 * Which sandbox a written file's bytes are in — a `FileLocation` as an owner.
 *
 * A file in `workdir/` belongs to the workspace (every conversation in it can read the file, so
 * calling it one conversation's would be a claim the tools do not honour), and a file in
 * `sessions/<id>/` belongs to that conversation.
 *
 * It exists as a function because it is a rule two callers need and neither owns: a turn writing
 * a file, and a listing route reconciling one it found. Two inline ternaries is how a file ends
 * up owned by a conversation in one path and by the workspace in the other.
 */
export function fileOwner(
  location: "workspace" | "session",
  ids: { workspaceId: string; sessionId: string }
): ResourceOwner {
  return location === "workspace"
    ? { kind: "workspace", id: ids.workspaceId }
    : { kind: "session", id: ids.sessionId };
}

export interface RegisterFileInput {
  userId: string;
  /**
   * The row's id, for a caller that has to name the file **before it exists**.
   *
   * A blob's path is derived from its id (`sources/parsed/<id>.txt`), so the writer has to know
   * the id to decide where to put the bytes — and letting this default would mean the row and the
   * path disagreed, which is a file that resolves to nothing.
   */
  id?: string;
  /** The stored locator: relative to the user root, `/`-separated. See `resourcePaths.ts`. */
  path: string;
  /**
   * How this file came to exist. A writer that knows says so; a reconciliation does not, and
   * passes `"discovered"` rather than claiming the assistant wrote it.
   */
  sourceType: FileSourceType;
  size: number;
  /** The name to show. Defaults to the last path segment. */
  title?: string;
  /** Passed through when the caller has one — an upload knows what the browser said. */
  mimeType?: string;
  summary?: string;
  /** The content hash, for user-supplied bytes only. See `idx_files_blob`. */
  sha256?: string;
  /** ISO, or the caller's clock. Kept as a parameter so a test can pin a timestamp. */
  now?: string;
}

/**
 * Create or refresh the row for bytes that now exist at `path`.
 *
 * Idempotent, and that is a requirement rather than a convenience: the file tools call it on
 * every write, and the reconcilers call it for every entry they find without a row. A second
 * write of the same file must update the row it already has — keeping its **id**, and with it
 * every reference to it, the summary somebody wrote about it and its parse state.
 *
 * **It creates no work resource.** That is the split the model is built on, and the reason
 * `ensureWorkResource` exists beside it rather than inside it.
 */
export function registerFile(db: AppDb, input: RegisterFileInput): FileRecord {
  const title = input.title ?? basename(input.path);
  const { category, mimeType } = classifyFile(title, input.mimeType);

  const existing = db.getFileByPath(input.userId, input.path);

  if (existing) {
    db.updateFilePath(existing.id, input.userId, {
      /*
       * `title` moves only when the caller names it.
       *
       * A reconcile knows where a file *is*, not what it ought to be called: the filesystem walk
       * visits every file it finds and would otherwise reset a title its owner had chosen, on
       * nothing more than somebody opening the library. `updateFilePath` COALESCEs, so an absent
       * title leaves the row's own, and the paths that really do rename pass one explicitly.
       */
      ...(input.title === undefined ? {} : { title }),
      mimeType,
      category,
      size: input.size,
      now: input.now,
    });
    return db.getFileForUser(input.userId, existing.id) ?? existing;
  }

  return db.createFile({
    id: input.id ?? newId(),
    userId: input.userId,
    sourceType: input.sourceType,
    title,
    path: input.path,
    mimeType,
    category,
    size: input.size,
    summary: input.summary,
    sha256: input.sha256,
    now: input.now,
  });
}

export interface EnsureWorkResourceInput {
  userId: string;
  owner: ResourceOwner;
  resourceType: "file" | "web_page";
  resourceId: string;
  title: string;
  summary?: string;
  now?: string;
}

/**
 * Make an entity referenceable by one owner, and return the reference.
 *
 * Idempotent on (owner, entity), so calling it for something already held is one statement that
 * refreshes the title rather than a duplicate — which is what makes re-uploading, re-referencing
 * and re-copying all ordinary. `undefined` means the entity is not this account's, or is not
 * there at all: the ownership check and the insert are one statement in `db.ts`, so an id from
 * another account cannot become a row.
 */
export function ensureWorkResource(
  db: AppDb,
  input: EnsureWorkResourceInput
): WorkResourceRecord | undefined {
  return db.upsertWorkResource({
    id: newId(),
    userId: input.userId,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    ownerType: input.owner.kind,
    ownerId: input.owner.id,
    title: input.title,
    summary: input.summary,
    now: input.now,
  });
}

/**
 * Give a page reference the text a sibling already extracted, and say whether it worked.
 *
 * **A page arrives already extracted**, which is why this is not a parse: `captureWebPage` says
 * the same thing when it reuses a prior text file, and the honest answer for a second owner is to
 * point at the text that is already on disk. What makes an adoption necessary at all is that a
 * page's text is reachable **only through a reference** — `web_pages` names neither the stored
 * body nor the extracted text — so a second reference to the same page, which is exactly what
 * pointing at it with `@` creates, is born `none` with no pointer, and `documents.schedule`
 * skips it (`text/html` is not a document MIME, and `service.ts` early-returns on that before it
 * writes anything). Left alone it answers "no readable text" for the rest of the conversation —
 * the failure `docs/resources.md` says the schedule exists to prevent, arriving by the one route
 * the schedule cannot cover.
 *
 * **False means there was no sibling text to adopt**, and the reference is left `none` rather
 * than marked `ready` with nothing behind it. `read_document` then says there is no text, which
 * is true and is the reader's own problem to solve by re-keeping the page.
 */
export function adoptPageParse(
  db: AppDb,
  userId: string,
  resource: WorkResourceRecord,
  now?: string
): boolean {
  // Not a page, or already readable: nothing to adopt. False either way, because the caller's
  // next move is the same — hand it to the parse pipeline, which skips a page and parses a file.
  if (resource.resourceType !== "web_page") return false;
  if (resource.parseStatus === "ready" && resource.parsedFileId) return false;

  const sibling = db
    .listWorkResourcesForResource(userId, "web_page", resource.resourceId)
    .find((other) => other.id !== resource.id && other.parsedFileId !== undefined);
  if (!sibling?.parsedFileId) return false;

  db.updateWorkResourceParse({
    id: resource.id,
    userId,
    // `ready`, not `none`: the text is there and every reader treats `ready` as "there is text
    // here". The *length* comes off the sibling rather than being re-measured, because it is the
    // same file and re-reading it would be a second answer to a question already answered.
    status: "ready",
    parsedChars: sibling.parsedChars,
    parsedFileId: sibling.parsedFileId,
    now,
  });
  return true;
}

/**
 * Move a file's row to a new path, keeping everything else about it.
 *
 * The operation the whole identity design exists for: a rename must not cost the file its
 * summary, its parse state or the references pointing at it. Returns false when no live row was
 * at `from` — a caller that needs to tell "moved" from "was not there" gets its answer, and one
 * that merely reconciles can ignore it.
 */
export function renameFile(
  db: AppDb,
  input: { userId: string; from: string; to: string; now?: string }
): boolean {
  const row = db.getFileByPath(input.userId, input.from);
  if (!row) return false;
  return db.updateFilePath(row.id, input.userId, {
    path: input.to,
    title: basename(input.to),
    now: input.now,
  });
}

/**
 * Move every row under a path: the file at it, and everything inside it if it is a directory.
 *
 * A directory move is one `fs.rename` and N rows, and the rows are the half that is easy to
 * forget. A file whose row still names its old place is a file the library lists twice — once
 * from where it is, once from a row reconciling a path that no longer holds anything.
 *
 * One read and then per-row updates rather than one clever `UPDATE … LIKE`: the replacement
 * needs a new *basename* per row, and doing that in SQL would mean writing the basename rule a
 * second time. Returns how many rows moved.
 */
export function renameFileSubtree(
  db: AppDb,
  input: { userId: string; from: string; to: string; now?: string }
): number {
  const prefix = `${input.from}/`;
  const rows = db.listFilesForUser(input.userId);
  let moved = 0;

  for (const row of rows) {
    const next =
      row.path === input.from
        ? input.to
        : row.path.startsWith(prefix)
          ? `${input.to}/${row.path.slice(prefix.length)}`
          : null;
    if (next === null) continue;

    db.updateFilePath(row.id, input.userId, {
      path: next,
      title: basename(next),
      now: input.now,
    });
    moved += 1;
  }

  return moved;
}

/**
 * Register what a *directory listing* found, and say which file each entry is.
 *
 * The half of registration that cannot be eager, and it is not belt-and-braces: the agent's
 * `delete_file` is a real filesystem operation that must not become a database write, and a file
 * can appear with no writer at all. Reconciliation is what makes "every file is in the registry"
 * true anyway — it just says `discovered` about the ones nobody claimed.
 *
 * Three properties, each chosen against a cost:
 *
 * - **One query for the whole listing.** The account's files are read once and indexed; a
 *   statement per entry would put an N+1 under a `readdir` that costs one call today.
 * - **Files only.** A directory is not a file, so a `node_modules` costs nothing here even if it
 *   costs a listing.
 * - **Nothing is ever hidden.** An entry with no row gains one; a row with no file keeps its row
 *   and is reported `missing` by the reader.
 *
 * A file it *discovers* is also made referenceable — that is the whole point of the walk being
 * what makes a dropped-in file usable — while a file that already had a row is left exactly as
 * its writer left it. See the module docblock.
 *
 * Returns `path → fileId` for every file in the listing, old rows and new ones alike.
 */
export function reconcileListing(
  db: AppDb,
  input: {
    userId: string;
    owner: ResourceOwner;
    /** Builds the stored path from a path relative to the sandbox root. */
    pathFor: (rel: string) => string;
    entries: readonly { type: string; path: string; size?: number | null }[];
    now?: string;
  }
): Map<string, string> {
  const known = new Map(db.listFilesForUser(input.userId).map((f) => [f.path, f.id]));

  const ids = new Map<string, string>();
  for (const entry of input.entries) {
    if (entry.type !== "file") continue;
    const path = input.pathFor(entry.path);
    const existing = known.get(path);
    if (existing) {
      ids.set(entry.path, existing);
      continue;
    }
    const created = registerDiscovered(db, {
      userId: input.userId,
      owner: input.owner,
      path,
      size: entry.size ?? 0,
      now: input.now,
    });
    ids.set(entry.path, created.id);
  }

  return ids;
}

/** Register a file nobody claimed, and make it referenceable. The reconcilers' single write. */
function registerDiscovered(
  db: AppDb,
  input: { userId: string; owner: ResourceOwner; path: string; size: number; now?: string }
): FileRecord {
  const file = registerFile(db, {
    userId: input.userId,
    path: input.path,
    sourceType: "discovered",
    size: input.size,
    now: input.now,
  });
  ensureWorkResource(db, {
    userId: input.userId,
    owner: input.owner,
    resourceType: "file",
    resourceId: file.id,
    title: file.title,
    now: input.now,
  });
  return file;
}

/* ------------------------------- the filesystem ------------------------------- */

/** How deep and how wide a walk looks. Caps rather than expectations — see `reconcileFilesystem`. */
export const SCAN_MAX_DEPTH = 6;
export const SCAN_MAX_FILES = 5_000;

/**
 * Bring the registry up to date with what is actually on disk.
 *
 * The gap this closes is the one `reconcileListing` cannot: the file browser lists *directories*,
 * and the library lists *rows*. So a file that appeared with no writer at all — cloned into a
 * workspace, restored from a backup, dropped in from the Finder, or written while the server was
 * running — was invisible in the library until somebody happened to open the file tree on that
 * exact folder. Found by a spec rather than by reasoning.
 *
 * **Run before a listing, not at boot.** A boot-time scan answers "what was there when the server
 * started", which is a different question from the one the reader is asking, and the difference
 * is exactly the file they just put there. The caps are what makes that affordable: a few
 * thousand `stat`s, tens of milliseconds, on a screen somebody opened deliberately. Whatever the
 * cap leaves out is still reachable — the file tree's own reconcile registers a directory the
 * moment it is listed.
 *
 * Idempotent by construction, so running it on every request cannot produce a second row — which
 * is what lets this be a plain call rather than a cache with an invalidation policy.
 */
export async function reconcileFilesystem(
  db: AppDb,
  filter: { workspaceId?: string; sessionId?: string } = {}
): Promise<{ scanned: number; truncated: boolean }> {
  let scanned = 0;
  let truncated = false;
  let budget = SCAN_MAX_FILES;

  for (const user of db.listUsers()) {
    const workspaces = db
      .listWorkspaces(user.id)
      .filter((w) => !filter.workspaceId || w.id === filter.workspaceId);

    for (const workspace of workspaces) {
      const known = new Set(db.listFilesForUser(user.id).map((f) => f.path));
      const roots: Array<{ root: string; owner: ResourceOwner; pathFor: (rel: string) => string }> =
        [];

      if (!filter.sessionId) {
        roots.push({
          root: workspaceWorkdir(workspace.dirPath),
          owner: { kind: "workspace", id: workspace.id },
          pathFor: (rel) => workspaceFilePath(workspace.slug, rel),
        });
      }
      for (const session of db.listSessionsForUser(workspace.id, user.id)) {
        if (filter.sessionId && session.id !== filter.sessionId) continue;
        roots.push({
          root: sessionDir(workspace.dirPath, session.id),
          owner: { kind: "session", id: session.id },
          pathFor: (rel) => sessionFilePath(workspace.slug, session.id, rel),
        });
      }

      for (const { root, owner, pathFor } of roots) {
        const found = await walk(root, budget);
        budget -= found.files.length;
        truncated ||= found.truncated;

        for (const file of found.files) {
          const path = pathFor(file.relPath);
          scanned += 1;
          /*
           * A file that already has a row is left alone, and that is the rule the module is built
           * around rather than an optimisation: its writer decided whether it is externally
           * referenceable. A diagram's `.mmd` and a parse result are registered files with **no**
           * work resource, on purpose, and a walk that gave them one would put them in the
           * library the first time somebody opened it.
           */
          if (known.has(path)) continue;
          registerDiscovered(db, { userId: user.id, owner, path, size: file.size });
        }
        if (budget <= 0) break;
      }
      if (budget <= 0) {
        truncated = true;
        break;
      }
    }
    if (budget <= 0) break;
  }

  return { scanned, truncated };
}

/** One bounded depth-first walk: the files under `root`, as paths relative to it. */
async function walk(
  root: string,
  budget: number
): Promise<{ files: Array<{ relPath: string; size: number }>; truncated: boolean }> {
  const files: Array<{ relPath: string; size: number }> = [];
  let truncated = false;

  const visit = async (dir: string, rel: string, depth: number): Promise<void> => {
    // Either cap stopping the walk *is* the truncation: what it leaves out is registered later,
    // by the listing that reconciles it.
    if (depth > SCAN_MAX_DEPTH || files.length >= budget) {
      truncated = true;
      return;
    }
    const entries = await readdir(join(root, dir), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (files.length >= budget) {
        truncated = true;
        return;
      }
      // A symlink is skipped rather than followed: `files.ts` realpath-checks a read for a
      // reason, and a walk that followed one could leave the sandbox entirely.
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await visit(join(dir, entry.name), childRel, depth + 1);
      } else if (entry.isFile()) {
        const info = await stat(join(root, dir, entry.name)).catch(() => null);
        if (info) files.push({ relPath: childRel, size: info.size });
      }
    }
  };

  await visit("", "", 0);
  return { files, truncated };
}

/* ---------------------------------- reading ---------------------------------- */

/**
 * Every live work resource the account holds, each with whether its bytes are still there.
 *
 * `missing` is a `stat`, computed here and stored nowhere — the decision `listDiagramViews` makes
 * about `fileMissing`, and for a sharper reason here. The one writer that creates the drift is
 * the agent's `delete_file`, which is deliberately a plain filesystem operation; a stored flag
 * would have to be cleared by *somebody*, and the only somebody is a database write inside a tool
 * that is not supposed to make one.
 *
 * A page has no bytes of its own to be missing, so it is never `missing` — see `resourcePath`.
 */
export async function listResourceViewsForUser(
  db: AppDb,
  user: UserLayout,
  userId: string,
  filter: WorkResourceFilter = {}
): Promise<WorkResourceRecord[]> {
  const rows = await withMissing(user, db.listWorkResourcesFiltered(userId, filter));
  return withOwnerLabels(db, userId, withReferenceCounts(db, userId, rows));
}

/**
 * Attach how many live references point at each row's entity, this one included.
 *
 * The library's delete asks with it: destroying a file destroys every reference to it, so a
 * delete that would take another conversation's material with it has to say so *before* it
 * happens. **Both relations count** — a conversation that merely *refers* to the file loses it
 * too, so counting holdings alone would answer "nobody else has this" about material two panels
 * were about to lose. One grouped statement per entity type on the page — at most two, since
 * `file` and `web_page` are the whole vocabulary — and never a query per row.
 *
 * Absent rather than `1` when the count cannot be had: a listing is the only caller, and a row
 * from anywhere else leaves the field off, which the reader must treat as "unknown" rather than
 * as "nobody else holds this".
 */
function withReferenceCounts(
  db: AppDb,
  userId: string,
  rows: readonly WorkResourceRecord[]
): WorkResourceRecord[] {
  const idsByType = new Map<WorkResourceType, Set<string>>();
  for (const row of rows) {
    const ids = idsByType.get(row.resourceType) ?? new Set<string>();
    ids.add(row.resourceId);
    idsByType.set(row.resourceType, ids);
  }

  const counts = new Map<string, number>();
  for (const [resourceType, ids] of idsByType) {
    for (const [resourceId, count] of db.countReferencesForEntities(userId, resourceType, [...ids])) {
      counts.set(`${resourceType}:${resourceId}`, count);
    }
  }

  return rows.map((row) => {
    const count = counts.get(`${row.resourceType}:${row.resourceId}`);
    return count === undefined ? row : { ...row, referenceCount: count };
  });
}

/**
 * Name the thing each reference is held by, and the workspace it is ultimately in.
 *
 * Two maps built once per listing — the account's workspaces, and its conversations with their
 * workspace's name — rather than a lookup per row. A row whose owner cannot be resolved keeps the
 * fields absent rather than getting a placeholder: "reached through" is the rule everywhere else
 * in this schema, and a list that invented a name for an owner it could not find would be lying
 * about material it is showing. It is also a reachable state — a reference outlives the
 * conversation that made it.
 */
export function withOwnerLabels(
  db: AppDb,
  userId: string,
  rows: readonly WorkResourceRecord[]
): WorkResourceRecord[] {
  const workspaces = new Map(db.listWorkspaces(userId).map((w) => [w.id, w]));
  const sessions = new Map(db.listSessionLabels(userId).map((s) => [s.id, s]));

  return rows.map((row) => {
    if (row.ownerType === "workspace") {
      const workspace = workspaces.get(row.ownerId);
      return {
        ...row,
        ownerName: workspace?.name,
        workspaceId: workspace?.id,
        workspaceName: workspace?.name,
      };
    }
    const session = sessions.get(row.ownerId);
    return {
      ...row,
      ownerName: session?.title,
      workspaceId: session?.workspace_id,
      workspaceName: session?.workspace_name,
    };
  });
}

/** Attach `missing` to each row. Shared so two listings cannot answer it differently. */
async function withMissing(
  user: UserLayout,
  rows: WorkResourceRecord[]
): Promise<WorkResourceRecord[]> {
  return Promise.all(
    rows.map(async (row) => {
      // A page is its text, and its text is a `File` the reference owns — there is no separate
      // entity locator to check. Only a file can be absent.
      if (row.resourceType !== "file") return row;
      const path = resolveFilePath(user, row.resource as StoredFile);
      if (!path) return { ...row, missing: true };
      // "Is it there" rather than "can I open it": a file that exists and is unreadable is a
      // permission problem, and reporting it as absent would send someone looking for a file
      // that is plainly in the tree.
      const present = await stat(path).then(
        (info) => info.isFile(),
        () => false
      );
      return { ...row, missing: !present };
    })
  );
}

/**
 * The resolved path of every file a run might read, by **file id**.
 *
 * One map for the whole run rather than a lookup per message: `buildUserContent` is re-run for
 * every replayed user turn, and a file attached three turns ago is replayed on every turn after
 * it. Collecting the ids first — from history *and* from the turn being sent — makes the cost one
 * pass over a small set instead of one query per attachment per message.
 *
 * An id that resolves to nothing is simply absent, which is what `buildUserContent` reads as
 * "this attachment is missing". There is deliberately no derivation to fall back to: the path is
 * stored on the row, so a second way to compute one could only disagree with it.
 */
export function filePathsFor(
  db: AppDb,
  user: UserLayout,
  userId: string,
  fileIds: Iterable<string>
): Map<string, string> {
  const paths = new Map<string, string>();
  for (const id of new Set(fileIds)) {
    const file = db.getFileForUser(userId, id);
    if (!file) continue;
    const path = resolveFilePath(user, file);
    if (path) paths.set(id, path);
  }
  return paths;
}

/** Re-exported so a caller reasoning about a resource's bytes has one import. */
export type { WorkResource, WebPage, StoredFile };

/* --------------------------------- deleting --------------------------------- */

/**
 * Delete a reference — and, as its internal consequence, the material it names.
 *
 * **One operation, and this is the only way material goes.** There used to be two, split by which
 * kind of row the reader happened to click: remove this session's reference and leave everything
 * alone, or trash the bytes through the file manager and take every reference with them. Same
 * intent, two consequences, two sentences in the dialog — and the *file* was reachable by a route
 * that never mentioned a reference at all, which is what made "the entity is an implementation
 * detail of the reference" untrue in practice.
 *
 * What a person means is "delete this", and the cost is stated before it happens: the reference
 * goes, the material goes, and **every other reference to that material stays where it is** —
 * dangling, and reported as gone wherever somebody opens it. Nothing here reaches for another
 * owner's `work_resources` row, and nothing touches `session_references` or `notes`: those are
 * other readers' records of having been about this material, and a delete is not theirs to
 * rewrite. That is what makes standing on the reference rather than on the entity safe to
 * report, instead of something that has to be swept up — see `session_references` in the schema.
 *
 * The bytes: a file inside one of the sandboxes (`workdir/` or a conversation's own directory)
 * moves to its workspace's `trash/`, which is the file manager's promise and what a restore would
 * read. An upload, a parse result or a page has nowhere to go and is soft-deleted in place — the
 * rule that a delete costs no disk.
 *
 * Returns false when the reference is not this account's or is already gone; a caller turns that
 * into the 404 it already answers for an unknown id.
 */
export async function deleteWorkResource(
  db: AppDb,
  layout: UserLayout,
  input: { userId: string; id: string }
): Promise<boolean> {
  const reference = db.getWorkResourceForUser(input.userId, input.id);
  if (!reference) return false;

  /*
   * The material first, then the reference. The order is the reverse of the obvious one and it is
   * deliberate: a move that fails must leave the reference alone, so the operation either lands
   * whole or reports an error over material that is still listed. Deleting the reference first
   * would leave a file the reader can no longer see, still on disk, after an error they cannot do
   * anything with.
   */
  await deleteEntity(db, layout, input.userId, reference);
  return db.softDeleteWorkResourceForUser(reference.id, input.userId);
}

/** The material half — a `files` or `web_pages` row, and the bytes if they live in a sandbox. */
async function deleteEntity(
  db: AppDb,
  layout: UserLayout,
  userId: string,
  reference: WorkResourceRecord
): Promise<void> {
  if (reference.resourceType === "web_page") {
    // The fetched body under `sources/web/` stays: a page's identity is its *reading*, and the
    // row is what every reader resolved through.
    db.softDeleteWebPageForUser(reference.resource.id, userId);
    return;
  }

  const file = db.getFileForUser(userId, reference.resource.id);
  if (!file) return;

  const workspace = workspaceOfReference(db, userId, reference);
  const sandbox = workspace ? sandboxFor(layout, workspace, file.path) : null;
  if (workspace && sandbox) {
    /*
     * `deletePath` moves the bytes and refuses a populated directory, which is the file manager's
     * own rule — one click in a browser is not a good place to be recursively destroying work
     * nobody looked at.
     */
    await deletePath(sandbox.abs, workspaceTrashDir(workspace.dirPath), sandbox.rel, file.id);
    db.updateFilePath(file.id, userId, {
      path: trashFilePath(workspace.slug, file.id, sandbox.rel),
    });
  }
  db.softDeleteFileForUser(file.id, userId);
}

/**
 * The workspace a reference's bytes belong to, whether it names one directly or through a
 * conversation.
 *
 * `undefined` for a reference whose owner is gone (a deleted conversation, a deleted workspace).
 * That is not a failure: the rows still go, and only the bytes stay where they were — which is
 * the same state a soft delete leaves them in anyway.
 */
function workspaceOfReference(
  db: AppDb,
  userId: string,
  reference: WorkResourceRecord
): { id: string; slug: string; dirPath: string } | undefined {
  if (reference.ownerType === "workspace") {
    const own = db.getWorkspaceForUser(reference.ownerId, userId);
    return own ? { id: own.id, slug: own.slug, dirPath: own.dirPath } : undefined;
  }
  const owned = db.getSessionForUser(reference.ownerId, userId);
  if (!owned) return undefined;
  const { workspace } = owned;
  return { id: workspace.id, slug: workspace.slug, dirPath: workspace.dirPath };
}

/**
 * Which sandbox a stored path is in, or null for one that is in none.
 *
 * A stored `files.path` is relative to the user root, so the two sandboxes are its prefixes —
 * computed from the workspace's own slug and the conversation's id rather than parsed out of the
 * path, which is the same reason `resolveFilePath` re-validates instead of trusting a column.
 * An upload under `sources/raw/` and a parse result under `sources/parsed/` are in neither, which
 * is what leaves their bytes in place.
 */
function sandboxFor(
  layout: UserLayout,
  workspace: { slug: string; dirPath: string },
  storedPath: string
): { abs: string; rel: string } | null {
  const workdirPrefix = workspaceFilePath(workspace.slug, "");
  if (storedPath.startsWith(workdirPrefix)) {
    return {
      abs: workspaceWorkdir(workspace.dirPath),
      rel: storedPath.slice(workdirPrefix.length),
    };
  }
  const sessionsPrefix = `workspaces/${workspace.slug}/sessions/`;
  if (storedPath.startsWith(sessionsPrefix)) {
    const rest = storedPath.slice(sessionsPrefix.length);
    const cut = rest.indexOf("/");
    // A file *at* the session root has no name to restore under, which is not a shape the writers
    // produce; the rows still go and the bytes stay.
    if (cut === -1) return null;
    return {
      abs: sessionDir(workspace.dirPath, rest.slice(0, cut)),
      rel: rest.slice(cut + 1),
    };
  }
  return null;
}
