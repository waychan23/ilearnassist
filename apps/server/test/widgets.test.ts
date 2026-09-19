import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_WIDGET_IDS,
  defaultWidgetIdsForScope,
  widgetsForScope,
  type Workspace,
} from "@ilearnassist/shared";
import { newSession, newWorkspace, startTestServer, type TestEnv } from "./helpers/tempEnv.js";
import { parseWidgetIds, resolveWidgetStates, widgetRowsForSelection } from "../src/widgets.js";

/*
 * The widget framework's server half: the pure rules, then the routes that expose them.
 *
 * `parseWidgetIds` and the two row helpers are where the subtle mistakes live (what "absent"
 * means, which rows a decision needs), and they need no HTTP to pin; the routes are then mostly
 * about *who may write what*, which is the part the database's own surface cannot answer.
 *
 * **Every widget this build ships is session-scope.** There used to be two at workspace scope,
 * and they were demo panels rather than features; removing them left the level with no widgets
 * at all, while the level's routes, storage and dialogs stayed. That state is asserted rather
 * than merely true — see "the workspace level" below — because the failure it invites is silent:
 * a fixture that names a workspace widget now fails to typecheck, but a *stale workspace row* and
 * an empty registry look identical through every read this file can make.
 */

describe("parseWidgetIds", () => {
  it("reads an absent field as 'nobody decided'", () => {
    // Not an error and not an empty list: the caller falls through to the next tier, which is
    // the whole reason this is a distinct outcome.
    expect(parseWidgetIds(undefined, "session")).toEqual({ ok: true, ids: undefined });
  });

  it("reads an empty list as 'decided: none'", () => {
    // The other half of that distinction, and the one that stops the fall-through. Collapsing
    // the two would make a Copilot's selection unoverridable.
    expect(parseWidgetIds([], "session")).toEqual({ ok: true, ids: [] });
  });

  it("refuses an id this build does not know", () => {
    // Refused rather than filtered: a dropped id is a selection that looks like it worked.
    expect(parseWidgetIds(["nope"], "session")).toEqual({ ok: false, code: "UNKNOWN_WIDGET" });
  });

  it("refuses a widget at a level it does not support", () => {
    // The only direction left, now that nothing is installed at workspace scope: a *session*
    // widget named at the workspace level. The reverse — a workspace widget named at session
    // level — is no longer reachable, because the ids are gone; it would be UNKNOWN_WIDGET, and
    // the test below pins exactly that distinction, since the two codes read alike.
    expect(parseWidgetIds(["plan"], "workspace")).toEqual({
      ok: false,
      code: "WIDGET_SCOPE_UNSUPPORTED",
    });
  });

  it("treats a retired widget id as unknown rather than misplaced", () => {
    // What removing the demo widgets actually did to stored data: `workspace_stats` is not a
    // widget at the wrong level, it is not a widget. Worth stating, because `WIDGET_SCOPE_
    // UNSUPPORTED` and `UNKNOWN_WIDGET` produce the same user-visible refusal and only one of
    // them means "upgrade your client".
    expect(parseWidgetIds(["workspace_stats"], "session")).toEqual({
      ok: false,
      code: "UNKNOWN_WIDGET",
    });
    expect(parseWidgetIds(["workspace_stats"], "workspace")).toEqual({
      ok: false,
      code: "UNKNOWN_WIDGET",
    });
  });

  it("refuses a value that is not a list at all", () => {
    expect(parseWidgetIds("plan", "session")).toEqual({ ok: false, code: "UNKNOWN_WIDGET" });
  });

  it("accepts a whole list, in the order given", () => {
    expect(parseWidgetIds(["quiz", "notes"], "session")).toEqual({
      ok: true,
      ids: ["quiz", "notes"],
    });
  });
});

