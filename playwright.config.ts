import { defineConfig, devices } from "@playwright/test";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Browser end-to-end run.
 *
 * Four processes are started, all of them local and offline:
 *   1. the fake OpenAI-compatible LLM  (`apps/server/test/helpers/fakeLlm.ts`)
 *   2. a fake cloud document parser    (`apps/server/test/helpers/fakeParser.ts`)
 *   3. the real guided-learning server, pointed at both fakes and at a throwaway
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
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], locale: "zh-CN" } }],

  webServer: [
    {
      command: "pnpm --filter @guided-learning/server fake-llm",
      port: FAKE_LLM_PORT,
      env: { FAKE_LLM_PORT: String(FAKE_LLM_PORT) },
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "pnpm --filter @guided-learning/server fake-parser",
      port: FAKE_PARSER_PORT,
      env: { FAKE_PARSER_PORT: String(FAKE_PARSER_PORT) },
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "pnpm --filter @guided-learning/server start",
      port: SERVER_PORT,
      env: {
        GL_DATA_DIR: join(E2E_DIR, "data"),
        GL_CONFIG_PATH: join(ROOT, "e2e", "config.local.yaml"),
        GL_SERVER_PORT: String(SERVER_PORT),
        GL_FAKE_LLM_URL: `http://127.0.0.1:${FAKE_LLM_PORT}/v1`,
        GL_FAKE_PARSER_URL: `http://127.0.0.1:${FAKE_PARSER_PORT}`,
      },
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "pnpm --filter @guided-learning/web dev",
      port: WEB_PORT,
      env: { GL_SERVER_PORT: String(SERVER_PORT), GL_WEB_PORT: String(WEB_PORT) },
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});

export { E2E_DIR };
