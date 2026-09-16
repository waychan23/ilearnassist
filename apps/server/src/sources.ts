import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
  FileEntry,
  SourceCategory,
  SourceOrigin,
  SourceOwner,
  SourceStorage,
} from "@ilearnassist/shared";
import { newId, type AppDb, type SourceFilter, type SourceRecord } from "./db.js";
import { classifySource } from "./sourceCategory.js";
import { resolveSourceBytes } from "./sourcePaths.js";
import { sessionDir, workspaceWorkdir, type UserLayout } from "./paths.js";

/**
 * The registry: what turns a file's existence into a row, and a row back into a listing.
 *
 * `diagrams.ts` is the shape this follows — a module of plain functions taking `db`, sitting
 * between a tool (or a route) and the table, holding the rules that are neither one's business.
 * Plain functions rather than closures over a turn's context, because there are two callers
 * with different lifetimes: an agent turn and an HTTP request must produce byte-identical rows
 * for the same file, and the surest way is for them to call the same function.
 */

/**
 * Who holds a file that lives in one of the two sandboxes.
 *
 * The owner of a file *is* the sandbox it is in — that is what the two sandboxes mean. A file
 * in `workdir/` belongs to the workspace (every conversation in it can read the file, so
 * calling it one conversation's would be a claim the tools do not honour), and a file in
 * `sessions/<id>/` belongs to that conversation.
 *
 * It exists as a function because it is a rule two callers need and neither owns: a turn
 * writing a file, and the listing route reconciling one it found. Two inline ternaries is how
 * a file ends up owned by a conversation in one path and by the workspace in the other.
 */
export function fileOwner(
  storage: Extract<SourceStorage, "workspace" | "session">,
  ids: { workspaceId: string; sessionId: string }
): SourceOwner {
  return storage === "workspace"
    ? { kind: "workspace", id: ids.workspaceId }
    : { kind: "session", id: ids.sessionId };
}

export interface RegisterFileInput {
  userId: string;
  owner: SourceOwner;
  /** Which of the two file sandboxes the bytes are in. `trash` is reached by deleting, not writing. */
  storage: Extract<SourceStorage, "workspace" | "session">;
  /** The path within that sandbox, `/`-separated and relative to its root. */
  relPath: string;
  /**
   * How this file came to exist. A writer that knows says so; a reconciliation does not, and
   * passes `"discovered"` rather than claiming the assistant wrote it.
   */
  origin: SourceOrigin;
  size: number;
  /** The name to show. Defaults to the last path segment. */
  name?: string;
  /** Passed through when the caller has one — an upload knows what the browser said. */
  mimeType?: string;
  summary?: string;
  /** ISO, or the caller's clock. Kept as a parameter so a test can pin a timestamp. */
  now?: string;
}

/**
 * Create or refresh the row for a file that now exists at `owner:relPath`.
 *
 * Idempotent, and that is a requirement rather than a convenience: the file tools call it on
 * every write, and the listing route calls it for every entry it finds without a row. A second
 * write of the same file must update the row it already has — keeping its **id**, and with it
 * every `messages.attachments` snapshot that points at this file, the summary somebody wrote
 * about it, and its parse state.
 *
 * Identity is the id, and this is where that shows: the row is found by *place*, but it is
 * never replaced because its place changed.
 */
