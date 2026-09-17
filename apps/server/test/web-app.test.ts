import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasBuiltWebApp, registerWebApp } from "../src/webApp.js";
import { startTestServer } from "./helpers/tempEnv.js";

/**
 * Serving the built frontend from the API's own origin.
 *
 * The interesting assertion is not that `/` returns HTML — it is that everything the API
 * already promised still behaves the same once a static wildcard is registered at `/` *and*
 * a not-found handler is answering for the client router. A concrete route must still win, an
 * unknown `/api/...` path must still answer with the shape the browser client knows how to
 * read, and the fallback must not swallow the build's own assets.
 */

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A minimal stand-in for `apps/web/dist`: an entry point and one asset beside it. */
function fakeWebBuild(contents = "<!doctype html><div id=\"app\"></div>"): string {
  const dir = mkdtempSync(join(tmpdir(), "gl-web-"));
  scratch.push(dir);
  writeFileSync(join(dir, "index.html"), contents, "utf8");
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "assets", "app.js"), "console.log('hi')", "utf8");
  return dir;
}

describe("hasBuiltWebApp", () => {
  it("is false when there is no build", () => {
    expect(hasBuiltWebApp(undefined)).toBe(false);
    expect(hasBuiltWebApp(join(tmpdir(), "definitely-not-a-real-build"))).toBe(false);
  });

  it("is false for a directory with no entry point", () => {
    // A `dist/` left half-written by an interrupted build must not be served: the API would
    // come up looking fine and every page load would 404.
    const dir = mkdtempSync(join(tmpdir(), "gl-web-empty-"));
    scratch.push(dir);
    expect(hasBuiltWebApp(dir)).toBe(false);
  });

  it("is true once there is an index.html", () => {
    expect(hasBuiltWebApp(fakeWebBuild())).toBe(true);
  });
});

describe("registerWebApp", () => {
  it("declines to register when there is nothing to serve", async () => {
    const { default: Fastify } = await import("fastify");
    const app = Fastify();
    expect(await registerWebApp(app, undefined)).toBe(false);
    await app.close();
  });
});

describe("a server with a frontend beside its API", () => {
  it("reports that it serves the app", async () => {
    const env = await startTestServer({ webDir: fakeWebBuild() });
    try {
      expect(env.server.servesWebApp).toBe(true);
    } finally {
      await env.cleanup();
    }
  });

  it("does not report it when there is no build", async () => {
    const env = await startTestServer();
    try {
      expect(env.server.servesWebApp).toBe(false);
    } finally {
      await env.cleanup();
    }
  });

  it("serves the entry point at /", async () => {
    const env = await startTestServer({ webDir: fakeWebBuild("<div id=\"app\"></div>") });
    try {
      const res = await env.server.app.inject({ method: "GET", url: "/" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.body).toContain('id="app"');
    } finally {
      await env.cleanup();
    }
  });

  it("serves the build's assets", async () => {
    const env = await startTestServer({ webDir: fakeWebBuild() });
    try {
      const res = await env.server.app.inject({ method: "GET", url: "/assets/app.js" });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("console.log");
    } finally {
      await env.cleanup();
    }
  });

  it("still routes the API to the API", async () => {
    // find-my-way prefers a concrete route over a wildcard, but the static plugin does
    // register `GET /*` at the same prefix — so this is the assertion that the ordering in
    // `buildServer` is what keeps `/api` reachable at all.
    const env = await startTestServer({ webDir: fakeWebBuild() });
    try {
      const res = await env.inject({ method: "GET", url: "/api/config" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveProperty("providers");
    } finally {
      await env.cleanup();
    }
  });

  it("guards the API but not the page that logs into it", async () => {
    // The auth gate is a hook on the `routes` plugin, so it covers the API and stops there —
    // which it has to, because a browser cannot present a cookie to load the login screen
    // that would give it one. Both halves matter: an unguarded API is the whole feature
    // missing, and a guarded `index.html` is an app nobody can open.
    const env = await startTestServer({ webDir: fakeWebBuild() });
    try {
      const api = await env.server.app.inject({ method: "GET", url: "/api/config" });
      expect(api.statusCode).toBe(401);
      expect(api.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });

      const page = await env.server.app.inject({ method: "GET", url: "/" });
      expect(page.statusCode).toBe(200);
    } finally {
      await env.cleanup();
    }
  });

  it("leaves the API's own 404 alone", async () => {
    // The browser client parses this shape, and it is what tells a developer that an
    // endpoint is missing rather than the whole server. Serving `index.html` here would
    // turn a typo into a page.
    const env = await startTestServer({ webDir: fakeWebBuild() });
    try {
      const res = await env.server.app.inject({ method: "GET", url: "/api/definitely-not-a-route" });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ statusCode: 404, error: "Not Found" });
    } finally {
      await env.cleanup();
    }
  });
});