describe("widgetRowsForSelection", () => {
  it("writes a row only where the choice differs from the default", () => {
    // A named list is a **complete** decision, not a patch on the defaults: choosing `diagram`
    // alone also turns off the two defaults, because "just this one" is what the request said.
    // Each of the three differs from its default, so each gets a row — in registry order, not
    // in the order the request listed them, which is the same order every read will answer.
    expect(widgetRowsForSelection("session", ["diagram"])).toEqual([
      { id: "notes", enabled: false },
      { id: "diagram", enabled: true },
      { id: "sources", enabled: false },
    ]);
    // Naming exactly the defaults agrees with them in both directions, so nothing is written —
    // the object stays silent about a state it never disagreed with.
    expect(widgetRowsForSelection("session", ["notes", "sources"])).toEqual([]);
    // …and absent is not the same request as empty: `undefined` means nobody decided, so the
    // defaults apply and are still not written.
    expect(widgetRowsForSelection("session", undefined)).toEqual([]);
  });
});

describe("resolveWidgetStates", () => {
  it("answers one entry per known widget, defaulting the ones nothing decided", () => {
    // Derived from the registry, because that is the claim: *every* widget at this level comes
    // back, in registry order, each falling back to the default. A hand-written list would turn
    // adding a widget into an edit here without changing what is being asserted.
    expect(resolveWidgetStates("session", [])).toEqual(
      widgetsForScope("session").map((w) => ({
        id: w.id,
        scope: "session",
        enabled: DEFAULT_WIDGET_IDS.includes(w.id),
      }))
    );
  });

  it("lets a stored row override the default, in both directions", () => {
    expect(
      resolveWidgetStates("session", [{ widget_id: "notes", enabled: 0 }])
        .find((w) => w.id === "notes")
    ).toMatchObject({ enabled: false });
    expect(
      resolveWidgetStates("session", [{ widget_id: "diagram", enabled: 1 }])
        .find((w) => w.id === "diagram")
    ).toMatchObject({ enabled: true });
  });

  it("drops a row naming a widget this build does not know", () => {
    // A downgrade's leftovers, and what a stored row from before the demo widgets were removed
    // now is. Walking the registry rather than the rows is what makes a stored row and a
    // defaulted row indistinguishable to a caller — and what keeps an unrenderable id out of
    // the reply.
    const resolved = resolveWidgetStates("session", [
      { widget_id: "from_the_future", enabled: 1 },
      { widget_id: "workspace_stats", enabled: 1 },
    ]);
    expect(resolved.map((w) => w.id)).toEqual(widgetsForScope("session").map((w) => w.id));
  });

  it("answers nothing at all for the workspace level", () => {
    // Not a bug and not an oversight: `WIDGET_SCOPES` still has two entries and the workspace
    // routes still exist, but nothing is installed there. A stored workspace row cannot bring
    // one back, because the registry is what the reply is built from.
    expect(widgetsForScope("workspace")).toEqual([]);
    expect(resolveWidgetStates("workspace", [{ widget_id: "plan", enabled: 1 }])).toEqual([]);
  });
});

