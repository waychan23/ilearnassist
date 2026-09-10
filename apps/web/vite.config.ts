import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

/** Set by the Playwright run so its dev server cannot collide with a `pnpm dev` one. */
const e2ePort = process.env.GL_WEB_PORT;

export default defineConfig({
  plugins: [vue()],
  server: {
    // Pinned and strict only when the e2e asks for it: if that port is taken the run must
    // fail loudly rather than silently testing whatever is on the next free port.
    ...(e2ePort ? { port: Number(e2ePort), strictPort: true } : { port: 5173 }),
    proxy: {
      // Forward API calls to the Fastify server; also mirrors a production reverse proxy.
      // `GL_SERVER_PORT` lets the e2e run point at its own server instance instead of a
      // stray `pnpm dev` one.
      "/api": {
        target: `http://127.0.0.1:${process.env.GL_SERVER_PORT ?? 3720}`,
        changeOrigin: true,
      },
    },
  },
});