import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { FastifyRequest } from "fastify";
import type {
  AuthTokens,
  CodedErrorBody,
  CredentialErrorCode,
  User,
  UserRole,
} from "@ilearnassist/shared";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  SUPERADMIN_ROLE,
  USERNAME_MAX_LENGTH,
} from "@ilearnassist/shared";
import { apiError } from "./apiError.js";
import { newId, type AppDb, type UserRecord } from "./db.js";
import { ensureUserLayout, userLayout, type DataLayout, type UserLayout } from "./paths.js";
import { uniqueUserSlug } from "./workspace.js";

/**
 * Who a request is acting as, and how it proved it.
 *
 * **A password and a bearer token.** The credential is `Authorization: Bearer <accessToken>`,
 * and the token is an opaque random string whose SHA-256 is a row in `auth_tokens` — not a
 * JWT. That is the load-bearing choice here, and it is not about taste: a JWT is
 * self-describing, so a server that has signed one can no longer refuse it, and "sign this
 * account out everywhere" becomes a key rotation that signs out everybody. Keeping a row per
 * token makes revocation one `UPDATE`, which is what the console's kick button is.
 *
 * What the token costs is a database read per request. That is one indexed lookup against a
 * local SQLite file, which is the same order of work as the session-secret lookup this
 * replaced, and it buys immediate revocation — a token stopped working the moment its row
 * says so, rather than at the next restart.
 *
 * Two lifetimes, and the split is the whole point of having two:
 *
 * - **Access** — a day. Sent on every request, so it is the one most likely to be observed.
 * - **Refresh** — a week, and **rotated on every use**: redeeming one revokes it and issues a
 *   fresh pair, so a stolen refresh token is worth one exchange and the theft is visible as a
 *   second client being refused. Because each exchange resets the week, a client that keeps
 *   working never has to sign in again, which is the "stay signed in as long as possible"
 *   behaviour without a token that lives forever.
 *
 * Passwords are `scrypt` from Node's own `crypto` — no dependency, and a memory-hard KDF
 * rather than a bare hash. The parameters travel inside the stored string, so raising them
 * later still verifies the hashes written before the change.
 */

/* --------------------------------- passwords --------------------------------- */

/**
 * `scrypt` parameters. The stored string carries them, so raising these does not orphan the
 * hashes already written — `verifyPassword` reads the cost out of the hash it is checking
 * rather than out of these constants.
 *
 * `128 * N * r` is 16 MiB here, which is under Node's default `maxmem` and is what makes the
 * work expensive for a guesser. `keylen` of 64 is the digest width.
 */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number }
) => Promise<Buffer>;

/**
 * A password hash: `scrypt$<N>$<r>$<p>$<salt>$<digest>`, all base64.
 *
 * A single string rather than six columns, because it is one value that is only ever written
 * and read whole. The scheme name leads so a future `argon2$…` can be added by teaching
 * `verifyPassword` one more branch, and an unrecognised prefix is refused rather than
 * guessed at.
 */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const digest = await scryptAsync(plain, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64"),
    digest.toString("base64"),
  ].join("$");
}

/**
 * Whether `plain` is the password behind `stored`.
 *
 * Returns false for every way a hash can be wrong — null, malformed, an unknown scheme, a
 * digest of the wrong length — because the caller turns all of them into one reply. The
 * comparison itself is `timingSafeEqual` over the raw digests, so a near-miss costs the same
 * as any other, and the length check before it gives nothing away: a digest's length is fixed
 * by the scheme, which is public.
 */
export async function verifyPassword(plain: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, salt, digest] = parts as [string, string, string, string, string, string];
  const cost = { N: Number(n), r: Number(r), p: Number(p) };
  if (!Number.isFinite(cost.N) || !Number.isFinite(cost.r) || !Number.isFinite(cost.p)) {
    return false;
  }
  let expected: Buffer;
  let actual: Buffer;
  try {
    expected = Buffer.from(digest, "base64");
    actual = await scryptAsync(plain, Buffer.from(salt, "base64"), expected.length, cost);
  } catch {
    // A stored hash whose cost parameters are outside what `scrypt` will run — `maxmem` refuses
    // an absurd N, for instance. Refusing the password is the only safe reading.
    return false;
  }
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

