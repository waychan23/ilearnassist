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
 * already promised still behaves the same once a static wildcard is registered at `/`.
 * A concrete route must still win, and an unknown `/api/...` path must still answer with
 * the shape the browser client knows how to read.
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
