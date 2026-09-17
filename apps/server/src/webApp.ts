import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

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
 * ### The history fallback, which is what the router needed
 *
 * The app has URLs that name pages — `/w/<workspaceId>/s/<sessionId>` is a conversation —
 * and the browser asks the *server* for one of them on every reload, bookmark and pasted
 * link. There is no file at that path; the page is built from `index.html` and the id on
 * the end. So a request that is plainly a *page* is answered with the entry point and the
 * client router takes it from there, which is the one thing a single-page app's server has
 * to know. (`webApp.ts` used to say this was the change a router would call for, and it
 * was right.)
 *
 * Three restrictions keep that from becoming a catch-all that eats the API:
 *
 * - **`/api` is answered here too, and as JSON.** A missing endpoint must stay a 404 in the
 *   envelope the browser client parses, or a typo becomes a page that loads and then fails
 *   in a way with no message. (Fastify's default 404 body, reproduced; the shape is asserted
 *   in `test/web-app.test.ts`.)
 * - **Only what a browser navigates to.** `Accept: text/html` and a path with no file
 *   extension: a missing `/assets/app.js` is a real 404, because answering it with HTML
 *   would give the browser a page where it asked for a script and the failure would surface
 *   as a MIME error somewhere else entirely.
 * - **Only GET and HEAD.** A `POST` to a path that does not exist is a wrong request, not a
 *   page.
 *
 * Vite needs none of this: its dev server has served `index.html` for an unknown path since
 * `appType: "spa"` became the default, so only a packaged build goes through here.
 */
export async function registerWebApp(app: FastifyInstance, webDir?: string): Promise<boolean> {
  if (!hasBuiltWebApp(webDir)) return false;

  await app.register(fastifyStatic, { root: webDir });
  app.setNotFoundHandler(historyFallback());
  return true;
}

/** Whether `webDir` holds a servable frontend. Exported so `buildServer` can report it. */
export function hasBuiltWebApp(webDir: string | undefined): webDir is string {
  return Boolean(webDir) && existsSync(join(webDir as string, "index.html"));
}

/**
 * What the not-found handler does, given that a frontend is being served.
 *
 * `reply.sendFile` rather than a copy of the bytes read at registration: the file is the
 * build's, and a `pnpm build` landing under a running server should be served by the next
 * refresh rather than the next restart. `@fastify/static` owns the read and the MIME type.
 */
function historyFallback() {
  return (request: FastifyRequest, reply: FastifyReply) => {
    // The path without its query, which is what decides both questions below. `request.url`
    // is the raw target; there is no router to ask.
    const path = request.url.split("?")[0] ?? "";
    const isApi = path === "/api" || path.startsWith("/api/");

    if (isApi || !isPageRequest(request, path)) {
      return reply.status(404).send({
        statusCode: 404,
        error: "Not Found",
        message: `Route ${request.method}:${path} not found`,
      });
    }

    return reply.sendFile("index.html");
  };
}

/** Whether this request is a browser asking for a page, rather than a client asking for a file. */
function isPageRequest(request: FastifyRequest, path: string): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  if (extname(path)) return false;
  return (request.headers.accept ?? "").includes("text/html");
}
