import { existsSync } from "node:fs";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

/**
 * Serve the built frontend (`apps/web/dist`) from the same origin as the API.
 *
 * Without this the production build is unreachable: `pnpm build` writes a `dist/` that
 * nothing serves, so the only way to use the app is the Vite dev server with its `/api`
 * proxy in front of a separate backend. Serving both from one origin removes the proxy
 * from the deployment story entirely — which is also what lets the desktop shell open a
 * single URL and get a working app.
 *
 * Registration is **conditional on an `index.html` existing**. A missing build is a
 * normal state (a fresh checkout, or a test run that never ran `pnpm build`), and the
 * server has to stay API-only in that case rather than answering `/` with a 404 that
 * looks like a broken deployment.
 *
 * Deliberately no history-mode fallback: the SPA has no router, so every URL it owns is
 * `/`, and a catch-all handler would have to either shadow `/api` or reimplement
 * Fastify's 404 envelope. Should a router ever land, that is the change to revisit.
 */
export async function registerWebApp(app: FastifyInstance, webDir?: string): Promise<boolean> {
  if (!hasBuiltWebApp(webDir)) return false;

  await app.register(fastifyStatic, { root: webDir });
  return true;
}

/** Whether `webDir` holds a servable frontend. Exported so `buildServer` can report it. */
export function hasBuiltWebApp(webDir: string | undefined): webDir is string {
  return Boolean(webDir) && existsSync(join(webDir as string, "index.html"));
}
