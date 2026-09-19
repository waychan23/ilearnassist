import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../src/schema.js";
import { APP_VERSION } from "../src/version.js";

/**
 * The one number that three things have to agree about, and none of which can see the others.
 *
 * `APP_VERSION` is reported by `/api/health`; the release workflow tags a commit and builds
 * installers; electron-builder expands `${version}` into the artefact's filename and into the
 * DMG's title. Only the middle one is a decision a person makes, and a monorepo whose packages
 * drift produces an installer named after one number and an app that reports another — which is
 * discovered by a user, at the moment they are telling you which version they run.
 *
 * The package's own `package.json` is the source (`version.ts` imports it, and esbuild inlines
 * it), so this test is what makes "all five are equal" a fact rather than a hope.
 */

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");

const PACKAGES = [
  "package.json",
  "apps/server/package.json",
  "apps/web/package.json",
  "apps/desktop/package.json",
  "packages/shared/package.json",
];

function versionOf(relativePath: string): string | undefined {
  const raw = JSON.parse(readFileSync(join(repoRoot, relativePath), "utf8")) as {
    name?: string;
    version?: string;
  };
  return raw.version;
}

describe("the app version", () => {
  it("is the same in every package, which is what the release tag matches", () => {
    const versions = PACKAGES.map((path) => [path, versionOf(path)] as const);
    const [first, ...rest] = versions;
    expect(first![1], `${first![0]} has no version`).toBeTruthy();

    for (const [path, version] of rest) {
      expect(version, `${path} disagrees with ${first![0]}`).toBe(first![1]);
    }
  });

  it("is what the server reports, so a deployment can ask what it is running", () => {
    // The constant is imported from `package.json`, so this pins the wiring rather than the value:
    // a refactor that read the wrong file would leave `/api/health` reporting someone else's
    // version, which is worse than reporting none.
    expect(APP_VERSION).toBe(versionOf("apps/server/package.json"));
  });

  it("looks like a version a tag and a filename can carry", () => {
    // `v0.1.0` is the tag, `${productName}-${version}-${os}-${arch}.${ext}` is the artefact, and
    // electron-builder needs the number to be a plain semver. A space or a leading `v` here would
    // produce a filename nobody meant.
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("is independent of the schema version, which moves on its own", () => {
    // Stated so nobody ties them together: they change for different reasons, and a build that
    // adds a migration is not a release that changes the app's version (nor the reverse).
    expect(typeof SCHEMA_VERSION).toBe("number");
    expect(SCHEMA_VERSION).toBeGreaterThan(0);
  });
});
