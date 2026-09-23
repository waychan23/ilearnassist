import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

/** Set by the Playwright run so its dev server cannot collide with a `pnpm dev` one. */
const e2ePort = process.env.ILA_WEB_PORT;

export default defineConfig({
  plugins: [vue()],
  optimizeDeps: {
    /*
     * Pre-bundle mermaid at server start rather than on first use.
     *
     * It is a ~1 MB package of some two hundred modules, imported dynamically so that it never
     * touches the initial load. Without this, Vite transforms all of them the first time a
     * diagram appears — which in the browser suite is that spec's first assertion, and a cold
     * transform there is the difference between a pass and a timeout. In `pnpm dev` it is a
     * visible stall on the first diagram of the session.
     *
     * `@open-file-viewer/core` is here for exactly the same reason and it is the worse case of
     * the two: one entry point over ~25 runtime dependencies, so a cold transform of it is a
     * cold transform of every one of them. It is behind a dynamic import too, and the browser
     * suite's first viewer assertion is where that would otherwise be paid.
     */
    include: ["mermaid", "@open-file-viewer/core"],
  },
  server: {
    // Pinned and strict only when the e2e asks for it: if that port is taken the run must
    // fail loudly rather than silently testing whatever is on the next free port.
    ...(e2ePort ? { port: Number(e2ePort), strictPort: true } : { port: 5173 }),
    proxy: {
      // Forward API calls to the Fastify server; also mirrors a production reverse proxy.
      // `ILA_SERVER_PORT` lets the e2e run point at its own server instance instead of a
      // stray `pnpm dev` one.
      "/api": {
        target: `http://127.0.0.1:${process.env.ILA_SERVER_PORT ?? 10471}`,
        changeOrigin: true,
      },
    },
  },
});