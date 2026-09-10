import { defineConfig, devices } from "@playwright/test";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Browser end-to-end run.
 *
 * Three processes are started, all of them local and offline:
 *   1. the fake OpenAI-compatible LLM  (`apps/server/test/helpers/fakeLlm.ts`)
 *   2. the real guided-learning server, pointed at that fake and at a throwaway
 *      database under `.e2e/`
 *   3. the Vite dev server, which proxies `/api` to (2)
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

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

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
      command: "pnpm --filter @guided-learning/server start",
      port: SERVER_PORT,
      env: {
        GL_DATA_DIR: join(E2E_DIR, "data"),
        GL_CONFIG_PATH: join(ROOT, "e2e", "config.local.yaml"),
        GL_SERVER_PORT: String(SERVER_PORT),
        GL_FAKE_LLM_URL: `http://127.0.0.1:${FAKE_LLM_PORT}/v1`,
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
