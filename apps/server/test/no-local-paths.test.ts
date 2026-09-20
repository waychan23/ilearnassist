import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * No tracked file names a real home directory — asserted against everything git publishes.
 *
 * This repository is open source, and a machine path is the kind of detail that gets written into
 * a doc without anybody deciding to publish it: it is the shortest way to say "the clone lives
 * over there", and it reads as harmless. It is not — it names a person, and it is wrong for every
 * reader. Two of them had accumulated by the time this guard was written (`CLAUDE.md` and
 * `docs/reference.md`, both naming the local chatbox clone), and the fix for each was a sentence
 * somebody had to write, which is exactly the kind of thing a guard should be asking for.
 *
 * **What this cannot do is fail in CI, and that is worth stating rather than discovering.** The
 * leak only exists on the machine it describes. A CI runner clones fresh, so it sees no personal
 * path at all and this test passes there whatever the author's checkout contains. The run that has
 * value is the local `pnpm test` before committing — the same role this repo already gives the
 * suite. Treat it as a pre-commit gate, not a safety net.
 *
 * Enumerated from `git ls-files` rather than from a directory walk, because "tracked" is precisely
 * the set that gets published: it excludes `CLAUDE.local.md`, `docs/local/`, `.env`, `data/` and
 * `node_modules/` without a second copy of the ignore rules to keep in agreement with
 * `.gitignore` — the same reason `route-lock-coverage.test.ts` reads the source rather than the
 * router.
 */

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

/**
 * Every tracked file, as repo-relative paths.
 *
 * `-z` rather than newline-splitting, for the reason the file browser uses a query parameter:
 * paths legitimately contain spaces (and quotes, and CJK), and a name that broke the split would
 * silently stop being scanned — a guard that skips a file without saying so.
 */
const TRACKED = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

/**
 * Extensions whose bytes are not text, skipped before they are read.
 *
 * The committed demos under `docs/assets/` are the reason this exists. One of them —
 * `first-run.zh.gif` — really does render a home path, because the control panel's first-run card
 * prints the resolved default data folder. That was raised and **deliberately kept**: the author
 * was asked and said it did not matter. A guard that flags a file the owner has consciously kept
 * gets turned off within a week, and it takes the checks that matter with it. So binaries are out
 * of scope here by decision, not by oversight.
 */
const BINARY_EXTENSIONS = new Set([
  "gif", "png", "jpg", "jpeg", "webp", "ico", "icns", "pdf",
  "woff", "woff2", "ttf", "otf", "eot",
  "mp4", "mov", "webm", "zip", "gz", "dmg", "sqlite",
  "so", "dylib", "node", "wasm",
]);

/**
 * Home-directory names that are self-evidently made up.
 *
 * These are already load-bearing in the suite — `apps/desktop/test/launch.test.ts`,
 * `settings.test.ts` and `e2e/panel.spec.ts` all assert against `/Users/someone/…`, and
 * `apps/desktop/test/paths.test.ts` records why: a path the test owns is better than "whatever
 * `/Users/<whoever>` the suite happens to run as". That instinct is right and this guard is meant
 * to protect it, not to argue with it.
 *
 * **Keep this list as short as it is.** Every name on it is a name this guard will no longer
 * notice, so adding a real one is how the guard gets routed around — the same discipline the
 * `i18n-exempt` marker carries. If a name needs a justifying sentence, it does not belong here.
 */
const PLACEHOLDER_SEGMENTS = new Set(["someone", "me", "you", "user", "example", "runner", "whoever"]);

/**
 * A home-directory absolute path, capturing the segment that names the person.
 *
 * Deliberately *not* a ban on the username appearing anywhere: `waychan23` is in every
 * `package.json`'s `repository` field, both READMEs' badges and `git clone` lines, and the
 * releases API. That is public identity the product needs. What is private is a path.
 *
 * The segment excludes quotes, spaces and angle brackets so that prose about a path — notably
 * `paths.test.ts`'s `/Users/<whoever>` — is not mistaken for one.
 */
const HOME_PATH = /\/(?:Users|home)\/([^/\s"'`()<>]+)\//g;

/** An exemption, for a line that must name a home path and has said why. */
const EXEMPT = /local-path-exempt:/;

interface Violation {
  file: string;
  line: number;
  text: string;
  found: string;
}

function isBinary(file: string): boolean {
  const extension = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  return BINARY_EXTENSIONS.has(extension);
}

function violationsIn(file: string): Violation[] {
  const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
  const found: Violation[] = [];

  for (const [index, text] of lines.entries()) {
    // The marker is read from the line and the one above it, so it can be a trailing comment or a
    // comment of its own — the same latitude `no-hardcoded-text.test.ts` allows `i18n-exempt`.
    if (EXEMPT.test(text) || EXEMPT.test(lines[index - 1] ?? "")) continue;

    for (const match of text.matchAll(HOME_PATH)) {
      if (PLACEHOLDER_SEGMENTS.has(match[1]!)) continue;
      found.push({ file, line: index + 1, text: text.trim(), found: match[0] });
    }
  }

  return found;
}

describe("no tracked file names a home directory", () => {
  it("has files to check", () => {
    // Guards the guard: a broken `git ls-files` call, or a suite run from outside the repository,
    // would otherwise leave every assertion below passing over an empty list.
    expect(TRACKED.length).toBeGreaterThan(100);
    expect(TRACKED).toContain("CLAUDE.md");
  });

  it("keeps machine paths out of everything git publishes", () => {
    const violations = TRACKED.filter((file) => !isBinary(file)).flatMap(violationsIn);

    expect(
      violations.map((v) => `${v.file}:${v.line}  ${v.found}\n    ${v.text}`)
    ).toEqual([]);
  });

  it("does not let the placeholder list grow quietly", () => {
    // A real name here would silence the guard for whoever owns it, which is the one edit that
    // could make this file useless while leaving it green.
    expect([...PLACEHOLDER_SEGMENTS].sort()).toEqual([
      "example", "me", "runner", "someone", "user", "whoever", "you",
    ]);
  });
});
