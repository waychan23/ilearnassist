/**
 * Ids are server-issued UUIDs. Anything else must never be interpolated into a filesystem
 * path, which is why this guard is shared rather than re-implemented per module.
 *
 * It lives in its own file so both `attachments.ts` and `documents/store.ts` can use it
 * without importing each other — the parsed-text sidecar needs the same guarantee as the
 * uploaded bytes, and a cycle between those two modules would be a poor way to get it.
 */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

export function isSafeId(id: string | undefined): id is string {
  return !!id && SAFE_ID.test(id);
}
