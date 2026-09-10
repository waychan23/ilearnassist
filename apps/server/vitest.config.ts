import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "server",
    environment: "node",
    include: ["test/**/*.test.ts"],
    // better-sqlite3 is a native module and every test file gets its own temp
    // database directory; separate processes keep those handles from interfering.
    pool: "forks",
  },
});
