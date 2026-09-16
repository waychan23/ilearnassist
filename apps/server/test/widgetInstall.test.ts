import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DIAGRAM_TOOL_NAME, PLAN_MAKE_TOOL_NAME } from "@ilearnassist/shared";
import { installWidgetForToolUse } from "../src/widgetInstall.js";
import { newSession, newWorkspace, startTestServer, type TestEnv } from "./helpers/tempEnv.js";

/**
 * The `auto-install` side effect on its own, without a turn in the way.
 *
 * The rule under test is the *decision* rule: this installs from silence and never over an
 * answer, so a panel somebody closed stays closed. `plan-sse.test.ts` covers the path end to end
 * through a real turn; this is where the edge cases live, because they are states a conversation
 * only reaches deliberately.
 */

let env: TestEnv;

beforeAll(async () => {
  env = await startTestServer();
});

afterAll(async () => {
  await env.cleanup();
});

let userId: string;
let sessionId: string;

beforeEach(async () => {
  const workspace = await newWorkspace(env, `W-${Math.random().toString(36).slice(2)}`);
  const session = await newSession(env, workspace.id);
  sessionId = session.id;
  userId = env.user.id;
});

function install(toolName: string) {
  return installWidgetForToolUse({ db: env.server.db, userId, sessionId, toolName });
}

function enabled(id: string): boolean | undefined {
  return env.server.db
    .listSessionWidgetsForUser(userId, sessionId)
    .find((w) => w.id === id)?.enabled;
}

describe("installWidgetForToolUse", () => {
  it("installs the widget an auto-install tool belongs to", () => {
    expect(install(PLAN_MAKE_TOOL_NAME)).toBe("plan");
    expect(enabled("plan")).toBe(true);
  });

  it("installs nothing for a tool that belongs to no widget", () => {
    // `ila_query` reads five panels and is bound to none of them: the widget it would install
    // does not exist, which is the case the lookup has to answer `undefined` for rather than
    // guessing one.
    expect(install("ila_query")).toBeUndefined();
    expect(install("read_file")).toBeUndefined();
    expect(install("no_such_tool")).toBeUndefined();
  });

  it("is a no-op the second time, and says so", () => {
    // Cost, not just correctness: a conversation that makes twenty plans pays twenty indexed
    // reads and one write. The second call reports `undefined` because it installed nothing.
    expect(install(PLAN_MAKE_TOOL_NAME)).toBe("plan");
    expect(install(PLAN_MAKE_TOOL_NAME)).toBeUndefined();
    expect(enabled("plan")).toBe(true);
  });

  it("does not install over an explicit uninstall", () => {
    /*
     * The decision rule, and the reason this helper reads `getSessionWidgetDecisionForUser`
     * rather than the resolved list. A row saying `enabled = 0` is somebody's decision, and a
     * model's call must not be the mechanism that resurrects a panel they closed — the same
     * invariant that makes an uninstall write a row rather than delete one.
     */
    expect(env.server.db.setSessionWidgetForUser(userId, sessionId, "plan", false)).toBe(true);

    expect(install(PLAN_MAKE_TOOL_NAME)).toBeUndefined();
    expect(enabled("plan")).toBe(false);

    // And it stays refused: a second call is not a second chance.
    expect(install(PLAN_MAKE_TOOL_NAME)).toBeUndefined();
    expect(enabled("plan")).toBe(false);
  });

  it("installs the diagram widget for ila_diagram", () => {
    expect(install(DIAGRAM_TOOL_NAME)).toBe("diagram");
    expect(enabled("diagram")).toBe(true);
  });

  it("installs nothing for a foreign conversation", () => {
    // The write is owner-scoped, so a session id that is not the caller's inserts nothing rather
    // than handing them a widget in somebody else's conversation.
    expect(
      installWidgetForToolUse({
        db: env.server.db,
        userId: "not-a-user",
        sessionId,
        toolName: PLAN_MAKE_TOOL_NAME,
      })
    ).toBeUndefined();
    expect(enabled("plan")).toBe(false);
  });
});
