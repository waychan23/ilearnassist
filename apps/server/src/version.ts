import { version } from "../package.json";

/**
 * The product version, as the release tag and the installer filename carry it.
 *
 * Read from this package's `package.json` and **inlined at build time** — `esbuild` resolves the
 * JSON import the same way it resolves `builtin.json`, so the number is in the bundle and the
 * packaged desktop app does not need a file beside it to know what it is. That is the whole reason
 * this is an `import` rather than a `readFileSync`: there is no `package.json` next to
 * `dist/server/index.mjs` in the app bundle.
 *
 * Every workspace's `version` is expected to be the same number, and a test asserts it
 * (`test/version.test.ts`). Three things have to agree about it and none of them can see the
 * others: the git tag that triggers a release, the `artifactName` electron-builder expands, and
 * this constant that `/api/health` reports. A monorepo where the packages drift is a release whose
 * installer says one number and whose app says another.
 */
export const APP_VERSION: string = version;
