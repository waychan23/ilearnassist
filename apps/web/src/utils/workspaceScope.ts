import type { WorkspaceScope } from "../api/types";

/**
 * The `@` grant's set algebra, as pure functions.
 *
 * The grant is a `SessionSettings` field, so the client's job is only to say what the next value
 * is; the server decides what it *means* (`apps/server/src/workspaceScope.ts` re-derives it
 * against the account's live workspaces on every turn). Keeping the arithmetic here rather than
 * in `Composer.vue` is the project's usual reason: components are covered by Playwright and
 * nothing else, and "what does removing the last chip leave" is exactly the kind of thing that is
 * wrong in a way nobody notices until a conversation reads a workspace it should not.
 *
 * Two rules carry the weight, and both are about not leaving a grant behind:
 *
 * - **Removing the last chip returns `null`, never `{all: false, workspaceIds: []}`.** An empty
 *   object is `!= null`, so `createSession` would send it and the conversation would be stored
 *   with a grant object that grants nothing — indistinguishable, to a reader, from one that does.
 *   `null` is the one representation of "no grant", on both sides.
 * - **`addAll` drops `workspaceIds` rather than keeping it.** `all` already covers every named
 *   workspace, so a list left underneath would be state nobody can see and nobody can remove.
 */

/** The grant with one more workspace named. Picking `all` first is not a state worth keeping. */
export function addWorkspace(scope: WorkspaceScope | null, id: string): WorkspaceScope {
  const ids = scope?.workspaceIds ?? [];
  return { all: false, workspaceIds: ids.includes(id) ? ids : [...ids, id] };
}

/** Every workspace the account holds, including ones created later. */
export function addAll(): WorkspaceScope {
  return { all: true };
}

/** One workspace taken back out. The last one leaves no grant at all. */
export function removeWorkspace(scope: WorkspaceScope | null, id: string): WorkspaceScope | null {
  const ids = (scope?.workspaceIds ?? []).filter((existing) => existing !== id);
  return ids.length === 0 ? null : { all: false, workspaceIds: ids };
}

/** Whether a workspace is already readable under this grant — `all` covers every one. */
export function isGranted(scope: WorkspaceScope | null, id: string): boolean {
  if (!scope) return false;
  if (scope.all === true) return true;
  return (scope.workspaceIds ?? []).includes(id);
}

export function isAll(scope: WorkspaceScope | null): boolean {
  return scope?.all === true;
}

/** The named workspaces, or none when the grant is `all` — what a chip row draws. */
export function scopeChipIds(scope: WorkspaceScope | null): string[] {
  return scope?.all === true ? [] : (scope?.workspaceIds ?? []);
}
