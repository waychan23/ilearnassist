import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  test: {
    name: "web",
    // jsdom deliberately leaves Node's `fetch`/`Response`/`ReadableStream` globals in
    // place. `api/client.ts` streams responses via `body.getReader()` + a streaming
    // `TextDecoder`, so it must run against the same implementations the browser gets.
    environment: "jsdom",
    include: ["test/**/*.test.ts"],
  },
});
