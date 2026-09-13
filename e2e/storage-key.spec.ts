import { expect, test } from "./fixtures";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AUTH_STORAGE_KEY } from "./auth.js";

/**
 * The session's storage key, in the two places it is written down.
 *
 * `AUTH_STORAGE_KEY` lives in `packages/shared`, because the app writes it and this suite has
 * to *remove* it — which is the only way a spec can present itself as signed out, now that the
 * session is a token rather than a cookie.
 *
 * The copy in `auth.ts` exists because the root tsconfig does not resolve the workspace
 * package, so the suite is the second place the literal appears. Two spellings of one value is
 * the arrangement `composables/breakpoints.ts` already has with `style.css`: held in step by an
 * assertion rather than by a comment, because the failure is silent. A rename on one side that
 * the other did not follow would leave `forgetSession` removing a key nobody writes — and every
 * spec that uses it would go on passing, against a browser that is still signed in.
 *
 * No browser needed: this reads a file. It still belongs in the suite rather than in a unit
 * test, because this is the side that carries the copy.
 */

test("the suite's storage key matches the app's", () => {
  const shared = readFileSync(
    fileURLToPath(new URL("../packages/shared/src/index.ts", import.meta.url)),
    "utf8"
  );

  expect(shared).toContain(`export const AUTH_STORAGE_KEY = "${AUTH_STORAGE_KEY}"`);
});