export function registerFileSource(db: AppDb, input: RegisterFileInput): SourceRecord {
  const name = input.name ?? basename(input.relPath);
  const { category, mimeType } = classifySource(name, input.mimeType);

  const existing = db.getSourceByPlace(input.userId, input.owner, input.relPath);

  if (existing) {
    db.updateSourcePlace(existing.id, input.userId, {
      /*
       * `name` moves only when the caller names it.
       *
       * A reconcile knows where a file *is*, not what it ought to be called: `GET /api/sources`
       * walks every session directory and re-registers every file it finds, row or no row, and
       * the `basename` fallback above would silently reset a name its owner had chosen — an
       * exported note's title back to `nt_ab12.md`, on nothing more than somebody opening the
       * library. `updateSourcePlace` COALESCEs, so an absent `name` leaves the row's own, and
       * the paths that really do rename (the file manager's, and the agent writing a new path)
       * pass a name explicitly.
       */
      ...(input.name === undefined ? {} : { name }),
      mimeType,
      category,
      size: input.size,
      storage: input.storage,
      now: input.now,
    });
    return db.getSourceForUser(existing.id, input.userId) ?? existing;
  }

  return db.createSource({
    id: newId(),
    userId: input.userId,
    ownerKind: input.owner.kind,
    ownerId: input.owner.id,
    origin: input.origin,
    storage: input.storage,
    relPath: input.relPath,
    name,
    mimeType,
    category,
    size: input.size,
    url: null,
    summary: input.summary ?? null,
    sha256: null,
    now: input.now,
  });
}

/**
 * Move a source's row to a new path, keeping everything else about it.
 *
 * The operation the whole identity design exists for: a rename must not cost the file its
 * summary, its parse state or the messages that point at it. Returns false when no live row
 * was at `from` — a caller that needs to tell "moved" from "was not there" gets its answer,
 * and one that merely reconciles can ignore it.
 */
export function renameSourceFile(
  db: AppDb,
  input: { userId: string; owner: SourceOwner; from: string; to: string; now?: string }
): boolean {
  const row = db.getSourceByPlace(input.userId, input.owner, input.from);
  if (!row) return false;
  return db.updateSourcePlace(row.id, input.userId, {
    relPath: input.to,
    name: basename(input.to),
    now: input.now,
  });
}

/**
 * Move every row under a path: the file at it, and everything inside it if it is a directory.
 *
 * A directory move is one `fs.rename` and N rows, and the rows are the half that is easy to
 * forget. A file whose row still names its old place is a file the browser lists twice — once
 * from the directory it is in, and once from a row reconciling a path that no longer holds
 * anything — so the subtree has to move with the directory.
 *
 * One read and then per-row updates rather than one clever `UPDATE … LIKE`: the replacement
 * needs a new *basename* per row (the leaf name does not change when its parent moves, but the
 * row's `name` is derived from its path), and doing that in SQL would mean writing the
 * basename rule a second time.
 *
 * Returns how many rows moved, which is what a test asserts on.
 */
export function renameSourceSubtree(
  db: AppDb,
  input: { userId: string; owner: SourceOwner; from: string; to: string; now?: string }
): number {
  const prefix = `${input.from}/`;
  const rows = db.listSourcesForOwner(input.userId, input.owner);
  let moved = 0;

  for (const row of rows) {
    const rel = row.relPath;
    if (rel === undefined) continue;
    const next =
      rel === input.from
        ? input.to
        : rel.startsWith(prefix)
          ? `${input.to}/${rel.slice(prefix.length)}`
          : null;
    if (next === null) continue;

    db.updateSourcePlace(row.id, input.userId, {
      relPath: next,
      name: basename(next),
      now: input.now,
    });
    moved += 1;
  }

  return moved;
}

/**
 * Give every *file* in a listing an id.
 *
 * The half of registration that cannot be eager, and it is not belt-and-braces: the agent's
 * `delete_file` is a real filesystem operation that must not become a database write, and a
 * file can appear with no writer at all. Reconciliation is what makes "every file is a source"
 * true anyway — it just happens to say `discovered` about the ones nobody claimed.
 *
 * Three properties, each chosen against a cost:
 *
 * - **One query for the whole listing.** The rows for the owner are read once and indexed; a
 *   statement per entry would put an N+1 under a `readdir` that costs one call today.
 * - **Files only.** A directory is not a source, so a `node_modules` costs nothing here even
 *   if it costs a listing.
 * - **Nothing is ever hidden.** An entry with no row gains one; a row with no file keeps its
 *   row and is reported `missing` by the reader. An entry that vanishes because a read would
 *   fail is indistinguishable from one that was never there.
 *
 * Returns `relPath → sourceId` for every file in the listing, old rows and new ones alike —
 * which is what the route hangs on each entry and what a rename or a delete addresses.
 */
