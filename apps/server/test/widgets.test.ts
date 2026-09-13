import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_WIDGET_IDS,
  type MessageUsage,
  type SessionStats,
  type Workspace,
} from "@ilearnassist/shared";
import { newSession, newWorkspace, startTestServer, type TestEnv } from "./helpers/tempEnv.js";
import {
  buildWorkspaceStats,
  parseWidgetIds,
  resolveWidgetStates,
  sumUsage,
  widgetRowsForSelection,
} from "../src/widgets.js";

/*
 * The widget framework's server half: the pure rules, then the routes that expose them.
 *
 * The tests are grouped that way on purpose. `sumUsage` and the selection validator are where
 * the subtle mistakes live (what a missing figure means, what "absent" means), and they need no
 * HTTP to pin; the routes are then mostly about *who may write what*, which is the part the
 * database's own surface cannot answer.
 */

describe("sumUsage", () => {
  it("falls back to the two halves when the provider sent no total", () => {
    // `MessageUsage`'s fields are all optional, so this is the ordinary case rather than an
    // edge one — and the fallback is a rule about the type, which is why it is not a COALESCE
    // buried in a GROUP BY.
    expect(sumUsage([{ inputTokens: 10, outputTokens: 4 }]).totalTokens).toBe(14);
  });

  it("prefers a reported total over the halves", () => {
    expect(sumUsage([{ inputTokens: 10, outputTokens: 4, totalTokens: 99 }]).totalTokens).toBe(99);
  });

  it("sums the per-turn figures across steps", () => {
    const summed = sumUsage([
      { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
      { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    ]);
    expect(summed).toMatchObject({ inputTokens: 110, outputTokens: 24, totalTokens: 134 });
  });

  it("takes contextTokens from the last figure rather than summing it", () => {
    // A level, not a running total: the second turn reporting *less* is the case that tells the
    // two implementations apart, and it is reachable — a conversation can get shorter.
    expect(
      sumUsage([{ inputTokens: 900, outputTokens: 100, contextTokens: 1000 }, { inputTokens: 5, contextTokens: 12 }])
        .contextTokens
    ).toBe(12);
  });

  it("keeps the previous level when a turn reported no context", () => {
    expect(
      sumUsage([{ inputTokens: 5, contextTokens: 40 }, { inputTokens: 5 }]).contextTokens
    ).toBe(40);
  });

  it("is all zeros for nothing at all", () => {
    expect(sumUsage([])).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      contextTokens: 0,
    });
  });
});

describe("parseWidgetIds", () => {
  it("reads an absent field as 'nobody decided'", () => {
    // Not an error and not an empty list: the caller falls through to the next tier, which is
    // the whole reason this is a distinct outcome.
    expect(parseWidgetIds(undefined, "workspace")).toEqual({ ok: true, ids: undefined });
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
    expect(parseWidgetIds(["workspace_stats"], "session")).toEqual({
      ok: false,
      code: "WIDGET_SCOPE_UNSUPPORTED",
    });
    expect(parseWidgetIds(["session_stats"], "workspace")).toEqual({
      ok: false,
      code: "WIDGET_SCOPE_UNSUPPORTED",
    });
  });

  it("refuses a value that is not a list at all", () => {
    expect(parseWidgetIds("session_stats", "session")).toEqual({
      ok: false,
      code: "UNKNOWN_WIDGET",
    });
  });

  it("accepts a whole list, in the order given", () => {
    expect(parseWidgetIds(["session_stats"], "session")).toEqual({
      ok: true,
      ids: ["session_stats"],
    });
  });
});

describe("widgetRowsForSelection", () => {
  it("writes a row only where the choice differs from the default", () => {
    // The minimal record of a decision. With the default empty, that is one row per ticked
    // widget and nothing else — an object whose state equals the defaults needs no rows.
    expect(widgetRowsForSelection("workspace", ["workspace_stats"])).toEqual([
      { id: "workspace_stats", enabled: true },
    ]);
    expect(widgetRowsForSelection("workspace", [])).toEqual([]);
    expect(widgetRowsForSelection("workspace", undefined)).toEqual([]);
  });
});

