import { describe, expect, it } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import { ADMIN_SECTIONS, routes } from "../../src/router/index.js";

/**
 * The route table, checked as a table.
 *
 * A URL is a promise about what a reload will show, and every entry in this file is a way that
 * promise can be false: a page with no `meta.view` (the templates branch on it and would fall
 * to "no page"), an id-shaped path that a lookalike shadows (path order decides, and the
 * catch-all is last for that reason), a section the console cannot render.
 */
const router = createRouter({ history: createMemoryHistory(), routes });

describe("the route table", () => {
  it("names the paths the app owns", () => {
    // Written out rather than derived from `routes`, because the point is to pin the strings:
    // a path is what a bookmark holds, and a rename is a breaking change nobody would notice
    // in a diff of the table itself.
    expect(routes.map((r) => r.path)).toEqual([
      "/",
      "/login",
      "/password",
      "/account",
      "/admin/:section?",
      "/w/:workspaceId",
      "/w/:workspaceId/s/:sessionId",
      "/:pathMatch(.*)*",
    ]);
  });

  it("gives every page a view, which is the one thing the templates need", () => {
    // `meta.view` replaced `uiState.view`, and `App.vue` picks its layout classes from it —
    // a route without one renders as no page at all. The type makes it a compile error for a
    // *new* record; this catches the other direction, a record that redirects and so needed
    // no meta while it was written.
    for (const route of routes) {
      if (route.name === "notFound") continue;
      expect(route.meta?.view, String(route.path)).toBeTruthy();
    }
  });

  it("resolves each page to its own view", () => {
    const cases: Array<[string, string, string]> = [
      ["/", "home", "home"],
      ["/login", "login", "login"],
      ["/password", "password", "password"],
      ["/account", "account", "account"],
      ["/admin/users", "admin", "admin"],
      ["/w/ws-1", "workspace", "chat"],
      ["/w/ws-1/s/s-1", "session", "chat"],
    ];
    for (const [path, name, view] of cases) {
      const resolved = router.resolve(path);
      expect(resolved.name, path).toBe(name);
      expect(resolved.meta.view, path).toBe(view);
    }
  });

  it("reads the ids out of the path, because they are what the guard loads by", () => {
    expect(router.resolve("/w/ws-1").params).toMatchObject({ workspaceId: "ws-1" });
    expect(router.resolve("/w/ws-1/s/s-1").params).toMatchObject({
      workspaceId: "ws-1",
      sessionId: "s-1",
    });
  });

  it("leaves the console's section for the guard to complete", () => {
    // `/admin` on its own is what a bare "platform console" push writes, and it is
    // `router/guards.ts` that turns it into `/admin/users` rather than a default in the
    // component — so that what is on screen is what the address says.
    expect(router.resolve("/admin").params.section).toBeUndefined();
    for (const section of ADMIN_SECTIONS) {
      expect(router.resolve(`/admin/${section}`).params.section).toBe(section);
    }
  });

  it("sends anything else to the front door", () => {
    // Including the near-misses: `/w` alone is not a workspace, and `/admin/users/extra` is
    // not a section. A path this app does not own is not a page to complain about.
    for (const path of ["/nope", "/w", "/w/ws-1/s", "/admin/users/extra", "/w/ws-1/x"]) {
      expect(router.resolve(path).name, path).toBe("notFound");
    }
  });

  it("keeps the conversation paths distinct, since one is inside the other", () => {
    // `/w/x` and `/w/x/s/y` differ only by a suffix, and path *order* is what decides: the
    // shorter one written second would swallow the longer one's first segment.
    expect(router.resolve("/w/x").name).toBe("workspace");
    expect(router.resolve("/w/x/s/y").name).toBe("session");
  });
});