export function reconcileListing(
  db: AppDb,
  input: {
    userId: string;
    owner: SourceOwner;
    storage: Extract<SourceStorage, "workspace" | "session">;
    entries: readonly FileEntry[];
    now?: string;
  }
): Map<string, string> {
  const rows = db.listSourcesForOwner(input.userId, input.owner);
  const known = new Map<string, string>();
  for (const row of rows) {
    if (row.relPath !== undefined) known.set(row.relPath, row.id);
  }

  const ids = new Map<string, string>();
  for (const entry of input.entries) {
    if (entry.type !== "file") continue;
    const existing = known.get(entry.path);
    if (existing) {
      ids.set(entry.path, existing);
      continue;
    }
    const created = registerFileSource(db, {
      userId: input.userId,
      owner: input.owner,
      storage: input.storage,
      relPath: entry.path,
      origin: "discovered",
      size: entry.size ?? 0,
      now: input.now,
    });
    ids.set(entry.path, created.id);
  }

  return ids;
}

/**
 * The workspace a source lives in, reached through the row's *owner*.
 *
 * A source names no workspace of its own. It names the thing that holds it — a workspace for a
 * `workdir/` file, a conversation for a session file — and a conversation knows its workspace,
 * which is the `sessions`-reach-their-owner-by-join rule one level down. Storing a second
 * column would be a second thing to keep in agreement with the first.
 *
 * `own`-scoped through the accessors, so a row whose owner belongs to somebody else resolves to
 * nothing rather than to their directory. Both callers have already checked the source belongs
 * to this account; this is the second half of that check, for the part of the answer the source
 * does not carry itself.
 */
export function ownerWorkspaceRoot(
  db: AppDb,
  userId: string,
  source: SourceRecord
): string | undefined {
  if (source.ownerKind === "workspace") {
    return db.getWorkspaceForUser(source.ownerId, userId)?.dirPath;
  }
  return db.getSessionForUser(source.ownerId, userId)?.workspace.dirPath;
}

/**
 * A source's bytes, resolved and validated, or undefined.
 *
 * The one place a row becomes a path for a *read*. A blob needs no workspace; a file storage
 * whose owner cannot be resolved gets `undefined`, which every caller already treats the way it
 * treats a missing file.
 */
export function sourceBytesOf(
  db: AppDb,
  user: UserLayout,
  userId: string,
  source: SourceRecord
): string | undefined {
  const root = ownerWorkspaceRoot(db, userId, source);
  if (root === undefined && source.storage !== "upload" && source.storage !== "web") {
    return undefined;
  }
  return resolveSourceBytes(user, source, root ?? "");
}

/**
 * Every live source the account holds, each with whether its bytes are still there.
 *
 * `missing` is a `stat`, computed here and stored nowhere — the same decision `listDiagramViews`
 * makes about `fileMissing`, and for a sharper reason here. The one writer that creates the
 * drift is the agent's `delete_file`, which is deliberately a plain filesystem operation; a
 * stored flag would have to be cleared by *somebody*, and the only somebody is a database write
 * inside a tool that is not supposed to make one.
 *
 * One listing rather than an owner-scoped one beside it: the workspace root is resolved per row
 * from the row's own owner, so a narrower question is a filter on this answer rather than a
 * second function that could resolve it differently. An account with many sources pays one
 * `stat` each, which is the price of computing the answer rather than storing it.
 */
export async function listSourceViewsForUser(
  db: AppDb,
  user: UserLayout,
  userId: string,
  filter: SourceFilter = {}
): Promise<SourceRecord[]> {
  const rows = withMissing(user, db.listSourcesForUser(userId, filter), (row) =>
    ownerWorkspaceRoot(db, userId, row)
  );
  return withOwnerLabels(db, userId, await rows);
}

/**
 * Name the thing each source is held by, and the workspace it is ultimately in.
 *
 * Two maps built once per listing — the account's workspaces, and its conversations with their
 * workspace's name — rather than a lookup per row: the browser lists the whole account at once,
 * and a query per source to find out what to call its owner is the N+1 that the reconcile
 * comment refuses for the same reason.
 *
 * A row whose owner cannot be resolved keeps the fields absent rather than getting a
 * placeholder. "Reached through" is the rule everywhere else in this schema, and a list that
 * invented a name for an owner it could not find would be lying about material it is showing.
 */
