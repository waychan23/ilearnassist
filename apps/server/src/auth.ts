import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { FastifyRequest } from "fastify";
import type { User } from "@ilearnassist/shared";
import { SETTING_AUTH_SECRET, newId, type AppDb } from "./db.js";
import { ensureUserLayout, userLayout, type DataLayout, type UserLayout } from "./paths.js";
import { uniqueUserSlug } from "./workspace.js";

/**
 * Who a request is acting as.
 *
 * **There is no password yet.** A username is the whole credential, so nothing here
 * authenticates anything — it *identifies*, and the login screen says so in as many words.
 * What the cookie buys is that the identification survives a reload and a restart, and that
 * every route can read one field instead of trusting whatever the client sends per request.
 *
 * Two things are nonetheless built the way they would be with a password, because they are
 * the parts that would be painful to retrofit:
 *
 * - **The cookie is signed.** A bare user id would be *almost* as good — ids are UUIDs and
 *   never leave the server — but almost is doing work in that sentence, and a signature
 *   costs one HMAC. It also means the growth path is a change of *value*, not of shape: when
 *   passwords arrive the cookie carries an opaque token id and only `currentUser` learns to
 *   look in a tokens table instead of `users`.
 * - **The secret lives in the database**, so it travels with the data root and rotating it is
 *   deleting one row — which logs everyone out, and is the lever you would want if a cookie
 *   ever leaked.
 *
 * `HttpOnly`, so page script cannot read it. That has a client-side consequence worth
 * knowing: the app cannot ask "am I signed in?" without a request, which is why the login
 * view waits for `/api/auth/me` rather than checking a cookie.
 */

export const SESSION_COOKIE = "ila_user";

/** Long, because signing in is a formality here rather than a security exchange. */
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * The longest username we accept. Only long enough to be a name, and short enough that the
 * derived slug is not truncated into something the user did not type.
 */
export const MAX_USERNAME_LENGTH = 64;

function sign(userId: string, secret: string): string {
  return createHmac("sha256", secret).update(userId).digest("hex");
}

/**
 * Compare two hex digests without leaking how far they matched.
 *
 * The length check first is not a shortcut: `timingSafeEqual` throws on unequal buffers, and
 * a hex digest's length is fixed and public, so nothing is given away by looking at it.
 */
function signaturesMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * The cookie value: `<userId>.<signature>`.
 *
 * Neither part needs encoding — a UUID and a hex digest are both in the cookie-safe set — so
 * the header is read and written literally rather than through a percent-encoder, which is
 * one fewer place for the two sides to disagree.
 */
function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/**
 * The signing secret, created on first use and then kept.
 *
 * Kept rather than generated per boot, because the panel restarts the server on every launch
 * and on every settings change — a per-boot secret would silently sign everyone out several
 * times a day.
 */
export function authSecret(db: AppDb): string {
  const existing = db.getSetting(SETTING_AUTH_SECRET);
  if (existing) return existing;
  // Two UUIDs rather than one: this is the only secret in the product, and making it 256
  // bits costs nothing anyone can measure.
  const secret = randomUUID() + randomUUID();
  db.setSetting(SETTING_AUTH_SECRET, secret);
  return secret;
}

export function sessionCookie(userId: string, secret: string): string {
  return [
    `${SESSION_COOKIE}=${userId}.${sign(userId, secret)}`,
    "Path=/",
    "HttpOnly",
    // `Lax` rather than `Strict`: the app is opened by clicking a link in the panel, and
    // `Strict` would drop the cookie on that first navigation and bounce the user to the
    // login screen they had already passed.
    "SameSite=Lax",
    `Max-Age=${MAX_AGE_SECONDS}`,
  ].join("; ");
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/**
 * The account a request is acting as, or undefined.
 *
 * Returns undefined for every way a cookie can be wrong — absent, malformed, signed with a
 * different secret, naming a deleted account — because the caller turns all of them into the
 * same 401. Distinguishing them would tell a client which of its guesses was closest.
 */
export function currentUser(
  request: FastifyRequest,
  db: AppDb,
  secret: string
): User | undefined {
  const raw = readCookie(request.headers.cookie, SESSION_COOKIE);
  if (!raw) return undefined;

  // `lastIndexOf`, because the id is a UUID (which contains `-` but no `.`) and the
  // signature is hex — so the last dot is unambiguously the separator, whatever a future
  // id format does.
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const id = raw.slice(0, dot);

  if (!signaturesMatch(raw.slice(dot + 1), sign(id, secret))) return undefined;
  return db.getUser(id);
}

/**
 * Find or create an account by name, with its tree on disk.
 *
 * The one place an account comes into being — the login route and the test harness both come
 * through here, so "what an account is" has a single answer. The name is matched
 * case-insensitively (a unique index on `username COLLATE NOCASE`), so "Ada" and "ada" are
 * one person rather than two accounts that look identical on the login screen.
 *
 * The slug is chosen once and stored; a later change to the username will not move the
 * directory, for the same reason a workspace's rename does not — every path in the user's
 * workspaces is built on it. Uniqueness is checked against the database first and the
 * filesystem second: the column is `UNIQUE`, and a filesystem-only check races two sign-ins
 * arriving at the same instant.
 */
export function ensureUser(
  db: AppDb,
  root: DataLayout,
  username: string
): { user: User; tree: UserLayout } {
  const existing = db.findUserByUsername(username);
  if (existing) {
    const tree = userLayout(root, existing.slug);
    ensureUserLayout(tree);
    return { user: existing, tree };
  }

  const slug = uniqueUserSlug(
    username,
    (candidate) =>
      db.listUsers().some((u) => u.slug === candidate) ||
      // The filesystem is only a backstop for a tree created by hand or left by a database
      // that is gone; the database is the authority.
      existsSync(join(root.usersRoot, candidate))
  );
  const user = db.createUser({ id: newId(), username, slug });
  const tree = userLayout(root, user.slug);
  ensureUserLayout(tree);
  return { user, tree };
}