/**
 * The alphabet generated passwords are drawn from, minus the characters people misread.
 *
 * `0`/`O` and `1`/`l`/`I` are gone, because these are read off a screen and typed by hand —
 * the console shows the password once and the user has to get it across. Thirty-two symbols
 * is a round number in bits, so the arithmetic below is exact.
 */
const PASSWORD_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

/** Four groups of four: 80 bits, and short enough to read aloud. */
const PASSWORD_GROUPS = 4;
const PASSWORD_GROUP_LEN = 4;

/**
 * A random password for an account somebody else is being given.
 *
 * `randomBytes` rather than `Math.random`, and rejection-free: 32 symbols divides 256 exactly,
 * so taking a byte modulo the alphabet length is uniform rather than merely close to it.
 */
export function generatePassword(): string {
  const groups: string[] = [];
  const bytes = randomBytes(PASSWORD_GROUPS * PASSWORD_GROUP_LEN);
  for (let g = 0; g < PASSWORD_GROUPS; g += 1) {
    let group = "";
    for (let i = 0; i < PASSWORD_GROUP_LEN; i += 1) {
      group += PASSWORD_ALPHABET[bytes[g * PASSWORD_GROUP_LEN + i]! % PASSWORD_ALPHABET.length];
    }
    groups.push(group);
  }
  return groups.join("-");
}

/* ---------------------------------- tokens ----------------------------------- */

/** A day. Long enough that a working tab never notices, short enough to bound a leak. */
export const ACCESS_TOKEN_TTL_SECONDS = 24 * 60 * 60;
/** A week, renewed on every exchange — so the effective session is as long as it is used. */
export const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

/** The header a token travels in. */
export const AUTHORIZATION_HEADER = "authorization";

/**
 * A token value: 32 random bytes, base64url.
 *
 * url-safe because it is also going to be quoted in a `curl` line and pasted into a header,
 * and because the `+` and `/` of standard base64 are two more characters for something to
 * mangle on the way.
 */
