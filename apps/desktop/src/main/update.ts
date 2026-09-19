/**
 * Whether a newer release exists, asked of GitHub.
 *
 * **The check belongs to the panel rather than to the server**, and the reason is what is being
 * upgraded: the server's schema is migrated by the code that opens it, but the *application* is
 * the thing a user replaces. Putting this in the server would also give it a new outbound call,
 * and this codebase is deliberate about those (see `web_fetch`'s SSRF guard) — the panel already
 * talks to the outside world for nothing else, so this is one place to reason about instead of
 * two.
 *
 * Four rules, and each is a decision:
 *
 * - **It never throws.** Every failure — no network, a rate limit, a proxy that answers HTML, a
 *   response that is not the shape we expect — is "we do not know", which is the same answer as an
 *   update not existing for the purposes of the UI. A control panel that shows a red error because
 *   a version check failed is worse than one that says nothing.
 * - **It has a short timeout.** Five seconds, and it is never awaited by anything the user is
 *   waiting for: the panel renders immediately and adopts the answer when it arrives.
 * - **The version comparison is numeric, not string.** `0.10.0` is newer than `0.9.0`, and any
 *   comparison that is not a tuple comparison reports the opposite. A dev build ahead of the
 *   published release must not be told it is behind.
 * - **`updateAvailable` is only true for a strictly newer release.** Re-running the same version
 *   is not news, and neither is a locally built one that is ahead.
 *
 * **No `electron-updater`, deliberately** (see `docs/desktop.md`). On macOS an update can only be
 * *installed* by a code-signed app, and this one is ad-hoc signed — Squirrel.Mac would download the
 * release and then refuse it. So the panel says a new version exists and opens the download page;
 * the user replaces the app the way they installed it. That works identically on all three
 * platforms, which is worth more than an install button that only works on two of them.
 */

/** Where releases are published. Matches `repository` in `package.json` and the release workflow. */
export const RELEASES_API = "https://api.github.com/repos/waychan23/ilearnassist/releases/latest";

/** Where a user is sent to download. GitHub's own page rather than a direct asset link. */
export const RELEASES_PAGE = "https://github.com/waychan23/ilearnassist/releases/latest";

export const UPDATE_TIMEOUT_MS = 5_000;

export interface UpdateCheck {
  /** The published version, without its leading `v`. Null when the check could not answer. */
  latest: string | null;
  /** Where to download it, or null when there is nothing to say. */
  url: string | null;
  /** True only for a strictly newer release than `current`. */
  available: boolean;
}

const NOTHING: UpdateCheck = { latest: null, url: null, available: false };

/**
 * A version as three numbers, or null for anything that is not one.
 *
 * Deliberately strict: the tag is ours, and a tag that is not `x.y.z` is a mistake worth failing
 * quietly on rather than guessing at. A pre-release suffix (`0.2.0-beta.1`) compares as `0.2.0`,
 * which is the right answer for "is there something newer to look at" — the panel is telling
 * somebody a release exists, not choosing an artefact.
 */
export function parseVersion(raw: unknown): [number, number, number] | null {
  if (typeof raw !== "string") return null;
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Whether `candidate` is strictly newer than `current`. Unparseable either side is "no". */
export function isNewer(candidate: string | null, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return false;
}

export interface CheckForUpdateOptions {
  current: string;
  /** Injected so a test can drive the whole thing with no network. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Ask GitHub for the latest release. Resolves; never rejects.
 *
 * The only field it trusts is `tag_name` (with `html_url` for the link), because those are the two
 * the panel renders. A response missing either is treated as no answer rather than as "no update",
 * which matters for the caller that caches the result: caching "no update" from a malformed reply
 * would suppress the next launch's check as well.
 */
export async function checkForUpdate(options: CheckForUpdateOptions): Promise<UpdateCheck> {
  const { current, fetchImpl = fetch, timeoutMs = UPDATE_TIMEOUT_MS } = options;

  try {
    const response = await fetchImpl(RELEASES_API, {
      headers: {
        Accept: "application/vnd.github+json",
        // GitHub rejects requests without one, and a self-identifying agent is the polite default.
        "User-Agent": "ilearnassist-control-panel",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return NOTHING;

    const body = (await response.json()) as { tag_name?: unknown; html_url?: unknown };
    const latest = typeof body.tag_name === "string" ? body.tag_name.replace(/^v/, "") : null;
    const url = typeof body.html_url === "string" ? body.html_url : RELEASES_PAGE;
    if (!latest) return NOTHING;

    return { latest, url, available: isNewer(latest, current) };
  } catch {
    // Offline, DNS, a timeout, a body that is not JSON. All of them mean "we do not know", and the
    // panel treats that the same as "nothing to report" — silently, because a version check is not
    // something the user asked for.
    return NOTHING;
  }
}