export function withOwnerLabels(
  db: AppDb,
  userId: string,
  rows: readonly SourceRecord[]
): SourceRecord[] {
  const workspaces = new Map(db.listWorkspaces(userId).map((w) => [w.id, w]));
  const sessions = new Map(db.listSessionLabels(userId).map((s) => [s.id, s]));

  return rows.map((row) => {
    if (row.ownerKind === "workspace") {
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

/** Attach `missing` to each row. Shared so the two listings cannot answer it differently. */
async function withMissing(
  user: UserLayout,
  rows: SourceRecord[],
  rootFor: (row: SourceRecord) => string | undefined
): Promise<SourceRecord[]> {
  return Promise.all(
    rows.map(async (row) => {
      const path = resolveSourceBytes(user, row, rootFor(row) ?? "");
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
 * The category and MIME a fetched page is stored under.
 *
 * A page's category is decided by its *origin*, never by a name, which is why it is not a case
 * in `classifySource`: an `.html` file in a workspace is code, and the same bytes fetched from
 * a URL are a page. `storage: "web"` and this category travel together for that reason.
 */
export const PAGE_CATEGORY: SourceCategory = "page";

/* ------------------------------- the filesystem ------------------------------- */

/** How deep and how wide a walk looks. Caps rather than expectations — see `reconcileFilesystem`. */
export const SCAN_MAX_DEPTH = 6;
export const SCAN_MAX_FILES = 5_000;

/**
 * Bring the registry up to date with what is actually on disk.
 *
 * The gap this closes is the one reconciliation cannot: `reconcileListing` registers what a
 * *directory listing* finds, and the source browser lists rows, not directories. So a file that
 * appeared with no writer at all — cloned into a workspace, restored from a backup, dropped in
 * from the Finder, or written while the server was running — was invisible in the browser until
 * somebody happened to open the file tree on that exact folder. Found by a spec rather than by
 * reasoning: the browser's own browser-suite case seeded a file on disk and waited for a row
 * that never came.
 *
 * **Run before a source listing, not at boot.** A boot-time scan answers "what was there when
 * the server started", which is a different question from the one the reader is asking, and the
 * difference is exactly the file they just put there. The cost is what makes that affordable:
 * the walk is capped at `SCAN_MAX_FILES` files and `SCAN_MAX_DEPTH` levels, so the worst case is
 * a few thousand `stat`s — tens of milliseconds, on a dialog somebody opened deliberately.
 * Whatever the cap leaves out is still reachable: the file tree's own reconcile registers a
 * directory the moment it is listed.
 *
 * Scoped, so a question about one workspace does not walk the account. `filter` is the same set
 * the listing takes, and only the two scope keys are read.
 *
 * Idempotent by construction (`registerFileSource` upserts on the place), so running it on every
 * request cannot produce a second row — which is what lets this be a plain call rather than a
 * cache with an invalidation policy.
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
      const roots: Array<{
        root: string;
        owner: SourceOwner;
        storage: Extract<SourceStorage, "workspace" | "session">;
      }> = [];

      if (!filter.sessionId) {
        roots.push({
          root: workspaceWorkdir(workspace.dirPath),
          owner: { kind: "workspace", id: workspace.id },
          storage: "workspace",
        });
      }
      for (const session of db.listSessionsForUser(workspace.id, user.id)) {
        if (filter.sessionId && session.id !== filter.sessionId) continue;
        roots.push({
          root: sessionDir(workspace.dirPath, session.id),
          owner: { kind: "session", id: session.id },
          storage: "session",
        });
      }

      for (const { root, owner, storage } of roots) {
        const found = await walk(root, budget);
        budget -= found.files.length;
        truncated ||= found.truncated;

        for (const file of found.files) {
          registerFileSource(db, {
            userId: user.id,
            owner,
            storage,
            relPath: file.relPath,
            origin: "discovered",
            size: file.size,
          });
          scanned += 1;
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

/**
 * The resolved path of every source a run might read, by id.
 *
 * One map for the whole run rather than a lookup per message: `buildUserContent` is re-run for
 * every replayed user turn, and a file referenced three turns ago is replayed on every turn
 * after it. Collecting the ids first — from history *and* from the turn being sent — is what
 * makes the cost one pass over a small set instead of one query per attachment per message.
 *
 * An id that resolves to nothing is simply absent from the map, which sends the content builder
 * back to deriving an upload's path from its id. That is the right fallback rather than an
 * error: a message may name a source that has since been deleted, and the turn should read it
 * as a missing attachment rather than fail.
 */
export function sourcePathsFor(
  db: AppDb,
  user: UserLayout,
  userId: string,
  history: readonly { attachments?: readonly unknown[]; sources?: readonly unknown[] }[],
  extra: readonly { id: string }[]
): Map<string, string> {
  const ids = new Set<string>(extra.map((a) => a.id));
  for (const message of history) {
    for (const attachment of [...(message.attachments ?? []), ...(message.sources ?? [])]) {
      const id = (attachment as { id?: unknown }).id;
      if (typeof id === "string") ids.add(id);
    }
  }

  const paths = new Map<string, string>();
  for (const id of ids) {
    const row = db.getSourceForUser(id, userId);
    if (!row) continue;
    // A blob needs no workspace and derives its own path; a file source needs the root its
    // owner names, which `sourceBytesOf` resolves per row.
    const path = sourceBytesOf(db, user, userId, row);
    if (path) paths.set(id, path);
  }
  return paths;
}

/**
 * Record a page the agent fetched and chose to keep.
 *
 * Its own function rather than a flag on `registerFileSource`, because almost nothing is shared:
 * a page has a URL and a model-written summary, it lives in the `web` blob root with a derived
 * filename and therefore no `relPath`, and its identity is its **content hash** — the same page
 * kept twice is one source, the way the same upload twice is one source. A file's identity is
 * its place; a page's is what it contains.
 *
 * `category: "page"` is set here rather than derived by the classifier, and that is the one
 * place the name does not decide: `classifySource` reads an `.html` file as code, because a
 * file on disk *is* code — while a page's category comes from its origin, which only this
 * caller knows.
 */
export function registerPageSource(
  db: AppDb,
  input: {
    userId: string;
    owner: SourceOwner;
    id: string;
    url: string;
    title: string;
    summary: string;
    mimeType: string;
    size: number;
    /** The extracted text, hashed with the bytes so a changed page is a new source. */
    text: string;
    now?: string;
  }
): SourceRecord {
  const sha256 = createHash("sha256").update(`${input.url}\n${input.text}`).digest("hex");
  /*
   * A blank summary is *no* summary, written as NULL rather than as an empty string.
   *
   * The two are different claims about the same column — "somebody looked and wrote nothing" and
   * "nobody has looked" — and the one that matters here is the second: a page a **user** pasted
   * has been read by nothing, which is exactly what `needsSummary` asks about when a later pass
   * considers describing it. `''` would answer "it has a summary" and stop that from ever
   * happening.
   */
  const summary = input.summary.trim() || null;

  const existing = db.findSourceByHash(input.userId, sha256);
  if (existing) {
    // The same page, kept again — in this conversation or another. The row is shared and the
    // summary is refreshed, because the newer reading of it is the one the model just made.
    db.updateSourcePlace(existing.id, input.userId, { summary, now: input.now });
    return db.getSourceForUser(existing.id, input.userId) ?? existing;
  }

  return db.createSource({
    id: input.id,
    userId: input.userId,
    ownerKind: input.owner.kind,
    ownerId: input.owner.id,
    origin: "web",
    storage: "web",
    relPath: null,
    name: input.title.trim() || input.url,
    mimeType: input.mimeType,
    category: PAGE_CATEGORY,
    size: input.size,
    url: input.url,
    summary,
    sha256,
    now: input.now,
  });
}
