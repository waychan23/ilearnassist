import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      // Forward API calls to the Fastify server; also mirrors a production reverse proxy.
      "/api": {
        target: "http://127.0.0.1:3720",
        changeOrigin: true,
      },
    },
  },
});