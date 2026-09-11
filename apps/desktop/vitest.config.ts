import { defineConfig } from "vitest/config";

/**
 * The desktop package's tests.
 *
 * Node environment, and nothing here imports `electron`. Everything worth asserting about
 * the control panel — where it puts its files, how it reads a server's startup line, what
 * it does when the server dies — lives in modules that take their inputs as arguments, so it
 * can be driven directly. What is left (window creation, menus, IPC wiring) is plumbing that
 * only a running Electron could test, and it is kept thin enough to read instead.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
