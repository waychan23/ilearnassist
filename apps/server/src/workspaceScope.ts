import type { Session, Workspace, WorkspaceScope } from "@ilearnassist/shared";
import type { AppDb } from "./db.js";

/**
 * The workspaces a conversation may read *across*, as the user granted them with `@`.
 *
 * This module is the whole of the feature's authority. A conversation's grant is stored as a
 * `SessionSettings.workspaceScope` — a small piece of JSON a client may write — and everything
 * downstream (the `read_document` whitelist, `ila_explore`, `ila_query`'s index, the system
 * prompt's guidance) reads only a `ResolvedScope`, never the stored value. One reader means one
 * answer to "what may this conversation read", which is the same reason `resolveWriteLocation`
 * exists as a function rather than as three call sites agreeing.
 *
 * **Nothing widens by default.** An absent, `null` or empty value resolves to `EMPTY_SCOPE`, so
 * a conversation created before this existed behaves exactly as it did.
 */

/** A workspace the grant names, with the one path `ila_explore` needs to read it. */
export interface ScopedWorkspace {
  id: string;
  name: string;
  workdirPath: string;
}

export interface ResolvedScope {
  /**
   * Every workspace this account holds, including ones created after the grant was made.
   *
   * A flag rather than a materialised list because that is what the user chose: storing the ids
   * it implied would answer "everything I have" with "everything I had on Tuesday". The
   * `workspaces` below are still resolved and carried, so the prompt can name what is in scope
   * *now* without the two being the same fact.
   */
  all: boolean;
  /** The live, owned workspaces in scope — never the conversation's own, which is always readable. */
  workspaces: ScopedWorkspace[];
}

/**
 * No grant. The common case, and a shared frozen constant because it is allocated once per turn
 * per conversation on a path where most conversations have nothing to say.
 */
export const EMPTY_SCOPE: ResolvedScope = Object.freeze({
  all: false,
  workspaces: [] as ScopedWorkspace[],
});

export function scopeIsEmpty(scope: ResolvedScope): boolean {
  return !scope.all && scope.workspaces.length === 0;
}

/**
 * The ids as the JSON the one prepared statement takes.
 *
 * **The only place this value is built**, and the constraint is not stylistic: the statement
 * reads them with `json_each`, `json_each('')` raises `malformed JSON`, and a `json_each` that
 * throws is a 500 on every turn in every conversation. `[]` — not `NULL`, not `""` — is what an
 * empty grant binds, and `JSON.stringify` of an array of strings is the only shape that is
 * always parseable. Never bind the array itself, and never a caller's raw string.
 */
export function scopeIdsJson(scope: ResolvedScope): string {
  return JSON.stringify(scope.workspaces.map((w) => w.id));
}

/**
 * The same grant in the shape `AppDb.listReadableSources` takes.
 *
 * `all` is a `0`/`1` because SQLite has no boolean type and better-sqlite3 will not coerce
 * `true` into `= 1`. Kept as a named type with a `NO_SCOPE` constant so a caller that has not
 * thought about the grant is writing `NO_SCOPE` deliberately rather than inventing an empty one.
 */
export interface ScopeQuery {
  all: boolean;
  idsJson: string;
}

export const NO_SCOPE: ScopeQuery = { all: false, idsJson: "[]" };

export function scopeQuery(scope: ResolvedScope): ScopeQuery {
  return { all: scope.all, idsJson: scopeIdsJson(scope) };
}

/**
 * What the account's own workspaces say, resolved against the grant.
 *
 * Re-derived on **every turn** from the account's live workspaces rather than trusted as stored,
 * and that is the security posture as much as a freshness one: a database row is not a trust
 * boundary, the ids arrive from a client, and a workspace deleted or renamed since the chip was
 * drawn must narrow the grant rather than fail a turn. A workspace that cannot be found is
 * **silently dropped** — the same "not yours and does not exist answer alike" rule the rest of
 * the routes follow. `getWorkspaceForUser` puts the owner in its `WHERE`, so another account's
 * id resolves to nothing here without a comparison anywhere.
 */