/**
 * The history fallback: a URL the client router owns, asked for over HTTP.
 *
 * Every one of these is a request a browser makes on a reload, a bookmark or a pasted link —
 * the browser asks the server for the address, and the address is a page this build has no
 * file for. Getting this wrong is not a subtle failure: without it a deep link 404s, and with
 * it written too widely the API stops answering.
 */
describe("a deep link into the app", () => {
  /** What a browser sends when a person presses Enter in the address bar. */
  const BROWSER = { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" };

  const deepLink = async (url: string, headers: Record<string, string> = BROWSER) => {
    const env = await startTestServer({ webDir: fakeWebBuild('<div id="app"></div>') });
    try {
      return await env.server.app.inject({ method: "GET", url, headers });
    } finally {
      await env.cleanup();
    }
  };

  it("serves the entry point for a conversation", async () => {
    // The requirement, over the wire: the id is the client's, and the server's only job is to
    // hand back the page that will read it.
    const res = await deepLink("/w/6f1c/s/9ab2");

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain('id="app"');
  });

  it("serves it for the console's sections and the account page too", async () => {
    for (const url of ["/login", "/password", "/account", "/admin", "/admin/providers"]) {
      const res = await deepLink(url);
      expect(res.statusCode, url).toBe(200);
      expect(res.headers["content-type"], url).toContain("text/html");
    }
  });

  it("keeps a missing asset a 404", async () => {
    // The restriction that matters most. Answering this with HTML would give the browser a page
    // where it asked for a script, and the failure would surface as a MIME error somewhere
    // else entirely — a blank screen and nothing in the server log to explain it.
    const res = await deepLink("/assets/nope.js");

    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toContain("application/json");
  });

  it("does not answer a request that is not a page navigation", async () => {
    // No `Accept: text/html` is a client asking for something else — a fetch, a crawler, a
    // script. And a POST to a path that does not exist is a wrong request rather than a page.
    const noAccept = await deepLink("/w/6f1c/s/9ab2", {});
    expect(noAccept.statusCode).toBe(404);

    const env = await startTestServer({ webDir: fakeWebBuild() });
    try {
      const posted = await env.server.app.inject({
        method: "POST",
        url: "/w/6f1c",
        headers: BROWSER,
        payload: {},
      });
      expect(posted.statusCode).toBe(404);
    } finally {
      await env.cleanup();
    }
  });

  it("serves nothing extra when there is no build", async () => {
    // The handler is registered *with* the static plugin, not beside it: an API-only server
    // must keep answering an unknown page with Fastify's own 404 rather than a blank page it
    // cannot fill.
    const env = await startTestServer();
    try {
      const res = await env.server.app.inject({ method: "GET", url: "/w/6f1c", headers: BROWSER });
      expect(res.statusCode).toBe(404);
      expect(res.headers["content-type"]).toContain("application/json");
    } finally {
      await env.cleanup();
    }
  });
});