describe("resolveWidgetStates", () => {
  it("answers one entry per known widget, defaulting the ones nothing decided", () => {
    expect(resolveWidgetStates("session", [])).toEqual([
      { id: "session_stats", scope: "session", enabled: DEFAULT_WIDGET_IDS.includes("session_stats") },
      { id: "plan", scope: "session", enabled: DEFAULT_WIDGET_IDS.includes("plan") },
    ]);
  });

  it("lets a stored row override the default, in both directions", () => {
    expect(resolveWidgetStates("workspace", [])).toEqual([
      { id: "workspace_stats", scope: "workspace", enabled: false },
    ]);
    expect(
      resolveWidgetStates("workspace", [{ widget_id: "workspace_stats", enabled: 1 }])
    ).toEqual([{ id: "workspace_stats", scope: "workspace", enabled: true }]);
  });

  it("drops a row naming a widget this build does not know", () => {
    // A downgrade's leftovers. Walking the registry rather than the rows is what makes a stored
    // row and a defaulted row indistinguishable to a caller — and what keeps an unrenderable id
    // out of the reply.
    expect(resolveWidgetStates("workspace", [{ widget_id: "from_the_future", enabled: 1 }])).toEqual(
      [{ id: "workspace_stats", scope: "workspace", enabled: false }]
    );
  });
});