export function resolveWorkspaceScope(db: AppDb, userId: string, session: Session): ResolvedScope {
  const stored = session.settings?.workspaceScope;
  if (!stored) return EMPTY_SCOPE;

  if (stored.all === true) {
    const workspaces = db
      .listWorkspaces(userId)
      .filter((w) => w.id !== session.workspaceId)
      .map(toScopedWorkspace);
    return { all: true, workspaces };
  }

  const ids = Array.isArray(stored.workspaceIds) ? stored.workspaceIds : [];
  const workspaces: ScopedWorkspace[] = [];
  for (const id of ids) {
    if (id === session.workspaceId) continue;
    const found = db.getWorkspaceForUser(id, userId);
    if (found) workspaces.push(toScopedWorkspace(found));
  }

  return workspaces.length === 0 ? EMPTY_SCOPE : { all: false, workspaces };
}

function toScopedWorkspace(workspace: Workspace): ScopedWorkspace {
  return { id: workspace.id, name: workspace.name, workdirPath: workspace.workdirPath };
}

/**
 * How many workspaces one grant may name, and how long an id may be.
 *
 * Bounds rather than business rules. The ids are written by a client and read on a path that
 * builds a `Map` and a SQL bind value, so an unbounded array is a body that costs work on every
 * turn in that conversation for as long as it is stored. 200 is far past any real account.
 */
const MAX_SCOPED_WORKSPACES = 200;
const MAX_WORKSPACE_ID_CHARS = 64;

export type NormalizedScope =
  | { ok: true; value: WorkspaceScope | null }
  | { ok: false; message: string };

/**
 * What a client is allowed to store, checked for shape and nothing else.
 *
 * **Ownership is deliberately not checked here.** That is `resolveWorkspaceScope`'s job, on the
 * read path, and it is the only place that can be right: a workspace can be deleted between the
 * chip being drawn and the save landing, and refusing that write would fail a user's save for a
 * reason that is not theirs. An id the account does not own is stored and resolves to nothing.
 * Two checks in two places would also be two answers, and the write-side one is the one that
 * goes stale.
 *
 * Refusing rather than coercing, on the "never coerce a request field into a role or a flag"
 * rule: `"true"` is truthy, so a coerced `all` would store a grant the caller did not ask for.
 * Nothing here is a permission check, so a malformed value is a 400 that names the field.
 */
export function normalizeWorkspaceScope(raw: unknown): NormalizedScope {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "workspaceScope must be an object or null." };
  }

  const record = raw as Record<string, unknown>;
  if (record.all !== undefined && typeof record.all !== "boolean") {
    return { ok: false, message: "workspaceScope.all must be a boolean." };
  }

  const rawIds = record.workspaceIds;
  if (rawIds !== undefined && !Array.isArray(rawIds)) {
    return { ok: false, message: "workspaceScope.workspaceIds must be an array of ids." };
  }
  const ids = (rawIds as unknown[] | undefined) ?? [];
  if (ids.length > MAX_SCOPED_WORKSPACES) {
    return {
      ok: false,
      message: `workspaceScope names at most ${MAX_SCOPED_WORKSPACES} workspaces.`,
    };
  }
  for (const id of ids) {
    if (typeof id !== "string" || id === "" || id.length > MAX_WORKSPACE_ID_CHARS) {
      return { ok: false, message: "workspaceScope.workspaceIds must be non-empty id strings." };
    }
  }

  // `all` covers the list, so the list goes. Keeping it would be a set of names nobody can see,
  // under a flag that already grants them, surviving an edit that removed the flag's meaning.
  if (record.all === true) return { ok: true, value: { all: true } };

  const unique = [...new Set(ids as string[])];
  // An empty grant is stored as `null`, so "no grant" has one representation rather than two
  // that read alike and compare differently.
  if (unique.length === 0) return { ok: true, value: null };
  return { ok: true, value: { all: false, workspaceIds: unique } };
}