describe("over HTTP", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await startTestServer();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  async function widgetsOf(url: string): Promise<{ id: string; enabled: boolean }[]> {
    const res = await env.inject({ method: "GET", url });
    if (res.statusCode !== 200) throw new Error(`read failed: ${res.statusCode} ${res.body}`);
    return res.json<{ id: string; enabled: boolean }[]>();
  }

  /** A conversation's own group, out of the two the one read answers. */
  async function sessionWidgetsOf(sessionId: string): Promise<{ id: string; enabled: boolean }[]> {
    const res = await env.inject({ method: "GET", url: `/api/sessions/${sessionId}/widgets` });
    if (res.statusCode !== 200) throw new Error(`read failed: ${res.statusCode} ${res.body}`);
    return res.json<{ session: { id: string; enabled: boolean }[] }>().session;
  }

  /**
   * Every widget this level installs, with the named one on and the rest off.
   *
   * Derived from the registry rather than written out, which is what these assertions are
   * actually about — "every session widget is listed, and exactly this one is enabled". A
   * hand-written array turns adding a widget into a test edit in four places and, worse, reads
   * as though the list itself were the claim.
   */
  const everySessionWidget = (enabledId: string | null) =>
    widgetsForScope("session").map((w) => ({
      id: w.id,
      scope: "session",
      enabled: w.id === enabledId,
    }));

  async function seedCopilot(widgets: unknown): Promise<string> {
    const res = await env.inject({
      method: "POST",
      url: "/api/copilots",
      payload: { name: "C", systemPrompt: "S", widgets },
    });
    if (res.statusCode !== 201) throw new Error(`copilot failed: ${res.statusCode} ${res.body}`);
    return res.json<{ id: string }>().id;
  }

  describe("the workspace level", () => {
    it("lists nothing, and stores nothing", async () => {
      // The level survives with no widgets on it. An empty list rather than a 404: the route is
      // about the object, and the object has no widgets rather than not existing.
      const ws = await newWorkspace(env);
      expect(await widgetsOf(`/api/workspaces/${ws.id}/widgets`)).toEqual([]);
    });

    it("refuses a session widget, and one that no longer exists", async () => {
      // Both are 400s with different codes, and the difference is real: `plan` exists at the
      // wrong level, `workspace_stats` does not exist at all. A client that retried one the way
      // it retries the other would loop.
      const misplaced = await env.inject({
        method: "POST",
        url: "/api/workspaces",
        payload: { name: "Misplaced", widgets: ["plan"] },
      });
      expect(misplaced.statusCode).toBe(400);
      expect(misplaced.json()).toMatchObject({ error: { code: "WIDGET_SCOPE_UNSUPPORTED" } });

      const retired = await env.inject({
        method: "POST",
        url: "/api/workspaces",
        payload: { name: "Retired", widgets: ["workspace_stats"] },
      });
      expect(retired.statusCode).toBe(400);
      expect(retired.json()).toMatchObject({ error: { code: "UNKNOWN_WIDGET" } });

      // Neither was created: the refusal precedes the write, so the name is not spent.
      const listed = await env.inject({ method: "GET", url: "/api/workspaces" });
      const names = listed.json<Workspace[]>().map((w) => w.name);
      expect(names).not.toContain("Misplaced");
      expect(names).not.toContain("Retired");
    });

    it("filters the defaults to the level's own scope, which is what makes them sendable", () => {
      /*
       * The reason this is a function rather than a `filter` at each call site.
       *
       * Two session-scope widgets are on the default list, and a workspace-scope list is what the
       * workspace dialog sends. Sending the raw list at workspace scope is not a request that
       * installs too much — it is a request that **fails**, so no workspace is ever created.
       */
      expect(defaultWidgetIdsForScope("workspace")).toEqual([]);
      expect(defaultWidgetIdsForScope("session")).toEqual(["notes", "sources"]);
    });
  });

  it("installs the defaults into a conversation that asked for nothing", async () => {
    /*
     * The absence path, which is what an older client takes. Asserted against
     * `DEFAULT_WIDGET_IDS` rather than against a literal, so flipping that constant is a test
     * failure to read rather than a silent behaviour change.
     */
    const ws = await newWorkspace(env);
    const session = await newSession(env, ws.id);

    const rows = await sessionWidgetsOf(session.id);
    expect(rows.filter((r) => r.enabled).map((r) => r.id)).toEqual([...DEFAULT_WIDGET_IDS]);
    // …and nothing was *stored*: a state that equals the default needs no row, which is what
    // keeps the default a default rather than something the object can drift away from.
    const stored = env.server.db.raw
      .prepare("SELECT COUNT(*) AS n FROM widget_instances WHERE scope = 'session' AND scope_id = ?")
      .get(session.id) as { n: number };
    expect(stored.n).toBe(0);
  });

  it("honours an explicit list literally, without adding the defaults", async () => {
    /*
     * The other half of the same rule, and the reason the create dialogs had to start sending
     * the defaults themselves: a request that names a list gets exactly that list. `[]` means
     * none and `["diagram"]` means one — neither means "that, plus what you would have chosen".
     */
    const ws = await newWorkspace(env);
    const session = await newSession(env, ws.id, { widgets: ["diagram"] });

    const rows = await sessionWidgetsOf(session.id);
    expect(rows.filter((r) => r.enabled).map((r) => r.id)).toEqual(["diagram"]);
  });

  it("turns a widget off without deleting the row", async () => {
    /*
     * The invariant the whole table is shaped around, and the API cannot witness it: a read
     * answers the *resolved* state, so a deleted row and a row saying `enabled = 0` look
     * identical through HTTP. So the row is read from the database itself — and the assertion
     * distinguishes the two, since a delete would leave `undefined` here while the next read
     * answered the default again.
     */
    const ws = await newWorkspace(env);
    const session = await newSession(env, ws.id, { widgets: ["diagram"] });
    const off = await env.inject({
      method: "PUT",
      url: `/api/sessions/${session.id}/widgets/diagram`,
      payload: { enabled: false },
    });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toEqual({ id: "diagram", scope: "session", enabled: false });

    const row = env.server.db.raw
      .prepare(
        "SELECT enabled FROM widget_instances WHERE scope = 'session' AND scope_id = ? AND widget_id = ?"
      )
      .get(session.id, "diagram");
    expect(row).toEqual({ enabled: 0 });
  });

  it("keeps a widget off once it has been turned off", async () => {
    // The failure a delete would cause: the row goes, the default applies again, and the widget
    // the user turned off comes back on the next read. `notes` is a default, so this is the
    // direction that actually shows it.
    const ws = await newWorkspace(env);
    const session = await newSession(env, ws.id);
    await env.inject({
      method: "PUT",
      url: `/api/sessions/${session.id}/widgets/notes`,
      payload: { enabled: false },
    });
    const rows = await sessionWidgetsOf(session.id);
    expect(rows.filter((r) => r.enabled).map((r) => r.id)).toEqual(["sources"]);
  });

  it("round-trips install, uninstall and install on the same pair", async () => {
    const ws = await newWorkspace(env);
    const session = await newSession(env, ws.id);
    const url = `/api/sessions/${session.id}/widgets/diagram`;

    for (const enabled of [true, false, true]) {
      const res = await env.inject({ method: "PUT", url, payload: { enabled } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ enabled });
    }
    // One row, not three — the upsert is what makes a repeated toggle ordinary rather than a
    // duplicate-key error.
    const count = env.server.db.raw
      .prepare("SELECT COUNT(*) AS n FROM widget_instances WHERE scope_id = ?")
      .get(session.id) as { n: number };
    expect(count.n).toBe(1);
  });

  it("refuses a widget it does not know, and one at the wrong level", async () => {
    const ws = await newWorkspace(env);
    const session = await newSession(env, ws.id);

    const unknown = await env.inject({
      method: "PUT",
      url: `/api/sessions/${session.id}/widgets/from_the_future`,
      payload: { enabled: true },
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ error: { code: "UNKNOWN_WIDGET" } });

    // On the *workspace* route, where every real id is at the wrong level.
    const wrongLevel = await env.inject({
      method: "PUT",
      url: `/api/workspaces/${ws.id}/widgets/diagram`,
      payload: { enabled: true },
    });
    expect(wrongLevel.statusCode).toBe(400);
    expect(wrongLevel.json()).toMatchObject({ error: { code: "WIDGET_SCOPE_UNSUPPORTED" } });
  });

  it("requires a boolean enabled, rather than guessing", async () => {
    const ws = await newWorkspace(env);
    const session = await newSession(env, ws.id);
    const res = await env.inject({
      method: "PUT",
      url: `/api/sessions/${session.id}/widgets/diagram`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "DATA_REQUIRED" } });
  });

  it("groups a conversation's widgets into the two lists the strip draws", async () => {
    // The workspace group is empty and still present. It is the shape the strip reads, and it
    // is what a workspace-scope widget would appear in — so an empty array here is the "none
    // installed" answer, not a missing field.
    const ws = await newWorkspace(env);
    const session = await newSession(env, ws.id, { widgets: ["diagram"] });

    const res = await env.inject({ method: "GET", url: `/api/sessions/${session.id}/widgets` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      workspace: [],
      session: everySessionWidget("diagram"),
    });
  });

  it("copies a Copilot's widget selection into the conversation it starts", async () => {
    const ws = await newWorkspace(env);
    const copilotId = await seedCopilot(["diagram"]);

    const session = await newSession(env, ws.id, { copilotId });
    expect(await sessionWidgetsOf(session.id)).toEqual([...everySessionWidget("diagram")]);
  });

  it("lets the create request override the Copilot's selection, including to none", async () => {
    const ws = await newWorkspace(env);
    const copilotId = await seedCopilot(["diagram"]);

    // `[]` is an explicit "none" and stops the fall-through to the Copilot.
    const none = await newSession(env, ws.id, { copilotId, widgets: [] });
    expect((await sessionWidgetsOf(none.id)).every((w) => !w.enabled)).toBe(true);
  });

  it("leaves a conversation's widgets alone when the Copilot is edited afterwards", async () => {
    // The snapshot rule, now covering widgets: a Copilot is a template and a conversation *copies*
    // it. A live read here would mean editing a Copilot reached back into conversations that had
    // already started — the failure the persona and tool snapshots were introduced to fix.
    const ws = await newWorkspace(env);
    const copilotId = await seedCopilot(["diagram"]);
    const session = await newSession(env, ws.id, { copilotId });

    const edited = await env.inject({
      method: "PUT",
      url: `/api/copilots/${copilotId}`,
      payload: { widgets: [] },
    });
    expect(edited.statusCode).toBe(200);

    expect(await sessionWidgetsOf(session.id)).toEqual([...everySessionWidget("diagram")]);
  });

  it("leaves a Copilot's widgets alone when the request does not mention them", async () => {
    // The `allTools` contract: a form that does not carry the field cannot clear it.
    const copilotId = await seedCopilot(["diagram"]);
    const edited = await env.inject({
      method: "PUT",
      url: `/api/copilots/${copilotId}`,
      payload: { name: "Renamed" },
    });
    expect(edited.json()).toMatchObject({ name: "Renamed", widgets: ["diagram"] });
  });

  it("refuses an id it does not know in a Copilot", async () => {
    // A Copilot installs into a session, so its selection is read at session scope. The
    // "wrong level" case is no longer expressible from a real id — every widget is session
    // scope — so what is pinned is the refusal that a stale client would meet.
    const res = await env.inject({
      method: "POST",
      url: "/api/copilots",
      payload: { name: "C", systemPrompt: "S", widgets: ["workspace_stats"] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "UNKNOWN_WIDGET" } });
  });

  it("applies the requested settings at creation, in one write", async () => {
    // The route used to be create-then-PATCH, which left a window in which the conversation
    // existed with parameters nobody chose. The Copilot's values are the base, the request's
    // are laid over — so a Copilot default survives when the request does not name it.
    const ws = await newWorkspace(env);
    const copilotId = await seedCopilot([]);
    await env.inject({
      method: "PUT",
      url: `/api/copilots/${copilotId}`,
      payload: { settings: { temperature: 0.3, maxSteps: 5 } },
    });

    const session = await newSession(env, ws.id, {
      copilotId,
      settings: { temperature: 0.9 },
    });
    expect(session.settings).toMatchObject({ temperature: 0.9, maxSteps: 5 });
  });

  it("answers 404 for another account's objects, on every widget route", async () => {
    const theirs = await newWorkspace(env);
    const theirSession = await newSession(env, theirs.id, { widgets: ["diagram"] });
    const bob = await env.asUser("Bob");

    const probes = [
      { method: "GET", url: `/api/workspaces/${theirs.id}/widgets` },
      { method: "PUT", url: `/api/workspaces/${theirs.id}/widgets/diagram`, payload: { enabled: true } },
      { method: "GET", url: `/api/sessions/${theirSession.id}/widgets` },
      { method: "PUT", url: `/api/sessions/${theirSession.id}/widgets/diagram`, payload: { enabled: true } },
    ] as const;

    for (const probe of probes) {
      const res = await bob.inject(probe as never);
      // 404 rather than 403, on purpose: "not yours" and "does not exist" have to answer the
      // same way or an id can be probed.
      expect(res.statusCode, `${probe.method} ${probe.url}`).toBe(404);
    }
  });

  it("answers 404 for a workspace or conversation that does not exist", async () => {
    for (const url of ["/api/workspaces/nope/widgets", "/api/sessions/nope/widgets"]) {
      expect((await env.inject({ method: "GET", url })).statusCode, url).toBe(404);
    }
  });
});