describe("buildWorkspaceStats", () => {
  it("counts every message but sums only the turns that reported usage", () => {
    const stats = buildWorkspaceStats({
      workspaceId: "w1",
      sessions: [
        {
          sessionId: "s1",
          title: "One",
          // A user message and a stopped turn carry no usage; a provider that reported nothing
          // is the same shape. All three count towards `messageCount` and none towards the sums.
          usages: [null, { inputTokens: 10, outputTokens: 4, totalTokens: 14 }, null],
        },
      ],
    });

    expect(stats).toMatchObject({
      messageCount: 3,
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
    });
  });

  it("totals the sessions so the headline cannot disagree with the list", () => {
    const stats = buildWorkspaceStats({
      workspaceId: "w1",
      sessions: [
        { sessionId: "s1", title: "One", usages: [{ inputTokens: 10, outputTokens: 1 }] },
        { sessionId: "s2", title: "Two", usages: [{ inputTokens: 20, outputTokens: 2 }] },
      ],
    });
    expect(stats.messageCount).toBe(stats.sessions.reduce((n, s) => n + s.messageCount, 0));
    expect(stats.totalTokens).toBe(33);
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

  /**
   * `newWorkspace` does not carry a widget list, and several tests need one — so this is the
   * route called directly rather than a helper that would exist for one caller.
   */
  async function workspaceWith(widgets: unknown): Promise<Workspace> {
    const res = await env.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { name: "W", widgets },
    });
    if (res.statusCode !== 201) throw new Error(`create failed: ${res.statusCode} ${res.body}`);
    return res.json<Workspace>();
  }

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

  async function seedCopilot(widgets: unknown): Promise<string> {
    const res = await env.inject({
      method: "POST",
      url: "/api/copilots",
      payload: { name: "C", systemPrompt: "S", widgets },
    });
    if (res.statusCode !== 201) throw new Error(`copilot failed: ${res.statusCode} ${res.body}`);
    return res.json<{ id: string }>().id;
  }

  it("installs what the create request asks for, and only that", async () => {
    const ws = await workspaceWith(["workspace_stats"]);
    expect(await widgetsOf(`/api/workspaces/${ws.id}/widgets`)).toEqual([
      { id: "workspace_stats", scope: "workspace", enabled: true },
    ]);
  });

  it("installs the defaults when the create request omits the field", async () => {
    // The absence path, which is what an older client and the auto-created "Default" workspace
    // both take. Asserted against `DEFAULT_WIDGET_IDS` rather than against `false`, so flipping
    // that constant is a test failure to read rather than a silent behaviour change.
    const ws = await newWorkspace(env);
    expect(await widgetsOf(`/api/workspaces/${ws.id}/widgets`)).toEqual([
      { id: "workspace_stats", scope: "workspace", enabled: DEFAULT_WIDGET_IDS.includes("workspace_stats") },
    ]);
  });

  it("turns a widget off without deleting the row", async () => {
    /*
     * The invariant the whole table is shaped around, and the API cannot witness it: a read
     * answers the *resolved* state, so a deleted row and a row saying `enabled = 0` look
     * identical through HTTP. The row count is therefore asserted against the database itself.
     */
    const ws = await workspaceWith(["workspace_stats"]);
    const off = await env.inject({
      method: "PUT",
      url: `/api/workspaces/${ws.id}/widgets/workspace_stats`,
      payload: { enabled: false },
    });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toEqual({ id: "workspace_stats", scope: "workspace", enabled: false });

    const rows = env.server.db.raw
      .prepare("SELECT widget_id, enabled FROM widget_instances WHERE scope = 'workspace' AND scope_id = ?")
      .all(ws.id) as { widget_id: string; enabled: number }[];
    expect(rows).toEqual([{ widget_id: "workspace_stats", enabled: 0 }]);
  });

  it("keeps a widget off once it has been turned off", async () => {
    // The failure a delete would cause: the row goes, the default applies again, and the widget
    // the user turned off comes back on the next read.
    const ws = await workspaceWith(["workspace_stats"]);
    await env.inject({
      method: "PUT",
      url: `/api/workspaces/${ws.id}/widgets/workspace_stats`,
      payload: { enabled: false },
    });
    expect(await widgetsOf(`/api/workspaces/${ws.id}/widgets`)).toEqual([
      { id: "workspace_stats", scope: "workspace", enabled: false },
    ]);
  });

  it("round-trips install, uninstall and install on the same pair", async () => {
    const ws = await workspaceWith([]);
    const url = `/api/workspaces/${ws.id}/widgets/workspace_stats`;

    for (const enabled of [true, false, true]) {
      const res = await env.inject({ method: "PUT", url, payload: { enabled } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ enabled });
    }
    // One row, not three — the upsert is what makes a repeated toggle ordinary rather than a
    // duplicate-key error.
    const count = env.server.db.raw
      .prepare("SELECT COUNT(*) AS n FROM widget_instances WHERE scope_id = ?")
      .get(ws.id) as { n: number };
    expect(count.n).toBe(1);
  });

  it("refuses a widget it does not know, and one at the wrong level", async () => {
    const ws = await newWorkspace(env);
    const unknown = await env.inject({
      method: "PUT",
      url: `/api/workspaces/${ws.id}/widgets/from_the_future`,
      payload: { enabled: true },
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ error: { code: "UNKNOWN_WIDGET" } });

    const wrongLevel = await env.inject({
      method: "PUT",
      url: `/api/workspaces/${ws.id}/widgets/session_stats`,
      payload: { enabled: true },
    });
    expect(wrongLevel.statusCode).toBe(400);
    expect(wrongLevel.json()).toMatchObject({ error: { code: "WIDGET_SCOPE_UNSUPPORTED" } });
  });

  it("refuses a bad widget list at creation, before anything is created", async () => {
    // The refusal has to precede the write: a workspace created and then rejected would be a
    // half-made object, and the name is already spent.
    const bad = await env.inject({
      method: "POST",
      url: "/api/workspaces",
      payload: { name: "Bad", widgets: ["session_stats"] },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: { code: "WIDGET_SCOPE_UNSUPPORTED" } });

    const listed = await env.inject({ method: "GET", url: "/api/workspaces" });
    expect(listed.json<Workspace[]>().map((w) => w.name)).not.toContain("Bad");
  });

  it("requires a boolean enabled, rather than guessing", async () => {
    const ws = await newWorkspace(env);
    const res = await env.inject({
      method: "PUT",
      url: `/api/workspaces/${ws.id}/widgets/workspace_stats`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "DATA_REQUIRED" } });
  });

  it("groups a conversation's widgets into the two lists the strip draws", async () => {
    const ws = await workspaceWith(["workspace_stats"]);
    const session = await newSession(env, ws.id, { widgets: ["session_stats"] });

    const res = await env.inject({ method: "GET", url: `/api/sessions/${session.id}/widgets` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      workspace: [{ id: "workspace_stats", scope: "workspace", enabled: true }],
      session: [
        { id: "session_stats", scope: "session", enabled: true },
        { id: "plan", scope: "session", enabled: false },
      ],
    });
  });

  it("copies a Copilot's widget selection into the conversation it starts", async () => {
    const ws = await newWorkspace(env);
    const copilotId = await seedCopilot(["session_stats"]);

    const session = await newSession(env, ws.id, { copilotId });
    expect(await sessionWidgetsOf(session.id)).toEqual([
      { id: "session_stats", scope: "session", enabled: true },
      { id: "plan", scope: "session", enabled: false },
    ]);
  });

  it("lets the create request override the Copilot's selection, including to none", async () => {
    const ws = await newWorkspace(env);
    const copilotId = await seedCopilot(["session_stats"]);

    // `[]` is an explicit "none" and stops the fall-through to the Copilot.
    const none = await newSession(env, ws.id, { copilotId, widgets: [] });
    expect((await sessionWidgetsOf(none.id)).every((w) => !w.enabled)).toBe(true);
  });

  it("leaves a conversation's widgets alone when the Copilot is edited afterwards", async () => {
    // The snapshot rule, now covering widgets: a Copilot is a template and a conversation *copies*
    // it. A live read here would mean editing a Copilot reached back into conversations that had
    // already started — the failure the persona and tool snapshots were introduced to fix.
    const ws = await newWorkspace(env);
    const copilotId = await seedCopilot(["session_stats"]);
    const session = await newSession(env, ws.id, { copilotId });

    const edited = await env.inject({
      method: "PUT",
      url: `/api/copilots/${copilotId}`,
      payload: { widgets: [] },
    });
    expect(edited.statusCode).toBe(200);

    expect(await sessionWidgetsOf(session.id)).toEqual([
      { id: "session_stats", scope: "session", enabled: true },
      { id: "plan", scope: "session", enabled: false },
    ]);
  });

  it("leaves a Copilot's widgets alone when the request does not mention them", async () => {
    // The `allTools` contract: a form that does not carry the field cannot clear it.
    const copilotId = await seedCopilot(["session_stats"]);
    const edited = await env.inject({
      method: "PUT",
      url: `/api/copilots/${copilotId}`,
      payload: { name: "Renamed" },
    });
    expect(edited.json()).toMatchObject({ name: "Renamed", widgets: ["session_stats"] });
  });

  it("refuses a workspace widget in a Copilot", async () => {
    // A Copilot installs into a session, so its selection is at session scope — and a
    // workspace-scope widget there is a request that cannot mean anything.
    const res = await env.inject({
      method: "POST",
      url: "/api/copilots",
      payload: { name: "C", systemPrompt: "S", widgets: ["workspace_stats"] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "WIDGET_SCOPE_UNSUPPORTED" } });
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
    const theirSession = await newSession(env, theirs.id, { widgets: ["session_stats"] });
    const bob = await env.asUser("Bob");

    const probes = [
      { method: "GET", url: `/api/workspaces/${theirs.id}/widgets` },
      { method: "PUT", url: `/api/workspaces/${theirs.id}/widgets/workspace_stats`, payload: { enabled: true } },
      { method: "GET", url: `/api/sessions/${theirSession.id}/widgets` },
      { method: "PUT", url: `/api/sessions/${theirSession.id}/widgets/session_stats`, payload: { enabled: true } },
      { method: "GET", url: `/api/workspaces/${theirs.id}/stats` },
      { method: "GET", url: `/api/sessions/${theirSession.id}/stats` },
    ] as const;

    for (const probe of probes) {
      const res = await bob.inject(probe as never);
      // 404 rather than 403, on purpose: "not yours" and "does not exist" have to answer the
      // same way or an id can be probed.
      expect(res.statusCode, `${probe.method} ${probe.url}`).toBe(404);
    }
  });

  it("counts messages and sums tokens per conversation", async () => {
    const ws = await newWorkspace(env);
    const session = await newSession(env, ws.id);
    const db = env.server.db;

    db.createMessage({ id: "m1", sessionId: session.id, role: "user", content: "hi" });
    db.createMessage({
      id: "m2",
      sessionId: session.id,
      role: "assistant",
      content: "hello",
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14, contextTokens: 14 },
    });
    // A stopped turn: persisted, and reporting no usage at all.
    db.createMessage({ id: "m3", sessionId: session.id, role: "assistant", content: "…", stopped: true });

    const res = await env.inject({ method: "GET", url: `/api/sessions/${session.id}/stats` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      sessionId: session.id,
      messageCount: 3,
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
      contextTokens: 14,
    });
  });

  it("reports the last turn's context rather than the sum of them", async () => {
    // Two turns where the second is smaller: summing would give 1014 and pass a test that only
    // checked for a non-zero number, so the assertion is on the exact smaller value.
    const ws = await newWorkspace(env);
    const session = await newSession(env, ws.id);
    const usage = (n: number): MessageUsage => ({ inputTokens: n, contextTokens: n });
    env.server.db.createMessage({
      id: "m1",
      sessionId: session.id,
      role: "assistant",
      content: "a",
      usage: usage(1000),
    });
    env.server.db.createMessage({
      id: "m2",
      sessionId: session.id,
      role: "assistant",
      content: "b",
      usage: usage(12),
    });

    const res = await env.inject({ method: "GET", url: `/api/sessions/${session.id}/stats` });
    expect(res.json()).toMatchObject({ inputTokens: 1012, contextTokens: 12 });
  });

  it("reports a conversation with no messages as zeros, not as missing", async () => {
    const ws = await newWorkspace(env);
    const empty = await newSession(env, ws.id);

    const one = await env.inject({ method: "GET", url: `/api/sessions/${empty.id}/stats` });
    expect(one.statusCode).toBe(200);
    expect(one.json()).toMatchObject({ messageCount: 0, totalTokens: 0, contextTokens: 0 });

    // And the workspace lists it rather than omitting it: a conversation that silently
    // disappeared from the list would read as one that does not exist.
    const all = await env.inject({ method: "GET", url: `/api/workspaces/${ws.id}/stats` });
    expect(all.json()).toMatchObject({ workspaceId: ws.id, messageCount: 0 });
    expect(
      all.json<{ sessions: SessionStats[] }>().sessions.map((s) => s.sessionId)
    ).toEqual([empty.id]);
  });

  it("counts conversations with no messages towards the workspace total without inventing figures", async () => {
    const ws = await newWorkspace(env);
    const first = await newSession(env, ws.id);
    await newSession(env, ws.id);
    env.server.db.createMessage({
      id: "m1",
      sessionId: first.id,
      role: "assistant",
      content: "a",
      usage: { inputTokens: 7, outputTokens: 3 },
    });

    const res = await env.inject({ method: "GET", url: `/api/workspaces/${ws.id}/stats` });
    expect(res.json()).toMatchObject({
      messageCount: 1,
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
    });
    expect(res.json<{ sessions: unknown[] }>().sessions).toHaveLength(2);
  });

  it("answers 404 for a workspace or conversation that does not exist", async () => {
    for (const url of ["/api/workspaces/nope/stats", "/api/workspaces/nope/widgets"]) {
      expect((await env.inject({ method: "GET", url })).statusCode, url).toBe(404);
    }
    for (const url of ["/api/sessions/nope/stats", "/api/sessions/nope/widgets"]) {
      expect((await env.inject({ method: "GET", url })).statusCode, url).toBe(404);
    }
  });
});
