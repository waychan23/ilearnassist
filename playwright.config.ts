import { defineConfig, devices } from "@playwright/test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AUTH_STATE, SIGNED_IN_AS, SIGNED_IN_PASSWORD } from "./e2e/auth.js";

/**
 * Browser end-to-end run.
 *
 * Four processes are started, all of them local and offline:
 *   1. the fake OpenAI-compatible LLM  (`apps/server/test/helpers/fakeLlm.ts`)
 *   2. a fake cloud document parser    (`apps/server/test/helpers/fakeParser.ts`)
 *   3. the real ilearnassist server, pointed at both fakes and at a throwaway
 *      database under `.e2e/`
 *   4. the Vite dev server, which proxies `/api` to (3)
 *
 * Ports are deliberately offset from `pnpm dev` (3720 / 5173) so a dev server can stay
 * running while the suite executes, and `reuseExistingServer` is off everywhere — this
 * config must never silently test whatever happens to be listening.
 */

const ROOT = fileURLToPath(new URL(".", import.meta.url));

// Offset well clear of the defaults (3720 / 5173) so a `pnpm dev` server can keep running
// while the suite executes — Vite auto-increments its port when one is taken, so a
// neighbouring port is not safe to assume free.
const FAKE_LLM_PORT = 3898;
const SERVER_PORT = 3899;
const WEB_PORT = 5199;
// A stand-in for a cloud document parser, so the cloud half of the parsing policy is
// exercised in a browser too — including the failure path that makes it worth having.
const FAKE_PARSER_PORT = 3897;

/** Scratch space for this run: sqlite database, uploads and workspace directories. */
const E2E_DIR = join(ROOT, ".e2e");

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  // The run writes a database under `.e2e/`; tear it down so repeated runs start clean.
  globalTeardown: "./e2e/global-teardown.ts",

  use: {
    // `localhost`, not `127.0.0.1`: Vite's default host is `localhost`, which on a
    // dual-stack machine binds `::1` only — an IPv4 literal is refused there.
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  // `locale` is pinned, not incidental. The app picks its language from
  // `navigator.languages`, and Chromium's default is en-US — so without this every spec
  // would render the English catalog and assert against Chinese text. Pinning it here (as
  // opposed to a per-spec `addInitScript` writing `gl-locale`) keeps the *detection* path
  // under test rather than bypassing it, and means a new spec inherits the pin instead of
  // having to remember it. `e2e/i18n.spec.ts` is where the other locales are exercised,
  // scoping its overrides to its own `describe` blocks.
  //
  // Split by filename rather than by a `grep`, so it is structural: the desktop specs ignore
  // `mobile.spec.ts` by name and need no edit, and an unlisted spec cannot be silently
  // claimed by both projects and run twice.
  //
  // What runs at phone size is deliberately *only* `mobile.spec.ts`. The desktop flows —
  // PDF upload, the settings tabs, a reload — are viewport-independent, so running them a
  // second time would buy runtime and flake rather than coverage.
  projects: [
    {
      /**
       * Signs in once and saves the cookie.
       *
       * A project of its own rather than a `globalSetup`, because a `globalSetup` may run
       * before the `webServer` entries are up and this has to reach one; `dependencies`
       * orders it after them by construction. Everything below depends on it and loads the
       * state it writes, which is what keeps the ~70 specs that are not about authentication
       * from having to know it exists.
       *
       * `testMatch` is stated because the filename is `auth.setup.ts`, which the default
       * glob (`*.spec.ts` / `*.test.ts`) does not match — so the other two projects do not
       * pick it up, and no `testIgnore` is needed to keep them off it.
       */
      name: "setup",
      testMatch: /.*\.setup\.ts/,
      use: { ...devices["Desktop Chrome"], locale: "zh-CN" },
    },
    {
      name: "chromium",
      testIgnore: /mobile\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"], locale: "zh-CN", storageState: AUTH_STATE },
      dependencies: ["setup"],
    },
    {
      // `Pixel 7` gives 412×915 with `hasTouch` and `isMobile`. The last of those is what
      // turns on meta-viewport emulation, which is what actually drives the responsive CSS —
      // without it the page renders at desktop width scaled down and nothing under test
      // would fire. `locale` is stated again rather than inherited: the desktop project
      // states it, and repeating it keeps the reason visible next to the pin.
      name: "mobile",
      testMatch: /mobile\.spec\.ts$/,
      use: {
        ...devices["Pixel 7"],
        locale: "zh-CN",
        hasTouch: true,
        isMobile: true,
        storageState: AUTH_STATE,
      },
      dependencies: ["setup"],
    },
  ],

  webServer: [
    {
      command: "pnpm --filter @ilearnassist/server fake-llm",
      port: FAKE_LLM_PORT,
      env: {
        FAKE_LLM_PORT: String(FAKE_LLM_PORT),
        /*
         * The fake provider enforces DeepSeek's thinking-mode rule — an assistant tool-call message
         * must carry a **non-empty** `reasoning_content` — so a flow that sends a blank one fails in
         * the browser suite rather than only against the in-process fake. It is the rule the reported
         * make-up failure came from, and a fake that accepts anything cannot fail that way.
         */
        FAKE_LLM_REQUIRE_REASONING: "1",
      },
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "pnpm --filter @ilearnassist/server fake-parser",
      port: FAKE_PARSER_PORT,
      env: { FAKE_PARSER_PORT: String(FAKE_PARSER_PORT) },
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      // The server refuses to listen without an administrator, so one has to exist before it
      // starts. That cannot be a `globalSetup` (Playwright starts every `webServer` first) and
      // cannot be a separate entry with no `port` (those return immediately and race). The
      // answer is chaining in the server entry's own command: `ensure-admin` is idempotent,
      // so a killed run that left `.e2e/data` behind is a no-op rather than a refusal, and
      // `&&` hands straight to `start`.
      command:
        `printf '%s\\n' '${SIGNED_IN_PASSWORD}' | ` +
        `pnpm --filter @ilearnassist/server cli ensure-admin --username ${SIGNED_IN_AS} --password-stdin && ` +
        `pnpm --filter @ilearnassist/server start`,
      port: SERVER_PORT,
      env: {
        ILA_DATA_DIR: join(E2E_DIR, "data"),
        ILA_CONFIG_PATH: join(ROOT, "e2e", "config.local.yaml"),
        ILA_SERVER_PORT: String(SERVER_PORT),
        ILA_FAKE_LLM_URL: `http://127.0.0.1:${FAKE_LLM_PORT}/v1`,
        ILA_FAKE_PARSER_URL: `http://127.0.0.1:${FAKE_PARSER_PORT}`,
      },
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "pnpm --filter @ilearnassist/web dev",
      port: WEB_PORT,
      env: { ILA_SERVER_PORT: String(SERVER_PORT), ILA_WEB_PORT: String(WEB_PORT) },
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});

export { E2E_DIR };
