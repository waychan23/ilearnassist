import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Which routes the session write lock covers — asserted from the source, in both directions.
 *
 * The gate itself is a route *config* flag (`requiresSessionLock`), and that is the right shape:
 * one hook, one behaviour, and the interesting decision readable in one place. What it cannot do
 * is notice a route that should carry the flag and does not — that route compiles, serves, and
 * quietly accepts writes from a client that holds nothing. `session-locks.test.ts` proves the
 * flag does what it says on real requests; this file is the other half, proving the flag is on
 * the right routes, and it is the half no request can prove.
 *
 * Read from the source rather than from Fastify's router, because `printRoutes` collapses routes
 * that share a path into one line and does not expose the config at all. The i18n guards read
 * source for the same reason and get the same benefit: a route added tomorrow is covered without
 * anybody remembering this file exists.
 */

const SOURCE = readFileSync(new URL("../src/routes.ts", import.meta.url), "utf8");

/**
 * Every `app.<verb>("/api/sessions/…")` declaration, with the text between the path and the
 * handler — which is where the options object goes, and therefore the only place the flag can be.
 *
 * Lazy up to the first `async (`: a declaration either passes options or goes straight into the
 * handler, so that slice is exactly "the options this route was registered with".
 */
const DECLARATIONS = [
  ...SOURCE.matchAll(
    /app\.(get|post|patch|put|delete)\(\s*"(\/api\/sessions\/[^"]+)"([\s\S]*?)async \(/g
  ),
].map((m) => ({ method: m[1]!.toUpperCase(), path: m[2]!, options: m[3]! }));

/**
 * The routes that write to one conversation, and therefore must hold its lock.
 *
 * Every write, so that "read-only" means what it says on the other client. `PATCH` and `DELETE`
 * on the conversation itself are in, because renaming or deleting the thing somebody else is
 * editing is exactly the interleaving this exists to prevent.
 */
const MUST_BE_GATED = [
  "PATCH /api/sessions/:id",
  // A pin is visible to the account's other clients the moment it lands, which is the same claim
  // a rename makes — so it holds the same lock.
  "PATCH /api/sessions/:id/pin",
  "DELETE /api/sessions/:id",
  "DELETE /api/sessions/:id/messages/:messageId",
  "PUT /api/sessions/:id/widgets/:widgetId",
  "POST /api/sessions/:id/plan/nodes/:nodeId/jump",
  "POST /api/sessions/:id/quizzes/:quizId/answer",
  "POST /api/sessions/:id/notes",
  "PATCH /api/sessions/:id/notes/:noteId",
  "DELETE /api/sessions/:id/notes/:noteId",
  "POST /api/sessions/:id/insights/generate",
  "PATCH /api/sessions/:id/insights/:insightId",
  "DELETE /api/sessions/:id/insights/:insightId",
  "POST /api/sessions/:id/resources",
  "POST /api/sessions/:id/chat",
  "POST /api/sessions/:id/answers",
  "POST /api/sessions/:id/regenerate",
  "POST /api/sessions/:id/stop",
];

/**
 * The session routes that deliberately do **not**, each for its own reason.
 *
 * Listed rather than merely allowed, so that a route which *should* be gated and is not has to be
 * added here on purpose — which is a sentence somebody has to justify in review, rather than an
 * omission nobody sees.
 */
const EXEMPT = [
  // Taking the lock cannot require the lock.
  "POST /api/sessions/:id/lock",
  "DELETE /api/sessions/:id/lock",
  // The release lands here, and the titler retry rides it, so it must always work.
  "POST /api/sessions/:id/leave",
  // Derived rows kept up to date idempotently: not the user's writing, and a conflict there is
  // a no-op rather than a lost edit.
  "POST /api/sessions/:id/threads/sync",
  // Reads. A client has to be able to *see* a conversation it may not write to — that is what
  // makes the refusal a read-only conversation rather than an error.
  "GET /api/sessions/:id/messages",
  "GET /api/sessions/:id/widgets",
  "GET /api/sessions/:id/stats",
  "GET /api/sessions/:id/plan",
  "GET /api/sessions/:id/plan/versions/:version",
  "GET /api/sessions/:id/quizzes",
  "GET /api/sessions/:id/threads",
  "GET /api/sessions/:id/diagrams",
  "GET /api/sessions/:id/tables",
  "GET /api/sessions/:id/notes",
  "GET /api/sessions/:id/insights",
  "GET /api/sessions/:id/files",
  "GET /api/sessions/:id/files/content",
  "GET /api/sessions/:id/files/raw",
  "GET /api/sessions/:id/resources",
];

const declared = DECLARATIONS.map((d) => `${d.method} ${d.path}`);

describe("the session write-lock coverage", () => {
  it("finds the session routes at all", () => {
    // The guard on the guard: a regex that stopped matching would make every assertion below
    // vacuously true, which is the one failure mode a source scan has.
    expect(DECLARATIONS.length).toBeGreaterThan(30);
  });

  it("gates every session-scoped write", () => {
    const ungated = DECLARATIONS.filter(
      (d) => !/requiresSessionLock/.test(d.options) && !EXEMPT.includes(`${d.method} ${d.path}`)
    ).map((d) => `${d.method} ${d.path}`);

    expect(ungated).toEqual([]);
    // And the other direction: every name on the expected list is a route that exists, so a
    // rename cannot silently leave a stale entry standing in for the real one.
    expect(MUST_BE_GATED.filter((name) => !declared.includes(name))).toEqual([]);
  });

  it("exempts exactly the routes it means to", () => {
    // A route that *has* the flag while sitting on the exempt list is a contradiction to fix
    // rather than tolerate: the list would read as permission for something it is not.
    const both = EXEMPT.filter(
      (name) =>
        declared.includes(name) &&
        DECLARATIONS.some(
          (d) => `${d.method} ${d.path}` === name && /requiresSessionLock/.test(d.options)
        )
    );
    expect(both).toEqual([]);
    expect(EXEMPT.filter((name) => !declared.includes(name))).toEqual([]);
  });

  it("gates nothing outside the session routes", () => {
    // The flag reads the session id from `params.id`, so a route elsewhere wearing it would gate
    // itself on whatever `:id` it happens to have — which is how `/api/resources/:id/reparse` would
    // end up requiring a lock from a conversation that has nothing to do with it.
    const elsewhere = [
      ...SOURCE.matchAll(/app\.(get|post|patch|put|delete)\(\s*"(\/api\/(?!sessions\/)[^"]+)"([\s\S]*?)async \(/g),
    ]
      .filter((m) => /requiresSessionLock/.test(m[3]!))
      .map((m) => `${m[1]!.toUpperCase()} ${m[2]!}`);

    expect(elsewhere).toEqual([]);
  });
});
