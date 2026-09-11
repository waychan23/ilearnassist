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
    // Vitest stubs CSS by default, so a `.css` file read with `?raw` comes back as an
    // empty string. `test/style.test.ts` parses `src/style.css` as text (jsdom will not
    // resolve custom properties, so the contrast invariant can only be checked at the
    // source), and needs the real content. Nothing else here imports CSS, so this costs
    // nothing today.
    css: true,
  },
});