function newTokenValue(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * What a token is stored as.
 *
 * The row is keyed by this and never by the token, so a copy of the database is a list of
 * spent hashes rather than a list of working credentials — a backup, a stray `data/`
 * directory, or this file opened in a sqlite browser. Nothing needs the plaintext back, so
 * the hash costs nothing.
 *
 * A plain SHA-256 rather than a KDF, and deliberately: the input is 256 bits of output from a
 * CSPRNG, so there is no guessable space for a slow hash to protect, and the lookup is on the
 * request path.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function isoIn(seconds: number, from: Date): string {
  return new Date(from.getTime() + seconds * 1000).toISOString();
}

/**
 * Mint an access/refresh pair for an account.
 *
 * Both are written before either is returned, so a token that reaches a client is always one
 * the server can check. There is no transaction around the two inserts: the failure mode of
 * one landing without the other is a client holding a token it cannot use, which signs in
 * again — not a token it should not have.
 */
export function issueTokens(db: AppDb, userId: string, now: Date = new Date()): AuthTokens {
  const accessToken = newTokenValue();
  const refreshToken = newTokenValue();
  db.createAuthToken({
    id: hashToken(accessToken),
    userId,
    kind: "access",
    expiresAt: isoIn(ACCESS_TOKEN_TTL_SECONDS, now),
  });
  db.createAuthToken({
    id: hashToken(refreshToken),
    userId,
    kind: "refresh",
    expiresAt: isoIn(REFRESH_TOKEN_TTL_SECONDS, now),
  });
  return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
}

/**
 * The account a bearer token names, if the token is one this server would still accept.
 *
 * Undefined for every way a token can be wrong — absent, malformed, unknown, expired, revoked,
 * or belonging to an account that has since been disabled — because the gate turns all of them
 * into the same 401. Distinguishing them would tell a caller which of its guesses was closest,
 * and "disabled" in particular is answered by the login route (with the correct password) and
 * not here.
 */
export function currentUser(
  request: FastifyRequest,
  db: AppDb,
  now: Date = new Date()
): UserRecord | undefined {
  const token = bearerToken(request);
  if (!token) return undefined;
  return resolveToken(db, token, "access", now);
}

/** The account a refresh token names, or undefined. Used only by the refresh route. */
export function userForRefreshToken(
  db: AppDb,
  token: string,
  now: Date = new Date()
): UserRecord | undefined {
  return resolveToken(db, token, "refresh", now);
}

function resolveToken(
  db: AppDb,
  token: string,
  kind: "access" | "refresh",
  now: Date
): UserRecord | undefined {
  const row = db.getAuthToken(hashToken(token));
  // The kind check is not redundant with the two callers above: without it either token would
  // work in the other's place, and a week-long refresh token would be a week-long API
  // credential — which is the thing the short access token exists to prevent.
  if (!row || row.kind !== kind) return undefined;
  if (row.revokedAt) return undefined;
  if (row.expiresAt <= now.toISOString()) return undefined;

  const user = db.getUser(row.userId);
  if (!user || user.disabled) return undefined;

  // Recorded at most hourly rather than per request. This is a write, and a write on every
  // `GET` would turn a read-mostly SQLite file into one that grows its WAL on every poll —
  // for a field nothing but diagnostics reads. An hour is fine for "when was this last used".
  const staleAfter = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  if (!row.lastUsedAt || row.lastUsedAt < staleAfter) db.touchAuthToken(row.id, now.toISOString());

  return user;
}

/** The token from an `Authorization: Bearer …` header, or undefined if there is not one. */
export function bearerToken(request: FastifyRequest): string | undefined {
  const raw = request.headers[AUTHORIZATION_HEADER];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header) return undefined;
  // Case-insensitive scheme, because the header's scheme is case-insensitive by RFC 7235 and
  // a client that sent `bearer` is not making a mistake worth refusing.
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

/**
 * End every session an account holds.
 *
 * The console's kick, and the thing to reach for when a credential has leaked. One statement
 * over the account's own rows, so it does not disturb anybody else — and because the gate
 * consults the database on every request, it takes effect on the next one rather than at the
 * next restart.
 */
export function revokeAllTokens(db: AppDb, userId: string, now: Date = new Date()): number {
  return db.revokeUserTokens(userId, now.toISOString());
}

/* --------------------------------- the panel --------------------------------- */

/**
 * The environment variable the control panel puts a launch-scoped secret in.
 *
 * The panel is the only thing that can recover a forgotten administrator password, because
 * by definition nobody is signed in when it is needed. It is not a back door for a different
 * reason than it looks: the secret is generated per launch, passed only to the child process
 * the panel itself spawned, and never written anywhere. Reaching the server from the network
 * does not get you one, and restarting the panel invalidates the old one.
 */
export const PANEL_TOKEN_ENV = "ILA_PANEL_TOKEN";

/** The header that secret travels in. Not `Authorization` — this is not a user's credential. */
export const PANEL_TOKEN_HEADER = "x-ila-panel-token";

export function panelToken(): string | undefined {
  const value = process.env[PANEL_TOKEN_ENV];
  return value && value.length > 0 ? value : undefined;
}

/**
 * Whether a presented secret is the panel's.
 *
 * Compared in constant time, and false for every way either side can be missing — no panel
 * token configured, no header sent, different lengths. The length check before
 * `timingSafeEqual` gives nothing away: a secret's length is not the part that is secret, and
 * `timingSafeEqual` throws on unequal buffers rather than answering.
 */
export function panelTokenMatches(provided: string | undefined): boolean {
  const expected = panelToken();
  if (!expected || !provided) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/* ---------------------------------- accounts --------------------------------- */

/**
 * Re-exported rather than re-implemented. The predicate moved to `@ilearnassist/shared` when the
 * console grew a second tier, because the page and the routes have to ask the *same* question —
 * see the note on `isSuperadmin` there. Call sites on this side are unchanged.
 */
export { isSuperadmin } from "@ilearnassist/shared";

/* ------------------------------ credential policy ----------------------------- */

/** A username from a request body or a command line, trimmed, or the empty string. */
export const readUsername = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

export const readPassword = (value: unknown): string =>
  typeof value === "string" ? value : "";

/**
 * Why a password cannot be accepted, or undefined.
 *
 * The length bounds are the whole of the policy, and deliberately: composition rules ("one
 * capital, one digit") measurably push people towards worse passwords and are not worth the
 * sentence they cost. `PASSWORD_MIN_LENGTH` is what the console's generated password already
 * exceeds, so a person who keeps what they were given passes.
 *
 * The upper bound exists because `scrypt` is linear in the input's length and the sign-in
 * route is one place an unauthenticated caller chooses how much work the server does.
 *
 * Its return code is narrowed to `CredentialErrorCode`, not the whole `ApiErrorCode`: these
 * five are all this rule can produce, and the CLI's envelope and the panel's catalog are
 * checked against that closed set.
 */
export function passwordProblem(plain: string): CodedErrorBody<CredentialErrorCode> | undefined {
  if (!plain) return apiError("PASSWORD_REQUIRED", "a password is required");
  if (plain.length < PASSWORD_MIN_LENGTH) {
    return apiError("PASSWORD_TOO_SHORT", "password is too short", { min: PASSWORD_MIN_LENGTH });
  }
  if (plain.length > PASSWORD_MAX_LENGTH) {
    return apiError("PASSWORD_TOO_LONG", "password is too long", { max: PASSWORD_MAX_LENGTH });
  }
  return undefined;
}

/** Why a username cannot be accepted, or undefined. */
export function usernameProblem(username: string): CodedErrorBody<CredentialErrorCode> | undefined {
  if (!username) return apiError("USERNAME_REQUIRED", "username is required");
  if (username.length > USERNAME_MAX_LENGTH) {
    return apiError("USERNAME_TOO_LONG", "username is too long", { max: USERNAME_MAX_LENGTH });
  }
  return undefined;
}

/**
 * An account as the client is allowed to see it.
 *
 * The *only* way a `UserRecord` becomes a `User`, and the reason it is a function rather than
 * a spread at each call site: a route that returned the record directly would serialise the
 * password hash. Naming the fields that travel means a new column is private until somebody
 * deliberately adds it, which is the same fail-closed move the auth gate makes.
 */
export function toWireUser(record: UserRecord): User {
  return {
    id: record.id,
    username: record.username,
    slug: record.slug,
    roles: record.roles,
    mustChangePassword: record.mustChangePassword,
    createdAt: record.createdAt,
  };
}

/**
 * Bring an account into being, with its tree on disk.
 *
 * The one place an account is created — the first-run route and the console's create route
 * both come through here, so "what an account is" has a single answer. The name is matched
 * case-insensitively by the caller (`findUserByUsername`), so "Ada" and "ada" are one person
 * rather than two accounts that look identical in the console.
 *
 * The slug is chosen once and stored; a later change to the username does not move the
 * directory, for the same reason a workspace's rename does not — every path in the user's
 * workspaces is built on it. Uniqueness is checked against the database first and the
 * filesystem second: the column is `UNIQUE`, and a filesystem-only check races two creates
 * arriving at the same instant.
 */
export function createAccountRow(
  db: AppDb,
  root: DataLayout,
  input: {
    username: string;
    roles: UserRole[];
    passwordHash: string;
    mustChangePassword: boolean;
  }
): UserRecord {
  const slug = uniqueUserSlug(
    input.username,
    (candidate) =>
      db.listUsers().some((u) => u.slug === candidate) ||
      // The filesystem is only a backstop for a tree created by hand or left by a database
      // that is gone; the database is the authority.
      existsSync(join(root.usersRoot, candidate))
  );
  return db.createUser({
    id: newId(),
    username: input.username,
    slug,
    roles: input.roles,
    passwordHash: input.passwordHash,
    mustChangePassword: input.mustChangePassword,
  });
}

/**
 * The row and the tree, in that order.
 *
 * Split from `createAccountRow` because the administrator CLI has to write the row inside a
 * transaction — two of them racing would otherwise both pass the "is there an administrator"
 * check — and a transaction must not contain a `mkdir`. The tree is created afterwards and
 * **self-heals**: `ensureUserLayout` is `mkdirSync(recursive)`, and every path into a user's
 * tree creates what it needs, so a process that dies between the two leaves a row whose
 * directories appear the first time anything touches them.
 */
export function createAccount(
  db: AppDb,
  root: DataLayout,
  input: {
    username: string;
    roles: UserRole[];
    passwordHash: string;
    mustChangePassword: boolean;
  }
): { user: UserRecord; tree: UserLayout } {
  const user = createAccountRow(db, root, input);
  const tree = userLayout(root, user.slug);
  ensureUserLayout(tree);
  return { user, tree };
}
