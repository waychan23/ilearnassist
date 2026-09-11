import { defineConfig } from "vitest/config";

/**
 * Root Vitest entry point. Each workspace app owns its own `vitest.config.ts`
 * (node vs jsdom, its own include globs and Vite plugins), and is listed here by
 * directory so `pnpm test` from the repo root runs all three.
 */
export default defineConfig({
  test: {
    projects: ["apps/server", "apps/web", "apps/desktop"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "html", "lcov"],
      include: ["apps/*/src/**", "packages/*/src/**"],
      // Presentational components and the process entry points are exercised by the
      // Playwright suite instead — a separate browser process whose coverage cannot be
      // merged into this report. Measuring them here would only report a number nobody
      // is acting on; the e2e run is what proves they work.
      exclude: [
        "**/*.d.ts",
        "**/vite-env.d.ts",
        "**/*.vue",
        "apps/server/src/index.ts",
        "apps/web/src/main.ts",
        // The desktop package's process entry points, for the same reason: `main.ts` is
        // Electron window and menu wiring, and `panel.ts` is DOM bindings. Neither has a
        // branch worth a unit test, and both are exercised by launching the app.
        "apps/desktop/src/main/main.ts",
        "apps/desktop/src/renderer/panel.ts",
        "apps/desktop/scripts/**",
      ],
    },
  },
});
